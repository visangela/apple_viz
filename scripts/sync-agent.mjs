// scripts/sync-agent.mjs
import fs from 'node:fs/promises';
import Parser from 'rss-parser';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const MODEL = 'google/gemma-4-31b-it';
const MAX_ARTICLES = 8;          // 免费层每天 50 请求，单次最多处理 8 篇
const OUTPUT_FILE = 'events.json';

const FEEDS = [
    { url: 'https://feeds.macrumors.com/MacRumors-Mac', source: 'MacRumors' },
    { url: 'https://9to5mac.com/feed', source: '9to5Mac' },
    { url: 'https://www.apple.com/newsroom/rss-feed.rss', source: 'Apple Newsroom' }
];

const VALID_PRODUCTS = [
    'MacBook Air', 'MacBook Pro', 'Mac mini', 'Mac Studio', 'Mac Pro', 'iMac',
    'iPad', 'iPad mini', 'iPad Air', 'iPad Pro', 'iPhone', 'Apple Watch'
];

const VALID_EVENTS = ['released', 'confirmed', 'delayed', 'cancelled', 'rumor'];

const EVENT_SCHEMA = {
    name: 'apple_product_event',
    strict: true,
    schema: {
        type: 'object',
        properties: {
            relevant: { type: 'boolean', description: '是否与 Apple 产品发布时间轴相关' },
            product: { type: 'string', enum: VALID_PRODUCTS },
            event: { type: 'string', enum: VALID_EVENTS },
            date: { type: 'string', description: '事件年月，格式 YYYY-MM；不明确填 "unknown"' },
            chip: { type: 'string', description: '芯片型号；不明确填 "unknown"' },
            model: { type: 'string', description: '产品型号或尺寸描述，如 "8.x\\" OLED"、"14\\"/16\\""；不明确填 "unknown"' },
            summary: { type: 'string', description: '中文摘要，不超过 80 字' }
        },
        required: ['relevant', 'product', 'event', 'date', 'chip', 'summary'],
        additionalProperties: false
    }
};

const parser = new Parser({
    timeout: 10000,
    headers: { 'User-Agent': 'AppleTimelineAgent/1.0 (GitHub Actions)' }
});

const SYSTEM_PROMPT = `你是 Apple 产品路线图分析助手。
从新闻标题和摘要中，判断它是否描述了 Apple 某个产品线的发布、推迟、取消或传闻。
严格按 JSON Schema 输出，不要输出任何其他文字。
- 如果文章与产品发布时间轴无关（评测、教程、促销），relevant 设为 false。
- 如果文章是发布会总结或盘点，只对明确提到的产品输出事件；未在文章中出现的产品不要臆测其已发布或取消。
- 没有明确年月时 date 填 "unknown"，不要猜测。
- 没有提到芯片时 chip 填 "unknown"。
- 如果文章明确提到芯片型号（如 A20 Pro、M6），必须填入 chip 字段，不要留 "unknown"。
- 如果文章明确提到尺寸或型号（如 "8.x 英寸 OLED"），填入 model 字段。`;

function buildPrompt(article) {
    return `标题：${article.title}
摘要：${(article.contentSnippet || '').slice(0, 400)}
来源：${article.source}
发布时间：${article.pubDate || '未知'}`;
}

async function callOpenRouter(article) {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) throw new Error('OPENROUTER_API_KEY 未设置');

    const res = await fetch(OPENROUTER_URL, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://github.com/your-username/apple-timeline',
            'X-Title': 'Apple Timeline Agent'
        },
        body: JSON.stringify({
            model: MODEL,
            temperature: 0,
            max_tokens: 300,
            response_format: {
                type: 'json_schema',
                json_schema: EVENT_SCHEMA
            },
            // 强制路由到支持 structured outputs 的 provider
            provider: { require_parameters: true },
            messages: [
                { role: 'system', content: SYSTEM_PROMPT },
                { role: 'user', content: buildPrompt(article) }
            ]
        }),
        signal: AbortSignal.timeout(45000)
    });

    if (!res.ok) {
        const errBody = await res.text();
        if (res.status === 429) throw new Error('RATE_LIMITED');
        throw new Error(`OpenRouter HTTP ${res.status}: ${errBody.slice(0, 300)}`);
    }

    const data = await res.json();
    const raw = data.choices?.[0]?.message?.content;
    if (!raw) return null;

    let parsed;
    try { parsed = JSON.parse(raw); } catch { return null; }

    // 二次校验：strict 并非在所有 provider 上完全强制
    if (parsed.relevant === false) return null;
    if (!VALID_PRODUCTS.includes(parsed.product)) return null;
    if (!VALID_EVENTS.includes(parsed.event)) return null;

    return {
        product: parsed.product,
        event: parsed.event,
        date: parsed.date === 'unknown' ? null : parsed.date,
        chip: parsed.chip === 'unknown' ? null : parsed.chip,
        model: parsed.model === 'unknown' ? null : parsed.model,
        summary: parsed.summary
    };
}

async function fetchAllFeeds() {
    const all = [];
    for (const feed of FEEDS) {
        try {
            const parsed = await parser.parseURL(feed.url);
            (parsed.items || []).slice(0, 5).forEach(item => {
                all.push({
                    title: item.title || '',
                    link: item.link || '',
                    contentSnippet: (item.contentSnippet || item.content || '').slice(0, 500),
                    pubDate: item.pubDate || new Date().toISOString(),
                    source: feed.source
                });
            });
        } catch (err) {
            console.warn(`feed failed: ${feed.source}`, err.message);
        }
    }
    return all;
}

async function main() {
    const articles = await fetchAllFeeds();
    articles.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
    const batch = articles.slice(0, MAX_ARTICLES);

    const events = [];
    const errors = [];

    // 串行调用，避免触发 20 req/min 的分钟级限流
    for (const article of batch) {
        try {
            const evt = await callOpenRouter(article);
            if (evt) {
                events.push({
                    ...evt,
                    link: article.link,
                    sourceName: article.source,
                    pubDate: article.pubDate
                });
            }
        } catch (err) {
            if (err.message === 'RATE_LIMITED') {
                errors.push('rate limited, stopped early');
                break;
            }
            errors.push(`${article.source}: ${err.message}`);
        }
    }

    // 去重
    const seen = new Set();
    const unique = events.filter(e => {
        const key = `${e.product}|${e.date}|${e.event}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });

    // const output = {
    //     syncedAt: new Date().toISOString(),
    //     events: unique,
    //     articleCount: batch.length,
    //     errors: errors.length ? errors : undefined
    // };

    // await fs.writeFile(OUTPUT_FILE, JSON.stringify(output, null, 2), 'utf8');

    ////////////////////
    // main() 末尾，替换原来的 fs.writeFile
    let history = [];
    try {
        const old = JSON.parse(await fs.readFile(OUTPUT_FILE, 'utf8'));
        history = old.events || [];
    } catch { /* 文件不存在，忽略 */ }

    // 新事件覆盖同 key 的旧事件，其余保留
    const merged = [...history];
    for (const evt of unique) {
        const idx = merged.findIndex(e =>
            e.product === evt.product && e.date === evt.date && e.event === evt.event
        );
        if (idx >= 0) merged[idx] = evt;
        else merged.push(evt);
    }

    // 只保留最近 120 天的事件，避免文件无限增长
    const cutoff = new Date(Date.now() - 120 * 86400000).toISOString().slice(0, 10);
    const retained = merged.filter(e => {
        const t = e.pubDate || e.date || '';
        return t >= cutoff;
    });

    const output = {
        syncedAt: new Date().toISOString(),
        events: retained,
        articleCount: batch.length,
        errors: errors.length ? errors : undefined
    };
    ////////////////////

    console.log(`Wrote ${unique.length} events to ${OUTPUT_FILE}`);
}

main().catch(err => {
    console.error('sync failed', err);
    process.exit(1);
});