// 记忆表格页签：镜像同步状态、清空警告/恢复、按行打标签/删除（墓碑）、
// 列召回筛选、备份列表、召回标签与预览
import {
    memoryState, syncMemory, persistMemory, deleteRow, undeleteRow, purgeMootTombstones,
    setRowTags, markSeen, newRowCount, allTags, buildMemoryContext, restoreFromBackup,
} from "../../memoryTable.js";
import { parseKeys } from "../../lorebook.js";
import { escapeHtml, clamp, downloadJson } from "../../utils.js";

// 展开状态跨重渲染保持
const openSheets = new Set();
const openDeleted = new Set();

function fmtTime(ts) {
    if (!ts) return '从未';
    const d = new Date(ts);
    const p = n => String(n).padStart(2, '0');
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function sheetStats(state) {
    const rows = state.mirror.sheets.reduce((n, s) => n + s.rows.length, 0);
    return {
        sheets: state.mirror.sheets.length,
        rows,
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
                <div id="pp_mem_sync" class="menu_button">立即同步</div>
                <div id="pp_mem_bk_btn" class="menu_button">备份与恢复</div>
                <div id="pp_mem_rc_btn" class="menu_button">召回设置</div>
            </div>
            <div id="pp_mem_status" class="pp-muted"></div>
            <div id="pp_mem_wipe"></div>
            <div id="pp_mem_backups" style="display:none"></div>
            <div id="pp_mem_recall" style="display:none"></div>
            <div id="pp_mem_list"></div>
        </div>`;

        container.querySelector('#pp_mem_sync').addEventListener('click', () => {
            const r = syncMemory();
            if (r.wiped) toastr.warning('检测到原表可能被清空：已保留镜像和备份，没有同步空数据');
            else if (r.changed) toastr.success(`同步完成：新出现 ${r.newCount} 行（原表新增或被修改的行）`);
            else toastr.info('原表没有变化');
            renderAll(container);
        });
        container.querySelector('#pp_mem_bk_btn').addEventListener('click', () => {
            const el = container.querySelector('#pp_mem_backups');
            el.style.display = el.style.display === 'none' ? '' : 'none';
        });
        container.querySelector('#pp_mem_rc_btn').addEventListener('click', () => {
            const el = container.querySelector('#pp_mem_recall');
            el.style.display = el.style.display === 'none' ? '' : 'none';
        });

        // 打开页签即同步一次（首次会建立镜像）
        syncMemory();
        renderAll(container);
    },
};

function renderAll(container) {
    renderStatus(container);
    renderWipe(container);
    renderBackups(container);
    renderRecall(container);
    renderSheets(container);
}

function renderStatus(container) {
    const state = memoryState();
    const st = sheetStats(state);
    const el = container.querySelector('#pp_mem_status');
    let html = `上次同步：${fmtTime(state.syncedAt)} · ${st.sheets} 张表 ${st.rows} 行 · 已删除 ${st.deleted} 行 · 备份 ${st.backups} 份`;
    if (st.fresh > 0) {
        html += ` · <span class="pp-mem-fresh">新 ${st.fresh} 行</span> <span id="pp_mem_seen" class="menu_button">全部标为已读</span>`;
    }
    el.innerHTML = html;
    el.querySelector('#pp_mem_seen')?.addEventListener('click', () => {
        markSeen(state, state.mirror.sheets.flatMap(s => s.rows.map(r => r.fp)));
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
        <div>⚠ 检测到记忆表格疑似被清空（${fmtTime(state.wipeAlert.at)}）：镜像仍保留 ${state.wipeAlert.rows} 行，未同步空数据。</div>
        <div class="pp-btn-row">
            <span id="pp_mem_restore_mirror" class="menu_button">从镜像恢复到原表</span>
            <span id="pp_mem_force_sync" class="menu_button">这是我自己清空的，仍然同步</span>
        </div>
    </div>`;
    el.querySelector('#pp_mem_restore_mirror').addEventListener('click', async () => {
        try {
            const n = await restoreFromBackup(state.mirror.sheets);
            toastr.success(`已插回 ${n} 行，请到记忆表格插件里核对`);
            renderAll(container);
        } catch (err) {
            toastr.error(`恢复失败：${err.message}`);
        }
    });
    el.querySelector('#pp_mem_force_sync').addEventListener('click', () => {
        syncMemory({ force: true });
        toastr.info('已按空表同步（清空前的数据在备份里）');
        renderAll(container);
    });
}

function renderBackups(container) {
    const state = memoryState();
    const el = container.querySelector('#pp_mem_backups');
    const rowsOf = sheets => sheets.reduce((n, s) => n + s.rows.length, 0);
    const item = (label, sheets, at) => `
    <div class="pp-mem-bkrow">
        <span>${label}</span>
        <span class="pp-mem-ops">
            <span class="menu_button" data-restore="${at}">恢复到原表</span>
            <span class="menu_button" data-export="${at}">导出</span>
        </span>
    </div>`;
    el.innerHTML = `
    <b>备份与恢复</b>
    <span class="pp-muted">每次原表内容变化时归档上一版镜像（最多 ${20} 份）。恢复 = 把该版本里缺失的行插回原表，只增不改。</span>
    ${item(`当前镜像（${fmtTime(state.syncedAt)} · ${rowsOf(state.mirror.sheets)} 行）`, state.mirror.sheets, 'mirror')}
    ${state.backups.map(b => item(`${fmtTime(b.at)} · ${rowsOf(b.sheets)} 行`, b.sheets, String(b.at))).join('')}
    <div class="pp-btn-row"><span id="pp_mem_purge" class="menu_button">清理无效删除记录</span></div>`;

    const findSheets = key => key === 'mirror' ? state.mirror.sheets
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
    <span class="pp-muted">剧情规划注入时使用。不勾任何标签 = 注入全部未删除行；勾选后只注入带这些标签的行。标签在各行旁边的输入框里打。</span>
    <div class="pp-mem-tagbar">
        ${tags.length ? tags.map(([t, n]) => `
        <label class="pp-mem-chip"><input type="checkbox" data-rtag="${escapeHtml(t)}" ${state.recallTags.includes(t) ? 'checked' : ''} /> ${escapeHtml(t)} (${n})</label>
        `).join('') : '<span class="pp-muted">还没有任何标签，先到下面给行打标签</span>'}
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

function renderSheets(container) {
    const list = container.querySelector('#pp_mem_list');
    const state = memoryState();

    if (!state.mirror.sheets.length) {
        list.innerHTML = '<div class="pp-muted">当前聊天没有读到记忆表格数据。确认「记忆增强表格」插件已安装、表格已启用，且至少有过一轮角色回复。</div>';
        return;
    }

    const seen = new Set(state.seen);
    list.innerHTML = state.mirror.sheets.map(sheet => {
        const open = openSheets.has(sheet.uid);
        const recall = state.sheetRecall[sheet.uid] ?? {};
        const colOn = i => !Array.isArray(recall.columns) || recall.columns.includes(i);
        const visibleRows = sheet.rows.filter(r => !state.tombstones[r.fp]);
        const delRows = sheet.rows.filter(r => state.tombstones[r.fp])
            .map(r => ({ fp: r.fp, cells: r.cells }));
        const tombExtras = Object.entries(state.tombstones)
            .filter(([fp, t]) => t.sheetUid === sheet.uid && !sheet.rows.some(r => r.fp === fp))
            .map(([fp, t]) => ({ fp, cells: t.cells, moot: true }));
        const deleted = [...delRows, ...tombExtras];
        return `
        <div class="pp-book" data-muid="${escapeHtml(sheet.uid)}">
            <div class="pp-item">
                <div class="pp-item-main"><b>${escapeHtml(sheet.name)}</b></div>
                <div class="pp-item-ops">
                    <span class="menu_button" data-mtoggle="${escapeHtml(sheet.uid)}">行 ${visibleRows.length}/${sheet.rows.length} <i class="fa-solid fa-chevron-${open ? 'down' : 'right'}"></i></span>
                    <label><input type="checkbox" data-mrecall="${escapeHtml(sheet.uid)}" ${recall.enabled === false ? '' : 'checked'} /> 参与召回</label>
                    ${sheet.enable === false ? '<span class="pp-muted">原表已停用</span>' : ''}
                </div>
            </div>
            <div class="pp-entries" ${open ? '' : 'hidden'}>
                <div class="pp-mem-cols">召回列：${sheet.columns.map((c, i) => `
                    <label><input type="checkbox" data-mcol="${i}" ${colOn(i) ? 'checked' : ''} /> ${escapeHtml(clamp(c, 10))}</label>`).join('')}
                </div>
                ${visibleRows.map(r => `
                <div class="pp-mem-row ${seen.has(r.fp) ? '' : 'pp-mem-new'}">
                    <input type="text" class="text_pole pp-mem-tags" data-mtags="${r.fp}" value="${escapeHtml((state.tags[r.fp] ?? []).join(','))}" placeholder="标签，逗号分隔" title="召回标签，如：战斗,背叛" />
                    <div class="pp-mem-cells" title="${escapeHtml(sheet.columns.map((c, i) => `${c}：${r.cells[i] ?? ''}`).join('\n'))}">
                        ${sheet.columns.map((c, i) => r.cells[i] ? `<span class="pp-mem-cell"><i>${escapeHtml(clamp(c, 8))}</i>${escapeHtml(clamp(r.cells[i], 50))}</span>` : '').join('')}
                    </div>
                    ${seen.has(r.fp) ? '' : '<span class="pp-mem-badge">新</span>'}
                    <span class="menu_button fa-solid fa-trash" data-mdel="${r.fp}" title="删除：内容不变就不再出现；原表那行被改动后会带「新」标重新出现"></span>
                </div>`).join('') || '<div class="pp-muted">没有可见行</div>'}
                ${deleted.length ? `
                <div class="pp-mem-delwrap">
                    <span class="menu_button" data-mshowdel="${escapeHtml(sheet.uid)}">已删除 ${deleted.length} 条 <i class="fa-solid fa-chevron-${openDeleted.has(sheet.uid) ? 'down' : 'right'}"></i></span>
                    ${openDeleted.has(sheet.uid) ? deleted.map(d => `
                    <div class="pp-mem-delrow" data-fp="${d.fp}">
                        <div class="pp-mem-cells pp-muted">${escapeHtml(clamp(d.cells.join(' ｜ '), 120))}</div>
                        <span class="pp-mem-ops">
                            ${d.moot ? '<span class="pp-muted">原表已无此行</span>' : `<span class="menu_button" data-mundel="${d.fp}">恢复显示</span>`}
                            <span class="menu_button" data-mpurge="${d.fp}" title="删掉这条删除记录">清除</span>
                        </span>
                    </div>`).join('') : ''}
                </div>` : ''}
            </div>
        </div>`;
    }).join('');

    // ---- 事件绑定 ----
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
        setRowTags(el.dataset.mtags, parseKeys(el.value));
        el.value = parseKeys(el.value).join(',');
        el.closest('.pp-mem-row')?.classList.remove('pp-mem-new');
        renderStatus(container);
        renderRecall(container);
    }));
    list.querySelectorAll('[data-mdel]').forEach(el => el.addEventListener('click', () => {
        const fp = el.dataset.mdel;
        const row = el.closest('.pp-mem-row');
        const cells = [...row.querySelectorAll('.pp-mem-cell')].map(c => c.textContent);
        const uid = el.closest('.pp-book').dataset.muid;
        const s = memoryState();
        const sheet = s.mirror.sheets.find(x => x.uid === uid);
        const target = sheet?.rows.find(r => r.fp === fp);
        deleteRow(fp, uid, target?.cells ?? cells);
        row.remove();
        renderStatus(container);
        toastr.info('已删除。内容不变就不会再出现；原表改动后会重新出现');
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
}
