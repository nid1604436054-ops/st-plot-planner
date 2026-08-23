// 随机事件页签：三层事件库（维度层 / 条目层 / 掷骰管线）+ AI 建库 + 路人反应校准
// 掷骰：条目过滤（启用/维度/触发关键词/冷却）→ 概率 → 库内加权；其余比例按维度加权走自由生成
// 路人反应卡：引人注目的事 → 显著性/即时反应/扩散链/底线/楼层预算 → 转自动过期注入（逐层换段）
import { settings, save, newId } from "../../settings.js";
import {
    defaultEventRules, rollEventPipeline, commitRolledEvent,
    generateRandomEvent, generateFreeRandomEvent, generateEventEntries, dimNameOf,
} from "../../randomEvents.js";
import { generateReactionCard, composeReactionText } from "../../reactions.js";
import { addInjection } from "../../injection.js";
import { currentFloor } from "../../context.js";
import { memoryState, addMirrorRow } from "../../memoryTable.js";
import { escapeHtml, clamp } from "../../utils.js";

const state = { event: null, sourceLabel: '', busy: false };   // 掷骰产出的事件卡
let editingDim = null, editingRule = null;                     // 展开编辑中的维度 / 条目 id
const lib = { dimId: '', count: 5, note: '', preview: [], busy: false };  // AI 建库草稿
const rx = { what: '', note: '', card: null, busy: false, touched: false }; // 路人反应卡
let rxMem = { open: false, uid: '', vals: [] };                // 余波写记忆表格的小表单

export const eventsTab = {
    id: 'events',
    title: '随机事件',
    render(container) {
        if (!settings.eventRules.length) {
            settings.eventRules = defaultEventRules();
            save();
        }
        if (!lib.dimId) lib.dimId = settings.eventDimensions[0]?.id ?? '';
        container.innerHTML = `
        <div class="pp-section">
            <b>掷骰生成事件</b>
            <div class="pp-muted">管线：条目过滤（启用 / 维度 / 触发关键词 / 冷却）→ 概率过筛 → 库内加权抽一；其余次数按维度加权走自由生成。同一维度连出两次后暂停一轮，最近出过的事件不再重复。</div>
            <label class="pp-label">事件库占比（%）：掷骰走事件库条目的比例，其余走维度自由生成</label>
            <input id="pp_ev_ratio" class="text_pole textarea_compact" type="number" min="0" max="100" step="5" />
            <div class="pp-btn-row">
                <div id="pp_ev_roll" class="menu_button"><i class="fa-solid fa-dice"></i> 掷骰生成事件</div>
            </div>
            <div id="pp_ev_status" class="pp-muted"></div>
        </div>
        <div id="pp_ev_output"></div>
        <div class="pp-section">
            <div class="pp-btn-row"><b>事件维度</b><span class="pp-muted" style="margin-left:auto">${(settings.eventDimensions ?? []).length} 个</span></div>
            <div class="pp-muted">维度是骨架：库内条目按维度分组，自由生成按维度加权抽方向。删除维度不会删条目（条目会变成「未分组」，可再挂回别的维度）。</div>
            <div id="pp_ev_dims"></div>
            <div class="pp-btn-row"><span id="pp_ev_dim_add" class="menu_button"><i class="fa-solid fa-plus"></i> 新建维度</span></div>
        </div>
        <div class="pp-section">
            <div class="pp-btn-row"><b>事件条目</b><span class="pp-muted" style="margin-left:auto">${settings.eventRules.length} 条</span></div>
            <div class="pp-muted">轻重口径：轻＝一根针，不自带走向；重＝一个局，不处理会发酵。冷却按掷中时的楼层起算；触发关键词留空 = 不限，填了则最近对话里要出现才算候选。</div>
            <div id="pp_ev_rules"></div>
            <div class="pp-btn-row"><span id="pp_ev_rule_add" class="menu_button"><i class="fa-solid fa-plus"></i> 新建条目</span></div>
        </div>
        <div class="pp-section">
            <b>AI 建库</b>
            <div class="pp-muted">选一个维度，让模型按维度气质批量出条目草稿，勾选后并入事件库（概率/权重/冷却用默认值，导入后可再调）。</div>
            <div class="pp-grid2">
                <div>
                    <label class="pp-label">维度</label>
                    <select id="pp_ev_libdim" class="text_pole textarea_compact"></select>
                </div>
                <div>
                    <label class="pp-label">数量（1-10）</label>
                    <input id="pp_ev_libcount" class="text_pole textarea_compact" type="number" min="1" max="10" />
                </div>
            </div>
            <label class="pp-label">补充说明（可选：想要的题材、烈度、要避开什么）</label>
            <textarea id="pp_ev_libnote" class="text_pole textarea_compact" rows="2" placeholder="例：偏日常向，不要涉及警察；重事件占一半"></textarea>
            <div class="pp-btn-row"><span id="pp_ev_libgen" class="menu_button">生成条目草稿</span></div>
            <div id="pp_ev_libprev"></div>
        </div>
        <div class="pp-section">
            <b>路人反应校准</b>
            <div class="pp-muted">模型处理路人反应常走两个极端：每层都全场哗哗地重复，或一笔带过后世界装失忆。这里把「刚发生的引人注目的事」交给模型出一张反应卡：即时反应怎么写、余波怎么随楼层扩散、底线在哪、几层收束。确认后作为隐身注入生效，正文按楼层自动换段，到期自动撤下。</div>
            <label class="pp-label">刚发生了什么引人注目的事（不填则模型从最近对话里找）</label>
            <textarea id="pp_rx_what" class="text_pole textarea_compact" rows="2" placeholder="例：主角刚在商场中庭当众唱了一首歌"></textarea>
            <label class="pp-label">补充说明（可选：期望烈度、扩散方向、要避开什么）</label>
            <textarea id="pp_rx_note" class="text_pole textarea_compact" rows="2"></textarea>
            <div class="pp-btn-row"><span id="pp_rx_gen" class="menu_button">生成反应卡</span></div>
            <div id="pp_rx_card"></div>
        </div>`;

        const ratio = container.querySelector('#pp_ev_ratio');
        ratio.value = settings.events?.libraryRatio ?? 60;
        ratio.addEventListener('change', () => {
            (settings.events ??= {}).libraryRatio = Math.min(Math.max(Number(ratio.value) || 60, 0), 100);
            save();
        });
        container.querySelector('#pp_ev_roll').addEventListener('click', () => roll(container));

        renderDims(container);
        renderRules(container);
        // 新建按钮只绑一次（列表渲染函数会被反复调用，不能把按钮绑定放里面）
        container.querySelector('#pp_ev_dim_add').addEventListener('click', () => {
            const d = { id: newId('dim-'), name: `维度 ${(settings.eventDimensions ?? []).length + 1}`, weight: 1, enabled: true, prompt: '' };
            settings.eventDimensions.push(d);
            editingDim = d.id;
            save();
            renderDims(container);
            renderRules(container);
            const libDim = container.querySelector('#pp_ev_libdim');
            libDim.innerHTML = (settings.eventDimensions ?? []).map(x => `<option value="${escapeHtml(x.id)}">${escapeHtml(x.name)}</option>`).join('');
            libDim.value = d.id;
            lib.dimId = d.id;
        });
        container.querySelector('#pp_ev_rule_add').addEventListener('click', () => {
            settings.eventRules.push({
                id: newId('ev-'), name: `事件 ${settings.eventRules.length + 1}`, enabled: true,
                probability: 0.2, weight: 1, cooldownLayers: 20,
                dimension: settings.eventDimensions[0]?.id ?? '', severity: 'light', keywords: '', promptHint: '',
            });
            editingRule = settings.eventRules[settings.eventRules.length - 1].id;
            save();
            renderRules(container);
        });

        const libDim = container.querySelector('#pp_ev_libdim');
        libDim.innerHTML = (settings.eventDimensions ?? []).map(d => `<option value="${escapeHtml(d.id)}">${escapeHtml(d.name)}</option>`).join('') || '<option value="">（先建维度）</option>';
        libDim.value = lib.dimId;
        libDim.addEventListener('change', () => { lib.dimId = libDim.value; });
        const libCount = container.querySelector('#pp_ev_libcount');
        libCount.value = lib.count;
        libCount.addEventListener('change', () => { lib.count = Math.min(Math.max(Number(libCount.value) || 5, 1), 10); });
        const libNote = container.querySelector('#pp_ev_libnote');
        libNote.value = lib.note;
        libNote.addEventListener('input', () => { lib.note = libNote.value; });
        container.querySelector('#pp_ev_libgen').addEventListener('click', () => buildLibrary(container));
        renderLibPreview(container);

        const what = container.querySelector('#pp_rx_what');
        what.value = rx.what;
        what.addEventListener('input', () => { rx.what = what.value; });
        const note = container.querySelector('#pp_rx_note');
        note.value = rx.note;
        note.addEventListener('input', () => { rx.note = note.value; });
        container.querySelector('#pp_rx_gen').addEventListener('click', () => buildReaction(container));
        if (rx.card) renderReactionCard(container);

        if (state.event) renderEvent(container);
    },
};

// ---------------------------------------------------------------------------
// 掷骰
// ---------------------------------------------------------------------------

async function roll(container) {
    if (state.busy) return;
    const status = container.querySelector('#pp_ev_status');
    const r = rollEventPipeline();
    if (r.mode === 'none') {
        status.textContent = `本次未掷出事件（${r.reason}），可再掷一次`;
        state.event = null;
        container.querySelector('#pp_ev_output').innerHTML = '';
        return;
    }
    state.busy = true;
    status.textContent = r.mode === 'library'
        ? `掷中「${r.rule.name}」（${r.rule.severity === 'heavy' ? '重' : '轻'}），生成中……`
        : `本轮流维度「${r.dimension.name}」自由生成，生成中……`;
    try {
        if (r.mode === 'library') {
            state.event = await generateRandomEvent(r.rule);
            state.sourceLabel = `事件库「${r.rule.name}」· ${r.rule.severity === 'heavy' ? '重' : '轻'}`;
            commitRolledEvent({ rule: r.rule, dimension: r.dimension, title: state.event.title, source: 'library' });
        } else {
            state.event = await generateFreeRandomEvent({ dimension: r.dimension });
            state.sourceLabel = `维度「${r.dimension.name}」自由生成`;
            commitRolledEvent({ dimension: r.dimension, title: state.event.title, source: 'free' });
        }
        renderEvent(container);
        status.textContent = `来自${state.sourceLabel}`;
        renderRules(container);   // 冷却中的条目状态变了，刷新列表
    } catch (err) {
        status.textContent = '';
        toastr.error(String(err.message ?? err));
    } finally {
        state.busy = false;
    }
}

function renderEvent(container) {
    const ev = state.event;
    const options = Array.isArray(ev.options) ? ev.options : [];

    container.querySelector('#pp_ev_output').innerHTML = `
        <div class="pp-section">
            <b>${escapeHtml(ev.title ?? '随机事件')}</b>
            <div>${escapeHtml(ev.description ?? '')}</div>
            ${options.map((o, i) => `<div class="menu_button pp-option" data-opt="${i}">${escapeHtml(o.label ?? '')}</div>`).join('')}
            <div class="pp-muted">选择一个走向后将转为隐身注入（明盘，20 层后自动过期）</div>
        </div>`;

    container.querySelectorAll('[data-opt]').forEach(el => el.addEventListener('click', () => {
        const opt = options[Number(el.dataset.opt)] ?? {};
        const content = `【随机事件·${ev.title ?? ''}】${ev.description ?? ''}\n已选定走向：${opt.label ?? ''}\n幕后提示：${opt.hint ?? ''}`;
        addInjection({
            id: newId('inj-'),
            label: `事件：${ev.title ?? ''} · ${opt.label ?? ''}`,
            mode: 'open',
            content,
            depth: 4,
            role: 'system',
            scope: 'chat',
            enabled: true,
            source: 'event',
            createdAt: Date.now(),
            expires: { type: 'layers', layers: 20 },
        });
        toastr.success('已注入');
        document.dispatchEvent(new CustomEvent('pp-switch-tab', { detail: { id: 'injections' } }));
    }));
}

// ---------------------------------------------------------------------------
// 维度层
// ---------------------------------------------------------------------------

function renderDims(container) {
    const list = container.querySelector('#pp_ev_dims');
    const dims = settings.eventDimensions ?? [];
    list.innerHTML = dims.map(d => `
        <div class="pp-item">
            <div class="pp-item-main">
                <label><input type="checkbox" data-dimen="${d.id}" ${d.enabled !== false ? 'checked' : ''} /> <b>${escapeHtml(d.name)}</b></label>
                <span class="pp-muted">权重 ${d.weight ?? 1}${editingDim === d.id ? '' : ` · ${escapeHtml(clamp(d.prompt ?? '', 60))}`}</span>
            </div>
            <div class="pp-item-ops">
                <span class="menu_button" data-dimedit="${d.id}">${editingDim === d.id ? '收起' : '编辑'}</span>
                <span class="menu_button fa-solid fa-trash" data-dimdel="${d.id}" title="删除维度（条目保留，变为未分组）"></span>
            </div>
        </div>
        ${editingDim === d.id ? `
        <div class="pp-gd-editor">
            <div class="pp-grid2">
                <div>
                    <label class="pp-label">维度名</label>
                    <input type="text" class="text_pole" data-dname="${d.id}" value="${escapeHtml(d.name)}" />
                </div>
                <div>
                    <label class="pp-label">权重（自由生成时的抽中占比）</label>
                    <input type="number" class="text_pole" min="0" step="0.1" data-dweight="${d.id}" value="${d.weight ?? 1}" />
                </div>
            </div>
            <label class="pp-label">方向提示（这个维度的事件是什么气质，自由生成按它即兴）</label>
            <textarea class="text_pole textarea_compact" rows="3" data-dprompt="${d.id}">${escapeHtml(d.prompt ?? '')}</textarea>
        </div>` : ''}`).join('') || '<div class="pp-muted">还没有维度，点下面新建</div>';

    list.querySelectorAll('[data-dimen]').forEach(cb => cb.addEventListener('change', () => {
        const d = dims.find(x => x.id === cb.dataset.dimen);
        if (d) { d.enabled = cb.checked; save(); }
    }));
    list.querySelectorAll('[data-dimedit]').forEach(btn => btn.addEventListener('click', () => {
        editingDim = editingDim === btn.dataset.dimedit ? null : btn.dataset.dimedit;
        renderDims(container);
    }));
    list.querySelectorAll('[data-dimdel]').forEach(btn => btn.addEventListener('click', () => {
        settings.eventDimensions = dims.filter(x => x.id !== btn.dataset.dimdel);
        if (editingDim === btn.dataset.dimdel) editingDim = null;
        save();
        toastr.info('已删除维度（其条目变为未分组，可编辑条目挂回其他维度）');
        renderDims(container);
        renderRules(container);
    }));
    list.querySelectorAll('[data-dname]').forEach(inp => inp.addEventListener('input', () => {
        const d = dims.find(x => x.id === inp.dataset.dname);
        if (!d) return;
        d.name = inp.value;
        save();
        inp.closest('.pp-item').querySelector('b').textContent = d.name || '（未命名）';
    }));
    list.querySelectorAll('[data-dweight]').forEach(inp => inp.addEventListener('change', () => {
        const d = dims.find(x => x.id === inp.dataset.dweight);
        if (d) { d.weight = Math.max(Number(inp.value) || 0, 0); save(); }
    }));
    list.querySelectorAll('[data-dprompt]').forEach(ta => ta.addEventListener('input', () => {
        const d = dims.find(x => x.id === ta.dataset.dprompt);
        if (d) { d.prompt = ta.value; save(); }
    }));
}

// ---------------------------------------------------------------------------
// 条目层
// ---------------------------------------------------------------------------

function ruleChips(r, floor) {
    const cd = Math.max(Number(r.cooldownLayers) || 0, 0);
    const cooling = cd > 0 && r.lastFloor != null && floor - r.lastFloor < cd;
    return `维度 ${dimNameOf(r.dimension)} · ${r.severity === 'heavy' ? '重' : '轻'} · 概率 ${Math.round((r.probability ?? 0) * 100)}% · 权重 ${r.weight ?? 1}`
        + (cd ? ` · 冷却 ${cd} 层${cooling ? `（剩 ${cd - (floor - r.lastFloor)} 层）` : ''}` : '')
        + (String(r.keywords ?? '').trim() ? ` · 关键词 ${escapeHtml(r.keywords)}` : '');
}

function renderRules(container) {
    const list = container.querySelector('#pp_ev_rules');
    const rules = settings.eventRules;
    const floor = currentFloor();
    const dimOptions = ['<option value="">（未分组，不参与掷骰）</option>']
        .concat((settings.eventDimensions ?? []).map(d => `<option value="${escapeHtml(d.id)}">${escapeHtml(d.name)}</option>`))
        .join('');

    list.innerHTML = rules.map(r => `
        <div class="pp-item">
            <div class="pp-item-main">
                <label><input type="checkbox" data-even="${r.id}" ${r.enabled !== false ? 'checked' : ''} /> <b>${escapeHtml(r.name)}</b></label>
                <span class="pp-muted">${ruleChips(r, floor)}</span>
                ${editingRule === r.id ? '' : `<span class="pp-muted">${escapeHtml(clamp(r.promptHint ?? '', 70))}</span>`}
            </div>
            <div class="pp-item-ops">
                <span class="menu_button" data-evedit="${r.id}">${editingRule === r.id ? '收起' : '编辑'}</span>
                <span class="menu_button fa-solid fa-trash" data-evdel="${r.id}" title="删除条目"></span>
            </div>
        </div>
        ${editingRule === r.id ? `
        <div class="pp-gd-editor">
            <div class="pp-grid2">
                <div>
                    <label class="pp-label">条目名</label>
                    <input type="text" class="text_pole" data-rname="${r.id}" value="${escapeHtml(r.name)}" />
                </div>
                <div>
                    <label class="pp-label">维度</label>
                    <select class="text_pole" data-rdim="${r.id}">${dimOptions}</select>
                </div>
            </div>
            <div class="pp-grid2">
                <div>
                    <label class="pp-label">轻重（执行口径）</label>
                    <select class="text_pole" data-rsev="${r.id}">
                        <option value="light" ${r.severity !== 'heavy' ? 'selected' : ''}>轻（一根针，不自带走向）</option>
                        <option value="heavy" ${r.severity === 'heavy' ? 'selected' : ''}>重（一个局，不处理会发酵）</option>
                    </select>
                </div>
                <div>
                    <label class="pp-label">触发概率（0-1）</label>
                    <input type="number" class="text_pole" min="0" max="1" step="0.05" data-rprob="${r.id}" value="${r.probability ?? 0.2}" />
                </div>
            </div>
            <div class="pp-grid2">
                <div>
                    <label class="pp-label">权重（候选池内抽中占比）</label>
                    <input type="number" class="text_pole" min="0" step="0.5" data-rweight="${r.id}" value="${r.weight ?? 1}" />
                </div>
                <div>
                    <label class="pp-label">冷却层数（掷中后多少层内不再入选，0=不限）</label>
                    <input type="number" class="text_pole" min="0" data-rcd="${r.id}" value="${r.cooldownLayers ?? 0}" />
                </div>
            </div>
            <label class="pp-label">触发关键词（逗号分隔，留空=不限；填了则最近对话出现才算候选）</label>
            <input type="text" class="text_pole" data-rkw="${r.id}" value="${escapeHtml(r.keywords ?? '')}" placeholder="例：酒吧, 夜店, 买醉" />
            <label class="pp-label">方向提示（给模型的一句话：触发情境与张力方向）</label>
            <textarea class="text_pole textarea_compact" rows="2" data-rhint="${r.id}">${escapeHtml(r.promptHint ?? '')}</textarea>
        </div>` : ''}`).join('') || '<div class="pp-muted">事件库为空：掷骰会全走维度自由生成；可点下面新建或用「AI 建库」批量导入</div>';

    list.querySelectorAll('[data-even]').forEach(cb => cb.addEventListener('change', () => {
        const r = rules.find(x => x.id === cb.dataset.even);
        if (r) { r.enabled = cb.checked; save(); }
    }));
    list.querySelectorAll('[data-evedit]').forEach(btn => btn.addEventListener('click', () => {
        editingRule = editingRule === btn.dataset.evedit ? null : btn.dataset.evedit;
        renderRules(container);
    }));
    list.querySelectorAll('[data-evdel]').forEach(btn => btn.addEventListener('click', () => {
        settings.eventRules = rules.filter(x => x.id !== btn.dataset.evdel);
        if (editingRule === btn.dataset.evdel) editingRule = null;
        save();
        renderRules(container);
    }));
    // 编辑即时保存（不整块重渲染，避免打断输入）
    list.querySelectorAll('[data-rname]').forEach(inp => inp.addEventListener('input', () => {
        const r = rules.find(x => x.id === inp.dataset.rname);
        if (!r) return;
        r.name = inp.value;
        save();
        inp.closest('.pp-item').querySelector('b').textContent = r.name || '（未命名）';
    }));
    list.querySelectorAll('[data-rdim]').forEach(sel => {
        sel.value = rules.find(x => x.id === sel.dataset.rdim)?.dimension ?? '';
        sel.addEventListener('change', () => {
            const r = rules.find(x => x.id === sel.dataset.rdim);
            if (r) { r.dimension = sel.value; save(); renderRules(container); }
        });
    });
    list.querySelectorAll('[data-rsev]').forEach(sel => sel.addEventListener('change', () => {
        const r = rules.find(x => x.id === sel.dataset.rsev);
        if (r) { r.severity = sel.value; save(); renderRules(container); }
    }));
    list.querySelectorAll('[data-rprob]').forEach(inp => inp.addEventListener('change', () => {
        const r = rules.find(x => x.id === inp.dataset.rprob);
        if (r) { r.probability = Math.min(Math.max(Number(inp.value) || 0, 0), 1); save(); }
    }));
    list.querySelectorAll('[data-rweight]').forEach(inp => inp.addEventListener('change', () => {
        const r = rules.find(x => x.id === inp.dataset.rweight);
        if (r) { r.weight = Math.max(Number(inp.value) || 0, 0); save(); }
    }));
    list.querySelectorAll('[data-rcd]').forEach(inp => inp.addEventListener('change', () => {
        const r = rules.find(x => x.id === inp.dataset.rcd);
        if (r) { r.cooldownLayers = Math.max(Number(inp.value) || 0, 0); save(); }
    }));
    list.querySelectorAll('[data-rkw]').forEach(inp => inp.addEventListener('input', () => {
        const r = rules.find(x => x.id === inp.dataset.rkw);
        if (r) { r.keywords = inp.value; save(); }
    }));
    list.querySelectorAll('[data-rhint]').forEach(ta => ta.addEventListener('input', () => {
        const r = rules.find(x => x.id === ta.dataset.rhint);
        if (r) { r.promptHint = ta.value; save(); }
    }));
}

// ---------------------------------------------------------------------------
// AI 建库
// ---------------------------------------------------------------------------

async function buildLibrary(container) {
    if (lib.busy) return;
    const dim = (settings.eventDimensions ?? []).find(d => d.id === lib.dimId);
    if (!dim) {
        toastr.warning('请先选择（或新建）一个维度');
        return;
    }
    lib.busy = true;
    const btn = container.querySelector('#pp_ev_libgen');
    btn.textContent = '生成中……';
    try {
        lib.preview = (await generateEventEntries({ dimension: dim, count: lib.count, note: lib.note }))
            .map(e => ({ ...e, checked: true }));
        if (!lib.preview.length) toastr.warning('模型没有返回可用的条目，换个说法再试');
        renderLibPreview(container);
    } catch (err) {
        toastr.error(String(err.message ?? err));
    } finally {
        lib.busy = false;
        btn.textContent = '生成条目草稿';
    }
}

function renderLibPreview(container) {
    const box = container.querySelector('#pp_ev_libprev');
    if (!lib.preview.length) {
        box.innerHTML = '';
        return;
    }
    box.innerHTML = `
        <div class="pp-muted">草稿（勾选后导入，轻重可改，导入后再调概率/冷却）</div>
        ${lib.preview.map((e, i) => `
        <div class="pp-lib-row">
            <input type="checkbox" data-libck="${i}" ${e.checked ? 'checked' : ''} />
            <select class="text_pole" data-libsev="${i}">
                <option value="light" ${e.severity !== 'heavy' ? 'selected' : ''}>轻</option>
                <option value="heavy" ${e.severity === 'heavy' ? 'selected' : ''}>重</option>
            </select>
            <span class="pp-lib-txt">${escapeHtml(e.name)}：${escapeHtml(e.promptHint)}</span>
        </div>`).join('')}
        <div class="pp-btn-row">
            <span id="pp_ev_libimp" class="menu_button">导入勾选项</span>
            <span id="pp_ev_libclr" class="menu_button">清空草稿</span>
        </div>`;
    box.querySelectorAll('[data-libck]').forEach(cb => cb.addEventListener('change', () => {
        lib.preview[Number(cb.dataset.libck)].checked = cb.checked;
    }));
    box.querySelectorAll('[data-libsev]').forEach(sel => sel.addEventListener('change', () => {
        lib.preview[Number(sel.dataset.libsev)].severity = sel.value;
    }));
    box.querySelector('#pp_ev_libimp').addEventListener('click', () => {
        const picked = lib.preview.filter(e => e.checked);
        if (!picked.length) {
            toastr.warning('没有勾选任何条目');
            return;
        }
        for (const e of picked) {
            settings.eventRules.push({
                id: newId('ev-'), name: e.name, enabled: true,
                probability: e.severity === 'heavy' ? 0.15 : 0.2, weight: 1,
                cooldownLayers: e.severity === 'heavy' ? 40 : 20,
                dimension: lib.dimId, severity: e.severity, keywords: '', promptHint: e.promptHint,
            });
        }
        lib.preview = [];
        save();
        toastr.success(`已导入 ${picked.length} 条（挂在维度「${dimNameOf(lib.dimId)}」）`);
        renderLibPreview(container);
        renderRules(container);
    });
    box.querySelector('#pp_ev_libclr').addEventListener('click', () => {
        lib.preview = [];
        renderLibPreview(container);
    });
}

// ---------------------------------------------------------------------------
// 路人反应校准
// ---------------------------------------------------------------------------

async function buildReaction(container) {
    if (rx.busy) return;
    rx.busy = true;
    rx.touched = false;
    const btn = container.querySelector('#pp_rx_gen');
    btn.textContent = '生成中……';
    try {
        rx.card = await generateReactionCard({ what: rx.what, note: rx.note });
        renderReactionCard(container);
    } catch (err) {
        toastr.error(String(err.message ?? err));
    } finally {
        rx.busy = false;
        btn.textContent = '生成反应卡';
    }
}

function renderReactionCard(container) {
    const card = rx.card;
    const box = container.querySelector('#pp_rx_card');
    const stars = '★'.repeat(card.salience) + '☆'.repeat(5 - card.salience);
    box.innerHTML = `
        <div class="pp-item pp-gd-evcard">
            <b>路人反应卡</b>
            <div>显著性 <span style="color:#e8c06a">${stars}</span>（${card.salience}/5）</div>
            <label class="pp-label">即时反应写法（每轮 1-3 句，写一次就够）</label>
            <div>${escapeHtml(card.immediate)}</div>
            <label class="pp-label">扩散链（按楼层分段推进）</label>
            ${card.diffusion.map(st => `<div class="pp-rx-stage"><b>第 ${escapeHtml(st.floors)} 层：</b>${escapeHtml(st.text)}</div>`).join('')}
            <label class="pp-label">底线</label>
            <div>${escapeHtml(card.boundaries)}</div>
            <label class="pp-label">楼层预算（有效层数，到期自动撤下）</label>
            <input id="pp_rx_floors" class="text_pole textarea_compact" type="number" min="2" max="30" value="${card.floors}" />
            <label class="pp-label">注入正文预览（可改；改过后不再按楼层自动换段，只按层数过期）</label>
            <textarea id="pp_rx_text" class="text_pole textarea_compact" rows="10">${escapeHtml(composeReactionText(card, 0))}</textarea>
            <div class="pp-btn-row">
                <span id="pp_rx_ok" class="menu_button">确认，转为隐身注入</span>
                <span id="pp_rx_mem" class="menu_button" title="把这条余波的长期后果写进记忆表格的一行（过期撤下后记忆仍在）">余波写入记忆表格</span>
            </div>
        </div>
        <div id="pp_rx_memform" style="display:none"></div>`;

    const textEl = box.querySelector('#pp_rx_text');
    const floorsEl = box.querySelector('#pp_rx_floors');
    floorsEl.addEventListener('change', () => {
        card.floors = Math.min(Math.max(Number(floorsEl.value) || card.floors, 2), 30);
        floorsEl.value = card.floors;
        if (!rx.touched) textEl.value = composeReactionText(card, 0);
    });
    textEl.addEventListener('input', () => { rx.touched = true; });

    box.querySelector('#pp_rx_ok').addEventListener('click', () => {
        const text = textEl.value.trim();
        if (!text) {
            toastr.warning('注入内容为空');
            return;
        }
        const auto = composeReactionText(card, 0);
        const reaction = rx.touched && text !== auto ? { ...card, edited: true } : card;
        addInjection({
            id: newId('inj-'),
            label: `路人反应：${(rx.what || card.immediate || '').slice(0, 24)}`,
            mode: 'open',
            content: text,
            depth: 4,
            role: 'system',
            scope: 'chat',
            enabled: true,
            source: 'reaction',
            createdAt: Date.now(),
            expires: { type: 'layers', layers: card.floors },
            reaction,
            age: 0,
        });
        toastr.success(`已注入，${card.floors} 层后自动撤下（正文逐层推进扩散段）`);
        document.dispatchEvent(new CustomEvent('pp-switch-tab', { detail: { id: 'injections' } }));
    });

    box.querySelector('#pp_rx_mem').addEventListener('click', () => {
        rxMem.open = !rxMem.open;
        renderRxMemForm(container);
    });
    renderRxMemForm(container);
}

function renderRxMemForm(container) {
    const form = container.querySelector('#pp_rx_memform');
    if (!form) return;
    if (!rxMem.open) {
        form.style.display = 'none';
        return;
    }
    form.style.display = '';
    const sheets = memoryState().mirror.sheets;
    if (!sheets.length) {
        form.innerHTML = '<div class="pp-muted">镜像里还没有表：先去「记忆表格」页同步或建表</div>';
        return;
    }
    if (!sheets.some(s => s.uid === rxMem.uid)) {
        rxMem.uid = sheets[0].uid;
        rxMem.vals = [];
    }
    const sheet = sheets.find(s => s.uid === rxMem.uid);
    const prefill = i => rxMem.vals[i] ?? (i === 0 ? `路人余波：${(rx.what || '').slice(0, 30)}` : '');
    form.innerHTML = `
        <div class="pp-gd-editor">
            <label class="pp-label">写入哪张镜像表</label>
            <select id="pp_rx_memsheet" class="text_pole">${sheets.map(s => `<option value="${escapeHtml(s.uid)}" ${s.uid === rxMem.uid ? 'selected' : ''}>${escapeHtml(s.name)}（${s.rows.length} 行）</option>`).join('')}</select>
            ${sheet.columns.map((c, i) => `
            <label class="pp-label">${escapeHtml(c || `第 ${i + 1} 列`)}</label>
            <input type="text" class="text_pole" data-rxcol="${i}" value="${escapeHtml(prefill(i))}" />`).join('')}
            <div class="pp-btn-row"><span id="pp_rx_memsave" class="menu_button">写入一行</span></div>
        </div>`;
    form.querySelector('#pp_rx_memsheet').addEventListener('change', e => {
        rxMem.uid = e.target.value;
        rxMem.vals = [];
        renderRxMemForm(container);
    });
    form.querySelectorAll('[data-rxcol]').forEach(inp => inp.addEventListener('input', () => {
        rxMem.vals[Number(inp.dataset.rxcol)] = inp.value;
    }));
    form.querySelector('#pp_rx_memsave').addEventListener('click', () => {
        const cols = sheet.columns.map((_, i) => rxMem.vals[i] ?? '');
        if (!cols.some(v => v.trim())) {
            toastr.warning('至少填一列内容');
            return;
        }
        addMirrorRow(rxMem.uid, cols);
        toastr.success(`已写入「${sheet.name}」一行`);
        rxMem.open = false;
        renderRxMemForm(container);
    });
}
