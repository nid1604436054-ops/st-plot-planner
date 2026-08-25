// 剧情指导页签：分步规划向导 + 随机事件工具区 + 游戏玩法工具区（均挂在页面底部）
// ① 收集确认（本地检索材料 + 记忆表格档位（停用/标签/常驻）+ 标签勾选与每表最新行补底 + 游戏玩法勾选 + 剧情构思；
// 这些勾选按对话记忆存聊天文件，同一对话做完一轮回来不用重勾；预设不在本页勾——已全局化，
// 「设置」页启用后插件发给大模型的任何调用都自动带上）
// → ② 随机事件闸口（可跳过）→ ③ 模型分析（OOC/剧情重复/文风重复/进度 + 设计剧情）→ ④ 人工二检（打回重写 / 确认采用 / 不保存）
// 确认采用的规划存为「进行中剧情」（story.js，跟聊天文件走）并自动绑定一条剧情注入（换剧情自动换内容，完结自动撤下）；
// 跳过随机事件的路径会先停在「分析前确认」页，点确认才真正调模型。
// 向导进度留底 + 自由跳转（调试排版用）：进行中的向导状态实时快照存 chatdata 的 wizard 块
// （按聊天身份走），刷新页面重开本页自动回到离开的那一步——已生成未处理的规划停在第 4 步等操作；
// 页首常驻 ①②③④ 跳转条随时互跳（已填内容与生成结果保留），跳进没有生成结果的第 4 步可直接往规划框填字看排版。
// 另有「检查当前剧情」：对照进行中剧情出执行报告（完成度/推进/文风/OOC/其他/建议）
// 掷骰入口只有向导第 2 步；页面下部工具区（tab-events.js）只放路人反应与事件库配置；
// 游戏玩法（tab-storage.js）追加挂在底部折叠区容器里与它们并列，生效条目由第 1 步勾选随分析发送，
// 检查报告（runStoryReview）自动附带当前生效条目
import { runPlotGuidance, runStoryReview, buildGuidanceMessages, collectStats, startResearchPrefetch, guidanceResearchInputs } from "../../planner.js";
import { generateRandomEvent, generateFreeRandomEvent, generateAiChoiceRandomEvent, rollEventPipeline, commitRolledEvent } from "../../randomEvents.js";
import { addInjection, updateInjection, removeInjection } from "../../injection.js";
import { settings, save, newId } from "../../settings.js";
import { storyState, activeStory, confirmPlot, endActive, attachReport, deleteStory, clearHistory } from "../../story.js";
import { renderEventsTools, resetEventsTools } from "./tab-events.js";
import { renderStorageTools } from "./tab-storage.js";
import { storageItemsInEffect } from "../../store.js";
import { memoryState } from "../../memoryTable.js";
import { getTavernContext } from "../../context.js";
import { loadChatData, saveChatData } from "../../chatdata.js";
import { escapeHtml, estimateTokens } from "../../utils.js";
import { searchToolReady, withGlobalPresets } from "../../api.js";

// 向导状态机：'' 空闲 | collect ① | event ② | ready 分析前确认 | running ③ | result ④ | reviewing/report 检查报告
let step = '';
const run = {
    note: '',            // 剧情构思方向
    gpIds: null,         // 本次随分析发送的游戏玩法条目 id；null = 未初始化（进第 1 步时默认勾当前生效的）
    event: null,         // { mode:'llm'|'lib'|'manual', title, choice } 入库用
    eventText: '',       // 拼给模型的事件材料
    result: null, raw: '', hits: 0, planText: '', reviseNote: '',
    hadActive: false,   // 本次分析发起时是否存在进行中剧情（第 4 步「剧情进度」行只在这种时候显示）
    memModes: null,      // 第 1 步第一层：每张表的召回档位 { [uid]: 'off' 停用 | 'tags' 按标签 | 'always' 常驻全量 }；null = 未动过（全部常驻全量，与旧默认一致）
    memTags: [],         // 「标签」档的表按哪些标签召回（勾选的标签名，对所有标签档的表生效）
    memRecent: 0,        // 「标签」档的表无论标签都另附的表尾最新行数；0 = 不另附（行没有时间戳，新记录在表尾）
    readyFrom: 'event',  // 分析前确认页的「返回」回到哪一步
    research: null,      // 「分析前确认」页预跑的联网判断 {fingerprint, promise}；分析时指纹对不上自动作废
};
// ② 随机事件闸口的界面状态
const ev = { mode: null, event: null, choiceIdx: null, opinion: '', useLibrary: true, wantPreview: false, busy: false };
// 进行中剧情全文 / 历史列表是否展开；历史里展开查看的条目 id（均只存内存）
let showActive = false, showHistory = false, viewHistId = null;
let report = null;      // 最近一次检查报告（内存缓存，正式存档在 story 条目上）

// ---------------------------------------------------------------------------
// 向导进度快照（chatdata 的 wizard 块，按聊天身份走）：刷新页面后从离开的那一步继续，
// 已生成未处理的规划停在第 4 步等操作。每次重渲染与输入改动都落一次快照（数据量 KB 级，
// 只写 localStorage 热层，不碰聊天文件）；确认采用 / 取消向导时清空。检查报告流（reviewing/
// report）不是向导状态，persistWizard 对非向导步骤直接跳过——第 4 步还没处理的生成结果
// 不会被一次检查报告冲掉。research 持有 Promise、busy 是进行中标志，都不入快照：
// 恢复后进「分析前确认」页会按需重新预跑。
// ---------------------------------------------------------------------------

const WIZARD_STEPS = ['collect', 'event', 'ready', 'running', 'result'];

function persistWizard() {
    if (!WIZARD_STEPS.includes(step)) return;
    saveChatData('wizard', {
        version: 1,
        step,
        run: { ...run, research: undefined },
        ev: { ...ev, busy: undefined },
    });
}

function clearWizard() {
    saveChatData('wizard', null);
}

// 恢复入口：向导空闲（刚刷新 / 刚切聊天重置完）且本聊天存有快照时，把状态装回去。
// 分析在途（running）碰上刷新没法续传，回「分析前确认」重新发起
let restoring = false;   // 恢复渲染期间不触发联网判断预跑——刷新恢复不该无声花一次轻量调用

function restoreWizard(container) {
    if (step) return;   // 向导进行中：内存是权威，不用旧快照覆盖
    const snap = loadChatData('wizard', null);
    if (!snap || snap.version !== 1) return;
    const r = snap.run ?? {}, e = snap.ev ?? {};
    Object.assign(run, {
        note: r.note ?? '',
        gpIds: Array.isArray(r.gpIds) ? r.gpIds : null,
        event: r.event ?? null,
        eventText: r.eventText ?? '',
        result: r.result ?? null,
        raw: r.raw ?? '',
        hits: r.hits ?? 0,
        planText: r.planText ?? '',
        reviseNote: r.reviseNote ?? '',
        hadActive: Boolean(r.hadActive),
        memModes: normalizeMemModes(r.memModes) ?? memModesFromLegacy(r),
        memTags: Array.isArray(r.memTags) ? r.memTags : [],
        memRecent: Math.max(0, Math.round(Number(r.memRecent) || 0)),
        readyFrom: r.readyFrom ?? 'event',
        research: null,
    });
    Object.assign(ev, {
        mode: e.mode ?? null,
        event: e.event ?? null,
        choiceIdx: typeof e.choiceIdx === 'number' ? e.choiceIdx : null,
        opinion: e.opinion ?? '',
        useLibrary: e.useLibrary !== false,
        wantPreview: Boolean(e.wantPreview),
        injectLayers: e.injectLayers,
        busy: false,
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
// 步骤跳转条：向导进行中页首常驻，①②③④随时互跳（已填内容与生成结果保留）。
// 调试排版用——不跑流程也能进任意一步填字段看格式；正常流程照旧走各步自己的按钮
// ---------------------------------------------------------------------------

function stepNavHtml() {
    const cur = step === 'ready' || step === 'running' ? 'ready' : step;
    const items = [
        ['collect', '① 收集', '第 1 步 · 收集确认：材料与勾选'],
        ['event', '② 事件', '第 2 步 · 随机事件闸口'],
        ['ready', '③ 分析', '第 3 步 · 分析前确认：进去后点「确认，开始分析」才调模型'],
        ['result', '④ 二检', '第 4 步 · 人工二检：检查结果与规划文本；没有生成结果时进去是空白二检页，可直接往规划框里填字试排版'],
    ];
    return `<div class="pp-gd-stepnav">${items.map(([id, label, tip]) =>
        `<span class="menu_button${cur === id ? ' pp-gd-navcur' : ''}" data-goto="${id}" title="${tip}。四步随时互跳，已填内容与生成结果保留，刷新页面后也从这一步继续">${label}</span>`).join('')}</div>`;
}

function gotoStep(container, target) {
    if (target === step || !WIZARD_STEPS.includes(target)) return;
    if (target === 'collect') return startCollect(container);   // 与正常入口同一套：勾选从对话记忆恢复、玩法补默认
    if (target === 'ready') {
        if (analyzeBusy) {   // 分析还在跑：点 ③ 回到的是实时输出页，不给再来一张确认页（防重复发起白花调用）
            step = 'running';
            renderMain(container);
            return;
        }
        run.readyFrom = step === 'collect' ? 'collect' : 'event';   // 「返回」按钮落回合理位置
    }
    step = target;
    renderMain(container);
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
    const uids = state.mirror.sheets
        .filter(s => (state.sheetRecall[s.uid] ?? {}).enabled !== false)
        .map(s => s.uid);
    const picked = Array.isArray(r.memSheets) ? new Set(r.memSheets) : null;
    const out = {};
    for (const uid of uids) out[uid] = picked && !picked.has(uid) ? 'off' : (r.memMatch ? 'tags' : 'always');
    return normalizeMemModes(out);
}

function applyPicks() {
    const p = loadChatData('picks', null);
    if (!p) {
        run.memModes = null;
        run.memTags = [];
        run.memRecent = 0;
        run.gpIds = null;
        return;
    }
    run.memModes = normalizeMemModes(p.memModes) ?? memModesFromLegacy(p);
    run.memTags = Array.isArray(p.memTags) ? p.memTags : [];
    run.memRecent = Math.max(0, Math.round(Number(p.memRecent) || 0));
    run.gpIds = Array.isArray(p.gpIds) ? p.gpIds : null;
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
        // 挂进事件工具区的折叠区容器：三个根折叠区同容器，边距合并、间距一致
        renderStorageTools(container.querySelector('#pp_ev_settings_wrap'));
    },
};

// 聊天切换时由 index.js 调用：清掉向导进度，避免 A 聊天的规划带到 B 聊天；
// 剧情数据、第 1 步勾选与向导快照本身存 chatdata.js（按聊天身份走），下面重新 render 时
// restoreWizard 会自动恢复新聊天自己的快照——切回来，没处理完的向导还在
export function resetGuidance() {
    step = '';
    analyzeToken++;   // 在途的分析/检查流式回调与结果全部作废（不写进新聊天）
    Object.assign(run, {
        note: '', gpIds: null, event: null, eventText: '', result: null, raw: '', hits: 0, planText: '', reviseNote: '', hadActive: false,
        memModes: null, memTags: [], memRecent: 0, readyFrom: 'event', research: null,
    });
    Object.assign(ev, { mode: null, event: null, choiceIdx: null, opinion: '', useLibrary: true, wantPreview: false, busy: false });
    resetEventsTools();   // 底部工具区的反应卡也是当前聊天的内容
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
            <span class="menu_button" id="pp_gd_story_review">检查当前剧情</span>
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
    // 步骤跳转条：向导进行中常驻；分析中也能跳走，结果落地后不抢页面、只提示到第 4 步看
    if (WIZARD_STEPS.includes(step)) {
        main.insertAdjacentHTML('afterbegin', stepNavHtml());
        main.querySelectorAll('[data-goto]').forEach(b => b.addEventListener('click', () => gotoStep(container, b.dataset.goto)));
    }
}

function renderStepPage(container, main) {
    if (step === 'collect') return renderCollect(container, main);
    if (step === 'event') return renderEvent(container, main);
    if (step === 'ready') return renderReady(container, main);

    if (step === 'running') {
        main.innerHTML = `
        <div class="pp-section">
            <div class="pp-gd-stephead"><b>第 3 步 · 分析中</b><span class="pp-muted" id="pp_gd_run_stage"></span></div>
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

// 联网搜索是否会对本次分析生效：设置页开了「分析前联网判断」且填了搜索密钥。
// 生效时分析前先由一次无工具的轻量判断决定要不要联网（只发剧情简报），判需要才直查，
// 纪要附加进分析材料
const searchToolActive = () => settings.search?.toolMode !== false && searchToolReady();

// 第 2 步事件生成用的材料 = 第 1 步的本次选择（记忆表范围/标签、玩法勾选），
// 与分析调用完全同一批——两步口径一致才能互相对账；预设走全局，出口自动附带
function wizardMaterials() {
    return {
        memoryTags: wizardMemoryTags(),
        memoryModes: wizardMemoryModes(),
        memoryRecent: wizardMemoryRecent(),
        storageItems: wizardStorageItems(),
    };
}

// 跳过类按钮先停在「分析前确认」页，不直接花一次模型调用
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
    // 第一层只列开了「参与召回」的表（与记忆表格页的召回开关取交集）
    const recallSheets = state.mirror.sheets.filter(s => (state.sheetRecall[s.uid] ?? {}).enabled !== false);
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
        <div class="pp-gd-stat"><span id="pp_gd_c1_stat"></span><span class="pp-muted" id="pp_gd_c1_count" title="预设全局生效：「设置」页勾选启用的预设会拼进插件发给大模型的每一次调用的系统提示词（规划分析/检查报告/随机事件/路人反应/AI 打标/AI 建库/联网判断），开关在「设置」页"> · 预设 ${presets.filter(p => p.enabled).length}/${presets.length} 全局生效${activeStory() ? ' · 已附进行中剧情' : ''}</span></div>
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
                    <label class="pp-gd-recentrow" id="pp_gd_c1_recent_wrap" title="标签过滤会漏掉近期发生但没打标签的事件：这里填 N，「标签」档的每张表无论行上有没有标签、命没命中勾选的标签，都把表尾最新的 N 行一并带给模型——比如「重要事件」表在标签档、这里填 30，它最新 30 条一定在材料里。「常驻」档本来就全量、用不上本项。记忆行没有时间戳，按表内顺序新记录追加在表尾，「最新」即表尾；0 = 不另附">「标签」档每表另附最新 <input type="number" class="text_pole" id="pp_gd_c1_recent" min="0" step="1" value="${run.memRecent}" /> 行（无论标签）</label>
                    <span class="pp-muted" id="pp_gd_c1_memtip"></span>
                </div>
            </div>
        </div>` : `
        <div class="pp-gd-layhead"><label class="pp-label">记忆表格召回</label></div>
        <div class="pp-muted">没有开启「参与召回」的记忆表，本次不附带</div>`}
        <label class="pp-label" title="勾选的玩法规则随分析发给模型，规划须按其约束设计；勾选随当前对话记忆，首轮默认勾当前生效中的条目">游戏玩法</label>
        <div class="pp-gd-selp">
            ${gpItems.map(i => `<label title="勾选后该条玩法规则作为材料发给规划模型（不影响它注入主对话）"><input type="checkbox" data-c1g="${i.id}" ${(run.gpIds ?? []).includes(i.id) ? 'checked' : ''}/> ${escapeHtml(i.name)}${gpHit.has(i.id) ? ' <span class="pp-badge pp-badge-open">生效中</span>' : ''}</label>`).join('')
            || '<span class="pp-muted">还没有玩法条目</span>'}
        </div>
        <label class="pp-label">剧情构思方向</label>
        <textarea id="pp_gd_note" class="text_pole textarea_compact" rows="3" placeholder="已有的想法、约束或重点（可选，随分析发给模型）"></textarea>
        <div class="pp-btn-row">
            <span id="pp_gd_c1_next" class="menu_button">下一步：随机事件</span>
            <span id="pp_gd_c1_skip" class="menu_button">跳过事件，直接分析</span>
            <span id="pp_gd_c1_cancel" class="menu_button">取消</span>
        </div>
    </div>
    <div id="pp_gd_promptview" class="pp-gd-builtin" style="display:none"></div>`;

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
        const st = collectStats({ memoryTags: wizardMemoryTags(), memoryModes: wizardMemoryModes(), memoryRecent: wizardMemoryRecent() });
        const memSeg = !recallSheets.length ? '记忆表格 不附带'
            : `记忆表格 ${st.memChars} 字（${memScopeDesc()}）`;
        const gpDesc = gpItems.length ? ` · 玩法 ${(run.gpIds ?? []).length} 条` : '';
        main.querySelector('#pp_gd_c1_stat').textContent =
            `对话 ${st.layers} 层 · 世界书命中 ${st.hits} 条 · ${memSeg}${gpDesc}`;
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
            ? tags.map(([t, n]) => `<label class="pp-mem-chip" title="带这个标签的记忆行"><input type="checkbox" data-mtag="${escapeHtml(t)}" ${run.memTags.includes(t) ? 'checked' : ''}/> ${escapeHtml(t)} (${n})</label>`).join('')
            : '<span class="pp-muted">所选表格里还没有带标签的行：到「记忆表格」页打标签</span>';
        chipsBox.querySelectorAll('[data-mtag]').forEach(cb => cb.addEventListener('change', () => {
            run.memTags = [...chipsBox.querySelectorAll('[data-mtag]:checked')].map(x => x.dataset.mtag);
            savePicks();
            persistWizard();
            refreshMem();
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

    main.querySelector('#pp_gd_c1_preview').addEventListener('click', () => {
        const view = main.querySelector('#pp_gd_promptview');
        if (view.style.display !== 'none') { view.style.display = 'none'; return; }
        try {
            const s = storyState();
            const built = buildGuidanceMessages({
                userNote: run.note,
                eventText: run.eventText,
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
            const secLine = sections.map(x => `${x.title} ${x.chars.toLocaleString()} 字`).join(' · ');
        view.innerHTML = `<div class="pp-muted" style="margin-bottom:6px" title="按「中日韩全角字符≈1 token、英文数字≈4字符=1 token」粗估，各家模型分词器不同，仅供规模参考；实际分词通常更省（中文约 1.4~1.6 字/token）；这是输入规模，不占「单次上限 tokens」${searchToolActive() ? '；已开联网搜索：分析前先轻量判断是否需要现实信息（只发剧情简报，纯虚构默认不检索），判需要才检索，纪要追加为附加小节，不在此预览内' : ''}">材料共 ${totalChars.toLocaleString()} 字 · 粗估约 ${(sysTok + usrTok).toLocaleString()} tokens</div>`
            + `<div class="pp-muted" style="margin-bottom:6px" title="逐小节的精确字符数（非估算）。世界书一节只含关键词命中或状态为「常驻」的条目，不是全部词条——想让重要词条每次都带上，到「世界书」页把状态切到「常驻」">材料构成：${escapeHtml(secLine)}</div>`
                + escapeHtml(`【系统提示词】\n${sysMsg.content}\n\n【用户消息】\n${usrMsg.content}`);
            view.style.display = '';
        } catch (err) {
            toastr.error(String(err.message ?? err));
        }
    });

    main.querySelector('#pp_gd_c1_next').addEventListener('click', () => { step = 'event'; renderMain(container); });
    main.querySelector('#pp_gd_c1_skip').addEventListener('click', () => {
        run.event = null;
        run.eventText = '';
        goReady(container, 'collect');
    });
    main.querySelector('#pp_gd_c1_cancel').addEventListener('click', () => {
        step = '';
        clearWizard();   // 主动退出：快照一并清空，刷新不再回到向导
        renderMain(container);
    });
}

// 分析前确认：材料清单一目了然，点确认才真正调模型
function renderReady(container, main) {
    const presets = settings.guidance?.presets ?? [];
    const stat = collectStats({ memoryTags: wizardMemoryTags(), memoryModes: wizardMemoryModes(), memoryRecent: wizardMemoryRecent() });
    // 档位口径与第 1 步状态行同一套：常驻 X 表 · 标签 Y 表（…）· 停用 Z 表
    const memState = memoryState();
    const sheets = memState.mirror.sheets.filter(s => (memState.sheetRecall[s.uid] ?? {}).enabled !== false);
    const modeOf = uid => (run.memModes ?? {})[uid] ?? 'always';
    const always = sheets.filter(s => modeOf(s.uid) === 'always').length;
    const tagsN = sheets.filter(s => modeOf(s.uid) === 'tags').length;
    const memDesc = !sheets.length ? '无可召回的表'
        : !always && !tagsN ? '不附带（全部停用）'
        : [
            always ? `常驻 ${always} 表` : '',
            tagsN ? `标签 ${tagsN} 表${run.memTags.length ? `按 ${run.memTags.length} 类${run.memRecent ? ` + 每表最新 ${run.memRecent} 行` : ''}` : (run.memRecent ? `（未勾标签·只带每表最新 ${run.memRecent} 行）` : '（未勾标签·不带）')}` : '',
            sheets.length - always - tagsN ? `停用 ${sheets.length - always - tagsN} 表` : '',
        ].filter(Boolean).join(' · ');
    const gpOn = settings.storageItems.some(i => i.enabled);
    main.innerHTML = `
    <div class="pp-section">
        <b>分析前确认</b>
        <div class="pp-gd-stat">对话 ${stat.layers} 层 · 世界书命中 ${stat.hits} 条 · 预设 ${presets.filter(p => p.enabled).length}/${presets.length} 全局生效 · 随机事件：${run.event?.title ? escapeHtml(run.event.title) : '无'}</div>
        <div class="pp-gd-stat pp-muted">记忆表格：${memDesc}${stat.memChars ? `，${stat.memChars} 字` : ''}${gpOn ? ` · 玩法 ${(run.gpIds ?? []).length} 条` : ''}${activeStory() ? ' · 附进行中剧情' : ''}${searchToolActive() ? ' · 联网搜索：开（先轻量判断，需要才检索）' : ''}</div>
        <div class="pp-btn-row">
            <span id="pp_gd_ready_go" class="menu_button" title="走插件独立 API 调用一次，计费按你配置的接口">确认，开始分析</span>
            <span id="pp_gd_ready_back" class="menu_button">返回</span>
        </div>
    </div>`;
    // 联网判断预跑：进这一页时材料与事件已定型，趁用户核对的几秒把判断跑完；
    // 分析时指纹对不上（这之后输入又变了）会自动作废重判。
    // 刷新恢复进本页（restoring）不预跑——那不是用户动作，不该无声花一次调用；
    // 点「确认，开始分析」时 prefetch 为空会照常内联判断，不漏
    run.research = searchToolActive() && !restoring
        ? startResearchPrefetch(guidanceResearchInputs({
            userNote: run.note,
            eventText: run.eventText,
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

// ② 随机事件闸口：大模型随机 / 事件库掷骰 / 自己给意见，三选一，也可跳过
function renderEvent(container, main) {
    main.innerHTML = `
    <div class="pp-section">
        <div class="pp-gd-stephead"><b>第 2 步 · 随机事件（可选）</b></div>
        <div class="pp-gd-selp">
            <label title="把事件库规则的名称与提示给模型参考，可从中选方向也可另起"><input type="checkbox" id="pp_gd_ev_lib" ${ev.useLibrary ? 'checked' : ''}/> 参考事件库</label>
            <label title="事件生成的同时让模型顺带给一版后续走向预览（仅供参考，正式规划仍走第 3 步分析）"><input type="checkbox" id="pp_gd_ev_prev" ${ev.wantPreview ? 'checked' : ''}/> 顺带出预览剧情</label>
        </div>
        <div class="pp-btn-row">
            <span id="pp_gd_ev_llm" class="menu_button" title="不经掷骰，直接让模型即兴生成；选定的事件融入本次规划，事件卡上也可转为隐身注入"><i class="fa-solid fa-dice"></i> 大模型随机</span>
            <span id="pp_gd_ev_roll" class="menu_button" title="掷骰管线：先在勾选的掷骰板块（事件条目/维度随机/AI自主）里按板块权重抽一个——条目板块按权重×概率抽一条（必出），维度随机按维度权重抽方向，AI自主由模型看剧情挑维度；板块开关与权重在本页底部「事件库设置」"><i class="fa-solid fa-dice-three"></i> 掷骰</span>
        </div>
        <label class="pp-label">或自己给意见</label>
        <textarea id="pp_gd_ev_manual" class="text_pole textarea_compact" rows="2" placeholder="不掷骰，直接写下你的事件或走向想法"></textarea>
        <div id="pp_gd_ev_out"></div>
        <div class="pp-btn-row">
            <span id="pp_gd_ev_done" class="menu_button">确认，开始分析</span>
            <span id="pp_gd_ev_skip" class="menu_button">跳过随机事件</span>
            <span id="pp_gd_ev_back" class="menu_button">上一步</span>
        </div>
        <div id="pp_gd_status" class="pp-muted"></div>
    </div>`;

    const manual = main.querySelector('#pp_gd_ev_manual');
    manual.value = ev.opinion;
    manual.addEventListener('input', () => { ev.opinion = manual.value; persistWizard(); });
    main.querySelector('#pp_gd_ev_lib').addEventListener('change', e => { ev.useLibrary = e.target.checked; persistWizard(); });
    main.querySelector('#pp_gd_ev_prev').addEventListener('change', e => { ev.wantPreview = e.target.checked; persistWizard(); });

    const out = main.querySelector('#pp_gd_ev_out');
    const status = main.querySelector('#pp_gd_status');
    if (ev.event) renderEvCard(out);

    main.querySelector('#pp_gd_ev_llm').addEventListener('click', async () => {
        if (ev.busy) return;
        ev.busy = true;
        status.textContent = '大模型随机生成中……';
        try {
            ev.mode = 'llm';
            ev.event = await generateFreeRandomEvent({ useLibrary: ev.useLibrary, wantPreview: ev.wantPreview, materials: wizardMaterials() });
            ev.choiceIdx = null;
            renderEvCard(out);
            status.textContent = '已生成（点选项选定走向，也可都不选只当参考）';
        } catch (err) {
            status.textContent = '';
            toastr.error(String(err.message ?? err));
        } finally {
            ev.busy = false;
        }
    });
    main.querySelector('#pp_gd_ev_roll').addEventListener('click', async () => {
        if (ev.busy) return;
        const r = rollEventPipeline();
        if (r.mode === 'none') {
            status.textContent = `本次未掷出事件（${r.reason}），可再掷或改用「大模型随机」`;
            return;
        }
        ev.busy = true;
        status.textContent = r.mode === 'library'
            ? `掷中「${r.rule.name}」，生成中……`
            : r.mode === 'ai'
                ? 'AI 自主挑维度中，生成中……'
                : `维度「${r.dimension.name}」自由生成中……`;
        try {
            if (r.mode === 'library') {
                ev.mode = 'lib';
                ev.event = await generateRandomEvent(r.rule, wizardMaterials());
                commitRolledEvent({ rule: r.rule, dimension: r.dimension, title: ev.event.title, source: 'library' });
                status.textContent = `来自事件库「${r.rule.name}」`;
            } else if (r.mode === 'ai') {
                ev.mode = 'ai';
                ev.event = await generateAiChoiceRandomEvent({ dimensions: r.dimensions, materials: wizardMaterials() });
                const dim = r.dimensions.find(d => d.name === ev.event?.dimension) ?? null;
                commitRolledEvent({ dimension: dim, title: ev.event.title, source: 'ai' });
                status.textContent = `来自 AI 自主${dim ? `·维度「${dim.name}」` : ''}`;
            } else {
                ev.mode = 'free';
                ev.event = await generateFreeRandomEvent({ dimension: r.dimension, useLibrary: ev.useLibrary, wantPreview: ev.wantPreview, materials: wizardMaterials() });
                commitRolledEvent({ dimension: r.dimension, title: ev.event.title, source: 'free' });
                status.textContent = `来自维度「${r.dimension.name}」自由生成`;
            }
            ev.choiceIdx = null;
            renderEvCard(out);
        } catch (err) {
            status.textContent = '';
            toastr.error(String(err.message ?? err));
        } finally {
            ev.busy = false;
        }
    });
    main.querySelector('#pp_gd_ev_done').addEventListener('click', () => {
        const e = ev.event;
        const op = ev.opinion.trim();
        if (e) {
            const opt = ev.choiceIdx != null ? (e.options ?? [])[ev.choiceIdx] : null;
            run.event = { mode: ev.mode ?? 'llm', title: e.title ?? '', choice: opt?.label ?? '' };
            run.eventText = `【${e.title ?? ''}】${e.description ?? ''}`
                + (e.preview ? `\n预览走向：${e.preview}` : '')
                + (opt ? `\n已选走向：${opt.label ?? ''}（幕后提示：${opt.hint ?? ''}）` : '')
                + (op ? `\n附加意见：${op}` : '');
        } else if (op) {
            run.event = { mode: 'manual', title: '', choice: '' };
            run.eventText = `【事件指导意见】${op}`;
        } else {
            run.event = null;
            run.eventText = '';
        }
        startAnalyze(container);
    });
    main.querySelector('#pp_gd_ev_skip').addEventListener('click', () => {
        run.event = null;
        run.eventText = '';
        goReady(container, 'event');
    });
    main.querySelector('#pp_gd_ev_back').addEventListener('click', () => { step = 'collect'; renderMain(container); });
}

function renderEvCard(out) {
    const e = ev.event;
    const options = Array.isArray(e.options) ? e.options : [];
    const layers = clampInjectLayers(ev.injectLayers);
    ev.injectLayers = layers;
    out.innerHTML = `
    <div class="pp-item pp-gd-evcard">
        <div class="pp-gd-evtitle">${escapeHtml(e.title ?? '随机事件')}</div>
        <div class="pp-gd-evdesc">${escapeHtml(e.description ?? '')}</div>
        ${e.preview ? `<div class="pp-gd-evpreview pp-muted">预览走向：${escapeHtml(e.preview)}</div>` : ''}
        ${options.length ? `
        <div class="pp-label pp-gd-evoptlabel">走向选项（点选一个定向，再点一次取消；都不选＝只作参考）</div>
        ${options.map((o, i) => `
            <div class="menu_button pp-option ${ev.choiceIdx === i ? 'pp-gd-sel' : ''}" data-evopt="${i}">
                <span class="pp-option-label">${escapeHtml(o.label ?? '')}</span>
                ${o.hint ? `<span class="pp-option-hint">幕后提示：${escapeHtml(o.hint ?? '')}</span>` : ''}
            </div>`).join('')}
        ${ev.choiceIdx == null ? '' : `<div class="pp-muted">已选：${escapeHtml(options[ev.choiceIdx]?.label ?? '')}</div>`}` : ''}
        <div class="pp-btn-row pp-gd-evops">
            <label title="隐身注入多少层后自动撤下；一层 = 一条角色回复（user 消息不计）">注入层数
                <input type="number" class="text_pole" id="pp_gd_ev_layers" min="1" max="200" step="1" value="${layers}" />
            </label>
            <span id="pp_gd_ev_inject" class="menu_button" title="把事件与已选走向直接写成一条隐身注入（模型可见、聊天界面不显示），按所填层数到期自动撤下；不经过第 3 步分析，也不影响事件作为材料融入本次规划">转为隐身注入</span>
        </div>
    </div>`;
    out.querySelectorAll('[data-evopt]').forEach(el => el.addEventListener('click', () => {
        const i = Number(el.dataset.evopt);
        ev.choiceIdx = ev.choiceIdx === i ? null : i;
        persistWizard();
        renderEvCard(out);
    }));
    const layersEl = out.querySelector('#pp_gd_ev_layers');
    // 点选走向会整卡重渲染，input 事件实时回存，重渲染后数值不丢
    layersEl.addEventListener('input', () => {
        const v = Number(layersEl.value);
        if (Number.isFinite(v)) { ev.injectLayers = v; persistWizard(); }
    });
    layersEl.addEventListener('change', () => {
        const v = clampInjectLayers(Number(layersEl.value));
        ev.injectLayers = v;
        persistWizard();
        layersEl.value = String(v);
    });
    out.querySelector('#pp_gd_ev_inject').addEventListener('click', () => {
        const opt = ev.choiceIdx != null ? options[ev.choiceIdx] : null;
        if (!opt) {
            toastr.warning('先点选一个走向再注入（都不选则只把事件当参考）');
            return;
        }
        const injLayers = clampInjectLayers(ev.injectLayers);
        addInjection({
            id: newId('inj-'),
            label: `事件：${e.title ?? ''} · ${opt.label ?? ''}`,
            mode: 'open',
            content: `【随机事件·${e.title ?? ''}】${e.description ?? ''}\n已选定走向：${opt.label ?? ''}\n幕后提示：${opt.hint ?? ''}`,
            depth: 4,
            role: 'system',
            scope: 'chat',
            enabled: true,
            source: 'event',
            createdAt: Date.now(),
            expires: { type: 'layers', layers: injLayers },
        });
        toastr.success(`已注入，${injLayers} 层后自动撤下（设置页底部可提前撤下）`);
    });
}

function clampInjectLayers(v) {
    return Math.min(Math.max(Math.round(Number(v) || 20), 1), 200);
}

// ---------------------------------------------------------------------------
// ③ 分析调用 / ④ 人工二检 + 封装
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
        const data = await runPlotGuidance({
            userNote: run.note,
            previousPlan: revise ? run.planText : '',
            revisionNote: revise ? run.reviseNote : '',
            eventText: run.eventText,
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
            toastr.info('分析已完成，点上方「④ 二检」查看');
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
        <div class="pp-gd-stephead"><b>第 4 步 · 人工二检</b><span class="pp-muted">世界书命中 ${run.hits} 条</span></div>
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
        <label class="pp-label">修改意见</label>
        <textarea id="pp_gd_revise_note" class="text_pole textarea_compact" rows="2" placeholder="填给模型的修改要求，点「打回重新生成」生效"></textarea>
        <label class="pp-label" title="默认沿用上次；「确认采用」的剧情注入也按这里的深度与角色注入（剧情注入永不过期，完结时自动撤下）">注入参数</label>
        <div class="pp-gd-selp pp-gd-injrow">
            <label>深度 <input type="number" class="text_pole" id="pp_gd_inj_depth" min="0" max="100" step="1" title="0 = 紧贴上下文末尾；数字越大越靠前" /></label>
            <label>角色 <select class="text_pole" id="pp_gd_inj_role"><option value="system">system</option><option value="user">user</option></select></label>
            <label>过期 <select class="text_pole" id="pp_gd_inj_exp"><option value="never">永久</option><option value="layers">N 层后</option></select></label>
            <label id="pp_gd_inj_layers_wrap" hidden>层数 <input type="number" class="text_pole" id="pp_gd_inj_layers" min="1" step="1" /></label>
        </div>
        <div class="pp-btn-row">
            <span id="pp_gd_adopt" class="menu_button">确认采用</span>
            <span id="pp_gd_revise" class="menu_button">打回重新生成</span>
            <span id="pp_gd_inject" class="menu_button" title="手动转一条隐身注入（与剧情自动注入相互独立，按上面的过期设置）">转为隐身注入</span>
            <span id="pp_gd_discard" class="menu_button" title="丢弃本次生成（构思、预设与事件选择保留）">不保存，回到第 1 步</span>
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
            event: run.event,
        });
        syncStoryInjection(run.planText, run.result?.plan?.summary ?? '');
        toastr.success('已存为进行中剧情并自动注入（原剧情自动归档，可在历史回看）');
        step = '';
        // 第 1 步勾选存在对话记忆里，下一轮进第 1 步自动恢复，这里照常清工作副本
        Object.assign(run, {
            note: '', gpIds: null, event: null, eventText: '', result: null, raw: '', hits: 0, planText: '', reviseNote: '', hadActive: false,
            memModes: null, memTags: [], memRecent: 0, readyFrom: 'event', research: null,
        });
        // 第 2 步闸口状态一并清空：上一轮的事件卡/走向/意见不带进新一轮规划（「不保存，回到第 1 步」才保留）
        Object.assign(ev, { mode: null, event: null, choiceIdx: null, opinion: '', useLibrary: true, wantPreview: false, busy: false });
        report = null;
        clearWizard();   // 已采用：快照清空，刷新页面不再回到第 4 步
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
        toastr.success('已注入（模型可见、聊天界面不显示；设置页底部可提前撤下）');
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
        const data = await runStoryReview({
            planText: active.planText,
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

function rewriteByAdvice(container) {
    const active = activeStory();
    if (!active || !report?.advice) return;
    run.note = '';
    // 第 1 步勾选从本对话的记忆恢复，重写与正常规划用同一批材料（与 startCollect 同一套口径）
    applyPicks();
    if (run.gpIds == null) run.gpIds = storageItemsInEffect().map(i => i.id);   // 与第 1 步同默认：生效中的玩法条目
    run.event = null;
    run.eventText = '';
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
