// T2 单元制数据层：随机事件 / 路人反应两工具的暂存单元池（chatdata 的 units 块，按聊天走）。
// 单元 = 工具产物 { id, tool, badges, title, text, payload, at, inPlan }：
//   badges = 加工史（有序 ≤2，末位 = 当前所在工具；界面显示为卡左上/右上小标记，左 = 先经过的工具）；
//   text   = 拼给模型的材料正文（事件 = 标题+描述+已选走向，反应 = 反应口径全文），选走向/改卡面时重算；
//   payload = 工具原生数据（事件 {mode,title,description,options,choiceIdx,injectLayers}；
//             反应 = 反应卡字段 title/salience/immediate/aftermath/boundaries/floors/edited）；
//   payload.origin = 前因正文（导入产物专属，2026-08-26 E11）：生成时勾选的源单元 text 原样
//             嵌进本单元正文开头——原始单元删了链条也在，随分析发送/转注入都能同时看到两个
//             工具的内容（否则双徽章单元只剩最后一道工具的口径，「这件事」是什么模型无从得知）。
// 单元定则（2026-08-26 用户拍板，后续一切修改的准则）：单元 = 带标签的纯文本提示词块，像生产材料一样
// 作为纯粹提示词使用——立为单元时走向已裁剪（没选全砍、选了只留那个），入池后不可再改选。
// inPlan（是否随规划分析发送）只在向导第 1 步「插入单元」勾选区读写——工具面板只管生成，不管查看。
// 跨工具导入是两工具间唯一影响通道：只能导入「加工史里还没有本工具」的单元——同工具回流禁、
// 两标满禁由此结构性成立（两标满的单元加工史已含双方工具，哪个工具都进不去，套娃不可能）。
// 导入不消耗：原单元原地保留（可再导入重 roll、可自己注入），导入产物 = 加工史追加本工具的新单元。
// 池每工具 ≤3，满了界面禁生成；采纳规划不清池，清理走第 1 步「插入单元」区各组的清空键（只清本工具名下）
import { loadChatData, saveChatData } from "./chatdata.js";
import { newId } from "./settings.js";
import { composeReactionText } from "./reactions.js";

export const MAX_UNITS_PER_TOOL = 3;
// 2026-09-02 起「装扮」是第三个工具（outfit）：产物同样是单元（多角色拼成一个），确认立卡后
// 除入池参与规划外还成为「当前装扮」走独立注入通道（outfit.js）——池与徽章规则与另两工具同机
const TOOL_IDS = new Set(['event', 'reaction', 'outfit']);

// 存档读回清洗：badges 只认两工具 id、去重、≤2、末位必须是当前工具（乱了重置为出生标）；
// 其余字段收敛到合法类型。形状不对的条目整体丢弃
function normalizeUnit(u, tool) {
    if (!u || typeof u !== 'object' || !TOOL_IDS.has(tool)) return null;
    let badges = Array.isArray(u.badges) ? u.badges.filter(b => TOOL_IDS.has(b)) : [];
    badges = [...new Set(badges)];
    if (badges.length > 2) badges.length = 2;
    if (!badges.length || badges[badges.length - 1] !== tool) badges = [tool];
    return {
        id: String(u.id ?? newId('unit-')),
        tool,
        badges,
        title: String(u.title ?? '').slice(0, 60),
        text: String(u.text ?? ''),
        payload: (u.payload && typeof u.payload === 'object') ? u.payload : null,
        at: Number(u.at) || Date.now(),
        inPlan: Boolean(u.inPlan),
    };
}

// 旧版「顺带出预览剧情」存在 payload.preview 里的残留：读回时清掉（功能已删，不留僵尸字段）
function stripLegacyPreview(unit) {
    if (unit?.payload && 'preview' in unit.payload) delete unit.payload.preview;
    return unit;
}

// 单元池（含面板草稿：两个面板的意见草稿、两工具生成的未入池草稿——随聊天存，刷新不丢）
export function unitsState() {
    const state = loadChatData('units', () => ({
        version: 1,
        eventUnits: [],
        reactionUnits: [],
        outfitUnits: [],   // 装扮单元池（2026-09-02，与另两工具同机 ≤3）
        eventDraft: null,
        reactionDraft: null,
        eventNote: '',
        reactionNote: '',
    }));
    state.eventUnits = (Array.isArray(state.eventUnits) ? state.eventUnits : [])
        .map(u => stripLegacyPreview(normalizeUnit(u, 'event'))).filter(Boolean).slice(0, MAX_UNITS_PER_TOOL);
    state.reactionUnits = (Array.isArray(state.reactionUnits) ? state.reactionUnits : [])
        .map(u => normalizeUnit(u, 'reaction')).filter(Boolean).slice(0, MAX_UNITS_PER_TOOL);
    state.outfitUnits = (Array.isArray(state.outfitUnits) ? state.outfitUnits : [])
        .map(u => normalizeUnit(u, 'outfit')).filter(Boolean).slice(0, MAX_UNITS_PER_TOOL);
    // 两工具的生成草稿（先出草稿，点「立为单元」才入池）；再生成会整体换掉
    state.eventDraft = state.eventDraft && typeof state.eventDraft === 'object'
        ? normalizeUnit(state.eventDraft, 'event') : null;
    state.reactionDraft = state.reactionDraft && typeof state.reactionDraft === 'object'
        ? normalizeUnit(state.reactionDraft, 'reaction') : null;
    // 旧版「参考事件库」开关（2026-08-26 退役：大模型随机无条件看库防复刻，不再有勾选）：读回时清残留
    delete state.eventOpts;
    state.eventNote = String(state.eventNote ?? '');
    state.reactionNote = String(state.reactionNote ?? '');
    return state;
}

export function persistUnits() {
    saveChatData('units', unitsState());
}

// 导入规则（唯一铁则）：目标工具不在加工史里才可导入。
// 两标满的单元加工史含双方工具，对谁都返回 false——回流禁与满标禁一并成立
export function unitImportable(u, targetTool) {
    return TOOL_IDS.has(targetTool) && !(u?.badges ?? []).includes(targetTool);
}

// 前因段（导入产物专属，E11）：源单元正文原样嵌进开头——删掉原始单元不丢链条。
// 事件侧正文与事件转注入共用这一个措辞；反应侧的前因段在 reactions.js 自带
// （units→reactions 已有依赖，反向会成环）
export function eventOriginText(u) {
    const origin = String(u?.payload?.origin ?? '').trim();
    return origin
        ? `【前因｜来自路人反应单元——本事件顺着它描述的世界状态发展，不复写同一件事】\n${origin}\n\n`
        : '';
}

// 事件单元的材料正文：与旧版第 2 步拼进分析的同一格式（标题+描述+已选走向）；
// 自己给意见立的单元（mode=manual 或无标题描述）走【事件指导意见】格式。
// 导入产物前面带前因段（走向裁剪/重算都走这里，前因不会掉）
export function eventUnitText(u) {
    const p = u?.payload ?? {};
    let base;
    if (p.mode === 'manual' || (!String(p.title ?? '').trim() && !String(p.description ?? '').trim())) {
        base = `【事件指导意见】${String(p.description ?? '').trim()}`;
    } else {
        const opt = Number.isInteger(p.choiceIdx) ? (Array.isArray(p.options) ? p.options[p.choiceIdx] : null) : null;
        base = `【${p.title ?? ''}】${p.description ?? ''}`
            + (opt ? `\n已选走向：${opt.label ?? ''}（幕后提示：${opt.hint ?? ''}）` : '');
    }
    return eventOriginText(u) + base;
}

// 事件单元出厂：payload 补 mode/choiceIdx 缺省，text 按当前走向算好。
// sourceUnit = 本次生成导入的源单元（导入产物带双徽章 [对方工具, 事件]，左 = 先；
// 其正文存进 payload.origin 作为前因——E11 起导入只收一个，导入产物正文自带前因）
export function newEventUnit(payload, sourceUnit = null) {
    const origin = sourceUnit ? String(sourceUnit.text ?? '').trim() : '';
    const unit = normalizeUnit({
        id: newId('unit-'),
        tool: 'event',
        badges: sourceUnit ? ['reaction', 'event'] : ['event'],
        title: String(payload?.title ?? '').slice(0, 60),
        text: '',
        payload: {
            mode: payload?.mode ?? 'llm',
            title: String(payload?.title ?? ''),
            description: String(payload?.description ?? ''),
            options: Array.isArray(payload?.options) ? payload.options : [],
            choiceIdx: Number.isInteger(payload?.choiceIdx) ? payload.choiceIdx : null,
            injectLayers: Number(payload?.injectLayers) || 20,
            ...(origin ? { origin } : {}),
        },
        at: Date.now(),
        inPlan: false,
    }, 'event');
    unit.text = eventUnitText(unit);
    return unit;
}

// 立为单元时的走向裁剪（用户定则：单元 = 纯文本提示词块，入池即定稿）：
// 草稿上走向都没选 → 选项全部砍掉（单元只作参考材料）；选了一个 → 只保留那一个，其余砍掉。
// 裁完重算材料正文；入池后不可再改选走向（想换走向 = 重新生成一版）
export function finalizeEventDraft(unit) {
    const p = unit?.payload;
    if (!p) return unit;
    const options = Array.isArray(p.options) ? p.options : [];
    if (Number.isInteger(p.choiceIdx) && options[p.choiceIdx]) {
        p.options = [options[p.choiceIdx]];
        p.choiceIdx = 0;
    } else {
        p.options = [];
        p.choiceIdx = null;
    }
    unit.text = eventUnitText(unit);
    return unit;
}

// 反应单元出厂：payload = 反应卡字段（composeReactionText 的输入），text = 组装好的口径全文。
// 标题优先用模型给的短标题（与事件同款）；旧卡没有 title 字段才退回拿即时口径开头硬切。
// sourceUnit = 本次生成导入的事件单元（双徽章 + 前因存 payload.origin，正文由
// composeReactionText 织入——到期逐层重算也走它，前因不会掉）
export function newReactionUnit(card, sourceUnit = null, inPlan = false) {
    const origin = sourceUnit ? String(sourceUnit.text ?? '').trim() : '';
    const unit = normalizeUnit({
        id: newId('unit-'),
        tool: 'reaction',
        badges: sourceUnit ? ['event', 'reaction'] : ['reaction'],
        title: String(card?.title ?? card?.immediate ?? '').slice(0, 60),
        text: '',
        payload: {
            title: String(card?.title ?? ''),
            salience: card?.salience,
            immediate: String(card?.immediate ?? ''),
            aftermath: String(card?.aftermath ?? ''),
            boundaries: String(card?.boundaries ?? ''),
            floors: card?.floors,
            edited: Boolean(card?.edited),
            ...(origin ? { origin } : {}),
        },
        at: Date.now(),
        inPlan,
    }, 'reaction');
    unit.text = composeReactionText(unit.payload, 0);
    return unit;
}

// 插入对应工具的池头（最新在前）；池满返回 false（调用方提示先删）
export function addUnit(unit) {
    if (!unit) return false;
    const st = unitsState();
    const key = unit.tool === 'event' ? 'eventUnits' : unit.tool === 'outfit' ? 'outfitUnits' : 'reactionUnits';
    if (st[key].length >= MAX_UNITS_PER_TOOL) return false;
    st[key].unshift(unit);
    persistUnits();
    return true;
}

export function removeUnit(id) {
    const st = unitsState();
    st.eventUnits = st.eventUnits.filter(u => u.id !== id);
    st.reactionUnits = st.reactionUnits.filter(u => u.id !== id);
    st.outfitUnits = st.outfitUnits.filter(u => u.id !== id);
    persistUnits();
}

// 一键清理只清指定工具名下的暂存（其他工具的单元不受影响）
export function clearUnits(tool) {
    const st = unitsState();
    if (tool === 'event') st.eventUnits = [];
    else if (tool === 'reaction') st.reactionUnits = [];
    else if (tool === 'outfit') st.outfitUnits = [];
    else return;
    persistUnits();
}

// 装扮单元出厂（2026-09-02）：characters = [{ name, text }]（每角色一段装扮描写，纯抽取时
// text＝勾选条目原文拼接、模型生成时＝轻量选择写的状态句）。多角色拼成一个单元（用户拍板）。
// 立卡后由 outfit.js 设为「当前装扮」开始注入；正文按角色分段、开头带角色名
export function newOutfitUnit(characters = [], title = '') {
    const chars = (characters ?? []).filter(c => c && String(c.name ?? '').trim());
    const names = chars.map(c => String(c.name).trim());
    const unit = normalizeUnit({
        id: newId('unit-'),
        tool: 'outfit',
        badges: ['outfit'],
        title: String(title ?? '').slice(0, 60) || (names.length ? `装扮·${names.join('、')}` : '装扮'),
        text: '',
        payload: {
            characters: chars.map(c => ({ name: String(c.name).trim(), text: String(c.text ?? '').trim() })),
        },
        at: Date.now(),
        inPlan: false,
    }, 'outfit');
    unit.text = outfitUnitText(unit);
    return unit;
}

// 装扮单元材料正文：每角色「角色名：描写」一段；拼给规划（插入单元）与注入（快照）共用
export function outfitUnitText(u) {
    const chars = Array.isArray(u?.payload?.characters) ? u.payload.characters : [];
    return chars.map(c => `【${String(c.name ?? '').trim() || '角色'}】\n${String(c.text ?? '').trim()}`).join('\n\n');
}
