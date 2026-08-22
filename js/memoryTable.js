// M6 记忆表格：对接「记忆增强表格」插件（st-memory-enhancement）的数据
// 只读它的原始数据（不 import 它的代码）：
//   - 表定义+单元格值：chatMetadata.sheets（cellHistory 是 uid→文字 的值表）
//   - 当前生效版本：聊天楼层上的 hash_sheets 快照（从最新往回找，跳过用户消息）
//   - 旧版数据：楼层上的 dataTable（columns + content 二维数组）
//
// v2 结构：原表与镜像分离。
//   - 原表库 state.source：后台自动同步 + 历史备份（防高楼层数据清空），只读展示
//   - 镜像 state.mirror：用户随意编辑的工作版（改内容/删行/删大类/加行），召回注入只用镜像
//   - 同步只更新原表库；合并（同步按钮的第二步）把新行带「新」标进来，
//     用户编辑过的行不被覆盖（原表改动只标「原表已更新」），删除过的行内容不变不复活（墓碑按内容指纹）
import { getTavernContext } from "./context.js";
import { chatCompletion } from "./api.js";
import { extractJson } from "./utils.js";
import { newId } from "./settings.js";

const STATE_KEY = 'plotPlannerMemory';
const MAX_BACKUPS = 20;

// ---------------------------------------------------------------------------
// 指纹与工具
// ---------------------------------------------------------------------------

// 列结构参与指纹：改列名/加列会让整表行全部「重新出现」，符合"结构变化值得重审"的设计
export function rowFingerprint(sheetUid, columns, cells) {
    const norm = [
        String(sheetUid ?? ''),
        columns.map(c => String(c ?? '').trim()).join('\u0001'),
        cells.map(c => String(c ?? '').trim()).join('\u0001'),
    ].join('\u0002');
    let h1 = 5381;
    let h2 = 52711;
    for (let i = 0; i < norm.length; i++) {
        const c = norm.charCodeAt(i);
        h1 = ((h1 << 5) + h1 + c) >>> 0;
        h2 = ((h2 << 5) + h2 + c) >>> 0;
    }
    return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

function totalRows(sheets) {
    return sheets.reduce((n, s) => n + (s.rows?.length ?? 0), 0);
}

// ---------------------------------------------------------------------------
// 读取器：把原表数据还原成 { uid, name, enable, columns, rows(纯文字二维) }
// ---------------------------------------------------------------------------

function cellValueMap(sheetDef) {
    const map = new Map();
    for (const c of sheetDef.cellHistory ?? []) {
        map.set(c?.uid, String(c?.data?.value ?? ''));
    }
    return map;
}

// 从最新往回找第一条带表格数据的 AI 消息（它自己的读取顺序也是这样）
function latestPiece(ctx) {
    const chat = Array.isArray(ctx.chat) ? ctx.chat : [];
    for (let i = chat.length - 1; i >= 0; i--) {
        const m = chat[i];
        if (!m || m.is_user === true) continue;
        if (m.hash_sheets || m.dataTable) return m;
    }
    return null;
}

function normalizeSheet(def, structure) {
    const values = cellValueMap(def);
    const grid = (structure ?? def.hashSheet ?? [])
        .map(row => (row ?? []).map(uid => values.get(uid) ?? ''));
    const columns = grid.length ? grid[0].slice(1).map(v => v.trim()) : [];
    const rows = [];
    for (const r of grid.slice(1)) {
        const cells = columns.map((_, i) => String(r[i + 1] ?? '').trim());
        if (cells.some(v => v)) rows.push(cells);   // 跳过全空行
    }
    return {
        uid: String(def.uid ?? ''),
        name: String(def.name ?? def.uid ?? '未命名'),
        enable: def.enable !== false,
        columns,
        rows,
    };
}

function normalizeOldTable(t) {
    const columns = (t.columns ?? []).map(v => String(v ?? '').trim());
    const rows = (t.content ?? [])
        .map(r => columns.map((_, i) => String(r?.[i] ?? '').trim()))
        .filter(cells => cells.some(v => v));
    return {
        uid: `old:${t.tableName}`,
        name: String(t.tableName ?? '未命名'),
        enable: t.enable !== false,
        columns,
        rows,
    };
}

export function readMemorySheets() {
    const ctx = getTavernContext();
    const defs = Array.isArray(ctx.chatMetadata?.sheets) ? ctx.chatMetadata.sheets : [];
    const piece = latestPiece(ctx);
    if (defs.length) {
        const snaps = piece?.hash_sheets ?? {};
        return defs.map(def => normalizeSheet(def, snaps[def.uid]));
    }
    if (piece?.dataTable) return piece.dataTable.map(normalizeOldTable);
    return [];
}

// ---------------------------------------------------------------------------
// 状态：原表库 / 镜像 / 备份 / 墓碑 / 标签 / 召回配置，存在 chatMetadata，跟聊天走
// ---------------------------------------------------------------------------

export function memoryState() {
    const ctx = getTavernContext();
    const meta = (ctx.chatMetadata ??= {});
    const state = (meta[STATE_KEY] ??= {
        version: 2,
        source: { syncedAt: 0, sheets: [] },   // 原表库：自动同步的只读快照
        mirror: { sheets: [] },                 // 镜像：用户随意编辑的工作版
        backups: [],                            // 原表库历史快照 [{ at, sheets }]
        tombstones: {},                         // { [源指纹]: { at, sheetUid, sheetName, columns, cells } }
        tags: {},                               // { [rid]: ['战斗','背叛'] }
        sheetRecall: {},                        // { [sheetUid]: { enabled, columns:[原列下标] } }
        recallTags: [],                         // 召回命中的标签；空 = 全部行
        seen: [],                               // 已看过的行 rid，用于「新」标
        tagStandard: '',                        // AI 打标签的分类标准（上次使用）
        wipeAlert: null,
    });
    if (state.version !== 2) migrateV1(state);
    return state;
}

// v1（镜像=自动同步的原表）迁移到 v2：原表库从旧镜像初始化，镜像行带上源指纹
function migrateV1(state) {
    const old = Array.isArray(state.mirror?.sheets) ? state.mirror.sheets : [];
    state.source = {
        syncedAt: state.syncedAt ?? 0,
        sheets: old.map(s => ({
            uid: s.uid, name: s.name, enable: s.enable !== false,
            columns: s.columns ?? [],
            rows: (s.rows ?? []).map(r => ({ fp: r.fp, cells: r.cells })),
        })),
    };
    state.mirror = {
        sheets: old.map(s => ({
            uid: s.uid, name: s.name, enable: s.enable !== false,
            columns: s.columns ?? [],
            rows: (s.rows ?? []).map(r => ({
                rid: r.fp, sfp: r.fp,
                cells: r.cells, srcCells: r.cells,
                edited: false,
            })),
        })),
    };
    // v1 的 tags/seen 以指纹为键，迁移行的 rid = 指纹，键值正好沿用
    state.tags ??= {};
    state.seen ??= [];
    state.tombstones ??= {};
    state.sheetRecall ??= {};
    state.recallTags ??= [];
    state.backups ??= [];
    state.tagStandard ??= '';
    state.wipeAlert ??= null;
    state.version = 2;
}

let saveTimer = null;
export function persistMemory() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        try { getTavernContext().saveChat?.(); }
        catch (e) { console.warn('[PlotPlanner] 记忆表格状态保存失败', e); }
    }, 800);
}

// ---------------------------------------------------------------------------
// 同步：源头 → 原表库；清空保护；变化归档备份。不动镜像。
// ---------------------------------------------------------------------------

export function syncMemory({ force = false } = {}) {
    const state = memoryState();
    const source = readMemorySheets();
    const srcRows = totalRows(source);
    const libRows = totalRows(state.source.sheets);

    // 清空保护：源头空了而库里有内容 → 判定清空事故，绝不拿空数据覆盖原表库/备份
    if (srcRows === 0 && libRows > 0 && !force) {
        if (!state.wipeAlert) state.wipeAlert = { at: Date.now(), rows: libRows, notified: false };
        persistMemory();
        return { wiped: true, changed: false, state };
    }

    // 与库里已存的快照同构（行带指纹）后再比较，否则永远判不等
    const fingerprinted = source.map(s => ({
        uid: s.uid, name: s.name, enable: s.enable,
        columns: s.columns,
        rows: s.rows.map(cells => ({ fp: rowFingerprint(s.uid, s.columns, cells), cells })),
    }));
    if (JSON.stringify(fingerprinted) === JSON.stringify(state.source.sheets)) {
        return { wiped: false, changed: false, state };
    }

    const firstSync = (state.source.syncedAt ?? 0) === 0 && libRows === 0;
    if (!firstSync) {
        state.backups.unshift({ at: state.source.syncedAt, sheets: state.source.sheets });
        state.backups = state.backups.filter((b, i, arr) =>
            i === 0 || JSON.stringify(b.sheets) !== JSON.stringify(arr[i - 1].sheets));
        if (state.backups.length > MAX_BACKUPS) state.backups.length = MAX_BACKUPS;
    }

    state.source = { syncedAt: Date.now(), sheets: fingerprinted };
    state.wipeAlert = null;
    persistMemory();
    return { wiped: false, changed: true, state };
}

// ---------------------------------------------------------------------------
// 镜像合并：原表库 → 镜像。规则：
//   新行（未删除过）带 rid=指纹进来（UI 标「新」）；墓碑行不复活；
//   未编辑的行静默跟原表刷新；编辑过的行保留编辑、原表有改动只标「原表已更新」；
//   原表删掉的行：未编辑的随之移除，编辑过的保留并标「原表已删」；
//   原表整表消失：镜像表里只剩未编辑的源行则整表移除；空的镜像表（原表空模板）一律不进镜像
// ---------------------------------------------------------------------------

export function mergeMirrorFromSource() {
    const state = memoryState();
    const srcSheets = state.source.sheets.filter(s => s.rows.length > 0);
    const srcByUid = new Map(srcSheets.map(s => [s.uid, s]));
    const firstBuild = state.mirror.sheets.length === 0;
    const before = JSON.stringify(state.mirror.sheets);
    let added = 0;

    for (const src of srcSheets) {
        let m = state.mirror.sheets.find(x => x.uid === src.uid);
        if (!m) {
            m = { uid: src.uid, name: src.name, enable: src.enable, columns: [...src.columns], rows: [] };
            state.mirror.sheets.push(m);
        } else {
            m.name = src.name;
            m.enable = src.enable;
            m.columns = [...src.columns];
        }

        const live = new Map(src.rows.map(r => [r.fp, r]));
        m.rows = m.rows.filter(r => {
            if (r.sfp == null) return true;                    // 用户手动加的行
            if (live.has(r.sfp)) return true;
            if (r.edited) { r.srcGone = true; return true; }   // 编辑过的保留，标「原表已删」
            return false;                                      // 未编辑的随原表移除
        });
        m.rows.forEach(r => { if (r.sfp != null && live.has(r.sfp)) r.srcGone = false; });

        const bySfp = new Map(m.rows.filter(r => r.sfp != null).map(r => [r.sfp, r]));
        for (const sr of src.rows) {
            if (state.tombstones[sr.fp]) continue;             // 删除过且内容没变 → 不复活
            const row = bySfp.get(sr.fp);
            if (row) {
                if (!row.edited) row.cells = [...sr.cells];
                else if (JSON.stringify(row.srcCells) !== JSON.stringify(sr.cells)) row.srcUpdated = true;
                row.srcCells = [...sr.cells];
            } else {
                m.rows.push({ rid: sr.fp, sfp: sr.fp, cells: [...sr.cells], srcCells: [...sr.cells], edited: false });
                added++;
            }
        }
    }

    // 原表整表消失：只剩未编辑源行的镜像表移除；合并后仍为空的表也移除（空模板不进镜像）
    state.mirror.sheets = state.mirror.sheets.filter(m => {
        if (m.rows.length === 0) return false;
        if (srcByUid.has(m.uid)) return true;
        return m.rows.some(r => r.sfp == null || r.edited);
    });

    // 首次建镜像：全部标为已看，避免满屏「新」
    if (firstBuild) markSeen(state, state.mirror.sheets.flatMap(s => s.rows.map(r => r.rid)));

    const changed = JSON.stringify(state.mirror.sheets) !== before;
    if (changed) persistMemory();
    return { added: firstBuild ? 0 : added, changed };
}

// ---------------------------------------------------------------------------
// 镜像编辑：行内容 / 删行 / 删整类 / 加行 / 采纳原表版本
// ---------------------------------------------------------------------------

function findMirrorSheet(uid) {
    return memoryState().mirror.sheets.find(s => s.uid === uid);
}

export function editMirrorRow(uid, rid, cells) {
    const state = memoryState();
    const sheet = state.mirror.sheets.find(s => s.uid === uid);
    const row = sheet?.rows.find(r => r.rid === rid);
    if (!row) return;
    row.cells = cells.map(v => String(v ?? '').trim());
    row.edited = true;
    persistMemory();
}

export function acceptSourceRow(uid, rid) {
    const state = memoryState();
    const row = state.mirror.sheets.find(s => s.uid === uid)?.rows.find(r => r.rid === rid);
    if (!row?.srcCells) return;
    row.cells = [...row.srcCells];
    row.edited = false;
    row.srcUpdated = false;
    persistMemory();
}

export function addMirrorRow(uid, cells) {
    const state = memoryState();
    const sheet = state.mirror.sheets.find(s => s.uid === uid);
    if (!sheet) return;
    const clean = cells.map(v => String(v ?? '').trim());
    if (!clean.some(v => v)) return;
    sheet.rows.push({ rid: newId('r_'), sfp: null, cells: clean, srcCells: null, edited: true });
    persistMemory();
}

// 删行：源行记墓碑（原表内容不变就不复活）；手加行直接消失
export function deleteMirrorRow(uid, rid) {
    const state = memoryState();
    const sheet = state.mirror.sheets.find(s => s.uid === uid);
    const row = sheet?.rows.find(r => r.rid === rid);
    if (!row) return;
    if (row.sfp != null) {
        state.tombstones[row.sfp] = {
            at: Date.now(), sheetUid: uid, sheetName: sheet.name,
            columns: sheet.columns, cells: row.srcCells ?? row.cells,
        };
    }
    delete state.tags[rid];
    sheet.rows = sheet.rows.filter(r => r.rid !== rid);
    if (!sheet.rows.length) state.mirror.sheets = state.mirror.sheets.filter(s => s.uid !== uid);
    persistMemory();
}

// 删整类：该表所有源行记墓碑（内容不变整类不回来），手加行直接消失；原表不动
export function deleteMirrorSheet(uid) {
    const state = memoryState();
    const sheet = state.mirror.sheets.find(s => s.uid === uid);
    if (!sheet) return;
    const now = Date.now();
    for (const r of sheet.rows) {
        if (r.sfp != null) {
            state.tombstones[r.sfp] = {
                at: now, sheetUid: uid, sheetName: sheet.name,
                columns: sheet.columns, cells: r.srcCells ?? r.cells,
            };
        }
        delete state.tags[r.rid];
    }
    state.mirror.sheets = state.mirror.sheets.filter(s => s.uid !== uid);
    persistMemory();
}

// 恢复显示：从墓碑把行放回镜像（表被清掉则按墓碑里存的结构重建）
export function undeleteRow(fp) {
    const state = memoryState();
    const t = state.tombstones[fp];
    if (!t) return;
    let sheet = state.mirror.sheets.find(s => s.uid === t.sheetUid);
    if (!sheet) {
        sheet = { uid: t.sheetUid, name: t.sheetName ?? t.sheetUid, enable: true, columns: t.columns ?? [], rows: [] };
        state.mirror.sheets.push(sheet);
    }
    sheet.rows.push({ rid: fp, sfp: fp, cells: [...t.cells], srcCells: [...t.cells], edited: false });
    delete state.tombstones[fp];
    persistMemory();
}

// 清掉"原表里已经不存在对应行"的墓碑记录，防止名单无限膨胀
export function purgeMootTombstones() {
    const state = memoryState();
    const live = new Set(state.source.sheets.flatMap(s => s.rows.map(r => r.fp)));
    let n = 0;
    for (const fp of Object.keys(state.tombstones)) {
        if (!live.has(fp)) { delete state.tombstones[fp]; n++; }
    }
    if (n) persistMemory();
    return n;
}

// ---------------------------------------------------------------------------
// 标签 / 已读
// ---------------------------------------------------------------------------

export function setRowTags(rid, tags) {
    const state = memoryState();
    if (tags.length) state.tags[rid] = tags;
    else delete state.tags[rid];
    markSeen(state, [rid]);
    persistMemory();
}

export function markSeen(state, rids) {
    state.seen = [...new Set([...state.seen, ...rids])];
}

export function newRowCount(state) {
    const seen = new Set(state.seen);
    return state.mirror.sheets.reduce((n, s) =>
        n + s.rows.filter(r => !seen.has(r.rid)).length, 0);
}

export function allTags(state) {
    const counts = new Map();
    for (const list of Object.values(state.tags)) {
        for (const t of list) counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

// ---------------------------------------------------------------------------
// AI 自动打标签：把镜像里没标签的行分批丢给独立 API 分类
// ---------------------------------------------------------------------------

const TAGGER_SYSTEM = [
    '你是角色扮演记忆条目的自动分类器。逐条阅读给出的记忆条目，为每条打 1~3 个标签。',
    '标签优先从「分类标准」里列出的类别名中选取（可多选）；标准未覆盖到的内容，自拟 2~6 字的简短标签。',
    '只输出一个 JSON 对象，格式：{"rows":[{"id":"条目id","tags":["标签"]}]}，不要输出任何其他文字。',
].join('\n');

export async function autoTagRows({ standard = '', overwrite = false, onProgress = null } = {}) {
    const state = memoryState();
    const rows = [];
    for (const sheet of state.mirror.sheets) {
        for (const r of sheet.rows) {
            if (!overwrite && (state.tags[r.rid] ?? []).length) continue;
            rows.push({ rid: r.rid, cols: sheet.columns, cells: r.cells });
        }
    }
    if (!rows.length) return { tagged: 0, total: 0 };

    const BATCH = 40;
    let tagged = 0;
    for (let i = 0; i < rows.length; i += BATCH) {
        const batch = rows.slice(i, i + BATCH);
        const lines = batch.map(r =>
            `[${r.rid}] ` + r.cells.map((c, j) => `${r.cols[j] ?? j}:${c}`).join(' | ')).join('\n');
        const raw = await chatCompletion({
            temperature: 0.2,
            maxTokens: 4000,
            messages: [
                { role: 'system', content: TAGGER_SYSTEM },
                {
                    role: 'user',
                    content: [
                        '## 分类标准',
                        standard.trim() || '（未给出，请按内容自拟简短类别，如：战斗、感情、约定、物品、地点）',
                        '## 记忆条目',
                        lines,
                        '只输出 JSON。',
                    ].join('\n\n'),
                },
            ],
        });
        const data = extractJson(raw);
        const validIds = new Set(batch.map(r => r.rid));
        for (const item of data?.rows ?? []) {
            const rid = String(item?.id ?? '');
            const tags = [...new Set((item?.tags ?? []).map(t => String(t).trim()).filter(Boolean))].slice(0, 3);
            if (!rid || !validIds.has(rid) || !tags.length) continue;
            state.tags[rid] = tags;
            tagged++;
        }
        onProgress?.(Math.min(i + BATCH, rows.length), rows.length);
    }
    persistMemory();
    return { tagged, total: rows.length };
}

// ---------------------------------------------------------------------------
// 召回：按标签筛选镜像行，输出沿用记忆表格插件的提示词格式
// ---------------------------------------------------------------------------

function csvSafe(v) {
    return String(v ?? '').replace(/,/g, '，').replace(/\s+/g, ' ');
}

function pickColumns(values, indices) {
    return indices ? indices.map(i => values[i]).filter(v => v !== undefined) : values;
}

export function buildMemoryContext({ tagFilter = null, maxChars = 4000 } = {}) {
    const state = memoryState();
    const want = (tagFilter ?? state.recallTags).filter(Boolean);
    const blocks = [];
    for (const sheet of state.mirror.sheets) {
        const recall = state.sheetRecall[sheet.uid] ?? {};
        if (recall.enabled === false) continue;
        const colIdx = Array.isArray(recall.columns) ? recall.columns : null;
        const rows = sheet.rows
            .filter(r => want.length === 0 || (state.tags[r.rid] ?? []).some(t => want.includes(t)))
            .map(r => pickColumns(r.cells, colIdx));
        if (!rows.length) continue;
        const header = 'rowIndex,' + pickColumns(sheet.columns, colIdx).map((c, i) => `${i}:${csvSafe(c)}`).join(',');
        const body = rows.map((r, i) => `${i},${r.map(csvSafe).join(',')}`).join('\n');
        blocks.push(`* ${blocks.length}:${sheet.name}\n【表格内容】\n${header}\n${body}`);
    }
    const text = blocks.join('\n');
    return text.length > maxChars ? text.slice(0, maxChars) + '\n…（超长截断）' : text;
}

// ---------------------------------------------------------------------------
// 恢复：把原表库快照里缺失的行插回原表（只增不改，走它的全局写接口）
// ---------------------------------------------------------------------------

export async function restoreFromBackup(sheets) {
    const adapter = window.externalDataAdapter;
    if (!adapter?.processJsonData) {
        throw new Error('未找到记忆表格插件的写入接口，请确认「记忆增强表格」插件已启用');
    }
    const current = readMemorySheets();
    const enabled = current.filter(s => s.enable);
    const ops = [];
    for (const sheet of sheets) {
        // 优先按 uid 找目标表，找不到（比如表被重建过）退回按表名找
        let idx = enabled.findIndex(s => s.uid === sheet.uid);
        if (idx === -1) idx = enabled.findIndex(s => s.name === sheet.name);
        if (idx === -1) continue;
        const target = enabled[idx];
        const liveFps = new Set(
            current.filter(s => s.uid === target.uid || s.name === target.name)
                .flatMap(s => s.rows.map(cells => rowFingerprint(s.uid, s.columns, cells))));
        for (const r of sheet.rows ?? []) {
            const cells = r.cells ?? r;
            if (liveFps.has(rowFingerprint(target.uid, sheet.columns ?? [], cells))) continue;
            const data = {};
            cells.forEach((v, i) => { if (String(v).trim()) data[String(i)] = String(v); });
            if (Object.keys(data).length) ops.push({ type: 'insert', tableIndex: idx, data });
        }
    }
    if (!ops.length) throw new Error('没有需要恢复的行（可能都已在原表中）');
    const res = await adapter.processJsonData(ops);
    if (!res?.success) throw new Error(res?.message || '恢复失败');
    syncMemory();
    mergeMirrorFromSource();
    return ops.length;
}
