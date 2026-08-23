// 随机事件工具区（挂在剧情指导页下部）：路人反应校准 + 底部「事件库设置」「AI 建库」两个折叠区。
// 掷骰入口只有分步规划向导第 2 步（随机事件闸口），这里不再放独立的掷骰按钮；
// 「事件库设置」里调掷骰三板块（事件条目 / 维度随机 / AI 自主）的开关与权重，供向导第 2 步的掷骰用。
// 路人反应卡：从最近对话认出引人注目的事（不手填，唯一输入框是指导意见）→ 显著性/即时反应/扩散链/
// 底线/楼层预算 → 转自动过期注入（逐层换段；生效期间规划与检查报告自动附带同一口径，见 planner.js）
import { settings, save, newId } from "../../settings.js";
import { defaultEventRules, generateEventEntries, dimNameOf } from "../../randomEvents.js";
import { generateReactionCard, composeReactionText } from "../../reactions.js";
import { addInjection } from "../../injection.js";
import { currentFloor } from "../../context.js";
import { escapeHtml, clamp } from "../../utils.js";

let editingDim = null, editingRule = null;                     // 展开编辑中的维度 / 条目 id
const lib = { dimId: '', count: 5, note: '', preview: [], busy: false };  // AI 建库草稿
const rx = { note: '', card: null, busy: false, touched: false }; // 路人反应卡（note = 指导意见）
const folds = { settings: false, dims: false, entries: false, ailib: false }; // 折叠区展开状态（跨重渲染保留）

// 渲染随机事件工具区（路人反应 + 底部两个折叠区），由剧情指导页挂载；掷骰本身在向导第 2 步
export function renderEventsTools(container) {
    // 默认条目只在首次使用时种一次（seeded 标记）：之后删空事件库是合法状态，不再复活
    if (!settings.events.seeded) {
        settings.events.seeded = true;
        if (!settings.eventRules.length) settings.eventRules = defaultEventRules();
        save();
    }
    if (!lib.dimId) lib.dimId = settings.eventDimensions[0]?.id ?? '';
    container.innerHTML = `
    <div class="pp-section">
        <b>路人反应校准</b>
        <div class="pp-muted">模型处理路人反应常走两个极端：每层都全场哗哗地重复，或一笔带过后世界装失忆。这里让模型从最近对话里认出刚发生的引人注目的事，出一张反应卡：即时反应怎么写、余波怎么随楼层扩散、底线在哪、几层收束。确认后作为隐身注入生效，正文按楼层自动换段，到期自动撤下；生效期间，上面分步向导的规划与检查报告会自动带上同一份口径。</div>
        <label class="pp-label">指导意见（可选：期望烈度、扩散方向、要避开什么；引人注目的事由模型从最近对话里认出）</label>
        <textarea id="pp_rx_note" class="text_pole textarea_compact" rows="2" placeholder="例：别闹大，控制在背后议论和转发的程度"></textarea>
        <div class="pp-btn-row"><span id="pp_rx_gen" class="menu_button">生成反应卡</span></div>
        <div id="pp_rx_card"></div>
    </div>
    <div id="pp_ev_settings_wrap"></div>`;

    const note = container.querySelector('#pp_rx_note');
    note.value = rx.note;
    note.addEventListener('input', () => { rx.note = note.value; });
    container.querySelector('#pp_rx_gen').addEventListener('click', () => buildReaction(container));
    if (rx.card) renderReactionCard(container);

    renderSettings(container);
}

// 聊天切换时由剧情指导页一并调用：反应卡是当前聊天的内容，跟着清；
// AI 建库草稿是建库工具状态（不分聊天），保留
export function resetEventsTools() {
    Object.assign(rx, { note: '', card: null, busy: false, touched: false });
}

// ---------------------------------------------------------------------------
// 底部折叠设置区：板块开关 + 维度 / 条目 / AI 建库
// ---------------------------------------------------------------------------

function renderSettings(container) {
    const wrap = container.querySelector('#pp_ev_settings_wrap');
    if (!wrap) return;
    const fold = (key, title, inner) => `
        <details class="pp-fold" data-fold="${key}" ${folds[key] ? 'open' : ''}>
            <summary>${title}</summary>
            ${inner}
        </details>`;
    const branches = settings.events?.branches ?? {};
    const branchRow = (key, name, hint) => {
        const b = branches[key] ?? {};
        return `<span class="pp-branch" title="${hint}"><label><input type="checkbox" data-brcb="${key}" ${b.enabled !== false ? 'checked' : ''}/> ${name}</label>`
            + `<input type="number" class="text_pole" min="0" step="0.5" data-brw="${key}" value="${b.weight ?? 1}" title="板块权重：越大越容易被掷到"/></span>`;
    };

    wrap.innerHTML = `
    <details class="pp-fold pp-fold-root" data-fold="settings" ${folds.settings ? 'open' : ''}>
        <summary><i class="fa-solid fa-gear"></i> 事件库设置（掷骰板块 · 条目 · 维度）</summary>
        <div class="pp-fold-toggles">
            ${branchRow('entries', '事件条目', '掷骰走事件库：从合格条目里按权重×概率抽一条')}
            ${branchRow('free', '维度随机', '掷骰随机抽一个维度，让模型按它的气质即兴')}
            ${branchRow('ai', 'AI 自主', '掷骰把维度清单交给模型，由它挑最贴合当前剧情的一个')}
        </div>
        <div class="pp-muted">每次掷骰先在勾选的板块里按旁边填的权重抽一个，再走该板块；没勾选或没货（如条目全在冷却）的板块自动退出本轮。</div>
        ${fold('entries', `事件条目（${settings.eventRules.length} 条）`, `
            <div class="pp-muted">轻重口径：轻＝一根针，不自带走向；重＝一个局，不处理会发酵。冷却按掷中时的楼层起算；触发关键词留空 = 不限，填了则最近对话里要出现才算候选。</div>
            <div id="pp_ev_rules"></div>
            <div class="pp-btn-row"><span id="pp_ev_rule_add" class="menu_button"><i class="fa-solid fa-plus"></i> 新建条目</span></div>`)}
        ${fold('dims', `事件维度（${(settings.eventDimensions ?? []).length} 个）`, `
            <div class="pp-muted">维度是题材分类：维度随机与 AI 自主都从它出方向，库内条目按它分组，改描述就是改即兴事件的口味。删除维度不会删条目（条目会变成「未分组」，可再挂回别的维度）。</div>
            <div id="pp_ev_dims"></div>
            <div class="pp-btn-row"><span id="pp_ev_dim_add" class="menu_button"><i class="fa-solid fa-plus"></i> 新建维度</span></div>`)}
    </details>
    <details class="pp-fold pp-fold-root" data-fold="ailib" ${folds.ailib ? 'open' : ''}>
        <summary><i class="fa-solid fa-robot"></i> AI 建库（出条目草稿，勾选后导入事件库）</summary>
        <div class="pp-muted">选一个维度，让模型按维度气质批量出条目草稿，勾选后并入事件库（概率/权重/冷却用默认值，导入后可再调）。只是填库工具，不参与掷骰。</div>
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
    </details>`;

    // 折叠状态记忆（toggle 事件不冒泡，逐个绑定）
    wrap.querySelectorAll('details[data-fold]').forEach(el =>
        el.addEventListener('toggle', () => { folds[el.dataset.fold] = el.open; }));

    // 掷骰板块：勾选 = 参与掷骰，旁边数字 = 板块权重（被抽中的相对机会）
    wrap.querySelectorAll('[data-brcb]').forEach(cb => cb.addEventListener('change', () => {
        const b = ((settings.events ??= {}).branches ??= {});
        b[cb.dataset.brcb] ??= { enabled: true, weight: 1 };
        b[cb.dataset.brcb].enabled = cb.checked;
        if (cb.checked && !(Number(b[cb.dataset.brcb].weight) > 0)) b[cb.dataset.brcb].weight = 2;   // 勾回时权重为 0 会永远掷不到，补个默认
        save();
    }));
    wrap.querySelectorAll('[data-brw]').forEach(inp => inp.addEventListener('change', () => {
        const b = settings.events?.branches?.[inp.dataset.brw];
        if (!b) return;
        b.weight = Math.max(Number(inp.value) || 0, 0);
        save();
    }));

    // 新建按钮只在这里绑（renderDims/renderRules 会被反复调用，不能把按钮绑定放里面）
    wrap.querySelector('#pp_ev_dim_add')?.addEventListener('click', () => {
        const d = { id: newId('dim-'), name: `维度 ${(settings.eventDimensions ?? []).length + 1}`, weight: 1, enabled: true, prompt: '' };
        settings.eventDimensions.push(d);
        editingDim = d.id;
        save();
        renderDims(container);
        renderRules(container);
        const sel = container.querySelector('#pp_ev_libdim');
        if (sel) {
            fillLibDimSelect(sel);
            lib.dimId = d.id;
            sel.value = d.id;
        }
    });
    wrap.querySelector('#pp_ev_rule_add')?.addEventListener('click', () => {
        settings.eventRules.push({
            id: newId('ev-'), name: `事件 ${settings.eventRules.length + 1}`, enabled: true,
            probability: 0.2, weight: 1, cooldownLayers: 20,
            dimension: settings.eventDimensions[0]?.id ?? '', severity: 'light', keywords: '', promptHint: '',
        });
        editingRule = settings.eventRules[settings.eventRules.length - 1].id;
        save();
        renderRules(container);
    });

    const libSel = wrap.querySelector('#pp_ev_libdim');
    if (libSel) {
        fillLibDimSelect(libSel);
        libSel.addEventListener('change', () => { lib.dimId = libSel.value; });
    }
    const libCount = wrap.querySelector('#pp_ev_libcount');
    if (libCount) {
        libCount.value = lib.count;
        libCount.addEventListener('change', () => { lib.count = Math.min(Math.max(Number(libCount.value) || 5, 1), 10); });
    }
    const libNote = wrap.querySelector('#pp_ev_libnote');
    if (libNote) {
        libNote.value = lib.note;
        libNote.addEventListener('input', () => { lib.note = libNote.value; });
    }
    wrap.querySelector('#pp_ev_libgen')?.addEventListener('click', () => buildLibrary(container));

    renderDims(container);
    renderRules(container);
    renderLibPreview(container);
}

function fillLibDimSelect(sel) {
    sel.innerHTML = (settings.eventDimensions ?? []).map(d => `<option value="${escapeHtml(d.id)}">${escapeHtml(d.name)}</option>`).join('')
        || '<option value="">（先建维度）</option>';
    if (lib.dimId && (settings.eventDimensions ?? []).some(d => d.id === lib.dimId)) sel.value = lib.dimId;
}

// ---------------------------------------------------------------------------
// 维度层
// ---------------------------------------------------------------------------

function renderDims(container) {
    const list = container.querySelector('#pp_ev_dims');
    if (!list) return;
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
    if (!list) return;
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
                    <label class="pp-label">触发概率（0-1，越大越容易掷中）</label>
                    <input type="number" class="text_pole" min="0" max="1" step="0.05" data-rprob="${r.id}" value="${r.probability ?? 0.2}" />
                </div>
            </div>
            <div class="pp-grid2">
                <div>
                    <label class="pp-label">权重（与概率相乘决定抽中占比）</label>
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
    if (!box) return;
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
        rx.card = await generateReactionCard({ note: rx.note });
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
            </div>
        </div>`;

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
            label: card.immediate ? `路人反应：${card.immediate.slice(0, 24)}` : '路人反应',
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
        toastr.success(`已注入，${card.floors} 层后自动撤下（正文逐层推进扩散段；生效期间规划与检查报告自动附带，设置页底部可提前撤下）`);
    });
}
