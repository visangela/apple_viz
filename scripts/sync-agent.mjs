// scripts/sync-agent.mjs
import fs from 'node:fs/promises';
import Parser from 'rss-parser';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const MODEL = 'google/gemma-4-31b-it:free';
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
            chip: { type: 'string', minLength: 1, description: '芯片型号，如 A20 Pro、M6、S11；文章完全没提芯片时填 "unknown"' },
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

字段规则：
- relevant：文章与 Apple 产品发布时间轴无关时设为 false。
- product：MacBook Air / MacBook Pro / Mac mini / Mac Studio / Mac Pro / iMac / iPad / iPad mini / iPad Air / iPad Pro / iPhone / Apple Watch 之一。
- event：released / confirmed / delayed / cancelled / rumor 之一。
- date：事件年月 YYYY-MM；没有明确年月填 "unknown"，不要猜测。
- chip：只要文章出现任何 Apple 芯片型号（M1–M9、A12–A22、S5–S13，可带 Pro/Max/Ultra 后缀），必须原样填入，例如 "A20 Pro"、"M6"、"S11"。只有文章完全没提芯片时才填 "unknown"。不要因为不确定就填 "unknown"。
- model：型号或尺寸，如 "8.x\\" OLED"、"14\\"/16\\""；不明确填 "unknown"。
- summary：中文概括，不超过 80 字。

示例：
输入标题："iPad mini 8 with OLED display is expected to debut this week"
输入摘要："The next iPad mini will feature an OLED display and the A20 Pro chip, according to supply chain sources."
输出：{"relevant":true,"product":"iPad mini","event":"confirmed","date":"2026-10","chip":"A20 Pro","model":"8.x\\" OLED","summary":"iPad mini 8 预计本周发布，OLED 屏，搭载 A20 Pro 芯片"}

输入标题："Apple announces new MacBook Pro with M6"
输入摘要："Apple today announced the new 14-inch and 16-inch MacBook Pro with the M6 chip."
输出：{"relevant":true,"product":"MacBook Pro","event":"released","date":"2026-10","chip":"M6","model":"14\\"/16\\"","summary":"苹果发布 M6 芯片的 14/16 英寸 MacBook Pro"}

输入标题："iPhone 17 review: a solid upgrade"
输出：{"relevant":false}`;

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
            max_tokens: 400,
            response_format: { type: 'json_object' },
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
    console.log('[LLM raw]', article.title.slice(0, 40), '→', raw);
    if (!raw) return null;

    let parsed;
    try { parsed = JSON.parse(raw); } catch { return null; }

    // 二次校验：strict 并非在所有 provider 上完全强制
    if (parsed.relevant === false) return null;
    if (!VALID_PRODUCTS.includes(parsed.product)) return null;
    if (!VALID_EVENTS.includes(parsed.event)) return null;

    // ===== 第四步：chip / date 正则兜底 =====
    // chip 兜底：模型填 unknown 或 null 时，从原文正则提取
    let chip = parsed.chip && parsed.chip !== 'unknown' ? parsed.chip : null;
    if (!chip) {
        const fullText = `${article.title} ${article.contentSnippet || ''}`;
        const chipMatch = fullText.match(
            /\b(M[1-9](?:\s?(?:Pro|Max|Ultra))?|A(?:1[0-9]|[1-9])(?:\s?(?:Pro|Max|Ultra))?|S(?:[1-9]|1[0-9])(?:\s?(?:Pro|Max|Ultra))?)\b/
        );
        if (chipMatch) chip = chipMatch[1].trim();
    }

    // date 兜底：模型填 unknown 或 null 时，从标题/摘要里找年月
    let date = parsed.date && parsed.date !== 'unknown' ? parsed.date : null;
    if (!date) {
        const ymMatch = `${article.title} ${article.contentSnippet || ''}`.match(/(20\d{2})[年\-\.\s]?(\d{1,2})?月?/);
        if (ymMatch) {
            const y = ymMatch[1];
            const m = ymMatch[2] ? String(parseInt(ymMatch[2])).padStart(2, '0') : null;
            if (m) date = `${y}-${m}`;
        }
    }

    // model 也顺手做一次 unknown → null 的归一
    const model = parsed.model && parsed.model !== 'unknown' ? parsed.model : null;

    return {
        product: parsed.product,
        event: parsed.event,
        date,
        chip,
        model,
        summary: parsed.summary
    };
    // ===== 兜底结束 =====
}

async function enrichArticle(item) {
    try {
        const res = await fetch(item.link, {
            headers: { 'User-Agent': 'AppleTimelineAgent/1.0' },
            signal: AbortSignal.timeout(8000)
        });
        const html = await res.text();
        const text = html.replace(/<script[\s\S]*?<\/script>/gi, '')
                         .replace(/<style[\s\S]*?<\/style>/gi, '')
                         .replace(/<[^>]+>/g, ' ')
                         .replace(/\s+/g, ' ')
                         .trim();
        return text.slice(0, 1500);
    } catch {
        return item.contentSnippet || '';
    }
}

async function fetchAllFeeds() {
    const all = [];
    for (const feed of FEEDS) {
        try {
            const parsed = await parser.parseURL(feed.url);
            const items = (parsed.items || []).slice(0, 5);
            for (const item of items) {
                const base = {
                    title: item.title || '',
                    link: item.link || '',
                    contentSnippet: (item.contentSnippet || item.content || '').slice(0, 500),
                    pubDate: item.pubDate || new Date().toISOString(),
                    source: feed.source
                };
                // 抓取正文，替换 contentSnippet
                base.contentSnippet = await enrichArticle(base);
                all.push(base);
            }
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
        const t = e.pubDate || e.date;
        return !t || t >= cutoff;   // 无日期的事件保留，不参与裁剪
    });

    const output = {
        syncedAt: new Date().toISOString(),
        events: retained,
        articleCount: batch.length,
        errors: errors.length ? errors : undefined
    };

    await fs.writeFile(OUTPUT_FILE, JSON.stringify(output, null, 2), 'utf8');

    console.log(
        `Wrote ${retained.length} events to ${OUTPUT_FILE} ` +
        `(new: ${unique.length}, history: ${history.length}, retained: ${retained.length})`
    );
}

main().catch(err => {
    console.error('sync failed', err);
    process.exit(1);
});