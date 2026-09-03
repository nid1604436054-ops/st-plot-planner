// 2.0 长线规划（DESIGN §6.2-6.7，2026-08-30 落码）：书-卷-章-节点 四层的数据层与生成管线编排。
// 产物不直接注入扮演模型——「章」挂进监听当最小剧情单位逐轮执行（§6.1 反剧透决策）。
// 管线：①骨架（含②切块，一次调用出卷＋楼数，插件校验总和、楼数算术插件说了算）→
// ③分块具体化（逐卷并行一次一卷，卷级文本内嵌推进锚）→ ④拼接（纯展示）→
// ⑤审阅改（按意见整书修订 / 卷文本就地手改）→ ⑥再切小（逐卷并行：卷→章→节点）→ 挂载执行。
// 暂停收尾（停进提示/已暂停显示）与混合重编见 listener.js / mix.js（2026-09-02 落地）；
// 归档不做（2026-09-02 用户复盘拍板：冷却机制够用）。
import { settings, newId } from "./settings.js";
import { loadChatData, saveChatData, flushChatData } from "./chatdata.js";
import { chatCompletion, parseModelJson } from "./api.js";
import { materialSections } from "./materials.js";
import { storyState, activeStory } from "./story.js";
import { listenerState, opMountUnit, runReentryRound, collectFloorsFromChat, lastRoleFloor, rollbackListenerFloors } from "./listener.js";
import { getTavernContext } from "./context.js";
import { storageItemsInEffect } from "./store.js";
import { knowledgeLists, payloadFromIds, entryText } from "./knowledge.js";

// 数值（§6.8：2026-08-28 用户终审；节点下限 3 是唯一未点名项，按提案默认执行）
export const LF_MIN_ANCHORS = 2;          // 推进锚每卷下限（2026-09-01 用户拍板 4→2：锚跟章走、每章 1-2 个）
export const LF_MIN_CHAPTER_FLOORS = 20;  // 一章至少 20 层楼、不设上限（原 10-20 区间作废）
export const LF_MIN_NODES = 3;            // 每章节点下限
export const LF_DEFAULT_FLOORS = 120;     // 楼层总数缺省兜底（助手默认；§6.3「用户不填用默认值兜底」）
export const LF_MIX_LOG_KEEP = 5;         // 每章「混合历史」保留版数上限（mix.js 混合重编的旧版快照；可驳默认）

// ---------------------------------------------------------------------------
// 数据层：chatdata 的 longform 块（按聊天走，§6.6「长线数据按聊天分开存」）
// ---------------------------------------------------------------------------

export function lfState() {
    const st = loadChatData('longform', () => ({
        version: 1,
        stage: 'none',            // none → skeleton → detailed → split（split 之后是执行期）
        totalFloors: LF_DEFAULT_FLOORS,
        minFloors: 0,             // 保底楼数（0 = 未设）
        idea: '', newChars: false,
        materialNote: '',         // 骨架那次实际携带的材料概览（事后可对账）
        mats: null,               // 材料面板勾选（第十九轮）：null=未初始化（见 normalize 的默认）
        createdAt: 0,
        volumes: [],
        mount: null,              // { vol, ch, unitId, at } 当前挂进监听的章
        error: '',                // 最近一次失败原因（页面留痕；下一次生成开工那一下清——第二十九轮起，旧注释「成功后清」从未实现）
    }));
    // 就地清洗（listenerState 同款）：必须返回缓存对象本身——调用方的就地改动要落在
    // 会话缓存里，persistLf 回读时才读得到；另造新对象＝改动写进孤儿副本、存回去的是旧值
    st.stage = ['none', 'skeleton', 'detailed', 'split'].includes(st.stage) ? st.stage : 'none';
    st.totalFloors = posInt(st.totalFloors) ?? LF_DEFAULT_FLOORS;
    st.minFloors = posInt(st.minFloors) ?? 0;
    st.idea = String(st.idea ?? '');
    st.newChars = st.newChars === true;
    st.materialNote = String(st.materialNote ?? '');
    st.mats = normLfMats(st.mats);
    st.createdAt = Number(st.createdAt) || 0;
    st.volumes = Array.isArray(st.volumes) ? st.volumes.map(normVol) : [];
    st.error = String(st.error ?? '');
    st.regenBackup = st.regenBackup && Array.isArray(st.regenBackup.volumes) ? st.regenBackup : null;   // 「从零开始」的旧书备份（见 stashLfRegenBackup）
    st.mount = st.mount && Number.isInteger(st.mount?.vol) && Number.isInteger(st.mount?.ch)
        ? { vol: st.mount.vol, ch: st.mount.ch, unitId: String(st.mount.unitId ?? ''), at: Number(st.mount.at) || 0 }
        : null;
    return st;
}

// 「从零开始」（原「重新生成骨架」，第三十轮改名）的备份/恢复（第二十四轮）：回参数表单时旧书
// 整份存进 regenBackup（随聊天持久、刷新不丢），新骨架生成成功才作废；生成失败/被中断自动恢复
// 旧书——旧版「重新生成」一按就当场清空，失败后旧书就没了（用户点名问过的容错缺口）
export function stashLfRegenBackup() {
    const st = lfState();
    if (!st.volumes.length) return;
    st.regenBackup = {
        stage: st.stage, totalFloors: st.totalFloors, minFloors: st.minFloors, idea: st.idea,
        newChars: st.newChars, materialNote: st.materialNote, createdAt: st.createdAt,
        volumes: JSON.parse(JSON.stringify(st.volumes)), mount: st.mount,
    };
    persistLf();
}

function restoreLfBackup() {
    const st = lfState();
    const b = st.regenBackup;
    if (!b) return false;
    Object.assign(st, {
        stage: b.stage, totalFloors: b.totalFloors, minFloors: b.minFloors, idea: b.idea,
        newChars: b.newChars, materialNote: b.materialNote, createdAt: b.createdAt,
        volumes: (b.volumes ?? []).map(normVol), mount: b.mount, error: '',
    });
    st.regenBackup = null;
    persistLf();
    flushChatData();
    return true;
}

export function persistLf() {
    saveChatData('longform', lfState());
}

function posInt(v) {
    const n = Math.round(Number(v));
    return Number.isFinite(n) && n > 0 ? n : null;
}

function normVol(v) {
    const o = v && typeof v === 'object' ? v : {};
    const anchors = (Array.isArray(o.anchors) ? o.anchors : [])
        .filter(a => a && typeof a === 'object')
        .map(a => ({ title: String(a.title ?? '').slice(0, 120) || '未命名锚', point: String(a.point ?? '') }));
    const chapters = Array.isArray(o.chapters) ? o.chapters.map(normChapter) : null;
    return {
        title: String(o.title ?? '').slice(0, 120) || `第 ${(posInt(o.no) ?? 0) + 1} 卷`,
        summary: String(o.summary ?? ''),
        seeds: String(o.seeds ?? ''),
        floors: posInt(o.floors) ?? LF_MIN_CHAPTER_FLOORS,
        text: String(o.text ?? ''),
        anchors,
        skAt: Number(o.skAt) || 0,      // 骨架就地编辑时间（概要/种子改过而卷文本没跟上时提示）
        textAt: Number(o.textAt) || 0,      // 卷文本最后定稿时间（修订/手改都刷新）
        detailState: ['none', 'run', 'done', 'error'].includes(o.detailState) ? o.detailState : 'none',
        detailError: String(o.detailError ?? ''),
        chapters,
        splitAt: Number(o.splitAt) || 0,    // 再切小时间；textAt > splitAt ⇒ 章表过期
        splitState: ['none', 'run', 'done', 'error'].includes(o.splitState) ? o.splitState : 'none',
        splitError: String(o.splitError ?? ''),
    };
}

function normChapter(c) {
    const o = c && typeof c === 'object' ? c : {};
    const nodes = (Array.isArray(o.nodes) ? o.nodes : [])
        .filter(n => n && typeof n === 'object')
        .map(n => ({ title: String(n.title ?? '').slice(0, 120) || '未命名节点', criterion: String(n.criterion ?? '') }));
    // 混合历史（mix.js 混合重编的旧版快照，2026-09-02）：整份保留重写前的文本与节点表＋七字段说明
    const mixLog = (Array.isArray(o.mixLog) ? o.mixLog : [])
        .filter(m => m && typeof m === 'object')
        .map(m => ({
            at: Number(m.at) || 0,
            idea: String(m.idea ?? ''),
            windowFloors: Math.max(0, Math.round(Number(m.windowFloors) || 0)),
            floorsRec: Math.max(0, Math.round(Number(m.floorsRec) || 0)),
            materialsNote: String(m.materialsNote ?? ''),
            changesNote: String(m.changesNote ?? ''),
            foreshadowNote: String(m.foreshadowNote ?? ''),
            calibNote: String(m.calibNote ?? ''),
            prevText: String(m.prevText ?? ''),
            prevNodes: (Array.isArray(m.prevNodes) ? m.prevNodes : [])
                .filter(n => n && typeof n === 'object')
                .map(n => ({ title: String(n.title ?? '').slice(0, 120) || '未命名节点', criterion: String(n.criterion ?? '') })),
        }))
        .slice(0, LF_MIX_LOG_KEEP);
    return {
        title: String(o.title ?? '').slice(0, 120) || '未命名章',
        floors: posInt(o.floors) ?? LF_MIN_CHAPTER_FLOORS,
        text: String(o.text ?? ''),
        nodes,
        lit: Math.min(Math.max(0, Math.round(Number(o.lit) || 0)), nodes.length),   // 进度账：已点亮节点数
        // 锚层（第四十五轮）：各节点点亮时的楼层号，与 lit 同长；删楼回退按它倒账。只留已点亮段
        litFloors: (Array.isArray(o.litFloors) ? o.litFloors : [])
            .slice(0, Math.min(Math.max(0, Math.round(Number(o.lit) || 0)), nodes.length))
            .map(v => Number.isInteger(v) && v > 0 ? v : null),
        done: o.done === true || (nodes.length > 0 && (Number(o.lit) || 0) >= nodes.length),
        unitId: String(o.unitId ?? ''),
        mixLog,
    };
}

// 材料面板勾选的形状收敛（第十九轮）：memory 默认开（记忆表格默认全量）、gpIds null＝未动过
// （跟随生效中的玩法条目，与向导第 1 步同默认）、lorePicks/kbListIds 空数组起步
function normLfMats(m) {
    const o = m && typeof m === 'object' ? m : {};
    return {
        memory: o.memory !== false,
        gpIds: Array.isArray(o.gpIds) ? o.gpIds.map(String) : null,
        lorePicks: Array.isArray(o.lorePicks) ? o.lorePicks.map(String) : [],
        kbListIds: Array.isArray(o.kbListIds) ? o.kbListIds.map(String) : [],
    };
}

export function resetLf() {
    const mats = lfState().mats;   // 材料勾选是偏好不是书数据——作废本长线时保留
    saveChatData('longform', {
        version: 1, stage: 'none',
        totalFloors: LF_DEFAULT_FLOORS, minFloors: 0, idea: '', newChars: false,
        materialNote: '', mats, createdAt: 0, volumes: [], mount: null,
    });
    flushChatData();
}

// ---------------------------------------------------------------------------
// 纯逻辑：楼层算术（§6.2「各卷楼数总和由插件校验，不让模型自行提议密度分布」、
// §6.3「预算管线」——模型只出结构，算术插件说了算，差了按比例重配＋最大余数法分尾差）
// ---------------------------------------------------------------------------

export function rescaleFloors(list, total) {
    const vols = list.map(v => ({ ...v, floors: posInt(v.floors) ?? 0 }));
    const sum = vols.reduce((n, v) => n + v.floors, 0);
    if (sum === total) return vols;
    if (!sum) return vols.map((v, i) => ({ ...v, floors: i === 0 ? total : 0 }));   // 全 0 的退化保护
    const raw = vols.map(v => (v.floors / sum) * total);
    const base = raw.map(Math.floor);
    let rest = total - base.reduce((n, x) => n + x, 0);
    const order = raw.map((r, i) => [r - base[i], i]).sort((a, b) => b[0] - a[0]);
    for (let k = 0; k < order.length && rest > 0; k++, rest--) base[order[k][1]] += 1;
    return vols.map((v, i) => ({ ...v, floors: base[i] }));
}

export function validateVolumes(vols, total) {
    if (!Array.isArray(vols) || vols.length < 2) return { ok: false, reason: '卷数至少 2 卷（模型没给出可用的卷结构）' };
    const sum = vols.reduce((n, v) => n + v.floors, 0);
    if (sum !== total) return { ok: false, reason: `各卷楼数之和 ${sum} ≠ 总数 ${total}，重配失败` };
    const thin = vols.filter(v => v.floors < LF_MIN_CHAPTER_FLOORS).length;
    if (thin) {
        const vr = lfVolumeRange(total);
        return { ok: false, reason: `有 ${thin} 卷楼数不足 ${LF_MIN_CHAPTER_FLOORS}（一章的最低楼数）——${total} 层建议切 ${vr.lo}-${vr.hi} 卷（每卷 40-60 层）：把楼层总数提到至少 ${vols.length * LF_MIN_CHAPTER_FLOORS}，或走「从零开始」重新生成（少切几卷）` };
    }
    return { ok: true };
}

// 数量建议（第二十轮，全部从楼数预算本地推导——「算术插件说了算」的延伸）：
// 锚密度与章数上限此前只写下限不写密度，模型把 24 层的卷排了 24 个锚、又照锚切出 4 张薄章
export function lfVolumeRange(total) {
    const t = posInt(total) ?? 0;
    return { lo: Math.max(2, Math.floor(t / 60)), hi: Math.max(2, Math.floor(t / 40)) };
}

// 锚数建议＝建议章数＋1、下限 2（2026-09-01：每章 1-2 个锚——锚只是切章刀口，每章完整覆盖一个即可；
// 旧口径「每 25-35 层一锚、max(4, 预算÷30)」被用户判太密——锚多到跟节点没区别）
export function lfAnchorTarget(floors) {
    return Math.max(LF_MIN_ANCHORS, Math.round((posInt(floors) ?? 0) / 50) + 1);
}

export function lfChapterCap(floors) {
    const f = posInt(floors) ?? 0;
    return { max: Math.max(1, Math.floor(f / LF_MIN_CHAPTER_FLOORS)), typ: Math.max(1, Math.round(f / 50)) };
}

// 卷文本里的【锚 N】行兜底解析：模型 anchors 数组缺行时从文本行里捞（锚是切章刀口，丢了切不准）
export function anchorsFromText(text) {
    const out = [];
    const re = /^\s*【锚\s*\d+】\s*(.+)$/gm;
    let m;
    while ((m = re.exec(String(text ?? '')))) {
        const body = m[1].trim();
        const cut = body.indexOf('——');
        out.push({
            title: (cut > 0 ? body.slice(0, cut) : body).slice(0, 120) || `锚 ${out.length + 1}`,
            point: cut > 0 ? body.slice(cut + 2).trim() : '',
        });
    }
    return out;
}

// 章文本里的【节点 N】行兜底解析（第二十五轮，与锚同款套路）：模型 nodes 数组缺行时从文本行里捞
// （节点是监听的判定表，丢了挂载就没得判）；「——」前＝节点名、后＝完成标准
export function nodesFromText(text) {
    const out = [];
    const re = /^\s*【节点\s*\d+】\s*(.+)$/gm;
    let m;
    while ((m = re.exec(String(text ?? '')))) {
        const body = m[1].trim();
        const cut = body.indexOf('——');
        out.push({
            title: (cut > 0 ? body.slice(0, cut) : body).slice(0, 120) || `节点 ${out.length + 1}`,
            criterion: cut > 0 ? body.slice(cut + 2).trim() : '',
        });
    }
    return out;
}

// ---------------------------------------------------------------------------
// 材料口径（第十九轮用户拍板：长线自备材料面板，不再沿用 1.0 第 1 步的勾选——那边改不了
// 长线想要的世界书/知识库独立选择，记忆表格长线要默认全量、不要标签）：
// 记忆表格一个勾＝全量（memoryTags: null/false）；玩法 gpIds null＝跟随生效中（同向导默认）；
// 世界书自选独立存（与 1.0 的 picks 分家）；知识库勾中的清单整表可用条目随行（§6.9 硬口径）。
// 仍不带：插入单元 / 近期草稿骨架 / 联网搜索（1.0 向导专属；要吸收的内容写「本次长线的想法」框）
// ---------------------------------------------------------------------------

// 玩法条目解析：null＝用户没动过面板 → 跟随生效中的条目（storageItemsInEffect，与向导第 1 步同默认）
function lfGpIds(m) {
    return m.gpIds ?? storageItemsInEffect().map(i => i.id);
}

// 知识库整表随行：勾中的清单全部可用条目（冷却中跳过）；不分抽样/全量、不抓取不轮换、
// 不结冷却（冷却账只属于向导「确认采用」流——长线没有那一步，不碰那张账）
function lfKbPayload(kbListIds) {
    const checked = new Set(kbListIds);
    const ids = [];
    for (const list of knowledgeLists()) {
        if (!checked.has(list.id) || list.outfit) continue;   // 装扮清单不进长线（2026-09-02）：按打标记前的旧勾选兜底过滤
        for (const e of list.entries) {
            if (Number(e.cooldown) > 0) continue;
            ids.push(e.id);
        }
    }
    return payloadFromIds(ids);
}

// 知识库材料小节（长线版）：按清单分组、整表口径（编号＝设置里的清单序号-条目号，与向导同款，
// 用户写修订意见时可以拿编号点名）；插在「检索命中」前（第十三轮排序原则——清单内容稳定
// 在前，开头会变的检索命中/最近对话垫底，前缀缓存照吃）
function lfKbSection(payload) {
    const groups = [];
    for (let i = 0; i < payload.length;) {
        const { list, listPos } = payload[i];
        const items = [];
        while (i < payload.length && payload[i].list === list) items.push(payload[i++]);
        groups.push(
            `### 清单 ${listPos} · ${list.name}（本清单领域的完整候选表——规划凡涉及该领域的内容，必须从下列条目里选用，不得自拟同类）`,
            items.map(({ entry }) => `【编号 ${listPos}-${entry.code}】${entryText(list, entry) || '（空条目）'}`).join('\n'),
        );
    }
    if (!groups.length) return null;
    return [
        '## 知识库材料（用户自建清单的候选素材，反模型偏好用：凡涉及某清单领域的内容必须从该清单条目里选用、不得自拟同类。选用时保持条目的核心特征——地点是酒吧就按酒吧写，不擅自改成餐厅；自然融入规划，不生硬罗列、不逐条复述；条目的排列顺序不代表时间先后，排程看时间信息不看罗列顺序。用户想法里点名了具体内容的以点名为准，不硬换成清单条目）',
        groups.join('\n'),
    ];
}

// 与向导共用同一拼法（materials.materialSections，稳定在前/会变的垫底——前缀缓存口径照吃）；
// 第四十三轮起材料里没有「检索命中」小节（长线纯手选，用户拍板：几百到上千层跨度，自动命中
// 每次拼材料才扫一次、价值低，一次手选够用）。整批并行调用只拼一次、逐卷共享同一份字符串。
// 知识库小节按第十三轮排序原则插在最近对话之前
export function lfMaterialParts() {
    const m = lfState().mats;
    const s = storyState();
    const { parts } = materialSections({
        memoryTags: m.memory ? null : false,   // 全量附带（null）或整节不带（false）——没有中间档
        storageItems: (settings.storageItems ?? []).filter(i => lfGpIds(m).includes(i.id)),
        activePlan: activeStory()?.planText ?? '',
        historySummaries: (s.history ?? []).filter(h => h.id !== s.activeId).map(h => h.summary),
        lorePicks: m.lorePicks,
    });
    const kb = lfKbPayload(m.kbListIds);
    if (!kb.length) return parts;
    const sec = lfKbSection(kb);
    const idx = parts.findIndex(p => String(p ?? '').startsWith('## 最近对话记录'));
    if (idx < 0) return [...parts, ...(sec ?? [])];
    return [...parts.slice(0, idx), ...(sec ?? []), ...parts.slice(idx)];
}

// 材料分区（第二十七轮立、第四十三轮收窄）：「最近对话记录」开头会变（对话是滑动窗口——
// 每轮聊天后窗口头就变），把它从稳定区拆出来，垫到任务段之后发——会变的小节放材料中间，
// 前缀会断在它头上、后面跟的骨架与任务段跟着重付；拆出去后跨步前缀最多断在它自己身上
// （「检索命中」小节已随第四十三轮撤出，不再是分区界）
export function lfStableAndVolatile() {
    const parts = lfMaterialParts();
    const idx = parts.findIndex(p => String(p ?? '').startsWith('## 最近对话记录'));
    if (idx < 0) return { stable: parts, live: [] };
    return { stable: parts.slice(0, idx), live: parts.slice(idx) };
}

// 换算锚（§6.3）：与监听共用设置页「监听」区的区间两端（一处设置、两侧同源，免得两个数值漂移）
export function lfPaceAnchor() {
    const c = settings.listener ?? {};
    const lo = Math.max(50, Math.round(Number(c.progressMin) || 400));
    const hi = Math.max(lo + 50, Math.round(Number(c.progressMax) || 800));
    return `「楼层」＝一条角色回复（用户消息不计楼层）。一层楼的有效剧情推进约 ${lo}-${hi} 字——按区间综合衡量、不做逐字换算；全书与各卷/章的楼数预算都按这个口径理解。`;
}

// 全书骨架块（具体化 / 审阅改 / 再切小的每次调用都整份随行——通则二「每次调用自包含」）
export function bookOutlineBlock(st) {
    const lines = st.volumes.map((v, i) =>
        `第 ${i + 1} 卷「${v.title}」（${v.floors} 层楼）：${v.summary}${v.seeds && v.seeds !== '无' ? `\n种子：${v.seeds}` : ''}`);
    return ['## 全书骨架（已定稿的卷级结构与楼数预算，卷与卷按先后推进）',
        ...lines,
        `全书共 ${st.volumes.length} 卷 · ${st.volumes.reduce((n, v) => n + v.floors, 0)} 层楼`].join('\n');
}

// ---------------------------------------------------------------------------
// 提示词（全新起草，随交付报告送审；结构要点出自 §6.7——旧 v3 全文已失传，不得冒充已审原文）。
// 第二十七轮起分两层：lfCommonSystem 是全管线共用的 system 公共头（换算锚/硬约束组/JSON 元规则
// 常驻于此、字节级不变），七份任务提示词只留各步自己的要求与输出结构、挪进 user 消息排在材料之后
// ——前缀缓存从请求第一个字节开始逐字节匹配，各步 system 不同＝材料块每步整块重付全价；
// system 统一后材料+骨架只在状态变化时付一次，修订/重切/修复重试全部吃同一段缓存
// ---------------------------------------------------------------------------

// 硬约束组（§6.11 同源条款的长线版：时间顺序 / 事实一致性 / user 不可编排 / 点名硬要求 / 通则一）
const GUARD_RULES = [
    '时间顺序：材料各小节与条目的排列顺序不代表时间先后，不得按罗列顺序安排先后；对话记录或用户想法里给出了当前时间的，一律以它为准，长线排程从当前时段往后推；已经发生的事发生在哪天就是哪天，后续剧情只能从既定事实之后往后推。',
    '事实一致性：对话记录、记忆表格、历史摘要里已发生的事，以及角色与 user 的既定设定（年龄、身份、能力、资格——从对话、人设卡、记忆表格里读到的）是硬约束，不得安排设定不允许的事（如未成年角色开车）；「剧情需要」与既定事实或设定冲突时，事实与设定赢。',
    'user 不可编排：user 是用户本人扮演的角色，长线只编排角色（char）与世界。不替 user 做动作、不替 user 说出台词或给出回应（「user 答应后」这类把 user 的回应写成既成事实的写法同属此列）、不预设 user 的心理反应；对话或用户想法里 user 已明确说出的意愿可当前提。涉及 user 的部分只能写条件式接口「若 user X，则 Y」，且每段剧情的核心推进独立成立、不依赖 user 的任何具体回应。',
    '点名要求是硬要求：想法或修改意见里点名的数量、价位或金额、时间日期、由谁发起或由谁挑选、地点、身份资格等——凡点名了的逐条落实，不得打折、不得反着写、不得自作主张换成别的方案；与你自己的习惯偏好冲突时，用户要求赢。',
    '数量要求一律是「至少 N、不设上限」：N 是下限不是目标值，剧情需要更多就给更多；任何示例只示范结构与写法，具体内容自行设计，不得照抄示例。',
];

// 全管线共用的 system 公共头（第二十七轮）：换算锚、硬约束组、JSON 元规则从七份任务提示词里
// 抽出常驻于此。这一份与材料稳定区一起构成跨步共享前缀——它不变，材料块就永远只付一次全价
export function lfCommonSystem() {
    return [
        '你是文字角色扮演作品的长线规划引擎，为「书-卷-章-节点」四层管线工作。本条消息是所有任务的公共规则层；当前任务的身份、具体要求与输出结构在用户消息末尾的任务段里，到那里对号入座。材料各小节按「稳定在前、会变的垫底」排列，先读到的多是设定与记录、末尾才是最近对话。',
        lfPaceAnchor(),
        '硬约束（对任何任务一律生效）：',
        ...GUARD_RULES.map((r, i) => `${i + 1}. ${r}`),
        '输出纪律：只按任务段给出的结构输出一个 JSON 对象，不要输出 JSON 以外的任何文字；字符串值里不要出现英文双引号（引用一律写中文「」）；长文本值（如 text/summary/seeds）内的换行一律写 \\n，短值内不要换行（用空格或分号）。',
    ].join('\n');
}

export function skeletonSystemPrompt({ totalFloors, minFloors = 0, newChars = false } = {}) {
    return [
        '你是文字角色扮演的长线剧情总设计师。用户正在为一部以「楼层」计量的长篇角色扮演作品做全书规划，上面给你的材料里有角色设定、世界书、记忆表格、进行中剧情、历史剧情摘要与最近对话。你的任务：设计全书骨架——只到「卷」级，不写具体场景与台词。',
        '任务要求：',
        `- 全书切成若干卷（至少 2 卷、不设上限）：每卷给卷名、剧情概要（这卷讲什么、从哪推进到哪、主要张力是什么、出场角色有谁）与本卷楼数。`,
        `- 各卷楼数之和必须等于 ${totalFloors}（硬预算，程序会校验；总和不能多也不能少）。${minFloors > 0 ? `全书剧情体量至少要撑得起 ${minFloors} 层楼的推进（保底要求）。` : ''}`,
        (() => { const vr = lfVolumeRange(totalFloors); return `- 楼数按剧情体量分配、不得平均：每卷至少 ${LF_MIN_CHAPTER_FLOORS} 层楼（一章的最低楼数），大小完全由这卷的剧情体量决定——重头戏的卷给足预算、过渡铺垫的卷压缩，禁止把楼层总数近似均分给各卷；每卷概要末尾用一句话交代本卷体量的理由（重在哪／轻在哪）。全书 ${totalFloors} 层建议切 ${vr.lo}-${vr.hi} 卷左右（切多了每卷装不下一章以上的剧情）。`; })(),
        newChars
            ? '- 允许引入新角色：在概要里显式点名新角色是谁、第几卷入场、起什么作用。'
            : '- 不引入新角色：全书只用材料里已有的角色与世界要素（临时路人可以有无名分的过场）。',
        '- 种子显式列出：每卷的伏笔与新要素在 seeds 里逐条写明（埋什么、预计在哪收）；本卷没有写「无」。',
        '- 卷与卷之间要有推进关系（后卷接着前卷的果），但每卷有自己的核心张力，不写成一卷的事抻成三卷。',
        '只输出一个符合如下结构的 JSON 对象，不要输出 JSON 以外的任何文字：',
        '{',
        '  "volumes": [',
        `    { "title": "卷名（简短）", "summary": "本卷剧情概要：讲什么、起止与主要张力、出场角色；末尾一句话交代本卷体量理由（重在哪／轻在哪）", "seeds": "本卷埋设的伏笔与新要素，逐条列出（埋什么、预计哪里收）；没有写「无」", "floors": ${Math.max(LF_MIN_CHAPTER_FLOORS, Math.floor(totalFloors / 4))} }`,
        '  ]',
        '}',
    ].join('\n');
}

export function detailSystemPrompt() {
    return [
        '你是文字角色扮演的长线剧情编剧。用户已定好全书骨架（见上面「全书骨架」小节），你的任务：把指定的一卷写成卷级详细剧情文本——它是将来切章的母本与审阅的全景。写法定调（两头都不许走偏）：禁的是写法精度、不是情节本身——本卷要发生的每件具体情节都要在、一件不少；但每件事写到「发生了什么、导致什么」就收笔，不写台词怎么说、不写动作怎么分解——写法比章文本粗至少一级（怎么演是章层的事），情节一点不减。',
        '任务要求：',
        '- 台词硬禁令：卷文本不得出现任何角色的台词原话——禁止引号对白、禁止「某某说：『……』」式的整句台词。对话一律概括成「谁与谁谈了什么、谈出什么结果、谁的立场动摇了」（概括可以：「审问中被审者反将一军、医修失态」；原话不行：「他说：『你来了』」）。动作同理只写到「做了什么事、造成什么影响」，不逐拍描写动作过程——台词与动作细节属于章层。',
        '- 情节完整、禁一笔带过：每件要紧的事单独写明（谁对谁做了什么、结果如何），禁止把多件事揉成一句总括——「众人各怀心思地散去」「随后冲突进一步升级」这类一笔带过不许当正文。切章的模型只能从你写明的事件里切章排节点，没写明的事件等于不存在；卷概要里的每个走向都要有对应的明写事件。',
        `- 展开程度匹配本卷楼数预算：本卷共 X 层楼 ≈ 有效推进约 X×几百到一千字量级的剧情量——预算大就多排事件线、多给波折与支线，预算小就收敛；「更详细」的方式永远是多排事件，不是给事件加台词与分镜。不写与预算脱节的流水账，也不把大预算写成一页纸。`,
        `- 推进锚＝阶段级里程碑（本卷剧情推进到哪个阶段的标记，也是将来切章的刀口）：一句话只说「推进到哪个阶段」，概括程度向卷概要看齐、比章和节点粗至少一级——禁止写到具体动作、对话、场景安排或可逐条核对的细节精度（那是章与节点的事）。数量一般每章 1-2 个锚（每章至少完整覆盖一个锚即可，不逐层设锚）；本卷的建议锚数在任务里给了，至少 ${LF_MIN_ANCHORS} 个、不设上限。锚与锚之间在文本里标注「（本锚间自由演绎）」——执行时扮演模型可自由发挥。`,
        '- 锚写成独立行，格式：【锚 N】锚标题——阶段落点（一句话、只到阶段层面）。',
        '- 骨架 seeds 里点名的伏笔必须落到文本里的具体剧情点，写明在哪埋、怎么收；「本锚间自由演绎」段不算埋伏笔。',
        '- 卷内时间线自洽：长线可以跨多天多周，但先后顺序不能乱，排程从既定事实之后往后推。',
        '只输出一个符合如下结构的 JSON 对象，不要输出 JSON 以外的任何文字：',
        '{',
        '  "text": "卷级剧情文本（含【锚 N】行与「（本锚间自由演绎）」标注，换行写 \\n）",',
        '  "anchors": [',
        '    { "title": "锚标题", "point": "阶段落点（一句话、只到阶段层面——不写动作/对话等细节）" }',
        '  ]',
        '}',
        '（anchors 数组与 text 里的【锚 N】行一一对应，两边都要给全。）',
    ].join('\n');
}

// 整书卷文本档「按意见修订」的分卷执行规格（第二十八轮）：全部卷的当前文本与整书意见都
// 在上下文里、每次调用只重出点名的那一卷——治「一次调用重出全部卷全文」必撞输出上限的
// 病根（maxTokens 默认 1500×3＝4500，五卷的书整书全文要 8000+ 字：截断→修复梯子补第二发
// 照样装不下→捞回的卷原样/缺正文、一处写不进，钱烧两遍页面不动——用户两轮实测同一症状）
export function bookReviseVolSystemPrompt() {
    return [
        '你是长线剧情大纲的修订编辑。用户在做一次整书意见修订，分卷执行：全部卷的当前文本与整书修改意见都给你，你只负责重出点名给你的那一卷的卷级文本。',
        '任务要求：',
        '- 只改意见涉及本卷的地方与违反硬约束的地方，其余原样保留——修订不是重写：意见没落到本卷的走向、事件与锚原则上不动（本卷在意见范围之外就原样带出）。',
        '- 输出必须是这一卷的修订后全文，不能只给被改的段落，也不要把别的卷一起输出。',
        '- 锚随文本同步：剧情改了锚跟着改；锚仍是阶段级里程碑（【锚 N】标题——阶段落点，一句话、只到阶段层面），数量维持每章 1-2 个的密度、至少下限。',
        '- 修订后的卷文本同样不得出现台词原话与整句对白——对话概括成「谁与谁谈了什么、谈出什么结果」（台词与动作细节属于将来的章层；意见点名的台词写成事件概括，别写原话）。重出全文时未被意见点名的事件一件不少照写，不许顺手浓缩成一笔带过的总括。',
        '- 本卷楼数预算维持原样（修订不改预算；要改预算回骨架步重新生成）。',
        '只输出一个符合如下结构的 JSON 对象，不要输出 JSON 以外的任何文字：',
        '{',
        '  "title": "卷名", "text": "修订后的卷级剧情文本（含【锚 N】行与「（本锚间自由演绎）」标注）", "anchors": [ { "title": "锚标题", "point": "阶段落点（一句话、只到阶段层面）" } ]',
        '}',
    ].join('\n');
}

export function splitSystemPrompt() {
    return [
        '你是长线剧情的切章编辑。用户会给你全书骨架与某一卷的卷级文本，你的任务：把这一卷切成章、再把每章切出执行节点——一步到位。',
        '任务要求：',
        `- 章数由预算决定：每章至少 ${LF_MIN_CHAPTER_FLOORS} 层楼、不设上限；本卷预算 X 层楼最多切 ⌊X÷${LF_MIN_CHAPTER_FLOORS}⌋ 章（任务里给了本卷的章数上限）——预算只够一章时整卷切成一章，不要硬拆成几张薄章。推进锚是切章的刀口（阶段级里程碑）——章界尽量落在锚上（每章至少完整覆盖一个锚，锚不被腰斩）；本卷预算 X 层楼已定，各章楼数之和必须等于本卷预算。`,
        '- 章文本（text）：这一章怎么演的执行指导——按本章楼数预算给足剧情量。这章文本将来整章挂进监听逐轮判定进度，扮演模型看不到它、监听按它对账。',
        '- 章文本必须重写、禁止照抄或缩抄卷文本：卷文本站在「事件与关系」层（卷层禁止台词原话与逐拍动作），章文本比它细一级——场景怎么开、节拍顺序、关键行动怎么做、关键台词的要点，都在这里写出来（台词与动作细节在章层允许）。每一段都要落到可指认的具体事件上（谁做了什么、结果怎么收）——这些具体事件就是节点判据的素材，段里没有具体事、判据就只能写空话。卷层一句话的事，在章层展开成这场戏怎么发生的过程（怎么开场、怎么你来我往、怎么收尾）——展开是重写，不是复述。',
        `- 节点：每章至少 ${LF_MIN_NODES} 个、不设上限；节点＝最小剧情单元，站在全书信息粒度的最细一级——卷层的浓缩到这一层必须重新落回具体。每个节点带「完成标准」，判据从该节点对应段落的正文里提炼（正文写了哪件具体事、判据就核那件事；说话类剧情写「说出了/谈成了什么」，不引原话），必须能对着楼层内容逐条核对——卷文本写「审问中被审者反将一军」是合法的卷层精度，节点判据就要落到「被审者出言动摇对方、对方当场失态」这一精度（「她把礼物送到对方手里」可核对；「气氛变好」不可核对）；达成口径＝角色动作偏向该目标即算达成（写给逐轮判定用，不是给人读的散文）。`,
        '- 判据禁写空话：「气氛变好」「关系推进」「张力加深」「初步显露」「进一步发展」这类没有可指认事件的措辞不得单独当完成标准；相邻节点的判据不得同义反复（同一件事换词再写一遍＝不合格）；每条判据都要能回答「演到什么样算这个节点完成」。',
        '- 节点挂钩（章文本与节点一一对应、看得见）：章文本按节点分段——每个节点对应章文本里的一段剧情，该段段首放独立行【节点 N】节点名——完成标准；节点行之间的正文就是这一节点的演绎区间，执行时按顺序点亮、点亮即进入下一段。nodes 数组与章文本里的【节点 N】行一一对应，两边都要给全。',
        '- 伏笔硬规则：卷文本里埋设或收束的伏笔，挂到具体节点的完成标准里（该节点必须让埋设或收束实际发生）；执行时没埋成会报错交用户处置。',
        '- 楼层预算不传导：某章实写超了楼数不向后传导（执行期原则）；但各章楼数分配现在定死，之和等于本卷预算。',
        'user 不可编排（长线版）：不替 user 做动作、不说台词、不预设心理（对话或骨架里 user 已明的意愿可当前提）；涉及 user 只能写「若 user X，则 Y」的条件式接口，且每章的核心推进不依赖 user 的任何具体回应。',
        '事实一致性：卷文本与材料里的既定事实、既定设定是硬约束，切章与节点安排不得违反。',
        '数量要求一律是「至少 N、不设上限」；示例只示范写法，内容自行设计。',
        '只输出一个符合如下结构的 JSON 对象，不要输出 JSON 以外的任何文字：',
        '{',
        '  "chapters": [',
        `    { "title": "章名", "floors": ${LF_MIN_CHAPTER_FLOORS}, "text": "本章执行指导文本（按【节点 N】行分段，每段＝一个节点的演绎区间；含场景、事件链、角色行动安排）", "nodes": [ { "title": "节点名", "criterion": "完成标准（可对照楼层内容核对；角色动作偏向该目标即算达成）" } ] }`,
        '  ]',
        '}',
    ].join('\n');
}

// 三档「按意见修订」的提示词（2026-09-01 第二十四轮，用户拍板「每一步都能用大模型改或手动改」）：
// ①骨架整书修订 ②单卷骨架修订 ③单卷卷文本修订（单卷档顺带治整书修订「一次出全部卷全文」易撞输出上限的病根）
export function skeletonReviseSystemPrompt({ totalFloors } = {}) {
    return [
        '你是长线剧情大纲的修订编辑。用户会给你全书当前骨架（各卷的卷名/楼数/概要/种子）与一条修改意见，你按意见修订骨架——只到「卷」级，不写具体场景与台词。',
        '任务要求：',
        '- 只改意见涉及的地方与违反硬约束的地方，其余原样保留——修订不是重写：没被意见点名的卷的走向与结构原则上不动；要增删整卷走「从零开始」，修订不增删卷。',
        `- 楼数可以改（意见点名了分配问题的照意见重分）：各卷楼数之和仍必须等于 ${totalFloors}（当前总数，程序会校验）；重分时按剧情体量分配、不得平均——重头戏的卷给足、过渡卷压缩。`,
        '- 输出必须是全部卷的修订后骨架：哪怕某卷一字未动也要原样输出，不能只给被改的卷。',
        '- 概要末尾保留/补上一句本卷体量理由（重在哪／轻在哪）；种子只在剧情被意见改动时跟着动。',
        '只输出一个符合如下结构的 JSON 对象，不要输出 JSON 以外的任何文字：',
        '{',
        '  "volumes": [',
        '    { "title": "卷名", "summary": "本卷剧情概要（含末尾一句体量理由）", "seeds": "本卷伏笔与新要素；没有写「无」", "floors": 40 }',
        '  ]',
        '}',
    ].join('\n');
}

export function volSkeletonReviseSystemPrompt() {
    return [
        '你是长线剧情大纲的修订编辑。用户会给你全书骨架（作上下文）与其中一卷的当前骨架（卷名/楼数/概要/种子），你的任务：只修订这一卷的骨架——只到「卷」级，不写具体场景与台词。',
        '任务要求：',
        '- 只改意见涉及的地方与违反硬约束的地方，其余原样保留——修订不是重写；只输出这一卷（别的卷不归你管）。',
        '- 楼数可以改：本卷楼数按剧情体量定（重头戏给足、过渡压缩），改了之后全书楼层总数会跟着各卷之和走（程序自动重算）；每卷至少 20 层楼。',
        '- 概要末尾保留/补上一句本卷体量理由（重在哪／轻在哪）。',
        '只输出一个符合如下结构的 JSON 对象，不要输出 JSON 以外的任何文字：',
        '{',
        '  "title": "卷名", "summary": "本卷剧情概要（含末尾一句体量理由）", "seeds": "本卷伏笔与新要素；没有写「无」", "floors": 40',
        '}',
    ].join('\n');
}

export function volTextReviseSystemPrompt() {
    return [
        '你是长线剧情大纲的修订编辑。用户会给你全书骨架（作上下文）与其中一卷的卷级文本，你的任务：只修订这一卷的卷文本。',
        '任务要求：',
        '- 只改意见涉及的地方与违反硬约束的地方，其余原样保留——修订不是重写：没被意见点名的走向、事件与锚原则上不动。',
        '- 输出必须是这一卷的修订后全文，不能只给被改的段落。',
        '- 锚随文本同步：剧情改了锚跟着改；锚仍是阶段级里程碑（【锚 N】标题——阶段落点，一句话、只到阶段层面），数量维持每章 1-2 个的密度、至少下限。',
        '- 修订后的卷文本同样不得出现台词原话与整句对白——对话概括成「谁与谁谈了什么、谈出什么结果」（台词与动作细节属于将来的章层；意见点名的台词写成事件概括，别写原话）。重出全文时未被意见点名的事件一件不少照写，不许顺手浓缩成一笔带过的总括。',
        '- 本卷楼数预算维持原样（要改预算去改骨架）。',
        '只输出一个符合如下结构的 JSON 对象，不要输出 JSON 以外的任何文字：',
        '{',
        '  "title": "卷名", "text": "修订后的卷级剧情文本（含【锚 N】行与「（本锚间自由演绎）」标注）", "anchors": [ { "title": "锚标题", "point": "阶段落点（一句话、只到阶段层面）" } ]',
        '}',
    ].join('\n');
}

// ---------------------------------------------------------------------------
// 调用编排（每步走 chatCompletion＋parseModelJson 修复梯子；输出上限乘数：这些产物
// 比一次 1.0 规划长得多——骨架 ×2、卷文本/修订/切章 ×3；设置 0 = 不限时保持 0）。
// onDelta/onReasoning 透传给 chatCompletion（第二十/二十四轮）：给了就走 SSE 流式，
// 页面实时显示已收字数与思考计数
// ---------------------------------------------------------------------------

function lfMaxTokens(mult) {
    const t = Math.round(Number(settings.api.maxTokens) || 0);
    return t ? Math.round(t * mult) : 0;
}

async function lfCall({ system, user, provider, signal, mult = 2, onUsage, onDelta, onReasoning }) {
    const req = {
        messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
        ],
        place: 'longform',   // 分处模型·长线生成档（第四十九轮）；长线页「生成模型」单次选的 provider 优先
        maxTokens: lfMaxTokens(mult),
        ...(provider ? { provider } : {}),
        ...(signal ? { signal } : {}),
        ...(onUsage ? { onUsage } : {}),
        ...(onDelta ? { onDelta } : {}),
        ...(onReasoning ? { onReasoning } : {}),
    };
    const { result } = await parseModelJson(await chatCompletion(req), req);
    return result;
}

// 先焐热再并行的 allSettled（第二十七轮）：入参是启动器数组（调用即发请求）。第一个 await 跑完
// （成功失败都算）才发射其余——前缀缓存在第一个请求处理完之前并不存在，同前缀的并发请求
// 互相看不到对方还没写完的缓存、全部按未命中计价；焐热之后其余并行读的是同一份已存在的缓存
async function warmFirstAllSettled(fns) {
    const settled = p => p.then(v => ({ status: 'fulfilled', value: v }), e => ({ status: 'rejected', reason: e }));
    const rs = [await settled(fns[0]())];
    if (fns.length > 1) rs.push(...await Promise.all(fns.slice(1).map(f => settled(f()))));
    return rs;
}

// ①＋② 骨架与切块（一次调用出卷＋楼数；总和校验与重配在本地）
export async function runLfSkeleton({ totalFloors, minFloors = 0, idea = '', newChars = false, provider, signal, onUsage, onDelta } = {}) {
    const total = posInt(totalFloors) ?? LF_DEFAULT_FLOORS;
    const { stable, live } = lfStableAndVolatile();
    const system = lfCommonSystem();
    const user = [
        stable.join('\n\n'),
        skeletonSystemPrompt({ totalFloors: total, minFloors, newChars }),
        ...live,
        '## 本次长线的想法与硬参数（本长线的最高优先级输入）',
        `全书楼层总数：${total}（各卷楼数之和必须等于它）`,
        `保底楼数：${minFloors > 0 ? `${minFloors}（全书剧情体量的下限）` : '未设'}`,
        `是否允许引入新角色：${newChars ? '允许' : '不允许'}`,
        `用户想法：\n${String(idea ?? '').trim() || '（未填——按材料自由设计）'}`,
    ].join('\n\n');

    let result;
    try {
        result = await lfCall({ system, user, provider, signal, mult: 2, onUsage, onDelta: onDelta && (t => onDelta(t.length)) });
    } catch (err) {
        restoreLfBackup();   // 重新生成流：调用失败/中断——旧书原样回来（首次生成无备份，等于无操作）
        throw err;
    }
    const raw = Array.isArray(result?.volumes) ? result.volumes : [];
    const vols = rescaleFloors(raw.map((v, i) => ({
        title: String(v?.title ?? '').slice(0, 120),
        summary: String(v?.summary ?? ''),
        seeds: String(v?.seeds ?? ''),
        floors: posInt(v?.floors) ?? 0,
        no: i,
    })), total);
    const check = validateVolumes(vols, total);
    if (!check.ok) {
        restoreLfBackup();
        throw new Error(check.reason);
    }

    const st = lfState();
    Object.assign(st, {
        stage: 'skeleton',
        totalFloors: total,
        minFloors: posInt(minFloors) ?? 0,
        idea: String(idea ?? ''),
        newChars: newChars === true,
        materialNote: lfMatOverview(),
        createdAt: Date.now(),
        volumes: vols.map(v => normVol(v)),
        mount: null,
        error: '',
        regenBackup: null,   // 新骨架立住——旧书备份作废
    });
    persistLf();
    flushChatData();
    return st;
}

// 材料概览一行（骨架时点留底用；页面的材料面板也拿它当实时概览——第十九轮起按长线自己的勾选）
export function lfMatOverview() {
    const m = lfState().mats;
    const s = storyState();
    const gp = (settings.storageItems ?? []).filter(i => lfGpIds(m).includes(i.id)).length;
    const kb = lfKbPayload(m.kbListIds);
    const kbLists = new Set(kb.map(p => p.list.id)).size;
    const hist = (s.history ?? []).filter(h => h.id !== s.activeId).length;
    return [
        m.memory ? '记忆表格全量' : '记忆表格不带',
        `玩法 ${gp} 条`,
        kbLists ? `知识库 ${kbLists} 清单 ${kb.length} 条` : '知识库未勾',
        m.lorePicks.length ? `世界书自选 ${m.lorePicks.length} 条` : '世界书自选未勾',
        activeStory() ? '进行中剧情随行' : '无进行中剧情',
        hist ? `历史摘要 ${hist} 份` : '无历史摘要',
    ].join(' · ');
}

// ③ 分块具体化：逐卷一次一卷（§6.4「能分多细分多细，批次不设限」）；材料与骨架块整批只拼一次、
// 逐卷共享同一份字符串。发射次序＝先焐热再并行（第二十七轮）：前缀缓存要等第一个请求跑完才落盘，
// 一口气全发＝同前缀的并发请求互相看不到对方还没写完的缓存、全部按未命中计价——先让第一卷把
// [system+材料稳定区+骨架+任务头] 的缓存焐热，其余卷再并行（读的是已存在的缓存，不再互抢）；
// 批次总时长因此多约一卷的生成时间，输入费省大半。onProgress 逐卷落定回调＋开工即报一次 0/N；
// onDelta 按卷报累计字数
export async function runLfDetailBatch({ provider, signal, onUsage, onDelta, onProgress } = {}) {
    const st = lfState();
    const targets = st.volumes.map((v, i) => ({ v, i })).filter(x => x.v.detailState !== 'done');
    if (!targets.length) return { done: 0, failed: [] };
    const { stable, live } = lfStableAndVolatile();
    const materials = stable.join('\n\n');
    const outline = bookOutlineBlock(st);
    for (const { v } of targets) { v.detailState = 'run'; v.detailError = ''; }
    persistLf();
    let settled = 0;
    onProgress?.({ settled: 0, total: targets.length });
    const tick = () => onProgress?.({ settled: ++settled, total: targets.length });
    const rs = await warmFirstAllSettled(targets.map(({ i }) => () => runLfDetailOne(i, { provider, signal, materials, outline, live, onUsage, onDelta })
        .then(r => { tick(); return r; }, e => { tick(); throw e; })));
    const failed = [];
    rs.forEach((r, k) => { if (r.status === 'rejected') failed.push({ vol: targets[k].i, reason: String(r.reason?.message ?? r.reason) }); });
    const st2 = lfState();
    for (const v of st2.volumes) if (v.detailState === 'run') v.detailState = 'none';   // 中断兜底：不留永远的「具体化中」
    if (st2.volumes.every(v => v.detailState === 'done') && st2.stage === 'skeleton') {
        st2.stage = 'detailed';
    }
    persistLf();
    return { done: targets.length - failed.length, failed };
}

async function runLfDetailOne(vi, { provider, signal, materials, outline, live = [], onUsage, onDelta }) {
    const st = lfState();
    const vol = st.volumes[vi];
    try {
        const user = [
            materials,
            outline,
            detailSystemPrompt(),
            ...live,
            '## 本卷任务',
            `把第 ${vi + 1} 卷「${vol.title}」写成卷级详细剧情文本。本卷预算 ${vol.floors} 层楼；推进锚建议约 ${lfAnchorTarget(vol.floors)} 个（至少 ${LF_MIN_ANCHORS} 个、一般每章 1-2 个——锚是阶段级里程碑，只说推进到哪个阶段）；骨架概要与种子如上，务必落实。`,
        ].join('\n\n');
        const result = await lfCall({ system: lfCommonSystem(), user, provider, signal, mult: 3, onUsage, onDelta: onDelta && (t => onDelta(vi, t.length)) });
        let anchors = Array.isArray(result?.anchors) ? result.anchors.map(a => ({
            title: String(a?.title ?? '').slice(0, 120),
            point: String(a?.point ?? ''),
        })) : [];
        if (anchors.length < LF_MIN_ANCHORS) {
            const fromText = anchorsFromText(result?.text);
            if (fromText.length > anchors.length) anchors = fromText;
        }
        const text = String(result?.text ?? '').trim();
        if (!text) throw new Error('卷文本为空');
        if (anchors.length < LF_MIN_ANCHORS) throw new Error(`推进锚少于 ${LF_MIN_ANCHORS} 个（解析到 ${anchors.length} 个）——锚是切章刀口，缺了切不准，请重试`);
        const v = lfState().volumes[vi];
        v.text = text;
        v.anchors = anchors.map(a => ({ title: a.title || '未命名锚', point: a.point }));
        v.textAt = Date.now();
        v.detailState = 'done';
        v.detailError = '';
        persistLf();
        return true;
    } catch (err) {
        if (err?.name === 'AbortError') throw err;
        const v = lfState().volumes[vi];
        v.detailState = 'error';
        v.detailError = String(err?.message ?? err);
        persistLf();
        throw err;
    }
}

// ⑤ 审阅改：按意见整书修订（意见必填——长线不设「换一版」档，要重来走「从零开始」）
// ⑤ 整书「按意见修订」卷文本（第二十八轮改逐卷执行）：老做法一次调用要求模型把全部卷
// 全文重出，五卷的书要 8000+ 字、必撞输出上限（maxTokens 默认 1500×倍率3＝4500 token）——
// 截断后修复梯子补第二发照样装不下，捞回的卷原样/缺正文、一处写不进：token 烧两遍、页面
// 不动。现在逐卷执行：每次调用看得到全部卷当前文本＋整书意见（跨卷意见——把乙卷的事挪到
// 甲卷——两头都落得了），只重出本卷；先焐热再并行吃前缀缓存；逐卷落袋互不连坐
export async function runLfRevise({ opinion = '', provider, signal, onUsage, onDelta, onProgress } = {}) {
    const note = String(opinion ?? '').trim();
    if (!note) throw new Error('修改意见是空的——写一句要改什么（长线的「换一版」＝走「从零开始」）');
    const st = lfState();
    if (!st.volumes.length || !st.volumes.every(v => v.detailState === 'done' && v.text)) {
        throw new Error('还有卷没具体化完——先跑完「具体化各卷」再修订');
    }
    const { stable, live } = lfStableAndVolatile();
    const volsBlock = st.volumes.map((v, i) => [
        `### 第 ${i + 1} 卷「${v.title}」（预算 ${v.floors} 层楼）`,
        v.text,
        `锚：${v.anchors.map(a => a.title).join('、')}`,
    ].join('\n')).join('\n\n');
    // 共享段在逐卷调用间逐字节一致（垫前缀缓存），分歧只在尾巴的「本卷任务」
    const shared = [
        stable.join('\n\n'),
        bookOutlineBlock(st),
        bookReviseVolSystemPrompt(),
        ...live,
        '## 全部卷的当前文本',
        volsBlock,
        '## 修改意见',
        note,
    ].join('\n\n');
    const tally = { updated: 0, unchanged: 0, keptNoText: 0 };
    const writeOne = (vi, result) => {
        const v = lfState().volumes[vi];
        const r = result ?? {};
        const text = String(r?.text ?? '').trim();
        const title = String(r?.title ?? v.title).slice(0, 120) || v.title;
        if (!text) { tally.keptNoText++; return; }   // 该卷空文本＝模型没给，保留原文（宁缺勿毁）
        if (text === v.text && title === v.title) { tally.unchanged++; return; }   // 原样带回：不写也不刷 textAt（章表不白标过期）
        if (title !== v.title) v.title = title;
        if (text !== v.text) {
            v.text = text;
            let anchors = Array.isArray(r?.anchors) ? r.anchors.map(a => ({ title: String(a?.title ?? ''), point: String(a?.point ?? '') })) : [];
            if (anchors.length < LF_MIN_ANCHORS) {
                const fromText = anchorsFromText(text);
                if (fromText.length > anchors.length) anchors = fromText;
            }
            if (anchors.length >= LF_MIN_ANCHORS) v.anchors = anchors.map(a => ({ title: a.title || '未命名锚', point: a.point }));
            v.textAt = Date.now();   // 修订后章表（若有）标过期
        }
        persistLf();
        tally.updated++;
    };
    let settled = 0;
    onProgress?.({ settled: 0, total: st.volumes.length });
    const tick = () => onProgress?.({ settled: ++settled, total: st.volumes.length });
    const rs = await warmFirstAllSettled(st.volumes.map((v, i) => () => (async () => {
        const user = [shared,
            '## 本卷任务',
            `只重出第 ${i + 1} 卷「${v.title}」的修订后全文——其余卷的当前文本只是上下文，不要输出它们。`,
        ].join('\n\n');
        writeOne(i, await lfCall({ system: lfCommonSystem(), user, provider, signal, mult: 3, onUsage, onDelta: onDelta && (t => onDelta(i, t.length)) }));
    })().then(r => { tick(); return r; }, e => { tick(); throw e; })));
    const failed = [];
    rs.forEach((r, k) => { if (r.status === 'rejected') failed.push({ vol: k, reason: String(r.reason?.message ?? r.reason) }); });
    flushChatData();
    // 一卷正文都没拿到＝修订白跑。第二十三轮加的硬校验照搬：全空不许静默装成功
    if (!tally.updated && !tally.unchanged && !failed.length && tally.keptNoText === st.volumes.length)
        throw new Error('修订输出里一卷正文都没有——模型没按格式给全文，已保留原文不动。重试一次，或把意见拆小分次修订');
    return { ...tally, failed };
}

// ⑤' 骨架整书修订（第二十四轮）：只改骨架四字段与楼数分配，不动卷文本——骨架阶段的「按意见修订」
export async function runLfSkeletonRevise({ opinion = '', provider, signal, onUsage, onDelta } = {}) {
    const note = String(opinion ?? '').trim();
    if (!note) throw new Error('修改意见是空的——写一句要改什么');
    const st = lfState();
    if (!st.volumes.length) throw new Error('还没有骨架——先生成骨架');
    const total = st.totalFloors;
    const { stable, live } = lfStableAndVolatile();
    const user = [stable.join('\n\n'), bookOutlineBlock(st), skeletonReviseSystemPrompt({ totalFloors: total }), ...live, '## 修改意见', note].join('\n\n');
    const result = await lfCall({ system: lfCommonSystem(), user, provider, signal, mult: 2, onUsage, onDelta: onDelta && (t => onDelta(t.length)) });
    const list = Array.isArray(result?.volumes) ? result.volumes : [];
    if (!list.length) throw new Error('修订输出里没有卷');
    if (list.length !== st.volumes.length) throw new Error(`修订输出卷数 ${list.length} 与现有 ${st.volumes.length} 不一致——要增删整卷走「从零开始」`);
    const vols = rescaleFloors(list.map((v, i) => ({
        title: String(v?.title ?? '').slice(0, 120),
        summary: String(v?.summary ?? ''),
        seeds: String(v?.seeds ?? ''),
        floors: posInt(v?.floors) ?? st.volumes[i].floors,   // 模型漏给的卷沿用原楼数
        no: i,
    })), total);
    const check = validateVolumes(vols, total);
    if (!check.ok) throw new Error(check.reason);
    const st2 = lfState();
    let updated = 0, unchanged = 0;
    st2.volumes.forEach((v, i) => {
        const r = vols[i];
        const floorsChanged = r.floors !== v.floors;
        const structChanged = r.title !== v.title || r.summary !== v.summary || r.seeds !== v.seeds;
        if (!floorsChanged && !structChanged) { unchanged++; return; }
        v.title = r.title; v.summary = r.summary; v.seeds = r.seeds;
        if (floorsChanged) {
            v.floors = r.floors;
            if (v.chapters?.length) v.splitState = 'none';   // 章预算对不上了——回「未切章」待重切
        }
        v.skAt = Date.now();
        updated++;
    });
    persistLf();
    flushChatData();
    return { updated, unchanged };
}

// ⑤'' 单卷骨架修订：模型拿全书骨架当上下文、只改这一卷；楼数改动后总数跟着各卷之和走
export async function runLfVolSkeletonRevise(vi, { opinion = '', provider, signal, onUsage, onDelta } = {}) {
    const note = String(opinion ?? '').trim();
    if (!note) throw new Error('修改意见是空的——写一句要改什么');
    const st = lfState();
    const vol = st.volumes[vi];
    if (!vol) throw new Error('没有这一卷');
    const { stable, live } = lfStableAndVolatile();
    const user = [
        stable.join('\n\n'),
        bookOutlineBlock(st),
        volSkeletonReviseSystemPrompt(),
        ...live,
        '## 本卷任务',
        `只修订第 ${vi + 1} 卷「${vol.title}」的骨架（只改意见涉及处）。它当前的字段——卷名：${vol.title}｜楼数：${vol.floors}｜概要：${vol.summary}｜种子：${vol.seeds || '无'}`,
        '## 修改意见',
        note,
    ].join('\n\n');
    const result = await lfCall({ system: lfCommonSystem(), user, provider, signal, mult: 2, onUsage, onDelta: onDelta && (t => onDelta(t.length)) });
    const title = String(result?.title ?? '').trim().slice(0, 120);
    const floors = posInt(result?.floors);
    if (!title) throw new Error('修订输出里没有卷名');
    if (floors != null && floors < LF_MIN_CHAPTER_FLOORS) throw new Error(`修订输出的楼数 ${floors} 低于每章下限 ${LF_MIN_CHAPTER_FLOORS} 层——重试，或在骨架页签手动改楼数`);
    const v = lfState().volumes[vi];
    const floorsChanged = floors != null && floors !== v.floors;
    const structChanged = title !== v.title || String(result?.summary ?? '') !== v.summary || String(result?.seeds ?? '') !== v.seeds;
    if (structChanged) {
        v.title = title;
        v.summary = String(result?.summary ?? '');
        v.seeds = String(result?.seeds ?? '');
    }
    if (floorsChanged) {
        v.floors = floors;
        if (v.chapters?.length) v.splitState = 'none';
    }
    if (structChanged || floorsChanged) v.skAt = Date.now();
    const s = lfState();
    s.totalFloors = s.volumes.reduce((n, x) => n + x.floors, 0);
    persistLf();
    flushChatData();
    return { structChanged, floorsChanged };
}

// ⑤''' 单卷卷文本修订：一次只出一卷全文——长书整书修订易撞输出上限时，用它把意见拆到卷
export async function runLfVolTextRevise(vi, { opinion = '', provider, signal, onUsage, onDelta } = {}) {
    const note = String(opinion ?? '').trim();
    if (!note) throw new Error('修改意见是空的——写一句要改什么');
    const st = lfState();
    const vol = st.volumes[vi];
    if (!vol) throw new Error('没有这一卷');
    if (vol.detailState !== 'done' || !vol.text) throw new Error('这一卷还没有卷文本——先跑「具体化各卷」');
    const { stable, live } = lfStableAndVolatile();
    const user = [
        stable.join('\n\n'),
        bookOutlineBlock(st),
        volTextReviseSystemPrompt(),
        ...live,
        `### 第 ${vi + 1} 卷「${vol.title}」（预算 ${vol.floors} 层楼）`,
        vol.text,
        `锚：${vol.anchors.map(a => a.title).join('、')}`,
        '## 修改意见',
        note,
    ].join('\n\n');
    const result = await lfCall({ system: lfCommonSystem(), user, provider, signal, mult: 3, onUsage, onDelta: onDelta && (t => onDelta(t.length)) });
    const text = String(result?.text ?? '').trim();
    if (!text) throw new Error('修订输出里没有正文（可能被输出上限截断）——原文保留未动，重试或把意见拆小');
    const v = lfState().volumes[vi];
    const title = String(result?.title ?? v.title).slice(0, 120) || v.title;
    if (title !== v.title) v.title = title;
    v.text = text;
    let anchors = Array.isArray(result?.anchors) ? result.anchors.map(a => ({ title: String(a?.title ?? ''), point: String(a?.point ?? '') })) : [];
    if (anchors.length < LF_MIN_ANCHORS) {
        const fromText = anchorsFromText(text);
        if (fromText.length > anchors.length) anchors = fromText;
    }
    if (anchors.length >= LF_MIN_ANCHORS) v.anchors = anchors.map(a => ({ title: a.title || '未命名锚', point: a.point }));
    v.textAt = Date.now();   // 若已切章，章表标过期
    persistLf();
    flushChatData();
    return { ok: true };
}

// ⑥ 再切小（操作条按钮第三十轮起叫「生成章节/继续切章（未完成的卷）」）：逐卷一次一卷
// （卷→章→节点一步到位）；章预算重配同卷预算：算术插件说了算。
// 发射次序同具体化批次＝先焐热再并行（第二十七轮，见 warmFirstAllSettled 注释）；
// onProgress/onDelta 口径同具体化批次
export async function runLfSplitBatch({ provider, signal, onUsage, onDelta, onProgress } = {}) {
    const st = lfState();
    const targets = st.volumes.map((v, i) => ({ v, i }))
        .filter(x => x.v.detailState === 'done' && x.v.splitState !== 'done');
    if (!targets.length) return { done: 0, failed: [] };
    const { stable, live } = lfStableAndVolatile();
    const materials = stable.join('\n\n');
    const outline = bookOutlineBlock(st);
    for (const { v } of targets) { v.splitState = 'run'; v.splitError = ''; }
    persistLf();
    let settled = 0;
    onProgress?.({ settled: 0, total: targets.length });
    const tick = () => onProgress?.({ settled: ++settled, total: targets.length });
    const rs = await warmFirstAllSettled(targets.map(({ i }) => () => runLfSplitOne(i, { provider, signal, materials, outline, live, onUsage, onDelta })
        .then(r => { tick(); return r; }, e => { tick(); throw e; })));
    const failed = [];
    rs.forEach((r, k) => { if (r.status === 'rejected') failed.push({ vol: targets[k].i, reason: String(r.reason?.message ?? r.reason) }); });
    const st2 = lfState();
    for (const v of st2.volumes) if (v.splitState === 'run') v.splitState = 'none';   // 中断兜底
    if (st2.volumes.every(v => v.splitState === 'done') && ['skeleton', 'detailed'].includes(st2.stage)) {
        st2.stage = 'split';
    }
    persistLf();
    return { done: targets.length - failed.length, failed };
}

// 章产物校验＋落盘（第三十轮从 runLfSplitOne 抽出，批量切章 / 单卷重切 / 整书章层修订三处共用）：
// 章预算算术插件说了算（先保每章不低于一章下限、再重配到卷预算——模型给的总和不作数）；
// 节点数组缺行时从章文本的【节点 N】行兜底（第二十五轮：节点是监听判定表，丢了没得判）；
// 同位置章沿用旧进度（修订后重切时已演完的章不回炉）
function settleSplitResult(vi, result) {
    const vol = lfState().volumes[vi];
    const cap = lfChapterCap(vol.floors);
    let chapters = Array.isArray(result?.chapters) ? result.chapters : [];
    if (!chapters.length) throw new Error('章列表为空');
    chapters = chapters.map(c => {
        let nodes = (Array.isArray(c?.nodes) ? c.nodes : []).map(n => ({
            title: String(n?.title ?? '').slice(0, 120),
            criterion: String(n?.criterion ?? ''),
        })).filter(n => n.title);
        const text = String(c?.text ?? '').trim();
        if (nodes.length < LF_MIN_NODES) {
            const fromText = nodesFromText(text);
            if (fromText.length > nodes.length) nodes = fromText;
        }
        return {
            title: String(c?.title ?? '').slice(0, 120),
            floors: posInt(c?.floors) ?? 0,
            text,
            nodes,
        };
    }).filter(c => c.text || c.nodes.length);
    if (chapters.length < 1) throw new Error('没有可用的章（全部缺文本与节点）');
    // 章数先对预算：N 章至少要 N×下限层——超了＝预算装不下，报数＋指路（第二十轮大白话化）
    if (chapters.length > cap.max) throw new Error(`本卷预算 ${vol.floors} 层，模型切了 ${chapters.length} 章——每章至少 ${LF_MIN_CHAPTER_FLOORS} 层、${chapters.length} 章至少需要 ${chapters.length * LF_MIN_CHAPTER_FLOORS} 层，预算不够（本卷最多切 ${cap.max} 章）。重试让模型少切几章，或用卷卡「编辑骨架」把本卷楼数改大`);
    const thin = chapters.filter(c => c.floors < LF_MIN_CHAPTER_FLOORS).length;
    if (thin) throw new Error(`有 ${thin} 章的楼数低于每章下限 ${LF_MIN_CHAPTER_FLOORS} 层（本卷预算 ${vol.floors} 层、最多切 ${cap.max} 章）。重试，或用卷卡「编辑骨架」把本卷楼数改大`);
    const sum = chapters.reduce((n, c) => n + c.floors, 0);
    if (sum !== vol.floors) chapters = rescaleFloors(chapters, vol.floors);
    const lackNodes = chapters.find(c => c.nodes.length < LF_MIN_NODES);
    if (lackNodes) throw new Error(`章「${lackNodes.title}」节点少于 ${LF_MIN_NODES} 个——重试`);
    const v = lfState().volumes[vi];
    const prev = v.chapters ?? [];
    v.chapters = chapters.map((c, ci) => normChapter({
        ...c,
        lit: prev[ci] && prev[ci].nodes.length === c.nodes.length ? prev[ci].lit : 0,
        litFloors: prev[ci] && prev[ci].nodes.length === c.nodes.length ? (prev[ci].litFloors ?? []) : [],   // 重切换表＝锚层作废（与 lit 同条件）
        done: prev[ci] && prev[ci].nodes.length === c.nodes.length ? prev[ci].done : false,
        unitId: prev[ci]?.unitId ?? '',
    }));
    v.splitAt = Date.now();
    v.splitState = 'done';
    v.splitError = '';
    persistLf();
}

async function runLfSplitOne(vi, { provider, signal, materials, outline, live = [], onUsage, onDelta, opinion = '' }) {
    const st = lfState();
    const vol = st.volumes[vi];
    try {
        const cap = lfChapterCap(vol.floors);
        const user = [
            materials,
            outline,
            splitSystemPrompt(),
            ...live,
            '## 本卷任务',
            `把第 ${vi + 1} 卷「${vol.title}」切成章与节点。本卷预算 ${vol.floors} 层楼（各章之和必须等于它）；最多切 ${cap.max} 章${cap.max === 1 ? '——预算只够一章，整卷切成一章、不要硬拆' : `（建议 ${cap.typ} 章左右）`}。卷级文本如下：`,
            vol.text,
            `锚清单：${vol.anchors.map((a, k) => `${k + 1}. ${a.title}${a.point ? `——${a.point}` : ''}`).join('；')}`,
            ...(opinion ? ['## 重切参考意见（只作用于这次切章——章怎么切、节点怎么排参考它；卷文本本身不动）', opinion] : []),
        ].join('\n\n');
        const result = await lfCall({ system: lfCommonSystem(), user, provider, signal, mult: 3, onUsage, onDelta: onDelta && (t => onDelta(vi, t.length)) });
        settleSplitResult(vi, result);
        return true;
    } catch (err) {
        if (err?.name === 'AbortError') throw err;
        const v = lfState().volumes[vi];
        v.splitState = 'error';
        v.splitError = String(err?.message ?? err);
        persistLf();
        throw err;
    }
}

// ⑥' 单卷重切（第二十四轮）：带可选意见重切一卷——切章层的「按意见修订」；已切过的卷也能重切
// （重切按章位置沿用旧章的点亮进度，与批量「生成章节」同一套规则）
export async function runLfVolSplit(vi, { opinion = '', provider, signal, onUsage, onDelta, onProgress } = {}) {
    const st = lfState();
    const vol = st.volumes[vi];
    if (!vol) throw new Error('没有这一卷');
    if (vol.detailState !== 'done' || !vol.text) throw new Error('这一卷还没有卷文本——先跑「具体化各卷」');
    vol.splitState = 'run';
    vol.splitError = '';
    persistLf();
    onProgress?.({ settled: 0, total: 1 });
    const { stable, live } = lfStableAndVolatile();
    const materials = stable.join('\n\n');
    const outline = bookOutlineBlock(st);
    try {
        await runLfSplitOne(vi, { provider, signal, materials, outline, live, onUsage, onDelta, opinion });
    } catch (err) {
        if (err?.name === 'AbortError') {
            const v = lfState().volumes[vi];
            if (v) { v.splitState = 'none'; persistLf(); }   // 中断不留永远的「切章中」
        }
        throw err;
    } finally {
        onProgress?.({ settled: 1, total: 1 });
    }
    return { ok: true };
}

// ⑥'' 整书章层修订（第三十轮，操作条「按意见修订所有章」）：对已切章的卷逐卷带整书意见重切。
// 与第二十八轮整书卷文本修订同一套经济学（通则三/四）：全部卷文本进共享段（跨卷意见两头都
// 看得到）、每次调用只重出点名的一卷（章＋节点全文比卷文本更容易撞输出上限）、先焐热再并行、
// 逐卷落袋互不连坐——失败卷旧章原样保留。卷文本不动：要改卷文本走「按意见修订所有卷」
export async function runLfChapterRevise({ opinion = '', provider, signal, onUsage, onDelta, onProgress } = {}) {
    const note = String(opinion ?? '').trim();
    if (!note) throw new Error('修改意见是空的——写一句要改什么');
    const st = lfState();
    // 目标＝有卷文本且有章表的卷（含上一轮修订失败仍留旧章的卷——失败卷要能重试，不能因
    // splitState＝error 就被跳过）；从没切出过章的卷归「生成章节」管，不在这
    const targets = st.volumes.map((v, i) => ({ v, i }))
        .filter(x => x.v.detailState === 'done' && x.v.text && ((x.v.chapters?.length ?? 0) > 0 || x.v.splitState === 'done'));
    if (!targets.length) throw new Error('还没有已切章的卷——先跑「生成章节」');
    const { stable, live } = lfStableAndVolatile();
    const volsBlock = targets.map(({ v, i }) => [
        `### 第 ${i + 1} 卷「${v.title}」（预算 ${v.floors} 层楼）`,
        v.text,
        `锚：${v.anchors.map(a => a.title).join('、')}`,
    ].join('\n')).join('\n\n');
    // 共享段在逐卷调用间逐字节一致（垫前缀缓存），分歧只在尾巴的「本卷任务」
    const shared = [
        stable.join('\n\n'),
        bookOutlineBlock(st),
        splitSystemPrompt(),
        ...live,
        '## 全部卷的当前文本',
        volsBlock,
        '## 修改意见（只作用于章怎么切、节点怎么排——各卷卷文本不动）',
        note,
    ].join('\n\n');
    for (const { v } of targets) { v.splitState = 'run'; v.splitError = ''; }
    persistLf();
    let settled = 0, updated = 0;
    onProgress?.({ settled: 0, total: targets.length });
    const tick = () => onProgress?.({ settled: ++settled, total: targets.length });
    const rs = await warmFirstAllSettled(targets.map(({ v, i }) => () => (async () => {
        const cap = lfChapterCap(v.floors);
        const user = [shared,
            '## 本卷任务',
            `只重出第 ${i + 1} 卷「${v.title}」的章与节点——其余卷的当前文本只是上下文，不要输出它们。本卷预算 ${v.floors} 层楼（各章之和必须等于它）；最多切 ${cap.max} 章${cap.max === 1 ? '——预算只够一章，整卷切成一章、不要硬拆' : `（建议 ${cap.typ} 章左右）`}。按上面的修改意见重切本卷：意见点名本卷的章怎么切、节点怎么排就照意见办，没点名的地方维持合理切法。`,
        ].join('\n\n');
        try {
            settleSplitResult(i, await lfCall({ system: lfCommonSystem(), user, provider, signal, mult: 3, onUsage, onDelta: onDelta && (t => onDelta(i, t.length)) }));
            updated++;
        } catch (err) {
            if (err?.name === 'AbortError') throw err;
            const vol = lfState().volumes[i];
            if (vol) { vol.splitState = 'error'; vol.splitError = String(err?.message ?? err); persistLf(); }
            throw err;
        }
    })().then(r => { tick(); return r; }, e => { tick(); throw e; })));
    const failed = [];
    rs.forEach((r, k) => { if (r.status === 'rejected') failed.push({ vol: targets[k].i, reason: String(r.reason?.message ?? r.reason) }); });
    const st2 = lfState();
    // 中断兜底：卡在「切章中」的卷——旧章还在就回「已切章」（chrev 的目标卷切前必有章），没有才回未切章
    for (const v of st2.volumes) if (v.splitState === 'run') v.splitState = (v.chapters?.length ?? 0) > 0 ? 'done' : 'none';
    if (st2.volumes.every(v => v.splitState === 'done') && ['skeleton', 'detailed'].includes(st2.stage)) {
        st2.stage = 'split';
    }
    persistLf();
    flushChatData();
    return { updated, failed };
}

// ---------------------------------------------------------------------------
// 执行层：章 → 监听单位槽（挂载 / 进度同步 / 手动接续）
// ---------------------------------------------------------------------------

// 章 → 单位（挂进监听的最小剧情单位：章文本全文＋节点表；unitId 挂在章上，重挂不换身份）
export function chapterUnit(st, vi, ci) {
    const vol = st.volumes[vi];
    const ch = vol?.chapters?.[ci];
    if (!ch || !ch.nodes.length) return null;
    if (!ch.unitId) {
        ch.unitId = newId('lfu-');
        persistLf();
    }
    return {
        id: ch.unitId,
        source: 'longform',
        title: `${vol.title} · ${ch.title}`.slice(0, 120),
        text: String(ch.text ?? ''),
        at: Date.now(),
        lfRef: { vol: vi, ch: ci },
        nodes: ch.nodes.map(n => ({ title: n.title, criterion: n.criterion, text: '' })),
        nodeIdx: Math.min(ch.lit, ch.nodes.length),
        litFloors: (Array.isArray(ch.litFloors) ? ch.litFloors : []).slice(0, Math.min(ch.lit, ch.nodes.length)),   // 锚层随账本带回（第四十五轮）
    };
}

// 进度账同步（第三十一轮改对账制）：监听单位槽是唯一的「执行位」，长线块的 mount 只是渲染缓存——
// 在监听页卸下/丢弃/顶掉/接回后这里要对得上账，不然长线页假显示「执行中」、挂载按钮也不回来。
// 三分支：①活动单位是长线章→进度写回账本、执行位跟随（被接回也能重新认回来）；
// ②退位槽里的长线章→冻结进度抢救进账本（丢弃前先落账，账不丢）；③没有长线章在岗→执行位清空
export function syncLfProgress() {
    const st = lfState();
    const ls = listenerState();
    const active = ls.unit;
    if (active && active.source === 'longform' && active.lfRef) {
        const ch = st.volumes[active.lfRef.vol]?.chapters?.[active.lfRef.ch];
        if (ch && ch.unitId === active.id) {
            const lit = Math.min(active.nodeIdx, ch.nodes.length);
            if (lit > ch.lit) {
                // 新点亮段的锚层入账（第四十五轮）：单位侧点亮自带楼层号，账本跟着长。
                // 删楼回退不走这里——章账本的倒回只在对账器 reconcileLfFloors 的显式路径上，
                // 「只进不退」总口径（旧副本不倒账）原样保留
                if (!Array.isArray(ch.litFloors)) ch.litFloors = [];
                const ua = Array.isArray(active.litFloors) ? active.litFloors : [];
                for (let i = ch.lit; i < lit; i++) ch.litFloors[i] = ua[i] ?? null;
                ch.lit = lit;
            }
            if (active.nodeIdx >= active.nodes.length) ch.done = true;
            if (!st.mount || st.mount.unitId !== active.id) {
                st.mount = { vol: active.lfRef.vol, ch: active.lfRef.ch, unitId: active.id, at: active.at };
            }
            persistLf();
            return st;
        }
    }
    const side = ls.sidelined;
    if (side && side.source === 'longform' && side.lfRef) {
        const ch = st.volumes[side.lfRef.vol]?.chapters?.[side.lfRef.ch];
        if (ch && ch.unitId === side.id && ch.nodes.length === side.nodes.length) {
            const lit = Math.min(side.nodeIdx, ch.nodes.length);
            if (lit > ch.lit) {
                // 冻结进度落账时锚层一并入账（第四十五轮）；回退同样只走对账器显式路径
                if (!Array.isArray(ch.litFloors)) ch.litFloors = [];
                const sa = Array.isArray(side.litFloors) ? side.litFloors : [];
                for (let i = ch.lit; i < lit; i++) ch.litFloors[i] = sa[i] ?? null;
                ch.lit = lit;   // 重切过（节点数对不上）不回写，防错账
            }
            if (side.nodeIdx >= side.nodes.length) ch.done = true;
            persistLf();
        }
    }
    if (st.mount) {
        st.mount = null;
        persistLf();
    }
    return st;
}

// 删楼回退对账器（第四十五轮；index.js 注册进监听的删楼事件与轮首兜底）：
// 监听两账（活动单位＋退位槽）先倒、留痕落账，再对真被锚层回退的长线章**显式**把账本倒回去——
// 不借道 syncLfProgress 的通用比较，「只进不退」（第三十一轮：旧副本不倒账）原样保留。
// 返回回退清单（null＝没动）。挂普通规划单位时也能用——章账本分支自然落空
export function reconcileLfFloors() {
    const chat = Array.isArray(getTavernContext().chat) ? getTavernContext().chat : [];
    if (!chat.length) return null;   // chatdata 未载完不硬对账（就绪窗口坑：空聊天不当「全删」处理）
    const rolled = rollbackListenerFloors(lastRoleFloor(collectFloorsFromChat(chat)));
    if (!rolled) return null;
    const st = lfState();
    let touched = false;
    for (const r of rolled) {
        const u = r.unit;
        if (!u || u.source !== 'longform' || !u.lfRef) continue;
        const ch = st.volumes[u.lfRef.vol]?.chapters?.[u.lfRef.ch];
        // 节点表对得上才倒（重切过不碰，防错账——与冻结落账同一守卫）
        if (ch && ch.unitId === u.id && ch.nodes.length === u.nodes.length && u.nodeIdx < ch.lit) {
            ch.lit = u.nodeIdx;
            ch.litFloors = (Array.isArray(ch.litFloors) ? ch.litFloors : []).slice(0, ch.lit);
            if (ch.lit < ch.nodes.length) ch.done = false;
            touched = true;
        }
    }
    if (touched) persistLf();
    return rolled;
}

export function mountChapter(vi, ci) {
    syncLfProgress();
    const st = lfState();
    const unit = chapterUnit(st, vi, ci);
    if (!unit) return { ok: false, reason: '这一章没有可挂载的节点表（先完成「生成章节」）' };
    const r = opMountUnit(unit);
    if (r.ok) {
        const prev = st.mount;
        if (prev) {
            const pch = st.volumes[prev.vol]?.chapters?.[prev.ch];
            if (pch && pch.lit >= pch.nodes.length) pch.done = true;
        }
        st.mount = { vol: vi, ch: ci, unitId: unit.id, at: Date.now() };
        persistLf();
        flushChatData();
        // 重挂对账（第三十三轮用户拍板）：这章有进度＝不是首挂，立即跑一次回归判定——
        // 对照五章规划窗口出「走到哪、偏没偏」的报告（钱照花一次，报告落在监听页）
        scheduleReentryFor(unit);
    }
    return r;
}

// 回归判定的五章窗口（第三十三轮用户拍板）：以当前章为中心、卷内前二后二补足五章；
// 前面不足往后补、后面不足往前补；卷不足五章整卷判——窗口不跨卷（短卷就整卷）
export function reentryWindow(st, vi, ci) {
    const vol = st.volumes[vi];
    const chs = vol?.chapters ?? [];
    const n = chs.length;
    if (!n) return null;
    let start = 0, len = n;
    if (n > 5) {
        start = Math.min(Math.max(ci - 2, 0), n - 5);
        len = 5;
    }
    return { start, len, chapters: chs.slice(start, start + len) };
}

// 备料并开跑回归判定：这里负责从账本拼五章窗口文本（当前章带完整节点表与账面进度标注），
// 判定循环在 listener.js（longform 引监听、监听不得反向引 longform——界面层搭桥的老规矩在备料处绕开）
export function scheduleReentryFor(unit) {
    if (!unit || unit.source !== 'longform' || !unit.lfRef) return null;
    if (!(unit.nodeIdx > 0)) return null;   // 零进度＝首挂：没有要对账的账，照常等下一轮例行判定
    const st = lfState();
    const vol = st.volumes[unit.lfRef.vol];
    const w = reentryWindow(st, unit.lfRef.vol, unit.lfRef.ch);
    if (!vol || !w) return null;
    const label = `《${vol.title}》第${w.start + 1}-${w.start + w.len}章（共${vol.chapters.length}章）`;
    const text = w.chapters.map((c, i) => {
        const idx = w.start + i;
        const cur = idx === unit.lfRef.ch;
        const nodes = cur
            ? `\n本章节点表（挂载时账面已点亮前 ${unit.nodeIdx} 个）：\n${(c.nodes ?? []).map((nn, k) => `${k + 1}. ${nn.title}——完成标准：${nn.criterion}${nn.text ? `；内容：${nn.text}` : ''}`).join('\n') || '（无节点）'}`
            : '';
        return `【第${idx + 1}章${cur ? '·当前挂载章' : ''}】《${c.title}》${nodes}\n${String(c.text ?? '')}`;
    }).join('\n\n');
    return runReentryRound({ window: { label, text }, unitId: unit.id }).catch(() => null);   // 失败已在引擎里留痕上屏，不炸挂载流程
}

// 接续＝全书顺序里下一章未演完的章（节点衔接只做手动，§6.8；当前章没演完时拒绝并指路）
export function lfNextChapter(st) {
    for (let vi = 0; vi < st.volumes.length; vi++) {
        const chs = st.volumes[vi].chapters ?? [];
        for (let ci = 0; ci < chs.length; ci++) if (!chs[ci].done) return { vol: vi, ch: ci };
    }
    return null;
}

export function lfStats(st) {
    let chapters = 0, done = 0, nodes = 0, lit = 0;
    for (const v of st.volumes) for (const c of v.chapters ?? []) {
        chapters++; if (c.done) done++;
        nodes += c.nodes.length; lit += Math.min(c.lit, c.nodes.length);
    }
    return { chapters, done, nodes, lit };
}
