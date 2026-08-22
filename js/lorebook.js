// M1 世界书：导入（酒馆原生 JSON / 纯文本单条）+ 关键词检索
// 检索结果只喂给插件自己的规划调用，不影响主对话的提示词（开发方案 §M1）
// 只保留「内容 + 关键词匹配」：酒馆原生的常驻 / 次要关键词 / 正则等格式一律不采用
import { settings, newId } from "./settings.js";

// 数据结构：
// Lorebook  { id, name, enabled, source, entries: LoreEntry[] }
// LoreEntry { uid, comment, keys[], content, disabled }
// 命中规则：条目已启用且任一关键词出现在扫描文本里（大小写不敏感）

export function normalizeEntry(raw = {}, index = 0) {
    return {
        uid: raw.uid ?? index,
        comment: raw.comment || `条目 ${index + 1}`,
        keys: (Array.isArray(raw.key) ? raw.key : (raw.keys ?? [])).filter(Boolean).map(String),
        content: String(raw.content ?? ''),
        disabled: Boolean(raw.disable ?? raw.disabled),
    };
}

// 导入酒馆原生世界书 JSON（entries 为对象或数组均可）。
// 只取标题 / 关键词 / 内容 / 原禁用状态，常驻等其余格式信息丢弃
export function importSillyTavernJson(text, name) {
    const data = JSON.parse(text);
    const rawEntries = data.entries ?? data;
    const entries = Object.values(rawEntries ?? {}).map((e, i) => normalizeEntry(e, i));
    if (!entries.length) {
        throw new Error('未解析到任何条目（请确认是酒馆世界书导出的 JSON）');
    }
    return {
        id: newId('lb-'),
        name: name || data.name || '导入的世界书',
        enabled: true,
        source: 'st-json',
        entries,
    };
}

// 纯文本：一次粘贴的整块就是一条条目，不做任何切块解析
export function createTextBook(name, keys = [], content = '') {
    return {
        id: newId('lb-'),
        name: name || '导入的文本世界书',
        enabled: true,
        source: 'plain-text',
        entries: [{
            uid: 0,
            comment: name || '条目 1',
            keys: keys.map(String).filter(Boolean),
            content,
            disabled: false,
        }],
    };
}

export function addLorebook(book) {
    settings.lorebooks.push(book);
    return book;
}

export function removeLorebook(id) {
    settings.lorebooks = settings.lorebooks.filter(b => b.id !== id);
}

export function findEntry(bookId, uid) {
    const book = settings.lorebooks.find(b => b.id === bookId);
    const entry = book?.entries.find(e => String(e.uid) === String(uid));
    return entry ?? null;
}

export function addEntry(bookId, { comment, keys, content }) {
    const book = settings.lorebooks.find(b => b.id === bookId);
    if (!book) return null;
    const uid = book.entries.reduce((m, e) => Math.max(m, Number(e.uid) || 0), -1) + 1;
    const entry = {
        uid,
        comment: comment || `条目 ${book.entries.length + 1}`,
        keys: (keys ?? []).map(String).filter(Boolean),
        content: content ?? '',
        disabled: false,
    };
    book.entries.push(entry);
    return entry;
}

export function removeEntry(bookId, uid) {
    const book = settings.lorebooks.find(b => b.id === bookId);
    if (!book) return;
    book.entries = book.entries.filter(e => String(e.uid) !== String(uid));
}

function enabledBooks() {
    return settings.lorebooks.filter(b => b.enabled);
}

export function parseKeys(text) {
    return String(text ?? '').split(/[,，]/).map(s => s.trim()).filter(Boolean);
}

/**
 * 检索：扫描 scanText，返回跨所有启用书籍的命中条目。
 * 命中规则：条目启用、内容非空、且任一关键词（子串，大小写不敏感）出现在扫描文本里。
 * 按 maxEntries 截断，总量受 maxChars 限制。
 */
export function scanLorebooks(scanText, { maxEntries, maxChars } = {}) {
    const opts = settings.retrieval;
    const maxE = maxEntries ?? opts.maxEntries;
    const maxC = maxChars ?? opts.maxChars;
    const haystack = String(scanText ?? '').toLowerCase();
    const hits = [];

    for (const book of enabledBooks()) {
        for (const entry of book.entries) {
            if (entry.disabled || !entry.content) continue;
            const keys = Array.isArray(entry.keys) ? entry.keys : [];
            if (keys.some(k => haystack.includes(String(k).toLowerCase()))) {
                hits.push({ book, entry });
            }
        }
    }

    hits.sort((a, b) => (Number(a.entry.uid) || 0) - (Number(b.entry.uid) || 0));

    let used = 0;
    const included = [];
    for (const { book, entry } of hits.slice(0, maxE)) {
        const budget = maxC - used;
        if (budget <= 0) break;
        const content = entry.content.length > budget ? `${entry.content.slice(0, budget)}…` : entry.content;
        used += content.length;
        included.push({ bookName: book.name, comment: entry.comment, content });
    }
    return included;
}

// 把命中条目拼装成喂给规划 API 的文本块
export function buildLoreContext(hits) {
    if (!hits?.length) return '（本次检索未命中任何世界书条目）';
    return hits.map(h => `【${h.bookName} / ${h.comment}】\n${h.content}`).join('\n\n');
}
