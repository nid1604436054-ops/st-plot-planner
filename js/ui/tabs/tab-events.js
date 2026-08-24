// 随机事件工具区（挂在剧情指导页下部）：路人反应校准 + 底部「事件库设置」「AI 建库」两个折叠区。
// 掷骰入口只有分步规划向导第 2 步（随机事件闸口），这里不再放独立的掷骰按钮；
// 「事件库设置」里调掷骰三板块（事件条目 / 维度随机 / AI 自主）的开关与权重，供向导第 2 步的掷骰用。
// 路人反应卡：从最近对话认出引人注目的事（不手填，唯一输入框是指导意见；材料在反应区自己的
// 「材料勾选」折叠里勾——plotPlannerReactionPicks 随对话记忆，独立于向导第 1 步，见 reactions.js）
// → 显著性/即时口径/余波口径/底线/楼层预算（一层 = 一条角色回复）→ 转自动到期注入
// （生效期间规划与检查报告自动附带同一口径，见 planner.js）
import { settings, save, newId } from "../../settings.js";
import { defaultEventRules, generateEventEntries, dimNameOf } from "../../randomEvents.js";
import { generateReactionCard, composeReactionText } from "../../reactions.js";
import { addInjection } from "../../injection.js";
import { currentFloor, chatEnabledBookIds } from "../../context.js";
import { reactionPicks, saveReactionPicks } from "../../materials.js";
import { storageItemsInEffect } from "../../store.js";
import { memoryState } from "../../memoryTable.js";
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

    // 反应卡材料勾选：独立于向导第 1 步（chatdata.js 的 reaction 块，随对话记忆）。
    // 世界书默认沿用本对话「世界书」页的书单（books = null），点任意一本即切为本批独立勾选
    const picks = reactionPicks();
    const chatBooks = chatEnabledBookIds() ?? settings.lorebooks.filter(b => b.enabled).map(b => String(b.id));
    const bookOn = b => picks.books ? picks.books.includes(String(b.id)) : chatBooks.includes(String(b.id));
    const mem = memoryState();
    const recallSheets = mem.mirror.sheets.filter(s => (mem.sheetRecall[s.uid] ?? {}).enabled !== false);
    const gpItems = settings.storageItems.filter(i => i.enabled);
    const gpHit = new Set(storageItemsInEffect().map(i => i.id));
    const gpOn = i => (picks.gpIds ?? [...gpHit]).includes(i.id);

    container.innerHTML = `
    <div class="pp-section">
        <b>路人反应校准</b>
        <details class="pp-fold" id="pp_rx_mats">
            <summary title="生成反应卡用的材料在这里勾（存当前对话，换对话各用各的）；向导第 1 步的勾选只管规划分析，两边互不影响">材料勾选（只管反应卡，不跟向导第 1 步）</summary>
            <label class="pp-label" title="附带进行中剧情全文，反应口径与规划方向一致；当前没有进行中剧情时勾了也无内容"><input type="checkbox" id="pp_rx_plan" ${picks.plan ? 'checked' : ''}/> 附带进行中剧情</label>
            <label class="pp-label" title="按勾选的书检索关键词命中与常驻条目。长线剧情里角色的身世、名声在世界书里，路人认不认得出来就靠它">世界书（按勾选的书检索；<span id="pp_rx_books_mode">${picks.books == null ? '默认＝本对话「世界书」页的书单，点任意一本切为独立勾选' : '本批独立勾选'}</span>）</label>
            <div class="pp-gd-selp">
                ${settings.lorebooks.map(b => `<label><input type="checkbox" data-rxbook="${escapeHtml(String(b.id))}" ${bookOn(b) ? 'checked' : ''}/> ${escapeHtml(b.name)}</label>`).join('')
                || '<span class="pp-muted">还没有导入世界书</span>'}
            </div>
            <label class="pp-label" title="勾选的表全量召回（不做标签过滤），全不勾＝不附带；长线剧情里角色的既往经历在这里">记忆表格（勾选的表全量；默认不附带）</label>
            <div class="pp-gd-selp">
                ${recallSheets.map(s => `<label><input type="checkbox" data-rxsheet="${escapeHtml(s.uid)}" ${picks.memSheets.includes(s.uid) ? 'checked' : ''}/> ${escapeHtml(s.name)} · ${s.rows.length} 行</label>`).join('')
                || '<span class="pp-muted">没有开启「参与召回」的记忆表</span>'}
            </div>
            <label class="pp-label" title="勾选的玩法规则作为材料发给反应模型（不影响它们注入主对话）">游戏玩法（<span id="pp_rx_gps_mode">${picks.gpIds == null ? '默认＝生效中的条目' : '本批独立勾选'}</span>）</label>
            <div class="pp-gd-selp">
                ${gpItems.map(i => `<label><input type="checkbox" data-rxgp="${escapeHtml(i.id)}" ${gpOn(i) ? 'checked' : ''}/> ${escapeHtml(i.name)}${gpHit.has(i.id) ? ' <span class="pp-badge pp-badge-open">生效中</span>' : ''}</label>`).join('')
                || '<span class="pp-muted">还没有启用的玩法条目</span>'}
            </div>
        </details>
        <label class="pp-label">指导意见</label>
        <textarea id="pp_rx_note" class="text_pole textarea_compact" rows="2" placeholder="例：别闹大，控制在背后议论和转发的程度"></textarea>
        <div class="pp-btn-row"><span id="pp_rx_gen" class="menu_button">生成反应卡</span></div>
        <div id="pp_rx_card"></div>
    </div>
    <div id="pp_ev_settings_wrap"></div>`;

    // 勾选即写回对话记忆。世界书/玩法默认跟随各自的全局口径（本对话书单 / 生效中），
    // 点过任意一本（条）即冻结为本批显式勾选；想回到「全跟默认」的等价状态，
    // 把默认勾着的那些全勾上即可。预设已全局生效（「设置」页开关），不在材料里单勾
    const matsEl = container.querySelector('#pp_rx_mats');
    matsEl.querySelector('#pp_rx_plan').addEventListener('change', e => {
        picks.plan = e.target.checked;
        saveReactionPicks(picks);
    });

    const bindList = (attr, apply) => {
        matsEl.querySelectorAll(`[data-${attr}]`).forEach(cb => cb.addEventListener('change', () => {
            apply([...matsEl.querySelectorAll(`[data-${attr}]`)].filter(x => x.checked).map(x => x.dataset[attr]));
        }));
    };
    bindList('rxbook', ids => { picks.books = ids.map(String); matsEl.querySelector('#pp_rx_books_mode').textContent = '本批独立勾选'; saveReactionPicks(picks); });
    bindList('rxsheet', ids => { picks.memSheets = ids; saveReactionPicks(picks); });
    bindList('rxgp', ids => { picks.gpIds = ids; matsEl.querySelector('#pp_rx_gps_mode').textContent = '本批独立勾选'; saveReactionPicks(picks); });

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
        ${fold('entries', `事件条目（${settings.eventRules.length} 条）`, `
            <div id="pp_ev_rules"></div>
            <div class="pp-btn-row"><span id="pp_ev_rule_add" class="menu_button"><i class="fa-solid fa-plus"></i> 新建条目</span></div>`)}
        ${fold('dims', `事件维度（${(settings.eventDimensions ?? []).length} 个）`, `
            <div id="pp_ev_dims"></div>
            <div class="pp-btn-row"><span id="pp_ev_dim_add" class="menu_button"><i class="fa-solid fa-plus"></i> 新建维度</span></div>`)}
    </details>
    <details class="pp-fold pp-fold-root" data-fold="ailib" ${folds.ailib ? 'open' : ''}>
        <summary><i class="fa-solid fa-robot"></i> AI 建库（出条目草稿，勾选后导入事件库）</summary>
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
            <span id="pp_ev_libimp" class="menu_button" title="只导入勾选的条目；轻重这里改或导入后在条目上改，概率/冷却导入后再调">导入勾选项</span>
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
            <label class="pp-label">即时反应口径（每轮 1-3 句，织进当前场景，写一次就够）</label>
            <div>${escapeHtml(card.immediate)}</div>
            <label class="pp-label">余波口径（消息传开/平息的方向，不写场面）</label>
            <div>${escapeHtml(card.aftermath)}</div>
            <label class="pp-label">底线</label>
            <div>${escapeHtml(card.boundaries)}</div>
            <label class="pp-label">楼层预算（一层 = 一条角色回复，user 消息不计；到期自动撤下）</label>
            <input id="pp_rx_floors" class="text_pole textarea_compact" type="number" min="2" max="30" value="${card.floors}" />
            <label class="pp-label">注入正文预览（可改；改过就按这份文本固定生效，只按层数过期）</label>
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
        toastr.success(`已注入，${card.floors} 层后自动撤下（一层 = 一条角色回复；生效期间规划与检查报告自动附带同一口径，设置页底部可提前撤下）`);
    });
}
