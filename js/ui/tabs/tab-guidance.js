// 剧情指导页签：分步规划向导
// ① 收集确认（本地检索材料 + 预设临时勾选 + 剧情构思 + 记忆表格标签匹配）→ ② 随机事件闸口（可跳过）
// → ③ 模型分析（OOC/剧情重复/文风重复/进度 + 设计剧情）→ ④ 人工二检（打回重写 / 确认采用 / 不保存）
// 确认采用的规划存为「进行中剧情」（story.js，跟聊天文件走）并自动绑定一条剧情注入（换剧情自动换内容，完结自动撤下）；
// 跳过随机事件的路径会先停在「分析前确认」页，点确认才真正调模型。
// 另有「检查当前剧情」：对照进行中剧情出执行报告（完成度/推进/文风/OOC/其他/建议）
import { runPlotGuidance, runStoryReview, buildGuidanceMessages, collectStats, GUIDANCE_SYSTEM_PROMPT } from "../../planner.js";
import { generateRandomEvent, generateFreeRandomEvent, rollEventRule } from "../../randomEvents.js";
import { addInjection, updateInjection, removeInjection } from "../../injection.js";
import { settings, save, newId } from "../../settings.js";
import { storyState, activeStory, confirmPlot, endActive, attachReport, deleteStory, clearHistory } from "../../story.js";
import { memoryState, allTags, autoTagByVocabulary, persistMemory } from "../../memoryTable.js";
import { getTavernContext } from "../../context.js";
import { escapeHtml } from "../../utils.js";

// 向导状态机：'' 空闲 | collect ① | event ② | ready 分析前确认 | running ③ | result ④ | reviewing/report 检查报告
let step = '';
const run = {
    note: '',            // 剧情构思方向
    presetIds: [],       // 本次启用的预设（临时勾选，不写回设置）
    event: null,         // { mode:'llm'|'lib'|'manual', title, choice } 入库用
    eventText: '',       // 拼给模型的事件材料
    result: null, raw: '', hits: 0, planText: '', reviseNote: '',
    memMatch: false,     // 第 1 步：是否按标签匹配召回记忆表格
    memTags: [],         // 按标签匹配时勾选的标签名
    readyFrom: 'event',  // 分析前确认页的「返回」回到哪一步
};
// ② 随机事件闸口的界面状态
const ev = { mode: null, event: null, choiceIdx: null, opinion: '', useLibrary: true, wantPreview: false };
// 进行中剧情全文 / 历史列表是否展开；历史里展开查看的条目 id（均只存内存）
let showActive = false, showHistory = false, viewHistId = null;
let report = null;      // 最近一次检查报告（内存缓存，正式存档在 story 条目上）
// 「匹配设置」折叠区是否展开（词表/打标区域编辑，随记忆状态存聊天）
let matchOpen = false;

// 预设区折叠/编辑中状态（与向导无关，跨重渲染保持）
let presetOpen = false;
let editingPreset = null;   // 正在编辑内容的预设 id

export const guidanceTab = {
    id: 'guidance',
    title: '剧情指导',
    render(container) {
        container.innerHTML = `
        <div class="pp-section" id="pp_gd_storybar"></div>
        <div id="pp_gd_main"></div>
        <div class="pp-section" id="pp_gd_preset"></div>`;
        renderStoryBar(container);
        renderMain(container);
        renderPreset(container);
    },
};

// 聊天切换时由 index.js 调用：清掉向导进度，避免 A 聊天的规划带到 B 聊天；
// 剧情数据本身存 chatMetadata，随聊天文件自动切换
export function resetGuidance() {
    step = '';
    Object.assign(run, {
        note: '', presetIds: [], event: null, eventText: '', result: null, raw: '', hits: 0, planText: '', reviseNote: '',
        memMatch: false, memTags: [], readyFrom: 'event',
    });
    Object.assign(ev, { mode: null, event: null, choiceIdx: null, opinion: '', useLibrary: true, wantPreview: false });
    showActive = false; showHistory = false; viewHistId = null; report = null; matchOpen = false;
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
                <span class="pp-muted">走一遍分步规划，确认采用后存在这里（跟聊天文件走，刷新不丢）</span>
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
        <div class="pp-item-main"><b>历史剧情</b> <span class="pp-muted">${archived ? `另有 ${archived} 条归档` : '暂无归档'}</span></div>
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
        toastr.success('已清空历史归档（进行中剧情保留）');
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
            <b>第 3 步 · 分析中……</b>
            <div class="pp-muted">检查（OOC / 剧情重复 / 文风重复 / 进度）+ 设计剧情一次出全，走插件独立 API，不影响主对话。</div>
        </div>`;
        return;
    }
    if (step === 'result') return renderResult(container, main);

    if (step === 'reviewing') {
        main.innerHTML = `
        <div class="pp-section">
            <b>检查当前剧情中……</b>
            <div class="pp-muted">对照进行中剧情与最近对话出执行报告，走插件独立 API。</div>
        </div>`;
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

    main.innerHTML = `
    <div class="pp-section">
        <div class="pp-muted">分步规划：① 收集确认（本地检索材料 + 预设勾选 + 记忆标签匹配 + 剧情构思）→ ② 随机事件闸口（可跳过）→ ③ 模型分析（检查 + 设计剧情）→ ④ 人工二检（打回重写 / 确认采用 / 不保存）。确认采用的规划存为「进行中剧情」并自动注入，可随时「检查当前剧情」出执行报告。</div>
    </div>`;
}

function startCollect(container) {
    step = 'collect';
    if (!run.presetIds.length) {
        run.presetIds = (settings.guidance?.presets ?? []).filter(p => p.enabled).map(p => p.id);
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

// 跳过类按钮先停在「分析前确认」页，不直接花一次模型调用
function goReady(container, from) {
    run.readyFrom = from;
    step = 'ready';
    renderMain(container);
}

// ① 收集确认：本地检索已完成，展示材料清单；预设勾选只对本次生效；构思可后补
function renderCollect(container, main) {
    const presets = settings.guidance?.presets ?? [];
    const tags = allTags(memoryState());
    main.innerHTML = `
    <div class="pp-section">
        <b>第 1 步 · 收集确认</b>
        <div class="pp-muted">本地检索完成（不调模型）：以下材料将随分析一起发送。</div>
        <div class="pp-item">
            <div class="pp-item-main">
                <span id="pp_gd_c1_stat"></span>
                <span class="pp-muted" id="pp_gd_c1_count">预设 ${run.presetIds.length}/${presets.length} 启用${activeStory() ? ' · 已附进行中剧情' : ''}</span>
            </div>
            <div class="pp-item-ops"><span class="menu_button" id="pp_gd_c1_preview">查看完整提示词</span></div>
        </div>
        <label class="pp-label">记忆表格召回（只影响本次分析，不改记忆表格页的配置）</label>
        <div class="pp-gd-selp">
            <label title="勾选后只带所选标签的行；不勾则启用召回的表格全量带出"><input type="checkbox" id="pp_gd_c1_memmatch" ${run.memMatch ? 'checked' : ''}/> 按标签匹配</label>
        </div>
        <div class="pp-gd-selp" id="pp_gd_c1_chips" ${run.memMatch ? '' : 'style="display:none"'}>
            ${tags.length
                ? tags.map(([t, n]) => `<label class="pp-mem-chip" title="带这个标签的记忆行"><input type="checkbox" data-mtag="${escapeHtml(t)}" ${run.memTags.includes(t) ? 'checked' : ''}/> ${escapeHtml(t)} (${n})</label>`).join('')
                : '<span class="pp-muted">还没有任何行标签：先在下方「匹配设置」里用词表打标签，或在记忆表格页手动打</span>'}
            <span class="pp-muted" id="pp_gd_c1_memtip"></span>
        </div>
        <div id="pp_gd_match"></div>
        <label class="pp-label">本次启用的预设（改动不写回保存的默认值）</label>
        <div class="pp-gd-selp">
            ${presets.map(p => `<label><input type="checkbox" data-c1p="${p.id}" ${run.presetIds.includes(p.id) ? 'checked' : ''}/> ${escapeHtml(p.name)}</label>`).join('')
            || '<span class="pp-muted">（还没有预设，可在下方「规划预设」里新建）</span>'}
        </div>
        <label class="pp-label">剧情构思方向（可选：已有的想法、约束、重点，随本次分析发给模型）</label>
        <textarea id="pp_gd_note" class="text_pole textarea_compact" rows="3"></textarea>
        <div class="pp-btn-row">
            <span id="pp_gd_c1_next" class="menu_button">下一步：随机事件</span>
            <span id="pp_gd_c1_skip" class="menu_button">跳过事件，直接分析</span>
            <span id="pp_gd_c1_cancel" class="menu_button">取消</span>
        </div>
    </div>
    <div id="pp_gd_promptview" class="pp-gd-builtin" style="display:none"></div>`;

    const refreshMem = () => {
        const st = collectStats({ memoryTags: wizardMemoryTags() });
        const mode = run.memMatch
            ? (run.memTags.length ? `按标签 ${run.memTags.length} 类` : '不附带（未勾标签）')
            : '全量';
        main.querySelector('#pp_gd_c1_stat').textContent =
            `对话 ${st.layers} 层 · 世界书命中 ${st.hits} 条 · 记忆表格 ${st.memChars} 字（${mode}）`;
        main.querySelector('#pp_gd_c1_chips').style.display = run.memMatch ? '' : 'none';
        main.querySelector('#pp_gd_c1_memtip').textContent =
            run.memMatch && !run.memTags.length && tags.length ? '未勾选任何标签，本次将不附带记忆表格' : '';
    };
    refreshMem();

    const noteEl = main.querySelector('#pp_gd_note');
    noteEl.value = run.note;
    noteEl.addEventListener('input', () => { run.note = noteEl.value; });

    main.querySelector('#pp_gd_c1_memmatch').addEventListener('change', e => {
        run.memMatch = e.target.checked;
        refreshMem();
    });
    main.querySelectorAll('[data-mtag]').forEach(cb => cb.addEventListener('change', () => {
        run.memTags = [...main.querySelectorAll('[data-mtag]:checked')].map(x => x.dataset.mtag);
        refreshMem();
    }));
    renderMatch(container, main);

    main.querySelectorAll('[data-c1p]').forEach(cb => cb.addEventListener('change', () => {
        run.presetIds = [...main.querySelectorAll('[data-c1p]:checked')].map(x => x.dataset.c1p);
        main.querySelector('#pp_gd_c1_count').textContent = `预设 ${run.presetIds.length}/${presets.length} 启用${activeStory() ? ' · 已附进行中剧情' : ''}`;
    }));

    main.querySelector('#pp_gd_c1_preview').addEventListener('click', () => {
        const view = main.querySelector('#pp_gd_promptview');
        if (view.style.display !== 'none') { view.style.display = 'none'; return; }
        try {
            const s = storyState();
            const { system, user } = buildGuidanceMessages({
                userNote: run.note,
                eventText: run.eventText,
                activePlan: activeStory()?.planText ?? '',
                historySummaries: s.history.filter(h => h.id !== s.activeId).map(h => h.summary),
                presets: runPresets(),
                memoryTags: wizardMemoryTags(),
            });
            view.textContent = `【系统提示词】\n${system}\n\n【用户消息】\n${user}`;
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

// 匹配设置（第 1 步内折叠区）：标签词表 + 打标区域 + 用词表批量打标。
// 词表与区域存聊天（memoryState），第 1 步勾选的匹配标签只存本次运行
function renderMatch(container, main) {
    const box = main.querySelector('#pp_gd_match');
    const state = memoryState();
    const sheets = state.mirror.sheets;

    const head = `
    <div class="pp-item" id="pp_gd_match_head" title="打标签用：词表决定模型能打哪些标签，区域决定给哪些表打">
        <div class="pp-item-main"><b>匹配设置</b> <span class="pp-muted">标签词表 / 打标区域</span></div>
        <div class="pp-item-ops"><span class="menu_button" id="pp_gd_match_toggle">${matchOpen ? '收起' : '展开'} <i class="fa-solid fa-chevron-${matchOpen ? 'down' : 'right'}"></i></span></div>
    </div>`;
    box.innerHTML = head + (matchOpen ? `
    <div class="pp-gd-editor">
        <label class="pp-label" title="勾选参与打标的表格；不勾 = 全部镜像表">打标区域（${sheets.length ? '不勾 = 全部表格' : '镜像里没有表格'}）</label>
        <div class="pp-gd-selp">
            ${sheets.map(s => `<label><input type="checkbox" data-msheet="${escapeHtml(s.uid)}" ${!state.matchSheets.length || state.matchSheets.includes(s.uid) ? 'checked' : ''}/> ${escapeHtml(s.name)}</label>`).join('')}
        </div>
        <label class="pp-label" title="打标时模型只能从这些名字里选；注释可选，帮模型判断什么内容算这个标签">标签词表（只能从这些名字里选，可加注释）</label>
        <div id="pp_gd_vocab"></div>
        <div class="pp-btn-row">
            <span id="pp_gd_vocab_add" class="menu_button"><i class="fa-solid fa-plus"></i> 加一个标签</span>
            <label><input type="checkbox" id="pp_gd_tag_over" /> 覆盖已有标签</label>
            <span id="pp_gd_tag_run" class="menu_button" title="把区域内（默认没标签）的行分批交给模型，按词表打标签"><i class="fa-solid fa-wand-magic-sparkles"></i> 用词表打标签</span>
        </div>
        <div id="pp_gd_tag_status" class="pp-muted"></div>
    </div>` : '');

    box.querySelector('#pp_gd_match_toggle').addEventListener('click', () => {
        matchOpen = !matchOpen;
        renderMatch(container, main);
    });
    if (!matchOpen) return;

    const vocabBox = box.querySelector('#pp_gd_vocab');
    const renderVocab = () => {
        vocabBox.innerHTML = state.matchTags.map((v, i) => `
        <div class="pp-gd-vocab">
            <input type="text" class="text_pole textarea_compact" data-vname="${i}" placeholder="标签名（如：背叛）" value="${escapeHtml(v.name ?? '')}" />
            <input type="text" class="text_pole textarea_compact" data-vnote="${i}" placeholder="注释（可选：什么内容算这个标签）" value="${escapeHtml(v.note ?? '')}" />
            <span class="menu_button fa-solid fa-trash" data-vdel="${i}" title="删除该标签"></span>
        </div>`).join('') || '<span class="pp-muted">（词表为空，先加几个标签再打标）</span>';
        vocabBox.querySelectorAll('[data-vname]').forEach(inp => inp.addEventListener('input', () => {
            state.matchTags[Number(inp.dataset.vname)].name = inp.value;
            persistMemory();
        }));
        vocabBox.querySelectorAll('[data-vnote]').forEach(inp => inp.addEventListener('input', () => {
            state.matchTags[Number(inp.dataset.vnote)].note = inp.value;
            persistMemory();
        }));
        vocabBox.querySelectorAll('[data-vdel]').forEach(btn => btn.addEventListener('click', () => {
            state.matchTags.splice(Number(btn.dataset.vdel), 1);
            persistMemory();
            renderVocab();
        }));
    };
    renderVocab();

    box.querySelector('#pp_gd_vocab_add').addEventListener('click', () => {
        state.matchTags.push({ name: '', note: '' });
        persistMemory();
        renderVocab();
        vocabBox.querySelector('.pp-gd-vocab:last-child [data-vname]')?.focus();
    });
    box.querySelectorAll('[data-msheet]').forEach(cb => cb.addEventListener('change', () => {
        state.matchSheets = [...box.querySelectorAll('[data-msheet]:checked')].map(x => x.dataset.msheet);
        persistMemory();
    }));

    box.querySelector('#pp_gd_tag_run').addEventListener('click', async function () {
        const status = box.querySelector('#pp_gd_tag_status');
        const vocab = state.matchTags.filter(v => String(v.name ?? '').trim());
        if (!vocab.length) {
            toastr.warning('词表为空，先添加标签');
            return;
        }
        this.classList.add('disabled');
        status.textContent = '打标中……';
        try {
            const r = await autoTagByVocabulary({
                vocab,
                sheetUids: state.matchSheets,
                overwrite: box.querySelector('#pp_gd_tag_over').checked,
                onProgress: (a, b) => { status.textContent = `打标中…… ${a}/${b}`; },
            });
            status.textContent = r.total
                ? `完成：${r.tagged}/${r.total} 行打上标签（词表标签会出现在上方勾选区）`
                : '没有需要打标的行（都有标签了？勾「覆盖已有标签」重打）';
            toastr.success(`打标完成：${r.tagged} 行`);
            renderMain(container);   // 刷新标签勾选区与字数统计
        } catch (err) {
            status.textContent = '';
            toastr.error(String(err.message ?? err));
        } finally {
            this.classList.remove('disabled');
        }
    });
}

// 分析前确认：材料清单一目了然，点确认才真正调模型
function renderReady(container, main) {
    const presets = settings.guidance?.presets ?? [];
    const stat = collectStats({ memoryTags: wizardMemoryTags() });
    const memDesc = run.memMatch
        ? (run.memTags.length ? `按标签（${run.memTags.join('、')}）` : '不附带（未勾标签）')
        : '全量召回';
    main.innerHTML = `
    <div class="pp-section">
        <b>分析前确认</b>
        <div class="pp-muted">即将调用模型开始分析（走插件独立 API，计费按你配置的接口）。请核对本次材料：</div>
        <div class="pp-item">
            <div class="pp-item-main">
                <span>对话 ${stat.layers} 层 · 世界书命中 ${stat.hits} 条 · 预设 ${run.presetIds.length}/${presets.length} 启用</span>
                <span class="pp-muted">记忆表格：${memDesc}${stat.memChars ? `，${stat.memChars} 字` : ''} · 随机事件：${run.event?.title ? escapeHtml(run.event.title) : '无'}${activeStory() ? ' · 附进行中剧情' : ''}</span>
            </div>
        </div>
        <div class="pp-btn-row">
            <span id="pp_gd_ready_go" class="menu_button">确认，开始分析</span>
            <span id="pp_gd_ready_back" class="menu_button">返回</span>
        </div>
    </div>`;
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
        <b>第 2 步 · 随机事件闸口</b>
        <div class="pp-muted">可选。不想要事件就直接跳过；选定的事件/意见会作为「随机事件」材料融入本次规划。</div>
        <div class="pp-gd-selp">
            <label title="把事件库规则的名称与提示给模型参考，可从中选方向也可另起"><input type="checkbox" id="pp_gd_ev_lib" ${ev.useLibrary ? 'checked' : ''}/> 参考事件库</label>
            <label title="事件生成的同时让模型顺带给一版后续走向预览（仅供参考，正式规划仍走第 3 步分析）"><input type="checkbox" id="pp_gd_ev_prev" ${ev.wantPreview ? 'checked' : ''}/> 顺带出预览剧情</label>
        </div>
        <div class="pp-btn-row">
            <span id="pp_gd_ev_llm" class="menu_button" title="不经掷骰，直接让模型即兴生成"><i class="fa-solid fa-dice"></i> 大模型随机</span>
            <span id="pp_gd_ev_roll" class="menu_button" title="按事件库规则的概率/权重掷骰，中了他再生成"><i class="fa-solid fa-dice-three"></i> 事件库掷骰</span>
        </div>
        <label class="pp-label">或自己给指导意见（不掷骰，直接写事件/走向想法）</label>
        <textarea id="pp_gd_ev_manual" class="text_pole textarea_compact" rows="2"></textarea>
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
        status.textContent = '大模型随机生成中……';
        try {
            ev.mode = 'llm';
            ev.event = await generateFreeRandomEvent({ useLibrary: ev.useLibrary, wantPreview: ev.wantPreview });
            ev.choiceIdx = null;
            renderEvCard(out);
            status.textContent = '已生成（点选项选定走向，也可都不选只当参考）';
        } catch (err) {
            status.textContent = '';
            toastr.error(String(err.message ?? err));
        }
    });
    main.querySelector('#pp_gd_ev_roll').addEventListener('click', async () => {
        const rule = rollEventRule(settings.eventRules);
        if (!rule) {
            status.textContent = '本次未触发任何事件（概率未中），可再掷或改用「大模型随机」';
            return;
        }
        status.textContent = `掷中「${rule.name}」，生成中……`;
        try {
            ev.mode = 'lib';
            ev.event = await generateRandomEvent(rule);
            ev.choiceIdx = null;
            renderEvCard(out);
            status.textContent = `来自规则「${rule.name}」`;
        } catch (err) {
            status.textContent = '';
            toastr.error(String(err.message ?? err));
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
    out.innerHTML = `
    <div class="pp-item pp-gd-evcard">
        <b>${escapeHtml(e.title ?? '随机事件')}</b>
        <div>${escapeHtml(e.description ?? '')}</div>
        ${e.preview ? `<div class="pp-muted">预览走向：${escapeHtml(e.preview)}</div>` : ''}
        ${options.map((o, i) => `
            <div class="menu_button pp-option ${ev.choiceIdx === i ? 'pp-gd-sel' : ''}" data-evopt="${i}">
                ${escapeHtml(o.label ?? '')}<span class="pp-muted"> —— ${escapeHtml(o.hint ?? '')}</span>
            </div>`).join('')}
        <div class="pp-muted">${ev.choiceIdx == null ? '点一个走向选定（再点取消），都不选则只把事件当参考' : `已选：${escapeHtml(options[ev.choiceIdx]?.label ?? '')}`}</div>
    </div>`;
    out.querySelectorAll('[data-evopt]').forEach(el => el.addEventListener('click', () => {
        const i = Number(el.dataset.evopt);
        ev.choiceIdx = ev.choiceIdx === i ? null : i;
        renderEvCard(out);
    }));
}

// ---------------------------------------------------------------------------
// ③ 分析调用 / ④ 人工二检 + 封装
// ---------------------------------------------------------------------------

function runPresets() {
    return (settings.guidance?.presets ?? []).filter(p => run.presetIds.includes(p.id));
}

function historySummaries() {
    const s = storyState();
    return s.history.filter(h => h.id !== s.activeId).map(h => h.summary);
}

async function startAnalyze(container, { revise = false } = {}) {
    step = 'running';
    renderMain(container);
    try {
        const data = await runPlotGuidance({
            userNote: run.note,
            previousPlan: revise ? run.planText : '',
            revisionNote: revise ? run.reviseNote : '',
            eventText: run.eventText,
            activePlan: activeStory()?.planText ?? '',
            historySummaries: historySummaries(),
            presets: runPresets(),
            memoryTags: wizardMemoryTags(),
        });
        run.result = data.result;
        run.raw = data.raw;
        run.hits = data.hits;
        run.planText = formatPlan(data.result.plan);
        step = 'result';
        renderMain(container);
    } catch (err) {
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
        <b>第 4 步 · 人工二检（世界书命中 ${run.hits} 条）</b>
        <div class="pp-muted">检查项与规划如下；不合格「打回重新生成」，合格「确认采用」，不要了「不保存」回到第 1 步。</div>
        ${checkRow('OOC', ooc?.found && items.length
            ? items.map(it => `<div class="pp-hit"><b>${escapeHtml(it.aspect ?? '')} · ${escapeHtml(it.severity ?? '')}</b><div>${escapeHtml(it.evidence ?? '')}</div><div class="pp-muted">建议：${escapeHtml(it.fix ?? '')}</div></div>`).join('')
            : '<span class="pp-muted">未发现明显 OOC</span>')}
        ${checkRow('与已有剧情重复', checks.plotRepeat?.found
            ? `<div>${escapeHtml(checks.plotRepeat.note || '存在重复')}</div>`
            : '<span class="pp-muted">未发现重复</span>')}
        ${checkRow('文风重复', `<div>${escapeHtml(checks.styleRepeat?.level || '—')}${checks.styleRepeat?.note ? `：${escapeHtml(checks.styleRepeat.note)}` : ''}</div>`)}
        ${checkRow('剧情进度', `<div>${escapeHtml(checks.progress?.stage || '—')}${checks.progress?.pct ? `（${escapeHtml(checks.progress.pct)}）` : ''}</div>${checks.progress?.note ? `<div class="pp-muted">${escapeHtml(checks.progress.note)}</div>` : ''}`)}
    </div>
    <div class="pp-section">
        <b>剧情规划（可编辑，确认采用、注入的都是这份文本）</b>
        <textarea id="pp_gd_plan" class="text_pole textarea_compact" rows="10"></textarea>
        <label class="pp-label">修改意见（打回重新生成用）</label>
        <textarea id="pp_gd_revise_note" class="text_pole textarea_compact" rows="2"></textarea>
        <label class="pp-label" title="默认沿用上次；「确认采用」的剧情注入也按这里的深度与角色注入（剧情注入永不过期，完结时自动撤下）">注入参数</label>
        <div class="pp-gd-selp pp-gd-injrow">
            <label>深度 <input type="number" id="pp_gd_inj_depth" min="0" max="100" step="1" title="0 = 紧贴上下文末尾；数字越大越靠前" /></label>
            <label>角色 <select id="pp_gd_inj_role"><option value="system">system</option><option value="user">user</option></select></label>
            <label>过期 <select id="pp_gd_inj_exp"><option value="never">永久</option><option value="layers">N 层后</option></select></label>
            <label id="pp_gd_inj_layers_wrap" hidden>层数 <input type="number" id="pp_gd_inj_layers" min="1" step="1" /></label>
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
        Object.assign(run, { result: null, raw: '', hits: 0, planText: '', reviseNote: '' });
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
            presetIds: run.presetIds,
        });
        syncStoryInjection(run.planText, run.result?.plan?.summary ?? '');
        toastr.success('已存为进行中剧情并自动注入（原剧情自动归档，可在历史回看）');
        step = '';
        Object.assign(run, {
            note: '', presetIds: [], event: null, eventText: '', result: null, raw: '', hits: 0, planText: '', reviseNote: '',
            memMatch: false, memTags: [], readyFrom: 'event',
        });
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
        toastr.success('已注入（明盘：模型可见，聊天界面不显示）');
        document.dispatchEvent(new CustomEvent('pp-switch-tab', { detail: { id: 'injections' } }));
    });
}

// ---------------------------------------------------------------------------
// 检查报告：对照进行中剧情出执行报告；「按建议重写」带建议打回重新规划
// ---------------------------------------------------------------------------

async function reviewStory(container) {
    const active = activeStory();
    if (!active) return;
    step = 'reviewing';
    renderMain(container);
    try {
        const data = await runStoryReview({ planText: active.planText });
        attachReport(active.id, data.result);
        report = data.result;
        step = 'report';
        renderMain(container);
        renderStoryBar(container);   // 刷新「最近检查」时间
    } catch (err) {
        toastr.error(String(err.message ?? err));
        step = '';
        renderMain(container);
    }
}

function rewriteByAdvice(container) {
    const active = activeStory();
    if (!active || !report?.advice) return;
    run.note = '';
    run.presetIds = (settings.guidance?.presets ?? []).filter(p => p.enabled).map(p => p.id);
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

// ---------------------------------------------------------------------------
// 规划预设区：多条命名预设（默认折叠成一条摘要行，交互同记忆表格「原表库」）。
// 勾选「启用」的预设按列表顺序拼接、随每次分析追加进系统提示词；所有改动即时保存。
// （向导第 1 步的临时勾选独立于这里的默认启用状态）
// ---------------------------------------------------------------------------

function findPreset(id) {
    return (settings.guidance?.presets ?? []).find(p => p.id === id);
}

function presetSummary() {
    const list = settings.guidance?.presets ?? [];
    const n = list.filter(p => p.enabled).length;
    return list.length ? `${list.length} 个预设 · ${n} 个启用` : '未设置';
}

function presetRow(p, i, total) {
    const editing = editingPreset === p.id;
    return `
    <div class="pp-item" data-preset-item="${p.id}">
        <div class="pp-item-main">
            <label title="勾选后该预设默认随每次分析生效（向导第 1 步可对单次增删）"><input type="checkbox" data-pena="${p.id}" ${p.enabled ? 'checked' : ''} /> <b class="pp-gd-pname">${escapeHtml(p.name)}</b></label>
        </div>
        <div class="pp-item-ops">
            <span class="pp-muted pp-gd-plen">${String(p.content ?? '').trim().length} 字</span>
            <span class="menu_button fa-solid fa-arrow-up" data-pup="${p.id}" title="上移（越靠前越先拼进提示词）" ${i === 0 ? 'style="visibility:hidden"' : ''}></span>
            <span class="menu_button fa-solid fa-arrow-down" data-pdown="${p.id}" title="下移" ${i === total - 1 ? 'style="visibility:hidden"' : ''}></span>
            <span class="menu_button" data-pedit="${p.id}">${editing ? '收起' : '编辑'}</span>
            <span class="menu_button fa-solid fa-trash" data-pdel="${p.id}" title="删除该预设"></span>
        </div>
    </div>
    ${editing ? `
    <div class="pp-gd-editor">
        <label class="pp-label">预设名</label>
        <input type="text" class="text_pole" data-pname="${p.id}" value="${escapeHtml(p.name)}" />
        <label class="pp-label">内容（对规划的内容格式、文风、篇幅、侧重点的要求，改动即时保存）</label>
        <textarea class="text_pole textarea_compact" rows="6" data-pcontent="${p.id}" placeholder="例：&#10;1. 用中文写，文风克制、不堆形容词；&#10;2. 每个阶段 content 至少两句话，写清幕后安排和动因；&#10;3. beats 按「铺垫→推进→转折→收束」组织。">${escapeHtml(p.content ?? '')}</textarea>
    </div>` : ''}`;
}

function renderPreset(container) {
    const el = container.querySelector('#pp_gd_preset');
    const presets = settings.guidance?.presets ?? [];
    const head = `
    <div class="pp-item" id="pp_gd_preset_head" title="写一次、每次分析都默认生效的固定要求；勾选启用的按顺序拼进系统提示词，向导第 1 步可对单次增删">
        <div class="pp-item-main"><b>规划预设（固定要求）</b></div>
        <div class="pp-item-ops">
            <span class="pp-muted">${presetSummary()}</span>
            <span class="menu_button" id="pp_gd_preset_toggle">${presetOpen ? '收起' : '编辑'} <i class="fa-solid fa-chevron-${presetOpen ? 'down' : 'right'}"></i></span>
        </div>
    </div>`;

    if (!presetOpen) {
        el.innerHTML = head;
        el.querySelector('#pp_gd_preset_toggle').addEventListener('click', () => {
            presetOpen = true;
            renderPreset(container);
        });
        return;
    }

    el.innerHTML = `
    ${head}
    <label class="pp-label">勾选「启用」的预设按列表顺序拼接（每条自带预设名做小标题），默认随每次分析追加进系统提示词，可多条同时启用做组合；向导第 1 步的勾选是对单次运行的增删，不改动这里。输出须仍是 JSON 骨架（程序要解析），所以格式要求写在内容层面（写法、语言、详细程度），别要求改成纯正文。</label>
    ${presets.map((p, i) => presetRow(p, i, presets.length)).join('') || '<div class="pp-muted">还没有预设，点下面「新建预设」加一条</div>'}
    <div class="pp-btn-row">
        <span id="pp_gd_preset_new" class="menu_button"><i class="fa-solid fa-plus"></i> 新建预设</span>
        <span id="pp_gd_preset_builtin" class="menu_button" title="展开查看内置的系统指令和预设拼接的位置">查看内置指令</span>
    </div>
    <div id="pp_gd_preset_view" class="pp-gd-builtin" style="display:none"></div>`;

    const refreshHead = () => {
        el.querySelector('#pp_gd_preset_head .pp-muted').textContent = presetSummary();
    };
    const movePreset = (id, delta) => {
        const list = settings.guidance.presets;
        const i = list.findIndex(x => x.id === id);
        const j = i + delta;
        if (i < 0 || j < 0 || j >= list.length) return;
        [list[i], list[j]] = [list[j], list[i]];
        save();
        renderPreset(container);
    };

    el.querySelector('#pp_gd_preset_toggle').addEventListener('click', () => {
        presetOpen = false;
        editingPreset = null;
        renderPreset(container);
    });
    el.querySelector('#pp_gd_preset_new').addEventListener('click', () => {
        const list = settings.guidance.presets;
        const p = { id: newId('gd-'), name: `预设 ${list.length + 1}`, content: '', enabled: true };
        list.push(p);
        editingPreset = p.id;
        save();
        renderPreset(container);
        el.querySelector(`[data-pcontent="${p.id}"]`)?.focus();
    });
    el.querySelectorAll('[data-pena]').forEach(cb => cb.addEventListener('change', () => {
        const p = findPreset(cb.dataset.pena);
        if (p) { p.enabled = cb.checked; save(); refreshHead(); }
    }));
    el.querySelectorAll('[data-pedit]').forEach(btn => btn.addEventListener('click', () => {
        editingPreset = editingPreset === btn.dataset.pedit ? null : btn.dataset.pedit;
        renderPreset(container);
    }));
    el.querySelectorAll('[data-pdel]').forEach(btn => btn.addEventListener('click', () => {
        const list = settings.guidance.presets;
        const idx = list.findIndex(x => x.id === btn.dataset.pdel);
        if (idx >= 0) {
            const [removed] = list.splice(idx, 1);
            save();
            toastr.success(`已删除预设「${removed.name}」`);
        }
        if (editingPreset === btn.dataset.pdel) editingPreset = null;
        renderPreset(container);
    }));
    el.querySelectorAll('[data-pup]').forEach(btn => btn.addEventListener('click', () => movePreset(btn.dataset.pup, -1)));
    el.querySelectorAll('[data-pdown]').forEach(btn => btn.addEventListener('click', () => movePreset(btn.dataset.pdown, 1)));
    // 名字/内容编辑即时保存，只更新行内文字，不整块重渲染（避免打断输入）
    el.querySelectorAll('[data-pname]').forEach(inp => inp.addEventListener('input', () => {
        const p = findPreset(inp.dataset.pname);
        if (!p) return;
        p.name = inp.value;
        save();
        const row = el.querySelector(`[data-preset-item="${p.id}"]`);
        row.querySelector('.pp-gd-pname').textContent = p.name || '（未命名）';
    }));
    el.querySelectorAll('[data-pcontent]').forEach(ta => ta.addEventListener('input', () => {
        const p = findPreset(ta.dataset.pcontent);
        if (!p) return;
        p.content = ta.value;
        save();
        el.querySelector(`[data-preset-item="${p.id}"] .pp-gd-plen`).textContent = `${ta.value.trim().length} 字`;
    }));
    el.querySelector('#pp_gd_preset_builtin').addEventListener('click', () => {
        const view = el.querySelector('#pp_gd_preset_view');
        const show = view.style.display === 'none';
        view.style.display = show ? '' : 'none';
        if (show) {
            view.textContent = `${GUIDANCE_SYSTEM_PROMPT}\n\n## 用户固定要求（在不改变上述 JSON 输出格式的前提下遵照执行）\n（勾选启用的预设按顺序追加在这里，每条带「### 预设名」小标题，随每次分析一起发给模型）`;
        }
    });
}
