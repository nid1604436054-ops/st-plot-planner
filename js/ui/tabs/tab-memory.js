// 记忆表格页签（v2.1：网格表格视图 + 独立「已删除内容」页）
//   - 镜像/原表库/已删除页统一用「记忆增强表格」原版的网格样式（等比例缩小）
//   - 镜像：表格内直接编辑行内容、打标签、删行；删除的行进「已删除内容」页，不堆在工作区
//   - 已删除内容页：按表名分组的独立页面，可恢复到镜像或永久清除
import {
    memoryState, syncMemory, mergeMirrorFromSource, persistMemory,
    deleteMirrorRow, deleteMirrorSheet, undeleteRow, purgeMootTombstones,
    setRowTags, markSeen, newRowCount, allTags, buildMemoryContext,
    restoreFromBackup, editMirrorRow, acceptSourceRow, addMirrorRow, autoTagByVocabulary,
} from "../../memoryTable.js";
import { parseKeys } from "../../lorebook.js";
import { escapeHtml, clamp, downloadJson } from "../../utils.js";

// 展开状态跨重渲染保持；镜像默认全部展开（记的是「折叠过的表」），原表库默认折叠（记的是「展开过的表」）
const closedSheets = new Set();    // 被手动折叠的镜像表
const openSrc = new Set();         // 展开的原表
let showEmptySrc = false;          // 原表库是否显示空表
let libOpen = false;               // 原表库整节是否展开（默认收起，只留摘要行）
let editingRow = null;             // 正在编辑内容的行 rid（重渲染后保持编辑状态）
let memView = 'main';              // 'main' 工作区 / 'deleted' 已删除内容页

function fmtTime(ts) {
    if (!ts) return '从未';
    const d = new Date(ts);
    const p = n => String(n).padStart(2, '0');
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function mirrorStats(state) {
    return {
        libSheets: state.source.sheets.filter(s => s.rows.length > 0).length,
        libRows: state.source.sheets.reduce((n, s) => n + s.rows.length, 0),
        sheets: state.mirror.sheets.length,
        rows: state.mirror.sheets.reduce((n, s) => n + s.rows.length, 0),
        deleted: Object.keys(state.tombstones).length,
        backups: state.backups.length,
        fresh: newRowCount(state),
    };
}

export const memoryTab = {
    id: 'memory',
    title: '记忆表格',
    render(container) {
        memView = 'main';
        container.innerHTML = `
        <div id="pp_mem_main">
            <div class="pp-section">
                <div class="pp-btn-row">
                    <div id="pp_mem_sync" class="menu_button" title="从记忆表格插件读取最新数据：更新原表库、归档备份，并把新增/改动合并进镜像（你编辑过的行不覆盖，删除过的不复活）">同步记忆表格</div>
                    <div id="pp_mem_tag_btn" class="menu_button" title="配置标签词表与打标区域，用 AI 给镜像的行批量打标签；召回和剧情指导的「按标签匹配」用的就是这些标签">打标签</div>
                    <div id="pp_mem_bk_btn" class="menu_button">备份与恢复</div>
                    <div id="pp_mem_rc_btn" class="menu_button">召回设置</div>
                </div>
                <div id="pp_mem_status" class="pp-muted"></div>
                <div id="pp_mem_wipe"></div>
                <div id="pp_mem_tagai" style="display:none"></div>
                <div id="pp_mem_backups" style="display:none"></div>
                <div id="pp_mem_recall" style="display:none"></div>
            </div>
            <div class="pp-group-head">
                <b class="pp-group-title">镜像 · 剧情召回用（随意编辑，不影响原表）</b>
                <span id="pp_mem_delbtn" class="menu_button" title="在镜像里删掉的行都在那一页：可恢复到镜像，或永久清除">已删除内容</span>
            </div>
            <div id="pp_mem_list" class="pp-mem-list"></div>
            <div id="pp_mem_src" class="pp-mem-list"></div>
        </div>
        <div id="pp_mem_del" style="display:none"></div>`;

        container.querySelector('#pp_mem_sync').addEventListener('click', () => {
            const r = syncMemory();
            if (r.wiped) toastr.warning('检测到原表可能被清空：原表库和备份已保留，没有同步空数据');
            else {
                const m = mergeMirrorFromSource();
                if (m.added) toastr.success(`已同步：镜像新进 ${m.added} 行`);
                else if (r.changed || m.changed) toastr.success('已同步（你编辑过的行未被覆盖）');
                else toastr.info('原表没有变化，镜像已是最新');
            }
            renderAll(container);
        });
        container.querySelector('#pp_mem_tag_btn').addEventListener('click', () => {
            const el = container.querySelector('#pp_mem_tagai');
            el.style.display = el.style.display === 'none' ? '' : 'none';
        });
        container.querySelector('#pp_mem_bk_btn').addEventListener('click', () => {
            const el = container.querySelector('#pp_mem_backups');
            el.style.display = el.style.display === 'none' ? '' : 'none';
        });
        container.querySelector('#pp_mem_rc_btn').addEventListener('click', () => {
            const el = container.querySelector('#pp_mem_recall');
            el.style.display = el.style.display === 'none' ? '' : 'none';
        });
        container.querySelector('#pp_mem_delbtn').addEventListener('click', () => {
            memView = 'deleted';
            renderAll(container);
        });

        // 打开页签即同步 + 合并一次（首次会建立原表库与镜像）
        const r = syncMemory();
        if (r.changed) mergeMirrorFromSource();
        renderAll(container);
    },
};

function renderAll(container) {
    const delBtn = container.querySelector('#pp_mem_delbtn');
    const n = Object.keys(memoryState().tombstones).length;
    if (delBtn) delBtn.textContent = n ? `已删除内容（${n}）` : '已删除内容';

    if (memView === 'deleted') {
        container.querySelector('#pp_mem_main').style.display = 'none';
        container.querySelector('#pp_mem_del').style.display = '';
        renderDeleted(container);
        return;
    }
    container.querySelector('#pp_mem_main').style.display = '';
    container.querySelector('#pp_mem_del').style.display = 'none';
    renderStatus(container);
    renderWipe(container);
    renderTagging(container);
    renderBackups(container);
    renderRecall(container);
    renderSheets(container);
    renderSource(container);
}

function renderStatus(container) {
    const state = memoryState();
    const st = mirrorStats(state);
    const el = container.querySelector('#pp_mem_status');
    let html = `原表同步：${fmtTime(state.source.syncedAt)} · 库 ${st.libSheets} 表 ${st.libRows} 行 ｜ 镜像 ${st.sheets} 表 ${st.rows} 行 · 已删除 ${st.deleted} · 备份 ${st.backups} 份`;
    if (st.fresh > 0) {
        html += ` · <span class="pp-mem-fresh">新 ${st.fresh} 行</span> <span id="pp_mem_seen" class="menu_button">全部标为已读</span>`;
    }
    el.innerHTML = html;
    el.querySelector('#pp_mem_seen')?.addEventListener('click', () => {
        markSeen(state, state.mirror.sheets.flatMap(s => s.rows.map(r => r.rid)));
        persistMemory();
        renderAll(container);
    });
}

function renderWipe(container) {
    const state = memoryState();
    const el = container.querySelector('#pp_mem_wipe');
    if (!state.wipeAlert) {
        el.innerHTML = '';
        return;
    }
    el.innerHTML = `
    <div class="pp-mem-wipe">
        <div>⚠ 检测到记忆表格疑似被清空（${fmtTime(state.wipeAlert.at)}）：原表库仍保留 ${state.wipeAlert.rows} 行，未同步空数据。</div>
        <div class="pp-btn-row">
            <span id="pp_mem_restore_mirror" class="menu_button">从原表库恢复到原表</span>
            <span id="pp_mem_force_sync" class="menu_button">这是我自己清空的，仍然同步</span>
        </div>
    </div>`;
    el.querySelector('#pp_mem_restore_mirror').addEventListener('click', async () => {
        try {
            const n = await restoreFromBackup(state.source.sheets);
            toastr.success(`已插回 ${n} 行，请到记忆表格插件里核对`);
            renderAll(container);
        } catch (err) {
            toastr.error(`恢复失败：${err.message}`);
        }
    });
    el.querySelector('#pp_mem_force_sync').addEventListener('click', () => {
        syncMemory({ force: true });
        mergeMirrorFromSource();
        toastr.info('已按空表同步（清空前的数据在备份里）');
        renderAll(container);
    });
}

// 打标签区（点顶部「打标签」展开）：词表决定模型能打哪些标签（封闭集合，不许自拟），
// 区域决定给哪些表打。词表与区域存聊天（memoryState），随聊天走
function renderTagging(container) {
    const state = memoryState();
    const el = container.querySelector('#pp_mem_tagai');
    const sheets = state.mirror.sheets;

    el.innerHTML = `
    <b title="把镜像里还没标签的行分批交给「设置」页配置的 API，按下方的词表自动打标签（模型只能从词表里选，不能自拟）；之后「召回设置」和剧情指导第 1 步的「按标签匹配」用的就是这些标签">打标签</b>
    <label class="pp-label" title="打标时模型只能从这些名字里选；注释可选，帮模型判断什么内容算这个标签">标签词表（一行一个，注释可选）</label>
    <div id="pp_mem_vocab"></div>
    <div class="pp-btn-row">
        <span id="pp_mem_vocab_add" class="menu_button"><i class="fa-solid fa-plus"></i> 加一个标签</span>
    </div>
    <label class="pp-label" title="勾选参与打标的表格；不勾 = 全部镜像表">打标区域（${sheets.length ? '不勾 = 全部表格' : '镜像里没有表格'}）</label>
    <div class="pp-gd-selp">
        ${sheets.map(s => `<label><input type="checkbox" data-msheet="${escapeHtml(s.uid)}" ${!state.matchSheets.length || state.matchSheets.includes(s.uid) ? 'checked' : ''}/> ${escapeHtml(s.name)}</label>`).join('')}
    </div>
    <div class="pp-btn-row">
        <label><input type="checkbox" id="pp_mem_tag_over" /> 覆盖已有标签</label>
        <span id="pp_mem_tag_run" class="menu_button" title="把区域内（默认没标签）的行分批交给模型，按词表打标签"><i class="fa-solid fa-wand-magic-sparkles"></i> 按词表打标签</span>
    </div>
    <div id="pp_mem_tag_status" class="pp-muted"></div>`;

    const vocabBox = el.querySelector('#pp_mem_vocab');
    const renderVocab = () => {
        vocabBox.innerHTML = state.matchTags.map((v, i) => `
        <div class="pp-tag-vocab">
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

    el.querySelector('#pp_mem_vocab_add').addEventListener('click', () => {
        state.matchTags.push({ name: '', note: '' });
        persistMemory();
        renderVocab();
        vocabBox.querySelector('.pp-tag-vocab:last-child [data-vname]')?.focus();
    });
    el.querySelectorAll('[data-msheet]').forEach(cb => cb.addEventListener('change', () => {
        state.matchSheets = [...el.querySelectorAll('[data-msheet]:checked')].map(x => x.dataset.msheet);
        persistMemory();
    }));

    el.querySelector('#pp_mem_tag_run').addEventListener('click', async function () {
        const status = el.querySelector('#pp_mem_tag_status');
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
                overwrite: el.querySelector('#pp_mem_tag_over').checked,
                onProgress: (a, b) => { status.textContent = `打标中…… ${a}/${b}`; },
            });
            status.textContent = r.total
                ? `完成：${r.tagged}/${r.total} 行打上标签${r.failed ? `（${r.failed} 行所在批次失败被跳过，再点一次只补这些）` : ''}（下方「召回设置」与剧情指导里就能按这些标签筛选）`
                : '没有需要打标的行（都有标签了？勾「覆盖已有标签」重打）';
            toastr.success(`打标完成：${r.tagged} 行${r.failed ? `，${r.failed} 行失败跳过` : ''}`);
            renderAll(container);   // 刷新召回设置区的标签
        } catch (err) {
            status.textContent = '';
            toastr.error(String(err.message ?? err));
        } finally {
            this.classList.remove('disabled');
        }
    });
}

function renderBackups(container) {
    const state = memoryState();
    const el = container.querySelector('#pp_mem_backups');
    const rowsOf = sheets => sheets.reduce((n, s) => n + s.rows.length, 0);
    const item = (label, sheets, key) => `
    <div class="pp-mem-bkrow">
        <span>${label}</span>
        <span class="pp-mem-ops">
            <span class="menu_button" data-restore="${key}">恢复到原表</span>
            <span class="menu_button" data-export="${key}">导出</span>
        </span>
    </div>`;
    el.innerHTML = `
    <b title="原表库每次内容变化归档上一版（最多 20 份）。恢复 = 把该版本里缺失的行插回原表，只增不改">备份与恢复</b>
    ${item(`当前原表库（${fmtTime(state.source.syncedAt)} · ${rowsOf(state.source.sheets)} 行）`, state.source.sheets, 'live')}
    ${state.backups.map(b => item(`${fmtTime(b.at)} · ${rowsOf(b.sheets)} 行`, b.sheets, String(b.at))).join('')}`;

    const findSheets = key => key === 'live' ? state.source.sheets
        : state.backups.find(b => String(b.at) === key)?.sheets;
    el.querySelectorAll('[data-restore]').forEach(btn => btn.addEventListener('click', async () => {
        const sheets = findSheets(btn.dataset.restore);
        if (!sheets) return;
        try {
            const n = await restoreFromBackup(sheets);
            toastr.success(`已插回 ${n} 行，请到记忆表格插件里核对`);
            renderAll(container);
        } catch (err) {
            toastr.error(`恢复失败：${err.message}`);
        }
    }));
    el.querySelectorAll('[data-export]').forEach(btn => btn.addEventListener('click', () => {
        const sheets = findSheets(btn.dataset.export);
        if (sheets) downloadJson(`memory-backup-${btn.dataset.export}.json`, sheets);
    }));
}

function renderRecall(container) {
    const state = memoryState();
    const el = container.querySelector('#pp_mem_recall');
    const tags = allTags(state);
    el.innerHTML = `
    <b title="剧情规划注入时使用镜像里未删除的行。不勾任何标签 = 全部行；勾选后只注入带这些标签的行">召回设置</b>
    <div class="pp-mem-tagbar">
        ${tags.length ? tags.map(([t, n]) => `
        <label class="pp-mem-chip"><input type="checkbox" data-rtag="${escapeHtml(t)}" ${state.recallTags.includes(t) ? 'checked' : ''} /> ${escapeHtml(t)} (${n})</label>
        `).join('') : '<span class="pp-muted">还没有任何标签，手动在行旁输入，或点上方「打标签」按词表批量打</span>'}
    </div>
    <div class="pp-btn-row"><span id="pp_mem_rc_preview" class="menu_button">预览召回内容</span></div>
    <pre id="pp_mem_rc_out" class="pp-muted" style="display:none"></pre>`;

    el.querySelectorAll('[data-rtag]').forEach(box => box.addEventListener('change', () => {
        const t = box.dataset.rtag;
        const set = new Set(state.recallTags);
        box.checked ? set.add(t) : set.delete(t);
        state.recallTags = [...set];
        persistMemory();
    }));
    el.querySelector('#pp_mem_rc_preview').addEventListener('click', () => {
        const out = el.querySelector('#pp_mem_rc_out');
        const text = buildMemoryContext();
        out.style.display = '';
        out.textContent = text || '（没有可召回的内容）';
    });
}

// ---------------------------------------------------------------------------
// 网格表格：沿用「记忆增强表格」原版的表格样式（表头加粗 + 左侧行号 + 内容虚线格），等比例缩小
// ---------------------------------------------------------------------------

function gridHeadHtml(columns, extraThs = '') {
    return `
    <thead><tr>
        <th class="pp-grid-origin"></th>
        ${columns.map(c => `<th title="${escapeHtml(c)}">${escapeHtml(clamp(c || '', 12))}</th>`).join('')}
        ${extraThs}
    </tr></thead>`;
}

function gridCellHtml(value) {
    return `<td class="pp-grid-cell" title="${escapeHtml(value)}">${escapeHtml(clamp(value, 80))}</td>`;
}

function badgesOf(state, row) {
    const seen = new Set(state.seen);
    const out = [];
    if (!seen.has(row.rid)) out.push('<span class="pp-mem-badge" title="原表新增或被修改后重新出现的行">新</span>');
    if (row.edited && row.srcUpdated) out.push('<span class="pp-mem-badge pp-mem-badge-src" title="你改过这行，原表那行也有了新版本；编辑时可「采纳原表版本」">原表已更新</span>');
    else if (row.edited) out.push('<span class="pp-mem-badge pp-mem-badge-edit" title="你手动编辑过这行，合并时不会被原表覆盖">已改</span>');
    if (row.srcGone) out.push('<span class="pp-mem-badge pp-mem-badge-gone" title="原表里这行已被删除，镜像里为你保留">原表已删</span>');
    return out.join('');
}

// 镜像里的一行：编辑态时内容格就地变成输入框（不整页重渲染，保住滚动位置）
function mirrorRowHtml(state, sheet, row, idx) {
    const editing = editingRow === row.rid;
    const isNew = !new Set(state.seen).has(row.rid);
    const cells = editing
        ? sheet.columns.map((c, i) => `
            <td class="pp-grid-editcell"><textarea class="text_pole textarea_compact" rows="2" data-mcell="${i}" placeholder="${escapeHtml(c)}">${escapeHtml(row.cells[i] ?? '')}</textarea></td>`).join('')
        : sheet.columns.map((_, i) => gridCellHtml(row.cells[i] ?? '')).join('');
    const ops = editing
        ? `
        <span class="menu_button" data-msave>保存</span>
        <span class="menu_button" data-mcancel>取消</span>
        ${row.srcUpdated ? '<span class="menu_button" data-maccept>采纳原表</span>' : ''}`
        : `
        <span class="menu_button fa-solid fa-pen" data-medit="${row.rid}" title="编辑这行内容"></span>
        <span class="menu_button fa-solid fa-trash" data-mdel="${row.rid}" title="删除：进「已删除内容」页；原表内容不变就不再出现，原表改动后重新出现"></span>`;
    return `
    <tr class="${isNew ? 'pp-grid-new' : ''}${editing ? ' pp-grid-editing' : ''}" data-rid="${row.rid}" data-idx="${idx}">
        <td class="pp-grid-idx">${idx}</td>
        ${cells}
        <td class="pp-grid-tagscell"><input type="text" class="text_pole pp-grid-tags" data-mtags="${row.rid}" value="${escapeHtml((state.tags[row.rid] ?? []).join(','))}" placeholder="标签" title="标签，逗号分隔" /></td>
        <td class="pp-grid-statecell">${badgesOf(state, row)}</td>
        <td class="pp-grid-opscell">${ops}</td>
    </tr>`;
}

// 添加行：临时插在表体顶部的编辑行
function newRowEditorHtml(sheet) {
    return `
    <tr class="pp-grid-editing" data-new="1">
        <td class="pp-grid-idx">＋</td>
        ${sheet.columns.map((c, i) => `<td class="pp-grid-editcell"><textarea class="text_pole textarea_compact" rows="2" data-mcell="${i}" placeholder="${escapeHtml(c)}"></textarea></td>`).join('')}
        <td class="pp-grid-tagscell"></td>
        <td class="pp-grid-statecell"></td>
        <td class="pp-grid-opscell">
            <span class="menu_button" data-msave data-mode="add">添加</span>
            <span class="menu_button" data-mcancel>取消</span>
        </td>
    </tr>`;
}

// ---------------------------------------------------------------------------
// 镜像列表
// ---------------------------------------------------------------------------

function renderSheets(container) {
    const list = container.querySelector('#pp_mem_list');
    const state = memoryState();

    if (!state.mirror.sheets.length) {
        list.innerHTML = '';
        return;
    }

    list.innerHTML = state.mirror.sheets.map(sheet => {
        const open = !closedSheets.has(sheet.uid);
        const recall = state.sheetRecall[sheet.uid] ?? {};
        const colOn = i => !Array.isArray(recall.columns) || recall.columns.includes(i);
        return `
        <div class="pp-book" data-muid="${escapeHtml(sheet.uid)}">
            <div class="pp-item">
                <div class="pp-item-main"><b>${escapeHtml(sheet.name)}</b></div>
                <div class="pp-item-ops">
                    <span class="menu_button" data-mtoggle="${escapeHtml(sheet.uid)}">行 ${sheet.rows.length} <i class="fa-solid fa-chevron-${open ? 'down' : 'right'}"></i></span>
                    <label title="勾掉后这张表不参与剧情召回"><input type="checkbox" data-mrecall="${escapeHtml(sheet.uid)}" ${recall.enabled === false ? '' : 'checked'} /> 参与召回</label>
                    <span class="menu_button fa-solid fa-trash" data-mdelsheet="${escapeHtml(sheet.uid)}" title="从镜像删除整类（进「已删除内容」页；原表不动，内容不变不会再回来）"></span>
                </div>
            </div>
            <div class="pp-entries" ${open ? '' : 'hidden'}>
                <div class="pp-mem-cols">召回列：${sheet.columns.map((c, i) => `
                    <label><input type="checkbox" data-mcol="${i}" ${colOn(i) ? 'checked' : ''} /> ${escapeHtml(clamp(c, 10))}</label>`).join('')}
                </div>
                <div class="pp-mem-gridwrap">
                    <table class="pp-grid">
                        ${gridHeadHtml(sheet.columns, '<th>标签</th><th>状态</th><th>操作</th>')}
                        <tbody>
                            ${sheet.rows.map((r, i) => mirrorRowHtml(state, sheet, r, i)).join('')
        || `<tr><td colspan="${sheet.columns.length + 4}" class="pp-muted">没有行，点下方「添加行」</td></tr>`}
                        </tbody>
                    </table>
                </div>
                <div class="pp-btn-row"><span class="menu_button" data-maddrow="${escapeHtml(sheet.uid)}">添加行</span></div>
            </div>
        </div>`;
    }).join('');

    bindSheetEvents(container, list);
}

function collectEditorCells(scope) {
    const cells = [];
    scope.querySelectorAll('[data-mcell]').forEach(t => { cells[Number(t.dataset.mcell)] = t.value; });
    return cells.map(v => v ?? '');
}

// 单行就地重渲染（编辑开/关、保存后刷徽标），不整页刷新避免滚动位置丢失；返回新的行元素
function swapRow(container, uid, rid) {
    const s = memoryState();
    const sheet = s.mirror.sheets.find(x => x.uid === uid);
    const row = sheet?.rows.find(r => r.rid === rid);
    const old = container.querySelector(`#pp_mem_list tr[data-rid="${rid}"]`);
    if (!old || !row) return null;
    old.insertAdjacentHTML('beforebegin', mirrorRowHtml(s, sheet, row, Number(old.dataset.idx) || 0));
    const fresh = old.previousElementSibling;
    old.remove();
    bindRow(container, fresh, uid);
    return fresh;
}

function bindRow(container, tr, uid) {
    const rid = tr.dataset.rid;
    tr.querySelector('[data-mtags]')?.addEventListener('change', ev => {
        const tags = parseKeys(ev.target.value);
        setRowTags(rid, tags);
        ev.target.value = tags.join(',');
        renderStatus(container);
        renderRecall(container);
    });
    tr.querySelector('[data-medit]')?.addEventListener('click', () => {
        editingRow = rid;
        swapRow(container, uid, rid)?.querySelector('[data-mcell]')?.focus();
    });
    tr.querySelector('[data-mdel]')?.addEventListener('click', () => {
        deleteMirrorRow(uid, rid);
        if (editingRow === rid) editingRow = null;
        renderAll(container);
    });
    bindRowEditor(container, tr, uid, rid);
}

function bindRowEditor(container, tr, uid, rid) {
    const save = tr.querySelector('[data-msave]');
    const mode = save?.dataset.mode;
    save?.addEventListener('click', () => {
        const cells = collectEditorCells(tr);
        if (mode === 'add') {
            addMirrorRow(uid, cells);
            renderSheets(container);
            renderStatus(container);
            toastr.success('已添加行');
        } else {
            editMirrorRow(uid, rid, cells);
            editingRow = null;
            swapRow(container, uid, rid);
            renderStatus(container);
            toastr.success('已保存');
        }
    });
    tr.querySelector('[data-mcancel]')?.addEventListener('click', () => {
        if (mode === 'add') tr.remove();
        else {
            editingRow = null;
            swapRow(container, uid, rid);
        }
    });
    tr.querySelector('[data-maccept]')?.addEventListener('click', () => {
        acceptSourceRow(uid, rid);
        editingRow = null;
        swapRow(container, uid, rid);
        renderStatus(container);
        toastr.info('已采纳原表版本');
    });
}

function bindSheetEvents(container, list) {
    list.querySelectorAll('[data-mtoggle]').forEach(el => el.addEventListener('click', () => {
        const uid = el.dataset.mtoggle;
        closedSheets.has(uid) ? closedSheets.delete(uid) : closedSheets.add(uid);
        renderSheets(container);
    }));
    list.querySelectorAll('[data-mrecall]').forEach(el => el.addEventListener('change', () => {
        const s = memoryState();
        const rc = (s.sheetRecall[el.dataset.mrecall] ??= {});
        rc.enabled = el.checked;
        persistMemory();
    }));
    list.querySelectorAll('.pp-book').forEach(book => {
        const uid = book.dataset.muid;
        book.querySelectorAll('[data-mcol]').forEach(el => el.addEventListener('change', () => {
            const s = memoryState();
            const rc = (s.sheetRecall[uid] ??= {});
            const all = s.mirror.sheets.find(x => x.uid === uid)?.columns ?? [];
            const set = new Set(Array.isArray(rc.columns) ? rc.columns : all.map((_, i) => i));
            el.checked ? set.add(Number(el.dataset.mcol)) : set.delete(Number(el.dataset.mcol));
            rc.columns = [...set].sort((a, b) => a - b);
            persistMemory();
        }));
    });

    list.querySelectorAll('tbody tr[data-rid]').forEach(tr => {
        bindRow(container, tr, tr.closest('.pp-book').dataset.muid);
    });

    // 添加行：编辑行插在表体顶部，再点一次取消
    list.querySelectorAll('[data-maddrow]').forEach(el => el.addEventListener('click', () => {
        const uid = el.dataset.maddrow;
        const tbody = el.closest('.pp-entries')?.querySelector('tbody');
        if (!tbody) return;
        const existing = tbody.querySelector('tr[data-new]');
        if (existing) {
            existing.remove();
            return;
        }
        const sheet = memoryState().mirror.sheets.find(s => s.uid === uid);
        if (!sheet) return;
        tbody.insertAdjacentHTML('afterbegin', newRowEditorHtml(sheet));
        bindRowEditor(container, tbody.querySelector('tr[data-new]'), uid, null);
    }));

    list.querySelectorAll('[data-mdelsheet]').forEach(el => el.addEventListener('click', () => {
        const uid = el.dataset.mdelsheet;
        const s = memoryState();
        const sheet = s.mirror.sheets.find(x => x.uid === uid);
        if (!sheet) return;
        deleteMirrorSheet(uid);
        closedSheets.delete(uid);
        renderAll(container);
        toastr.info(`已从镜像删除「${sheet.name}」整类（进「已删除内容」页；原表不动）`);
    }));
}

// ---------------------------------------------------------------------------
// 已删除内容页：独立页面，按表名分组，可恢复到镜像 / 永久清除
// ---------------------------------------------------------------------------

function renderDeleted(container) {
    const el = container.querySelector('#pp_mem_del');
    const state = memoryState();

    const groups = new Map();   // sheetUid -> { name, items: [[fp, tombstone]] }
    for (const [fp, t] of Object.entries(state.tombstones)) {
        const uid = t.sheetUid ?? 'unknown';
        if (!groups.has(uid)) groups.set(uid, { name: t.sheetName ?? uid, items: [] });
        groups.get(uid).items.push([fp, t]);
    }
    const total = Object.keys(state.tombstones).length;

    const listHtml = [...groups.values()].map(g => {
        g.items.sort((a, b) => (b[1].at ?? 0) - (a[1].at ?? 0));
        const columns = g.items[0][1].columns ?? [];
        return `
        <div class="pp-book">
            <div class="pp-item">
                <div class="pp-item-main"><b>${escapeHtml(g.name)}</b></div>
                <div class="pp-item-ops"><span class="pp-muted">${g.items.length} 行</span></div>
            </div>
            <div class="pp-entries">
                <div class="pp-mem-gridwrap">
                    <table class="pp-grid">
                        ${gridHeadHtml(columns, '<th>操作</th>')}
                        <tbody>
                            ${g.items.map(([fp, t], i) => `
                            <tr>
                                <td class="pp-grid-idx">${i}</td>
                                ${columns.map((_, ci) => gridCellHtml(t.cells?.[ci] ?? '')).join('')}
                                <td class="pp-grid-opscell">
                                    <span class="menu_button" data-mundel="${fp}" title="把这一行放回镜像工作区">恢复</span>
                                    <span class="menu_button" data-mpurge="${fp}" title="永久删掉这条删除记录（不可恢复）">清除</span>
                                </td>
                            </tr>`).join('')}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>`;
    }).join('');

    el.innerHTML = `
    <div class="pp-section">
        <div class="pp-btn-row">
            <span id="pp_mem_del_back" class="menu_button"><i class="fa-solid fa-arrow-left"></i> 返回镜像</span>
            <span id="pp_mem_del_purge" class="menu_button" title="删除记录里，原表已经不存在对应行的（整表没了或那行在原表里也删了）——这种记录永远不会再用到，点这里把它们永久清掉，不影响其他记录">清理无效记录</span>
        </div>
        <b title="在镜像里删掉的行都在这里，不参与召回，也不会堆在工作区。「恢复」= 放回镜像；「清除」= 永久删除记录。原表新增或修改的行不受影响，会照常出现在镜像里等你复审">已删除内容（${total} 条）</b>
    </div>
    ${listHtml || '<div class="pp-muted">还没有删除过任何内容</div>'}`;

    el.querySelector('#pp_mem_del_back').addEventListener('click', () => {
        memView = 'main';
        renderAll(container);
    });
    el.querySelector('#pp_mem_del_purge').addEventListener('click', () => {
        const n = purgeMootTombstones();
        toastr.info(n ? `清理了 ${n} 条无效记录` : '没有需要清理的记录');
        renderAll(container);
    });
    el.querySelectorAll('[data-mundel]').forEach(btn => btn.addEventListener('click', () => {
        undeleteRow(btn.dataset.mundel);
        renderAll(container);
        toastr.success('已恢复到镜像');
    }));
    el.querySelectorAll('[data-mpurge]').forEach(btn => btn.addEventListener('click', () => {
        delete memoryState().tombstones[btn.dataset.mpurge];
        persistMemory();
        renderAll(container);
    }));
}

// ---------------------------------------------------------------------------
// 原表库（只读）
// ---------------------------------------------------------------------------

function renderSource(container) {
    const el = container.querySelector('#pp_mem_src');
    const state = memoryState();
    const sheets = state.source.sheets;
    const libRows = sheets.reduce((n, s) => n + s.rows.length, 0);
    const libSheets = sheets.filter(s => s.rows.length > 0).length;

    // 默认只留一条摘要行：原表库是自动同步的只读备份（防清空），不是编辑区，展开只为核对/恢复
    const head = `
    <div class="pp-item" id="pp_mem_libhead" title="从记忆表格插件自动同步的只读快照，用于自动备份与恢复（入口在上方「备份与恢复」）；不能在这里编辑，编辑请用上面的镜像">
        <div class="pp-item-main"><b>原表库 · 自动备份（只读）</b></div>
        <div class="pp-item-ops">
            <span class="pp-muted">${libSheets} 表 ${libRows} 行 · 备份 ${state.backups.length} 份</span>
            <span class="menu_button" id="pp_mem_libtoggle">${libOpen ? '收起' : '展开'} <i class="fa-solid fa-chevron-${libOpen ? 'down' : 'right'}"></i></span>
        </div>
    </div>`;

    if (!sheets.length) {
        el.innerHTML = head;
        el.querySelector('#pp_mem_libtoggle').addEventListener('click', () => {
            libOpen = !libOpen;
            renderSource(container);
        });
        return;
    }
    if (!libOpen) {
        el.innerHTML = head;
        el.querySelector('#pp_mem_libtoggle').addEventListener('click', () => {
            libOpen = !libOpen;
            renderSource(container);
        });
        return;
    }

    const empty = sheets.filter(s => !s.rows.length);
    const shown = showEmptySrc ? sheets : sheets.filter(s => s.rows.length > 0);
    el.innerHTML = `
    ${head}
    ${empty.length ? `<div class="pp-btn-row"><span id="pp_mem_emptysrc" class="menu_button">${showEmptySrc ? '隐藏' : '显示'}空模板表（${empty.length} 张）</span></div>` : ''}
    ${shown.map(s => `
    <div class="pp-item">
        <div class="pp-item-main"><b>${escapeHtml(s.name)}</b></div>
        <div class="pp-item-ops">
            <span class="pp-muted">${s.rows.length} 行</span>
            <span class="menu_button" data-stoggle="${escapeHtml(s.uid)}"><i class="fa-solid fa-chevron-${openSrc.has(s.uid) ? 'down' : 'right'}"></i></span>
        </div>
        ${openSrc.has(s.uid) ? `
        <div class="pp-mem-gridwrap">
            <table class="pp-grid">
                ${gridHeadHtml(s.columns)}
                <tbody>${s.rows.map((r, i) => `
                    <tr><td class="pp-grid-idx">${i}</td>${r.cells.map(c => gridCellHtml(c)).join('')}</tr>`).join('')}</tbody>
            </table>
        </div>` : ''}
    </div>`).join('')}`;

    el.querySelector('#pp_mem_libtoggle').addEventListener('click', () => {
        libOpen = !libOpen;
        renderSource(container);
    });
    el.querySelector('#pp_mem_emptysrc')?.addEventListener('click', () => {
        showEmptySrc = !showEmptySrc;
        renderSource(container);
    });
    el.querySelectorAll('[data-stoggle]').forEach(t => t.addEventListener('click', () => {
        const uid = t.dataset.stoggle;
        openSrc.has(uid) ? openSrc.delete(uid) : openSrc.add(uid);
        renderSource(container);
    }));
}
