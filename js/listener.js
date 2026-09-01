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
import { chatCompletion, parseModelJson } from "./api.js";
import { loadChatData, saveChatData, flushChatData } from "./chatdata.js";
import { getTavernContext } from "./context.js";
import { scanLorebooks, buildLoreContext, resolveLorePicks } from "./lorebook.js";
import { buildMemoryContext } from "./memoryTable.js";

const POSITION_IN_PROMPT = extension_prompt_types?.IN_PROMPT ?? 0;
const ROLE_SYSTEM = extension_prompt_roles?.SYSTEM ?? 0;
const SLOT_KEY = 'pp:listener';

// 每次调用超时与排队闸硬上限（提案值）：闸的等待受「超时＋一次重试」约束，
// 硬上限兜底防扣住发送挂死——超界即按失败放行，迟到的结果照写注入槽（下一轮用）
const CALL_TIMEOUT_MS = 90_000;
const GATE_HARD_CAP_MS = 240_000;
const FAIL_STREAK_PAUSE = 3;

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
    low: { label: '低', text: '仅很轻微的发现（OOC 轻微、文风轻微）可不发；中等及以上 OOC、剧情重复、明显文风重复必须发。' },
    medium: { label: '中', text: '有任何发现就发修正指导，轻微也不例外；仅三项全部无发现时静默。' },
    high: { label: '高', text: '有任何发现就发修正指导；仅三项全部无发现时静默。' },
};

export function listenerCfg() {
    const c = settings.listener ??= {};
    c.enabled ??= false;
    c.providerId ??= '';
    c.depth ??= 2;
    c.strictness ??= 'standard';
    c.intervene ??= 'medium';
    c.traceRounds ??= 50;
    c.stuckWindow ??= 3;
    c.progressMin ??= 400;
    c.progressMax ??= 800;
    c.withLorebook ??= true;
    c.withMemory ??= true;
    c.floorLimit ??= 0;   // 楼层范围（第三十四轮）：0 = 全量（默认）；N > 0 = 只带最近 N 层角色楼
    if (!STRICTNESS_LEVELS[c.strictness]) c.strictness = 'standard';
    if (!INTERVENE_UNIT[c.intervene]) c.intervene = 'medium';
    return c;
}

// 监听模型固定项：方案库选定的方案；没选 = 第一个方案；显式选主连接或方案库空 = 退回主连接（provider:null）
export function listenerProvider() {
    listenerCfg();
    const profs = settings.api.profiles ?? [];
    let chosen = null;
    if (settings.listener.providerId && settings.listener.providerId !== '__main__') {
        chosen = profs.find(p => p.id === settings.listener.providerId) ?? null;
    } else if (!settings.listener.providerId) {
        chosen = profs[0] ?? null;
    }
    if (chosen?.baseUrl && chosen?.model) {
        return { name: `${chosen.name} · ${chosen.model}`, fallback: false, provider: { baseUrl: chosen.baseUrl, apiKey: chosen.apiKey, model: chosen.model } };
    }
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
        lastGuidance: '',    // 上一轮指导全文（防复读输入线 + 面板显示）
        guideVoidReason: '', // 非空＝上一轮指导已作废（卸下/换挂/接回/关总开关/切聊天）——注入槽已清、面板改显示作废行；下一轮落账清零
        lastFloorSig: '',    // 最后一轮已分析过的楼层签名（去重：滑动/重生成内容没变不重跑）
        lorePicks: [],       // 世界书自选勾选键（「bookId:uid」，第三十四轮）：勾中的整条原文固定进每轮判定材料，
                             // 不设上限、不看关键词/常驻/启用状态；与检索命中自动去重（自选优先）。存监听自己的
                             // 聊天块——与向导第 1 步 / 长线页的勾选各管各的（先例：长线勾选存 longform 块）
        dot: false,          // 红点旗标（有问题未看；打开监听页签即清除）
        dotReason: '',       // 红点问题的一句话描述
    }));
    state.unit = normalizeUnit(state.unit);
    state.sidelined = normalizeUnit(state.sidelined);
    if (!Array.isArray(state.trace)) state.trace = [];
    if (!Array.isArray(state.lorePicks)) state.lorePicks = [];   // 旧聊天块没有该字段（第三十四轮新增）
    return state;
}

export function persistListener() {
    saveChatData('listener', listenerState());
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
    };
}

// ---------------------------------------------------------------------------
// 纯逻辑：单位构造与 1.0 规划节点化（判断点 13 提案 A：beats 行直接当节点，零新增提示词）
// ---------------------------------------------------------------------------

// 手动导入先做成单节点单位（整个文本一块判；2.0 管线产物自带节点表后此处只是测试入口）
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
    return { ok: true };
}

// 卸下当前单位 → 进退位槽（槽被占则拒绝，先处理退位槽）；真正删除走丢弃
export function unmountUnit(state) {
    if (!state.unit) return { ok: false, reason: '当前没有挂载单位' };
    if (state.sidelined) return { ok: false, reason: '退位槽已有单位：先「接回」或「丢弃」它' };
    state.sidelined = state.unit;
    state.unit = null;
    voidGuidance(state, '卸下单位');   // 卸下后按轻量口径执勤：单位指导绝不留到下一轮注入
    return { ok: true };
}

export function discardSidelined(state) {
    if (!state.sidelined) return { ok: false, reason: '退位槽是空的' };
    state.sidelined = null;
    return { ok: true };
}

// ---------------------------------------------------------------------------
// 纯逻辑：楼层收集与格式化（全部未隐藏楼层带楼层号；楼层号只数角色回复，与全插件口径一致）
// ---------------------------------------------------------------------------

export function collectFloorsFromChat(chat) {
    if (!Array.isArray(chat)) return [];
    const out = [];
    let floor = 0;
    for (const m of chat) {
        if (m?.is_system === true) continue;   // 「对 AI 隐藏」的楼层不进输入也不计楼层
        if (m?.is_user) {
            const text = String(m?.mes ?? '');
            if (text) out.push({ floor: null, name: '{{user}}', isUser: true, text });
        } else {
            const text = String(m?.mes ?? '');
            if (text) out.push({ floor: ++floor, name: String(m?.name ?? '角色'), isUser: false, text });   // 空楼不进输入也不占号：模型要按可见楼层引证
        }
    }
    return out;
}

export function formatFloors(list) {
    return list.map(m => m.isUser
        ? `（用户·不计楼层）${m.name}: ${m.text}`
        : `[楼层${m.floor}] ${m.name}: ${m.text}`).join('\n\n');
}

// 最后一楼签名：楼数 + 最后一条角色楼内容指纹。滑动/重生成内容没变 → 签名不变 → 不重跑
export function floorsSignature(chat) {
    const list = collectFloorsFromChat(chat);
    const last = [...list].reverse().find(m => !m.isUser);
    if (!last) return '';
    let h = 5381;
    for (let i = 0; i < last.text.length; i++) h = ((h << 5) + h + last.text.charCodeAt(i)) >>> 0;
    return `${list.filter(m => !m.isUser).length}:${h.toString(16)}`;
}

// ---------------------------------------------------------------------------
// 纯逻辑：两套提示词组装（每次调用自包含；上一轮指导只用于防复读）
// ---------------------------------------------------------------------------

// 两套提示词的块序＝前缀缓存口径（第二十七轮立、第三十四/三十五轮两次修正）：监听每轮都跑、
// 提示词前缀跨轮复用是监听成本的大头。稳定块（说明/单位全文/世界书自选/**记忆表格**/判定规则/
// 输出契约）全部前置；节点状态（推进时才变）放在楼层前面，推进轮不再整发全价；楼层这个每轮
// 追加的大块放在「每轮都整个重写的小块」（上一轮指导/检索命中）之前——楼层的旧内容每轮都能
// 吃缓存、只有新尾巴按未命中计价。**记忆表格按「大而少变」归稳定段（第三十五轮用户拍桌：
// 「谁告诉你记忆表是小块？我记忆表 4 万多字」——第二十七轮把附加材料归进「每轮都变的小块」
// 的老分类两头都不成立：体量可以很大、变化只随记忆更新不随轮次；排在楼层后面会让它每轮跟着
// 丢缓存、整块按全价重算）。若把楼层挪到指导/检索后面绝对垫底，同样整段楼层每轮重算——
// 缓存吃满的最优解＝大块材料全部在前、其后只留真正的小块。
// 世界书拆两半发（第三十四轮）：自选条目跟勾选走、整条不截断、进稳定段；检索命中按最近楼层
// 重扫逐轮变，照旧垫底——同一条两边都有时自选优先，检索里让位
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
            '<世界书自选条目（用户点名常驻材料；整条原文、不截断）>',
            picksText || '（未勾选——角色设定等对照材料以本块勾选为准，没有就按单位全文与楼层判定）',
            '</世界书自选条目>',
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
            '- 结构＝一句目标句（把剧情引向当前待判节点）＋动作提示（点出可做而未做的动作方向）。',
            '- 长度不设上限：一轮里多角色且各有负责内容时，该写多长写多长，宁详勿简。',
            '- 每轮重新生成：措辞必须随已推进内容变化，不得复读上一轮指导（哪怕意思相近也要换说法）。',
            '- 两条红线：不得剧透——指导只基于当前单位与下一节点标题，严禁编造或暗示后续内容；不得催促抢跑——引导，不驱赶。',
            '- 意思模板（仅示意含义，措辞自定）：目标句如「让两人的对话自然滑向摊牌的边缘」；动作提示如「她可以先把手里那样东西放到桌上」。',
            `   介入强度（当前档：${inter.label}）决定发的勤度：${inter.text} 决定不发时必须给原因。`,
            '',
            '【输出】',
            '只输出一个 JSON 对象，不输出任何其他文字：',
            '{',
            '  "judgment": "achieved | not_yet | stuck",',
            '  "evidence": [{"floor": 楼层号, "quote": "该楼原文片段", "note": "为什么这段能作证"}],',
            '  "progress_note": "本轮实际推进了什么，一两句",',
            '  "guidance": {"goal": "目标句", "action_hint": "动作提示"},',
            '  "no_guidance_reason": "不发指导时的原因；发了则留空字符串",',
            '  "watch": {"ooc": true/false, "slow_burn": true/false, "fake_completion": true/false, "notes": "边缘情况备注，无则空字符串"}',
            '}',
            '说明：evidence 至少 1 条、不设上限；guidance 在卡死或按介入档决定静默时整段留空（goal 与 action_hint 均空字符串）并在 no_guidance_reason 写明原因。',
            '字符串值里不要出现英文双引号（引用一律写中文「」），也不要在值内换行。',
            '',
            '【当前节点状态】（判定的对照对象）',
            `- 当前待判节点：${node.title}——完成标准：${node.criterion}${node.text ? `\n  节点内容：${node.text}` : ''}`,
            `- 下一节点标题（只知名、不知戏）：${next}——只用于把握收尾方向，严禁把下一节点的具体内容编进指导。`,
            `- 本章已点亮节点：${lit}——不得再指导模型重复演绎这些节点的内容。`,
            '',
            `<剧情上下文（${floorsNote ?? '当前聊天全部未隐藏楼层'}，带楼层号；新楼层追加在本节末尾）>`,
            floorsText,
            '</剧情上下文>',
            '',
            '<上一轮指导（仅供避免复读，不是模板）>',
            last,
            '</上一轮指导>',
            '',
            '<世界书检索命中（按最近楼层重扫，逐轮可能变化；与上方自选条目自动去重）>',
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
            '【检查任务】（三项，判定基准与 1.0 剧情检查一致）',
            '1. OOC——只判角色（char）自身的问题：用户（user）在对话里明确指示、纠正或要求改变走向时（包括括号指令与作者式安排），角色照做不算 OOC，用户指示优先于人设与既有走向；只有用户没有指示、角色自行脱离人设/事实/关系/世界观时才判，evidence 引用具体楼层号与原文。',
            '2. 剧情重复——同一剧情线的自然延续不算重复；只有把已完结、已发生并被交代过的情节当作新剧情原样重演，或复刻已有桥段的流程，才判重复。',
            '3. 文风重复——只针对角色（char）的扮演文本：先检查用户近期输入是否自己在重复动作、场景或指令，角色跟进不算；只有用户没有重复而角色自发重复描写套路、桥段或句式时，才判轻微/明显，note 写明用户是否先重复、角色重复了什么。',
            '',
            '【修正指导】',
            '- 三项检查有任何发现时，生成一段修正指导：点明往哪个方向修（如拉回人设的事实依据、绕开重复的新走法），结构＝一句目标句＋动作提示；长度不设上限、宁详勿简；措辞每轮变化、不复读上一轮修正指导。',
            '- 三项全部无发现时，不发指导——no_guidance_reason 写一两句本轮质量印象（例：「节奏稳定、人设无漂移；第 12 楼起略有原地打转苗头，暂不需干预」），禁用「均无发现」「一切正常」这类空话。正常轮次静默是这个模式的常态，不是异常。',
            '',
            `【介入强度】（当前档：${inter.label}）`,
            inter.text,
            '',
            '【输出】',
            '只输出一个 JSON 对象，不输出任何其他文字：',
            '{',
            '  "ooc": { "found": true/false, "items": [{ "aspect": "性格|事实|关系|世界观|口吻", "evidence": "具体楼层与原文依据", "severity": "轻微|中等|严重", "fix": "修正建议" }] },',
            '  "plot_repeat": { "found": true/false, "note": "重演/复刻之处；没有则空字符串" },',
            '  "style_repeat": { "level": "无|轻微|明显", "note": "仅判角色自发重复：用户是否先重复、角色重复了什么" },',
            '  "guidance": { "goal": "目标句", "action_hint": "动作提示" },',
            '  "no_guidance_reason": "不发指导时的原因；发了则留空字符串"',
            '}',
            '说明：字符串值里不要出现英文双引号（引用一律写中文「」），也不要在值内换行。',
            '',
            '【材料】',
            '<世界书自选条目（用户点名常驻材料；整条原文、不截断）>',
            picksText || '（未勾选——没有点名材料就按楼层原文直接检查）',
            '</世界书自选条目>',
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
            '<世界书检索命中（按最近楼层重扫，逐轮可能变化；与上方自选条目自动去重）>',
            loreHits || '（无）',
            '</世界书检索命中>',
        ].join('\n') },
    ];
}

// ---------------------------------------------------------------------------
// 纯逻辑：回归判定（第三十三轮）——重挂有进度的长线章时补一次对账报告
// ---------------------------------------------------------------------------

// 材料与例行判定同一套（全/限楼层＋世界书自选＋检索命中＋记忆表），窗口＝五章规划轨迹。
// 只出报告不出指导：后两章的规划在窗口里，任何「指导」都可能把后续剧情漏进扮演模型——回归判定
// 的产物给用户看，注入槽一概不碰（旧作废标记也留着，等下一轮例行判定重新生成指导）
export function buildReentryPrompt({ unit, windowLabel, windowText, floorsText, picksText = '', floorsNote, memoryText = '', loreHits = '' }) {
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
            '<世界书自选条目（用户点名常驻材料；整条原文、不截断）>',
            picksText || '（未勾选——没有点名材料就按窗口与楼层判定）',
            '</世界书自选条目>',
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
            '',
            '<世界书检索命中（按最近楼层重扫；与上方自选条目自动去重）>',
            loreHits || '（无）',
            '</世界书检索命中>',
        ].join('\n') },
    ];
}

// ---------------------------------------------------------------------------
// 纯逻辑：输出契约规约（模型输出不可信，字段全部收敛到合法形状；违契约抛错走 L1）
// ---------------------------------------------------------------------------

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
    const noReason = String(obj.no_guidance_reason ?? '').trim();
    if (!goal && !noReason) throw new Error('既没有指导也没有静默原因（静默轮必须留痕原因）');
    const w = (obj.watch && typeof obj.watch === 'object') ? obj.watch : {};
    return {
        judgment: j,
        evidence,
        progressNote: String(obj.progress_note ?? '').slice(0, 300),
        goal,
        actionHint,
        noGuidanceReason: noReason,
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
    const o = (obj.ooc && typeof obj.ooc === 'object') ? obj.ooc : {};
    const items = (Array.isArray(o.items) ? o.items : []).map(it => (it && typeof it === 'object' ? it : {})).map(it => ({
        aspect: String(it.aspect ?? '').slice(0, 40),
        evidence: String(it.evidence ?? '').slice(0, 300),
        severity: ['轻微', '中等', '严重'].includes(it.severity) ? it.severity : '中等',
        fix: String(it.fix ?? '').slice(0, 300),
    }));
    const p = (obj.plot_repeat && typeof obj.plot_repeat === 'object') ? obj.plot_repeat : {};
    const s = (obj.style_repeat && typeof obj.style_repeat === 'object') ? obj.style_repeat : {};
    const g = (obj.guidance && typeof obj.guidance === 'object') ? obj.guidance : {};
    const goal = String(g.goal ?? '').trim();
    const actionHint = String(g.action_hint ?? '').trim();
    const noReason = String(obj.no_guidance_reason ?? '').trim();
    if (!goal && !noReason) throw new Error('既没有修正指导也没有静默原因（静默轮必须留痕原因）');
    const found = Boolean(o.found) && items.length > 0;
    return {
        // found=false 时 items 也保留：模型给的次级观察要进留痕显示，不丢（found 仍是介入闸的唯一依据）
        ooc: { found, items },
        plotRepeat: { found: Boolean(p.found), note: String(p.note ?? '').slice(0, 300) },
        styleRepeat: { level: ['无', '轻微', '明显'].includes(s.level) ? s.level : '无', note: String(s.note ?? '').slice(0, 300) },
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
    const worst = Math.max(sev, style, plot);
    if (level === 'low') return worst >= 2;    // 仅很轻微的发现（OOC／文风轻微）不发；剧情重复、中等及以上都发
    if (level === 'medium') return worst >= 1; // 有任何发现就发（轻微也发）
    return worst > 0;                          // high：与中同——档位差异体现在单位模式的发送频率
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

export function guidanceText(goal, actionHint) {
    return [goal, actionHint].filter(Boolean).map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
}

export function applyUnitOutcome(state, report, meta) {
    if (report.judgment === 'achieved' && state.unit && state.unit.nodeIdx < state.unit.nodes.length) {
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
        floors: meta.floorCount,
        ok: true,
        judgment: report.judgment,
        litNode: report.judgment === 'achieved' ? state.unit?.nodes[Math.max(0, state.unit.nodeIdx - 1)]?.title ?? '' : '',
        evidence: report.evidence,
        progressNote: report.progressNote,
        watch: report.watch,
        guidance: meta.guidance,
        noGuidanceReason: report.goal ? '' : report.noGuidanceReason,
        retried: Boolean(meta.retried),
        ...(meta.tokens ? { tokens: meta.tokens } : {}),
        ...(meta.materials ? { materials: meta.materials } : {}),
    };
    state.trace.unshift(rec);
    // 红点口径：卡死要人拍板、watch 抓到 OOC/假完成值得看一眼
    if (report.judgment === 'stuck') {
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
        },
        guidance: meta.guidance,
        // 以实际发没发为准：介入档拦下的轮次留原因（页内静默轮要显示全文）
        noGuidanceReason: meta.guidance ? '' : report.noGuidanceReason,
        retried: Boolean(meta.retried),
        ...(meta.tokens ? { tokens: meta.tokens } : {}),
        ...(meta.materials ? { materials: meta.materials } : {}),
    };
    state.trace.unshift(rec);
    const hasFinding = report.ooc.found || report.plotRepeat.found || report.styleRepeat.level !== '无';
    if (hasFinding) {
        state.dot = true;
        state.dotReason = `第${meta.round}轮轻量检查有发现：${[
            report.ooc.found ? `OOC×${report.ooc.items.length}` : '',
            report.plotRepeat.found ? '剧情重复' : '',
            report.styleRepeat.level !== '无' ? `文风重复（${report.styleRepeat.level}）` : '',
        ].filter(Boolean).join('、')}`;
    }
    return rec;
}

// 回归判定落账（第三十三轮）：不走例行轮的任何一笔——不加轮次、不碰指导线与作废标记、
// 不清失败计数；节点批量补点亮（只进不退）；偏大了才亮红点（要人拍板的事才打扰）
export function applyReentryOutcome(state, report, meta) {
    const before = state.unit?.nodeIdx ?? 0;
    const applied = Math.max(before, report.reached);
    if (state.unit) state.unit.nodeIdx = Math.min(applied, state.unit.nodes.length);
    const rec = {
        at: meta.at,
        round: state.round,          // 信息性显示：回归判定不是楼层轮，不推进轮次计数
        mode: 'reentry',
        ok: true,
        reentry: {
            window: meta.windowLabel,
            before,
            reached: report.reached,
            applied,
            nodesTotal: state.unit?.nodes.length ?? 0,
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
let holdToastShown = false;   // 扣发送提示一轮只弹一次
let lastPromptText = '';      // 最近一次判定（例行轮或回归判定）实际发出的提示词全文——只在内存留最近一份，
                              // 全文随楼层数线性膨胀，进存档会把聊天文件撑翻倍；面板「看提示词全文」读它

export function lastListenerPrompt() {
    return lastPromptText;
}

function writeSlot(text) {
    const cfg = listenerCfg();
    const d = Number(cfg.depth);
    setExtensionPrompt(SLOT_KEY, String(text ?? ''), POSITION_IN_PROMPT, Number.isFinite(d) && d >= 0 ? Math.floor(d) : 2, false, ROLE_SYSTEM);
}

export function clearListenerSlot() {
    setExtensionPrompt(SLOT_KEY, '', POSITION_IN_PROMPT, 2, false, ROLE_SYSTEM);
}

function modeOf(state) {
    if (state.unit && state.unit.nodeIdx < state.unit.nodes.length) return 'unit';
    return 'light';   // 无单位，或单位已演完等手动接续
}

// 世界书自选（第三十四轮用户拍板：角色资料都在世界书里、撤掉角色卡摘要这条独立材料线）：
// 勾选键存监听聊天块，复用第七轮 §6.10 的 resolveLorePicks——勾选即点名，不看关键词/常驻/
// 启用状态，整条原文不截断（十人卡体量两万字级，任何上限都是卡边）。稳定材料排进提示词前部
// 吃前缀缓存；返回 keys 给检索让位用（自选优先，同一条不进材料两次）
function assembleLorePicks(state) {
    const picks = resolveLorePicks(state.lorePicks);
    if (!picks.length) return { text: '', count: 0, chars: 0, keys: null };
    const text = picks.map(p => `【${p.book.name} / ${p.entry.comment ?? `条目 ${p.entry.uid + 1}`}】\n${p.entry.content}`).join('\n\n');
    return { text, count: picks.length, chars: text.length, keys: new Set(picks.map(p => p.key)) };
}

// 世界书命中拆成 {text, count}：text 进提示词、count 进材料清单（第三十三轮材料透明化）；
// excludeKeys＝自选条目键集，命中里让位防同一条进材料两次（第三十四轮）
function assembleLore(floorsText, excludeKeys = null) {
    const cfg = listenerCfg();
    if (!cfg.withLorebook) return { text: '', count: null };
    const hits = scanLorebooks(floorsText, excludeKeys ? { excludeKeys } : undefined);
    return { text: buildLoreContext(hits), count: hits.length };
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

// 记忆表（第三十五轮归位稳定段）：大而少变——体量可以到几万字（用户实测 4 万+）、变化只随
// 记忆更新不随轮次，排楼层后面会每轮跟着丢缓存整块全价。返回纯内容，空＝（无）由块标签兜底
function assembleMemory() {
    const cfg = listenerCfg();
    if (!cfg.withMemory) return '';
    return buildMemoryContext() ?? '';   // 全量口径（共用 1.0 召回规则）
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
    if (running) return { skipped: 'busy' };
    running = true;
    gate?.beginRound();
    holdToastShown = false;

    const mode = modeOf(state);
    const roundOwnerId = state.unit?.id ?? null;   // 本轮的主人：判完时单位槽若已换人（挂/卸/接回），产物整体作废
    const floorSig = floorsSignature(chat);
    const floors = limitFloors(collectFloorsFromChat(chat), Number(cfg.floorLimit) || 0);   // 楼层范围（第三十四轮）：成功与失败留痕同一个口径
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
        const floorsNote = cfg.floorLimit > 0 ? `最近 ${cfg.floorLimit} 层角色楼（楼层号为全聊天绝对号）` : undefined;
        const picks = assembleLorePicks(state);
        const lore = assembleLore(floorsText, picks.keys);
        const memoryText = assembleMemory();
        if (mode === 'unit') {
            messages = buildUnitPrompt({
                cfg,
                unit: state.unit,
                floorsText,
                floorsNote,
                picksText: picks.text,
                memoryText,
                loreHits: lore.text,
                lastGuidance: state.lastGuidance,
            });
        } else {
            messages = buildLightPrompt({
                cfg,
                floorsText,
                floorsNote,
                picksText: picks.text,
                memoryText,
                loreHits: lore.text,
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
            lorePicks: picks.count,
            picksChars: picks.chars,
            floors: nums.length ? { first: nums[0], last: nums[nums.length - 1], count: nums.length } : null,
            floorsLimited: cfg.floorLimit > 0,
            loreHits: lore.count,
            memory: Boolean(cfg.withMemory && memoryText),
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
            const text = guidanceText(report.goal, report.actionHint);
            writeSlot(text);   // 滚动覆写：静默轮写空串（旧指导不留到下一轮）
            applyUnitOutcome(state, report, { round, at, floorSig, floorCount: floors.filter(f => !f.isUser).length, guidance: text, retried: parsed.retried, tokens, materials });
        } else {
            const report = normalizeLightReport(parsed.result);
            const intervene = lightShouldIntervene(report, cfg.intervene) && report.goal;
            const text = intervene ? guidanceText(report.goal, report.actionHint) : '';
            if (!intervene && report.goal) report.noGuidanceReason = `介入档（${INTERVENE_LIGHT[cfg.intervene].label}）不够格：${report.noGuidanceReason || '本轮发现未达发送门槛'}`;
            writeSlot(text);
            applyLightOutcome(state, report, { round, at, floorSig, floorCount: floors.filter(f => !f.isUser).length, guidance: text, retried: parsed.retried, tokens, materials });
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
            round, at, mode,
            floorCount: floors.filter(f => !f.isUser).length,
            error: err?.message ?? String(err),
        });
        writeSlot('');   // 失败轮注入槽清空（判断点 10：宁可裸跑也不喂旧指导）
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
        const floors = limitFloors(collectFloorsFromChat(chat), Number(cfg.floorLimit) || 0);
        const floorsText = formatFloors(floors);
        const floorsNote = cfg.floorLimit > 0 ? `最近 ${cfg.floorLimit} 层角色楼（楼层号为全聊天绝对号）` : undefined;
        const picks = assembleLorePicks(state);
        const lore = assembleLore(floorsText, picks.keys);
        const memoryText = assembleMemory();
        const messages = buildReentryPrompt({
            unit: state.unit,
            windowLabel: win.label,
            windowText: win.text,
            floorsText,
            floorsNote,
            picksText: picks.text,
            memoryText,
            loreHits: lore.text,
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
            floorsLimited: cfg.floorLimit > 0,
            loreHits: lore.count,
            memory: Boolean(cfg.withMemory && memoryText),
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
        applyReentryOutcome(state, report, { at, windowLabel: win.label, tokens, materials });
        const capped = Math.max(1, Math.floor(Number(cfg.traceRounds) || 50));
        if (state.trace.length > capped) state.trace.length = capped;
        persistListener();
        updateWandDot(state);
        notifyPanel();
        return { ok: true, mode: 'reentry' };
    } catch (err) {
        if ((listenerState().unit?.id ?? null) !== unitId) {
            return { ok: false, voided: true };
        }
        const msg = String(err?.message ?? err).slice(0, 400);
        state.trace.unshift({ at: Date.now(), round: state.round, mode: 'reentry', ok: false, error: msg });
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
        clearTimeout(analyzeTimer);
        updateWandDot(st);
        notifyPanel();
    });

    // 扮演模型输出完毕（新楼层落地）：立即开跑判定（去抖 800ms 吸收事件抖动）
    eventSource.on(event_types.MESSAGE_RECEIVED, scheduleAnalyze);

    // 最后一楼被编辑/重生成：内容变了签名就变，自动重判；没变不吃轮
    eventSource.on(event_types.MESSAGE_EDITED, scheduleAnalyze);

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

// 手动点亮当前节点（两本账：用户的显式操作可改进度账——卡死拍板的出路之一）
export function manualLitCurrentNode() {
    const state = listenerState();
    if (!state.unit || state.unit.nodeIdx >= state.unit.nodes.length) return false;
    state.unit.nodeIdx += 1;
    state.dot = false;
    state.dotReason = '';
    persistListener();
    notifyPanel();
    return true;
}

// 挂载/卸下/接回/丢弃的操作出口（面板调用；带持久化与失败提示）。
// 换主人的三个操作（挂/卸/接回）同步清注入槽：旧指导是给旧主人写的，不清就会注入进下一轮生成
export function opMountUnit(unit) {
    const state = listenerState();
    const r = mountUnit(state, unit);
    if (r.ok) {
        clearListenerSlot();
        persistListener();
        flushChatData();
    }
    return r;
}

export function opUnmountUnit() {
    const state = listenerState();
    const r = unmountUnit(state);
    if (r.ok) {
        clearListenerSlot();
        persistListener();
    }
    return r;
}

export function opRecallSidelined() {
    const state = listenerState();
    const r = recallSidelined(state);
    if (r.ok) {
        clearListenerSlot();
        persistListener();
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
    return { key: 'light', label: '●轻量执勤', hint: '无挂载单位：OOC/剧情重复/文风重复三项检查' };
}
