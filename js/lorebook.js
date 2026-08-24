// M1 世界书：导入（酒馆原生 JSON / 纯文本单条）+ 关键词检索
// 检索结果只喂给插件自己的规划调用，不影响主对话的提示词（开发方案 §M1）
// 条目支持「常驻」（对齐酒馆原生 constant）：勾了常驻不看关键词、每次检索恒带出
import { settings, newId } from "./settings.js";

// 数据结构：
// Lorebook  { id, name, enabled, source, entries: LoreEntry[] }
// LoreEntry { uid, comment, keys[], content, disabled, constant }
// 命中规则：所在书被启用（或在本对话的启用书单里），条目已启用且
// （勾了常驻，或任一关键词出现在扫描文本里，大小写不敏感）

export function normalizeEntry(raw = {}, index = 0) {
    return {
        uid: raw.uid ?? index,
        comment: raw.comment || `条目 ${index + 1}`,
        keys: (Array.isArray(raw.key) ? raw.key : (raw.keys ?? [])).filter(Boolean).map(String),
        content: String(raw.content ?? ''),
        disabled: Boolean(raw.disable ?? raw.disabled),
        constant: Boolean(raw.constant),
    };
}

// 导入酒馆原生世界书 JSON（entries 为对象或数组均可）。
// 取标题 / 关键词 / 内容 / 原禁用与常驻状态，次要关键词 / 正则等其余格式信息丢弃
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
            constant: false,
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
        constant: false,
    };
    book.entries.push(entry);
    return entry;
}

export function removeEntry(bookId, uid) {
    const book = settings.lorebooks.find(b => b.id === bookId);
    if (!book) return;
    book.entries = book.entries.filter(e => String(e.uid) !== String(uid));
}

function enabledBooks(enabledIds = null) {
    // enabledIds：调用方传入的「按对话绑定」书单（null = 该对话没绑定，沿用书的全局 enabled）。
    // 书级开关是把别的世界挡在外面的闸门（常驻条目不看关键词恒带出，全靠它挡），
    // 按对话各记一套后，多世界多对话不用来回重勾
    if (enabledIds == null) return settings.lorebooks.filter(b => b.enabled);
    const wanted = new Set(enabledIds.map(String));
    return settings.lorebooks.filter(b => wanted.has(String(b.id)));
}

export function parseKeys(text) {
    return String(text ?? '').split(/[,，]/).map(s => s.trim()).filter(Boolean);
}

/**
 * 检索：扫描 scanText，返回命中条目。
 * 命中规则：所在书被启用（enabledIds 传入时以该对话书单为准），条目启用、内容非空，
 * 且（勾了常驻，或任一关键词（子串，大小写不敏感）出现在扫描文本里）。
 * 常驻条目恒带出：排在最前、不占 maxEntries 名额（多条常驻不挤掉关键词命中），
 * 但仍与命中条目共用 maxChars 字符预算、优先消耗——常驻是每次都在的底料。
 * maxEntries / maxChars 为 0 表示不限制（命中多少带多少 / 不截断）。
 */
export function scanLorebooks(scanText, { maxEntries, maxChars, enabledIds } = {}) {
    const opts = settings.retrieval;
    const maxE = maxEntries ?? opts.maxEntries;
    const maxC = maxChars ?? opts.maxChars;
    const haystack = String(scanText ?? '').toLowerCase();
    const constants = [];
    const keyed = [];

    for (const book of enabledBooks(enabledIds)) {
        for (const entry of book.entries) {
            if (entry.disabled || !entry.content) continue;
            if (entry.constant) {
                constants.push({ book, entry });
                continue;
            }
            const keys = Array.isArray(entry.keys) ? entry.keys : [];
            if (keys.some(k => haystack.includes(String(k).toLowerCase()))) {
                keyed.push({ book, entry });
            }
        }
    }

    const byUid = (a, b) => (Number(a.entry.uid) || 0) - (Number(b.entry.uid) || 0);
    constants.sort(byUid);
    keyed.sort(byUid);

    let used = 0;
    const included = [];
    const push = ({ book, entry }) => {
        let content = entry.content;
        if (maxC > 0) {
            const budget = maxC - used;
            if (budget <= 0) return false;
            if (content.length > budget) content = `${content.slice(0, budget)}…`;
            used += content.length;
        }
        included.push({ bookName: book.name, comment: entry.comment, content, constant: Boolean(entry.constant) });
        return true;
    };
    for (const h of constants) {
        if (!push(h)) break;
    }
    for (const h of (maxE > 0 ? keyed.slice(0, maxE) : keyed)) {
        if (!push(h)) break;
    }
    return included;
}

// 把命中条目拼装成喂给规划 API 的文本块
export function buildLoreContext(hits) {
    if (!hits?.length) return '（本次检索未命中任何世界书条目）';
    return hits.map(h => `【${h.bookName} / ${h.comment}】\n${h.content}`).join('\n\n');
}
