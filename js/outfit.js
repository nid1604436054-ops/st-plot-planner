// 2.0 装扮（2026-09-02 设计定稿落码，DESIGN §6.4「场景元素卡」被本轮取代——范围收窄为
// 衣物与服饰，场景不管；产物从「两轮自动过期的状态句」改为「单元＋手动注入设置」）。
// 三件事：
//   ① 面板草稿（剧情指导页第 1 步「装扮」悬浮面板）：按角色行抓取装扮清单（轮换制复用
//      knowledge.grabFromList）＋两种成稿方式——纯抽取（零模型调用，勾选条目原文拼接）/
//      模型生成（每角色一次轻量选择调用：候选一小把＋可选世界书/最近对话 → 模型挑并写状态句）；
//      确认立为「装扮单元」（units.js 第三工具，多角色拼成一个）。
//   ② 当前装扮注入：独立注入槽（injection.js 的 applyOutfitSlot，深度＝监听深度＋1，
//      比监听指导更靠前、比 1.0 剧情注入更靠近末端），不受监听总开关管。默认持续注入；
//      监听页两框互斥联动「持续 / 注入几层楼」——层数随角色楼自动递减、可直接改数，
//      走完自动清框停注（两框都灰＝停注）。「撤下」进留痕；新装扮确认时旧的自动进留痕。
//   ③ 换装留痕：开始注入那一刻记一条（含装扮全文＋当时设置），到期/被覆盖/手动撤时补结束
//      状态；与判定轮共用监听页留痕滚动池（traceRounds 管）、带「换装」来源标签。
// 计层口径与 M4 注入一致：一层＝一条角色回复，滑动/重新生成楼数不变不吃层、删楼只减不增。
import { settings, newId } from "./settings.js";
import { loadChatData, saveChatData } from "./chatdata.js";
import { getTavernContext } from "./context.js";
import { chatCompletion, parseModelJson } from "./api.js";
import { applyOutfitSlot, revokeOutfitSlot, replyFloorCount } from "./injection.js";
import { pushTraceRecord } from "./listener.js";
import { entryText, findList, grabFromList } from "./knowledge.js";

// ---------------------------------------------------------------------------
// 每聊天状态（chatdata 的 outfit 块）
// ---------------------------------------------------------------------------

// 就地修补不换对象（第三十七轮 normalizeMatCfg 的教训原样适用）：outfitState() 在一次改动
// 中途可能被再调（outfitRemaining / settingLabel 都取一遍状态），换了新对象会把外层持有的
// 引用变成孤儿——就地改字段，任何一次取到的引用都是同一份
function normalizeRow(r) {
    // drawn = 这一行最近一次抓到的那把候选 id（照知识库面板：候选区只显示抓到的）；
    // picked = 其中勾上的（纯抽取正文＝勾中的拼接；模型生成的候选集＝勾中的）
    r.name = String(r?.name ?? '').slice(0, 60);
    r.listId = String(r?.listId ?? '');
    r.drawn = (Array.isArray(r?.drawn) ? r.drawn : []).map(String);
    r.picked = (Array.isArray(r?.picked) ? r.picked : []).map(String);
    r.pickCodes = (Array.isArray(r?.pickCodes) ? r.pickCodes : []).map(String);   // 模型选择自报的编号（透明显示用）
    r.text = String(r?.text ?? '');
    return r;
}

export function outfitState() {
    const state = loadChatData('outfit', () => ({ version: 1, draft: null, active: null }));
    state.draft = state.draft && typeof state.draft === 'object' ? state.draft : null;
    if (state.draft) {
        state.draft.rows = (Array.isArray(state.draft.rows) ? state.draft.rows : []).filter(r => r && typeof r === 'object');
        state.draft.rows.forEach(normalizeRow);
        state.draft.rows = state.draft.rows.filter(r => r.listId || r.name);
        state.draft.mode = state.draft.mode === 'gen' ? 'gen' : 'draw';
        state.draft.useChat = Boolean(state.draft.useChat);
        state.draft.chatFloors = Math.min(Math.max(Math.round(Number(state.draft.chatFloors) || 6), 1), 50);
        state.draft.providerId = String(state.draft.providerId ?? '');
        state.draft.title = String(state.draft.title ?? '').slice(0, 60);
    }
    state.active = state.active && typeof state.active === 'object' ? normalizeActive(state.active) : null;
    return state;
}

function normalizeActive(a) {
    a.unitId = String(a.unitId ?? '');
    a.title = String(a.title ?? '').slice(0, 120) || '装扮';
    a.text = String(a.text ?? '');
    a.mode = ['always', 'floors', 'none'].includes(a.mode) ? a.mode : 'always';
    a.layers = Math.max(1, Math.round(Number(a.layers) || 1));
    a.floorBase = Math.round(Number(a.floorBase)) || 0;
    a.at = Number(a.at) || Date.now();
    a.traceId = a.traceId == null ? null : String(a.traceId);
    a.settingText = String(a.settingText ?? '');
    return a;
}

export function persistOutfit() {
    saveChatData('outfit', outfitState());
}

// 面板草稿的缺省形状（首次打开面板时播种）
export function outfitDraft() {
    const st = outfitState();
    if (!st.draft) {
        st.draft = { rows: [], mode: 'draw', useChat: true, chatFloors: 6, providerId: '', title: '' };
    }
    return st.draft;
}

// ---------------------------------------------------------------------------
// 当前装扮：注入模式状态机
// ---------------------------------------------------------------------------

function outfitAge(active) {
    return Math.max(0, replyFloorCount() - (active.floorBase ?? 0));
}

// floors 模式的剩余层数（面板数字显示的就是它）；always/none 返回 null
export function outfitRemaining() {
    const active = outfitState().active;
    if (!active || active.mode !== 'floors') return null;
    return Math.max(0, active.layers - outfitAge(active));
}

function slotText(active) {
    return [
        '[装扮状态｜后台提示] 以下为相关角色当前的衣物与饰品状态。描写、动作与剧情安排须与之一致；除非剧情明确描写了换装，不得改变这些装扮；不必逐句复述，在穿着、动作与互动的自然细节里体现即可。',
        active.text,
    ].join('\n');
}

function notifyOutfitChanged() {
    if (typeof document === 'undefined') return;
    document.dispatchEvent(new CustomEvent('pp-listener-updated'));   // 监听页装扮区与留痕窗都听这个事件刷新
}

function syncSlot() {
    const active = outfitState().active;
    if (active && active.mode !== 'none' && String(active.text ?? '').trim()) applyOutfitSlot(slotText(active));
    else revokeOutfitSlot();
}

// 开始注入那一刻记留痕（含装扮全文＋当时设置）；结束状态（到期/被覆盖/手动撤）补在同一条上。
// 停注后再重新勾框＝新的注入段＝新记一条（旧条已带结束状态，不动）
function openTraceEntry(active, settingText) {
    const id = newId('ot-');
    active.traceId = id;
    active.settingText = settingText;
    pushTraceRecord({
        id,
        at: Date.now(),
        mode: 'outfit',
        src: 'outfit',
        ok: true,
        outfit: {
            title: active.title,
            setting: settingText,
            text: active.text,
            end: null,
        },
    });
}

// 给打开中的留痕条目补结束状态；没有打开中的（已到期补过／当时没开注入）就什么都不做
function stampTraceEnd(active, status) {
    if (!active?.traceId) return;
    const trace = loadChatData('listener', () => ({}));
    const arr = Array.isArray(trace.trace) ? trace.trace : [];
    const rec = arr.find(r => r?.id === active.traceId);
    if (rec?.outfit) rec.outfit.end = { status, at: Date.now() };
    saveChatData('listener', trace);
    active.traceId = null;
}

// 更新打开中条目的「当时设置」（持续⇄层数切换时同步，留痕里看到的设置与实际一致）
function syncTraceSetting(active) {
    if (!active?.traceId) return;
    const trace = loadChatData('listener', () => ({}));
    const arr = Array.isArray(trace.trace) ? trace.trace : [];
    const rec = arr.find(r => r?.id === active.traceId);
    if (rec?.outfit) rec.outfit.setting = active.settingText;
    saveChatData('listener', trace);
}

function settingLabel(active) {
    return active.mode === 'floors' ? `注入 ${active.layers - outfitAge(active)} 层` : '持续注入';
}

// 确认立单元后设为当前装扮：旧的自动进留痕（被覆盖），新的默认持续注入、立即写槽
export function activateOutfit(unit) {
    const st = outfitState();
    if (st.active) stampTraceEnd(st.active, '被覆盖');
    st.active = normalizeActive({
        unitId: String(unit?.id ?? ''),
        title: String(unit?.title ?? ''),
        text: String(unit?.text ?? ''),
        mode: 'always',
        layers: 1,
        floorBase: replyFloorCount(),
        at: Date.now(),
    });
    openTraceEntry(st.active, settingLabel(st.active));
    persistOutfit();
    syncSlot();
    notifyOutfitChanged();
}

// 撤下：进留痕（手动撤）、清槽清状态
export function withdrawOutfit() {
    const st = outfitState();
    if (!st.active) return false;
    stampTraceEnd(st.active, '手动撤下');
    st.active = null;
    persistOutfit();
    revokeOutfitSlot();
    notifyOutfitChanged();
    return true;
}

/**
 * 注入模式切换（监听页两框互斥联动的写点）。
 * mode: 'always' 持续 | 'floors' 注入 N 层 | 'none' 两个都灰＝停注。
 * floorsWanted 只在进 floors 时用（面板上填的剩余层数；缺省沿用现值或 20）。
 * 停注后（none）再勾任一框＝新的注入段：记新的留痕条目。
 */
export function setOutfitMode(mode, floorsWanted) {
    const st = outfitState();
    const active = st.active;
    if (!active) return;
    const wasStopped = active.mode === 'none';
    if (mode === 'floors') {
        active.mode = 'floors';
        const want = Math.max(1, Math.round(Number(floorsWanted) || (active.layers - outfitAge(active)) || 20));
        active.layers = outfitAge(active) + want;   // 剩余层数＝want（改数走这里：age 基线不动）
    } else if (mode === 'always') {
        active.mode = 'always';
    } else {
        active.mode = 'none';
    }
    if (wasStopped && mode !== 'none') {
        openTraceEntry(active, settingLabel(active));   // 重新开始注入＝新留痕条目
    } else {
        active.settingText = settingLabel(active);
        syncTraceSetting(active);
    }
    persistOutfit();
    syncSlot();
    notifyOutfitChanged();
}

// 直接改剩余层数（数字输入框）：层数总量＝已过层数＋新值；只剩 floors 模式有意义
export function setOutfitFloors(n) {
    const st = outfitState();
    const active = st.active;
    if (!active || active.mode !== 'floors') return;
    const want = Math.max(1, Math.round(Number(n) || 1));
    active.layers = outfitAge(active) + want;
    active.settingText = settingLabel(active);
    syncTraceSetting(active);
    persistOutfit();
    notifyOutfitChanged();
}

// 楼层落地时推进（index.js 的 MESSAGE_RECEIVED 接；不受监听总开关管）：
// 楼数净增推导（滑动/重新生成不吃层）；层数走完 → 自动清框停注＋留痕补「到期」
export function tickOutfitExpiry() {
    const st = outfitState();
    const active = st.active;
    if (!active || active.mode !== 'floors') return;
    if (outfitRemaining() > 0) {
        syncTraceSetting(active);   // 留痕里的「注入 N 层」跟着剩余数走
        return;
    }
    active.mode = 'none';
    stampTraceEnd(active, '到期');
    persistOutfit();
    revokeOutfitSlot();
    notifyOutfitChanged();
}

// 切聊天重放（index.js 的 CHAT_CHANGED 接）：按新聊天的 outfit 块写/清槽
export function replayOutfitSlot() {
    syncSlot();
}

// ---------------------------------------------------------------------------
// 轻量选择（每角色一次小调用，智力不衰减——主生成不带全库）
// ---------------------------------------------------------------------------

// 模型解析（监听 Provider 同款语义：''＝方案库第一条、'__main__'＝主连接、其他＝按 id 取）
export function resolveOutfitProvider(providerId) {
    const profs = settings.api.profiles ?? [];
    let chosen = null;
    const id = String(providerId ?? '');
    if (id && id !== '__main__') chosen = profs.find(p => p.id === id) ?? null;
    else if (!id) chosen = profs[0] ?? null;
    if (chosen?.baseUrl && chosen?.model) {
        return { name: `${chosen.name} · ${chosen.model}`, provider: { baseUrl: chosen.baseUrl, apiKey: chosen.apiKey, model: chosen.model, format: chosen.format ?? 'chat' } };
    }
    return { name: settings.api.model ? `主连接 · ${settings.api.model}` : '（未配置）', provider: null };
}

// 某张清单该用哪个模型：绑定的清单用绑定时配置的模型（没配＝方案库第一条），衣库清单用面板当次选的
export function providerForList(list, panelProviderId) {
    return resolveOutfitProvider(list?.bind?.providerId || panelProviderId);
}

/**
 * 轻量选择的提示词（纯函数，离线测试台与交付报告送审用同一份）。
 * 输入：角色名 / 候选条目（编号＋原文）/ 绑定世界书对照材料（可空）/ 最近对话窗口（可空）。
 * 输出契约：{ "pick": ["编号"], "text": "状态句" }——pick 必须从候选编号里选。
 */
export function outfitSelectMessages({ name, listName, candidates, wbText = '', chatText = '' }) {
    const candLines = (candidates ?? []).map(c => `【${c.code}】${c.text}`).join('\n');
    return [
        { role: 'system', content: [
            '你是角色装扮挑选师。用户正在为一台文字角色扮演挑选「当前装扮」：你会拿到一位角色的候选衣物/饰品清单（用户自建，用来替换模型自己的常见偏好），从中挑出合乎情境的一套，并为这位角色写一段装扮状态句。',
            '规则：',
            '- 必须从候选条目里选，不得自拟候选外的衣物或饰品；条目的核心特征（材质、颜色、款式、搭配关系）保持原样，只做穿着状态的组装；',
            '- 有世界书对照材料时，角色的设定、身份、场合以它为准；有最近对话时，场合与氛围以对话为准（在家不出门就不选正装）；两者都没有就按候选本身搭配出合理的一套；',
            '- 状态句是给扮演模型看的后台提示：写「她穿着什么、戴着什么、此刻是什么穿着状态」，一段话、两到四句；写实但不堆砌形容词；只描述装扮本身，不安排动作、不写剧情；',
            '- 选几条没有定数：搭配合理就够，可以一条（一件标志性饰品）也可以多条。',
            '字符串值里不要出现英文双引号（引用一律写中文「」），也不要在值内换行。',
            '只输出一个 JSON 对象，不输出任何其他文字：',
            '{',
            '  "pick": ["选中的候选编号，形如 1-03"],',
            '  "text": "该角色的装扮状态句"',
            '}',
        ].join('\n') },
        { role: 'user', content: [
            `## 角色\n${name}`,
            `## 候选清单 · ${listName}（装扮从这里选，不得自拟同类）\n${candLines}`,
            ...(wbText ? ['## 世界书对照材料（角色与场合设定）', wbText] : []),
            ...(chatText ? ['## 最近对话（判断当前场合用）', chatText] : []),
        ].join('\n\n') },
    ];
}

function normalizeSelectResult(obj, candidates) {
    if (!obj || typeof obj !== 'object') throw new Error('输出不是一个 JSON 对象');
    const valid = new Set((candidates ?? []).map(c => String(c.code)));
    const pick = (Array.isArray(obj.pick) ? obj.pick : []).map(x => String(x ?? '').trim()).filter(c => valid.has(c));
    const text = String(obj.text ?? '').trim();
    if (!text) throw new Error('状态句为空');
    return { pick: [...new Set(pick)], text };
}

/**
 * 跑一次轻量选择（面板「模型选择」按角色逐个调用）。thinkingOff 恒开（监听轻量同款口径：
 * 小调用开思考成本不划算）；解析坏输出走 parseModelJson 修复梯子。
 * @returns {Promise<{pick: string[], text: string}>}
 */
export async function runOutfitSelect({ name, list, candidates, wbText = '', chatText = '', provider = null }) {
    const messages = outfitSelectMessages({ name, listName: list?.name ?? '', candidates, wbText, chatText });
    const req = { messages, thinkingOff: true, ...(provider ? { provider } : {}) };
    const { result } = await parseModelJson(await chatCompletion(req), req);
    return normalizeSelectResult(result, candidates);
}

// 候选载荷：草稿行勾选的条目 → [{ code, text }]（code＝清单号-条目号，与知识库编号同构）
export function rowCandidates(row) {
    const list = findList(row.listId);
    if (!list) return [];
    const listPos = (settings.knowledge?.lists ?? []).indexOf(list) + 1;
    return (list.entries ?? []).filter(e => (row.picked ?? []).includes(e.id))
        .map(e => ({ code: `${listPos}-${e.code}`, text: entryText(list, e) || '（空条目）' }));
}

// 抓一把进候选区（轮换制）：drawn＝抓到的全部（默认全勾）、picked 同步重置；返回抓到的条目
export function drawForRow(row, n) {
    const list = findList(row.listId);
    if (!list) return [];
    const { picked } = grabFromList(list, n);
    row.drawn = picked.map(e => e.id);
    row.picked = [...row.drawn];
    row.pickCodes = [];
    return picked;
}

// 纯抽取正文：勾选条目原文逐条拼接（零模型调用）
export function drawRowText(row) {
    const list = findList(row.listId);
    if (!list) return '';
    return (list.entries ?? []).filter(e => (row.picked ?? []).includes(e.id))
        .map(e => entryText(list, e)).filter(Boolean).join('\n');
}
