// 2.0 长线规划（DESIGN §6.2-6.7，2026-08-30 落码）：书-卷-章-节点 四层的数据层与生成管线编排。
// 产物不直接注入扮演模型——「章」挂进监听当最小剧情单位逐轮执行（§6.1 反剧透决策）。
// 管线：①骨架（含②切块，一次调用出卷＋楼数，插件校验总和、楼数算术插件说了算）→
// ③分块具体化（逐卷并行一次一卷，卷级文本内嵌推进锚）→ ④拼接（纯展示）→
// ⑤审阅改（按意见整书修订 / 卷文本就地手改）→ ⑥再切小（逐卷并行：卷→章→节点）→ 挂载执行。
// 混合重编 / 暂停恢复 / 归档 / 场景元素卡 / 动作指导卡不在本期（§6.8 后续块）。
import { settings, newId } from "./settings.js";
import { loadChatData, saveChatData, flushChatData } from "./chatdata.js";
import { chatCompletion, parseModelJson } from "./api.js";
import { materialSections } from "./materials.js";
import { storyState, activeStory } from "./story.js";
import { listenerState, opMountUnit } from "./listener.js";
import { storageItemsInEffect } from "./store.js";
import { knowledgeLists, payloadFromIds, entryText } from "./knowledge.js";

// 数值（§6.8：2026-08-28 用户终审；节点下限 3 是唯一未点名项，按提案默认执行）
export const LF_MIN_ANCHORS = 4;          // 推进锚每卷下限（后期改「生成前可选/模型自判」，用户预告）
export const LF_MIN_CHAPTER_FLOORS = 20;  // 一章至少 20 层楼、不设上限（原 10-20 区间作废）
export const LF_MIN_NODES = 3;            // 每章节点下限
export const LF_DEFAULT_FLOORS = 120;     // 楼层总数缺省兜底（助手默认；§6.3「用户不填用默认值兜底」）

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
        error: '',                // 最近一次失败原因（页面上留痕，成功后清）
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
    st.mount = st.mount && Number.isInteger(st.mount?.vol) && Number.isInteger(st.mount?.ch)
        ? { vol: st.mount.vol, ch: st.mount.ch, unitId: String(st.mount.unitId ?? ''), at: Number(st.mount.at) || 0 }
        : null;
    return st;
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
    return {
        title: String(o.title ?? '').slice(0, 120) || '未命名章',
        floors: posInt(o.floors) ?? LF_MIN_CHAPTER_FLOORS,
        text: String(o.text ?? ''),
        nodes,
        lit: Math.min(Math.max(0, Math.round(Number(o.lit) || 0)), nodes.length),   // 进度账：已点亮节点数
        done: o.done === true || (nodes.length > 0 && (Number(o.lit) || 0) >= nodes.length),
        unitId: String(o.unitId ?? ''),
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
    if (thin) return { ok: false, reason: `有 ${thin} 卷楼数不足 ${LF_MIN_CHAPTER_FLOORS}（一章的最低楼数）——把楼层总数提到至少 ${vols.length * LF_MIN_CHAPTER_FLOORS}，或重新生成骨架让它少切几卷` };
    return { ok: true };
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
        if (!checked.has(list.id)) continue;
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
// 整批并行调用只拼一次、逐卷共享同一份字符串。知识库小节按第十三轮排序原则插在检索命中前
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
    const idx = parts.findIndex(p => String(p ?? '').startsWith('## 检索命中的世界书条目'));
    if (idx < 0) return [...parts, ...(sec ?? [])];
    return [...parts.slice(0, idx), ...(sec ?? []), ...parts.slice(idx)];
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
// 提示词四份（全新起草，随交付报告送审；结构要点出自 §6.7——旧 v3 全文已失传，不得冒充已审原文）
// ---------------------------------------------------------------------------

// 硬约束组（§6.11 同源条款的长线版：时间顺序 / 事实一致性 / user 不可编排 / 点名硬要求 / 通则一）
const GUARD_RULES = [
    '时间顺序：材料各小节与条目的排列顺序不代表时间先后，不得按罗列顺序安排先后；对话记录或用户想法里给出了当前时间的，一律以它为准，长线排程从当前时段往后推；已经发生的事发生在哪天就是哪天，后续剧情只能从既定事实之后往后推。',
    '事实一致性：对话记录、记忆表格、历史摘要里已发生的事，以及角色与 user 的既定设定（年龄、身份、能力、资格——从对话、人设卡、记忆表格里读到的）是硬约束，不得安排设定不允许的事（如未成年角色开车）；「剧情需要」与既定事实或设定冲突时，事实与设定赢。',
    'user 不可编排：user 是用户本人扮演的角色，长线只编排角色（char）与世界。不替 user 做动作、不替 user 说出台词或给出回应（「user 答应后」这类把 user 的回应写成既成事实的写法同属此列）、不预设 user 的心理反应；对话或用户想法里 user 已明确说出的意愿可当前提。涉及 user 的部分只能写条件式接口「若 user X，则 Y」，且每段剧情的核心推进独立成立、不依赖 user 的任何具体回应。',
    '点名要求是硬要求：想法或修改意见里点名的数量、价位或金额、时间日期、由谁发起或由谁挑选、地点、身份资格等——凡点名了的逐条落实，不得打折、不得反着写、不得自作主张换成别的方案；与你自己的习惯偏好冲突时，用户要求赢。',
    '数量要求一律是「至少 N、不设上限」：N 是下限不是目标值，剧情需要更多就给更多；任何示例只示范结构与写法，具体内容自行设计，不得照抄示例。',
];

export function skeletonSystemPrompt({ totalFloors, minFloors = 0, newChars = false } = {}) {
    return [
        '你是文字角色扮演的长线剧情总设计师。用户正在为一部以「楼层」计量的长篇角色扮演作品做全书规划，会给你角色设定、世界书、记忆表格、进行中剧情、历史剧情摘要与最近对话等材料。你的任务：设计全书骨架——只到「卷」级，不写具体场景与台词。',
        lfPaceAnchor(),
        '任务要求：',
        `- 全书切成若干卷（至少 2 卷、不设上限）：每卷给卷名、剧情概要（这卷讲什么、从哪推进到哪、主要张力是什么、出场角色有谁）与本卷楼数。`,
        `- 各卷楼数之和必须等于 ${totalFloors}（硬预算，程序会校验；各卷大小由剧情体量决定，但总和不能多也不能少）。${minFloors > 0 ? `全书剧情体量至少要撑得起 ${minFloors} 层楼的推进（保底要求）。` : ''}`,
        `- 每卷至少要能切出一章（一章至少 ${LF_MIN_CHAPTER_FLOORS} 层楼），即每卷楼数不得低于 ${LF_MIN_CHAPTER_FLOORS}。`,
        newChars
            ? '- 允许引入新角色：在概要里显式点名新角色是谁、第几卷入场、起什么作用。'
            : '- 不引入新角色：全书只用材料里已有的角色与世界要素（临时路人可以有无名分的过场）。',
        '- 种子显式列出：每卷的伏笔与新要素在 seeds 里逐条写明（埋什么、预计在哪收）；本卷没有写「无」。',
        '- 卷与卷之间要有推进关系（后卷接着前卷的果），但每卷有自己的核心张力，不写成一卷的事抻成三卷。',
        ...GUARD_RULES,
        '字符串值里不要出现英文双引号（引用一律写中文「」），也不要在值内换行。',
        '只输出一个符合如下结构的 JSON 对象，不要输出 JSON 以外的任何文字：',
        '{',
        '  "volumes": [',
        `    { "title": "卷名（简短）", "summary": "本卷剧情概要：讲什么、起止与主要张力、出场角色", "seeds": "本卷埋设的伏笔与新要素，逐条列出（埋什么、预计哪里收）；没有写「无」", "floors": ${Math.max(LF_MIN_CHAPTER_FLOORS, Math.floor(totalFloors / 4))} }`,
        '  ]',
        '}',
    ].join('\n');
}

export function detailSystemPrompt() {
    return [
        '你是文字角色扮演的长线剧情编剧。用户已定好全书骨架（见用户消息「全书骨架」小节），你的任务：把指定的一卷写成卷级详细剧情文本——具体到场景、事件链与角色行动安排，但不写台词级细节。',
        lfPaceAnchor(),
        '任务要求：',
        `- 展开程度匹配本卷楼数预算：本卷共 X 层楼 ≈ 有效推进约 X×几百到一千字量级的剧情量——预算大就多排事件线、多给波折与支线，预算小就收敛；不写与预算脱节的流水账，也不把大预算写成一页纸。`,
        `- 推进锚（本卷的剧情检查点）：至少 ${LF_MIN_ANCHORS} 个、不设上限——每个锚是一段有明确完成态的剧情点（一个具体事件实际发生、一个目标达成或落空、一个关键转折落地）；锚与锚之间在文本里标注「（本锚间自由演绎）」——执行时扮演模型可自由发挥，锚是将来切章与判定进度的刀口。`,
        '- 锚写成独立行，格式：【锚 N】锚标题——锚落地时发生了什么（一句话、可对照）。',
        '- 骨架 seeds 里点名的伏笔必须落到文本里的具体剧情点，写明在哪埋、怎么收；「本锚间自由演绎」段不算埋伏笔。',
        '- 卷内时间线自洽：长线可以跨多天多周，但先后顺序不能乱，排程从既定事实之后往后推。',
        ...GUARD_RULES,
        '字符串值里不要出现英文双引号（引用一律写中文「」）；text 值内的换行写 \\n。',
        '只输出一个符合如下结构的 JSON 对象，不要输出 JSON 以外的任何文字：',
        '{',
        '  "text": "卷级剧情文本（含【锚 N】行与「（本锚间自由演绎）」标注，换行写 \\n）",',
        '  "anchors": [',
        '    { "title": "锚标题", "point": "锚落地时发生了什么（一句话、可对照楼层内容核对）" }',
        '  ]',
        '}',
        '（anchors 数组与 text 里的【锚 N】行一一对应，两边都要给全。）',
    ].join('\n');
}

export function reviseSystemPrompt() {
    return [
        '你是长线剧情大纲的修订编辑。用户会给你全部卷的当前文本与一条修改意见，你按意见修订全书。',
        lfPaceAnchor(),
        '任务要求：',
        '- 只改意见涉及的地方与违反硬约束的地方，其余原样保留——修订不是重写：没被意见点名的卷的走向、事件与锚原则上不动。',
        '- 输出必须是全部卷的修订后全文：哪怕某卷一字未动也要原样输出，不能只给被改的卷。',
        '- 锚随文本同步：剧情改了的卷锚跟着改；没动的卷锚原样带出。推进锚仍须满足各卷下限。',
        '- 各卷楼数分配维持原样（修订不改预算；要改预算回骨架步重新生成）。',
        ...GUARD_RULES,
        '字符串值里不要出现英文双引号（引用一律写中文「」）；text 值内的换行写 \\n。',
        '只输出一个符合如下结构的 JSON 对象，不要输出 JSON 以外的任何文字：',
        '{',
        '  "volumes": [',
        '    { "title": "卷名", "text": "修订后的卷级剧情文本", "anchors": [ { "title": "锚标题", "point": "锚落地内容" } ] }',
        '  ]',
        '}',
    ].join('\n');
}

export function splitSystemPrompt() {
    return [
        '你是长线剧情的切章编辑。用户会给你全书骨架与某一卷的卷级文本，你的任务：把这一卷切成章、再把每章切出执行节点——一步到位。',
        lfPaceAnchor(),
        '任务要求：',
        `- 章：每章至少 ${LF_MIN_CHAPTER_FLOORS} 层楼、不设上限；推进锚是切章的刀口——章界尽量落在锚上（每章至少完整覆盖一个锚，锚不被腰斩）；本卷预算 X 层楼已定，各章楼数之和必须等于本卷预算。`,
        '- 章文本（text）：这一章怎么演的执行指导——场景、事件链、角色行动安排，按本章楼数预算给足剧情量。这章文本将来整章挂进监听逐轮判定进度，扮演模型看不到它、监听按它对账。',
        `- 节点：每章至少 ${LF_MIN_NODES} 个、不设上限；节点＝最小剧情单元，每个带「完成标准」——必须能对着楼层内容逐条核对（「她把礼物送到对方手里」可核对；「气氛变好」不可核对）；达成口径＝角色动作偏向该目标即算达成（写给逐轮判定用，不是给人读的散文）。`,
        '- 伏笔硬规则：卷文本里埋设或收束的伏笔，挂到具体节点的完成标准里（该节点必须让埋设或收束实际发生）；执行时没埋成会报错交用户处置。',
        '- 楼层预算不传导：某章实写超了楼数不向后传导（执行期原则）；但各章楼数分配现在定死，之和等于本卷预算。',
        'user 不可编排（长线版）：不替 user 做动作、不说台词、不预设心理（对话或骨架里 user 已明的意愿可当前提）；涉及 user 只能写「若 user X，则 Y」的条件式接口，且每章的核心推进不依赖 user 的任何具体回应。',
        '事实一致性：卷文本与材料里的既定事实、既定设定是硬约束，切章与节点安排不得违反。',
        '数量要求一律是「至少 N、不设上限」；示例只示范写法，内容自行设计。',
        '字符串值里不要出现英文双引号（引用一律写中文「」）；text 值内的换行写 \\n。',
        '只输出一个符合如下结构的 JSON 对象，不要输出 JSON 以外的任何文字：',
        '{',
        '  "chapters": [',
        `    { "title": "章名", "floors": ${LF_MIN_CHAPTER_FLOORS}, "text": "本章执行指导文本（含场景、事件链、角色行动安排）", "nodes": [ { "title": "节点名", "criterion": "完成标准（可对照楼层内容核对；角色动作偏向该目标即算达成）" } ] }`,
        '  ]',
        '}',
    ].join('\n');
}

// ---------------------------------------------------------------------------
// 调用编排（每步走 chatCompletion＋parseModelJson 修复梯子；输出上限乘数：这些产物
// 比一次 1.0 规划长得多——骨架 ×2、卷文本/修订/切章 ×3；设置 0 = 不限时保持 0）
// ---------------------------------------------------------------------------

function lfMaxTokens(mult) {
    const t = Math.round(Number(settings.api.maxTokens) || 0);
    return t ? Math.round(t * mult) : 0;
}

async function lfCall({ system, user, provider, signal, mult = 2, onUsage }) {
    const req = {
        messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
        ],
        maxTokens: lfMaxTokens(mult),
        ...(provider ? { provider } : {}),
        ...(signal ? { signal } : {}),
        ...(onUsage ? { onUsage } : {}),
    };
    const { result } = await parseModelJson(await chatCompletion(req), req);
    return result;
}

// ①＋② 骨架与切块（一次调用出卷＋楼数；总和校验与重配在本地）
export async function runLfSkeleton({ totalFloors, minFloors = 0, idea = '', newChars = false, provider, signal, onUsage } = {}) {
    const total = posInt(totalFloors) ?? LF_DEFAULT_FLOORS;
    const materials = lfMaterialParts().join('\n\n');
    const system = skeletonSystemPrompt({ totalFloors: total, minFloors, newChars });
    const user = [
        materials,
        '## 本次长线的想法与硬参数（本长线的最高优先级输入）',
        `全书楼层总数：${total}（各卷楼数之和必须等于它）`,
        `保底楼数：${minFloors > 0 ? `${minFloors}（全书剧情体量的下限）` : '未设'}`,
        `是否允许引入新角色：${newChars ? '允许' : '不允许'}`,
        `用户想法：\n${String(idea ?? '').trim() || '（未填——按材料自由设计）'}`,
    ].join('\n\n');

    const result = await lfCall({ system, user, provider, signal, mult: 2, onUsage });
    const raw = Array.isArray(result?.volumes) ? result.volumes : [];
    const vols = rescaleFloors(raw.map((v, i) => ({
        title: String(v?.title ?? '').slice(0, 120),
        summary: String(v?.summary ?? ''),
        seeds: String(v?.seeds ?? ''),
        floors: posInt(v?.floors) ?? 0,
        no: i,
    })), total);
    const check = validateVolumes(vols, total);
    if (!check.ok) throw new Error(check.reason);

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

// ③ 分块具体化：逐卷并行一次一卷（§6.4「能分多细分多细，批次不设限」——并行由调用方 API 承担）；
// 材料与骨架块整批只拼一次、逐卷共享（同一前缀，走缓存的服务商只付一次全价）
export async function runLfDetailBatch({ provider, signal, onUsage } = {}) {
    const st = lfState();
    const targets = st.volumes.map((v, i) => ({ v, i })).filter(x => x.v.detailState !== 'done');
    if (!targets.length) return { done: 0, failed: [] };
    const materials = lfMaterialParts().join('\n\n');
    const outline = bookOutlineBlock(st);
    for (const { v } of targets) { v.detailState = 'run'; v.detailError = ''; }
    persistLf();
    const rs = await Promise.allSettled(targets.map(({ i, v }) => runLfDetailOne(i, { provider, signal, materials, outline, onUsage })));
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

async function runLfDetailOne(vi, { provider, signal, materials, outline, onUsage }) {
    const st = lfState();
    const vol = st.volumes[vi];
    try {
        const user = [
            materials,
            outline,
            '## 本卷任务',
            `把第 ${vi + 1} 卷「${vol.title}」写成卷级详细剧情文本。本卷预算 ${vol.floors} 层楼；骨架概要与种子如上，务必落实。`,
        ].join('\n\n');
        const result = await lfCall({ system: detailSystemPrompt(), user, provider, signal, mult: 3, onUsage });
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

// ⑤ 审阅改：按意见整书修订（意见必填——长线不设「换一版」档，要重来走「重新生成骨架」）
export async function runLfRevise({ opinion = '', provider, signal, onUsage } = {}) {
    const note = String(opinion ?? '').trim();
    if (!note) throw new Error('修改意见是空的——写一句要改什么（长线的「换一版」＝重新生成骨架）');
    const st = lfState();
    if (!st.volumes.length || !st.volumes.every(v => v.detailState === 'done' && v.text)) {
        throw new Error('还有卷没具体化完——先跑完「具体化各卷」再修订');
    }
    const materials = lfMaterialParts().join('\n\n');
    const volsBlock = st.volumes.map((v, i) => [
        `### 第 ${i + 1} 卷「${v.title}」（预算 ${v.floors} 层楼）`,
        v.text,
        `锚：${v.anchors.map(a => a.title).join('、')}`,
    ].join('\n')).join('\n\n');
    const user = [
        materials,
        bookOutlineBlock(st),
        '## 全部卷的当前文本',
        volsBlock,
        '## 修改意见',
        note,
    ].join('\n\n');
    const result = await lfCall({ system: reviseSystemPrompt(), user, provider, signal, mult: 3, onUsage });
    const list = Array.isArray(result?.volumes) ? result.volumes : [];
    if (!list.length) throw new Error('修订输出里没有卷');
    if (list.length !== st.volumes.length) throw new Error(`修订输出卷数 ${list.length} 与现有 ${st.volumes.length} 不一致——已放弃写入，重试或把意见拆小`);
    const st2 = lfState();
    st2.volumes.forEach((v, i) => {
        const r = list[i] ?? {};
        const text = String(r?.text ?? '').trim();
        if (!text) return;   // 该卷空文本＝模型没给，保留原文（宁缺勿毁）
        v.title = String(r?.title ?? v.title).slice(0, 120) || v.title;
        v.text = text;
        let anchors = Array.isArray(r?.anchors) ? r.anchors.map(a => ({ title: String(a?.title ?? ''), point: String(a?.point ?? '') })) : [];
        if (anchors.length < LF_MIN_ANCHORS) {
            const fromText = anchorsFromText(text);
            if (fromText.length > anchors.length) anchors = fromText;
        }
        if (anchors.length >= LF_MIN_ANCHORS) v.anchors = anchors.map(a => ({ title: a.title || '未命名锚', point: a.point }));
        v.textAt = Date.now();   // 修订后章表（若有）标过期
    });
    persistLf();
    flushChatData();
    return st2;
}

// ⑥ 再切小：逐卷并行（卷→章→节点一步到位）；章预算重配同卷预算：算术插件说了算
export async function runLfSplitBatch({ provider, signal, onUsage } = {}) {
    const st = lfState();
    const targets = st.volumes.map((v, i) => ({ v, i }))
        .filter(x => x.v.detailState === 'done' && x.v.splitState !== 'done');
    if (!targets.length) return { done: 0, failed: [] };
    const materials = lfMaterialParts().join('\n\n');
    const outline = bookOutlineBlock(st);
    for (const { v } of targets) { v.splitState = 'run'; v.splitError = ''; }
    persistLf();
    const rs = await Promise.allSettled(targets.map(({ i, v }) => runLfSplitOne(i, { provider, signal, materials, outline, onUsage })));
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

async function runLfSplitOne(vi, { provider, signal, materials, outline, onUsage }) {
    const st = lfState();
    const vol = st.volumes[vi];
    try {
        const user = [
            materials,
            outline,
            '## 本卷任务',
            `把第 ${vi + 1} 卷「${vol.title}」切成章与节点。本卷预算 ${vol.floors} 层楼（各章之和必须等于它）。卷级文本如下：`,
            vol.text,
            `锚清单：${vol.anchors.map((a, k) => `${k + 1}. ${a.title}${a.point ? `——${a.point}` : ''}`).join('；')}`,
        ].join('\n\n');
        const result = await lfCall({ system: splitSystemPrompt(), user, provider, signal, mult: 3, onUsage });
        let chapters = Array.isArray(result?.chapters) ? result.chapters : [];
        if (!chapters.length) throw new Error('章列表为空');
        // 章预算算术：先保每章不低于一章下限，再重配到卷预算（模型给的总和不作数）
        chapters = chapters.map(c => ({
            title: String(c?.title ?? '').slice(0, 120),
            floors: posInt(c?.floors) ?? 0,
            text: String(c?.text ?? '').trim(),
            nodes: (Array.isArray(c?.nodes) ? c.nodes : []).map(n => ({
                title: String(n?.title ?? '').slice(0, 120),
                criterion: String(n?.criterion ?? ''),
            })).filter(n => n.title),
        })).filter(c => c.text || c.nodes.length);
        if (chapters.length < 1) throw new Error('没有可用的章（全部缺文本与节点）');
        const thin = chapters.filter(c => c.floors < LF_MIN_CHAPTER_FLOORS).length;
        if (thin) throw new Error(`有 ${thin} 章楼数低于 ${LF_MIN_CHAPTER_FLOORS}（一章的最低楼数）——重试，或把本卷预算（现 ${vol.floors} 层）加大`);
        const sum = chapters.reduce((n, c) => n + c.floors, 0);
        if (sum !== vol.floors) chapters = rescaleFloors(chapters, vol.floors);
        const lackNodes = chapters.find(c => c.nodes.length < LF_MIN_NODES);
        if (lackNodes) throw new Error(`章「${lackNodes.title}」节点少于 ${LF_MIN_NODES} 个——重试`);
        const v = lfState().volumes[vi];
        const prev = v.chapters ?? [];
        v.chapters = chapters.map((c, ci) => normChapter({
            ...c,
            // 同位置章尽量沿用旧进度（修订后重切时，已演完的章不回炉）；结构对不上的从零
            lit: prev[ci] && prev[ci].nodes.length === c.nodes.length ? prev[ci].lit : 0,
            done: prev[ci] && prev[ci].nodes.length === c.nodes.length ? prev[ci].done : false,
            unitId: prev[ci]?.unitId ?? '',
        }));
        v.splitAt = Date.now();
        v.splitState = 'done';
        v.splitError = '';
        persistLf();
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
    };
}

// 进度账同步：监听单位上点亮的节点数写回长线章（监听槽是执行位，长线块是账本——两本账里
// 「进度数据账」的持久方；单位被卸下/顶掉后账不丢）
export function syncLfProgress() {
    const st = lfState();
    if (!st.mount) return st;
    const unit = listenerState().unit;
    if (unit && unit.id === st.mount.unitId) {
        const ch = st.volumes[st.mount.vol]?.chapters?.[st.mount.ch];
        if (ch) {
            ch.lit = Math.min(unit.nodeIdx, ch.nodes.length);
            if (unit.nodeIdx >= unit.nodes.length) ch.done = true;
            persistLf();
        }
    }
    return st;
}

export function mountChapter(vi, ci) {
    syncLfProgress();
    const st = lfState();
    const unit = chapterUnit(st, vi, ci);
    if (!unit) return { ok: false, reason: '这一章没有可挂载的节点表（先完成「再切小」）' };
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
    }
    return r;
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
