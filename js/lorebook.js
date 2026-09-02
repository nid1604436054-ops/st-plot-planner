// M1 世界书：导入（酒馆原生 JSON / 纯文本单条）+ 关键词检索
// 检索结果只喂给插件自己的调用，不影响主对话的提示词（开发方案 §M1）
// 第四十三轮（世界书选择机制重构）：库归设置页「世界书库」、只管内容（导入/改名/删/条目正文
// 与关键词数据/回收站/书类型）；「停用/关键词/常驻」三档状态与书的启用搬到监听页按聊天各存
// 一份（scanLorebooks 的 statusMap 模式），条目上的 disabled/constant 旧全局标记不再被任何
// 扫描读到（数据留在库里无害）；向导侧材料只带勾选条目（自选＋常驻按钮＋按关键词一键勾选），
// 自动检索从一次性生成里全部撤出——监听是唯一还自动带世界书的地方
import { settings, newId } from "./settings.js";

// 数据结构：
// Lorebook  { id, name, enabled, source, kind, entries: LoreEntry[] }
// LoreEntry { uid, comment, keys[], content, disabled, constant }
// （tags 字段在历史数据里可能还在，标签筛选功能已下线，不再参与任何检索）
// kind = 书类型（2026-09-02 动作指导书路线）：缺省/'normal' 普通世界书 | 'action' 动作指导书——
// 被动标签，条目收录规则完全不变；区别只在条目进剧情规划向导的材料时，规划提示词额外加
// 「动作参考」段（动作写法照条目、关键动作与节点挂钩）。长线不接。
// enabled（书的全局标记）：第四十三轮起只是「没动过书单的聊天」的种子默认——书单界面在
// 监听页按聊天存（chatdata 的 books 块），动过一次后以各聊天的书单为准

export function setBookKind(id, kind) {
    const book = settings.lorebooks.find(b => b.id === id);
    if (!book) return;
    book.kind = kind === 'action' ? 'action' : 'normal';
}

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
export function importSillyTavernJson(text, name, kind = 'normal') {
    const data = JSON.parse(text);
    const rawEntries = data.entries ?? data;
    const entries = Object.values(rawEntries ?? {}).map((e, i) => normalizeEntry(e, i));
    if (!entries.length) {
        throw new Error('未解析到任何条目（请确认是酒馆世界书导出的 JSON）');
    }
    return {
        id: newId('lb-'),
        name: name || '导入的世界书',
        enabled: true,
        source: 'st-json',
        ...(kind === 'action' ? { kind: 'action' } : {}),
        entries,
    };
}

// 纯文本：一次粘贴的整块就是一条条目，不做任何切块解析
export function createTextBook(name, keys = [], content = '', kind = 'normal') {
    return {
        id: newId('lb-'),
        name: name || '导入的文本世界书',
        enabled: true,
        source: 'plain-text',
        ...(kind === 'action' ? { kind: 'action' } : {}),
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

export function addEntry(bookId, { comment, keys, content } = {}) {
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

// ---------------------------------------------------------------------------
// 回收站：删除的书/条目先进这里（上限 30 条，超出丢最旧），世界书页可恢复或彻底删除。
// 删除不再是一锤子买卖——用户明确要过恢复功能
// ---------------------------------------------------------------------------

const TRASH_LIMIT = 30;

function pushTrash(item) {
    const trash = (settings.lorebookTrash ??= []);
    trash.unshift({ id: newId('tr-'), at: Date.now(), ...item });
    if (trash.length > TRASH_LIMIT) trash.length = TRASH_LIMIT;
}

export function trashBook(book) {
    pushTrash({ kind: 'book', book });
}

export function trashEntry(book, entry) {
    pushTrash({ kind: 'entry', bookId: book.id, bookName: book.name, entry });
}

// 恢复一条：书按原 id 放回（id 撞车换新 id），条目放回原书（原书没了按书名找，
// 还没有就恢复失败留在回收站，让用户先恢复那本书）。
// 第四十三轮：恢复的书一律按「默认未启用」落回（用户拍板「回收站只是备份、简单处理」——
// 启用归监听页按聊天存，恢复不主动接回任何书单）；已绑定书单的聊天里若恰好还存着这本书的
// id，那个聊天会重新看到它启用——属既有数据、不去逐聊天清洗
// 返回 { ok:true, bookId } = 成功（bookId 供界面展开那本书）；{ ok:false, error } = 失败原因
export function restoreTrashItem(id) {
    const trash = settings.lorebookTrash ?? [];
    const idx = trash.findIndex(t => t.id === id);
    if (idx < 0) return { ok: false, error: '回收站里没有这一条' };
    const item = trash[idx];
    if (item.kind === 'book') {
        if (settings.lorebooks.some(b => b.id === item.book.id)) item.book.id = newId('lb-');
        item.book.enabled = false;
        settings.lorebooks.push(item.book);
        trash.splice(idx, 1);
        return { ok: true, bookId: item.book.id };
    }
    const book = settings.lorebooks.find(b => b.id === item.bookId)
        ?? settings.lorebooks.find(b => b.name === item.bookName);
    if (!book) return { ok: false, error: `原书「${item.bookName}」已不在：请先从回收站恢复那本书` };
    // 条目删掉后 uid 可能被后来新增的条目占用，撞车就换新 uid
    if (book.entries.some(e => String(e.uid) === String(item.entry.uid))) {
        item.entry.uid = book.entries.reduce((m, e) => Math.max(m, Number(e.uid) || 0), -1) + 1;
    }
    book.entries.push(item.entry);
    trash.splice(idx, 1);
    return { ok: true, bookId: book.id };
}

export function purgeTrashItem(id) {
    settings.lorebookTrash = (settings.lorebookTrash ?? []).filter(t => t.id !== id);
}

export function clearTrash() {
    settings.lorebookTrash = [];
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
 * 检索：扫描 scanText，返回命中条目。三种模式：
 *
 * ① 默认（库状态）：命中规则＝所在书被启用（enabledIds 传入时以该对话书单为准）、内容非空，
 * 且（条目勾了常驻，或任一关键词（子串，大小写不敏感）出现在扫描文本里；停用条目不带）。
 * 常驻条目恒带出：排在最前、不占 maxEntries 名额（多条常驻不挤掉关键词命中），但仍与命中
 * 条目共用 maxChars 字符预算、优先消耗。第四十三轮起没有调用方走这条（旧全局状态已退役），
 * 保留作兜底。excludeKeys＝自选让位集（自选优先，同一条不进材料两次）。
 *
 * ② statusMap（监听）：条目三档状态按聊天传进来（{ 'bookId:uid': 'off' | 'key' | 'always' }，
 * 缺省＝'key'）——'off' 不带、'always' 恒带（结果里 constant 标记为 true，调用方据此把常驻档
 * 拆进提示词稳定段）、'key' 按关键词命中。书的大门仍由 enabledIds（监听页书单）管。
 *
 * ③ pure（向导「按关键词一键选择」）：纯关键词匹配——全库所有书所有条目（不看启用书单、
 * 不看任何状态）、不设条数与字符上限，命中的整条带出，供界面勾选。
 *
 * maxEntries / maxChars 为 0 表示不限制（命中多少带多少 / 不截断）。
 */
export function scanLorebooks(scanText, { maxEntries, maxChars, enabledIds, excludeKeys, statusMap, pure } = {}) {
    const haystack = String(scanText ?? '').toLowerCase();
    if (pure) {
        const out = [];
        for (const book of settings.lorebooks) {
            for (const entry of book.entries) {
                if (!entry.content) continue;
                const keys = Array.isArray(entry.keys) ? entry.keys : [];
                if (keys.some(k => haystack.includes(String(k).toLowerCase()))) {
                    out.push({ bookName: book.name, comment: entry.comment, content: entry.content, constant: false, bookId: book.id, uid: entry.uid, action: book.kind === 'action' });
                }
            }
        }
        return out;
    }
    const opts = settings.retrieval;
    const maxE = maxEntries ?? opts.maxEntries;
    const maxC = maxChars ?? opts.maxChars;
    const excluded = excludeKeys instanceof Set ? excludeKeys : null;
    const statusOf = statusMap && typeof statusMap === 'object' && !Array.isArray(statusMap)
        ? key => (statusMap[key] ?? 'key') : null;
    const constants = [];
    const keyed = [];

    for (const book of enabledBooks(enabledIds)) {
        for (const entry of book.entries) {
            if (!entry.content) continue;
            const key = `${book.id}:${entry.uid}`;
            if (excluded?.has(key)) continue;
            let isConst;
            if (statusOf) {
                const st = statusOf(key);
                if (st === 'off') continue;
                isConst = st === 'always';
            } else {
                if (entry.disabled) continue;
                isConst = Boolean(entry.constant);
            }
            if (isConst) {
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
    const push = ({ book, entry }, isConst) => {
        let content = entry.content;
        if (maxC > 0) {
            const budget = maxC - used;
            if (budget <= 0) return false;
            if (content.length > budget) content = `${content.slice(0, budget)}…`;
            used += content.length;
        }
        // bookId/action（2026-09-02 动作指导书）＋constant：命中对象带上出处书、类型标记与
        // 常驻旗——拼装文本（buildLoreContext）不读它们；规划侧据此决定要不要加「动作参考」段，
        // 监听侧据此把常驻档拆进提示词稳定段。constant 用本次判定出的档位（statusMap 的
        // 'always' 或库里的 constant），不直接读库标记——两种模式各自算好传进来
        included.push({ bookName: book.name, comment: entry.comment, content, constant: isConst, bookId: book.id, action: book.kind === 'action' });
        return true;
    };
    for (const h of constants) {
        if (!push(h, true)) break;
    }
    for (const h of (maxE > 0 ? keyed.slice(0, maxE) : keyed)) {
        if (!push(h, false)) break;
    }
    return included;
}

// 把命中条目拼装成喂给规划 API 的文本块
export function buildLoreContext(hits) {
    if (!hits?.length) return '（本次检索未命中任何世界书条目）';
    return hits.map(h => `【${h.bookName} / ${h.comment}】\n${h.content}`).join('\n\n');
}

// 世界书条目自选（第七轮 §6.10）：勾选键（「bookId:uid」）→ 现存的 {key, book, entry}。
// 不看关键词/常驻/书与条目的启用状态——勾选就是唯一口径（自选＝点名，与检索状态无关，
// 禁用的照样能勾）；书或条目被删后勾选静默失效（找不到就不带），内容为空的不带。
// 返回已按键去重、按传入顺序排列
export function resolveLorePicks(keys) {
    const seen = new Set();
    const out = [];
    for (const raw of keys ?? []) {
        const s = String(raw ?? '');
        const i = s.indexOf(':');
        if (i <= 0) continue;
        const bookId = s.slice(0, i);
        const uid = s.slice(i + 1);
        if (seen.has(s)) continue;
        const book = settings.lorebooks.find(b => b.id === bookId);
        const entry = book?.entries.find(e => String(e.uid) === String(uid));
        if (!entry || !entry.content) continue;
        seen.add(s);
        out.push({ key: s, book, entry });
    }
    return out;
}
