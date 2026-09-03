// 2.0 监听 = 执行引擎（第一块代码）：扮演模型每轮输出后立即判定 + 为下一轮备好微量指导，
// 写独立隐身注入槽（滚动覆写）。两个模式同一循环：单位执勤（挂载了剧情单位）/
// 轻量执勤（无单位或单位已演完——OOC/剧情重复/文风重复检查，口径照搬 1.0 检查的三条基准）。
// 设计定稿见 docs/DESIGN.md §6.1 与工作文件《监听开工-设计与提示词.md》；提示词 v1.1 / v1 全新起草
// （不在失传七份之列），经用户三轮反馈修订后落此。
// 分层约定：本文件上半段是纯逻辑（楼层收集 / 提示词组装 / 契约规约 / 排队闸状态机），
// 离线测试台直接 import 覆盖；下半段是宿主接线（事件 / 注入 / 降级 / 红点）。
// 注入键 pp:listener 键空间独立（先例：store.js 的 pps:），不进 M4 注入项数组、不与其互相干扰。
import { eventSource, event_types, setExtensionPrompt, extension_prompt_types, extension_prompt_roles } from "/script.js";
import { settings, save, newId } from "./settings.js";
import { chatCompletion, parseModelJson, placeProvider } from "./api.js";
import { loadChatData, saveChatData, flushChatData } from "./chatdata.js";
import { getTavernContext, chatEnabledBookIds } from "./context.js";
import { scanLorebooks, buildLoreContext, resolveLorePicks } from "./lorebook.js";
import { buildMemoryContext, memoryState } from "./memoryTable.js";

// 第五十八轮（注入端位置根治＋身份可选）：酒馆注入接口的 position 参数传 IN_PROMPT＝「绝对位」
// 落系统提示词区（聊天补全侧进 systemPrompts 段、文本补全侧进故事串锚点），随传的 depth 被无视
// ——「注入深度」设置此前从未生效（用户实测改 0 无效的真因，扮演模型自述「指导在系统提示词」属实）。
// 传 IN_CHAT 才是「按深度插进聊天末端」：聊天补全 populateDepthInjection 与文本补全 doChatInject
// 两条管线都按 depth 切进消息序列、且尊重 role（SYSTEM/USER/ASSISTANT 三档）。
const POSITION_IN_CHAT = extension_prompt_types?.IN_CHAT ?? 1;
const ROLE_SYSTEM = extension_prompt_roles?.SYSTEM ?? 0;
const ROLE_CHAR = extension_prompt_roles?.ASSISTANT ?? 2;   // 设置「注入身份」选「角色」时用（assistant 消息）
const SLOT_KEY = 'pp:listener';
const HALT_KEY = 'pp:halt';   // 停进提示槽（2026-09-02 暂停收尾）：独立于指导槽——指导槽每轮滚动覆写，
                             // 停进提示要在「没有指导的轮次」里也活着，只能自己一个键。与监听总开关无关
                             // （它是一条给扮演模型的剧情口径说明，同装扮槽的待遇）

// 每次调用超时与排队闸硬上限（提案值）：闸的等待受「超时＋一次重试」约束，
// 硬上限兜底防扣住发送挂死——超界即按失败放行，迟到的结果照写注入槽（下一轮用）
const CALL_TIMEOUT_MS = 90_000;
const GATE_HARD_CAP_MS = 240_000;
const FAIL_STREAK_PAUSE = 3;
// 指导账本留存条数（第五十轮）：每层楼一条、按楼层号淘汰最旧——删楼/重做往前翻的原账上限；
// 更早的楼层重做时按「无原账」处理（裸跑），不报错
const GUIDE_LOG_KEEP = 100;

// ---------------------------------------------------------------------------
// 纯逻辑：档位文本（旋钮＝档位文本注入，判断点 4）
// ---------------------------------------------------------------------------

const STRICTNESS_LEVELS = {
    loose: { label: '宽', text: '动作方向与完成标准相符即算达成。' },
    standard: { label: '标准', text: '角色的连贯动作明显偏向完成标准即算达成，不要求做到十足。' },
    strict: { label: '严', text: '完成标准的关键动作实质发生才算达成，方向对但没做实不算。' },
};

const INTERVENE_UNIT = {
    low: { label: '低', text: '仅明显偏航或推进停滞时发指导。' },
    medium: { label: '中', text: '例行轻推，允许静默轮。' },
    high: { label: '高', text: '每轮都发指导（卡死轮除外）。' },
};

const INTERVENE_LIGHT = {
    // 2026-08-29 用户修订：轻量模式发现问题就发——输入成本反正已经花了，发现不说就白花；
    // 静默概念属于单位模式的节点推进（节点没到不用催），不允许压掉轻量模式的问题上报
    // 第五十四轮起四项检查（新增「复读 user 的话」——发现就发、无轻重档）
    low: { label: '低', text: '仅很轻微的发现（OOC 轻微、文风轻微）可不发；中等及以上 OOC、剧情重复、复读 user 的话、明显文风重复必须发。' },
    medium: { label: '中', text: '有任何发现就发修正指导，轻微也不例外；仅四项全部无发现时静默。' },
    high: { label: '高', text: '有任何发现就发修正指导；仅四项全部无发现时静默。' },
};

export function listenerCfg() {
    const c = settings.listener ??= {};
    c.enabled ??= false;
    c.depth ??= 2;
    c.role ??= 'system';   // 第五十八轮：指导注入身份——system（旁白口径）/ char（assistant 消息）
    c.strictness ??= 'standard';
    c.intervene ??= 'medium';
    c.traceRounds ??= 50;
    c.stuckWindow ??= 3;
    c.progressMin ??= 400;
    c.progressMax ??= 800;
    // 第三十七轮：世界书检索/记忆表/楼层数三样材料开关从全局设置搬进按聊天的双材料单
    // （state.matRoutine / state.matReentry，见 listenerState 迁移播种）——全局键不再在这里补默认
    if (!STRICTNESS_LEVELS[c.strictness]) c.strictness = 'standard';
    if (!INTERVENE_UNIT[c.intervene]) c.intervene = 'medium';
    if (c.role !== 'system' && c.role !== 'char') c.role = 'system';
    return c;
}

// 监听模型固定项（第四十九轮起＝设置页最底部「分处模型」区的「监听判定」档，原「监听」区
// 的下拉已撤）：该档选了方案 = 整套（地址/密钥/模型/格式）走它；空/方案不在 = 跟随当前
// 配置（主连接）。旧 settings.listener.providerId 由 settings.js 迁移带过来（显式选过的
// 方案 id 原样保留；旧默认「方案库第一条」语义废弃，未选过 = 主连接）
export function listenerProvider() {
    listenerCfg();
    const r = placeProvider('listener');
    if (r?.provider) return { name: r.name, fallback: false, provider: r.provider };
    return { name: settings.api.model ? `主连接 · ${settings.api.model}` : '（未配置）', fallback: true, provider: null };
}

// ---------------------------------------------------------------------------
// 纯逻辑：每聊天状态（chatdata 新增 listener 块，同 1.0 六块模式）
// ---------------------------------------------------------------------------

export function listenerState() {
    const state = loadChatData('listener', () => ({
        version: 1,
        unit: null,          // 当前挂载单位 { id, source:'manual'|'plan10', title, text, at, fromStoryId?, nodes:[{title,criterion,text}], nodeIdx }
        sidelined: null,     // 退位槽（一次一个）：挂入新单位被顶下来的旧单位，进度原样冻结等接回
        round: 0,            // 判定轮次计数
        trace: [],           // 留痕（最新在前，滚动清旧）
        failStreak: 0,       // 连续失败计数（L2 失联用）
        paused: false,       // L2 失联后暂停，等用户在面板恢复
        hold: false,         // 手动暂停推进（第五十三轮）：当前节点想停留时用户点「暂停推进」——方向指导
                             // 与暗牌停发、进度冻结（判定不再点亮），检查项（四查）照跑照修正；再点恢复。只对单位轮生效
        lastGuidance: '',    // 上一轮指导全文（防复读输入线 + 面板显示）
        guideVoidReason: '', // 非空＝上一轮指导已作废（卸下/换挂/接回/关总开关/切聊天）——注入槽已清、面板改显示作废行；下一轮落账清零
        lastFloorSig: '',    // 最后一轮已分析过的楼层签名（去重：滑动/重生成内容没变不重跑）
        loreStatus: {},      // 世界书条目三档状态（第四十三轮，按聊天存）：{ 'bookId:uid': 'off' 停用 |
                             // 'key' 关键词 | 'always' 常驻 }，缺省＝'key'。书的启用也在本聊天（chatdata
                             // 的 books 块）——两样都在监听页「世界书条目」窗里就地编辑。旧的 lorePicks
                             // 自选勾选已按「不迁移、直接作废」退役（常驻档顶替它的职责）
        matRoutine: null,    // 日常监听材料单（第三十七轮）{ scan, floors, scanFloors, memModes, memTags, memRecent }——
                             // 每轮例行判定（单位轮＋轻量轮）用；null 由下面的迁移播种补。
                             // scanFloors（第三十八轮）＝「世界书检索」按关键词激活的回看窗口，与正文楼层数分开
        matReentry: null,    // 重挂对账材料单（第三十七轮）——第四十三轮起只剩 { floors, memModes, memTags,
                             // memRecent, picks }：世界书＝纯手选（重挂单不上三按钮机制），自动检索整块撤掉
        dot: false,          // 红点旗标（有问题未看；打开监听页签即清除）
        dotReason: '',       // 红点问题的一句话描述
        guideLog: {},        // 指导账本（第五十轮）：{ '楼层号': { t: 指导全文, e: 血脉代号 } }——
                             // 每轮判定的产出记到「它塑造的那层楼」名下，删楼/滑动/重新生成重做那层时沿用原账；
                             // 静默轮与失败轮也记（t=''，当时注入的就是「没有指导」）
        guideEra: 0,         // 血脉代号（第五十轮）：单位槽换主人（挂/卸/接回/同 id 重挂）就 +1——
                             // 给前任写的旧指导不再作数；切聊天/关总开关不 +1（账仍历史为真）
        // lastFloorSeen（第五十轮）：楼层水位＝最近见过的最后一层角色楼号，删楼缩水的判定基准；不播种
        halt: null,          // 停进提示（2026-09-02 暂停收尾）：{ kind:'paused' 手动卸下长线章 |
                             // 'suspended' 回归判定偏大挂起, title, note, unitId, at }；null＝无。
                             // 出口：挂载/接回/mix 重挂（打碎混合）/手动撤下/偏大后重挂没偏自动解除
    }));
    state.unit = normalizeUnit(state.unit);
    state.sidelined = normalizeUnit(state.sidelined);
    if (!Array.isArray(state.trace)) state.trace = [];
    state.hold = Boolean(state.hold);   // 手动暂停推进（第五十三轮）：旧聊天块没有该键 → false（默认不暂停）
    state.halt = normalizeHalt(state.halt);
    // 指导账本形状收敛（第五十轮）：键＝正整数楼层号、值须带字符串 t；e 缺损归 0（旧账按第 0 代血脉算，不丢）
    state.guideEra = Number.isFinite(Number(state.guideEra)) ? Math.max(0, Math.floor(Number(state.guideEra))) : 0;
    if (!state.guideLog || typeof state.guideLog !== 'object' || Array.isArray(state.guideLog)) state.guideLog = {};
    else for (const k of Object.keys(state.guideLog)) {
        const v = state.guideLog[k];
        if (!v || typeof v !== 'object' || typeof v.t !== 'string' || !Number.isInteger(Number(k)) || Number(k) <= 0) delete state.guideLog[k];
        else v.e = Number.isFinite(Number(v.e)) ? Math.max(0, Math.floor(Number(v.e))) : 0;
    }
    if (!state.loreStatus || typeof state.loreStatus !== 'object' || Array.isArray(state.loreStatus)) state.loreStatus = {};
    else for (const k of Object.keys(state.loreStatus)) {
        if (!['off', 'key', 'always'].includes(state.loreStatus[k])) delete state.loreStatus[k];   // 三档之外的全剔（旧聊天块的 lorePicks 是数组、不是这里的账）
    }
    // 双材料单（第三十七轮，用户拍板「两套页面、范围相同、各自手动选」）：按聊天存、互不影响。
    // 旧全局开关只在第一次见到这个聊天块时播种一次——第一个迁移的聊天带走旧值，全局键随即
    // 删除（E14 残键纪律）；此后聊天的聊天块一落地就带这两份材料单，不再看全局
    if (!state.matRoutine) {
        const raw = settings.listener ?? {};
        const offAll = raw.withMemory === false
            ? Object.fromEntries((memoryState().mirror.sheets ?? []).map(s => [s.uid, 'off']))   // 全停用＝不带（新表后来默认常驻，与第 1 步同口径）
            : null;
        state.matRoutine = {
            scan: raw.withLorebook !== false,
            floors: Math.max(0, Math.round(Number(raw.floorLimit) || 0)),
            scanFloors: 0,   // 第三十八轮新字段：旧全局键没有「扫描窗口」这概念，播种 0＝全聊天（按对话里实际出现的关键词激活）
            memModes: offAll,
            memTags: [],
            memRecent: 0,
        };
        delete raw.withLorebook; delete raw.withMemory; delete raw.floorLimit;
        try { save(); } catch { /* 设置存不进不阻断判定 */ }
    }
    if (!state.matReentry) state.matReentry = { floors: 0, memModes: null, memTags: [], memRecent: 0, picks: [] };
    normalizeMatCfg(state.matRoutine, { scan: true, floors: 0, scanFloors: 0, memModes: null });
    normalizeMatCfg(state.matReentry, { floors: 0, memModes: null });
    delete state.matReentry.scan; delete state.matReentry.scanFloors;   // 第四十三轮：重挂单的检索开关与扫描窗口退役（残键纪律，旧数据作废）
    return state;
}

// 材料单形状收敛（第三十七轮）：就地修补不换对象——面板与引擎共用同一引用，就地改＋persist 才不丢。
// routine 版带 scan/scanFloors（世界书检索开关与关键词激活窗口），reentry 版不带（检索已撤）
const MEM_MODES = new Set(['off', 'tags', 'always']);
function normalizeMatCfg(r, seed) {
    if ('scan' in r) r.scan = typeof r.scan === 'boolean' ? r.scan : (seed.scan ?? true);
    if ('scanFloors' in r || seed.scanFloors !== undefined) r.scanFloors = Number.isFinite(Number(r.scanFloors)) && Number(r.scanFloors) > 0 ? Math.floor(Number(r.scanFloors)) : 0;   // 第三十八轮：关键词激活的回看窗口（0＝全聊天）
    r.floors = Number.isFinite(Number(r.floors)) && Number(r.floors) > 0 ? Math.floor(Number(r.floors)) : 0;
    if (!r.memModes || typeof r.memModes !== 'object' || Array.isArray(r.memModes)) r.memModes = seed.memModes;
    else for (const k of Object.keys(r.memModes)) if (!MEM_MODES.has(r.memModes[k])) delete r.memModes[k];
    if (!Array.isArray(r.memTags)) r.memTags = [];
    r.memRecent = Number.isFinite(Number(r.memRecent)) && Number(r.memRecent) > 0 ? Math.floor(Number(r.memRecent)) : 0;
    if ('picks' in r && !Array.isArray(r.picks)) r.picks = [];   // 只有重挂单带 picks（世界书纯手选）
    return r;
}

export function persistListener() {
    saveChatData('listener', listenerState());
}

// 停进提示的形状收敛（就地修补同款规矩）
function normalizeHalt(h) {
    if (!h || typeof h !== 'object' || !['paused', 'suspended'].includes(h.kind)) return null;
    return {
        kind: h.kind,
        title: String(h.title ?? '').slice(0, 120),
        note: String(h.note ?? '').slice(0, 300),
        unitId: String(h.unitId ?? ''),
        at: Number(h.at) || 0,
    };
}

// 挂起是否对当前单位生效（判定照跑、指导暂停注入的开关）：只有 suspended 一种会拦指导
export function haltSuspendActive(state, unit) {
    const h = state?.halt;
    return Boolean(h && h.kind === 'suspended' && unit && h.unitId && h.unitId === unit.id);
}

// 存档读回清洗：形状不对的 unit 整体作废（null 化），字段收敛到合法类型
function normalizeUnit(u) {
    if (!u || typeof u !== 'object') return null;
    const nodes = (Array.isArray(u.nodes) ? u.nodes : [])
        .filter(n => n && typeof n === 'object')
        .map(n => ({
            title: String(n.title ?? '').slice(0, 120) || '未命名节点',
            criterion: String(n.criterion ?? ''),
            text: String(n.text ?? ''),
        }));
    if (!nodes.length) return null;
    let idx = Number(u.nodeIdx);
    if (!Number.isInteger(idx) || idx < 0) idx = 0;
    if (idx > nodes.length) idx = nodes.length;
    return {
        id: String(u.id ?? newId('lu-')),
        source: ['plan10', 'longform'].includes(u.source) ? u.source : 'manual',
        title: String(u.title ?? '').slice(0, 120) || '未命名单位',
        text: String(u.text ?? ''),
        at: Number(u.at) || Date.now(),
        ...(u.fromStoryId ? { fromStoryId: String(u.fromStoryId) } : {}),
        ...(u.lfRef ? { lfRef: { vol: Number(u.lfRef.vol) || 0, ch: Number(u.lfRef.ch) || 0 } } : {}),
        nodes,
        nodeIdx: idx,
        // 锚层（第四十五轮）：各节点点亮时所在的角色楼楼层号（全聊天绝对号），删楼回退按它熄灭；
        // null/缺位＝第四十五轮之前的旧点亮，不因删楼熄灭。只留已点亮段
        litFloors: (Array.isArray(u.litFloors) ? u.litFloors : []).slice(0, idx).map(v => Number.isInteger(v) && v > 0 ? v : null),
    };
}

// ---------------------------------------------------------------------------
// 纯逻辑：单位构造与 1.0 规划节点化（判断点 13 提案 A：beats 行直接当节点，零新增提示词）
// ---------------------------------------------------------------------------

// 单节点单位构造（整个文本一块判）。监听页「手动导入」入口已随第三十九轮退役（不需要节点判定的
// 材料改走向导「转为隐身注入」）；本函数保留作测试台/内部造单位用，不再有产品界面入口
export function makeUnitFromText(title, text) {
    const full = String(text ?? '').trim();
    return normalizeUnit({
        id: newId('lu-'),
        source: 'manual',
        title: String(title ?? '').trim() || '手动导入单位',
        text: full,
        at: Date.now(),
        nodes: [{ title: '单位整体', criterion: '单位全文所安排的剧情实际发生（角色行动偏向该安排即算达成）', text: '' }],
        nodeIdx: 0,
    });
}

// 1.0 剧情规划的 planText 里 beats 排版行「N. [阶段名] 内容」逐行解析成节点；
// 一行都解析不出（用户手改成自由文本）就整份当单节点。完成标准 = 该阶段安排实际发生（提案 A 口径）
export function nodesFromPlanText(planText) {
    const re = /^\d+[.、]\s*\[([^\]]*)\]\s*(.+)$/;
    const nodes = [];
    for (const raw of String(planText ?? '').split('\n')) {
        const m = raw.trim().match(re);
        if (m) nodes.push({ title: m[1].trim() || `阶段${nodes.length + 1}`, criterion: '该阶段安排的剧情在楼层里实际发生（角色行动偏向该安排即算达成）', text: m[2].trim() });
    }
    if (nodes.length) return nodes;
    return [{ title: '规划整体', criterion: '整份规划所安排的剧情实际发生（偏向即算达成）', text: '' }];
}

export function makeUnitFromStory(entry) {
    const planText = String(entry?.planText ?? '').trim();
    if (!planText) return null;
    return normalizeUnit({
        id: newId('lu-'),
        source: 'plan10',
        title: String(entry?.summary ?? '').trim().slice(0, 60) || '1.0 剧情规划',
        text: planText,
        at: Date.now(),
        ...(entry?.id ? { fromStoryId: String(entry.id) } : {}),
        nodes: nodesFromPlanText(planText),
        nodeIdx: 0,
    });
}

// 指导作废（第三十二轮）：单位槽换主人／监听关停／切聊天时调用——
// 旧指导是为主人变动前的下一轮写的，留着会照样注入、照样挂在面板上；作废后下一轮判定重新生成
function voidGuidance(state, reason) {
    state.lastGuidance = '';   // 防复读输入线一并断掉：旧措辞对新单位/新模式没有参照意义（同失败轮口径）
    state.guideVoidReason = String(reason ?? '').slice(0, 60) || '单位变动';
}

// 血脉换代（第五十轮）：单位槽换主人那刻起，账本里给前任写的指导不再作数（还原时 era 对不上即弃）。
// 只在挂/卸/接回/同 id 重挂四处调用；切聊天与关总开关不换代——槽清了、账仍历史为真，
// 回本聊天后删楼重做旧楼层照样沿用当时的原账
function bumpGuideEra(state) {
    state.guideEra = (Number(state.guideEra) || 0) + 1;
}

// 挂载的唯一规则（判断点 14 提案：被顶下来的单位进退位槽，进度账不动）：
// 槽里已有单位且退位槽也占着 → 拒绝挂载（先去面板接回或丢弃），不让数据静默蒸发
export function mountUnit(state, unit) {
    if (!unit) return { ok: false, reason: '单位内容为空' };
    // 同一单位再挂（长线章卸下重挂／挂载中重挂换新文本）：不造重复副本——
    // 退位槽里的旧副本作废（进度账在长线账本里、新副本自带），活动槽就地换新、不进退位槽
    if (state.sidelined && state.sidelined.id === unit.id) state.sidelined = null;
    if (state.unit && state.unit.id === unit.id) {
        state.unit = unit;
        state.lastFloorSig = '';
        voidGuidance(state, '重挂同一单位');   // 文本可能改过：旧指导按过期处理
        bumpGuideEra(state);   // 血脉换代（第五十轮）：改过文本的单位重做旧楼层时不沿用改挂前的旧账
        return { ok: true };
    }
    if (state.unit && state.sidelined) {
        return { ok: false, reason: '退位槽已有单位：先「接回」或「丢弃」它，再挂载新单位' };
    }
    if (state.unit) {
        state.sidelined = state.unit;   // 自动退位：进度原样冻结（nodeIdx 等全保留）
    }
    state.unit = unit;
    state.lastFloorSig = '';   // 新单位立即按当前楼层重判一轮
    voidGuidance(state, '挂载新单位');
    bumpGuideEra(state);
    return { ok: true };
}

// 接回退位单位：当前活动单位换进退位槽（同样受「槽只一个」约束）
export function recallSidelined(state) {
    if (!state.sidelined) return { ok: false, reason: '退位槽是空的' };
    if (state.unit) {
        const back = state.sidelined;
        state.sidelined = state.unit;
        state.unit = back;
    } else {
        state.unit = state.sidelined;
        state.sidelined = null;
    }
    state.lastFloorSig = '';
    voidGuidance(state, '接回退位单位');
    bumpGuideEra(state);
    return { ok: true };
}

// 卸下当前单位 → 进退位槽（槽被占则拒绝，先处理退位槽）；真正删除走丢弃
export function unmountUnit(state) {
    if (!state.unit) return { ok: false, reason: '当前没有挂载单位' };
    if (state.sidelined) return { ok: false, reason: '退位槽已有单位：先「接回」或「丢弃」它' };
    state.sidelined = state.unit;
    state.unit = null;
    voidGuidance(state, '卸下单位');   // 卸下后按轻量口径执勤：单位指导绝不留到下一轮注入
    bumpGuideEra(state);
    return { ok: true };
}

export function discardSidelined(state) {
    if (!state.sidelined) return { ok: false, reason: '退位槽是空的' };
    state.sidelined = null;
    return { ok: true };
}

// ---------------------------------------------------------------------------
// 纯逻辑：楼层收集与格式化（全部未隐藏楼层带楼层号；楼层号只数角色回复，与全插件口径一致）
// 楼层号口径（第五十七轮）＝全聊天绝对号：非空角色楼按出现顺序占号，「对 AI 隐藏」的楼层
// 照样占号但不显示正文（藏在哪层号就空在哪）；空楼不占号。此前隐藏楼不占号＝相对号——
// 藏一批头部楼层后全体楼号前移、锚层账与水位全部错位，轮首对账把「还在只是藏了」当删楼
// 熄灭节点（用户实测藏楼后节点回退到最开始）。绝对号下藏/取消隐藏不动任何号，删楼才缩号。
// ---------------------------------------------------------------------------

export function collectFloorsFromChat(chat) {
    if (!Array.isArray(chat)) return [];
    const out = [];
    let floor = 0;
    for (const m of chat) {
        const hidden = m?.is_system === true;   // 「对 AI 隐藏」的楼层：不进输入；角色楼照样占号（绝对号）
        if (m?.is_user) {
            const text = String(m?.mes ?? '');
            if (text && !hidden) out.push({ floor: null, name: '{{user}}', isUser: true, text });
        } else {
            const text = String(m?.mes ?? '');
            if (text) floor++;   // 空楼不进输入也不占号；隐藏楼占号不显示（模型按可见楼层引证，号有跳空属正常）
            if (text && !hidden) out.push({ floor, name: String(m?.name ?? '角色'), isUser: false, text });
        }
    }
    return out;
}

// 现存非空角色楼总数（含隐藏楼；第五十七轮）＝现存最大楼层号。删楼判别基准：
// 「楼层还在只是被隐藏」总数不变，真删楼总数才缩水——对账回退用它，不再被藏楼误触发
export function roleFloorCeil(chat) {
    if (!Array.isArray(chat)) return 0;
    let n = 0;
    for (const m of chat) if (m && m.is_user !== true && String(m.mes ?? '') !== '') n++;
    return n;
}

export function formatFloors(list) {
    return list.map(m => m.isUser
        ? `（用户·不计楼层）${m.name}: ${m.text}`
        : `[楼层${m.floor}] ${m.name}: ${m.text}`).join('\n\n');
}

// 最后一楼签名：可见楼数（含用户楼，第五十七轮——藏/取消隐藏用户楼也要能触发重判）＋最后一条角色楼
// 内容指纹。滑动/重生成内容没变 → 签名不变 → 不重跑
export function floorsSignature(chat) {
    const list = collectFloorsFromChat(chat);
    const last = [...list].reverse().find(m => !m.isUser);
    if (!last) return '';
    let h = 5381;
    for (let i = 0; i < last.text.length; i++) h = ((h << 5) + h + last.text.charCodeAt(i)) >>> 0;
    return `${list.length}:${h.toString(16)}`;
}

// 列表里最后一个带楼层号的角色楼（楼层号为全聊天绝对号）；没有角色楼＝0。
// 锚层口径（第四十五轮）：节点点亮锚在「点亮那一轮的最后一层角色楼」上
export function lastRoleFloor(list) {
    for (let i = list.length - 1; i >= 0; i--) if (list[i]?.floor != null) return list[i].floor;
    return 0;
}

// ---------------------------------------------------------------------------
// 纯逻辑：两套提示词组装（每次调用自包含；上一轮指导只用于防复读）
// ---------------------------------------------------------------------------

// 两套提示词的块序＝前缀缓存口径（第二十七轮立、第三十四/三十五轮两次修正、第四十六轮纠偏）：
// 监听每轮都跑、提示词前缀跨轮复用是监听成本的大头。稳定块（说明/单位全文/世界书自选/**记忆表格**/
// 判定规则/输出契约）全部前置；楼层之后只留小块——**节点状态**（第四十六轮挪来）、上一轮指导、
// 检索命中。第四十六轮纠偏：节点状态原先放楼层前面，归类成「推进时才变＝近似稳定」——分类错了，
// 它变的频率虽低（一章推进十来次），但它一变、后面整段楼层全价重付（用户实测口径：一章 50 层楼
// 12 个节点＝楼层块整段全价重算约 12 次，楼层越滚越大、平方级烧钱）；挪到楼层后面后楼层整段常吃
// 缓存，节点状态块（几百字）落进本来就每轮重算的尾部区，判定对象紧贴楼层末尾读、注意力不亏。
// **记忆表格按「大而少变」归稳定段（第三十五轮用户拍桌：「谁告诉你记忆表是小块？我记忆表 4 万
// 多字」——排在楼层后面会每轮跟着丢缓存整块全价；代价＝记忆插件写入新行的那一轮楼层跟着全价
// 一次，写入频率远低于楼层追加，两头取轻）。若把楼层挪到指导/检索后面绝对垫底，同样整段楼层
// 每轮重算——缓存吃满的最优解＝大块材料全部在前、其后只留真正的小块。
// 世界书拆两半发（第三十四轮立、第四十三轮改口径）：**常驻档**（监听页三按钮设为「常驻」的
// 条目）整条不截断、进稳定段；**关键词档**按最近楼层重扫逐轮变，照旧垫底——两档来自同一次
// statusMap 扫描、天然不重复（常驻档在扫描结果里 constant 标记为 true）
export function buildUnitPrompt({ cfg, unit, floorsText, picksText = '', floorsNote, memoryText = '', loreHits = '', lastGuidance }) {
    const strict = STRICTNESS_LEVELS[cfg.strictness] ?? STRICTNESS_LEVELS.standard;
    const inter = INTERVENE_UNIT[cfg.intervene] ?? INTERVENE_UNIT.medium;
    const node = unit.nodes[Math.min(unit.nodeIdx, unit.nodes.length - 1)];
    const next = unit.nodes[unit.nodeIdx + 1]?.title ?? '（已是本单位最后一个节点）';
    const lit = unit.nodes.slice(0, unit.nodeIdx).map(n => n.title).join('、') || '（暂无）';
    const last = String(lastGuidance ?? '').trim() || '（无——本轮是第一轮）';
    return [
        { role: 'system', content: '你是剧情监听器，在一场正在进行的长篇角色扮演里执勤。每一轮扮演模型输出后，你对照当前剧情单位判定进度，并为下一轮生成一段微量指导。你不是剧情作者——剧情已经规划好了，你只负责让它按计划自然生长。你不与任何人对话，你的全部输出是一个 JSON 对象。' },
        { role: 'user', content: [
            '【剧情单位说明】',
            '- 「最小剧情单位」＝当前正在执行的规划文本，内含若干「节点」；每个节点带可逐条对照的完成标准。',
            `- 「楼层」＝一条角色回复（用户消息不计楼层）。一层楼的有效剧情推进约 ${cfg.progressMin}-${cfg.progressMax} 字，按区间综合衡量，不做逐字换算。`,
            '',
            '【材料】',
            '<当前剧情单位全文>',
            String(unit.text ?? ''),
            '</当前剧情单位全文>',
            '',
            '<世界书常驻条目（用户在监听页设为「常驻」的条目；整条原文、不截断）>',
            picksText || '（未设常驻——角色设定等对照材料以监听页「世界书条目」窗里设为常驻的为准，没有就按单位全文与楼层判定）',
            '</世界书常驻条目>',
            '',
            '<记忆表格（既有事件记录；判定推进与重复时参考）>',
            memoryText || '（无）',
            '</记忆表格>',
            '',
            '【判定任务】',
            '对「当前待判节点」（见下方【当前节点状态】）给出三态之一：',
            '- achieved：本轮角色的连贯动作已偏向该节点的完成标准（口径：偏向即达成，不要求做到十足）；',
            '- not_yet：尚未达成——剧情仍在朝它走、或本轮存在有效对话、或属刻意慢节奏；',
            `- stuck：卡死——连续约 ${cfg.stuckWindow} 轮既无节点推进也无有效对话，且能排除刻意慢节奏与脱离角色的元对话。`,
            '规则：',
            '1. 作证铁律：判定必须引用具体楼层号与该楼原文片段，不许凭感觉。achieved 与 stuck 至少各给一条证据；not_yet 尽量给（说明现状离标准差在哪）。',
            '2. 边缘回合：',
            '   - 戏中戏/梦境/玩笑里的「假装完成」不算 achieved——用楼层原文区分真推进与表演；',
            '   - 用户发的脱离角色元对话（OOC）不是推进也不是卡死，在 watch 里标注即可，不要据此改判；',
            '   - 刻意慢节奏（有意铺垫、日常呼吸感）的回合没有任何节点推进是正确结果，判 not_yet，严禁报 stuck。',
            '',
            `【达成判定松紧】（当前档：${strict.label}）`,
            strict.text,
            '',
            '【指导生成】',
            '判定完成后，为下一轮生成微量指导：',
            '- 结构＝一句目标句（把剧情引向当前待判节点）＋动作提示（点出可做而未做的动作方向）＋角色暗牌（见下条，没有可留空）。',
            '- 下一节点的方向要提前种：当前节点接近收尾、或本轮对话自然抛出了指向下一节点的选择或话题（如 user 问角色想去哪里、接下来做什么——这正是把剧情引向下一节点的机会），指导就按下一节点的标题方向引——让角色生出与它相关的念头、提议或倾向（例：下一节点标题是「动物园」，可让角色说出想去看看熊猫），使剧情在节点到来前就自然走向它，而不是等节点点亮才突然转向。',
            '- 但只种方向、不预演内容：具体情节由节点点亮后正式登场；若单位全文里已写了下一节点的安排，种的方向要与其一致，但指导里不得替它预演具体事件、场景或台词；下一节点之后的节点仍然只字不提。',
            '- 角色暗牌要随指导同行（第五十一轮）：从单位全文提炼「此刻角色心里已定、已知、楼层里还没说出口的事」——她定好的行程或答案、她的准备与小算盘、她玩牌时自己手里有什么牌与盘算、她藏起来待兑现的计划或玩笑。优先给马上要被用到的：user 一句「想好去哪了吗」「你出什么牌」马上就要落地，扮演模型手里没有这张牌就只能临场另编、把既定安排编歪。单位全文没写她知道的，不许替她编；暗牌随指导一起给，不发指导的轮次自然也没有暗牌。',
            '- 暗牌的边界：暗牌＝她已知的事实，不是将要发生的情节——后续节点怎么演、结局类信息何时揭晓，仍然不给；兑现还远的远期牌只给「她心里有数」级（例：单位写了她备了礼物——可给「她备了东西、藏着」；礼物是什么、何时送不给，等那个节点轮到自己）。',
            '- 长度不设上限：一轮里多角色且各有负责内容时，该写多长写多长，宁详勿简。',
            '- 每轮重新生成：措辞必须随已推进内容变化，不得复读上一轮指导（哪怕意思相近也要换说法）。',
            '- 措辞用指令式：写「下一拍做什么」，不写「她可以做什么」的建议腔；暗牌写成「她知道什么、被问到时会怎么接」，不写成事件预告。',
            '- 两条红线：不得剧透——将要发生的情节不给：下一节点只允许种标题方向、严禁预演其具体情节，下一节点之后的节点严禁编造或暗示（角色暗牌里「她已知的事实」不算剧透，按暗牌条放行）；不得催促抢跑——引导，不驱赶。',
            '- 意思模板（仅示意含义，措辞自定）：目标句如「让两人的对话自然滑向摊牌的边缘」；动作提示如「下一拍她把手里的牌扣在桌上、起身去倒水」；暗牌如「这趟约会她心里定好的是动物园猫科区——user 问去哪时她多半卖关子，不临场另编目的地」。',
            `   介入强度（当前档：${inter.label}）决定发的勤度：${inter.text} 决定不发时必须给原因。`,
            '',
            '【检查任务】（四项，随判定同行——判定基准与轻量执勤／1.0 剧情检查一致）',
            '1. OOC——只判角色（char）自身的问题：用户（user）在对话里明确指示、纠正或要求改变走向时（包括括号指令与作者式安排），角色照做不算 OOC，用户指示优先于人设与既有走向；只有用户没有指示、角色自行脱离人设/事实/关系/世界观时才判，evidence 引用具体楼层号与原文。',
            '2. 剧情重复——同一剧情线的自然延续不算重复；只有把已完结、已发生并被交代过的情节当作新剧情原样重演，或复刻已有桥段的流程，才判重复。',
            '3. 文风重复——只针对角色（char）的扮演文本：先检查用户近期输入是否自己在重复动作、场景或指令，角色跟进不算；只有用户没有重复而角色自发重复描写套路、桥段或句式时，才判轻微/明显，note 写明用户是否先重复、角色重复了什么。',
            '4. 复读 user 的话——只判角色（char）把用户（user）当轮或近期说过的话复述进自己的回复文本：整句或大段原样复读、把 user 的原话嵌进旁白或对白再说一遍、逐条重述 user 刚提到的内容都算；角色正常回应接话、只引用其中一两个词展开、为剧情转述给第三方不算，user 一次说多件事、角色逐件处理也不算。note 引被复读的原句片段与楼层号。',
            '- 这四项与 watch 分开：watch 标边缘情况（用户元对话、慢热、假装完成），四项检查只看角色扮演文本的质量问题；四项每轮都报（无发现就 found=false／level=无、items 空），发现不写进 goal/action_hint——修正由系统按门槛另行拼装。',
            '- 发现必须带可执行的修正：fix 写成「下一拍怎么改」的直接指令——文风重复写换什么句式／开头／结构（例：「下一拍起改用动作直入或对白起句，停用『从……的位置』式介词开头」），剧情重复写往哪个新走向带，OOC 写拉回哪条人设事实。禁止只复述现象（「高频使用某句式」是现象不是修正）、禁止「避免重复」「注意多样性」式口号；给不出具体改法的项不判（found=false／level=无）。',
            '',
            '【输出】',
            '只输出一个 JSON 对象，不输出任何其他文字：',
            '{',
            '  "judgment": "achieved | not_yet | stuck",',
            '  "evidence": [{"floor": 楼层号, "quote": "该楼原文片段", "note": "为什么这段能作证"}],',
            '  "progress_note": "本轮实际推进了什么，一两句",',
            '  "guidance": {"goal": "目标句", "action_hint": "动作提示", "hidden": "角色暗牌：她此刻已知、还没说出口的事；没有则空字符串"},',
            '  "no_guidance_reason": "不发指导时的原因；发了则留空字符串",',
            '  "ooc": { "found": true/false, "items": [{ "aspect": "性格|事实|关系|世界观|口吻", "evidence": "具体楼层与原文依据", "severity": "轻微|中等|严重", "fix": "修正建议：下一拍怎么改的直接指令" }] },',
            '  "plot_repeat": { "found": true/false, "note": "重演/复刻之处；没有则空字符串", "fix": "下一拍往哪个新走向带（直接指令）；没有发现则空字符串" },',
            '  "style_repeat": { "level": "无|轻微|明显", "note": "仅判角色自发重复：用户是否先重复、角色重复了什么", "fix": "下一拍换什么句式/开头/结构（直接指令）；level=无则空字符串" },',
            '  "user_echo": { "found": true/false, "note": "复读了 user 哪些话（引原句片段与楼层号）；没有则空字符串", "fix": "下一拍怎么改：删掉复读、直接以角色的反应接住这句话（直接指令）；没有发现则空字符串" },',
            '  "watch": {"ooc": true/false, "slow_burn": true/false, "fake_completion": true/false, "notes": "边缘情况备注，无则空字符串"}',
            '}',
            '说明：evidence 至少 1 条、不设上限；guidance 在卡死或按介入档决定静默时整段留空（goal、action_hint 与 hidden 均空字符串）并在 no_guidance_reason 写明原因；四项检查每轮都报，无发现时 found=false／level=无、items 空数组。',
            '字符串值里不要出现英文双引号（引用一律写中文「」），也不要在值内换行。',
            '',
            `<剧情上下文（${floorsNote ?? '当前聊天全部未隐藏楼层'}，带楼层号；新楼层追加在本节末尾）>`,
            floorsText,
            '</剧情上下文>',
            '',
            '【当前节点状态】（判定的对照对象）',
            `- 当前待判节点：${node.title}——完成标准：${node.criterion}${node.text ? `\n  节点内容：${node.text}` : ''}`,
            `- 下一节点标题：${next}——当前节点收尾时按它把握方向；对话抛出指向它的选择或话题（如 user 问接下来去哪、做什么）时，按标题方向提前种下念头或提议（只种方向，具体情节等节点点亮后登场）。`,
            `- 本章已点亮节点：${lit}——不得再指导模型重复演绎这些节点的内容。`,
            '',
            '<上一轮指导（仅供避免复读，不是模板）>',
            last,
            '</上一轮指导>',
            '',
            '<世界书检索命中（「关键词」档条目按最近楼层重扫，逐轮可能变化；「常驻」档条目在上方材料块、不在这里）>',
            loreHits || '（无）',
            '</世界书检索命中>',
        ].join('\n') },
    ];
}

export function buildLightPrompt({ cfg, floorsText, picksText = '', floorsNote, memoryText = '', loreHits = '', lastGuidance }) {
    const inter = INTERVENE_LIGHT[cfg.intervene] ?? INTERVENE_LIGHT.medium;
    const last = String(lastGuidance ?? '').trim() || '（无——本轮是第一轮）';
    return [
        { role: 'system', content: '你是剧情监听器（轻量执勤模式）。当前这场角色扮演没有挂载剧情规划，你只做两件事：逐轮检查对话质量，发现问题时为下一轮生成一段修正指导。你不是剧情作者；你不与任何人对话，你的全部输出是一个 JSON 对象。' },
        { role: 'user', content: [
            '【说明】',
            '- 「楼层」＝一条角色回复（用户消息不计楼层）。',
            '- 修正指导只影响扮演模型下一轮的写法，不改变既有人设、事实与关系。',
            '',
            '【检查任务】（四项，判定基准与 1.0 剧情检查一致）',
            '1. OOC——只判角色（char）自身的问题：用户（user）在对话里明确指示、纠正或要求改变走向时（包括括号指令与作者式安排），角色照做不算 OOC，用户指示优先于人设与既有走向；只有用户没有指示、角色自行脱离人设/事实/关系/世界观时才判，evidence 引用具体楼层号与原文。',
            '2. 剧情重复——同一剧情线的自然延续不算重复；只有把已完结、已发生并被交代过的情节当作新剧情原样重演，或复刻已有桥段的流程，才判重复。',
            '3. 文风重复——只针对角色（char）的扮演文本：先检查用户近期输入是否自己在重复动作、场景或指令，角色跟进不算；只有用户没有重复而角色自发重复描写套路、桥段或句式时，才判轻微/明显，note 写明用户是否先重复、角色重复了什么。',
            '4. 复读 user 的话——只判角色（char）把用户（user）当轮或近期说过的话复述进自己的回复文本：整句或大段原样复读、把 user 的原话嵌进旁白或对白再说一遍、逐条重述 user 刚提到的内容都算；角色正常回应接话、只引用其中一两个词展开、为剧情转述给第三方不算，user 一次说多件事、角色逐件处理也不算。note 引被复读的原句片段与楼层号。',
            '- 发现必须带可执行的修正：fix 写成「下一拍怎么改」的直接指令——文风重复写换什么句式／开头／结构（例：「下一拍起改用动作直入或对白起句，停用『从……的位置』式介词开头」），剧情重复写往哪个新走向带，OOC 写拉回哪条人设事实。禁止只复述现象（「高频使用某句式」是现象不是修正）、禁止「避免重复」「注意多样性」式口号；给不出具体改法的项不判（found=false／level=无）。',
            '',
            '【修正指导】',
            '- 四项检查有任何发现时，生成一段修正指导：开头用指令句点明本轮必须改正什么（是硬性要求不是建议，如「本轮起不再把 user 的原话复述进回复」），再给目标句＋动作提示（如拉回人设的事实依据、绕开重复的新走法）；长度不设上限、宁详勿简；措辞每轮变化、不复读上一轮修正指导。',
            '- 四项全部无发现时，不发指导——no_guidance_reason 写一两句本轮质量印象（例：「节奏稳定、人设无漂移；第 12 楼起略有原地打转苗头，暂不需干预」），禁用「均无发现」「一切正常」这类空话。正常轮次静默是这个模式的常态，不是异常。',
            '',
            `【介入强度】（当前档：${inter.label}）`,
            inter.text,
            '',
            '【输出】',
            '只输出一个 JSON 对象，不输出任何其他文字：',
            '{',
            '  "ooc": { "found": true/false, "items": [{ "aspect": "性格|事实|关系|世界观|口吻", "evidence": "具体楼层与原文依据", "severity": "轻微|中等|严重", "fix": "修正建议：下一拍怎么改的直接指令" }] },',
            '  "plot_repeat": { "found": true/false, "note": "重演/复刻之处；没有则空字符串", "fix": "下一拍往哪个新走向带（直接指令）；没有发现则空字符串" },',
            '  "style_repeat": { "level": "无|轻微|明显", "note": "仅判角色自发重复：用户是否先重复、角色重复了什么", "fix": "下一拍换什么句式/开头/结构（直接指令）；level=无则空字符串" },',
            '  "user_echo": { "found": true/false, "note": "复读了 user 哪些话（引原句片段与楼层号）；没有则空字符串", "fix": "下一拍怎么改：删掉复读、直接以角色的反应接住这句话（直接指令）；没有发现则空字符串" },',
            '  "guidance": { "goal": "目标句", "action_hint": "动作提示" },',
            '  "no_guidance_reason": "不发指导时的原因；发了则留空字符串"',
            '}',
            '说明：字符串值里不要出现英文双引号（引用一律写中文「」），也不要在值内换行。',
            '',
            '【材料】',
            '<世界书常驻条目（用户在监听页设为「常驻」的条目；整条原文、不截断）>',
            picksText || '（未设常驻——没有点名材料就按楼层原文直接检查）',
            '</世界书常驻条目>',
            '',
            '<记忆表格（既有事件记录；检查剧情重复时参考）>',
            memoryText || '（无）',
            '</记忆表格>',
            '',
            `<剧情上下文（${floorsNote ?? '当前聊天全部未隐藏楼层'}，带楼层号；新楼层追加在本节末尾）>`,
            floorsText,
            '</剧情上下文>',
            '',
            '<上一轮修正指导（仅供避免复读，不是模板）>',
            last,
            '</上一轮修正指导>',
            '',
            '<世界书检索命中（「关键词」档条目按最近楼层重扫，逐轮可能变化；「常驻」档条目在上方材料块、不在这里）>',
            loreHits || '（无）',
            '</世界书检索命中>',
        ].join('\n') },
    ];
}

// ---------------------------------------------------------------------------
// 纯逻辑：回归判定（第三十三轮）——重挂有进度的长线章时补一次对账报告
// ---------------------------------------------------------------------------

// 材料与例行判定同一套基底（全/限楼层＋世界书手选＋记忆表），窗口＝五章规划轨迹。
// 第四十三轮：重挂单撤自动检索（用户拍板「手动够用」）——世界书只带重挂单手选的条目。
// 只出报告不出指导：后两章的规划在窗口里，任何「指导」都可能把后续剧情漏进扮演模型——回归判定
// 的产物给用户看，注入槽一概不碰（旧作废标记也留着，等下一轮例行判定重新生成指导）
export function buildReentryPrompt({ unit, windowLabel, windowText, floorsText, picksText = '', floorsNote, memoryText = '' }) {
    const lit = unit.nodeIdx;
    return [
        { role: 'system', content: '你是剧情监听器，在一场正在进行的长篇角色扮演里执勤。这一次是「回归判定」：当前这章规划此前执行到一半被卸下、期间剧情继续演了；现在它重新挂载，你对照规划补一份判定报告，回答两件事——剧情走到哪了、偏没偏。你不与任何人对话，你的全部输出是一个 JSON 对象。' },
        { role: 'user', content: [
            '【说明】',
            '- 「楼层」＝一条角色回复（用户消息不计楼层）。',
            '- 「回归判定」只出报告给用户看：不生成给扮演模型的指导、不注入任何内容。',
            '',
            '【材料】',
            `<五章规划窗口（${windowLabel}）>`,
            windowText,
            '</五章规划窗口>',
            '',
            '<世界书条目（用户在重挂单手选随行的材料；整条原文、不截断）>',
            picksText || '（未勾选——没有点名材料就按窗口与楼层判定）',
            '</世界书条目>',
            '',
            '<记忆表格（既有事件记录；判定走到哪与偏没偏时参考）>',
            memoryText || '（无）',
            '</记忆表格>',
            '',
            '【任务一：走到哪了】',
            '对照「当前挂载章」的节点表（见窗口内），按聊天实际重新核对全部节点：',
            `- 挂载时账面已点亮前 ${lit} 个节点；请独立重判——实际达成数可能多于账面（卸下期间剧情继续走），也可能持平。`,
            '- reached＝实际已达成的节点总数（0 到全部）；节点按序推进，报第 K 个达成即默认前 K-1 个也已达成。',
            '- 「达成」口径与例行判定一致：角色的连贯动作偏向该节点完成标准即算，不要求做到十足；戏中戏/梦境/玩笑里的「假装完成」不算。',
            '- 你认定为已达成的每个节点至少给一条楼层作证（楼层号＋该楼原文片段）。',
            '',
            '【任务二：偏没偏】',
            '对照五章窗口的规划轨迹（前面的章＝已规划的来路、后面的章＝已规划的去路），判定当前剧情的偏离程度三选一：',
            '- on_track：没偏——剧情仍在规划轨迹上自然生长；',
            '- minor：偏了但能自然拉回——走岔的内容可以由后续剧情自然衔接回轨迹；',
            '- major：偏大了——走岔的内容与规划轨迹冲突，继续演下去会损坏后续章节的安排。',
            'note 写明偏在哪（对照哪一章哪一段的安排）；至少一条楼层作证；判 on_track 时 note 给一句现状描述、evidence 可为空数组。',
            '',
            '【输出】',
            '只输出一个 JSON 对象，不输出任何其他文字：',
            '{',
            '  "progress": { "reached": 数值, "evidence": [{"floor": 楼层号, "quote": "该楼原文片段", "note": "作证哪个节点"}] },',
            '  "deviation": { "level": "on_track | minor | major", "note": "偏离情况描述", "evidence": [{"floor": 楼层号, "quote": "该楼原文片段", "note": "为什么这段能作证"}] },',
            '  "summary": "给用户的一段大白话总结（两三句）：走到哪了、偏没偏、要不要处理",',
            '}',
            '说明：progress 的 evidence 至少 1 条、不设上限；字符串值里不要出现英文双引号（引用一律写中文「」），也不要在值内换行。',
            '',
            `<剧情上下文（${floorsNote ?? '当前聊天全部未隐藏楼层'}，带楼层号）>`,
            floorsText,
            '</剧情上下文>',
        ].join('\n') },
    ];
}

// ---------------------------------------------------------------------------
// 纯逻辑：输出契约规约（模型输出不可信，字段全部收敛到合法形状；违契约抛错走 L1）
// ---------------------------------------------------------------------------

// 检查项解析（第五十二轮起两套模式共用；第五十四轮起四项）：OOC 逐条（维度/依据/轻重/修正建议）＋剧情重复＋文风重复＋复读 user 的话，
// 形状收敛与轻量旧解析逐字段同款；found=false 时 items 也保留（次级观察要进留痕，found 仍是介入闸唯一依据）
function parseFindings(obj) {
    const o = (obj.ooc && typeof obj.ooc === 'object') ? obj.ooc : {};
    const items = (Array.isArray(o.items) ? o.items : []).map(it => (it && typeof it === 'object' ? it : {})).map(it => ({
        aspect: String(it.aspect ?? '').slice(0, 40),
        evidence: String(it.evidence ?? '').slice(0, 300),
        severity: ['轻微', '中等', '严重'].includes(it.severity) ? it.severity : '中等',
        fix: String(it.fix ?? '').slice(0, 300),
    }));
    const p = (obj.plot_repeat && typeof obj.plot_repeat === 'object') ? obj.plot_repeat : {};
    const s = (obj.style_repeat && typeof obj.style_repeat === 'object') ? obj.style_repeat : {};
    const e = (obj.user_echo && typeof obj.user_echo === 'object') ? obj.user_echo : {};
    return {
        ooc: { found: Boolean(o.found) && items.length > 0, items },
        // fix（第五十三轮）＝「下一拍怎么改」的可执行指令：拼装优先用 fix，旧输出没有该字段回落 note
        plotRepeat: { found: Boolean(p.found), note: String(p.note ?? '').slice(0, 300), fix: String(p.fix ?? '').slice(0, 300) },
        styleRepeat: { level: ['无', '轻微', '明显'].includes(s.level) ? s.level : '无', note: String(s.note ?? '').slice(0, 300), fix: String(s.fix ?? '').slice(0, 300) },
        // 复读 user 的话（第五十四轮，用户开工令「角色重复 user 的话就输出指导制止」）：无轻重档，found＝发现与否
        userEcho: { found: Boolean(e.found), note: String(e.note ?? '').slice(0, 300), fix: String(e.fix ?? '').slice(0, 300) },
    };
}

export function normalizeUnitJudgment(obj) {
    if (!obj || typeof obj !== 'object') throw new Error('输出不是一个 JSON 对象');
    const j = String(obj.judgment ?? '').trim().toLowerCase();
    if (!['achieved', 'not_yet', 'stuck'].includes(j)) throw new Error(`judgment 非法：「${String(obj.judgment ?? '').slice(0, 40)}」`);
    const evidence = (Array.isArray(obj.evidence) ? obj.evidence : []).map(e => (e && typeof e === 'object' ? e : {})).map(e => ({
        floor: Number.isFinite(Number(e.floor)) && Number(e.floor) > 0 ? Math.floor(Number(e.floor)) : null,
        quote: String(e.quote ?? '').slice(0, 300),
        note: String(e.note ?? '').slice(0, 300),
    }));
    if ((j === 'achieved' || j === 'stuck') && !evidence.some(e => e.quote)) {
        throw new Error('作证铁律未满足：achieved/stuck 至少要有一条带引文的证据');
    }
    const g = (obj.guidance && typeof obj.guidance === 'object') ? obj.guidance : {};
    const goal = String(g.goal ?? '').trim();
    const actionHint = String(g.action_hint ?? '').trim();
    const hidden = String(g.hidden ?? '').replace(/\s+/g, ' ').trim();   // 角色暗牌（第五十一轮）：随指导同行的已知信息
    const noReason = String(obj.no_guidance_reason ?? '').trim();
    if (!goal && !noReason) throw new Error('既没有指导也没有静默原因（静默轮必须留痕原因）');
    const w = (obj.watch && typeof obj.watch === 'object') ? obj.watch : {};
    const findings = parseFindings(obj);   // 三查（第五十二轮）：随单位判定同行，报告进面板折叠区、达门槛的发现并进指导
    return {
        judgment: j,
        evidence,
        progressNote: String(obj.progress_note ?? '').slice(0, 300),
        goal,
        actionHint,
        hidden,
        noGuidanceReason: noReason,
        findings,
        watch: {
            ooc: Boolean(w.ooc),
            slowBurn: Boolean(w.slow_burn),
            fakeCompletion: Boolean(w.fake_completion),
            notes: String(w.notes ?? '').slice(0, 300),
        },
    };
}

export function normalizeLightReport(obj) {
    if (!obj || typeof obj !== 'object') throw new Error('输出不是一个 JSON 对象');
    const findings = parseFindings(obj);
    const g = (obj.guidance && typeof obj.guidance === 'object') ? obj.guidance : {};
    const goal = String(g.goal ?? '').trim();
    const actionHint = String(g.action_hint ?? '').trim();
    const noReason = String(obj.no_guidance_reason ?? '').trim();
    if (!goal && !noReason) throw new Error('既没有修正指导也没有静默原因（静默轮必须留痕原因）');
    return {
        // found=false 时 items 也保留：模型给的次级观察要进留痕显示，不丢（found 仍是介入闸的唯一依据）
        ooc: findings.ooc,
        plotRepeat: findings.plotRepeat,
        styleRepeat: findings.styleRepeat,
        userEcho: findings.userEcho,   // 复读 user 的话（第五十四轮）：与单位模式共用 parseFindings
        goal,
        actionHint,
        noGuidanceReason: noReason,
    };
}

// 轻量介入档闸（判断点 8，2026-08-29 用户修订：发现就该发，只有很轻微的可不发）
export function lightShouldIntervene(r, level) {
    const sev = r.ooc.found ? Math.max(...r.ooc.items.map(it => ({ '轻微': 1, '中等': 2, '严重': 3 }[it.severity] ?? 2))) : 0;
    const style = { '无': 0, '轻微': 1, '明显': 2 }[r.styleRepeat.level] ?? 0;
    const plot = r.plotRepeat.found ? 2 : 0;   // 剧情重复没有轻重档，按中等权重计
    // 复读 user 的话（第五十四轮，用户口径「发现就输出指导」）：无轻重档、按中等权重计——低/中/高三档全过闸
    const echo = r.userEcho?.found ? 2 : 0;
    const worst = Math.max(sev, style, plot, echo);
    if (level === 'low') return worst >= 2;    // 仅很轻微的发现（OOC／文风轻微）不发；剧情重复、复读、中等及以上都发
    if (level === 'medium') return worst >= 1; // 有任何发现就发（轻微也发）
    return worst > 0;                          // high：与中同——档位差异体现在单位模式的发送频率
}

// 三查修正段（第五十二轮，用户开工令「把轻量模式的判断也塞到单位模式里」）：单位轮的三查发现达到
// 轻量同款介入门槛（lightShouldIntervene＋同一枚「介入」旋钮）时，机械拼装成修正段并进指导——
// 哪怕节点方向静默也照发（偏离不严重只出报告不干预、够严重全程自动化，都是用户原话定的口径）。
// 拼装走机械路线不走模型改写：发现与修正建议模型已经在三查字段里给了，转述一道只会加软口径风险。
export function findingsFixText(r, level) {
    if (!r || typeof r !== 'object' || !lightShouldIntervene(r, level)) return '';
    const clean = v => String(v ?? '').replace(/\s+/g, ' ').trim();
    const lines = [];
    for (const it of (r.ooc?.found ? r.ooc.items : [])) {
        lines.push(`OOC·${clean(it.aspect) || '问题'}·${it.severity}——${clean(it.fix) || clean(it.evidence)}`);
    }
    // 剧情/文风的行文优先用 fix（第五十三轮用户实测反馈「只报现象没有任何指导性」）：fix 是模型按硬口径
    // 写的「下一拍怎么改」；旧输出没有 fix 字段时回落 note（note 只描述现象，拼出来没有修正力）
    if (r.plotRepeat?.found) lines.push(`剧情重复——${clean(r.plotRepeat.fix) || clean(r.plotRepeat.note)}`);
    if (r.styleRepeat && r.styleRepeat.level !== '无') lines.push(`文风重复·${r.styleRepeat.level}——${clean(r.styleRepeat.fix) || clean(r.styleRepeat.note)}`);
    // 复读行（第五十四轮立、第五十五轮硬化）：自带禁令句——「接住 user 发言＝回应不是复述」要对冲
    // 注入尾令的「先接住」（扮演模型容易把「接住」读成「复述一遍」，正是这个毛病的来源）
    if (r.userEcho?.found) lines.push(`复读 user 的话——严禁把 user 说过的原话或近义重述写进回复；接住 user 的发言用角色的反应（回应/反问/行动），不是复述。改法：${clean(r.userEcho.fix) || clean(r.userEcho.note)}`);
    if (!lines.length) return '';
    // 注入端硬化（第五十五轮，用户点名「约束力不够」——参照第五十一轮素条教训：只有内容没有令、
    // 扮演模型看一眼就过）：硬头声明「必须改正、不是参考」＋逐条编号（指令清单相）＋段尾落地令
    const numbered = lines.map((l, i) => `${i + 1}. ${l}`);
    return `【检查修正】下列发现本轮必须改正（这是硬性要求，不是氛围参考）：\n${numbered.join('\n')}\n——被点名的行为本轮不得再出现，修正后的写法从本轮扮演文本就落地。`;
}

// 回归判定契约（第三十三轮）：reached 与 level 是硬字段（错值即违契约，走 L1 重试），
// 其余字段宽容收敛——报告是给人看的，措辞残缺不致命
export function normalizeReentryReport(obj, unit) {
    if (!obj || typeof obj !== 'object') throw new Error('输出不是一个 JSON 对象');
    const total = unit.nodes.length;
    const reachedRaw = Number(obj?.progress?.reached);
    if (!Number.isFinite(reachedRaw) || reachedRaw < 0 || reachedRaw > total) {
        throw new Error(`progress.reached 非法（合法范围 0-${total}）：「${String(obj?.progress?.reached ?? '').slice(0, 40)}」`);
    }
    const level = String(obj?.deviation?.level ?? '').trim();
    if (!['on_track', 'minor', 'major'].includes(level)) {
        throw new Error(`deviation.level 非法：「${String(obj?.deviation?.level ?? '').slice(0, 40)}」`);
    }
    const evs = arr => (Array.isArray(arr) ? arr : [])
        .filter(e => e && typeof e === 'object')
        .map(e => ({
            floor: Number.isFinite(Number(e.floor)) && Number(e.floor) > 0 ? Math.floor(Number(e.floor)) : null,
            quote: String(e.quote ?? '').slice(0, 300),
            note: String(e.note ?? '').slice(0, 300),
        }));
    return {
        reached: Math.round(reachedRaw),
        progressEvidence: evs(obj?.progress?.evidence),
        deviationLevel: level,
        deviationNote: String(obj?.deviation?.note ?? '').slice(0, 300),
        deviationEvidence: evs(obj?.deviation?.evidence),
        summary: String(obj?.summary ?? '').slice(0, 400),
    };
}

// ---------------------------------------------------------------------------
// 纯逻辑：判定结果落账（进度账只在这里点亮——监听判定是正路；失败路径绝不碰它）
// ---------------------------------------------------------------------------

export function guidanceText(goal, actionHint, hidden = '') {
    const segs = [goal, actionHint].filter(Boolean).map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
    // 角色暗牌段（第五十一轮）：拼进注入/账本/面板共用的指导文本；括注是给扮演模型的使用守则（防主动抖牌）
    const h = String(hidden ?? '').replace(/\s+/g, ' ').trim();
    if (h) segs.push(`【角色已知】${h}（角色心里有数、还没说出口的事：不主动抖出来，被问到或时机到了才用）`);
    return segs.join('\n');
}

export function applyUnitOutcome(state, report, meta) {
    let litFloor = null;
    // meta.hold（第五十三轮手动暂停推进）：判定如实记（judgment 原样落账），但点亮被冻结——
    // 用户暂停期间模型判 achieved 也不推进，恢复后下一轮判定自然点亮
    if (report.judgment === 'achieved' && !meta.hold && state.unit && state.unit.nodeIdx < state.unit.nodes.length) {
        // 锚层（第四十五轮）：点亮时记下本轮最后一层角色楼，删楼回退按锚点熄灭；0＝异常楼层态→无锚不回退
        litFloor = Math.max(1, Number(meta.lastFloor) || 0) || null;
        if (!Array.isArray(state.unit.litFloors)) state.unit.litFloors = [];   // 直接调用方（测试台）可能手工造单位
        state.unit.litFloors[state.unit.nodeIdx] = litFloor;
        state.unit.nodeIdx += 1;   // 点亮当前节点（进度账唯一自动写点）
    }
    state.round = meta.round;
    state.lastGuidance = meta.guidance;
    state.guideVoidReason = '';   // 新一轮落账：作废标记解除（哪怕本轮静默，静默状态也是新轮的）
    state.failStreak = 0;
    state.lastFloorSig = meta.floorSig;
    const rec = {
        at: meta.at,
        round: meta.round,
        mode: 'unit',
        // 来源标签（2026-09-02 留痕三来源）：挂载的是长线章＝长线剧情；1.0 规划/手动＝普通剧情规划。
        // 轻量轮（applyLightOutcome）不带标签——没有挂规划时的例行检查不属于三来源
        src: state.unit?.source === 'longform' ? 'longform' : 'plan',
        floors: meta.floorCount,
        ok: true,
        judgment: report.judgment,
        litNode: report.judgment === 'achieved' && !meta.hold ? state.unit?.nodes[Math.max(0, state.unit.nodeIdx - 1)]?.title ?? '' : '',
        litFloor,
        evidence: report.evidence,
        progressNote: report.progressNote,
        watch: report.watch,
        // 三查报告（第五十二轮）：随判定落账——留痕卡一行小结、面板「检查报告」折叠区看最近一轮明细
        ...(report.findings ? { findings: report.findings } : {}),
        guidance: meta.guidance,
        noGuidanceReason: report.goal ? '' : report.noGuidanceReason,
        suspended: Boolean(meta.suspended),   // 偏大挂起轮（2026-09-02）：判定与进度账照跑、指导没注入
        hold: Boolean(meta.hold),             // 手动暂停推进轮（第五十三轮）：方向停发、点亮冻结，检查项照跑
        retried: Boolean(meta.retried),
        ...(meta.tokens ? { tokens: meta.tokens } : {}),
        ...(meta.materials ? { materials: meta.materials } : {}),
    };
    state.trace.unshift(rec);
    // 红点口径：卡死要人拍板、watch 抓到 OOC/假完成值得看一眼。暂停推进轮不亮卡死红点——
    // 无推进是用户自己冻的（第五十三轮），不是剧情卡死
    if (report.judgment === 'stuck' && !meta.hold) {
        state.dot = true;
        state.dotReason = `第${meta.round}轮判定卡死（连续无推进无有效对话），需要你人工拍板`;
    } else if (report.watch.ooc || report.watch.fakeCompletion) {
        state.dot = true;
        state.dotReason = `第${meta.round}轮 watch 标记：${[report.watch.ooc ? 'OOC 元对话' : '', report.watch.fakeCompletion ? '疑似假装完成' : ''].filter(Boolean).join('、')}`;
    }
    return rec;
}

export function applyLightOutcome(state, report, meta) {
    state.round = meta.round;
    state.lastGuidance = meta.guidance;
    state.guideVoidReason = '';   // 新一轮落账：作废标记解除
    state.failStreak = 0;
    state.lastFloorSig = meta.floorSig;
    const rec = {
        at: meta.at,
        round: meta.round,
        mode: 'light',
        floors: meta.floorCount,
        ok: true,
        findings: {
            ooc: report.ooc,
            plotRepeat: report.plotRepeat,
            styleRepeat: report.styleRepeat,
            userEcho: report.userEcho,   // 复读 user 的话（第五十四轮）
        },
        guidance: meta.guidance,
        // 以实际发没发为准：介入档拦下的轮次留原因（页内静默轮要显示全文）
        noGuidanceReason: meta.guidance ? '' : report.noGuidanceReason,
        retried: Boolean(meta.retried),
        ...(meta.tokens ? { tokens: meta.tokens } : {}),
        ...(meta.materials ? { materials: meta.materials } : {}),
    };
    state.trace.unshift(rec);
    const hasFinding = report.ooc.found || report.plotRepeat.found || report.styleRepeat.level !== '无' || report.userEcho?.found;
    if (hasFinding) {
        state.dot = true;
        state.dotReason = `第${meta.round}轮轻量检查有发现：${[
            report.ooc.found ? `OOC×${report.ooc.items.length}` : '',
            report.plotRepeat.found ? '剧情重复' : '',
            report.styleRepeat.level !== '无' ? `文风重复（${report.styleRepeat.level}）` : '',
            report.userEcho?.found ? '复读 user 的话' : '',
        ].filter(Boolean).join('、')}`;
    }
    return rec;
}

// 回归判定落账（第三十三轮）：不走例行轮的任何一笔——不加轮次、不碰指导线与作废标记、
// 不清失败计数；节点批量补点亮（只进不退）；偏大了才亮红点（要人拍板的事才打扰）
export function applyReentryOutcome(state, report, meta) {
    const before = state.unit?.nodeIdx ?? 0;
    const applied = Math.max(before, report.reached);
    // 锚层（第四十五轮，可驳默认）：批量补点亮的节点统一锚定回归判定那轮的最后一层角色楼——
    // 不逐节点解析证据楼层（自由文本 notes 不可靠），删楼时这批节点随顶层锚点一起回退
    const anchorFloor = Math.max(1, Number(meta.lastFloor) || 0) || null;
    if (state.unit) {
        if (!Array.isArray(state.unit.litFloors)) state.unit.litFloors = [];   // 直接调用方（测试台）可能手工造单位
        for (let i = before; i < applied; i++) state.unit.litFloors[i] = anchorFloor;
        state.unit.nodeIdx = Math.min(applied, state.unit.nodes.length);
    }
    const rec = {
        at: meta.at,
        round: state.round,          // 信息性显示：回归判定不是楼层轮，不推进轮次计数
        mode: 'reentry',
        src: 'longform',             // 回归判定只发生在长线章重挂（2026-09-02 留痕来源标签）
        ok: true,
        reentry: {
            window: meta.windowLabel,
            before,
            reached: report.reached,
            applied,
            nodesTotal: state.unit?.nodes.length ?? 0,
            anchorFloor,
            deviation: report.deviationLevel,
            deviationNote: report.deviationNote,
            summary: report.summary,
            evidence: [...report.progressEvidence, ...report.deviationEvidence].slice(0, 10),
        },
        ...(meta.tokens ? { tokens: meta.tokens } : {}),
        ...(meta.materials ? { materials: meta.materials } : {}),
    };
    state.trace.unshift(rec);
    if (report.deviationLevel === 'major') {
        state.dot = true;
        state.dotReason = `回归判定：剧情偏大了——${report.deviationNote.slice(0, 120)}`;
        // 偏大挂起（2026-09-02 用户拍板「偏大了以后就等我来处理，挂在那里不要动」）：
        // 判定与进度账照跑，指导暂停注入（挂起轮写空串）、停进提示进独立槽拦着别硬拉回。
        // 处置出口：打碎混合（mix 重挂）/ 手动标记达成 / 卸下；重挂后没偏或能拉回自动解除
        state.halt = {
            kind: 'suspended',
            title: state.unit?.title ?? '',
            note: String(report.deviationNote ?? '').slice(0, 300),
            unitId: state.unit?.id ?? '',
            at: Date.now(),
        };
    } else if (state.halt?.kind === 'suspended') {
        state.halt = null;   // 没偏／能自然拉回：挂起自动解除（停进提示同步撤，见调用方 syncHaltSlot）
    }
    return rec;
}

export function applyFailure(state, meta) {
    state.round = meta.round;
    state.failStreak += 1;
    state.lastFloorSig = '';   // 失败轮不锁签名：下一事件还允许重试同一楼
    state.lastGuidance = '';   // 绝不复用过期指导：失败即清空输入线
    state.guideVoidReason = '';   // 失败轮有自己的显示口径（留痕 ok:false），不吃作废行
    const rec = {
        at: meta.at,
        round: meta.round,
        mode: meta.mode,
        src: meta.src ?? null,   // 失败轮的来源标签随它本该成功的轮（2026-09-02）
        floors: meta.floorCount,
        ok: false,
        error: String(meta.error ?? '').slice(0, 400),
    };
    state.trace.unshift(rec);
    state.dot = true;
    state.dotReason = `第${meta.round}轮监听失败：${rec.error.slice(0, 120)}`;
    let pausedNow = false;
    if (state.failStreak >= FAIL_STREAK_PAUSE && !state.paused) {
        state.paused = true;   // L2 失联：暂停等用户处理，恢复按钮在监听页签
        pausedNow = true;
    }
    return { rec, pausedNow };
}

// 外部写入留痕的统一出口（2026-09-02 换装留痕走它）：unshift＋滚动封顶＋落盘。
// 换装的留痕与判定轮共用同一个滚动池（traceRounds 管）、同一张留痕面板
export function pushTraceRecord(rec) {
    const state = listenerState();
    state.trace.unshift(rec);
    const capped = Math.max(1, Math.floor(Number(listenerCfg().traceRounds) || 50));
    if (state.trace.length > capped) state.trace.length = capped;
    persistListener();
}

// ---------------------------------------------------------------------------
// 纯逻辑：指导账本（第五十轮，用户拍板「删到哪一层/重新生成就沿用那一轮原来的指导」）——
// 每轮判定的产物记到「它塑造的那层楼」名下（= 本轮最后一层角色楼 + 1）；删楼缩水或
// 滑动/重新生成重做某层时，按楼层号取回原账沿用。判定轮本身照跑（节点点亮进度与
// R45「重新演出会再次点亮」口径一致），换的只是重做那次生成注入的指导
// ---------------------------------------------------------------------------

// 记账：静默轮与失败轮也记（t=''——当时注入的就是「没有指导」，重做同样沿用）；
// 封顶留最近 GUIDE_LOG_KEEP 条、按楼层号淘汰最旧
export function recordGuide(state, targetFloor, text) {
    if (!Number.isInteger(targetFloor) || targetFloor <= 0) return;
    if (!state.guideLog || typeof state.guideLog !== 'object' || Array.isArray(state.guideLog)) state.guideLog = {};
    state.guideLog[String(targetFloor)] = { t: String(text ?? ''), e: Number(state.guideEra) || 0 };
    const keys = Object.keys(state.guideLog).map(Number).sort((a, b) => a - b);
    if (keys.length > GUIDE_LOG_KEEP) for (const k of keys.slice(0, keys.length - GUIDE_LOG_KEEP)) delete state.guideLog[String(k)];
}

// 取账：楼层号对上且血脉（era）没换过才给；undefined＝无账可用（没记过/超出留存/单位已换主人）
export function guideEntryFor(state, floor) {
    const e = state?.guideLog?.[String(floor)];
    if (!e || typeof e !== 'object' || typeof e.t !== 'string') return undefined;
    if ((Number(e.e) || 0) !== (Number(state.guideEra) || 0)) return undefined;
    return e.t;
}

// ---------------------------------------------------------------------------
// 纯逻辑：排队闸状态机（判断点 9/10：等待有界；失败/超界一律放行，绝不挂死发送）
// click 由宿主注入（真实环境点 #send_but；测试台注入记录器）
// ---------------------------------------------------------------------------

export function createSendGate({ hardCapMs = GATE_HARD_CAP_MS, click = () => {}, onHold = () => {}, onRelease = () => {} } = {}) {
    let roundActive = false;
    let pending = false;
    let timer = null;
    const clearTimer = () => { if (timer) { clearTimeout(timer); timer = null; } };
    const fireClick = () => { fireClick.busy = true; try { click(); } finally { fireClick.busy = false; } };

    return {
        // 捕获阶段调：返回 true = 扣下这条发送（宿主随即 preventDefault）
        intercept() {
            if (fireClick.busy) return false;   // 放行点击是我们自己发起的
            if (!roundActive) return false;
            if (!pending) {
                pending = true;
                onHold();
                clearTimer();
                timer = setTimeout(() => {
                    timer = null;
                    if (!pending) return;
                    pending = false;
                    onRelease('timeout');
                    fireClick();   // 超界放行：没有指导也照常发送
                }, hardCapMs);
            } else {
                onHold();   // 扣住期间又按了一次：继续扣（内容以输入框为准，放行时一次带走）
            }
            return true;
        },
        beginRound() { roundActive = true; },
        endRound() {
            roundActive = false;
            clearTimer();
            if (!pending) return;
            pending = false;
            onRelease('settled');
            fireClick();   // 指导已写槽（或已按失败处理）：放行，体感＝输入与指导一起走
        },
        // 切聊天等场景：丢弃扣住的发送（不点击——点了会发进新聊天）
        abort() {
            roundActive = false;
            clearTimer();
            if (pending) { pending = false; onRelease('aborted'); }
        },
        state: () => ({ roundActive, pending }),
    };
}

// ---------------------------------------------------------------------------
// 宿主接线：引擎循环
// ---------------------------------------------------------------------------

let running = false;          // 一轮未结束不叠新一轮
let gate = null;              // 排队闸（initListener 装配）
let analyzeTimer = null;      // 事件去抖
let reconTimer = null;        // 删楼对账去抖（连删多楼时合并成一次）
let holdToastShown = false;   // 扣发送提示一轮只弹一次
let lastPromptText = '';      // 最近一次判定（例行轮或回归判定）实际发出的提示词全文——只在内存留最近一份，
                              // 全文随楼层数线性膨胀，进存档会把聊天文件撑翻倍；面板「看提示词全文」读它

export function lastListenerPrompt() {
    return lastPromptText;
}

// 注入框（第五十一轮 2A）：素条加头尾——头声明这是剧情指导（扮演模型此前拿到的是光秃两句话、
// 常被当氛围参考），尾教它先接住 user 最新发言再落回方向。账本/留痕/面板存的是不带框的裸文本，
// 框只在写注入槽这一刻加——删楼/重做还原走同一条 writeSlot，天然只包一层。
// 第五十五轮（用户点名「复读/文风重复约束力不够」）：带【检查修正】段的轮换专用尾令——原尾令
// 「先接住」对复读惯性的扮演模型是诱发语（「接住」被读成「复述一遍」），修正轮把「接住＝回应、
// 不是复述」说死。按文本内容选尾令是确定性的：同一裸文本永远包同一层框，还原路径一字不差不破。
const GUIDE_HEAD = '【剧情指导·本轮】';
// 第五十八轮（用户拍板「先照着四尝试改一下」）：普通轮尾令硬化——原「再自然落回方向」没有期限，
// 扮演模型接住 user 的临时提议后整轮顺着跑也不算违约（用户实测「旁边有酒店」插入事件后丢失主线）。
// 改法＝把「插入事件」与「改道」说死：接住后本轮内必须回到方向；只有 user 明确要求改变剧情走向
// 才算改道（逃逸口不能省——判定标准里「用户明确指示」本就最高优先，指导不能凌驾于用户之上）。
// 「先接住」三字保留：R55 查实的复读诱发是修正轮的「接住」措辞，普通轮的「先接住」没背过案底。
const GUIDE_TAIL = '——本轮扮演按上述方向走；user 最新发言先接住，再落回上述方向。他的临时提议是插入事件：接住后本轮内回到方向，不得整轮顺着它跑；只有他明确要求改变剧情走向时才改道。';
const GUIDE_FIX_TAIL = '——user 最新发言先用角色的反应接住（回应、反问或行动，不复述他的原话），再按上述修正与方向走；被点名的行为本轮不得再出现。';

let lastSlotRaw = '';   // 最近一次写槽的裸文本（内存级）——设置页改注入深度/身份后可立即按新口径重写原文本

function writeSlot(text) {
    const cfg = listenerCfg();
    const d = Number(cfg.depth);
    const raw = String(text ?? '').trim();
    lastSlotRaw = raw;
    const tail = raw.includes('【检查修正】') ? GUIDE_FIX_TAIL : GUIDE_TAIL;
    const t = raw ? `${GUIDE_HEAD}\n${raw}\n${tail}` : '';   // 静默/作废轮写空串，不注入空框
    const role = cfg.role === 'char' ? ROLE_CHAR : ROLE_SYSTEM;   // 身份选项只管指导槽；停进提示恒系统
    setExtensionPrompt(SLOT_KEY, t, POSITION_IN_CHAT, Number.isFinite(d) && d >= 0 ? Math.floor(d) : 2, false, role);
}

// 设置页改「注入深度/注入身份」后的即时生效口：按新配置重写当前槽内容（裸文本原样、只换框外参数；
// 页面刷新后 lastSlotRaw 为空串——写空等于清空本就空的槽，下一轮判定照常滚动覆写）
export function refreshListenerSlot() {
    writeSlot(lastSlotRaw);
}

export function clearListenerSlot() {
    setExtensionPrompt(SLOT_KEY, '', POSITION_IN_CHAT, 2, false, ROLE_SYSTEM);
}

// ---------------------------------------------------------------------------
// 停进提示（2026-09-02 暂停收尾，用户拍板「撤下长线剧情时给模型发一段提示词、
// 让它不要继续推进当前剧情防止走歪」）：独立注入槽，深度与指导槽相同。两种来源——
// 手动卸下长线章（paused：章进了退位槽、剧情口径上「这条线暂停了」）与回归判定偏大
// （suspended：章还挂着，但指导暂停注入、口径上「别硬拉回规划」）。出口统一走 clearListenerHalt：
// 挂载/接回/mix 重挂（打碎混合是偏离处置出口）、面板手动撤下、偏大后重挂没偏自动解除
// ---------------------------------------------------------------------------

export function haltHintText(h) {
    if (!h) return '';
    return h.kind === 'paused'
        ? `此前挂载的长线剧情「${h.title}」已暂停。后续回复不要再推进该剧情线既定安排的内容：不要主动推进其中尚未发生的关键事件、不要替它收尾、也不要直接跳到后续阶段；已发生的部分照常有效。当前没有这条线的新指导——按对话现状自然回应，等待新的安排。`
        : `当前长线剧情「${h.title}」与实际走向的偏离较大，规划已挂起等待用户处理。后续回复不要强行把剧情拉回该章的既定安排、也不要刻意推进其后续节点；按对话现状自然演绎即可。`;
}

function haltSlotText(h) {
    return `[长线${h?.kind === 'paused' ? '暂停' : '偏离挂起'}｜后台提示] ${haltHintText(h)}`;
}

function haltDepth() {
    const d = Number(listenerCfg().depth);
    return Number.isFinite(d) && d >= 0 ? Math.floor(d) : 2;
}

export function syncHaltSlot() {
    const h = listenerState().halt;
    if (h) setExtensionPrompt(HALT_KEY, haltSlotText(h), POSITION_IN_CHAT, haltDepth(), false, ROLE_SYSTEM);
    else setExtensionPrompt(HALT_KEY, '', POSITION_IN_CHAT, 2, false, ROLE_SYSTEM);
}

// 内部写点：直接改 state.halt（纯逻辑区）＋由调用方负责 persist 与 syncHaltSlot
function setHalt(kind, { title = '', note = '', unitId = '' } = {}) {
    const state = listenerState();
    state.halt = { kind, title: String(title ?? '').slice(0, 120), note: String(note ?? '').slice(0, 300), unitId: String(unitId ?? ''), at: Date.now() };
    return state;
}

// 面板「撤下停进提示」按钮的出口（也是一切手动清提示的公共出口）
export function clearListenerHalt() {
    const state = listenerState();
    if (!state.halt) return false;
    state.halt = null;
    persistListener();
    syncHaltSlot();
    notifyPanel();
    return true;
}

function modeOf(state) {
    if (state.unit && state.unit.nodeIdx < state.unit.nodes.length) return 'unit';
    return 'light';   // 无单位，或单位已演完等手动接续
}

// 世界书手选（重挂单专用，第四十三轮收窄——例行轮的自选已被三按钮常驻档顶替）：复用第七轮
// §6.10 的 resolveLorePicks——勾选即点名，不看关键词/常驻/启用状态，整条原文不截断
function assembleLorePicks(picksArr) {
    const picks = resolveLorePicks(Array.isArray(picksArr) ? picksArr : []);
    if (!picks.length) return { text: '', count: 0, chars: 0 };
    const text = picks.map(p => `【${p.book.name} / ${p.entry.comment}】\n${p.entry.content}`).join('\n\n');
    return { text, count: picks.length, chars: text.length };
}

// 例行轮的世界书材料（第四十三轮重构；「监听没接按聊天书单」那个 bug 的结构性修复就在这行
// enabledIds——此前 scanLorebooks 没传书单、落回全局启用）：一次 statusMap 扫描拆两档——
// **常驻档**（三按钮设为「常驻」）整条原文进稳定段；**关键词档**命中进每轮重扫的垫底块
// （buildLoreContext 拼装）。书的大门＝本聊天的书单；条目状态按聊天存（state.loreStatus，
// 缺省＝'key'）。「世界书检索」开关只管关键词档——关掉＝常驻照带、关键词命中整块不带
// （常驻跟状态走不受开关管，同旧自选语义）
function assembleLoreRoutine(state, scanText) {
    const scan = state.matRoutine.scan !== false;
    const hits = scanLorebooks(scanText, { enabledIds: chatEnabledBookIds(), statusMap: state.loreStatus });
    const always = hits.filter(h => h.constant);
    const keyed = scan ? hits.filter(h => !h.constant) : [];
    const alwaysText = always.map(h => `【${h.bookName} / ${h.comment}】\n${h.content}`).join('\n\n');
    return {
        alwaysText,
        alwaysCount: always.length,
        alwaysChars: alwaysText.length,
        hitsText: keyed.length ? buildLoreContext(keyed) : '',
        hitsCount: keyed.length,
    };
}

// 楼层范围（第三十四轮）：limit > 0 时只带最近 limit 层角色楼——其间夹的用户消息一并保留
// （拦腰砍会丢上下文），楼层号仍是全聊天绝对号（判定引证不受影响）。返回原数组或尾段切片
export function limitFloors(list, limit) {
    if (!Number.isFinite(limit) || limit <= 0) return list;
    const charIdx = [];
    (Array.isArray(list) ? list : []).forEach((m, i) => { if (m && !m.isUser) charIdx.push(i); });
    if (charIdx.length <= limit) return list;
    return list.slice(charIdx[charIdx.length - limit]);
}

// 记忆表（第三十五轮归位稳定段；第三十七轮接进第 1 步挑选器）：大而少变——体量可以到几万字
// （用户实测 4 万+）、变化只随记忆更新不随轮次，排楼层后面会每轮跟着丢缓存整块全价。
// 挑选口径＝向导第 1 步同一套参数（用户定则：一切提示词材料都在全量版本上做减法、一套机器，
// 不做每板块单独算法）——memModes 档位/memTags 标签/memRecent 表尾最新行；全停用返回空串、
// 块标签兜底（无）；不传参数＝全量（老口径）
function assembleMemory(mat) {
    if (!mat) return '';
    return buildMemoryContext({ tagFilter: Array.isArray(mat.memTags) ? mat.memTags : null, sheetModes: mat.memModes ?? null, latestPerSheet: mat.memRecent ?? 0 }) ?? '';
}

async function listenerAttempt(messages, provider, onUsage) {
    let lastErr = null;
    for (let i = 0; i < 2; i++) {   // 超时/网络层失败重试一次（提案值；HTTP 业务错误也一并重试）
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), CALL_TIMEOUT_MS);
        try {
            // 第十七轮分家：监听恒传 thinkingOff:true——固定关思考、不吃设置页「关闭思考」总开关。
            // 监听每轮都跑、开了思考成本会爆炸；规划等生成侧继续跟总开关，两侧互不牵连
            return await chatCompletion({ messages, provider, signal: ctl.signal, onUsage, thinkingOff: true });
        } catch (err) {
            lastErr = err;
            if (err?.name === 'AbortError') err.message = `监听调用超时（${CALL_TIMEOUT_MS / 1000} 秒）`;
        } finally {
            clearTimeout(timer);
        }
    }
    throw lastErr;
}

/**
 * 跑一轮监听。宿主事件（楼层落地/编辑）与面板「立即判定一轮」都走这里；
 * 引擎内部自锁（running），外层不需要再防抖。
 */
export async function runListenerRound({ manual = false } = {}) {
    const cfg = listenerCfg();
    if (!cfg.enabled) return { skipped: 'disabled' };
    const state = listenerState();
    if (state.paused) return { skipped: 'paused' };
    const ctx = getTavernContext();
    const chat = Array.isArray(ctx.chat) ? ctx.chat : null;
    if (!chat || !chat.length) return { skipped: 'no-chat' };   // chatdata 就绪窗口坑：ctx.chat 未载完不硬跑
    runLitReconcile();   // 轮首兜底对账（第四十五轮）：删楼事件万一没接住（升级中途删楼等），判定前先把账对齐
    if (running) return { skipped: 'busy' };
    running = true;
    gate?.beginRound();
    holdToastShown = false;

    const mode = modeOf(state);
    const roundOwnerId = state.unit?.id ?? null;   // 本轮的主人：判完时单位槽若已换人（挂/卸/接回），产物整体作废
    const roundSrc = mode === 'unit' ? (state.unit?.source === 'longform' ? 'longform' : 'plan') : null;   // 失败留痕的来源标签（2026-09-02）
    const floorSig = floorsSignature(chat);
    const allFloors = collectFloorsFromChat(chat);
    const lastFloor = lastRoleFloor(allFloors);   // 锚层：本轮最后一层角色楼（点亮锚在这上面）
    const nextFloor = roleFloorCeil(chat) + 1;   // 下一层将生成的楼层号（第五十七轮）：隐藏楼仍在数组、新楼排其后——指导账记它名下（藏尾楼时 lastFloor+1 会记错楼）
    syncGuideLineForJudgment(state, lastFloor);   // 判定输入线校正（第五十轮）：有删楼没接住时「上一轮指导」按原账换线
    state.lastFloorSeen = lastFloor;              // 楼层水位（第五十轮）：删楼缩水的判定基准，正常轮随抬
    const floors = limitFloors(allFloors, Number(state.matRoutine.floors) || 0);   // 日常监听材料单（第三十七轮）：成功与失败留痕同一个口径
    const round = state.round + 1;
    const at = Date.now();
    const tokens = { promptTokens: 0, completionTokens: 0 };
    const onUsage = u => {
        tokens.promptTokens += u?.prompt_tokens ?? u?.promptTokens ?? 0;
        tokens.completionTokens += u?.completion_tokens ?? u?.completionTokens ?? 0;
    };
    const { provider } = listenerProvider();

    try {
        let messages;
        const floorsText = formatFloors(floors);
        const floorsNote = state.matRoutine.floors > 0 ? `最近 ${state.matRoutine.floors} 层角色楼（楼层号为全聊天绝对号；被隐藏的楼层保留楼层号但不显示正文，号有跳空属正常）` : undefined;
        // 关键词激活窗口（第三十八轮，用户拍板「单独一个楼层数、与正文的分开」）：扫描文本与正文窗口
        // 各裁各的——正文楼层数只管「剧情上下文」带几层，「世界书检索」往回看几层归 scanFloors（0＝全聊天）
        const scanText = formatFloors(limitFloors(allFloors, Number(state.matRoutine.scanFloors) || 0));
        const lore = assembleLoreRoutine(state, scanText);   // 常驻档进稳定段、关键词档命中进垫底块（第四十三轮）
        const memoryText = assembleMemory(state.matRoutine);
        if (mode === 'unit') {
            messages = buildUnitPrompt({
                cfg,
                unit: state.unit,
                floorsText,
                floorsNote,
                picksText: lore.alwaysText,
                memoryText,
                loreHits: lore.hitsText,
                lastGuidance: state.lastGuidance,
            });
        } else {
            messages = buildLightPrompt({
                cfg,
                floorsText,
                floorsNote,
                picksText: lore.alwaysText,
                memoryText,
                loreHits: lore.hitsText,
                lastGuidance: state.lastGuidance,
            });
        }
        lastPromptText = messages.map(m => `【${m.role}】\n${m.content}`).join('\n\n');
        // 材料清单（第三十三轮透明化）：本轮实际喂了什么随留痕落一笔小账，核对材料不必翻提示词全文
        const nums = floors.filter(f => f.floor != null).map(f => f.floor);
        const materials = {
            ...(state.unit
                ? { unitChars: String(state.unit.text ?? '').length, nodeIdx: state.unit.nodeIdx, nodesTotal: state.unit.nodes.length }
                : { light: true }),
            loreAlways: lore.alwaysCount,
            loreAlwaysChars: lore.alwaysChars,
            floors: nums.length ? { first: nums[0], last: nums[nums.length - 1], count: nums.length } : null,
            floorsLimited: state.matRoutine.floors > 0,
            loreHits: state.matRoutine.scan === false ? null : lore.hitsCount,   // null＝检索关（面板显「关」），0＝开了但没命中
            memory: memoryText ? memoryText.length : 0,   // 字数（第三十七轮）：全停用＝0；旧留痕是布尔、面板兼容显示
        };
        const raw = await listenerAttempt(messages, provider, onUsage);
        const parsed = await parseModelJson(raw, {
            messages,
            call: req => listenerAttempt(req.messages, provider, req.onUsage ?? onUsage),
            onUsage,
        });

        // 判定期间单位槽换了主人（第三十二轮竞态收口）：判定与指导都是给旧主人写的——
        // 不写注入槽（换人操作已清槽）、不落账、不点亮、不清作废标记，这轮就当没发生
        if ((listenerState().unit?.id ?? null) !== roundOwnerId) {
            if (manual) toastr.info('本轮判定作废：判定期间单位槽变了（挂载／卸下／接回），等下一轮重判');
            return { ok: true, mode, round, voided: true };
        }

        if (mode === 'unit') {
            const report = normalizeUnitJudgment(parsed.result);
            // 偏大挂起轮（2026-09-02）：判定与进度账照跑（applyUnitOutcome 里点亮照旧），
            // 唯独指导不进注入槽——挂起期间槽保持空、停进提示在独立槽拦着别硬拉回规划
            const suspended = haltSuspendActive(state, state.unit);
            // 手动暂停推进（第五十三轮，用户开工令「当前节点暂缓不推进、检测面板正常运行」）：
            // 方向指导与暗牌停发、点亮冻结（applyUnitOutcome），检查项照跑照修正。与挂起的分工——
            // 挂起＝偏大等处置、指导一概不进槽；暂停＝用户要在当前节点停留、只停推进不停质量修正
            const hold = Boolean(state.hold);
            // 暗牌只随指导同行：goal/action_hint 都空＝静默轮，模型就算多嘴给了 hidden 也不因此破静默
            let text = !hold && (report.goal || report.actionHint) ? guidanceText(report.goal, report.actionHint, report.hidden) : '';
            // 检查修正（第五十二轮立、第五十四轮起四项）：达门槛的发现自动并进指导——节点方向静默的轮也照发（全程自动化）；
            // 挂起轮拦下（挂起＝等用户处理，指导一概不进槽）；暂停轮照发（检查修正不属于节点推进）。
            // 两种轮的检查报告都照常落账给人看
            if (!suspended) {
                const fix = findingsFixText(report.findings, cfg.intervene);
                if (fix) text = text ? `${text}\n${fix}` : fix;
            }
            if (hold && !suspended) {
                report.goal = '';   // 照挂起轮同款：拦下的方向按静默轮落账，留痕里才看得到暂停原因
                report.actionHint = '';
                report.hidden = '';
                report.noGuidanceReason = '暂停推进中（手动）：节点方向与暗牌停发、进度冻结；四项检查照常（报告见监听页「检查报告」区，达门槛的修正照发）';
            }
            if (suspended) {
                text = '';
                report.goal = '';   // 照轻量介入闸先例：拦下的指导按静默轮落账，留痕里才看得到挂起原因
                report.actionHint = '';
                report.hidden = '';
                report.noGuidanceReason = '长线偏离挂起中：判定与进度账照跑，指导暂停注入（处置出口见监听页挂起卡的指路行）';
            }
            writeSlot(text);   // 滚动覆写：静默轮写空串（旧指导不留到下一轮）
            recordGuide(state, nextFloor, text);   // 指导账本（第五十轮）：记到「它塑造的那层楼」名下
            applyUnitOutcome(state, report, { round, at, floorSig, floorCount: floors.filter(f => !f.isUser).length, lastFloor, guidance: text, suspended, hold, retried: parsed.retried, tokens, materials });
        } else {
            const report = normalizeLightReport(parsed.result);
            const intervene = lightShouldIntervene(report, cfg.intervene) && report.goal;
            let text = intervene ? guidanceText(report.goal, report.actionHint) : '';
            // 机械修正段并进轻量注入（第五十五轮，与单位模式同构）：goal 是监听模型写的修正指导
            // （建议腔、软口径无力——知识库教训），机械段逐条编号＋禁令补硬约束；同一道闸，模型
            // 偷懒没写 goal 而发现达标时机械段单独顶上
            const fix = findingsFixText(report, cfg.intervene);
            if (fix) text = text ? `${text}\n${fix}` : fix;
            if (!intervene && report.goal) report.noGuidanceReason = `介入档（${INTERVENE_LIGHT[cfg.intervene].label}）不够格：${report.noGuidanceReason || '本轮发现未达发送门槛'}`;
            writeSlot(text);
            recordGuide(state, nextFloor, text);   // 指导账本（第五十轮）：轻量轮同记账
            applyLightOutcome(state, report, { round, at, floorSig, floorCount: floors.filter(f => !f.isUser).length, lastFloor, guidance: text, retried: parsed.retried, tokens, materials });
        }
        const capped = Math.max(1, Math.floor(Number(cfg.traceRounds) || 50));
        if (state.trace.length > capped) state.trace.length = capped;
        persistListener();
        updateWandDot(state);
        notifyPanel();
        return { ok: true, mode, round };
    } catch (err) {
        // 失败路径同样吃 owner 对账（第三十三轮补漏）：在途那轮的主人已换，失败留痕与失败计数
        // 不该写进新主人的账——就当这轮没发生（换人操作已把注入槽清了，这里也不必再写）
        if ((listenerState().unit?.id ?? null) !== roundOwnerId) {
            if (manual) toastr.info('本轮判定作废：判定期间单位槽变了（挂载／卸下／接回），等下一轮重判');
            return { ok: false, voided: true };
        }
        const { rec, pausedNow } = applyFailure(state, {
            round, at, mode, src: roundSrc,
            floorCount: floors.filter(f => !f.isUser).length,
            error: err?.message ?? String(err),
        });
        writeSlot('');   // 失败轮注入槽清空（判断点 10：宁可裸跑也不喂旧指导）
        recordGuide(state, nextFloor, '');   // 失败也记账（第五十轮）：这层楼当时就是裸跑生成的，重做同样裸跑
        const capped = Math.max(1, Math.floor(Number(cfg.traceRounds) || 50));
        if (state.trace.length > capped) state.trace.length = capped;
        persistListener();
        updateWandDot(state);
        notifyPanel();
        if (pausedNow) toastr.error(`监听连续失败 ${FAIL_STREAK_PAUSE} 次，已暂停（失联）——检查监听模型连接后到「监听」页签点恢复`);
        else if (manual) toastr.error(`监听失败：${rec.error.slice(0, 160)}`);
        return { ok: false, error: rec.error };
    } finally {
        running = false;
        gate?.endRound();   // 放行被扣的发送（成功=带着指导走，失败=裸发但不阻塞）
    }
}

/**
 * 回归判定（第三十三轮）：重挂有进度的长线章时跑一次对账——「走到哪、偏没偏」。
 * 由 longform 侧的 scheduleReentryFor 备好五章窗口材料后调用；不碰排队闸（不是发送链路上的轮），
 * 不写注入槽、不出指导。与例行轮共用 running 锁：来时若例行轮在途（挂载已把它作废），等它落地再跑。
 */
export async function runReentryRound({ window: win, unitId } = {}) {
    const cfg = listenerCfg();
    if (!cfg.enabled) return { skipped: 'disabled' };
    const state = listenerState();
    if (state.paused) return { skipped: 'paused' };
    if (!win?.label || !String(win.text ?? '').trim()) return { skipped: 'no-window' };
    if (!state.unit || state.unit.id !== unitId) return { skipped: 'owner-changed' };   // 排到队时槽里已不是它
    const ctx = getTavernContext();
    const chat = Array.isArray(ctx.chat) ? ctx.chat : null;
    if (!chat || !chat.length) return { skipped: 'no-chat' };
    // 等例行引擎空出来（挂载瞬间在途的旧主人轮几秒内会被 owner 对账作废释放；上限两分钟）
    for (let waited = 0; running && waited < 120_000; waited += 300) await new Promise(r => setTimeout(r, 300));
    if (running) {
        toastr.warning('回归判定没排上：监听引擎一直忙——账面进度不变，下一轮扮演输出后照常例行判定');
        return { skipped: 'busy' };
    }
    running = true;
    const at = Date.now();
    const tokens = { promptTokens: 0, completionTokens: 0 };
    const onUsage = u => {
        tokens.promptTokens += u?.prompt_tokens ?? u?.promptTokens ?? 0;
        tokens.completionTokens += u?.completion_tokens ?? u?.completionTokens ?? 0;
    };
    const { provider } = listenerProvider();

    try {
        const allFloors = collectFloorsFromChat(chat);
        const lastFloor = lastRoleFloor(allFloors);   // 锚层：回归判定批量点亮统一锚在这一层（第四十五轮）
        const floors = limitFloors(allFloors, Number(state.matReentry.floors) || 0);   // 重挂对账材料单（第三十七轮）：与日常单互不影响
        const floorsText = formatFloors(floors);
        const floorsNote = state.matReentry.floors > 0 ? `最近 ${state.matReentry.floors} 层角色楼（楼层号为全聊天绝对号）` : undefined;
        const picks = assembleLorePicks(state.matReentry.picks);   // 重挂单：世界书纯手选（第四十三轮撤自动检索）
        const memoryText = assembleMemory(state.matReentry);
        const messages = buildReentryPrompt({
            unit: state.unit,
            windowLabel: win.label,
            windowText: win.text,
            floorsText,
            floorsNote,
            picksText: picks.text,
            memoryText,
        });
        lastPromptText = messages.map(m => `【${m.role}】\n${m.content}`).join('\n\n');
        const nums = floors.filter(f => f.floor != null).map(f => f.floor);
        const materials = {
            window: win.label,
            windowChars: String(win.text ?? '').length,
            nodeIdx: state.unit.nodeIdx,
            nodesTotal: state.unit.nodes.length,
            lorePicks: picks.count,
            picksChars: picks.chars,
            floors: nums.length ? { first: nums[0], last: nums[nums.length - 1], count: nums.length } : null,
            floorsLimited: state.matReentry.floors > 0,
            memory: memoryText ? memoryText.length : 0,
        };
        const raw = await listenerAttempt(messages, provider, onUsage);
        const parsed = await parseModelJson(raw, {
            messages,
            call: req => listenerAttempt(req.messages, provider, req.onUsage ?? onUsage),
            onUsage,
        });

        // 判定期间槽里换了主人：与例行轮同一口径，产物整体作废（失败成功都一样）
        if ((listenerState().unit?.id ?? null) !== unitId) {
            return { ok: true, mode: 'reentry', voided: true };
        }
        const report = normalizeReentryReport(parsed.result, state.unit);
        applyReentryOutcome(state, report, { at, windowLabel: win.label, lastFloor, tokens, materials });
        const capped = Math.max(1, Math.floor(Number(cfg.traceRounds) || 50));
        if (state.trace.length > capped) state.trace.length = capped;
        persistListener();
        syncHaltSlot();   // 偏大→挂起提示进槽／没偏→挂起解除清槽（applyReentryOutcome 只改 state）
        updateWandDot(state);
        notifyPanel();
        return { ok: true, mode: 'reentry' };
    } catch (err) {
        if ((listenerState().unit?.id ?? null) !== unitId) {
            return { ok: false, voided: true };
        }
        const msg = String(err?.message ?? err).slice(0, 400);
        state.trace.unshift({ at: Date.now(), round: state.round, mode: 'reentry', src: 'longform', ok: false, error: msg });
        state.dot = true;
        state.dotReason = `回归判定失败：${msg.slice(0, 120)}`;
        persistListener();
        updateWandDot(state);
        notifyPanel();
        toastr.error(`回归判定失败：${msg.slice(0, 160)}——账面进度不变，下一轮扮演输出后照常例行判定`);
        return { ok: false, error: msg };
    } finally {
        running = false;   // 不碰排队闸：回归判定不在发送链路上，扣发送没有任何理由
    }
}

// ---------------------------------------------------------------------------
// 删楼回退对账（第四十五轮）：节点点亮时锚定楼层号（litFloors），删楼后锚层越界的
// 节点熄灭、账往回倒——纯账本零调用。口径按用户承诺「只从下往上删，不中间抽楼」：
// 锚层 > 现存最后一层角色楼即越界；无锚（第四十五轮之前的旧点亮）不因删楼熄灭。
// 长线章账本的回退写点在 longform.js（对账器经 index.js 注册进来，保持单向依赖）
// ---------------------------------------------------------------------------

// 单个单位的锚点对账：返回 null＝没回退；否则 { from, to, unlit:[{title,anchor}] }（已就地改账）
export function reconcileUnitAnchors(unit, lastFloor) {
    if (!unit || !Array.isArray(unit.litFloors)) return null;
    let keep = 0;
    for (let i = 0; i < unit.nodeIdx; i++) {
        const a = unit.litFloors[i];
        if (a == null || a <= lastFloor) keep = i + 1;   // 无锚＝旧账，不因删楼熄灭
        else break;   // 从下往上删：第一个越界即止
    }
    if (keep >= unit.nodeIdx) return null;
    const unlit = [];
    for (let i = keep; i < unit.nodeIdx; i++) unlit.push({ title: unit.nodes[i]?.title ?? `节点${i + 1}`, anchor: unit.litFloors[i] ?? null });
    const from = unit.nodeIdx;
    unit.nodeIdx = keep;
    unit.litFloors = unit.litFloors.slice(0, keep);
    return { from, to: keep, unlit };
}

// 监听两账（活动单位＋退位槽）删楼回退＋留痕落账。返回回退清单（null＝没动）；
// 每条带 unit 引用供长线侧显式倒章账本（留痕记录里不带——不留对象进存档）
export function rollbackListenerFloors(lastFloor) {
    const state = listenerState();
    const rolled = [];
    for (const u of [state.unit, state.sidelined]) {
        const r = reconcileUnitAnchors(u, lastFloor);
        if (r) rolled.push({ unit: u, label: String(u.title ?? ''), src: u.source === 'longform' ? 'longform' : 'plan', ...r });
    }
    if (!rolled.length) return null;
    for (const r of rolled) {
        state.trace.unshift({ at: Date.now(), round: state.round, mode: 'rollback', src: r.src, ok: true, rollback: { label: r.label, from: r.from, to: r.to, unlit: r.unlit, lastFloor } });
    }
    const capped = Math.max(1, Math.floor(Number(listenerCfg().traceRounds) || 50));
    if (state.trace.length > capped) state.trace.length = capped;
    persistListener();
    updateWandDot(state);
    notifyPanel();
    toastr.info(`删楼回退：${rolled.map(r => `「${String(r.label).slice(0, 30)}」熄灭 ${r.from - r.to} 个节点`).join('；')}——被删楼层里的剧情重新演出会再次点亮`);
    return rolled;
}

// 对账器挂钩：长线侧的章账本回退写点由 index.js 注册进来（listener 不 import longform）
let litReconciler = null;
export function registerLitReconciler(fn) { litReconciler = typeof fn === 'function' ? fn : null; }

function runLitReconcile() {
    try {
        const chat = Array.isArray(getTavernContext().chat) ? getTavernContext().chat : null;
        if (!chat || !chat.length) return;   // chatdata 就绪窗口坑：没载完不硬对账（空聊天也不当「全删」处理）
        litReconciler?.();
    } catch (e) {
        console.warn('[PlotPlanner] 删楼对账失败（账面不动，下一轮判定前会再试）', e);
    }
}

// ---------------------------------------------------------------------------
// 指导还原出口（第五十轮）：删楼缩水 / 滑动·重新生成 → 注入槽换回「那一轮原来的指导」。
// 与 R45 节点回退同一批触发时机，但独立动作——节点没回退（删的楼层里没点亮）指导也要还原。
// 判定轮照跑不动：重做落地后照常重判、节点可再次点亮（「被删楼层里的剧情重新演出会再次点亮」）
// ---------------------------------------------------------------------------

// 轮首输入线校正（纯逻辑）：水位高于现存最后一层＝有删楼没接住（升载中途删楼等）——
// 「上一轮指导」防复读线若按被删前的旧线喂会串味，换回「塑造现存最后一层的那条原账」；
// 没有原账就清空（同失败轮口径）。只校正判定输入线，不写注入槽（生成早已过去，槽归还原出口管）
export function syncGuideLineForJudgment(state, lastFloor) {
    const seen = Number(state.lastFloorSeen);
    if (!Number.isFinite(seen) || seen <= lastFloor) return;
    state.lastFloorSeen = lastFloor;
    const g = guideEntryFor(state, lastFloor);
    if (g !== undefined) {
        state.lastGuidance = g;
        state.guideVoidReason = '';
    } else {
        state.lastGuidance = '';
        state.guideVoidReason = '删楼回退：那一层没有原指导记录';
    }
}

// 「指导沿用」留痕（mode=rollback 复用留痕池；rollback.guide 子形状与节点回退区分渲染）
function pushGuideReplayTrace(state, { target, reuse, trigger, lastFloor, text }) {
    state.trace.unshift({
        at: Date.now(),
        round: state.round,
        mode: 'rollback',
        src: null,
        ok: true,
        rollback: { guide: { target, reuse, trigger }, ...(Number.isInteger(lastFloor) ? { lastFloor } : {}) },
        ...(reuse ? { guidance: String(text ?? '') } : {}),
    });
    const capped = Math.max(1, Math.floor(Number(listenerCfg().traceRounds) || 50));
    if (state.trace.length > capped) state.trace.length = capped;
    persistListener();
    updateWandDot(state);
    notifyPanel();
}

// 删楼缩水还原（宿主出口）：删楼事件与 send 型生成开始前都调——水位没降（没删楼）零动作。
// M＝现存最后一层；注入槽与「上一轮指导」换回「第 M+1 层那一次」的原账（重发的正是这层楼）；
// 无原账（升级前生成/超出留存/血脉已换）就清空作废——宁可裸跑，不喂对不上剧情位置的旧指导
export function restoreGuideAfterShrink() {
    try {
        if (!listenerCfg().enabled) return;
        const state = listenerState();
        if (state.paused) return;
        const chat = Array.isArray(getTavernContext().chat) ? getTavernContext().chat : null;
        if (!chat || !chat.length) return;   // 空聊天护栏：不当「全删」处理
        const M = lastRoleFloor(collectFloorsFromChat(chat));
        const seen = Number(state.lastFloorSeen);
        if (!Number.isFinite(seen) || seen <= M) return;   // 没缩水：不动（水位由判定轮维护）
        if (seen <= roleFloorCeil(chat)) return;   // 只是藏楼不是删楼（第五十七轮）：水位与现存末楼之间的楼层还在数组里（is_system），还原/作废都不做
        state.lastFloorSeen = M;
        const T = M + 1;
        const g = guideEntryFor(state, T);
        if (g !== undefined) {
            if (g === state.lastGuidance && state.guideVoidReason === '') return;   // 已还原过：零动作
            state.lastGuidance = g;
            state.guideVoidReason = '';
            writeSlot(g);
            pushGuideReplayTrace(state, { target: T, reuse: true, trigger: 'delete', lastFloor: M, text: g });
        } else {
            if (state.guideVoidReason === '删楼回退：无原指导记录') return;   // 同一结果已落过（防重复留痕）；失败轮清过线不算——面板要看到作废行
            voidGuidance(state, '删楼回退：无原指导记录');
            writeSlot('');
            pushGuideReplayTrace(state, { target: T, reuse: false, trigger: 'delete', lastFloor: M });
        }
    } catch (e) {
        console.warn('[PlotPlanner] 删楼指导还原失败（账面不动，下一轮判定前会再试）', e);
    }
}

// 重做最后一层（宿主出口）：滑动 / 重新生成开始前调——注入槽换回「塑造这层楼的原账」。
// 酒馆源码核实：GENERATION_STARTED 在提示词组装之前发出，此处改槽来得及影响本次生成；
// MESSAGE_SWIPED 不挂（翻看旧变体也触发它，那时没有生成、不该动槽）。末楼是用户消息时
// （重新生成按「生成新楼层」处理）退回缩水还原口径
export function restoreGuideForRedo() {
    try {
        if (!listenerCfg().enabled) return;
        const state = listenerState();
        if (state.paused) return;
        const chat = Array.isArray(getTavernContext().chat) ? getTavernContext().chat : null;
        if (!chat || !chat.length) return;
        const last = chat[chat.length - 1];
        if (!last || last.is_user === true || last.is_system === true) { restoreGuideAfterShrink(); return; }
        let n = 0;
        for (let i = 0; i < chat.length - 1; i++) {
            const m = chat[i];
            if (m && m.is_user !== true && String(m.mes ?? '')) n++;   // 非空角色楼占号（隐藏楼也占，第五十七轮绝对号口径）
        }
        const T = n + 1;   // 被重做那层的楼层号
        const g = guideEntryFor(state, T);
        if (g !== undefined) {
            if (g === state.lastGuidance && state.guideVoidReason === '') return;   // 已还原过：零动作
            state.lastGuidance = g;
            state.guideVoidReason = '';
            writeSlot(g);
            pushGuideReplayTrace(state, { target: T, reuse: true, trigger: 'regen', text: g });
        } else {
            const reason = `重做第${T}层：无原指导记录`;
            if (state.guideVoidReason === reason) return;   // 同一结果已落过（防重复留痕）
            voidGuidance(state, reason);
            writeSlot('');
            pushGuideReplayTrace(state, { target: T, reuse: false, trigger: 'regen' });
        }
    } catch (e) {
        console.warn('[PlotPlanner] 重做前指导还原失败（不拦生成，按现行槽内容注入）', e);
    }
}

// ---------------------------------------------------------------------------
// 宿主接线：触发时机（扮演模型完全输出完毕 = 实践验证过的 MESSAGE_RECEIVED；
// 楼层签名去重后，编辑/重生成最后一楼（MESSAGE_EDITED）也会触发重判）
// ---------------------------------------------------------------------------

function scheduleAnalyze() {
    clearTimeout(analyzeTimer);
    analyzeTimer = setTimeout(() => {
        const cfg = listenerCfg();
        if (!cfg.enabled) return;
        const state = listenerState();
        if (state.paused) return;
        const chat = Array.isArray(getTavernContext().chat) ? getTavernContext().chat : [];
        const sig = floorsSignature(chat);
        if (!sig || sig === state.lastFloorSig) return;   // 楼没变（滑动/重生成内容相同）不重跑
        runListenerRound();
    }, 800);
}

// 红点：亮在我们自己的魔法棒菜单项上（#pp_wand_open 是本插件建的 DOM，不碰酒馆内部）
function updateWandDot(state) {
    if (typeof document === 'undefined') return;   // 离线测试台没有 DOM
    const on = Boolean(state.paused || state.dot);
    const dot = document.getElementById('pp_wand_dot');
    if (dot) dot.classList.toggle('pp-dot-on', on);
}

function notifyPanel() {
    if (typeof document === 'undefined') return;
    document.dispatchEvent(new CustomEvent('pp-listener-updated'));
}

// 排队闸装配：捕获阶段扣 #send_but 点击与输入框回车；放行时补一次真实点击
function installSendGate() {
    const g = createSendGate({
        click: () => {
            const btn = document.getElementById('send_but');
            if (btn) btn.click();
        },
        onHold: () => {
            if (!holdToastShown) {
                holdToastShown = true;
                toastr.info('监听判定还在跑：本条发送已暂扣，判定一结束就自动发出（输入与指导一起走）');
            }
        },
        onRelease: () => { },
    });

    document.addEventListener('click', e => {
        if (!e.target?.closest?.('#send_but')) return;
        if (g.intercept()) { e.preventDefault(); e.stopImmediatePropagation(); }
    }, true);

    document.addEventListener('keydown', e => {
        if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
        if (!e.target?.closest?.('#send_textarea')) return;
        if (g.intercept()) { e.preventDefault(); e.stopImmediatePropagation(); }
    }, true);

    return g;
}

export function initListener() {
    listenerCfg();
    gate = installSendGate();

    eventSource.on(event_types.CHAT_CHANGED, () => {
        // 换聊天：丢掉扣住的发送（点了会发进新聊天）、清注入槽（旧聊天的指导不外溢），
        // listenerState() 随 chatdata 按聊天身份自动切换，红点按新聊天状态重算；
        // 槽清了显示也得认账——回本聊天时旧指导不再算「注入槽里生效」（第三十二轮）
        gate?.abort();
        clearListenerSlot();
        const st = listenerState();
        voidGuidance(st, '切换聊天');
        persistListener();
        syncHaltSlot();   // 停进提示按新聊天的 halt 块重放/清空（每聊天各管各的）
        clearTimeout(analyzeTimer);
        updateWandDot(st);
        notifyPanel();
    });

    // 扮演模型输出完毕（新楼层落地）：立即开跑判定（去抖 800ms 吸收事件抖动）
    eventSource.on(event_types.MESSAGE_RECEIVED, scheduleAnalyze);

    // 最后一楼被编辑/重生成：内容变了签名就变，自动重判；没变不吃轮
    eventSource.on(event_types.MESSAGE_EDITED, scheduleAnalyze);

    // 删楼（第四十五轮）：楼层被删 → 对账回退锚层越界的节点（去抖合并「连删多楼」的连发事件）；
    // 指导还原（第五十轮）跟在节点对账后面同一拍跑——删到哪层，注入槽就回到「那层那一次」的原账
    eventSource.on(event_types.MESSAGE_DELETED, () => {
        clearTimeout(reconTimer);
        reconTimer = setTimeout(() => {
            runLitReconcile();
            restoreGuideAfterShrink();
        }, 600);
    });

    // 藏楼/取消藏楼自动重判（第五十七轮，用户开工令）：酒馆的隐藏按钮只改 is_system＋存档、
    // 全程不发事件（源码核实 hideChatMessageRange）——document 级点击委托补个眼线，点了就去抖
    // 跑一轮判定（签名闸兜底：楼层没真变不跑、不花调用）。与酒馆自己的事件委托同款，只读不碰它的 DOM。
    // 斜杠/脚本等无点击入口的藏楼兜底在下一触点：任何原因跑起判定轮时签名变了照跑，且轮首
    // 对账已改按「含隐藏的总楼数」判删楼，藏楼不再误回退
    document.addEventListener('click', e => {
        if (e.target?.closest?.('.mes_hide, .mes_unhide')) scheduleAnalyze();
    });

    // 生成开始前（第五十轮）：滑动/重新生成＝重做最后一层 → 注入槽换回塑造它的原账；
    // 普通发送只做删楼缩水兜底（删楼事件没接住时补还原）。continue/impersonate/quiet 不碰
    // （酒馆源码核实 GENERATION_STARTED 在提示词组装之前发出，此处改槽来得及）
    if (event_types.GENERATION_STARTED) eventSource.on(event_types.GENERATION_STARTED, (type, _opts, dryRun) => {
        if (dryRun) return;
        try {
            if (type === 'send') restoreGuideAfterShrink();
            else if (type === 'swipe' || type === 'regenerate') restoreGuideForRedo();
        } catch { /* 还原失败不拦生成 */ }
    });

    updateWandDot(listenerState());
}

// 面板/设置页共用的恢复与开关写点
export function resumeListener() {
    const state = listenerState();
    state.paused = false;
    state.failStreak = 0;
    state.dot = false;
    state.dotReason = '';
    persistListener();
    updateWandDot(state);
    notifyPanel();
}

// 手动暂停推进的按钮出口（第五十三轮，用户开工令「我在监听期间点一下，当前节点暂缓不推进，
// 检测面板正常运行；事件结束再点一下恢复正常」）：只对单位轮生效（轻量执勤没有节点推进可停）。
// 开＝清注入槽＋给「暂停后要塑造的下一层楼」记空账——旧方向指导既不再注入、也不会被删楼/重做
// 的还原出口灌回去（第五十轮账本按楼层取数，空账＝还原后照旧裸跑/只有当轮修正）；
// 关＝不动槽，由 UI 侧紧接着自动补一轮判定，把方向指导立刻写回来（不用等下一条消息落地）
export function setListenerHold(on) {
    const state = listenerState();
    const next = Boolean(on);
    if (state.hold !== next) {
        state.hold = next;
        persistListener();
        if (next) {
            writeSlot('');
            recordGuide(state, roleFloorCeil(getTavernContext().chat) + 1, '');   // 给「下一层将生成的楼」记空账（绝对号口径，藏尾楼也对）
        }
        notifyPanel();
    }
    return state.hold;
}

export function setListenerEnabled(on) {
    listenerCfg().enabled = Boolean(on);
    save();
    if (!on) {
        clearListenerSlot();
        gate?.abort();
        const state = listenerState();
        voidGuidance(state, '监听已关闭');   // 关停时槽已清：面板不能再把旧指导显示成「生效中」
        persistListener();
        updateWandDot(state);
    }
    notifyPanel();
}

// 手动点亮当前节点（两本账：用户的显式操作可改进度账——卡死拍板的出路之一）；
// 偏大挂起中的手动标记达成同时解除挂起（2026-09-02：用户接管＝处置完成）
export function manualLitCurrentNode() {
    const state = listenerState();
    if (!state.unit || state.unit.nodeIdx >= state.unit.nodes.length) return false;
    const chat = Array.isArray(getTavernContext().chat) ? getTavernContext().chat : [];
    state.unit.litFloors[state.unit.nodeIdx] = lastRoleFloor(collectFloorsFromChat(chat)) || null;   // 锚层：手动点亮锚在现存最后一层（第四十五轮）
    state.unit.nodeIdx += 1;
    if (state.halt?.kind === 'suspended') state.halt = null;
    state.dot = false;
    state.dotReason = '';
    persistListener();
    syncHaltSlot();
    notifyPanel();
    return true;
}

// 手动回退一个节点（第五十六轮）：误判达成的纠错口——模型把还没演到的节点错判成达成、
// 或手滑点了「标记达成」后，这里把最近点亮的节点退回待判（nodeIdx-1、锚层账同缩）。
// 纯账本零调用（同删楼回退口径）、也不立刻补判：原楼层还在，马上重判大概率原样再点亮、等于白退；
// 注入槽里的旧方向是给「误判后位置」写的，照暂停推进的配方清槽＋对未生成楼层记空账（宁可裸跑），
// 下一轮例行判定自然对回退后的节点重新跑。长线章的账本倒回由面板侧调 longform 的显式路径。
export function rollbackOneNode() {
    const state = listenerState();
    const unit = state.unit;
    if (!unit || !(Number(unit.nodeIdx) > 0)) return false;
    const from = Number(unit.nodeIdx);
    const anchor = Array.isArray(unit.litFloors) ? unit.litFloors[from - 1] ?? null : null;
    const unlit = [{ title: unit.nodes[from - 1]?.title ?? `节点${from}`, anchor }];
    unit.nodeIdx = from - 1;
    unit.litFloors = Array.isArray(unit.litFloors) ? unit.litFloors.slice(0, from - 1) : [];
    const capped = Math.max(1, Math.floor(Number(listenerCfg().traceRounds) || 50));
    state.trace.unshift({ at: Date.now(), round: state.round, mode: 'rollback', src: unit.source === 'longform' ? 'longform' : 'plan', ok: true,
        rollback: { kind: 'manual', label: String(unit.title ?? ''), from, to: from - 1, unlit } });
    if (state.trace.length > capped) state.trace.length = capped;
    writeSlot('');
    recordGuide(state, roleFloorCeil(getTavernContext().chat) + 1, '');   // 未生成楼层记空账（防还原路径灌回旧方向；绝对号口径，藏尾楼也对）
    voidGuidance(state, '节点回退');   // 旧指导是给回退前位置写的，不作数也不当防复读参照
    persistListener();
    notifyPanel();
    return { unit, label: String(unit.title ?? ''), src: unit.source === 'longform' ? 'longform' : 'plan', from, to: from - 1, unlit };
}

// 挂载/卸下/接回/丢弃的操作出口（面板调用；带持久化与失败提示）。
// 换主人的三个操作（挂/卸/接回）同步清注入槽：旧指导是给旧主人写的，不清就会注入进下一轮生成。
// 停进提示随行（2026-09-02）：挂载/接回＝撤（新剧情接管或恢复推进）；卸下长线章＝发（暂停收尾）
export function opMountUnit(unit) {
    const state = listenerState();
    const r = mountUnit(state, unit);
    if (r.ok) {
        clearListenerSlot();
        state.halt = null;   // 挂载（手动/确认采用顶掉/mix 重挂）＝这条线有人管了，停进提示撤下
        persistListener();
        syncHaltSlot();
        flushChatData();
    }
    return r;
}

export function opUnmountUnit() {
    const state = listenerState();
    const wasLf = state.unit?.source === 'longform';
    const title = state.unit?.title ?? '';
    const unitId = state.unit?.id ?? '';
    const r = unmountUnit(state);
    if (r.ok) {
        clearListenerSlot();
        if (wasLf) setHalt('paused', { title, unitId });   // 只有手动「卸下」发停进提示；确认采用顶掉不发（新规划接管）
        persistListener();
        syncHaltSlot();
    }
    return r;
}

export function opRecallSidelined() {
    const state = listenerState();
    const r = recallSidelined(state);
    if (r.ok) {
        clearListenerSlot();
        state.halt = null;   // 接回＝恢复推进
        persistListener();
        syncHaltSlot();
    }
    return r;
}

export function opDiscardSidelined() {
    const state = listenerState();
    const r = discardSidelined(state);
    if (r.ok) persistListener();
    return r;
}

export function listenerModeLabel(state) {
    const cfg = listenerCfg();
    if (!cfg.enabled) return { key: 'off', label: '●未启用', hint: '到下方或设置页打开总开关' };
    if (state.paused) return { key: 'lost', label: '⚠失联', hint: '连续失败自动暂停，恢复前不判定' };
    if (!listenerProvider().provider && listenerProvider().fallback && !settings.api.baseUrl) return { key: 'suspend', label: '⏸挂起', hint: '监听模型未配置（方案库与主连接都空）' };
    if (state.unit && state.unit.nodeIdx < state.unit.nodes.length) return { key: 'unit', label: '●单位执勤', hint: '挂载了剧情单位，逐轮判定节点进度' };
    if (state.unit) return { key: 'unit-done', label: '●单位执勤·已演完', hint: '末节点已点亮，等手动接续（无自动档）；期间按轻量口径检查' };
    return { key: 'light', label: '●轻量执勤', hint: '无挂载单位：OOC/剧情重复/文风重复/复读 user 的话四项检查' };
}
