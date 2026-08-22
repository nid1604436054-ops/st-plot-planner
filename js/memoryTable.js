// M6 记忆表格：对接「记忆增强表格」插件（st-memory-enhancement）的数据
// 只读它的原始数据（不 import 它的代码）：
//   - 表定义+单元格值：chatMetadata.sheets（cellHistory 是 uid→文字 的值表）
//   - 当前生效版本：聊天楼层上的 hash_sheets 快照（从最新往回找，跳过用户消息）
//   - 旧版数据：楼层上的 dataTable（columns + content 二维数组）
// 我们的镜像 / 备份 / 删除墓碑 / 标签存在 chatMetadata.plotPlannerMemory，与原表互不干扰。
//
// 删除规则（墓碑）：按「整行内容指纹」判定。行内容一个字没变 → 命中墓碑就一直隐藏；
// 原表那行被修改或新增 → 指纹不同 → 重新出现（UI 标「新」），等用户重新处理。
import { getTavernContext } from "./context.js";

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

function withFingerprints(sheets) {
    return sheets.map(s => ({
        uid: s.uid,
        name: s.name,
        enable: s.enable !== false,
        columns: s.columns ?? [],
        rows: (s.rows ?? []).map(cells => ({
            fp: rowFingerprint(s.uid, s.columns ?? [], cells),
            cells,
        })),
    }));
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
// 状态：镜像 / 备份 / 墓碑 / 标签 / 召回配置，存在 chatMetadata，跟聊天走
// ---------------------------------------------------------------------------

export function memoryState() {
    const ctx = getTavernContext();
    const meta = (ctx.chatMetadata ??= {});
    return (meta[STATE_KEY] ??= {
        version: 1,
        syncedAt: 0,
        mirror: { sheets: [] },     // 最新镜像（带指纹）
        backups: [],                // 历史快照 [{ at, sheets }]，内容有变化才归档
        tombstones: {},             // { [fp]: { at, sheetUid, cells } } 删除名单
        tags: {},                   // { [fp]: ['战斗','背叛'] }
        sheetRecall: {},            // { [sheetUid]: { enabled, columns:[原列下标] } }
        recallTags: [],             // 召回命中的标签；空 = 全部未删除行
        seen: [],                   // 已看过的行指纹，用于「新」标
        wipeAlert: null,            // 清空事故 { at, rows, notified }
    });
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
// 同步：源头 → 镜像；清空保护；变化归档备份
// ---------------------------------------------------------------------------

export function syncMemory({ force = false } = {}) {
    const state = memoryState();
    const source = readMemorySheets();
    const srcRows = totalRows(source);
    const mirRows = totalRows(state.mirror.sheets);

    // 清空保护：源头空了而镜像有内容 → 判定清空事故，绝不拿空数据覆盖镜像/备份
    if (srcRows === 0 && mirRows > 0 && !force) {
        if (!state.wipeAlert) state.wipeAlert = { at: Date.now(), rows: mirRows, notified: false };
        persistMemory();
        return { wiped: true, changed: false, newCount: 0, state };
    }

    if (JSON.stringify(source) === JSON.stringify(state.mirror.sheets.map(s => ({
        uid: s.uid, name: s.name, enable: s.enable, columns: s.columns, rows: s.rows.map(r => r.cells),
    })))) {
        return { wiped: false, changed: false, newCount: 0, state };
    }

    const firstSync = state.syncedAt === 0 || mirRows === 0;
    const prevFps = new Set(state.mirror.sheets.flatMap(s => s.rows.map(r => r.fp)));

    // 旧镜像归档为备份（首次同步没有可归档的旧状态）
    if (!firstSync) {
        state.backups.unshift({ at: state.syncedAt, sheets: state.mirror.sheets });
        state.backups = state.backups.filter((b, i, arr) =>
            i === 0 || JSON.stringify(b.sheets) !== JSON.stringify(arr[i - 1].sheets));
        if (state.backups.length > MAX_BACKUPS) state.backups.length = MAX_BACKUPS;
    }

    state.mirror = { sheets: withFingerprints(source) };
    state.syncedAt = Date.now();
    state.wipeAlert = null;

    let newCount = 0;
    for (const sheet of state.mirror.sheets) {
        for (const r of sheet.rows) {
            if (!prevFps.has(r.fp)) newCount++;
        }
    }
    if (firstSync) {
        // 首次同步全部标为已看，避免满屏「新」
        markSeen(state, state.mirror.sheets.flatMap(s => s.rows.map(r => r.fp)));
        newCount = 0;
    }
    persistMemory();
    return { wiped: false, changed: true, newCount, state };
}

// ---------------------------------------------------------------------------
// 墓碑 / 标签 / 已读
// ---------------------------------------------------------------------------

export function deleteRow(fp, sheetUid, cells) {
    const state = memoryState();
    state.tombstones[fp] = { at: Date.now(), sheetUid, cells };
    delete state.tags[fp];
    markSeen(state, [fp]);
    persistMemory();
}

export function undeleteRow(fp) {
    const state = memoryState();
    delete state.tombstones[fp];
    persistMemory();
}

// 清掉"原表里已经不存在对应行"的墓碑记录，防止名单无限膨胀
export function purgeMootTombstones() {
    const state = memoryState();
    const live = new Set(state.mirror.sheets.flatMap(s => s.rows.map(r => r.fp)));
    let n = 0;
    for (const fp of Object.keys(state.tombstones)) {
        if (!live.has(fp)) { delete state.tombstones[fp]; n++; }
    }
    if (n) persistMemory();
    return n;
}

export function setRowTags(fp, tags) {
    const state = memoryState();
    if (tags.length) state.tags[fp] = tags;
    else delete state.tags[fp];
    markSeen(state, [fp]);
    persistMemory();
}

export function markSeen(state, fps) {
    state.seen = [...new Set([...state.seen, ...fps])];
}

export function newRowCount(state) {
    const seen = new Set(state.seen);
    return state.mirror.sheets.reduce((n, s) =>
        n + s.rows.filter(r => !seen.has(r.fp)).length, 0);
}

export function allTags(state) {
    const counts = new Map();
    for (const list of Object.values(state.tags)) {
        for (const t of list) counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

// ---------------------------------------------------------------------------
// 召回：按标签筛选未删除行，输出沿用记忆表格插件的提示词格式
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
        if (recall.enabled === false || sheet.enable === false) continue;
        const colIdx = Array.isArray(recall.columns) ? recall.columns : null;
        const rows = sheet.rows
            .filter(r => !state.tombstones[r.fp])
            .filter(r => want.length === 0 || (state.tags[r.fp] ?? []).some(t => want.includes(t)))
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
// 恢复：把镜像/备份里缺失的行插回原表（只增不改，走它的全局写接口）
// ---------------------------------------------------------------------------

export async function restoreFromBackup(sheets) {
    const adapter = window.externalDataAdapter;
    if (!adapter?.processJsonData) {
        throw new Error('未找到记忆表格插件的写入接口，请先打开一次它的面板再重试');
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
            withFingerprints(current.filter(s => s.uid === target.uid || s.name === target.name))
                .flatMap(s => s.rows.map(r => r.fp)));
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
    return ops.length;
}
