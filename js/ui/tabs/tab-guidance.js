// 剧情指导页签：分步规划向导（三步：材料→确认→结果；分析实时输出页不占步骤，开始分析自动进）+ 随机事件工具区 + 游戏玩法工具区（底部）
// ① 收集确认（本地检索材料 + 记忆表格档位（停用/标签/常驻）+ 标签勾选与每表最新行补底 + 游戏玩法勾选
// + 随机事件/路人反应两个现场工具的入口键（板块各住一个悬浮面板，产物都是「单元」，见 units.js）
// + 「插入单元」勾选（入池单元参不参与本次分析在这里定——单元是整块提示词，选不选是规划侧的事）
// + 剧情构思；
// 这些勾选按对话记忆存聊天数据，同一对话做完一轮回来不用重勾；预设不在本页勾——已全局化，
// 「设置」页启用后插件发给大模型的任何调用都自动带上）
// → ② 分析前确认（逐行核对插入的单元/玩法/联网搜索，点「开始分析」才真正调模型，自动进分析实时输出页）
// → ③ 人工二检（OOC/剧情重复/文风重复/进度 + 规划文本：重新生成 / 确认采用 / 放弃保存）
// 确认采用的规划存为「进行中剧情」（story.js，跟聊天数据走）并自动绑定一条剧情注入（换剧情自动换内容，完结自动撤下）；
// 单元池不随采用清空，清理由各工具面板的一键清理键手动执行。
// 向导进度留底 + 自由跳转（调试排版用）：进行中的向导状态实时快照存 chatdata 的 wizard 块
// （按聊天身份走），刷新页面重开本页自动回到离开的那一步——已生成未处理的规划停在第 3 步等操作；
// 页首常驻 ①②③ 跳转条随时互跳（已填内容与生成结果保留），跳进没有生成结果的第 3 步可直接往规划框填字看排版。
// 另有「检查当前剧情」：对照进行中剧情出执行报告（完成度/推进/文风/OOC/其他/建议）
// 掷骰入口只有随机事件工具面板；页面下部工具区（tab-events.js）只放事件库配置与 AI 建库；
// 游戏玩法（tab-storage.js）追加挂在底部折叠区容器里与它们并列（条目库管理 + AI 玩法咨询都在该区——
// 生成类功能不进向导运行区），生效条目由第 1 步勾选随分析发送，检查报告（runStoryReview）自动附带当前生效条目；
// 「生效中的隐身注入」折叠区（tab-events.js）也在该容器末尾——注入管理与注入相关工具同住底部工具区
import { runPlotGuidance, runStoryReview, buildGuidanceMessages, collectStats, startResearchPrefetch, guidanceResearchInputs } from "../../planner.js";
import { generateRandomEvent, generateFreeRandomEvent, generateAiChoiceRandomEvent, rollEventPipeline, commitRolledEvent } from "../../randomEvents.js";
import { addInjection, updateInjection, removeInjection } from "../../injection.js";
import { settings, save, newId } from "../../settings.js";
import { storyState, activeStory, confirmPlot, endActive, attachReport, deleteStory, clearHistory } from "../../story.js";
import { generateReactionCard, composeReactionText } from "../../reactions.js";
import { renderEventsTools, renderInjectionTools } from "./tab-events.js";
import { renderStorageTools } from "./tab-storage.js";
import { storageItemsInEffect } from "../../store.js";
import { memoryState } from "../../memoryTable.js";
import { getTavernContext } from "../../context.js";
import { loadChatData, saveChatData } from "../../chatdata.js";
import { escapeHtml, estimateTokens } from "../../utils.js";
import { searchToolReady, withGlobalPresets } from "../../api.js";
import { unitsState, persistUnits, newEventUnit, newReactionUnit, addUnit, removeUnit, clearUnits, unitImportable, eventUnitText, eventOriginText, finalizeEventDraft, MAX_UNITS_PER_TOOL } from "../../units.js";

// 向导状态机：'' 空闲 | collect ① | ready ② 分析前确认 | running 分析实时输出页（不占跳转条步骤）| result ③ | reviewing/report 检查报告
let step = '';
const run = {
    note: '',            // 剧情构思方向
    gpIds: null,         // 本次随分析发送的游戏玩法条目 id；null = 未初始化（进第 1 步时默认勾当前生效的）
    result: null, raw: '', hits: 0, planText: '', reviseNote: '',
    hadActive: false,   // 本次分析发起时是否存在进行中剧情（第 3 步「剧情进度」行只在这种时候显示）
    memModes: null,      // 第 1 步第一层：每张表的召回档位 { [uid]: 'off' 停用 | 'tags' 按标签 | 'always' 常驻全量 }；null = 未动过（全部常驻全量，与旧默认一致）
    memTags: [],         // 「标签」档的表按哪些标签召回（勾选的标签名，对所有标签档的表生效）
    memRecent: 0,        // 「标签」档的表无论标签都另附的表尾最新行数；0 = 不另附（行没有时间戳，新记录在表尾）
    readyFrom: 'collect', // 分析前确认页的「返回」回到哪一步
    research: null,      // 「分析前确认」页预跑的联网判断 {fingerprint, promise}；分析时指纹对不上自动作废
};
// 两工具生成在途标志（瞬时态，不入 run 也不入快照）
let rxBusy = false, evBusy = false;
// 工具面板里的跨工具导入选材（勾选中的对方单元 id；瞬时态，切聊天时清）
const evImports = new Set(), rxImports = new Set();
// 进行中剧情全文 / 历史列表是否展开；历史里展开查看的条目 id（均只存内存）
let showActive = false, showHistory = false, viewHistId = null;
let report = null;      // 最近一次检查报告（内存缓存，正式存档在 story 条目上）

// ---------------------------------------------------------------------------
// 向导进度快照（chatdata 的 wizard 块，按聊天身份走）：刷新页面后从离开的那一步继续，
// 已生成未处理的规划停在第 3 步等操作。每次重渲染与输入改动都落一次快照（数据量 KB 级，
// 只写 localStorage 热层，不碰聊天文件）；确认采用 / 取消向导时清空。检查报告流（reviewing/
// report）不是向导状态，persistWizard 对非向导步骤直接跳过——第 3 步还没处理的生成结果
// 不会被一次检查报告冲掉。research 持有 Promise、busy 是进行中标志，都不入快照：
// 恢复后进「分析前确认」页会按需重新预跑。随机事件/路人反应的单元与面板草稿不在快照里——
// 它们存 chatdata 的 units 块（units.js），与向导进度各自独立、采用后也保留
// ---------------------------------------------------------------------------

const WIZARD_STEPS = ['collect', 'ready', 'running', 'result'];

function persistWizard() {
    if (!WIZARD_STEPS.includes(step)) return;
    saveChatData('wizard', {
        version: 2,
        step,
        run: { ...run, research: undefined },
    });
}

function clearWizard() {
    saveChatData('wizard', null);
}

// v1 快照（五步版：随机事件是向导第 2 步、反应卡是 run.reaction）→ v2 归一化：
// 旧第 2 步攒下的事件卡/意见转成事件工具的暂存单元，第 1 步的反应卡转成反应单元
// （池每边只有 3 格，满了让位丢弃）；事件步骤号收窄进「分析前确认」。
// 转换只发生一次（下次落盘就是 v2），用户在升级瞬间不丢攒到一半的东西
function migrateSnapshotV1(snap) {
    const r = snap.run ?? {}, e = snap.ev ?? {};
    let touched = false;
    const evCard = e.event;
    if (evCard && typeof evCard === 'object' && String(evCard.title ?? evCard.description ?? '').trim()) {
        const u = newEventUnit({ ...evCard, mode: e.mode ?? 'llm', choiceIdx: typeof e.choiceIdx === 'number' ? e.choiceIdx : null });
        u.inPlan = Boolean(String(r.eventText ?? '').trim());
        touched = addUnit(u) || touched;
    } else if (String(r.eventText ?? '').trim()) {
        const u = newEventUnit({ mode: 'manual', title: r.event?.title ?? '', description: r.eventText });
        u.inPlan = true;
        touched = addUnit(u) || touched;
    }
    const rx = normalizeReactionCard(r.reaction);
    if (rx) touched = addUnit(newReactionUnit(rx, null, rx.inPlan)) || touched;
    if (touched) toastr.info('旧向导里的事件/反应已转成暂存单元（在两个工具面板里）');
    return {
        version: 2,
        step: snap.step === 'event' ? 'ready' : snap.step,
        run: { ...r, event: undefined, eventText: undefined, rxNote: undefined, reaction: undefined, readyFrom: 'collect' },
    };
}

// 恢复入口：向导空闲（刚刷新 / 刚切聊天重置完）且本聊天存有快照时，把状态装回去。
// 分析在途（running）碰上刷新没法续传，回「分析前确认」重新发起
let restoring = false;   // 恢复渲染期间不触发联网判断预跑——刷新恢复不该无声花一次轻量调用

function restoreWizard(container) {
    if (step) return;   // 向导进行中：内存是权威，不用旧快照覆盖
    let snap = loadChatData('wizard', null);
    if (!snap) return;
    if (snap.version === 1) snap = migrateSnapshotV1(snap);
    if (snap.version !== 2) return;
    const r = snap.run ?? {};
    Object.assign(run, {
        note: r.note ?? '',
        gpIds: Array.isArray(r.gpIds) ? r.gpIds : null,
        result: r.result ?? null,
        raw: r.raw ?? '',
        hits: r.hits ?? 0,
        planText: r.planText ?? '',
        reviseNote: r.reviseNote ?? '',
        hadActive: Boolean(r.hadActive),
        memModes: normalizeMemModes(r.memModes) ?? memModesFromLegacy(r),
        memTags: Array.isArray(r.memTags) ? r.memTags : [],
        memRecent: Math.max(0, Math.round(Number(r.memRecent) || 0)),
        readyFrom: 'collect',
        research: null,
    });
    const target = snap.step === 'running' ? 'ready' : snap.step;
    if (!WIZARD_STEPS.includes(target)) return;
    step = target;
    restoring = true;
    renderMain(container);
    restoring = false;
    toastr.info('已恢复上次的向导进度');
}

// ---------------------------------------------------------------------------
// 步骤跳转条：向导进行中页首常驻，①②③随时互跳（已填内容与生成结果保留）。
// 2026-08-26 用户拍板四步并三步——「生成」不是独立步骤（闲时点它也只是落回②确认页），
// 分析中的实时输出页保留在状态机里（running：开始分析自动进入、分析在途点②回来、完账自动跳③），
// 只是不再占用跳转条一格，运行中②格保持高亮
// ---------------------------------------------------------------------------

function stepNavHtml() {
    const cur = step;
    const items = [
        ['collect', '① 材料', '第 1 步 · 收集确认：材料与勾选（随机事件/路人反应两个工具在此进）'],
        ['ready', '② 确认', '第 2 步 · 分析前确认：核对随分析插入的单元、玩法与联网搜索开关，点「开始分析」才调模型；分析在途时点这里回到实时输出页'],
        ['result', '③ 结果', '第 3 步 · 人工二检：检查结果与规划文本；没有生成结果时进去是空白二检页，可直接往规划框里填字试排版'],
    ];
    return `<div class="pp-gd-stepnav">${items.map(([id, label, tip]) =>
        `<span class="menu_button${cur === id || (id === 'ready' && cur === 'running') ? ' pp-gd-navcur' : ''}" data-goto="${id}" title="${tip}。三步随时互跳，已填内容与生成结果保留，刷新页面后也从这一步继续">${label}</span>`).join('')}</div>`;
}

function gotoStep(container, target) {
    if (target === step || !WIZARD_STEPS.includes(target)) return;
    if (target === 'collect') return startCollect(container);   // 与正常入口同一套：勾选从对话记忆恢复、玩法补默认
    if (target === 'ready' && analyzeBusy) {   // 分析还在跑：点 ② 回到的是实时输出页，不给再来一张确认页（防重复发起白花调用）
        step = 'running';
        renderMain(container);
        return;
    }
    step = target;
    renderMain(container);
}

// ---------------------------------------------------------------------------
// 悬浮查看器：居中大窗盖在页面上（标题栏 + 右上关闭 + 统计行 + 可滚正文）。
// 路人反应卡与「查看完整提示词」共用——长内容弹窗看，不摊在页面里把面板撑长；
// Esc、点窗外遮罩空白、右上 × 三路都能关。窗挂在 document.body（不在抽屉里），
// 切聊天时由 resetGuidance 一并关掉
// ---------------------------------------------------------------------------

let viewerEsc = null;   // Esc 关窗的监听引用，关窗时摘掉防泄漏

function closeViewer() {
    if (viewerEsc) { document.removeEventListener('keydown', viewerEsc); viewerEsc = null; }
    document.querySelector('.pp-viewer-mask')?.remove();
}

// statHtml = 标题栏下的统计行（可空）；返回遮罩元素，调用方往 .pp-viewer-body 里填内容挂控件
function openViewer(title, statHtml = '') {
    closeViewer();
    const mask = document.createElement('div');
    mask.className = 'pp-viewer-mask';
    mask.innerHTML = `
    <div class="pp-viewer" role="dialog" aria-label="${escapeHtml(title)}">
        <div class="pp-viewer-head">
            <b>${escapeHtml(title)}</b>
            <span class="menu_button pp-viewer-close fa-solid fa-xmark" title="关闭（Esc 或点窗外空白处也行）"></span>
        </div>
        ${statHtml ? `<div class="pp-viewer-stat">${statHtml}</div>` : ''}
        <div class="pp-viewer-body"></div>
    </div>`;
    document.body.appendChild(mask);
    viewerEsc = e => { if (e.key === 'Escape') closeViewer(); };
    document.addEventListener('keydown', viewerEsc);
    mask.addEventListener('mousedown', e => { if (e.target === mask) closeViewer(); });
    mask.querySelector('.pp-viewer-close').addEventListener('click', closeViewer);
    return mask;
}

// 复制到剪贴板：优先剪贴板 API，非安全上下文/未授权退回 execCommand
async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch { /* 退回 execCommand */ }
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { /* 环境连 execCommand 都不给，认栽 */ }
    ta.remove();
    return ok;
}

// 检索高亮：原文按命中切开逐段转义、命中段包 <mark>（在转义后文本上匹配会踩中转义序列的坑），
// 大小写不敏感；返回拼好的 html 与命中数
function markMatches(text, q) {
    const lower = text.toLowerCase();
    const lq = q.toLowerCase();
    let html = '', i = 0, count = 0;
    for (;;) {
        const j = lower.indexOf(lq, i);
        if (j < 0) { html += escapeHtml(text.slice(i)); break; }
        html += escapeHtml(text.slice(i, j)) + '<mark>' + escapeHtml(text.slice(j, j + q.length)) + '</mark>';
        count++;
        i = j + q.length;
    }
    return { html, count };
}

// ---------------------------------------------------------------------------
// 第 1 步勾选按对话记忆（chatdata.js 的 picks 块）：记忆表格的每表档位/标签/最新行数、
// 游戏玩法的勾选都按对话各自记住——同一对话做完一轮规划回来不用重勾，换对话各用各的。
// 预设不在这里：已全局化，「设置」页的启用开关是唯一开关。run 是工作副本，进第 1 步时
// 从这里恢复；每次勾选变动立即写回
// ---------------------------------------------------------------------------

// 档位读回清洗：只认 off/tags/always；没有任何非默认档位时归一成 null（= 默认全常驻）
function normalizeMemModes(m) {
    if (!m || typeof m !== 'object') return null;
    const out = {};
    let touched = false;
    for (const [uid, v] of Object.entries(m)) {
        if (v === 'off' || v === 'tags' || v === 'always') {
            out[uid] = v;
            if (v !== 'always') touched = true;
        }
    }
    return touched ? out : null;
}

// 旧存档（表范围勾选 memSheets + 全局「按标签匹配」开关 memMatch）→ 档位迁移：
// 勾掉的表 = 停用，其余 = 当年开着标签匹配 ? 标签 : 常驻；没有旧字段返回 null（新存档）
function memModesFromLegacy(r) {
    if (r.memSheets === undefined && r.memMatch === undefined) return null;
    const state = memoryState();
    const uids = state.mirror.sheets.map(s => s.uid);
    const picked = Array.isArray(r.memSheets) ? new Set(r.memSheets) : null;
    const out = {};
    for (const uid of uids) out[uid] = picked && !picked.has(uid) ? 'off' : (r.memMatch ? 'tags' : 'always');
    return normalizeMemModes(out);
}

// 反应卡快照读回清洗：字段截断到合法区间；快照缺失/形状不对（老版本存的）返回 null。
// text 为空时按卡面重算（渲染时兜底，这里不调 composeReactionText——那是 reactions.js 的活）
function normalizeReactionCard(rx) {
    if (!rx || typeof rx !== 'object' || !String(rx.immediate ?? '').trim()) return null;
    return {
        salience: Math.min(Math.max(Math.round(Number(rx.salience) || 2), 1), 5),
        immediate: String(rx.immediate ?? ''),
        aftermath: String(rx.aftermath ?? ''),
        boundaries: String(rx.boundaries ?? ''),
        floors: Math.min(Math.max(Number(rx.floors) || 6, 2), 30),
        text: String(rx.text ?? ''),
        edited: Boolean(rx.edited),
        inPlan: Boolean(rx.inPlan),
    };
}

// 单元卡头：加工史徽章（左＝先经过的工具，右＝后经过的；空位占位保持多卡标题对齐）+ 标题
const TOOL_MARK = { event: '事', reaction: '反' };
const TOOL_NAME = { event: '随机事件', reaction: '路人反应' };

function unitMarkHtml(b) {
    return b
        ? `<span class="pp-unit-mark" title="加工史标记（左＝先经过的工具，右＝后经过的）：${TOOL_NAME[b]}">${TOOL_MARK[b]}</span>`
        : '<span class="pp-unit-mark pp-unit-mark-empty"></span>';
}

function unitHeadHtml(unit) {
    return `<div class="pp-unit-head">${unitMarkHtml(unit.badges[0])}<div class="pp-gd-evtitle">${escapeHtml(unit.title || '(未命名)')}</div>${unitMarkHtml(unit.badges[1])}</div>`;
}

// 这个单元当前是否有生效中的注入（注入创建时带 unitId，按它对账；外聊的不算）
const unitInjected = u => settings.injections.some(i => i.enabled && i.unitId === u.id
    && !(i.scope === 'chat' && i.chatId !== undefined && i.chatId !== getTavernContext().chatId));

// 第 1 步「插入单元」区展开状态：点单元名开合，跨重画保留（切聊天时在 resetGuidance 清）
const expandedUnits = new Set();

// 第 1 步「插入单元」区行：勾选框（插入规划）+ 完整加工史徽章（左＝先、右＝后）+ 单元名（点开看全文与操作）。
// 已注入的反应单元灰显不可勾——生效注入会让规划与检查自动附带同一口径，再勾就是同文进两次
function unitPickRow(u) {
    const injected = u.tool === 'reaction' && unitInjected(u);
    const tip = `${TOOL_NAME[u.tool]}单元。勾选后作为整块材料随分析发送` + (injected ? '；已转隐身注入，规划与检查自动附带这份正文，不用再勾' : '');
    return `<div class="pp-gd-urow">
        <label title="${escapeHtml(tip)}"><input type="checkbox" data-c1u="${escapeHtml(u.id)}" ${u.inPlan ? 'checked' : ''} ${injected ? 'disabled' : ''}/></label>
        <span class="pp-gd-ubody" data-uview="${escapeHtml(u.id)}" title="点开/收起这个单元的提示词全文与操作">${unitMarkHtml(u.badges[0])}${unitMarkHtml(u.badges[1])} ${escapeHtml(u.title || '(未命名)')}${injected ? '（已注入·自动附带）' : ''}</span>
    </div>`;
}

// 反应卡结构化卡面（草稿卡与单元区展开卡共用）：显著性星级 + 即时口径 + 余波口径 + 底线分栏 + 楼层预算 + 注入正文预览。
// 2026-08-26 恢复 E7 原显示——定则的「单元 = 纯文本提示词块」管的是发给模型的材料语义，卡面展示保留生成结果的原有形态，
// 不做整块纯文本替换（E8 一度替换成组装全文，用户点名退回）
function rxCardFieldsHtml(unit) {
    const card = unit.payload ?? {};
    const stars = '★'.repeat(card.salience) + '☆'.repeat(5 - card.salience);
    return `
    <div>显著性 <span style="color:#e8c06a">${stars}</span>（${card.salience}/5）</div>
    <label class="pp-label">即时反应口径（每轮 1-3 句，织进当前场景，写一次就够）</label>
    <div>${escapeHtml(card.immediate)}</div>
    <label class="pp-label">余波口径（消息传开/平息的方向，不写场面）</label>
    <div>${escapeHtml(card.aftermath)}</div>
    <label class="pp-label">底线</label>
    <div>${escapeHtml(card.boundaries)}</div>
    <label class="pp-label" title="转注入用的就是下面这份预览文本；改过就按这份固定，注入后只按层数过期。随分析发送走第 1 步「插入单元」勾选，用的也是这份文本">楼层预算（一层 = 一条角色回复，user 消息不计；到期自动撤下）</label>
    <input data-rxu-floors="1" class="text_pole textarea_compact" type="number" min="2" max="30" value="${card.floors}" />
    <label class="pp-label">注入正文预览（可改）</label>
    <textarea data-rxu-text="1" class="text_pole textarea_compact" rows="10">${escapeHtml(unit.text)}</textarea>`;
}

// 结构化卡面字段接线（E7 原逻辑抽出共用）：楼层预算夹 2-30，未手改正文时按新预算重算预览；正文一改即冻结为手写版
function wireRxCardFields(cardEl, unit) {
    const floorsEl = cardEl.querySelector('[data-rxu-floors]');
    const textEl = cardEl.querySelector('[data-rxu-text]');
    floorsEl.addEventListener('change', () => {
        unit.payload.floors = Math.min(Math.max(Number(floorsEl.value) || unit.payload.floors, 2), 30);
        floorsEl.value = unit.payload.floors;
        if (!unit.payload.edited) { unit.text = composeReactionText(unit.payload, 0); textEl.value = unit.text; }
        persistUnits();
    });
    textEl.addEventListener('input', () => { unit.text = textEl.value; unit.payload.edited = true; persistUnits(); });
    return { textEl };
}

// 单元区展开卡：事件卡＝描述正文；反应卡＝原结构化卡面（见 rxCardFieldsHtml）。
// 转注入/层数/删除全在这里（工具面板只管生成，不存放单元）
function unitAreaCardHtml(u) {
    if (u.tool === 'event') {
        return `<div class="pp-item pp-gd-evcard" data-ucard="${escapeHtml(u.id)}">
            <div class="pp-gd-evdesc">${escapeHtml(u.text ?? '')}</div>
            <div class="pp-btn-row pp-gd-evops">
                <label title="隐身注入多少层后自动撤下；一层 = 一条角色回复（user 消息不计）">注入层数
                    <input type="number" class="text_pole" data-ua-layers="1" min="1" max="200" step="1" value="${(u.payload ?? {}).injectLayers ?? 20}" />
                </label>
                <span data-ua-inject="1" class="menu_button" title="把事件与已选走向直接写成一条隐身注入（模型可见、聊天界面不显示），按所填层数到期自动撤下；不经过分析，也不影响这个单元在「插入单元」的勾选。立卡时没选走向的单元转不了注入（只作参考材料）">转为隐身注入</span>
                <span data-ua-del="1" class="menu_button fa-solid fa-trash" title="从暂存池删除这个单元（已转隐身注入的不受影响）"></span>
            </div>
        </div>`;
    }
    return `<div class="pp-item pp-gd-evcard" data-ucard="${escapeHtml(u.id)}">
        ${rxCardFieldsHtml(u)}
        <div class="pp-btn-row pp-gd-evops">
            <span data-ua-inject="1" class="menu_button" title="转为隐身注入（模型可见、聊天界面不显示），按楼层预算到期自动撤下；生效期间规划与检查自动附带同一口径，「插入单元」的勾选自动取消；本单元留在暂存里不消耗">转为隐身注入</span>
            <span data-ua-del="1" class="menu_button fa-solid fa-trash" title="从暂存池删除这个单元（已转隐身注入的不受影响）"></span>
        </div>
    </div>`;
}

// 单元区展开卡接线：rerender = 单元区重画（行上的勾选/已注入态跟着变），refreshCounts = 入口键暂存计数刷新。
// 事件注入要求立卡时选过走向（裁剪后只剩那一个）；反应注入沿用「注入即取消插入勾选」防同文双算
function wireUnitAreaCard(cardEl, unit, rerender, refreshCounts) {
    if (unit.tool === 'event') {
        const p = unit.payload ?? (unit.payload = {});
        const layersEl = cardEl.querySelector('[data-ua-layers]');
        layersEl.addEventListener('input', () => {
            const v = Number(layersEl.value);
            if (Number.isFinite(v)) { p.injectLayers = v; persistUnits(); }
        });
        layersEl.addEventListener('change', () => {
            p.injectLayers = clampInjectLayers(p.injectLayers);
            persistUnits();
            layersEl.value = String(p.injectLayers);
        });
        cardEl.querySelector('[data-ua-inject]').addEventListener('click', () => {
            const opt = Number.isInteger(p.choiceIdx) ? (p.options ?? [])[p.choiceIdx] : null;
            if (!opt) {
                toastr.warning('这个单元立卡时没选走向，只作参考材料；要注入请在生成草稿时选一个走向');
                return;
            }
            const injLayers = clampInjectLayers(p.injectLayers);
            addInjection({
                id: newId('inj-'),
                label: `事件：${p.title ?? ''} · ${opt.label ?? ''}`,
                mode: 'open',
                content: eventOriginText(unit) + `【随机事件·${p.title ?? ''}】${p.description ?? ''}\n已选定走向：${opt.label ?? ''}\n幕后提示：${opt.hint ?? ''}`,
                depth: 4,
                role: 'system',
                scope: 'chat',
                enabled: true,
                source: 'event',
                unitId: unit.id,
                createdAt: Date.now(),
                expires: { type: 'layers', layers: injLayers },
            });
            toastr.success(`已注入，${injLayers} 层后自动撤下（页面底部「生效中的隐身注入」可提前撤下）`);
        });
    } else {
        const { textEl } = wireRxCardFields(cardEl, unit);
        cardEl.querySelector('[data-ua-inject]').addEventListener('click', () => {
            const text = textEl.value.trim();
            if (!text) { toastr.warning('注入内容为空'); return; }
            const auto = composeReactionText(unit.payload, 0);
            const reaction = unit.payload.edited && text !== auto ? { ...unit.payload, edited: true } : unit.payload;
            addInjection({
                id: newId('inj-'),
                label: unit.title ? `路人反应：${unit.title}` : '路人反应',
                mode: 'open',
                content: text,
                depth: 4,
                role: 'system',
                scope: 'chat',
                enabled: true,
                source: 'reaction',
                unitId: unit.id,
                createdAt: Date.now(),
                expires: { type: 'layers', layers: unit.payload.floors },
                reaction,
                age: 0,
            });
            toastr.success(unit.inPlan
                ? `已注入，${unit.payload.floors} 层后自动撤下；生效期间规划与检查自动附带同一口径，已同时取消「插入单元」的勾选`
                : `已注入，${unit.payload.floors} 层后自动撤下（一层 = 一条角色回复；生效期间规划与检查报告自动附带同一口径，页面底部「生效中的隐身注入」可提前撤下）`);
            unit.inPlan = false;
            persistUnits();
            rerender();
        });
    }
    cardEl.querySelector('[data-ua-del]').addEventListener('click', () => {
        removeUnit(unit.id);
        expandedUnits.delete(unit.id);
        rerender();
        refreshCounts();
    });
}

// 第 1 步口径读回（不动 run）：检查报告也用它继承向导口径——报告不依赖向导正在不在第 1 步，
// 读的就是这份按对话存的勾选（第 1 步每次变动立即写回，永远与所见一致）
function readMemPicks() {
    const p = loadChatData('picks', null);
    if (!p) return { memModes: null, memTags: [], memRecent: 0, gpIds: null };
    return {
        memModes: normalizeMemModes(p.memModes) ?? memModesFromLegacy(p),
        memTags: Array.isArray(p.memTags) ? p.memTags : [],
        memRecent: Math.max(0, Math.round(Number(p.memRecent) || 0)),
        gpIds: Array.isArray(p.gpIds) ? p.gpIds : null,
    };
}

function applyPicks() {
    const p = readMemPicks();
    run.memModes = p.memModes;
    run.memTags = p.memTags;
    run.memRecent = p.memRecent;
    run.gpIds = p.gpIds;
}

function savePicks() {
    saveChatData('picks', {
        version: 1,
        memModes: run.memModes,
        memTags: run.memTags,
        memRecent: run.memRecent,
        gpIds: run.gpIds,
    });
}

// 分析/检查的流式显示：onDelta 累计文本 + 当前阶段。analyzeToken 让旧一轮在途的流式回调
// 与结果不写进切换后的新聊天（resetGuidance 时递增作废）
let analyzeToken = 0;
// 一次分析在途：跳转条让人能离开「分析中」页面，这里防并发重入（期间任何入口再点都提示等待）
let analyzeBusy = false;
let streamText = '';
let streamStage = '';

function updateStreamView(token) {
    if (token !== analyzeToken) return;
    const outEl = document.getElementById('pp_gd_run_stream');
    if (!outEl) return;
    const stageEl = document.getElementById('pp_gd_run_stage');
    if (stageEl) stageEl.textContent = streamStage === 'gate'
        ? '联网判断/检索中……'
        : `模型输出中 · 已接收 ${streamText.length} 字`;
    outEl.textContent = streamText || '等待模型输出……';
    outEl.scrollTop = outEl.scrollHeight;
}

export const guidanceTab = {
    id: 'guidance',
    title: '剧情指导',
    render(container) {
        container.innerHTML = `
        <div class="pp-section" id="pp_gd_storybar"></div>
        <div id="pp_gd_main"></div>
        <div id="pp_gd_events"></div>`;
        renderStoryBar(container);
        renderMain(container);
        restoreWizard(container);   // 刚刷新 / 刚切聊天：本聊天存有向导快照就回到离开的那一步
        renderEventsTools(container.querySelector('#pp_gd_events'));
        // 挂进事件工具区的折叠区容器：四个根折叠区同容器，边距合并、间距一致
        //（事件库设置 / AI 建库 / 游戏玩法 / 生效中的隐身注入，注入管理在游戏玩法之后）
        renderStorageTools(container.querySelector('#pp_ev_settings_wrap'));
        renderInjectionTools(container.querySelector('#pp_ev_settings_wrap'));
    },
};

// 聊天切换时由 index.js 调用：清掉向导进度，避免 A 聊天的规划带到 B 聊天；
// 剧情数据、第 1 步勾选、单元池与向导快照本身存 chatdata.js（按聊天身份走），下面重新 render 时
// restoreWizard 会自动恢复新聊天自己的快照——切回来，没处理完的向导还在
export function resetGuidance() {
    step = '';
    closeViewer();   // 开着的悬浮查看器（两个工具面板/提示词预览）一并关掉，不带到新聊天
    analyzeToken++;   // 在途的分析/检查流式回调与结果全部作废（不写进新聊天）
    Object.assign(run, {
        note: '', gpIds: null, result: null, raw: '', hits: 0, planText: '', reviseNote: '', hadActive: false,
        memModes: null, memTags: [], memRecent: 0, readyFrom: 'collect', research: null,
    });
    evImports.clear();
    rxImports.clear();
    expandedUnits.clear();
    showActive = false; showHistory = false; viewHistId = null; report = null;
    const container = document.getElementById('pp_tab_content');
    if (container?.querySelector('#pp_gd_storybar')) guidanceTab.render(container);
}

// ---------------------------------------------------------------------------
// 顶部：进行中剧情状态条 + 历史归档
// ---------------------------------------------------------------------------

function renderStoryBar(container) {
    const el = container.querySelector('#pp_gd_storybar');
    const s = storyState();
    const active = activeStory();

    if (!active) {
        el.innerHTML = `
        <div class="pp-item">
            <div class="pp-item-main">
                <span class="pp-item-title">当前没有进行中的剧情</span>
            </div>
            <div class="pp-item-ops"><span id="pp_gd_start" class="menu_button"><i class="fa-solid fa-plus"></i> 开始规划</span></div>
        </div>
        ${historyHtml(s)}`;
        el.querySelector('#pp_gd_start').addEventListener('click', () => startCollect(container));
        wireHistory(el, container);
        return;
    }

    el.innerHTML = `
    <div class="pp-item">
        <div class="pp-item-main">
            <span class="pp-item-title"><span class="pp-badge pp-badge-open">进行中</span>${escapeHtml(active.summary || '（无摘要）')}</span>
            <span class="pp-muted">采用于 ${new Date(active.at).toLocaleString()}${active.reportAt ? ` · 最近检查 ${new Date(active.reportAt).toLocaleString()}` : ''}${storyInjStatus()}</span>
        </div>
        <div class="pp-item-ops">
            <span class="menu_button" id="pp_gd_story_show">${showActive ? '隐藏' : '查看'}</span>
            <span class="menu_button" id="pp_gd_story_review" title="对照最近对话检查执行情况；记忆表格按向导第 1 步勾的档位与标签召回（口径存在本对话记忆里，与「按建议重写」用的同一份）">检查当前剧情</span>
            <span class="menu_button" id="pp_gd_story_new">重新规划</span>
            <span class="menu_button" id="pp_gd_story_end" title="剧情完结：退出进行中状态，归档保留，剧情注入自动撤下">结束剧情</span>
        </div>
    </div>
    ${showActive ? `<div class="pp-gd-planview">${escapeHtml(active.planText)}${reportCardHtml(active.report, active.reportAt)}</div>` : ''}
    ${historyHtml(s)}`;

    el.querySelector('#pp_gd_story_show').addEventListener('click', () => { showActive = !showActive; renderStoryBar(container); });
    el.querySelector('#pp_gd_story_review').addEventListener('click', () => reviewStory(container));
    el.querySelector('#pp_gd_story_new').addEventListener('click', () => startCollect(container));
    el.querySelector('#pp_gd_story_end').addEventListener('click', () => {
        endActive();
        if (storyInjItem()) removeInjection(storyInjId());
        toastr.info('已结束进行中剧情（归档保留，剧情注入已撤下）');
        renderStoryBar(container);
    });
    wireHistory(el, container);
}

function historyHtml(s) {
    const archived = s.history.filter(h => h.id !== s.activeId).length;
    const head = `
    <div class="pp-item" id="pp_gd_hist_head" title="每次确认采用的规划自动归档，仅保留最近 20 条">
        <div class="pp-item-main"><b>历史剧情</b>${archived ? ` <span class="pp-muted">另有 ${archived} 条归档</span>` : ''}</div>
        <div class="pp-item-ops">
            ${s.history.length ? `<span class="menu_button" id="pp_gd_hist_toggle">${showHistory ? '收起' : '展开'} <i class="fa-solid fa-chevron-${showHistory ? 'down' : 'right'}"></i></span>` : ''}
            ${archived ? `<span class="menu_button" id="pp_gd_hist_clear" title="清空归档（进行中那条保留）">清空</span>` : ''}
        </div>
    </div>`;
    if (!showHistory || !s.history.length) return head;
    return head + s.history.map(h => `
    <div class="pp-item">
        <div class="pp-item-main">
            <span>${h.id === s.activeId ? '<span class="pp-badge pp-badge-open">进行中</span>' : ''}<b>${escapeHtml(h.summary || '（无摘要）')}</b></span>
            <span class="pp-muted">${new Date(h.at).toLocaleString()}${h.event?.title ? ` · 事件：${escapeHtml(h.event.title)}${h.event.choice ? `（${escapeHtml(h.event.choice)}）` : ''}` : ''}${h.reportAt ? ' · 已检查' : ''}</span>
        </div>
        <div class="pp-item-ops">
            <span class="menu_button" data-hview="${h.id}">${viewHistId === h.id ? '收起' : '查看'}</span>
            ${h.id === s.activeId ? '' : `<span class="menu_button fa-solid fa-trash" data-hdel="${h.id}" title="删除该条归档"></span>`}
        </div>
    </div>
    ${viewHistId === h.id ? `<div class="pp-gd-planview">${escapeHtml(h.planText)}${reportCardHtml(h.report, h.reportAt)}</div>` : ''}`).join('');
}

function wireHistory(el, container) {
    el.querySelector('#pp_gd_hist_toggle')?.addEventListener('click', () => {
        showHistory = !showHistory;
        viewHistId = null;
        renderStoryBar(container);
    });
    el.querySelector('#pp_gd_hist_clear')?.addEventListener('click', () => {
        clearHistory();
        toastr.success('已清空历史归档（进行中剧情不受影响；要让提示词不再附带它，请点状态条上的「结束剧情」）');
        renderStoryBar(container);
    });
    el.querySelectorAll('[data-hview]').forEach(b => b.addEventListener('click', () => {
        viewHistId = viewHistId === b.dataset.hview ? null : b.dataset.hview;
        renderStoryBar(container);
    }));
    el.querySelectorAll('[data-hdel]').forEach(b => b.addEventListener('click', () => {
        deleteStory(b.dataset.hdel);
        if (viewHistId === b.dataset.hdel) viewHistId = null;
        toastr.success('已删除该条归档');
        renderStoryBar(container);
    }));
}

// ---------------------------------------------------------------------------
// 剧情注入自动绑定：采用→创建/替换（id 固定），重新采用→换内容，结束剧情→撤下。
// 与手动「转为隐身注入」互不影响（手动注入每次生成新 id）
// ---------------------------------------------------------------------------

function storyInjId() {
    return `story-${getTavernContext().chatId ?? 'unknown'}`;
}

function storyInjItem() {
    return settings.injections.find(i => i.id === storyInjId()) ?? null;
}

// 状态条上的注入状态尾巴：注入被手动停用/删掉时如实显示
function storyInjStatus() {
    const item = storyInjItem();
    if (!item) return ' · 未注入';
    return item.enabled ? ` · 已自动注入（深度 ${item.depth}）` : ' · 注入已停用';
}

function syncStoryInjection(planText, summary) {
    const inj = settings.guidance.inject;
    const id = storyInjId();
    const prev = settings.injections.find(i => i.id === id);
    const item = {
        id,
        label: `剧情：${String(summary || planText).trim().slice(0, 30)}`,
        mode: 'open',
        content: planText,
        depth: inj.depth,
        role: inj.role,
        scope: 'chat',
        chatId: getTavernContext().chatId,
        enabled: true,
        source: 'story',
        createdAt: prev?.createdAt ?? Date.now(),
        expires: { type: 'never' },   // 生命周期跟剧情走：换剧情替换内容，完结时撤下
    };
    const idx = settings.injections.findIndex(i => i.id === id);
    if (idx >= 0) {
        settings.injections[idx] = item;
        updateInjection(item);
    } else {
        addInjection(item);
    }
}

// ---------------------------------------------------------------------------
// 主区：按向导步骤渲染
// ---------------------------------------------------------------------------

function renderMain(container) {
    const main = container.querySelector('#pp_gd_main');
    persistWizard();   // 重渲染即落快照：所有步骤切换都在这里过一遍（向导空闲 / 检查报告流不动快照）
    renderStepPage(container, main);
    // 底部工具区（事件库设置/AI建库/游戏玩法/隐身注入）只在空闲页与第 1 步出现——
    // 确认/分析中/结果/检查报告是运行页，不放设置与制作类（2026-08-26 用户拍板）
    const toolsEl = container.querySelector('#pp_gd_events');
    if (toolsEl) toolsEl.style.display = (step === '' || step === 'collect') ? '' : 'none';
    // 步骤跳转条：向导进行中常驻；分析中也能跳走，结果落地后不抢页面、只提示到第 3 步看
    if (WIZARD_STEPS.includes(step)) {
        main.insertAdjacentHTML('afterbegin', stepNavHtml());
        main.querySelectorAll('[data-goto]').forEach(b => b.addEventListener('click', () => gotoStep(container, b.dataset.goto)));
    }
}

function renderStepPage(container, main) {
    if (step === 'collect') return renderCollect(container, main);
    if (step === 'ready') return renderReady(container, main);

    if (step === 'running') {
        // 分析实时输出页：不占跳转条一格（2026-08-26 三步化）——开始分析自动进入、
        // 分析在途点②回来、完账自动跳③结果；标题不带步骤号，免得与新③结果撞号
        main.innerHTML = `
        <div class="pp-section">
            <div class="pp-gd-stephead"><b>分析中</b><span class="pp-muted" id="pp_gd_run_stage"></span></div>
            <pre id="pp_gd_run_stream" class="pp-gd-stream pp-muted">等待模型输出……</pre>
        </div>`;
        updateStreamView(analyzeToken);
        return;
    }
    if (step === 'result') return renderResult(container, main);

    if (step === 'reviewing') {
        main.innerHTML = `
        <div class="pp-section">
            <div class="pp-gd-stephead"><b>检查当前剧情</b><span class="pp-muted" id="pp_gd_run_stage"></span></div>
            <pre id="pp_gd_run_stream" class="pp-gd-stream pp-muted">等待模型输出……</pre>
        </div>`;
        updateStreamView(analyzeToken);
        return;
    }
    if (step === 'report' && report) {
        main.innerHTML = `
        <div class="pp-section">
            <b>检查报告</b>
            ${reportCardHtml(report)}
            <div class="pp-btn-row">
                <span id="pp_gd_rp_again" class="menu_button">重新检查</span>
                <span id="pp_gd_rp_rewrite" class="menu_button" title="把报告建议作为修改意见，带着当前剧情打回重新规划">按建议重写剧情</span>
            </div>
        </div>`;
        main.querySelector('#pp_gd_rp_again').addEventListener('click', () => reviewStory(container));
        main.querySelector('#pp_gd_rp_rewrite').addEventListener('click', () => rewriteByAdvice(container));
        return;
    }

    main.innerHTML = '';
}

function startCollect(container) {
    step = 'collect';
    // 第 1 步勾选从本对话的记忆恢复；没存过的对话用默认（全部表全量）
    applyPicks();
    // 游戏玩法：没存过勾选的对话默认勾「当前生效中」的条目（生效判定与主对话注入同一套）
    if (run.gpIds == null) {
        run.gpIds = storageItemsInEffect().map(i => i.id);
    }
    renderStoryBar(container);
    renderMain(container);
}

// 本次运行的记忆表格召回 → planner 的 memoryTags / memoryModes / memoryRecent：
// 档位在每张表上（off 停用 / tags 按标签 / always 常驻全量），标签与最新窗口只作用于「标签」档的表
function wizardMemoryTags() {
    return run.memTags;
}

function wizardMemoryModes() {
    return run.memModes;
}

function wizardMemoryRecent() {
    return run.memRecent;
}

// 本次运行随分析发送的游戏玩法条目（第 1 步勾选，默认 = 当前生效中）
function wizardStorageItems() {
    return (settings.storageItems ?? []).filter(i => (run.gpIds ?? []).includes(i.id));
}

// 第 1 步「插入单元」勾选的单元正文（从两工具的暂存池取）：事件进「随机事件」小节、反应进
// 「路人反应」小节（与生效中的反应注入合并）——「查看完整提示词」预览与真实调用同一来源。
// 已注入的反应单元在第 1 步勾选区灰显（规划/检查自动附带注入正文，防同文进两次），
// 这里再滤一道作兜底
function wizardUnitTexts() {
    const st = unitsState();
    const ev = st.eventUnits.filter(u => u.inPlan).map(u => String(u.text ?? '').trim()).filter(Boolean);
    const rx = st.reactionUnits.filter(u => u.inPlan && !unitInjected(u)).map(u => String(u.text ?? '').trim()).filter(Boolean);
    return { eventText: ev.join('\n\n'), reactionText: rx.join('\n\n') };
}

// 联网搜索是否会对本次分析生效：设置页开了「启用联网搜索」（总开关）且填了搜索密钥。
// 生效时分析前先发一次轻量调用：「模型搜索前判断」开着由它决定要不要联网（判需要才直查），
// 关着则只为取关键词、每次必查；纪要附加进分析材料
const searchToolActive = () => settings.search?.enabled !== false && searchToolReady();
const searchPreJudge = () => settings.search?.preJudge !== false;

// 两工具（随机事件/路人反应）生成用的材料 = 第 1 步的本次选择（记忆表范围/标签、玩法勾选），
// 与规划分析完全同一批——三处口径一致才能互相对账（DESIGN §2.5：材料部分严格同源）；预设走全局，出口自动附带
function wizardMaterials() {
    return {
        memoryTags: wizardMemoryTags(),
        memoryModes: wizardMemoryModes(),
        memoryRecent: wizardMemoryRecent(),
        storageItems: wizardStorageItems(),
    };
}

// 第 1 步「下一步」先进「分析前确认」页，点确认才真正花一次模型调用
function goReady(container, from) {
    run.readyFrom = from;
    step = 'ready';
    renderMain(container);
}

// ① 收集确认：本地检索已完成，展示材料清单；记忆召回分两层（表范围 → 标签过滤）；
// 词表与打标配置在记忆表格页，这里只做选择；预设全局生效（设置页开关），本页不再勾选；构思可后补
function renderCollect(container, main) {
    const presets = settings.guidance?.presets ?? [];
    const state = memoryState();
    // 表格档位列全部镜像表——「参与召回」开关已退役，档位（停用/标签/常驻）是唯一口径
    const recallSheets = state.mirror.sheets;
    // 表格档位：没进映射的表 = 常驻（默认全量，与旧版「全部勾选 + 不按标签」一致）
    const modeOf = uid => (run.memModes ?? {})[uid] ?? 'always';
    const sheetRowHtml = s => `
    <div class="pp-gd-sheetrow">
        <span class="pp-gd-sheetname" title="${escapeHtml(s.name)} · ${s.rows.length} 行">${escapeHtml(s.name)} · ${s.rows.length} 行</span>
        <div class="pp-seg" data-mseg="${escapeHtml(s.uid)}" title="停用＝本次不带这张表；标签＝只带命中所勾标签的行（没打标签的表用这档带不出东西，那类表选常驻）；常驻＝无论标签全量带出">
            <span class="pp-seg-opt${modeOf(s.uid) === 'off' ? ' on' : ''}" data-state="off">停用</span>
            <span class="pp-seg-opt${modeOf(s.uid) === 'tags' ? ' on' : ''}" data-state="tags">标签</span>
            <span class="pp-seg-opt${modeOf(s.uid) === 'always' ? ' on' : ''}" data-state="always">常驻</span>
        </div>
    </div>`;
    // 游戏玩法：只列启用中的条目；「生效中」标记与主对话注入同一判定
    const gpItems = settings.storageItems.filter(i => i.enabled);
    const gpHit = new Set(storageItemsInEffect().map(i => i.id));
    main.innerHTML = `
    <div class="pp-section">
        <div class="pp-gd-stephead">
            <b>第 1 步 · 收集确认</b>
            <span class="menu_button" id="pp_gd_c1_preview">查看完整提示词</span>
        </div>
        ${recallSheets.length ? `
        <div>
            <div class="pp-gd-layhead">
                <label class="pp-label" title="每张表一个档位，随当前对话记忆存聊天数据，下一轮规划回来不用重设；不改记忆表格页的配置">记忆表格召回</label>
                <span id="pp_gd_mem_jump" class="menu_button" title="标签词表与 AI 打标签在「记忆表格」页管理">管理标签 ›</span>
            </div>
            <div class="pp-gd-memlay">
                <div>
                    <b class="pp-gd-layname">表格档位</b>
                    <div class="pp-gd-sheetlist" id="pp_gd_c1_sheets">
                        ${recallSheets.map(sheetRowHtml).join('')}
                    </div>
                </div>
                <div>
                    <b class="pp-gd-layname">标签过滤</b>
                    <div class="pp-gd-selp" id="pp_gd_c1_chips"></div>
                    <label class="pp-gd-recentrow" id="pp_gd_c1_recent_wrap" title="标签过滤会漏掉近期发生但没打标签的事件：这里填 N，「标签」档的每张表无论行上有没有标签、命没命中勾选的标签，都把表尾最新的 N 行一并带给模型——比如「重要事件」表在标签档、这里填 30，它最新 30 条一定在材料里。「常驻」档本来就全量、用不上本项。记忆行没有时间戳，按表内顺序新记录追加在表尾，「最新」即表尾；0 = 不另附">「标签」启用时每表另附最新 <input type="number" class="text_pole" id="pp_gd_c1_recent" min="0" step="1" value="${run.memRecent}" /> 行</label>
                    <span class="pp-muted" id="pp_gd_c1_memtip"></span>
                </div>
            </div>
        </div>` : `
        <div class="pp-gd-layhead"><label class="pp-label">记忆表格召回</label></div>
        <div class="pp-muted">镜像里还没有记忆表，本次不附带</div>`}
        <label class="pp-label" title="勾选的玩法规则随分析发给模型，规划须按其约束设计；勾选随当前对话记忆，首轮默认勾当前生效中的条目。条目的添加与 AI 咨询生成在页面底部「游戏玩法」折叠区">游戏玩法</label>
        <div class="pp-gd-selp">
            ${gpItems.map(i => `<label title="勾选后该条玩法规则作为材料发给规划模型（不影响它注入主对话）"><input type="checkbox" data-c1g="${i.id}" ${(run.gpIds ?? []).includes(i.id) ? 'checked' : ''}/> ${escapeHtml(i.name)}${gpHit.has(i.id) ? ' <span class="pp-badge pp-badge-open">生效中</span>' : ''}</label>`).join('')
            || '<span class="pp-muted">还没有玩法条目</span>'}
        </div>
        <div class="pp-btn-row">
            <span id="pp_gd_ev_panel" class="menu_button" title="整个板块在悬浮面板里，第 1 步只留这个入口：面板内生成——掷骰 / 大模型随机 / 按意见生成三键与意见二选一（意见框有字时只剩「按意见生成」能点），生成先出草稿、点草稿上的「立为单元」入池，暂存最多 3 个。大模型随机无条件把事件库已有条目作为防复刻清单随行（不做勾选）。生成材料自动带本页上方同一批，也可勾选导入路人反应的暂存单元做既定方向（最多勾一项——勾了新的自动替掉旧的；生成的事件必须与它咬合：顺着它描述的世界状态发展、不复写同一件事；仅随机两键生效；已生效注入不自动带，防双算；导入产物正文自带前因，删掉原始单元也不丢）。入池单元在本页下方「插入单元」区点开查看、勾选随分析发送、转隐身注入；采纳规划后暂存不清空，清空键在「插入单元」区">随机事件</span>
            <span id="pp_gd_rx_panel" class="menu_button" title="整个板块在悬浮面板里，第 1 步只留这个入口：面板内填指导意见（可选）、点「生成反应卡」出草稿、点草稿上「立为单元」入池（材料自动带本页上方同一批，也可导入随机事件的暂存单元做既定方向（最多勾一项——勾了新的自动替掉旧的）——导入的事件按将要且一定会发生对待，反应卡围绕它出；导入产物正文自带前因，删掉原始单元也不丢；模型会顺带给浓缩短标题作单元名）。入池单元在本页下方「插入单元」区点开查看与操作——勾选随分析发送 / 转隐身注入（按楼层预算到期自动撤下，生效期间规划与检查自动附带同一口径，两路互斥）；产物最多暂存 3 个，清空键在「插入单元」区">路人反应</span>
        </div>
        <div id="pp_gd_c1_units"></div>
        <label class="pp-label" title="已有的想法、约束或重点（可选，随分析发给模型）">剧情构思方向</label>
        <textarea id="pp_gd_note" class="text_pole textarea_compact" rows="3"></textarea>
        <div class="pp-btn-row">
            <span id="pp_gd_c1_next" class="menu_button">下一步</span>
            <span id="pp_gd_c1_cancel" class="menu_button">取消</span>
        </div>
    </div>`;

    // 状态行的记忆段口径：按档位计数（常驻 X · 标签 Y · 停用 Z），有标签档再拼标签/最新行明细
    const memScopeDesc = () => {
        const modes = recallSheets.map(s => modeOf(s.uid));
        const always = modes.filter(m => m === 'always').length;
        const tags = modes.filter(m => m === 'tags').length;
        if (!always && !tags) return '不附带（全部停用）';
        const tagPart = !tags ? '' : run.memTags.length
            ? `按标签 ${run.memTags.length} 类${run.memRecent ? ` + 每表最新 ${run.memRecent} 行` : ''}`
            : (run.memRecent ? `未勾标签·只带每表最新 ${run.memRecent} 行` : '未勾标签·标签档不带');
        return [
            always ? `常驻 ${always}` : '',
            tags ? `标签 ${tags}` : '',
            modes.length - always - tags ? `停用 ${modes.length - always - tags}` : '',
            tagPart,
        ].filter(Boolean).join(' · ');
    };
    // 材料概览整行（第 1 步页面不再常驻显示，点「查看完整提示词」在弹窗开头看）
    const c1StatText = () => {
        const st = collectStats({ memoryTags: wizardMemoryTags(), memoryModes: wizardMemoryModes(), memoryRecent: wizardMemoryRecent() });
        const memSeg = !recallSheets.length ? '记忆表格 不附带'
            : `记忆表格 ${st.memChars} 字（${memScopeDesc()}）`;
        const gpDesc = gpItems.length ? ` · 玩法 ${(run.gpIds ?? []).length} 条` : '';
        const us = unitsState();
        const evN = us.eventUnits.filter(u => u.inPlan).length;
        const rxN = us.reactionUnits.filter(u => u.inPlan).length;
        // 单元数常驻显示（0 也显示）：第 2 步确认页与这里同口径，有没有单元一眼可见
        const unitSeg = ` · 单元：随机事件 ${evN} · 路人反应 ${rxN}`;
        return `对话 ${st.layers} 层 · 世界书命中 ${st.hits} 条 · ${memSeg}${gpDesc}${unitSeg}`;
    };
    // 标签列下方的即时提示：只在该说话时出现（档位/标签没配对上、或标签档要空手）
    const memTipText = () => {
        const modes = recallSheets.map(s => modeOf(s.uid));
        const tags = modes.filter(m => m === 'tags').length;
        if (!tags) return run.memTags.length && modes.some(m => m !== 'off') ? '勾了标签但没有表在「标签」档，标签暂不生效' : '';
        if (!run.memTags.length)
            return run.memRecent ? `未勾标签：标签档的 ${tags} 张表只带各自最新 ${run.memRecent} 行` : '未勾标签：标签档的表将不带任何行（没打标签的表请切「常驻」）';
        return '';
    };
    const refreshMem = () => {
        const tipEl = main.querySelector('#pp_gd_c1_memtip');
        if (tipEl) tipEl.textContent = memTipText();
    };

    // 第二层标签 chips 的计数只统计未停用表格里的行；档位变了就地重建
    // （无可召回的表时整个记忆区块不渲染，chipsBox 为空直接跳过）
    const chipsBox = main.querySelector('#pp_gd_c1_chips');
    const renderChips = () => {
        if (!chipsBox) return;
        const scope = new Set(recallSheets.filter(s => modeOf(s.uid) !== 'off').map(s => s.uid));
        const counts = new Map();
        for (const sheet of state.mirror.sheets) {
            if (!scope.has(sheet.uid)) continue;
            for (const r of sheet.rows)
                for (const t of state.tags[r.rid] ?? []) counts.set(t, (counts.get(t) ?? 0) + 1);
        }
        const tags = [...counts.entries()].sort((a, b) => b[1] - a[1]);
        chipsBox.innerHTML = tags.length
            ? `<label class="pp-mem-chip" title="没全勾时勾上=一键勾选全部标签；已全勾时点掉=一键全清"><input type="checkbox" id="pp_gd_c1_all" /> 全选</label>`
                + tags.map(([t, n]) => `<label class="pp-mem-chip" title="带这个标签的记忆行"><input type="checkbox" data-mtag="${escapeHtml(t)}" ${run.memTags.includes(t) ? 'checked' : ''}/> ${escapeHtml(t)} (${n})</label>`).join('')
            : '<span class="pp-muted">所选表格里还没有带标签的行：到「记忆表格」页打标签</span>';
        const applyTags = () => {
            run.memTags = [...chipsBox.querySelectorAll('[data-mtag]:checked')].map(x => x.dataset.mtag);
            savePicks();
            persistWizard();
            refreshMem();
        };
        const allBox = chipsBox.querySelector('#pp_gd_c1_all');
        // 全选框跟随当前勾选态（半勾显示不确定态）；点它 = 未全勾→全勾、已全勾→全清
        const syncAll = () => {
            if (!allBox) return;
            const boxes = [...chipsBox.querySelectorAll('[data-mtag]')];
            allBox.checked = boxes.length > 0 && boxes.every(b => b.checked);
            allBox.indeterminate = !allBox.checked && boxes.some(b => b.checked);
        };
        syncAll();
        allBox?.addEventListener('change', () => {
            chipsBox.querySelectorAll('[data-mtag]').forEach(cb => { cb.checked = allBox.checked; });
            applyTags();
        });
        chipsBox.querySelectorAll('[data-mtag]').forEach(cb => cb.addEventListener('change', () => {
            applyTags();
            syncAll();
        }));
    };
    renderChips();
    refreshMem();

    // 档位三段按钮：就地翻高亮不整页重渲染（不丢滚动位置），标签计数与统计行跟随刷新
    main.querySelectorAll('#pp_gd_c1_sheets .pp-seg-opt').forEach(el => el.addEventListener('click', () => {
        if (el.classList.contains('on')) return;
        const uid = el.closest('.pp-seg').dataset.mseg;
        run.memModes = { ...(run.memModes ?? {}), [uid]: el.dataset.state };
        savePicks();
        persistWizard();
        el.closest('.pp-seg').querySelectorAll('.pp-seg-opt').forEach(o => o.classList.toggle('on', o === el));
        renderChips();
        refreshMem();
    }));
    main.querySelector('#pp_gd_mem_jump')?.addEventListener('click', () =>
        document.dispatchEvent(new CustomEvent('pp-switch-tab', { detail: { id: 'memory' } })));

    const noteEl = main.querySelector('#pp_gd_note');
    noteEl.value = run.note;
    noteEl.addEventListener('input', () => { run.note = noteEl.value; persistWizard(); });

    // 每表另附最新行数：input 实时回存（失焦整卡重渲染不丢），change 收敛非法值并回填
    const recentEl = main.querySelector('#pp_gd_c1_recent');
    recentEl?.addEventListener('input', () => {
        const v = Number(recentEl.value);
        if (Number.isFinite(v)) { run.memRecent = Math.max(0, Math.round(v)); savePicks(); persistWizard(); refreshMem(); }
    });
    recentEl?.addEventListener('change', () => {
        run.memRecent = Math.max(0, Math.round(Number(recentEl.value) || 0));
        recentEl.value = String(run.memRecent);
        savePicks();
        persistWizard();
        refreshMem();
    });

    main.querySelectorAll('[data-c1g]').forEach(cb => cb.addEventListener('change', () => {
        run.gpIds = [...main.querySelectorAll('[data-c1g]:checked')].map(x => x.dataset.c1g);
        savePicks();
        persistWizard();
        refreshMem();
    }));

    // 两个现场工具的入口键：面板住在悬浮查看器里（openEvPanel / openRxPanel，见下），
    // 页面不被这两个板块占一行以外的地盘；按钮文案带暂存计数，面板里的每次变动回来同步刷新
    const evBtnEl = main.querySelector('#pp_gd_ev_panel');
    const rxBtnEl = main.querySelector('#pp_gd_rx_panel');
    const syncToolBtns = () => {
        const us = unitsState();
        evBtnEl.textContent = us.eventUnits.length ? `随机事件（${us.eventUnits.length}）` : '随机事件';
        rxBtnEl.textContent = us.reactionUnits.length ? `路人反应（${us.reactionUnits.length}）` : '路人反应';
    };
    syncToolBtns();
    // 第 1 步「插入单元」区：入池单元统一在这里查看与操作（工具面板只管生成，2026-08-26 E8 外置）——
    // 勾选 = 随分析发送；点单元名展开提示词全文；转注入/层数/楼层预算/删除/清空键全在这
    const unitsBox = main.querySelector('#pp_gd_c1_units');
    const renderUnitPicks = () => {
        const us = unitsState();
        const all = [...us.eventUnits, ...us.reactionUnits];
        const group = (tool, list) => !list.length ? '' : `
        <div class="pp-gd-ughead">
            <label class="pp-label">${TOOL_NAME[tool]}单元（${list.length}）</label>
            <span class="menu_button" data-uclear="${tool}" title="清空${TOOL_NAME[tool]}名下的全部暂存单元（另一工具的不动；已转隐身注入的不受影响）；采纳规划不会清池">清空</span>
        </div>
        ${list.map(u => unitPickRow(u) + (expandedUnits.has(u.id) ? unitAreaCardHtml(u) : '')).join('')}`;
        unitsBox.innerHTML = all.length ? `
        <label class="pp-label" title="勾选的单元作为整块提示词随分析发给规划模型（事件进「随机事件」小节、反应进「路人反应」小节，规划为其留出融入空间）。单元的生成在上面两个工具面板里；点单元名展开提示词全文与操作">插入单元</label>
        ${group('event', us.eventUnits)}${group('reaction', us.reactionUnits)}` : '';
        unitsBox.querySelectorAll('[data-c1u]').forEach(cb => cb.addEventListener('change', () => {
            const cur = unitsState();
            for (const u of [...cur.eventUnits, ...cur.reactionUnits]) {
                if (u.id === cb.dataset.c1u) { u.inPlan = cb.checked; break; }
            }
            persistUnits();
        }));
        unitsBox.querySelectorAll('[data-uview]').forEach(el => el.addEventListener('click', () => {
            const id = el.dataset.uview;
            if (expandedUnits.has(id)) expandedUnits.delete(id); else expandedUnits.add(id);
            renderUnitPicks();
        }));
        unitsBox.querySelectorAll('[data-ucard]').forEach(cardEl => {
            const u = all.find(x => x.id === cardEl.dataset.ucard);
            if (u) wireUnitAreaCard(cardEl, u, renderUnitPicks, syncToolBtns);
        });
        unitsBox.querySelectorAll('[data-uclear]').forEach(btn => btn.addEventListener('click', () => {
            clearUnits(btn.dataset.uclear);
            (btn.dataset.uclear === 'event' ? evImports : rxImports).clear();
            renderUnitPicks();
            syncToolBtns();
            toastr.success(`已清空${TOOL_NAME[btn.dataset.uclear]}单元（另一工具的不动；已转隐身注入的不受影响）`);
        }));
    };
    renderUnitPicks();
    const onPanelChange = () => { syncToolBtns(); renderUnitPicks(); refreshMem(); };
    evBtnEl.addEventListener('click', () => openEvPanel(onPanelChange));
    rxBtnEl.addEventListener('click', () => openRxPanel(onPanelChange));

    // 完整提示词预览走悬浮查看器：按材料类型分块折叠（系统提示词 + 世界书/记忆表格/
    // 最近对话…各一块，块头显示小节名与精确字数），统计行带检索（命中的块自动展开高亮、
    // 没命中的临时藏起）与「复制全文」；展开/收起逐块点块头（2026-08-26 用户拍板撤掉「全部展开」键）
    main.querySelector('#pp_gd_c1_preview').addEventListener('click', () => {
        try {
            const s = storyState();
            const ut = wizardUnitTexts();
            const built = buildGuidanceMessages({
                userNote: run.note,
                eventText: ut.eventText,
                reactionText: ut.reactionText,
                activePlan: activeStory()?.planText ?? '',
                historySummaries: s.history.filter(h => h.id !== s.activeId).map(h => h.summary),
                memoryTags: wizardMemoryTags(),
                memoryModes: wizardMemoryModes(),
                memoryRecent: wizardMemoryRecent(),
                storageItems: wizardStorageItems(),
            });
            // 与真实调用同一拼法：chatCompletion 出口会附加全局预设，这里用同一个函数还原，
            // 预览里看到的系统提示词（含末尾的用户全局预设块）就是发出的那份
            const [sysMsg, usrMsg] = withGlobalPresets([
                { role: 'system', content: built.system },
                { role: 'user', content: built.user },
            ]);
            const sysTok = estimateTokens(sysMsg.content);
            const usrTok = estimateTokens(usrMsg.content);
            const { sections = [] } = built;
            const totalChars = sections.reduce((n, x) => n + x.chars, 0);
            const fullText = `【系统提示词】\n${sysMsg.content}\n\n【用户消息】\n${usrMsg.content}`;
            // 块 = 系统提示词（含全局预设）+ 用户消息里的每个材料小节（planner 逐节带回正文）
            const blocks = [
                { title: '系统提示词', header: '系统提示词（「设置」页启用的全局预设已拼在末尾）', body: sysMsg.content, chars: sysMsg.content.length },
                ...sections.map(x => ({ title: x.title, header: x.header, body: x.body, chars: x.chars })),
            ];
            const mask = openViewer('完整提示词预览',
                `<span class="pp-muted" style="flex-basis:100%" title="本行 = 本次分析实际携带的材料概览。预设全局生效：「设置」页勾选启用的预设会拼进插件发给大模型的每一次调用的系统提示词（规划分析/检查报告/随机事件/路人反应/AI 打标/AI 建库/联网判断），开关在「设置」页">${escapeHtml(c1StatText())} · 预设 ${presets.filter(p => p.enabled).length}/${presets.length} 全局生效${activeStory() ? ' · 已附进行中剧情' : ''}</span>`
                + `<span title="按「中日韩全角字符≈1 token、英文数字≈4字符=1 token」粗估，各家模型分词器不同，仅供规模参考；实际分词通常更省（中文约 1.4~1.6 字/token）；这是输入规模，不占「单次上限 tokens」${searchToolActive() ? `；已开联网搜索：${searchPreJudge() ? '分析前先轻量判断是否需要现实信息（只发剧情简报，纯虚构默认不检索），判需要才检索' : '分析前轻量取关键词后直接检索，不判断要不要搜'}，纪要追加为附加小节，不在此预览内` : ''}">材料共 ${totalChars.toLocaleString()} 字 · 粗估约 ${(sysTok + usrTok).toLocaleString()} tokens</span>`
                + `<input type="text" id="pp_gd_pv_search" class="text_pole" placeholder="检索…" title="在全部块里检索（大小写不敏感）：命中的块自动展开并高亮、没命中的临时藏起，清空恢复全览" />`
                + `<span id="pp_gd_pv_hits" class="pp-muted"></span>`
                + `<span class="menu_button" id="pp_gd_pv_copy" style="margin-left:auto" title="复制系统提示词与用户消息全文，可直接粘到别处调试"><i class="fa-regular fa-copy"></i> 复制全文</span>`);
            const bodyEl = mask.querySelector('.pp-viewer-body');
            const hitsEl = mask.querySelector('#pp_gd_pv_hits');
            const renderBlocks = () => {
                const query = mask.querySelector('#pp_gd_pv_search').value.trim();
                let hitBlocks = 0, hitCount = 0;
                bodyEl.innerHTML = blocks.map(b => {
                    let bodyHtml, count = 0;
                    if (query) {
                        const m = markMatches(b.body, query);
                        bodyHtml = m.html;
                        count = m.count;
                        if (!count) return '';   // 检索时没命中的块不渲染
                        hitBlocks++;
                        hitCount += count;
                    } else {
                        bodyHtml = escapeHtml(b.body);
                    }
                    return `
                    <details class="pp-viewer-block"${query ? ' open' : ''}>
                        <summary title="${escapeHtml(b.header)}"><span class="pp-viewer-btitle">${escapeHtml(b.title)}</span><span class="pp-muted">${b.chars.toLocaleString()} 字</span>${count ? ` <span class="pp-viewer-hitn">${count} 处</span>` : ''}</summary>
                        <pre class="pp-viewer-pre">${bodyHtml}</pre>
                    </details>`;
                }).join('') || `<div class="pp-muted">没有命中「${escapeHtml(query)}」的块，换个词或清空检索</div>`;
                hitsEl.textContent = query ? `命中 ${hitCount} 处 · ${hitBlocks}/${blocks.length} 块` : '';
            };
            renderBlocks();
            mask.querySelector('#pp_gd_pv_search').addEventListener('input', renderBlocks);
            mask.querySelector('#pp_gd_pv_copy').addEventListener('click', async () => {
                if (await copyText(fullText)) toastr.success('已复制到剪贴板');
                else toastr.error('复制失败：浏览器未授权剪贴板');
            });
        } catch (err) {
            toastr.error(String(err.message ?? err));
        }
    });

    main.querySelector('#pp_gd_c1_next').addEventListener('click', () => goReady(container, 'collect'));
    main.querySelector('#pp_gd_c1_cancel').addEventListener('click', () => {
        step = '';
        clearWizard();   // 主动退出：快照一并清空，刷新不再回到向导
        renderMain(container);
    });
}

// 分析前确认（2026-08-26 用户拍板改版）：材料细账第 1 步已确认过，这里只逐行核对随分析
// 插入的内容——单元名单（显示名称不显示数量）、玩法条目名单、联网搜索开关；
// 记忆表格/对话层数/世界书等其余材料清单在第 1 步「查看完整提示词」弹窗里，不在此重复
function renderReady(container, main) {
    const us = unitsState();
    const evNames = us.eventUnits.filter(u => u.inPlan).map(u => u.title || '(未命名)');
    const rxNames = us.reactionUnits.filter(u => u.inPlan).map(u => u.title || '(未命名)');
    const gpNames = wizardStorageItems().map(i => i.name || '(未命名)');
    const ut = wizardUnitTexts();
    main.innerHTML = `
    <div class="pp-section">
        <div class="pp-gd-stephead" title="记忆表格、对话层数、世界书命中、预设等其余材料清单在第 1 步「查看完整提示词」弹窗开头"><b>第 2 步 · 分析前确认</b></div>
        <div class="pp-gd-stat" title="第 1 步「插入单元」区勾选的随机事件单元名单，随分析发给模型；正文在第 1 步点单元名查看">插入单元 · 随机事件：${evNames.length ? escapeHtml(evNames.join('、')) : '无'}</div>
        <div class="pp-gd-stat" title="第 1 步「插入单元」区勾选的路人反应单元名单，随分析发给模型；正文在第 1 步点单元名查看">插入单元 · 路人反应：${rxNames.length ? escapeHtml(rxNames.join('、')) : '无'}</div>
        <div class="pp-gd-stat" title="第 1 步勾选的游戏玩法条目，作为材料随分析发送，规划按这些规则设计">玩法：${gpNames.length ? escapeHtml(gpNames.join('、')) : '无'}</div>
        <div class="pp-gd-stat" title="联网搜索总开关在「设置」页；开着时分析前先轻量判断是否需要现实信息（或直接检索），纪要附进分析材料">联网搜索：${searchToolActive() ? '开' : '关'}</div>
        <div class="pp-btn-row">
            <span id="pp_gd_ready_go" class="menu_button" title="走插件独立 API 调用一次，计费按你配置的接口">开始分析</span>
            <span id="pp_gd_ready_back" class="menu_button">返回</span>
        </div>
    </div>`;
    // 联网判断预跑：进这一页时材料与事件已定型，趁用户核对的几秒把判断跑完；
    // 分析时指纹对不上（这之后输入又变了）会自动作废重判。
    // 刷新恢复进本页（restoring）不预跑——那不是用户动作，不该无声花一次调用；
    // 点「开始分析」时 prefetch 为空会照常内联判断，不漏
    run.research = searchToolActive() && !restoring
        ? startResearchPrefetch(guidanceResearchInputs({
            userNote: run.note,
            eventText: ut.eventText,
            activePlan: activeStory()?.planText ?? '',
            historySummaries: historySummaries(),
        }))
        : null;
    main.querySelector('#pp_gd_ready_go').addEventListener('click', () => startAnalyze(container));
    main.querySelector('#pp_gd_ready_back').addEventListener('click', () => {
        step = run.readyFrom;
        renderMain(container);
    });
}

// ---------------------------------------------------------------------------
// 两个现场工具的悬浮面板（第 1 步入口键进 openViewer）：产物都是「单元」（units.js）。
// 材料与本页上方同一批（wizardMaterials），已生效注入不自动进工具生成（防双算）——
// 跨工具影响只走显式导入（对方暂存池里「加工史还没本工具」的单元才能勾）
// ---------------------------------------------------------------------------

// 导入选材行：列出对方池里可导入的单元；全部不可导入时说明一句，对方池空则整段不渲染
function importRowHtml(tool, picked) {
    const st = unitsState();
    const others = tool === 'event' ? st.reactionUnits : st.eventUnits;
    if (!others.length) return '';
    const otherName = TOOL_NAME[tool === 'event' ? 'reaction' : 'event'];
    const list = others.filter(u => unitImportable(u, tool));
    if (!list.length) return `
    <label class="pp-label">导入${otherName}单元做既定方向</label>
    <div class="pp-muted" title="加工史已含本工具（两标满）的单元不能再导入——套娃在结构上不可能">对方暂存里的单元都已经过本工具（两标满），不能再导入</div>`;
    return `
    <label class="pp-label" title="跨工具导入是两工具间唯一影响通道：只能导入「加工史里还没有本工具」的单元（同工具回流禁、两标满禁）。最多勾一项——勾了新的自动替掉旧的（2026-08-26 拍板）。导入＝既定方向——生成结果必须与导入单元咬合（顺着它发展、不复写同一件事），不是可有可无的参考。导入不消耗——原单元留在对方暂存里，勾着再生成一次就是重 roll；导入产物 = 带累积徽章的新单元（左＝先、右＝后），正文自带前因（源单元内容嵌在开头，删掉原始单元也不丢）">导入${otherName}单元做既定方向</label>
    <div class="pp-gd-selp">
        ${list.map(u => `<label title="${escapeHtml(String(u.text ?? '').slice(0, 300))}"><input type="checkbox" data-imp="${escapeHtml(u.id)}" ${picked.has(u.id) ? 'checked' : ''}/> ${escapeHtml(u.title || '(未命名)')}</label>`).join('')}
    </div>`;
}

// 当前勾选中的导入单元（生成材料用；勾选后被对方清理的自动落空）
function pickedImports(tool, picked) {
    const st = unitsState();
    const others = tool === 'event' ? st.reactionUnits : st.eventUnits;
    return others.filter(u => picked.has(u.id) && unitImportable(u, tool));
}

// 随机事件工具面板：只管生成（2026-08-26 E8 重排）。意见框在顶部（生成参考来源），与随机严格二选一——
// 意见框有字 → 掷骰/大模型随机/导入全灰置，只剩「按意见生成」；清空意见 → 随机两键回来（按意见生成灰置）。
// 按意见生成走大模型（意见是方向不是剧本），产物与随机路径一样先出草稿、点「立为单元」入池；
// 入池单元的查看/勾选/注入/删除/清空都在第 1 步「插入单元」区。掷骰入口唯一化——页面底部工具区只管库与维度
function openEvPanel(onChange) {
    const body = openViewer('随机事件').querySelector('.pp-viewer-body');
    const status = text => { const el = body.querySelector('#pp_gd_ev_status'); if (el) el.textContent = text; };
    const rerender = () => { render(); onChange(); };
    const render = () => {
        const st = unitsState();
        const full = st.eventUnits.length >= MAX_UNITS_PER_TOOL;
        body.innerHTML = `
        <label class="pp-label" title="写下事件或走向想法，点「按意见生成」让大模型遵循它即兴（意见是方向不是剧本，仍会生成走向选项）；与随机二选一——框里有字时掷骰/大模型随机灰置，清空恢复">指导意见</label>
        <textarea id="pp_gd_ev_manual" class="text_pole textarea_compact" rows="2" placeholder="想要什么样的事件或走向，写下想法"></textarea>
        <div class="pp-btn-row">
            <span id="pp_gd_ev_roll" class="menu_button" title="掷骰管线：先在勾选的掷骰板块（事件条目/维度随机/AI自主）里按板块权重抽一个——条目板块按权重×概率抽一条（必出），维度随机按维度权重抽方向，AI自主由模型看剧情挑维度；板块开关与权重在页面底部「事件库设置」；结果先出草稿，点「立为单元」收进暂存">掷骰</span>
            <span id="pp_gd_ev_llm" class="menu_button" title="不经掷骰直接让模型即兴；事件库已有条目无条件作为防复刻清单随行（生成的新事件不与库里撞内容，不做勾选）；生成材料自动带第 1 步同一批，勾选的导入单元（最多一项）作为既定方向随行（生成的事件必须与它咬合：顺着它发展、不复写同一件事；产物正文自带前因）">大模型随机</span>
            <span id="pp_gd_ev_note" class="menu_button" title="把上面的意见交给大模型，遵循意见即兴生成事件（意见路径独占材料位：不带掷骰、不带导入单元）；结果先出草稿，点「立为单元」收进暂存">按意见生成</span>
        </div>
        <div id="pp_gd_ev_imp">${importRowHtml('event', evImports)}</div>
        <div id="pp_gd_ev_status" class="pp-muted">${full ? `暂存已满 ${MAX_UNITS_PER_TOOL}/${MAX_UNITS_PER_TOOL}，先在第 1 步「插入单元」区删一个再生成` : ''}</div>
        <div id="pp_gd_ev_pool"></div>`;
        const manualEl = body.querySelector('#pp_gd_ev_manual');
        manualEl.value = st.eventNote;
        // 二选一灰置（2026-08-26 用户拍板）：pp-off 只降透明度+挡点击，不重画（输入不掉焦点）
        const syncGenBtns = () => {
            const has = manualEl.value.trim().length > 0;
            body.querySelector('#pp_gd_ev_roll').classList.toggle('pp-off', has);
            body.querySelector('#pp_gd_ev_llm').classList.toggle('pp-off', has);
            body.querySelector('#pp_gd_ev_note').classList.toggle('pp-off', !has);
            body.querySelector('#pp_gd_ev_imp').classList.toggle('pp-off', has);   // 导入只在随机两键时生效
        };
        manualEl.addEventListener('input', () => { st.eventNote = manualEl.value; persistUnits(); syncGenBtns(); });   // 只回存不重画，输入不掉焦点
        syncGenBtns();

        // 草稿卡（面板只放草稿；入池单元在第 1 步「插入单元」区查看与操作）
        const poolBox = body.querySelector('#pp_gd_ev_pool');
        poolBox.innerHTML = st.eventDraft ? evDraftCardHtml(st.eventDraft)
            : '<div class="pp-muted" title="掷骰/大模型随机/按意见生成都先出草稿；点草稿上的「立为单元」入池，入池后去第 1 步「插入单元」区查看与操作">生成后草稿出现在这里——立为单元后去第 1 步「插入单元」区找它</div>';
        if (st.eventDraft) wireEvDraft(poolBox.querySelector('[data-draft]'), st.eventDraft, rerender);

        body.querySelectorAll('[data-imp]').forEach(cb => cb.addEventListener('change', () => {
            // 单选（2026-08-26 用户拍板）：导入最多勾一项——勾了新的自动替掉旧的。
            // 只同步各框勾选态不重画（导入行没有输入框，重画也无碍，但少动 DOM 更稳）
            if (cb.checked) { evImports.clear(); evImports.add(cb.dataset.imp); }
            else evImports.delete(cb.dataset.imp);
            body.querySelectorAll('[data-imp]').forEach(o => { if (o !== cb) o.checked = evImports.has(o.dataset.imp); });
        }));
        body.querySelector('#pp_gd_ev_llm').addEventListener('click', async () => {
            if (evBusy || manualEl.value.trim()) return;
            if (!(getTavernContext().chat ?? []).length) { toastr.warning('空聊天里没有对话材料，先聊几句再生成'); return; }
            if (unitsState().eventUnits.length >= MAX_UNITS_PER_TOOL) { toastr.warning(`事件暂存已满 ${MAX_UNITS_PER_TOOL} 个，先删一个再生成`); return; }
            const imports = pickedImports('event', evImports);
            evBusy = true;
            status('大模型随机生成中……');
            try {
                const gen = await generateFreeRandomEvent({ materials: { ...wizardMaterials(), importedUnits: imports } });
                const cur = unitsState();
                cur.eventDraft = newEventUnit({ ...gen, mode: 'llm' }, imports[0] ?? null);
                persistUnits();
                rerender();   // 面板整面重画：草稿卡上桌
                status('草稿已生成——点「立为单元」收进暂存（再生成会换掉草稿）');
            } catch (err) {
                status('');
                toastr.error(String(err.message ?? err));
            } finally {
                evBusy = false;
            }
        });
        body.querySelector('#pp_gd_ev_note').addEventListener('click', async () => {
            if (evBusy) return;
            const note = manualEl.value.trim();
            if (!note) return;
            if (!(getTavernContext().chat ?? []).length) { toastr.warning('空聊天里没有对话材料，先聊几句再生成'); return; }
            if (unitsState().eventUnits.length >= MAX_UNITS_PER_TOOL) { toastr.warning(`事件暂存已满 ${MAX_UNITS_PER_TOOL} 个，先删一个再生成`); return; }
            evBusy = true;
            status('按意见生成中……');
            try {
                const gen = await generateFreeRandomEvent({ note, materials: { ...wizardMaterials() } });   // 意见路径独占材料位，不带导入单元
                const cur = unitsState();
                cur.eventDraft = newEventUnit({ ...gen, mode: 'opinion' }, null);
                persistUnits();
                rerender();
                status('草稿已生成——点「立为单元」收进暂存（再生成会换掉草稿）');
            } catch (err) {
                status('');
                toastr.error(String(err.message ?? err));
            } finally {
                evBusy = false;
            }
        });
        body.querySelector('#pp_gd_ev_roll').addEventListener('click', async () => {
            if (evBusy || manualEl.value.trim()) return;
            if (!(getTavernContext().chat ?? []).length) { toastr.warning('空聊天里没有对话材料，先聊几句再生成'); return; }
            if (unitsState().eventUnits.length >= MAX_UNITS_PER_TOOL) { toastr.warning(`事件暂存已满 ${MAX_UNITS_PER_TOOL} 个，先删一个再生成`); return; }
            const r = rollEventPipeline();
            if (r.mode === 'none') {
                status(`本次未掷出事件（${r.reason}），可再掷或改用「大模型随机」`);
                return;
            }
            const imports = pickedImports('event', evImports);
            evBusy = true;
            status(r.mode === 'library'
                ? `掷中「${r.rule.name}」，生成中……`
                : r.mode === 'ai'
                    ? 'AI 自主挑维度中，生成中……'
                    : `维度「${r.dimension.name}」自由生成中……`);
            try {
                let gen;
                let msg;
                if (r.mode === 'library') {
                    gen = await generateRandomEvent(r.rule, { ...wizardMaterials(), importedUnits: imports });
                    commitRolledEvent({ rule: r.rule, dimension: r.dimension, title: gen.title, source: 'library' });
                    msg = `来自事件库「${r.rule.name}」——点「立为单元」收进暂存`;
                } else if (r.mode === 'ai') {
                    gen = await generateAiChoiceRandomEvent({ dimensions: r.dimensions, materials: { ...wizardMaterials(), importedUnits: imports } });
                    // 回传的维度名先去首尾空格再精确匹配；仍对不上就记空（commitRolledEvent 容忍 null）
                    const dim = r.dimensions.find(d => d.name === String(gen?.dimension ?? '').trim()) ?? null;
                    commitRolledEvent({ dimension: dim, title: gen.title, source: 'ai' });
                    msg = `来自 AI 自主${dim ? `·维度「${dim.name}」` : ''}——点「立为单元」收进暂存`;
                } else {
                    gen = await generateFreeRandomEvent({ dimension: r.dimension, materials: { ...wizardMaterials(), importedUnits: imports } });
                    commitRolledEvent({ dimension: r.dimension, title: gen.title, source: 'free' });
                    msg = `来自维度「${r.dimension.name}」自由生成——点「立为单元」收进暂存`;
                }
                const cur = unitsState();
                cur.eventDraft = newEventUnit({ ...gen, mode: r.mode === 'library' ? 'lib' : r.mode }, imports[0] ?? null);
                persistUnits();
                rerender();   // 整面重画会清掉状态行，提示在重画后再落
                status(msg);
            } catch (err) {
                status('');
                toastr.error(String(err.message ?? err));
            } finally {
                evBusy = false;
            }
        });
    };
    render();
}

// 事件草稿卡（面板内）：草稿标 + 卡头徽章 + 描述 + 走向选项（三选一或不选）+ 立为单元/丢弃。
// 立为单元按「三选一或不选」裁剪走向（finalizeEventDraft）：没选=选项全砍（只作参考材料）、
// 选了=只留那一个——入池即定稿的纯文本提示词块，之后不可再改选走向（想换 = 重新生成一版）
function evDraftCardHtml(unit) {
    const p = unit.payload ?? {};
    const options = Array.isArray(p.options) ? p.options : [];
    return `
    <div class="pp-item pp-gd-evcard pp-gd-evdraft" data-draft="1" data-uid="${escapeHtml(unit.id)}">
        <div><span class="pp-badge" title="还没入暂存池；再生成一次会换掉这份草稿">草稿</span></div>
        ${unitHeadHtml(unit)}
        <div class="pp-gd-evdesc">${escapeHtml(p.description ?? '')}</div>
        ${options.length ? `
        <div class="pp-label pp-gd-evoptlabel" title="三选一或不选；都不选＝立卡后只作参考材料，选项会在立卡时裁掉">走向选项</div>
        ${options.map((o, i) => `
            <div class="menu_button pp-option ${p.choiceIdx === i ? 'pp-gd-sel' : ''}" data-evopt="${i}">
                <span class="pp-option-label">${escapeHtml(o.label ?? '')}</span>
                ${o.hint ? `<span class="pp-option-hint">幕后提示：${escapeHtml(o.hint ?? '')}</span>` : ''}
            </div>`).join('')}
        ${p.choiceIdx == null ? '' : `<div class="pp-muted">已选：${escapeHtml(options[p.choiceIdx]?.label ?? '')}</div>`}` : ''}
        <div class="pp-btn-row pp-gd-evops">
            <span data-evu-keep="1" class="menu_button" title="把这份草稿收进暂存池；走向按当前所选裁剪（没选=选项全砍，选了=只留那一个），裁完即定稿">立为单元</span>
            <span data-evu-discard="1" class="menu_button" title="丢掉这份草稿（不影响暂存池里已立的单元）">丢弃</span>
        </div>
    </div>`;
}

// 事件草稿卡接线：走向点选 + 收/弃（收 = finalizeEventDraft 裁剪后入池）。rerender = 面板整面重画
function wireEvDraft(cardEl, unit, rerender) {
    const p = unit.payload ?? (unit.payload = {});
    cardEl.querySelectorAll('[data-evopt]').forEach(el => el.addEventListener('click', () => {
        const i = Number(el.dataset.evopt);
        p.choiceIdx = p.choiceIdx === i ? null : i;
        unit.text = eventUnitText(unit);   // 走向变了，材料正文跟着变
        persistUnits();
        rerender();
    }));
    cardEl.querySelector('[data-evu-keep]').addEventListener('click', () => {
        const st = unitsState();
        if (st.eventUnits.length >= MAX_UNITS_PER_TOOL) {
            toastr.warning(`事件暂存已满 ${MAX_UNITS_PER_TOOL} 个，先在第 1 步「插入单元」区删一个再收`);
            return;
        }
        st.eventDraft = null;
        persistUnits();
        addUnit(finalizeEventDraft(unit));
        rerender();
        toastr.success('已立为事件单元（第 1 步「插入单元」区点开查看、勾选随分析发送、转注入）');
    });
    cardEl.querySelector('[data-evu-discard]').addEventListener('click', () => {
        const st = unitsState();
        st.eventDraft = null;
        persistUnits();
        rerender();
    });
}

// 路人反应工具面板：只管生成（2026-08-26 E8 对齐事件面板草稿制）——顶部指导意见（可选）→
// 「生成反应卡」出草稿 → 点草稿上「立为单元」入池；模型顺带给浓缩短标题作单元名。
// 入池单元的查看/勾选/注入/删除/清空都在第 1 步「插入单元」区，面板不再存放单元
function openRxPanel(onChange) {
    const body = openViewer('路人反应').querySelector('.pp-viewer-body');
    const status = text => { const el = body.querySelector('#pp_gd_rx_status'); if (el) el.textContent = text; };
    const rerender = () => { render(); onChange(); };
    const render = () => {
        const st = unitsState();
        const full = st.reactionUnits.length >= MAX_UNITS_PER_TOOL;
        body.innerHTML = `
        <label class="pp-label" title="写给生成模型的指导意见：期望烈度、余波方向、要避开什么">指导意见（可选）</label>
        <textarea id="pp_gd_rx_note" class="text_pole textarea_compact" rows="2" placeholder="期望烈度、余波方向、要避开什么"></textarea>
        <div class="pp-btn-row">
            <span id="pp_gd_rx_gen" class="menu_button" title="生成一张反应卡先出草稿（材料自动带第 1 步同一批：记忆表格档位与标签、玩法勾选、世界书、进行中剧情，勾选的导入单元（最多一项）作为既定方向随行——反应卡围绕导入的事件出，没勾才从最近对话里找；产物正文自带前因，删掉原始单元也不丢）；点草稿上的「立为单元」入池，模型会顺带给一个浓缩短标题作单元名">生成反应卡</span>
        </div>
        ${importRowHtml('reaction', rxImports)}
        <div id="pp_gd_rx_status" class="pp-muted">${full ? `反应暂存已满 ${MAX_UNITS_PER_TOOL}/${MAX_UNITS_PER_TOOL}，先在第 1 步「插入单元」区删一个再生成` : ''}</div>
        <div id="pp_gd_rx_pool"></div>`;
        const noteEl = body.querySelector('#pp_gd_rx_note');
        noteEl.value = st.reactionNote;
        noteEl.addEventListener('input', () => { st.reactionNote = noteEl.value; persistUnits(); });   // 只回存不重画，输入不掉焦点

        // 草稿卡（面板只放草稿；入池单元在第 1 步「插入单元」区查看与操作）
        const poolBox = body.querySelector('#pp_gd_rx_pool');
        poolBox.innerHTML = st.reactionDraft ? rxDraftCardHtml(st.reactionDraft)
            : '<div class="pp-muted" title="生成先出草稿；点草稿上的「立为单元」入池，入池后去第 1 步「插入单元」区查看与操作">生成后草稿出现在这里——立为单元后去第 1 步「插入单元」区找它</div>';
        const draft = st.reactionDraft;
        if (draft) {
            const draftEl = poolBox.querySelector('[data-draft]');
            wireRxCardFields(draftEl, draft);   // 楼层预算/注入正文在草稿期就可改，改动随草稿存
            draftEl.querySelector('[data-rxu-keep]').addEventListener('click', () => {
                const cur = unitsState();
                if (cur.reactionUnits.length >= MAX_UNITS_PER_TOOL) {
                    toastr.warning(`反应暂存已满 ${MAX_UNITS_PER_TOOL} 个，先在第 1 步「插入单元」区删一个再收`);
                    return;
                }
                cur.reactionDraft = null;
                persistUnits();
                addUnit(draft);
                rerender();
                toastr.success('已立为反应单元（第 1 步「插入单元」区点开查看、勾选随分析发送、转注入）');
            });
            draftEl.querySelector('[data-rxu-discard]').addEventListener('click', () => {
                const cur = unitsState();
                cur.reactionDraft = null;
                persistUnits();
                rerender();
            });
        }

        body.querySelectorAll('[data-imp]').forEach(cb => cb.addEventListener('change', () => {
            // 单选（与事件面板同款拍板）：导入最多勾一项，勾了新的自动替掉旧的
            if (cb.checked) { rxImports.clear(); rxImports.add(cb.dataset.imp); }
            else rxImports.delete(cb.dataset.imp);
            body.querySelectorAll('[data-imp]').forEach(o => { if (o !== cb) o.checked = rxImports.has(o.dataset.imp); });
        }));
        body.querySelector('#pp_gd_rx_gen').addEventListener('click', async () => {
            if (rxBusy) return;
            if (!(getTavernContext().chat ?? []).length) { toastr.warning('空聊天里没有对话材料，先聊几句再生成'); return; }
            if (unitsState().reactionUnits.length >= MAX_UNITS_PER_TOOL) { toastr.warning(`反应暂存已满 ${MAX_UNITS_PER_TOOL} 个，先删一个再生成`); return; }
            const imports = pickedImports('reaction', rxImports);
            rxBusy = true;
            const btn = body.querySelector('#pp_gd_rx_gen');
            btn.textContent = '生成中……';
            status('');
            try {
                const gen = await generateReactionCard({
                    note: st.reactionNote,
                    materials: { ...wizardMaterials(), importedUnits: imports },
                    activePlan: activeStory()?.planText ?? '',
                });
                const cur = unitsState();
                cur.reactionDraft = newReactionUnit(gen, imports[0] ?? null);
                persistUnits();
                rerender();   // 面板整面重画：按钮文案复位、草稿卡上桌
                status('草稿已生成——点「立为单元」收进暂存（再生成会换掉草稿）');
            } catch (err) {
                toastr.error(String(err.message ?? err));
                btn.textContent = '生成反应卡';
            } finally {
                rxBusy = false;
            }
        });
    };
    render();
}

// 反应草稿卡（面板内）：草稿标 + 卡头徽章 + 原结构化卡面（rxCardFieldsHtml）+ 立为单元/丢弃——
// 草稿期就能改楼层预算与注入正文，立卡后带着改动原样入池
function rxDraftCardHtml(unit) {
    return `
    <div class="pp-item pp-gd-evcard pp-gd-evdraft" data-draft="1" data-uid="${escapeHtml(unit.id)}">
        <div><span class="pp-badge" title="还没入暂存池；再生成一次会换掉这份草稿">草稿</span></div>
        ${unitHeadHtml(unit)}
        ${rxCardFieldsHtml(unit)}
        <div class="pp-btn-row pp-gd-evops">
            <span data-rxu-keep="1" class="menu_button" title="把这份草稿收进暂存池；收进后去第 1 步「插入单元」区查看与操作">立为单元</span>
            <span data-rxu-discard="1" class="menu_button" title="丢掉这份草稿（不影响暂存池里已立的单元）">丢弃</span>
        </div>
    </div>`;
}

function clampInjectLayers(v) {
    return Math.min(Math.max(Math.round(Number(v) || 20), 1), 200);
}

// ---------------------------------------------------------------------------
// 分析调用 / 第 3 步人工二检 + 封装
// ---------------------------------------------------------------------------

function historySummaries() {
    const s = storyState();
    return s.history.filter(h => h.id !== s.activeId).map(h => h.summary);
}

async function startAnalyze(container, { revise = false } = {}) {
    if (analyzeBusy) {
        toastr.warning('上一轮分析还在进行中，等它完成（可先去别的步骤看看，完成会提示）');
        return;
    }
    const token = ++analyzeToken;
    analyzeBusy = true;
    streamText = '';
    streamStage = '';
    step = 'running';
    const activePlan = activeStory()?.planText ?? '';
    run.hadActive = Boolean(activePlan.trim());
    renderMain(container);
    try {
        const ut = wizardUnitTexts();   // 第 1 步「插入单元」勾选的单元正文：事件与反应各自合并成小节材料
        const data = await runPlotGuidance({
            userNote: run.note,
            previousPlan: revise ? run.planText : '',
            revisionNote: revise ? run.reviseNote : '',
            eventText: ut.eventText,
            reactionText: ut.reactionText,
            activePlan,
            historySummaries: historySummaries(),
            memoryTags: wizardMemoryTags(),
            memoryModes: wizardMemoryModes(),
            memoryRecent: wizardMemoryRecent(),
            storageItems: wizardStorageItems(),
            onDelta: t => { streamText = t; updateStreamView(token); },
            onStage: s => { streamStage = s; updateStreamView(token); },
            // 打回重写不吃预跑缓存：修改意见可能把检索方向带偏，重写一律重新判断
            researchPrefetch: revise ? null : run.research,
        });
        if (token !== analyzeToken) return;   // 期间切了聊天/重开向导：结果丢弃不落地
        run.result = data.result;
        run.raw = data.raw;
        run.hits = data.hits;
        run.planText = formatPlan(data.result.plan);
        persistWizard();
        // 分析中用户跳去了别的步骤：结果照常入账（快照已更新），不抢当前页面
        if (step === 'running' || step === 'result') {
            step = 'result';
            renderMain(container);
        } else {
            toastr.info('分析已完成，点上方「③ 结果」查看');
        }
    } catch (err) {
        if (token !== analyzeToken) return;
        toastr.error(String(err.message ?? err));
        // 打回重写失败回到结果页（旧结果还在）；首轮失败回到第 1 步改材料；
        // 用户已跳去别的步骤则只报错，不动他所在的页面
        if (step === 'running') {
            step = revise ? 'result' : 'collect';
            renderMain(container);
        }
    } finally {
        analyzeBusy = false;
    }
}

function formatPlan(plan) {
    if (!plan) return '';
    const beats = (plan.beats ?? []).map((b, i) => `${i + 1}. [${b.stage ?? ''}] ${b.content ?? ''}`).join('\n');
    const risks = (plan.risks ?? []).length ? `风险注意：${plan.risks.join('；')}` : '';
    return [plan.summary ?? '', beats, risks].filter(Boolean).join('\n\n');
}

function renderResult(container, main) {
    const checks = run.result?.checks ?? {};
    const ooc = checks.ooc;
    const items = Array.isArray(ooc?.items) ? ooc.items : [];
    const checkRow = (name, body) => `<div class="pp-gd-check"><b>${name}</b>${body}</div>`;
    const inj = settings.guidance.inject;

    main.innerHTML = `
    <div class="pp-section">
        <div class="pp-gd-stephead"><b>第 3 步 · 人工二检</b><span class="pp-muted">世界书命中 ${run.hits} 条</span></div>
        ${checkRow('OOC', ooc?.found && items.length
            ? items.map(it => `<div class="pp-hit"><b>${escapeHtml(it.aspect ?? '')} · ${escapeHtml(it.severity ?? '')}</b><div>${escapeHtml(it.evidence ?? '')}</div><div class="pp-muted">建议：${escapeHtml(it.fix ?? '')}</div></div>`).join('')
            : '<span class="pp-muted">未发现明显 OOC</span>')}
        ${checkRow('与已有剧情重复', checks.plotRepeat?.found
            ? `<div>${escapeHtml(checks.plotRepeat.note || '存在重复')}</div>`
            : '<span class="pp-muted">未发现重复</span>')}
        ${checkRow('文风重复', `<div>${escapeHtml(checks.styleRepeat?.level || '—')}${checks.styleRepeat?.note ? `：${escapeHtml(checks.styleRepeat.note)}` : ''}</div>`)}
        ${run.hadActive ? checkRow('剧情进度', `<div>${escapeHtml(checks.progress?.stage || '—')}${checks.progress?.pct ? `（${escapeHtml(checks.progress.pct)}）` : ''}</div>${checks.progress?.note ? `<div class="pp-muted">${escapeHtml(checks.progress.note)}</div>` : ''}`) : ''}
    </div>
    <div class="pp-section">
        <b title="可编辑；「确认采用」与「转为隐身注入」用的都是这份文本">剧情规划</b>
        <textarea id="pp_gd_plan" class="text_pole textarea_compact" rows="14"></textarea>
        <label class="pp-label" title="填给模型的修改要求，点「重新生成」按它把规划重写一版（材料与第 1 步勾选不变）">修改意见</label>
        <textarea id="pp_gd_revise_note" class="text_pole textarea_compact" rows="2" title="填给模型的修改要求，点「重新生成」按它把规划重写一版（材料与第 1 步勾选不变）"></textarea>
        <label class="pp-label" title="默认沿用上次；「确认采用」的剧情注入也按这里的深度与角色注入（剧情注入永不过期，完结时自动撤下）">注入参数</label>
        <div class="pp-gd-selp pp-gd-injrow">
            <label>深度 <input type="number" class="text_pole" id="pp_gd_inj_depth" min="0" max="100" step="1" title="0 = 紧贴上下文末尾；数字越大越靠前" /></label>
            <label>角色 <select class="text_pole" id="pp_gd_inj_role"><option value="system">system</option><option value="user">user</option></select></label>
            <label>过期 <select class="text_pole" id="pp_gd_inj_exp"><option value="never">永久</option><option value="layers">N 层后</option></select></label>
            <label id="pp_gd_inj_layers_wrap" hidden>层数 <input type="number" class="text_pole" id="pp_gd_inj_layers" min="1" step="1" /></label>
        </div>
        <div class="pp-btn-row">
            <span id="pp_gd_adopt" class="menu_button">确认采用</span>
            <span id="pp_gd_revise" class="menu_button" title="按上面的修改意见把规划重写一版（材料与第 1 步勾选不变）">重新生成</span>
            <span id="pp_gd_inject" class="menu_button" title="把上面这份规划文本直接注入主对话（模型可见、聊天界面不显示），按上面的深度/角色/过期生效、到期自动撤下。与「确认采用」的区别：采用是把规划存为「进行中剧情」档案——后续规划与检查都以它为基准，并自动绑定剧情注入（完结才撤下）；转注入不进档案，只是把这份文本临时塞给主对话模型">转为隐身注入</span>
            <span id="pp_gd_discard" class="menu_button" title="丢弃本次生成（构思、预设与事件选择保留）">放弃保存</span>
        </div>
    </div>`;

    const planEl = main.querySelector('#pp_gd_plan');
    planEl.value = run.planText;
    planEl.addEventListener('input', () => { run.planText = planEl.value; persistWizard(); });
    const noteEl = main.querySelector('#pp_gd_revise_note');
    noteEl.value = run.reviseNote;
    noteEl.addEventListener('input', () => { run.reviseNote = noteEl.value; persistWizard(); });

    // 注入参数：记住上次选择；改动时同步已启用的剧情注入的深度/角色
    const depthEl = main.querySelector('#pp_gd_inj_depth');
    const roleEl = main.querySelector('#pp_gd_inj_role');
    const expEl = main.querySelector('#pp_gd_inj_exp');
    const layersEl = main.querySelector('#pp_gd_inj_layers');
    const layersWrap = main.querySelector('#pp_gd_inj_layers_wrap');
    const syncInjCfgUi = () => {
        layersWrap.hidden = inj.expires !== 'layers';
    };
    depthEl.value = inj.depth;
    roleEl.value = inj.role;
    expEl.value = inj.expires;
    layersEl.value = inj.layers;
    syncInjCfgUi();
    const onInjCfgChange = () => {
        inj.depth = Math.max(0, Number(depthEl.value) || 0);
        inj.role = roleEl.value;
        inj.expires = expEl.value;
        inj.layers = Math.max(1, Number(layersEl.value) || 20);
        syncInjCfgUi();
        save();
        const live = storyInjItem();
        if (live?.enabled) {
            live.depth = inj.depth;
            live.role = inj.role;
            updateInjection(live);
        }
    };
    depthEl.addEventListener('change', onInjCfgChange);
    roleEl.addEventListener('change', onInjCfgChange);
    expEl.addEventListener('change', onInjCfgChange);
    layersEl.addEventListener('change', onInjCfgChange);

    main.querySelector('#pp_gd_revise').addEventListener('click', () => startAnalyze(container, { revise: true }));
    main.querySelector('#pp_gd_discard').addEventListener('click', () => {
        Object.assign(run, { result: null, raw: '', hits: 0, planText: '', reviseNote: '', hadActive: false, research: null });
        step = 'collect';
        toastr.info('已丢弃本次生成（构思、预设与事件选择保留）');
        renderMain(container);
    });
    main.querySelector('#pp_gd_adopt').addEventListener('click', () => {
        if (!run.planText.trim()) {
            toastr.warning('规划内容为空');
            return;
        }
        confirmPlot({
            planText: run.planText,
            summary: run.result?.plan?.summary ?? '',
            note: run.note,
            event: adoptedEventMeta(),
        });
        syncStoryInjection(run.planText, run.result?.plan?.summary ?? '');
        toastr.success('已存为进行中剧情并自动注入（原剧情自动归档，可在历史回看）');
        step = '';
        // 第 1 步勾选存在对话记忆里，下一轮进第 1 步自动恢复，这里照常清工作副本。
        // 单元池不随采用清空（DESIGN §2.5）：清理由各工具面板的一键清理键手动执行
        Object.assign(run, {
            note: '', gpIds: null, result: null, raw: '', hits: 0, planText: '', reviseNote: '', hadActive: false,
            memModes: null, memTags: [], memRecent: 0, readyFrom: 'collect', research: null,
        });
        report = null;
        clearWizard();   // 已采用：快照清空，刷新页面不再回到第 3 步
        renderStoryBar(container);
        renderMain(container);
    });
    main.querySelector('#pp_gd_inject').addEventListener('click', () => {
        const content = run.planText.trim();
        if (!content) {
            toastr.warning('规划内容为空');
            return;
        }
        addInjection({
            id: newId('inj-'),
            label: `剧情规划 ${new Date().toLocaleTimeString()}`,
            mode: 'open',
            content,
            depth: inj.depth,
            role: inj.role,
            scope: 'chat',
            enabled: true,
            source: 'planner',
            createdAt: Date.now(),
            expires: inj.expires === 'layers' ? { type: 'layers', layers: inj.layers } : { type: 'never' },
        });
        toastr.success('已注入（模型可见、聊天界面不显示；页面底部「生效中的隐身注入」可提前撤下）');
    });
}

// ---------------------------------------------------------------------------
// 检查报告：对照进行中剧情出执行报告；「按建议重写」带建议打回重新规划
// ---------------------------------------------------------------------------

async function reviewStory(container) {
    const active = activeStory();
    if (!active) return;
    const token = ++analyzeToken;
    streamText = '';
    streamStage = '';
    step = 'reviewing';
    renderMain(container);
    try {
        // 记忆口径继承向导第 1 步：读对话记忆里的 picks（「按建议重写」恢复的也是同一份，
        // 检查与重写天然同口径）；本对话没存过勾选 = 全量召回，与单人卡的老行为一致
        const picks = readMemPicks();
        const data = await runStoryReview({
            planText: active.planText,
            memoryTags: picks.memTags,
            memoryModes: picks.memModes,
            memoryRecent: picks.memRecent,
            onDelta: t => { streamText = t; updateStreamView(token); },
            onStage: s => { streamStage = s; updateStreamView(token); },
        });
        if (token !== analyzeToken) return;   // 期间切了聊天：报告丢弃
        attachReport(active.id, data.result);
        report = data.result;
        renderStoryBar(container);   // 刷新「最近检查」时间（报告本体已挂到剧情条目上）
        // 检查期间用户跳进向导其他步骤时不抢页面——回到剧情页签随时能看报告
        if (step === 'reviewing') {
            step = 'report';
            renderMain(container);
        }
    } catch (err) {
        if (token !== analyzeToken) return;
        toastr.error(String(err.message ?? err));
        if (step === 'reviewing') {
            step = '';
            renderMain(container);
        }
    }
}

// 采用时往剧情条目上记的事件元信息（历史列表显示用）：取最新一个第 1 步「插入单元」勾选的事件单元
function adoptedEventMeta() {
    const u = unitsState().eventUnits.find(x => x.inPlan);
    if (!u) return null;
    const p = u.payload ?? {};
    const opt = Number.isInteger(p.choiceIdx) ? (p.options ?? [])[p.choiceIdx] : null;
    return { mode: p.mode ?? 'llm', title: p.title ?? '', choice: opt?.label ?? '' };
}

function rewriteByAdvice(container) {
    const active = activeStory();
    if (!active || !report?.advice) return;
    run.note = '';
    // 第 1 步勾选从本对话的记忆恢复，重写与正常规划用同一批材料（与 startCollect 同一套口径）；
    // 第 1 步「插入单元」勾选的单元也照常随材料进入重写（单元池与向导进度各自独立）
    applyPicks();
    if (run.gpIds == null) run.gpIds = storageItemsInEffect().map(i => i.id);   // 与第 1 步同默认：生效中的玩法条目
    run.planText = active.planText;   // 上一版 = 当前剧情
    run.reviseNote = report.advice;   // 报告建议即修改意见
    startAnalyze(container, { revise: true });
}

function reportCardHtml(r, at = 0) {
    if (!r) return '';
    const ooc = r.ooc;
    const items = Array.isArray(ooc?.items) ? ooc.items : [];
    const row = (k, v) => `<div class="pp-gd-rrow"><span class="pp-gd-rk">${k}</span><span class="pp-gd-rv">${v}</span></div>`;
    return `
    <div class="pp-gd-report">
        ${at ? `<div class="pp-muted">检查于 ${new Date(at).toLocaleString()}</div>` : ''}
        ${row('当前剧情完成度', escapeHtml(r.completion ?? '—'))}
        ${row('近几轮是否有效推进', `${r.progress?.moved ? '是' : '否'}${r.progress?.note ? `：${escapeHtml(r.progress.note)}` : ''}`)}
        ${row('文风是否出现重复', `${escapeHtml(r.styleRepeat?.level ?? '—')}${r.styleRepeat?.note ? `：${escapeHtml(r.styleRepeat.note)}` : ''}`)}
        ${row('是否 OOC', ooc?.found && items.length
            ? items.map(it => `<div class="pp-hit"><b>${escapeHtml(it.aspect ?? '')} · ${escapeHtml(it.severity ?? '')}</b><div>${escapeHtml(it.evidence ?? '')}</div><div class="pp-muted">建议：${escapeHtml(it.fix ?? '')}</div></div>`).join('')
            : '<span class="pp-muted">未发现</span>')}
        ${row('是否存在其他问题', (r.otherIssues ?? []).length ? (r.otherIssues ?? []).map(x => `<div>· ${escapeHtml(x)}</div>`).join('') : '<span class="pp-muted">无</span>')}
        ${row('建议', escapeHtml(r.advice ?? ''))}
    </div>`;
}
