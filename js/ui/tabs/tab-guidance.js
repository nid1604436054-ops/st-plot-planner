// 剧情指导页签：分步规划向导 + 随机事件工具区 + 游戏玩法工具区（均挂在页面底部）
// ① 收集确认（本地检索材料 + 记忆表格两层筛选（表范围/标签）+ 游戏玩法勾选 + 剧情构思；
// 这些勾选按对话记忆存聊天文件，同一对话做完一轮回来不用重勾；预设不在本页勾——已全局化，
// 「设置」页启用后插件发给大模型的任何调用都自动带上）
// → ② 随机事件闸口（可跳过）→ ③ 模型分析（OOC/剧情重复/文风重复/进度 + 设计剧情）→ ④ 人工二检（打回重写 / 确认采用 / 不保存）
// 确认采用的规划存为「进行中剧情」（story.js，跟聊天文件走）并自动绑定一条剧情注入（换剧情自动换内容，完结自动撤下）；
// 跳过随机事件的路径会先停在「分析前确认」页，点确认才真正调模型。
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
    memSheets: null,     // 第 1 步第一层：勾选的表 uid；null = 全部（开了召回的表），[] = 一张不带
    memMatch: false,     // 第 1 步第二层：是否按标签匹配召回记忆表格
    memTags: [],         // 按标签匹配时勾选的标签名
    readyFrom: 'event',  // 分析前确认页的「返回」回到哪一步
    research: null,      // 「分析前确认」页预跑的联网判断 {fingerprint, promise}；分析时指纹对不上自动作废
};
// ② 随机事件闸口的界面状态
const ev = { mode: null, event: null, choiceIdx: null, opinion: '', useLibrary: true, wantPreview: false, busy: false };
// 进行中剧情全文 / 历史列表是否展开；历史里展开查看的条目 id（均只存内存）
let showActive = false, showHistory = false, viewHistId = null;
let report = null;      // 最近一次检查报告（内存缓存，正式存档在 story 条目上）

// ---------------------------------------------------------------------------
// 第 1 步勾选按对话记忆（chatdata.js 的 picks 块）：记忆表格的表范围/标签匹配/标签、
// 游戏玩法的勾选都按对话各自记住——同一对话做完一轮规划回来不用重勾，换对话各用各的。
// 预设不在这里：已全局化，「设置」页的启用开关是唯一开关。run 是工作副本，进第 1 步时
// 从这里恢复；每次勾选变动立即写回（历史数据里的 presetIds 字段读回时忽略）
// ---------------------------------------------------------------------------

function applyPicks() {
    const p = loadChatData('picks', null);
    if (!p) {
        run.memSheets = null;
        run.memMatch = false;
        run.memTags = [];
        run.gpIds = null;
        return;
    }
    run.memSheets = Array.isArray(p.memSheets) ? p.memSheets : null;
    run.memMatch = Boolean(p.memMatch);
    run.memTags = Array.isArray(p.memTags) ? p.memTags : [];
    run.gpIds = Array.isArray(p.gpIds) ? p.gpIds : null;
}

function savePicks() {
    saveChatData('picks', {
        version: 1,
        memSheets: run.memSheets,
        memMatch: run.memMatch,
        memTags: run.memTags,
        gpIds: run.gpIds,
    });
}

// 分析/检查的流式显示：onDelta 累计文本 + 当前阶段。analyzeToken 让旧一轮在途的流式回调
// 与结果不写进切换后的新聊天（resetGuidance 时递增作废）
let analyzeToken = 0;
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
        renderEventsTools(container.querySelector('#pp_gd_events'));
        // 挂进事件工具区的折叠区容器：三个根折叠区同容器，边距合并、间距一致
        renderStorageTools(container.querySelector('#pp_ev_settings_wrap'));
    },
};

// 聊天切换时由 index.js 调用：清掉向导进度，避免 A 聊天的规划带到 B 聊天；
// 剧情数据与第 1 步勾选本身存 chatdata.js（按聊天身份走），切换自动恢复各自的
export function resetGuidance() {
    step = '';
    analyzeToken++;   // 在途的分析/检查流式回调与结果全部作废（不写进新聊天）
    Object.assign(run, {
        note: '', gpIds: null, event: null, eventText: '', result: null, raw: '', hits: 0, planText: '', reviseNote: '', hadActive: false,
        memSheets: null, memMatch: false, memTags: [], readyFrom: 'event', research: null,
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

// 本次运行的记忆表格召回方式 → planner 的 memoryTags：
// 不匹配 = []（全量）；按标签但一个没勾 = false（不附带）；按标签 = 标签名数组
function wizardMemoryTags() {
    if (!run.memMatch) return [];
    return run.memTags.length ? run.memTags : false;
}

// 本次运行的记忆表格表范围 → planner 的 memorySheets：
// null = 全部（开了召回的表）；数组 = 勾选的表（可为空 = 一张不带）
function wizardMemorySheets() {
    return run.memSheets;
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
        memorySheets: wizardMemorySheets(),
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
                <label class="pp-label" title="勾选随当前对话记忆（存聊天文件），下一轮规划回来不用重勾；不改记忆表格页的配置">记忆表格召回</label>
                <span id="pp_gd_mem_jump" class="menu_button" title="标签词表与 AI 打标签在「记忆表格」页管理">管理标签 ›</span>
            </div>
            <div class="pp-gd-memlay">
                <div>
                    <b class="pp-gd-layname">表格范围</b>
                    <div class="pp-gd-selp" id="pp_gd_c1_sheets">
                        ${recallSheets.map(s => `<label title="勾掉后本次分析不带这张表的记忆行"><input type="checkbox" data-msheet="${escapeHtml(s.uid)}" ${run.memSheets == null || run.memSheets.includes(s.uid) ? 'checked' : ''}/> ${escapeHtml(s.name)} · ${s.rows.length} 行</label>`).join('')}
                    </div>
                </div>
                <div>
                    <b class="pp-gd-layname">标签过滤</b>
                    <label title="勾选后只带所选标签的行；不勾则所选表格全量带出"><input type="checkbox" id="pp_gd_c1_memmatch" ${run.memMatch ? 'checked' : ''}/> 按标签匹配</label>
                    <div class="pp-gd-selp" id="pp_gd_c1_chips" ${run.memMatch ? '' : 'style="display:none"'}></div>
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

    const memModeDesc = () => Array.isArray(run.memSheets) && !run.memSheets.length ? '不附带（未选表格）'
        : run.memMatch
            ? (run.memTags.length ? `按标签 ${run.memTags.length} 类` : '不附带（未勾标签）')
            : '全量';
    const refreshMem = () => {
        const st = collectStats({ memoryTags: wizardMemoryTags(), memorySheets: wizardMemorySheets() });
        const sheetDesc = run.memSheets == null ? '全部表' : `${run.memSheets.length} 张表`;
        const memSeg = !recallSheets.length ? '记忆表格 不附带'
            : `记忆表格 ${st.memChars} 字（${sheetDesc} · ${memModeDesc()}）`;
        const gpDesc = gpItems.length ? ` · 玩法 ${(run.gpIds ?? []).length} 条` : '';
        main.querySelector('#pp_gd_c1_stat').textContent =
            `对话 ${st.layers} 层 · 世界书命中 ${st.hits} 条 · ${memSeg}${gpDesc}`;
        const chipsEl = main.querySelector('#pp_gd_c1_chips');
        if (chipsEl) chipsEl.style.display = run.memMatch ? '' : 'none';
        const tipEl = main.querySelector('#pp_gd_c1_memtip');
        if (tipEl) tipEl.textContent =
            run.memMatch && !run.memTags.length ? '未勾选任何标签，本次将不附带记忆表格' : '';
    };

    // 第二层标签 chips 的计数只统计第一层所选表格里的行；选表变了就地重建
    // （无可召回的表时整个记忆区块不渲染，chipsBox 为空直接跳过）
    const chipsBox = main.querySelector('#pp_gd_c1_chips');
    const renderChips = () => {
        if (!chipsBox) return;
        const scope = new Set(run.memSheets ?? recallSheets.map(s => s.uid));
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
            refreshMem();
        }));
    };
    renderChips();
    refreshMem();

    main.querySelectorAll('#pp_gd_c1_sheets [data-msheet]').forEach(cb => cb.addEventListener('change', () => {
        run.memSheets = [...main.querySelectorAll('#pp_gd_c1_sheets [data-msheet]:checked')].map(x => x.dataset.msheet);
        savePicks();
        renderChips();
        refreshMem();
    }));
    main.querySelector('#pp_gd_mem_jump')?.addEventListener('click', () =>
        document.dispatchEvent(new CustomEvent('pp-switch-tab', { detail: { id: 'memory' } })));

    const noteEl = main.querySelector('#pp_gd_note');
    noteEl.value = run.note;
    noteEl.addEventListener('input', () => { run.note = noteEl.value; });

    main.querySelector('#pp_gd_c1_memmatch')?.addEventListener('change', e => {
        run.memMatch = e.target.checked;
        savePicks();
        refreshMem();
    });

    main.querySelectorAll('[data-c1g]').forEach(cb => cb.addEventListener('change', () => {
        run.gpIds = [...main.querySelectorAll('[data-c1g]:checked')].map(x => x.dataset.c1g);
        savePicks();
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
                memorySheets: wizardMemorySheets(),
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
    main.querySelector('#pp_gd_c1_cancel').addEventListener('click', () => { step = ''; renderMain(container); });
}

// 分析前确认：材料清单一目了然，点确认才真正调模型
function renderReady(container, main) {
    const presets = settings.guidance?.presets ?? [];
    const stat = collectStats({ memoryTags: wizardMemoryTags(), memorySheets: wizardMemorySheets() });
    const sheetDesc = run.memSheets == null ? '全部表' : `${run.memSheets.length} 张表`;
    const memDesc = Array.isArray(run.memSheets) && !run.memSheets.length ? '不附带（未选表格）'
        : run.memMatch
            ? (run.memTags.length ? `按标签（${run.memTags.join('、')}）` : '不附带（未勾标签）')
            : '全量召回';
    const gpOn = settings.storageItems.some(i => i.enabled);
    main.innerHTML = `
    <div class="pp-section">
        <b>分析前确认</b>
        <div class="pp-gd-stat">对话 ${stat.layers} 层 · 世界书命中 ${stat.hits} 条 · 预设 ${presets.filter(p => p.enabled).length}/${presets.length} 全局生效 · 随机事件：${run.event?.title ? escapeHtml(run.event.title) : '无'}</div>
        <div class="pp-gd-stat pp-muted">记忆表格：${sheetDesc} · ${memDesc}${stat.memChars ? `，${stat.memChars} 字` : ''}${gpOn ? ` · 玩法 ${(run.gpIds ?? []).length} 条` : ''}${activeStory() ? ' · 附进行中剧情' : ''}${searchToolActive() ? ' · 联网搜索：开（先轻量判断，需要才检索）' : ''}</div>
        <div class="pp-btn-row">
            <span id="pp_gd_ready_go" class="menu_button" title="走插件独立 API 调用一次，计费按你配置的接口">确认，开始分析</span>
            <span id="pp_gd_ready_back" class="menu_button">返回</span>
        </div>
    </div>`;
    // 联网判断预跑：进这一页时材料与事件已定型，趁用户核对的几秒把判断跑完；
    // 分析时指纹对不上（这之后输入又变了）会自动作废重判
    run.research = searchToolActive()
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
    manual.addEventListener('input', () => { ev.opinion = manual.value; });
    main.querySelector('#pp_gd_ev_lib').addEventListener('change', e => { ev.useLibrary = e.target.checked; });
    main.querySelector('#pp_gd_ev_prev').addEventListener('change', e => { ev.wantPreview = e.target.checked; });

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
        renderEvCard(out);
    }));
    const layersEl = out.querySelector('#pp_gd_ev_layers');
    // 点选走向会整卡重渲染，input 事件实时回存，重渲染后数值不丢
    layersEl.addEventListener('input', () => {
        const v = Number(layersEl.value);
        if (Number.isFinite(v)) ev.injectLayers = v;
    });
    layersEl.addEventListener('change', () => {
        const v = clampInjectLayers(Number(layersEl.value));
        ev.injectLayers = v;
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
    const token = ++analyzeToken;
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
            memorySheets: wizardMemorySheets(),
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
        step = 'result';
        renderMain(container);
    } catch (err) {
        if (token !== analyzeToken) return;
        toastr.error(String(err.message ?? err));
        // 打回重写失败回到结果页（旧结果还在）；首轮失败回到第 1 步改材料
        step = revise ? 'result' : 'collect';
        renderMain(container);
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
        <textarea id="pp_gd_plan" class="text_pole textarea_compact" rows="10"></textarea>
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
    planEl.addEventListener('input', () => { run.planText = planEl.value; });
    const noteEl = main.querySelector('#pp_gd_revise_note');
    noteEl.value = run.reviseNote;
    noteEl.addEventListener('input', () => { run.reviseNote = noteEl.value; });

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
            memSheets: null, memMatch: false, memTags: [], readyFrom: 'event', research: null,
        });
        // 第 2 步闸口状态一并清空：上一轮的事件卡/走向/意见不带进新一轮规划（「不保存，回到第 1 步」才保留）
        Object.assign(ev, { mode: null, event: null, choiceIdx: null, opinion: '', useLibrary: true, wantPreview: false, busy: false });
        report = null;
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
        step = 'report';
        renderMain(container);
        renderStoryBar(container);   // 刷新「最近检查」时间
    } catch (err) {
        if (token !== analyzeToken) return;
        toastr.error(String(err.message ?? err));
        step = '';
        renderMain(container);
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
