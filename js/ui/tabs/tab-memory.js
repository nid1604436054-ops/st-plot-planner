// 记忆表格页签（v2：原表库 / 镜像 分离）
//   - 原表库：自动同步 + 备份，只读展示（含恢复到原表）
//   - 镜像：随意编辑的工作版（改行内容 / 删行 / 删整类 / 加行 / 打标签），召回只用镜像
//   - AI 自动打标签：把没标签的行分批交给独立 API 按用户给的分类标准打标
import {
    memoryState, syncMemory, mergeMirrorFromSource, persistMemory,
    deleteMirrorRow, deleteMirrorSheet, undeleteRow, purgeMootTombstones,
    setRowTags, markSeen, newRowCount, allTags, buildMemoryContext,
    restoreFromBackup, editMirrorRow, acceptSourceRow, addMirrorRow, autoTagRows,
} from "../../memoryTable.js";
import { parseKeys } from "../../lorebook.js";
import { escapeHtml, clamp, downloadJson } from "../../utils.js";

// 展开状态跨重渲染保持
const openSheets = new Set();      // 展开的镜像表
const openDeleted = new Set();     // 展开的「已删除」区
const openSrc = new Set();         // 展开的原表
let showEmptySrc = false;          // 原表库是否显示空表
let editingRow = null;             // 正在编辑内容的行 rid（重渲染后保持编辑框开着）

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
        container.innerHTML = `
        <div class="pp-section">
            <div class="pp-btn-row">
                <div id="pp_mem_sync" class="menu_button" title="从记忆表格插件读取最新数据，更新原表库并归档备份；镜像不动">立即同步原表</div>
                <div id="pp_mem_merge" class="menu_button" title="把原表库的新增/修改合并进镜像；你编辑过的行不会被覆盖，删除过的行不复活">从原表更新镜像</div>
                <div id="pp_mem_tag_btn" class="menu_button">AI 打标签</div>
                <div id="pp_mem_bk_btn" class="menu_button">备份与恢复</div>
                <div id="pp_mem_rc_btn" class="menu_button">召回设置</div>
            </div>
            <div id="pp_mem_status" class="pp-muted"></div>
            <div id="pp_mem_wipe"></div>
            <div id="pp_mem_tagai" style="display:none"></div>
            <div id="pp_mem_backups" style="display:none"></div>
            <div id="pp_mem_recall" style="display:none"></div>
        </div>
        <b class="pp-group-title">镜像 · 剧情召回用（随意编辑，不影响原表）</b>
        <div id="pp_mem_list" class="pp-mem-list"></div>
        <b class="pp-group-title">原表库（自动同步，只读）</b>
        <div id="pp_mem_src" class="pp-mem-list"></div>`;

        container.querySelector('#pp_mem_sync').addEventListener('click', () => {
            const r = syncMemory();
            if (r.wiped) toastr.warning('检测到原表可能被清空：原表库和备份已保留，没有同步空数据');
            else if (r.changed) {
                mergeMirrorFromSource();
                toastr.success('原表库已更新（镜像未动，需要时点「从原表更新镜像」合并）');
            } else toastr.info('原表没有变化');
            renderAll(container);
        });
        container.querySelector('#pp_mem_merge').addEventListener('click', () => {
            const r = mergeMirrorFromSource();
            if (r.changed) toastr.success(r.added ? `已合并：新进 ${r.added} 行（原表新增或被修改）` : '已合并（部分行的原表状态有更新）');
            else toastr.info('镜像已是最新');
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

        // 打开页签即同步 + 合并一次（首次会建立原表库与镜像）
        const r = syncMemory();
        if (r.changed) mergeMirrorFromSource();
        renderAll(container);
    },
};

function renderAll(container) {
    renderStatus(container);
    renderWipe(container);
    renderTagAi(container);
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

function renderTagAi(container) {
    const state = memoryState();
    const el = container.querySelector('#pp_mem_tagai');
    el.innerHTML = `
    <b>AI 自动打标签</b>
    <span class="pp-muted">把镜像里还没有标签的行分批交给「设置」页配置的 API 分类。分类标准写类别名（逗号/顿号分隔）或一段描述。</span>
    <textarea id="pp_mem_tagstd" class="text_pole textarea_compact" rows="2" placeholder="分类标准，例如：战斗,感情,约定,物品,地点,其他"></textarea>
    <label class="pp-label"><input type="checkbox" id="pp_mem_tagover" /> 覆盖已有标签</label>
    <div class="pp-btn-row"><span id="pp_mem_tagrun" class="menu_button">开始打标签</span></div>`;
    el.querySelector('#pp_mem_tagstd').value = state.tagStandard ?? '';

    el.querySelector('#pp_mem_tagrun').addEventListener('click', async () => {
        const btn = el.querySelector('#pp_mem_tagrun');
        const std = el.querySelector('#pp_mem_tagstd');
        const standard = std.value.trim();
        state.tagStandard = standard;
        persistMemory();
        const s = memoryState();
        const overwrite = el.querySelector('#pp_mem_tagover').checked;
        const pending = s.mirror.sheets.reduce((n, sh) =>
            n + sh.rows.filter(r => overwrite || !(s.tags[r.rid] ?? []).length).length, 0);
        if (!pending) {
            toastr.info('没有待打标签的行（都已有标签，或镜像为空）');
            return;
        }
        btn.textContent = '打标签中…';
        try {
            const r = await autoTagRows({
                standard, overwrite,
                onProgress: (done, all) => { btn.textContent = `打标签中… ${done}/${all} 行`; },
            });
            toastr.success(`已为 ${r.tagged} / ${r.total} 行打上标签`);
            renderAll(container);
        } catch (err) {
            toastr.error(`打标签失败：${err.message}`);
            btn.textContent = '开始打标签';
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
    <b>备份与恢复</b>
    <span class="pp-muted">原表库每次内容变化归档上一版（最多 20 份）。恢复 = 把该版本里缺失的行插回原表，只增不改。</span>
    ${item(`当前原表库（${fmtTime(state.source.syncedAt)} · ${rowsOf(state.source.sheets)} 行）`, state.source.sheets, 'live')}
    ${state.backups.map(b => item(`${fmtTime(b.at)} · ${rowsOf(b.sheets)} 行`, b.sheets, String(b.at))).join('')}
    <div class="pp-btn-row"><span id="pp_mem_purge" class="menu_button">清理无效删除记录</span></div>`;

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
    el.querySelector('#pp_mem_purge').addEventListener('click', () => {
        const n = purgeMootTombstones();
        toastr.info(n ? `清理了 ${n} 条无效记录` : '没有需要清理的记录');
        renderAll(container);
    });
}

function renderRecall(container) {
    const state = memoryState();
    const el = container.querySelector('#pp_mem_recall');
    const tags = allTags(state);
    el.innerHTML = `
    <b>召回设置</b>
    <span class="pp-muted">剧情规划注入时使用镜像里未删除的行。不勾任何标签 = 全部行；勾选后只注入带这些标签的行。</span>
    <div class="pp-mem-tagbar">
        ${tags.length ? tags.map(([t, n]) => `
        <label class="pp-mem-chip"><input type="checkbox" data-rtag="${escapeHtml(t)}" ${state.recallTags.includes(t) ? 'checked' : ''} /> ${escapeHtml(t)} (${n})</label>
        `).join('') : '<span class="pp-muted">还没有任何标签，手动在行旁输入，或用「AI 打标签」</span>'}
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
// 镜像列表
// ---------------------------------------------------------------------------

function badgesOf(state, row) {
    const seen = new Set(state.seen);
    const out = [];
    if (!seen.has(row.rid)) out.push('<span class="pp-mem-badge" title="原表新增或被修改后重新出现的行">新</span>');
    if (row.edited && row.srcUpdated) out.push('<span class="pp-mem-badge pp-mem-badge-src" title="你改过这行，原表那行也有了新版本；可在编辑框里「采纳原表版本」">原表已更新</span>');
    else if (row.edited) out.push('<span class="pp-mem-badge pp-mem-badge-edit" title="你手动编辑过这行，合并时不会被原表覆盖">已改</span>');
    if (row.srcGone) out.push('<span class="pp-mem-badge pp-mem-badge-gone" title="原表里这行已被删除，镜像里为你保留">原表已删</span>');
    return out.join('');
}

function renderSheets(container) {
    const list = container.querySelector('#pp_mem_list');
    const state = memoryState();

    if (!state.mirror.sheets.length) {
        list.innerHTML = '<div class="pp-muted">镜像为空。确认记忆表格插件里有带内容的表后，点「立即同步原表」+「从原表更新镜像」。空模板表不会进镜像。</div>';
        return;
    }

    list.innerHTML = state.mirror.sheets.map(sheet => {
        const open = openSheets.has(sheet.uid);
        const recall = state.sheetRecall[sheet.uid] ?? {};
        const colOn = i => !Array.isArray(recall.columns) || recall.columns.includes(i);
        const deleted = Object.entries(state.tombstones).filter(([, t]) => t.sheetUid === sheet.uid);
        return `
        <div class="pp-book" data-muid="${escapeHtml(sheet.uid)}">
            <div class="pp-item">
                <div class="pp-item-main"><b>${escapeHtml(sheet.name)}</b></div>
                <div class="pp-item-ops">
                    <span class="menu_button" data-mtoggle="${escapeHtml(sheet.uid)}">行 ${sheet.rows.length} <i class="fa-solid fa-chevron-${open ? 'down' : 'right'}"></i></span>
                    <label><input type="checkbox" data-mrecall="${escapeHtml(sheet.uid)}" ${recall.enabled === false ? '' : 'checked'} /> 参与召回</label>
                    <span class="menu_button fa-solid fa-trash" data-mdelsheet="${escapeHtml(sheet.uid)}" title="从镜像删除整类（原表不动；原表这批行内容不变就不会再回来）"></span>
                </div>
            </div>
            <div class="pp-entries" ${open ? '' : 'hidden'}>
                <div class="pp-mem-cols">召回列：${sheet.columns.map((c, i) => `
                    <label><input type="checkbox" data-mcol="${i}" ${colOn(i) ? 'checked' : ''} /> ${escapeHtml(clamp(c, 10))}</label>`).join('')}
                </div>
                ${sheet.rows.map(r => {
                    const editing = editingRow === r.rid;
                    return `
                    <div class="pp-mem-rowwrap">
                        <div class="pp-mem-row" data-rid="${r.rid}">
                            <input type="text" class="text_pole pp-mem-tags" data-mtags="${r.rid}" value="${escapeHtml((state.tags[r.rid] ?? []).join(','))}" placeholder="标签" title="标签，逗号分隔" />
                            <div class="pp-mem-cells" title="${escapeHtml(sheet.columns.map((c, i) => `${c}：${r.cells[i] ?? ''}`).join('\n'))}">
                                ${sheet.columns.map((c, i) => r.cells[i] ? `<span class="pp-mem-cell"><i>${escapeHtml(clamp(c, 8))}</i>${escapeHtml(clamp(r.cells[i], 50))}</span>` : '').join('')}
                            </div>
                            ${badgesOf(state, r)}
                            <span class="menu_button fa-solid fa-pen" data-medit="${r.rid}" title="编辑这行内容"></span>
                            <span class="menu_button fa-solid fa-trash" data-mdel="${r.rid}" title="删除：原表内容不变就不再出现；原表改动后会重新出现"></span>
                        </div>
                        ${editing ? rowEditorHtml(sheet, r) : ''}
                    </div>`;
                }).join('') || '<div class="pp-muted">没有行，可点下方「添加行」</div>'}
                <div class="pp-btn-row">
                    <span class="menu_button" data-maddrow="${escapeHtml(sheet.uid)}">添加行</span>
                </div>
                ${deleted.length ? `
                <div class="pp-mem-delwrap">
                    <span class="menu_button" data-mshowdel="${escapeHtml(sheet.uid)}">已删除 ${deleted.length} 条 <i class="fa-solid fa-chevron-${openDeleted.has(sheet.uid) ? 'down' : 'right'}"></i></span>
                    ${openDeleted.has(sheet.uid) ? deleted.map(([fp, t]) => `
                    <div class="pp-mem-delrow">
                        <div class="pp-mem-cells pp-muted">${escapeHtml(clamp((t.cells ?? []).join(' ｜ '), 120))}</div>
                        <span class="pp-mem-ops">
                            <span class="menu_button" data-mundel="${fp}">恢复显示</span>
                            <span class="menu_button" data-mpurge="${fp}" title="删掉这条删除记录">清除</span>
                        </span>
                    </div>`).join('') : ''}
                </div>` : ''}
            </div>
        </div>`;
    }).join('');

    bindSheetEvents(container, list);
}

// 行内容编辑框：每列一个输入区；源行被改过时可一键采纳原表版本
function rowEditorHtml(sheet, row) {
    const isNew = row == null;
    return `
    <div class="pp-mem-editrow" ${isNew ? 'data-new="1"' : ''}>
        ${sheet.columns.map((c, i) => `
        <label class="pp-label">${escapeHtml(c || `列${i + 1}`)}</label>
        <textarea class="text_pole textarea_compact" rows="2" data-mcell="${i}">${escapeHtml(row?.cells[i] ?? '')}</textarea>`).join('')}
        <div class="pp-btn-row">
            <span class="menu_button" data-msave>${isNew ? '确认添加' : '保存'}</span>
            <span class="menu_button" data-mcancel>取消</span>
            ${row?.srcUpdated ? '<span class="menu_button" data-maccept>采纳原表版本</span>' : ''}
        </div>
    </div>`;
}

function collectEditorCells(editor) {
    const cells = [];
    editor.querySelectorAll('[data-mcell]').forEach(t => { cells[Number(t.dataset.mcell)] = t.value; });
    return cells.map(v => v ?? '');
}

function bindSheetEvents(container, list) {
    const state = memoryState();

    list.querySelectorAll('[data-mtoggle]').forEach(el => el.addEventListener('click', () => {
        const uid = el.dataset.mtoggle;
        openSheets.has(uid) ? openSheets.delete(uid) : openSheets.add(uid);
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

    list.querySelectorAll('[data-mtags]').forEach(el => el.addEventListener('change', () => {
        const tags = parseKeys(el.value);
        setRowTags(el.dataset.mtags, tags);
        el.value = tags.join(',');
        el.closest('.pp-mem-row')?.classList.remove('pp-mem-new');
        renderStatus(container);
        renderRecall(container);
    }));

    // 行内容编辑 / 添加行：编辑框就地展开，不整体重渲染，避免长列表滚动位置丢失
    const toggleEditor = (rowwrap, html) => {
        const existing = rowwrap.querySelector('.pp-mem-editrow');
        if (existing) {
            existing.remove();
            editingRow = null;
            return false;
        }
        rowwrap.insertAdjacentHTML('beforeend', html);
        return true;
    };
    list.querySelectorAll('[data-medit]').forEach(el => el.addEventListener('click', () => {
        const rid = el.dataset.medit;
        const rowwrap = el.closest('.pp-mem-rowwrap');
        const uid = el.closest('.pp-book').dataset.muid;
        const sheet = memoryState().mirror.sheets.find(s => s.uid === uid);
        const row = sheet?.rows.find(r => r.rid === rid);
        if (!row) return;
        const opened = toggleEditor(rowwrap, rowEditorHtml(sheet, row));
        editingRow = opened ? rid : null;
        if (opened) bindEditor(rowwrap, uid, rid);
    }));
    list.querySelectorAll('[data-maddrow]').forEach(el => el.addEventListener('click', () => {
        const uid = el.dataset.maddrow;
        // 添加行编辑框展开在条目区顶部
        const entries = el.closest('.pp-entries');
        let editor = entries.querySelector('.pp-mem-editrow[data-new]');
        if (editor) {
            editor.remove();
            editingRow = null;
            return;
        }
        const sheet = memoryState().mirror.sheets.find(s => s.uid === uid);
        if (!sheet) return;
        entries.insertAdjacentHTML('afterbegin', rowEditorHtml(sheet, null));
        editor = entries.querySelector('.pp-mem-editrow[data-new]');
        bindEditor(editor, uid, null);
    }));

    function bindEditor(editor, uid, rid) {
        editor.querySelector('[data-msave]').addEventListener('click', () => {
            const cells = collectEditorCells(editor);
            if (rid == null) {
                addMirrorRow(uid, cells);
                editingRow = null;
                renderSheets(container);
                renderStatus(container);
                toastr.success('已添加行');
            } else {
                editMirrorRow(uid, rid, cells);
                editingRow = null;
                renderSheets(container);   // 刷新徽标（已改）与内容
                toastr.success('已保存');
            }
        });
        editor.querySelector('[data-mcancel]').addEventListener('click', () => {
            editor.remove();
            editingRow = null;
        });
        editor.querySelector('[data-maccept]')?.addEventListener('click', () => {
            acceptSourceRow(uid, rid);
            editingRow = null;
            renderSheets(container);
            toastr.info('已采纳原表版本');
        });
    }

    // 整表重渲染时，editingRow 对应的编辑框是随 HTML 重新生成的，按钮要重新绑定
    list.querySelectorAll('.pp-mem-editrow:not([data-new])').forEach(editor => {
        const rid = editor.closest('.pp-mem-rowwrap')?.querySelector('.pp-mem-row')?.dataset.rid;
        const uid = editor.closest('.pp-book')?.dataset.muid;
        if (rid && uid) bindEditor(editor, uid, rid);
    });

    list.querySelectorAll('[data-mdel]').forEach(el => el.addEventListener('click', () => {
        const rid = el.dataset.mdel;
        const uid = el.closest('.pp-book').dataset.muid;
        deleteMirrorRow(uid, rid);
        renderAll(container);
    }));
    list.querySelectorAll('[data-mdelsheet]').forEach(el => el.addEventListener('click', () => {
        const uid = el.dataset.mdelsheet;
        const s = memoryState();
        const sheet = s.mirror.sheets.find(x => x.uid === uid);
        if (!sheet) return;
        deleteMirrorSheet(uid);
        openSheets.delete(uid);
        renderAll(container);
        toastr.info(`已从镜像删除「${sheet.name}」整类（原表不动；内容不变不会再回来）`);
    }));
    list.querySelectorAll('[data-mshowdel]').forEach(el => el.addEventListener('click', () => {
        const uid = el.dataset.mshowdel;
        openDeleted.has(uid) ? openDeleted.delete(uid) : openDeleted.add(uid);
        renderSheets(container);
    }));
    list.querySelectorAll('[data-mundel]').forEach(el => el.addEventListener('click', () => {
        undeleteRow(el.dataset.mundel);
        renderAll(container);
    }));
    list.querySelectorAll('[data-mpurge]').forEach(el => el.addEventListener('click', () => {
        const s = memoryState();
        delete s.tombstones[el.dataset.mpurge];
        persistMemory();
        renderAll(container);
    }));

    void state;
}

// ---------------------------------------------------------------------------
// 原表库（只读）
// ---------------------------------------------------------------------------

function renderSource(container) {
    const el = container.querySelector('#pp_mem_src');
    const state = memoryState();
    const sheets = state.source.sheets;
    const empty = sheets.filter(s => !s.rows.length);
    const shown = showEmptySrc ? sheets : sheets.filter(s => s.rows.length > 0);

    if (!sheets.length) {
        el.innerHTML = '<div class="pp-muted">原表库为空（当前聊天还没读到记忆表格数据）</div>';
        return;
    }
    el.innerHTML = `
    ${empty.length ? `<div class="pp-btn-row"><span id="pp_mem_emptysrc" class="menu_button">${showEmptySrc ? '隐藏' : '显示'}空模板表（${empty.length} 张）</span></div>` : ''}
    ${shown.map(s => `
    <div class="pp-item">
        <div class="pp-item-main"><b>${escapeHtml(s.name)}</b></div>
        <div class="pp-item-ops">
            <span class="pp-muted">${s.rows.length} 行</span>
            <span class="menu_button" data-stoggle="${escapeHtml(s.uid)}"><i class="fa-solid fa-chevron-${openSrc.has(s.uid) ? 'down' : 'right'}"></i></span>
        </div>
        ${openSrc.has(s.uid) ? `
        <div class="pp-mem-srclist pp-muted">
            ${s.rows.length ? s.rows.map(r => `<div>${escapeHtml(clamp(r.cells.join(' ｜ '), 100))}</div>`).join('') : '（空表）'}
        </div>` : ''}
    </div>`).join('')}`;

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
