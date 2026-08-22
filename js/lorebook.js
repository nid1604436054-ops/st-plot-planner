// M1 世界书：导入（酒馆原生 JSON / 纯文本）+ 关键词/正则检索
// 检索结果只喂给插件自己的规划调用，不影响主对话的提示词（开发方案 §M1）
import { settings, newId } from "./settings.js";

// 数据结构：
// Lorebook  { id, name, enabled, source, entries: LoreEntry[] }
// LoreEntry { uid, comment, keys[], secondaryKeys[], regex[], content, constant, order, disabled }

export function normalizeEntry(raw = {}, index = 0) {
    return {
        uid: raw.uid ?? index,
        comment: raw.comment || `条目 ${index + 1}`,
        keys: (Array.isArray(raw.key) ? raw.key : (raw.keys ?? [])).filter(Boolean).map(String),
        secondaryKeys: (Array.isArray(raw.keysecondary) ? raw.keysecondary : (raw.secondaryKeys ?? [])).filter(Boolean).map(String),
        regex: (raw.regex ?? []).filter(Boolean).map(String),
        content: String(raw.content ?? ''),
        constant: Boolean(raw.constant),
        order: Number.isFinite(raw.order) ? raw.order : 100,
        disabled: Boolean(raw.disable ?? raw.disabled),
    };
}

// 导入酒馆原生世界书 JSON（entries 为对象或数组均可）
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

// 导入纯文本。格式约定（开发方案 §M1）：
//   - 单独一行 “---” 分隔条目
//   - 条目首行可为 “# 标题 | 关键词1,关键词2”
//   - 关键词段以 [常驻] 开头表示 constant
export function importPlainText(text, name) {
    const blocks = text.split(/^\s*---\s*$/m).map(b => b.trim()).filter(Boolean);
    if (!blocks.length) throw new Error('未解析到任何内容块');
    const entries = blocks.map((block, i) => {
        const lines = block.split('\n');
        let comment = `条目 ${i + 1}`;
        let keys = [];
        let constant = false;
        let content = block;
        const header = lines[0].match(/^#\s*(.+?)(?:\s*\|\s*(.*))?$/);
        if (header) {
            comment = header[1].trim();
            let keyPart = (header[2] ?? '').trim();
            if (/^\[常驻\]/.test(keyPart)) {
                constant = true;
                keyPart = keyPart.replace(/^\[常驻\]\s*/, '');
            }
            keys = keyPart ? keyPart.split(/[,，]/).map(s => s.trim()).filter(Boolean) : [];
            content = lines.slice(1).join('\n').trim();
        }
        return { uid: i, comment, keys, secondaryKeys: [], regex: [], content, constant, order: 100, disabled: false };
    });
    return {
        id: newId('lb-'),
        name: name || '导入的文本世界书',
        enabled: true,
        source: 'plain-text',
        entries,
    };
}

export function addLorebook(book) {
    settings.lorebooks.push(book);
    return book;
}

export function removeLorebook(id) {
    settings.lorebooks = settings.lorebooks.filter(b => b.id !== id);
}

function enabledBooks() {
    return settings.lorebooks.filter(b => b.enabled);
}

function toRegex(pattern) {
    try {
        return new RegExp(pattern, 'i');
    } catch {
        return null; // 无效正则直接跳过
    }
}

/**
 * 检索：扫描 scanText，返回跨所有启用书籍的命中条目。
 * 命中规则：constant 恒命中；任一主关键词子串命中（若设有次关键词，还需任一次关键词命中）；
 * 任一正则 test 通过。按 order 升序截断，总量受 maxChars 限制。
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
            let hit = entry.constant;
            if (!hit && entry.keys.length) {
                const primary = entry.keys.some(k => haystack.includes(String(k).toLowerCase()));
                const secondaryOk = !entry.secondaryKeys.length
                    || entry.secondaryKeys.some(k => haystack.includes(String(k).toLowerCase()));
                hit = primary && secondaryOk;
            }
            if (!hit && entry.regex.length) {
                hit = entry.regex.some(p => {
                    const re = toRegex(p);
                    return re && re.test(String(scanText ?? ''));
                });
            }
            if (hit) hits.push({ book, entry });
        }
    }

    hits.sort((a, b) => (a.entry.order - b.entry.order) || (a.entry.uid - b.entry.uid));

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
