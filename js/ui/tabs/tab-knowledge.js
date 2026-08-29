// 知识库页签（§6.9 落码）：自建素材清单的管理端。清单只喂剧情规划向导——抓取与发送在
// 剧情指导页第 1 步（清单勾选 + 「知识库抓取」悬浮面板），本页管清单与条目本身：
// 新建清单（自定义表头，导入时定死、永不做事后迁移——换表头＝新建清单重导，原始文本在手
// 重导即重建）、粘贴草稿→副 API 结构化→审后入库、条目浏览（紧凑一行一条＋搜索＋标签筛选）、
// 手动添加/编辑/删除、冷却账查看（选过的条目冷却期内抓取自动跳过）。
// 内容生产流程＝用户在外部用提示词批量起草 → 粘贴 → 模型照表头结构化 → 审后入库；
// 条目全局共享（不绑聊天不绑角色）。内嵌区互斥展开（条目区 / 导入区同时只开一个，E13 同款）。
// 搜索框放在刷新区外（完整提示词预览同款处理）：列表就地重画，输入不掉焦点不劈 IME。
// 2026-08-29 真机反馈五条 UI 修订：标题块移出灰底常驻显示（与清单行拉开区分度）、
// 「新建清单」置顶、清单行压成单行（展开箭头取代「条目」钮、「改名」与清单名同行、
// 「导入」入口从清单行撤下挪进展开后的条目区工具行）、条目列表自带滚动条（原地翻看）。
// 2026-08-29 真机反馈第二轮五条：展开区挪到自家清单行正下方（不再垫在所有行之后）、
// 手动加的条目插到列表最上面、「入库选中/丢弃草稿」上移到草稿页头部（删底部按钮行＝
// 两个「丢弃」删一）、导入草稿与粘贴原文随设置留底（刷新不丢，入库或丢弃才清）、
// 结构化导入长草稿自动分批＋解析报错带解析器原文（截断输出补闭合抢救前段）。
import { settings, save } from "../../settings.js";
import {
    knowledgeLists, findList, createList, renameList, deleteList,
    addEntries, deleteEntry, updateEntry, entryText, structureImport,
} from "../../knowledge.js";
import { escapeHtml } from "../../utils.js";

// 展开视图（互斥）：null 收起 | {type:'entries'|'import', listId}
let view = null;
// 条目区检索词 / 标签筛选（跟随当前展开的清单，切清单即清）
let query = '';
let tagFilter = null;
// 展开编辑中的条目 id（一行一开）
let editingEntryId = null;
// 改名中的清单 id（null = 无）
let renamingId = null;
// 结构化导入草稿与粘贴的原文（2026-08-29 真机反馈第二轮拍板保留：随设置留底、刷新不丢，
// 入库或丢弃草稿才清；收起/切换清单不再丢——原「瞬态刷新即弃」设计就此反转）
let draft = null;   // { listId, providerId, entries: [{ values, keep }] }
let rawText = '';
// 上次结构化导入用的供应商（会话内记住，跨刷新不存）
let lastProviderId = '';
// 留底层单槽（跟着最近一次导入走）：展开状态/草稿/原文一起存 settings.knowledge.ui
let uiRestored = false;
const persistUi = () => {
    settings.knowledge.ui = { view, draft, raw: rawText };
    save();
};

// 标签字段：表头里名字含「标签」的第一个字段（没有就不显示标签筛选）
function tagFieldOf(list) {
    return list.fields.find(f => f.includes('标签')) ?? null;
}

// 某字段的标签词拆分（模型按约定用中文顿号分隔；容忍逗号/空格）
function tagTokens(v) {
    return String(v ?? '').split(/[、,，\s]+/).map(t => t.trim()).filter(Boolean);
}

// 清单行（单行紧凑）：展开箭头 + 名字（+改名同行）+ 条目数/表头（省略号，全文在悬浮说明）+ 删。
// 点行或箭头展开/收起条目（2026-08-29 真机反馈：原「条目/导入/改名」三钮把行撑成两三行，压回一行）
function listRowHtml(list) {
    const cooling = list.entries.filter(e => Number(e.cooldown) > 0).length;
    const open = view?.listId === list.id;   // 条目区/导入区任一展开都算开（箭头朝下）
    const meta = `${list.entries.length} 条${cooling ? ` · ${cooling} 条冷却中` : ''} · 表头：${list.fields.join('、')}`;
    return `
    <div class="pp-item pp-kb-lrow" data-klist="${escapeHtml(list.id)}" title="点这一行展开/收起条目">
        <span class="menu_button pp-kb-chev fa-solid ${open ? 'fa-chevron-down' : 'fa-chevron-right'}" data-ktoggle="${escapeHtml(list.id)}" title="展开/收起条目"></span>
        <div class="pp-item-main">
            ${renamingId === list.id
                ? `<input type="text" class="text_pole" data-krename="${escapeHtml(list.id)}" value="${escapeHtml(list.name)}" title="回车确认，Esc 取消" style="flex:1 1 auto; min-width:0" />`
                : `<span class="pp-item-title" title="${escapeHtml(list.name)}">${escapeHtml(list.name)}</span>
                   <span class="pp-kb-lmeta pp-muted" title="${escapeHtml(meta)}">${escapeHtml(meta)}</span>`}
        </div>
        <div class="pp-item-ops">
            <span class="menu_button" data-krenamebtn="${escapeHtml(list.id)}" title="给这张清单改名">改名</span>
            <span class="menu_button fa-solid fa-trash" data-kdel="${escapeHtml(list.id)}" title="删除整张清单（条目与冷却账一并删除；原始文本在手可重导）"></span>
        </div>
    </div>`;
}

// 条目一行（紧凑）：编号 + 各字段值一行；冷却/用过徽章；点行展开字段编辑
function entryRowHtml(list, entry) {
    const editing = editingEntryId === entry.id;
    const cool = Number(entry.cooldown) > 0;
    return `
    <div class="pp-kb-erow" data-kentry="${escapeHtml(entry.id)}" title="点开编辑各字段">
        <span class="pp-muted pp-kb-ecode">${escapeHtml(entry.code)}</span>
        <span class="pp-kb-ebody">${escapeHtml(entryText(list, entry) || '（空条目，点开填写）')}</span>
        ${cool ? `<span class="pp-badge" title="选用后进冷却：接下来若干次知识库生成里抓取自动跳过（按生成次数计，次数在「设置 → 知识库」）">冷却 ${Number(entry.cooldown)}</span>` : ''}
        ${Number(entry.used) > 0 ? `<span class="pp-muted" title="规划生成累计选用次数">用过 ${Number(entry.used)} 次</span>` : ''}
        <span class="menu_button fa-solid fa-trash" data-kedel="${escapeHtml(entry.id)}" title="删除这条条目"></span>
    </div>
    ${editing ? `
    <div class="pp-gd-editor">
        ${list.fields.map(f => `
        <label class="pp-label">${escapeHtml(f)}</label>
        <input type="text" class="text_pole textarea_compact" data-kfield="${escapeHtml(f)}" value="${escapeHtml(entry.values[f] ?? '')}" />`).join('')}
    </div>` : ''}`;
}

// 刷新区（搜索框之外的全部）：标签筛选 chips + 条目行 + 计数。搜索框在区外，输入不掉焦点
function entriesListHtml(list) {
    const tagField = tagFieldOf(list);
    let entries = list.entries;
    if (tagFilter !== null && tagField) {
        entries = entries.filter(e => tagTokens(e.values[tagField]).includes(tagFilter));
    }
    if (query.trim()) {
        const q = query.trim().toLowerCase();
        entries = entries.filter(e => e.code.toLowerCase().includes(q)
            || list.fields.some(f => String(e.values[f] ?? '').toLowerCase().includes(q)));
    }
    let chips = '';
    if (tagField) {
        const counts = new Map();
        for (const e of list.entries) for (const t of tagTokens(e.values[tagField])) counts.set(t, (counts.get(t) ?? 0) + 1);
        const tags = [...counts.entries()].sort((a, b) => b[1] - a[1]);
        chips = tags.length ? `
        <div class="pp-gd-selp">
            <label class="pp-mem-chip" title="不看标签，列出全部条目"><input type="radio" name="pp_kb_tag" data-ktag="" ${tagFilter === null ? 'checked' : ''}/> 全部</label>
            ${tags.map(([t, n]) => `<label class="pp-mem-chip"><input type="radio" name="pp_kb_tag" data-ktag="${escapeHtml(t)}" ${tagFilter === t ? 'checked' : ''}/> ${escapeHtml(t)} (${n})</label>`).join('')}
        </div>` : `<div class="pp-muted" title="标签筛选认表头里名字含「标签」的字段；这张清单的表头没有">（表头没有标签类字段，无标签筛选）</div>`;
    }
    return `
    ${chips}
    <div class="pp-kb-list">
        ${entries.map(e => entryRowHtml(list, e)).join('') || '<div class="pp-muted">没有命中筛选的条目</div>'}
    </div>
    ${entries.length !== list.entries.length ? `<div class="pp-muted">列出 ${entries.length}/${list.entries.length} 条</div>` : ''}`;
}

// 导入区：供应商单次选用 + 粘贴框 + 结构化 → 草稿（逐条审改、勾选入库）。
// 操作钮在草稿页头部不入底部（2026-08-29 真机反馈：保存不该翻到内容最下面；
// 底部那颗重复的「丢弃草稿」已删）。粘贴的原文随设置留底，刷新不丢
function importHtml(list) {
    const profs = settings.api.profiles ?? [];
    if (!draft || draft.listId !== list.id) {
        return `
        <div class="pp-kb-import">
            <div class="pp-kb-toolrow">
                <select id="pp_kb_prov" class="text_pole" title="结构化调用走哪个连接：主连接或供应商方案（单次选用，不影响当前正在使用的模型）">
                    <option value="">主连接</option>
                    ${profs.map(p => `<option value="${escapeHtml(p.id)}" ${lastProviderId === p.id ? 'selected' : ''}>${escapeHtml(p.name)} · ${escapeHtml(p.model ?? '')}</option>`).join('')}
                </select>
                <span class="menu_button" id="pp_kb_struct" title="把粘贴的原始草稿交给模型，照这张清单的表头（${escapeHtml(list.fields.join('、'))}）整理成条目草稿；草稿逐条审改后才入库，本步不产生入库数据。长草稿自动分批整理（一批一次调用），全部批失败才算失败">结构化导入</span>
            </div>
            <textarea id="pp_kb_raw" class="text_pole textarea_compact" rows="8" placeholder="把在外部批量起草的原始文本整段粘到这里（格式不限：列表、分段、表格都行）">${escapeHtml(rawText)}</textarea>
            <div class="pp-muted">流程：外部起草 → 粘贴 → 模型照表头结构化 → 审后入库。粘贴的原文与结构化草稿都随页面保留（刷新不丢），入库或丢弃才清；表头定死永不迁移，换表头＝新建清单重导</div>
        </div>`;
    }
    const kept = draft.entries.filter(d => d.keep).length;
    return `
    <div class="pp-kb-import">
        <div class="pp-gd-ughead">
            <label class="pp-label">结构化草稿（${draft.entries.length} 条，勾选 ${kept} 条）——审改字段后入库</label>
            <span class="menu_button" id="pp_kb_commit" title="把勾选的草稿条目收进这张清单（接在条目列表末尾）">入库选中 ${kept} 条</span>
            <span class="menu_button" data-kdiscard="1" title="丢掉整批结构化草稿（还没有任何条目入库）；粘贴的原文保留，可改完重新结构化">丢弃草稿</span>
        </div>
        ${draft.entries.map((d, i) => `
        <div class="pp-kb-drow">
            <label title="勾选的才入库"><input type="checkbox" data-dkeep="${i}" ${d.keep ? 'checked' : ''} /></label>
            ${list.fields.map(f => `<input type="text" class="text_pole textarea_compact" data-dfield="${i}|${escapeHtml(f)}" value="${escapeHtml(d.values[f] ?? '')}" title="${escapeHtml(f)}" placeholder="${escapeHtml(f)}" />`).join('')}
            <span class="menu_button fa-solid fa-trash" data-ddel="${i}" title="从草稿里删掉这一条"></span>
        </div>`).join('')}
    </div>`;
}

export const knowledgeTab = {
    id: 'knowledge',
    title: '知识库',
    render(container) {
        const lists = knowledgeLists();
        // 留底层恢复（只在首次渲染做一次）：展开状态/草稿/原文随设置存，刷新不丢
        if (!uiRestored) {
            uiRestored = true;
            const ui = settings.knowledge?.ui;
            if (ui?.view && lists.some(l => l.id === ui.view.listId)) view = ui.view;
            if (ui?.draft && lists.some(l => l.id === ui.draft.listId)) draft = ui.draft;
            if (typeof ui?.raw === 'string') rawText = ui.raw;
        }
        // 视图指向的清单可能已被删掉：当收起处理
        if (view && !lists.some(l => l.id === view.listId)) view = null;
        const viewList = view ? findList(view.listId) : null;
        // 展开区跟在自家清单行正下方（2026-08-29 真机反馈第二轮：原来垫在所有行之后，
        // 加条目/入库都得翻到页底）——点哪行就地在哪行下面展开
        const panelHtml = viewList ? (view.type === 'entries' ? `
            <div class="pp-kb-entries">
                <div class="pp-kb-toolrow">
                    <input type="text" id="pp_kb_query" class="text_pole textarea_compact" placeholder="搜索编号或任意字段内容…" value="${escapeHtml(query)}" style="flex:1 1 auto" />
                    <span class="menu_button" id="pp_kb_add" title="手动添加一条空条目，插到条目列表最上面（展开填写各字段）"><i class="fa-solid fa-plus"></i> 添加条目</span>
                    <span class="menu_button" id="pp_kb_import" title="粘贴外部起草的原始文本，模型照表头（${escapeHtml(viewList.fields.join('、'))}）结构化成条目草稿，审后入库">导入</span>
                </div>
                <div id="pp_kb_elist">${entriesListHtml(viewList)}</div>
            </div>` : importHtml(viewList)) : '';
        container.innerHTML = `
        <div class="pp-kb-head" title="知识库＝反模型偏好的候选池：模型在「约会去哪、消费什么」这类选择上换模型重 roll 也只在几个常见选项里打转，清单把候选集合整个换掉。清单只喂剧情规划向导（剧情指导页第 1 步勾清单→「知识库抓取」抓一小把随材料发送→选用过的条目自动进冷却）；随机事件、路人反应与扮演模型注入不碰知识库">
            <b>素材清单</b><span class="pp-muted">${lists.length ? `${lists.length} 张清单 · 共 ${lists.reduce((n, l) => n + l.entries.length, 0)} 条` : '还没有清单，先在下面新建一张'}</span>
        </div>
        <div class="pp-section">
            <div class="pp-kb-toolrow">
                <input type="text" id="pp_kb_newname" class="text_pole textarea_compact" placeholder="新清单名，如：约会地点" style="flex:1 1 140px" />
                <input type="text" id="pp_kb_newfields" class="text_pole textarea_compact" placeholder="表头字段，顿号分隔，如：名字、说明、标签" style="flex:2 1 260px" title="每张清单自定义表头（字段名任意定）——新建后定死、永不迁移；模型结构化导入时照它填，抓取按条抓" />
                <span class="menu_button" id="pp_kb_newcreate" title="建一张空清单，随后在展开区的「导入」里粘贴草稿结构化，或手动添加条目"><i class="fa-solid fa-plus"></i> 新建清单</span>
            </div>
            ${lists.map(list => listRowHtml(list) + (viewList?.id === list.id ? panelHtml : '')).join('')}
        </div>`;
        this.wire(container);
    },
    wire(container) {
        const rerender = () => { this.render(container); };
        // 收起只收视图：草稿与原文留底保留（2026-08-29 真机反馈第二轮），丢弃只走「丢弃草稿」
        const closeView = () => { view = null; editingEntryId = null; query = ''; tagFilter = null; persistUi(); };

        // 展开/收起：点清单行或箭头开条目区（再点收起）；草稿跟着自己的清单走，切清单不丢
        const openEntries = id => {
            view = { type: 'entries', listId: id };
            editingEntryId = null; query = ''; tagFilter = null;
            persistUi();
            rerender();
        };
        container.querySelectorAll('[data-klist]').forEach(row => row.addEventListener('click', e => {
            if (e.target.closest('input, .menu_button')) return;   // 改名框/按钮各走各的
            openEntries(row.dataset.klist);
        }));
        container.querySelectorAll('[data-ktoggle]').forEach(btn => btn.addEventListener('click', () => {
            const id = btn.dataset.ktoggle;
            if (view?.type === 'entries' && view.listId === id) { closeView(); rerender(); return; }
            openEntries(id);
        }));
        // 「导入」入口在条目区工具行（2026-08-29 从清单行撤下挪进来）：切到这张清单的导入区
        container.querySelector('#pp_kb_import')?.addEventListener('click', () => {
            if (!view || view.type !== 'entries') return;
            view = { type: 'import', listId: view.listId };
            editingEntryId = null;
            persistUi();
            rerender();
        });
        container.querySelectorAll('[data-kdel]').forEach(btn => btn.addEventListener('click', () => {
            const list = findList(btn.dataset.kdel);
            if (!list) return;
            if (!confirm(`删除清单「${list.name}」？条目（${list.entries.length} 条）与冷却账一并删除，不可恢复。`)) return;
            deleteList(list.id);
            if (view?.listId === list.id) view = null;
            if (draft?.listId === list.id) draft = null;   // 它的草稿一并清，别在留底层当孤儿
            persistUi();
            rerender();
            toastr.success(`已删除清单「${list.name}」`);
        }));
        container.querySelectorAll('[data-krenamebtn]').forEach(btn => btn.addEventListener('click', () => {
            renamingId = renamingId === btn.dataset.krenamebtn ? null : btn.dataset.krenamebtn;
            rerender();
            container.querySelector('[data-krename]')?.focus();
        }));
        const renameEl = container.querySelector('[data-krename]');
        renameEl?.addEventListener('change', () => {
            const id = renameEl.dataset.krename;
            const nn = renameEl.value.trim().slice(0, 30);
            if (!nn) toastr.warning('清单名不能为空');
            else if (knowledgeLists().some(l => l.id !== id && l.name === nn)) toastr.warning(`已有同名清单「${nn}」`);
            else renameList(id, nn);
            renamingId = null;
            rerender();
        });
        renameEl?.addEventListener('keydown', e => {
            if (e.key === 'Enter') renameEl.blur();
            if (e.key === 'Escape') { renamingId = null; rerender(); }
        });

        // 新建清单：名字 + 表头（顿号/逗号分隔）
        container.querySelector('#pp_kb_newcreate').addEventListener('click', () => {
            const name = container.querySelector('#pp_kb_newname').value;
            const fields = container.querySelector('#pp_kb_newfields').value.split(/[、,，]/);
            try {
                const list = createList(name, fields);
                container.querySelector('#pp_kb_newname').value = '';
                container.querySelector('#pp_kb_newfields').value = '';
                view = { type: 'import', listId: list.id };   // 新建后直接进导入区
                query = ''; tagFilter = null; editingEntryId = null;
                persistUi();
                rerender();
                toastr.success(`清单「${list.name}」已建好（表头：${list.fields.join('、')}）——粘贴草稿开始导入`);
            } catch (err) {
                toastr.warning(String(err.message ?? err));
            }
        });

        const viewList = view ? findList(view.listId) : null;
        if (view?.type === 'entries' && viewList) this.wireEntries(container, viewList, rerender);
        if (view?.type === 'import' && viewList) this.wireImport(container, viewList, rerender);
    },
    // 条目区接线：搜索就地刷新列表（输入框在刷新区外不掉焦点）/ 标签筛选 / 行展开编辑 / 删除 / 手动添加
    wireEntries(container, list, rerender) {
        const elist = container.querySelector('#pp_kb_elist');
        const refreshList = () => {
            if (!elist) { rerender(); return; }
            elist.innerHTML = entriesListHtml(list);
            wireRows();
        };
        const wireRows = () => {
            elist.querySelectorAll('[data-ktag]').forEach(r => r.addEventListener('change', () => {
                tagFilter = r.dataset.ktag === '' ? null : r.dataset.ktag;
                refreshList();
            }));
            elist.querySelectorAll('[data-kentry]').forEach(row => row.addEventListener('click', e => {
                if (e.target.closest('input, textarea, select, [data-kedel]')) return;
                editingEntryId = editingEntryId === row.dataset.kentry ? null : row.dataset.kentry;
                refreshList();
            }));
            elist.querySelectorAll('[data-kedel]').forEach(btn => btn.addEventListener('click', () => {
                deleteEntry(list.id, btn.dataset.kedel);
                if (editingEntryId === btn.dataset.kedel) editingEntryId = null;
                refreshList();
                rerender();   // 头行的条目计数也要跟
            }));
            // 字段编辑即时保存，不重渲染（避免打断输入）
            elist.querySelectorAll('[data-kfield]').forEach(inp => inp.addEventListener('input', () => {
                const entry = list.entries.find(x => x.id === editingEntryId);
                if (!entry) return;
                entry.values[inp.dataset.kfield] = inp.value;
                updateEntry(list.id, entry.id, entry.values);
            }));
        };
        const qEl = container.querySelector('#pp_kb_query');
        qEl?.addEventListener('input', () => { query = qEl.value; refreshList(); });
        container.querySelector('#pp_kb_add')?.addEventListener('click', () => {
            // 插到列表最上面（2026-08-29 真机反馈第二轮：百来条的清单加一条不该翻到底），
            // 重渲染后新编辑框就在工具行正下方，不用滚
            addEntries(list.id, [{}], { prepend: true });
            editingEntryId = list.entries[0].id;
            rerender();
        });
        wireRows();
    },
    // 导入区接线：结构化调用（长草稿自动分批、失败批不拖垮其余）→ 草稿审改 → 入库
    wireImport(container, list, rerender) {
        const provSel = container.querySelector('#pp_kb_prov');
        const structBtn = container.querySelector('#pp_kb_struct');
        const rawEl = container.querySelector('#pp_kb_raw');
        // 粘贴的原文随输入留底（save 已防抖，逐键写不伤性能）
        rawEl?.addEventListener('input', () => { rawText = rawEl.value; persistUi(); });
        if (structBtn) structBtn.addEventListener('click', async () => {
            const raw = rawEl.value;
            if (!String(raw).trim()) { toastr.warning('请先把原始草稿粘进来'); return; }
            const pid = provSel.value;
            lastProviderId = pid;
            const prof = (settings.api.profiles ?? []).find(p => p.id === pid);
            structBtn.classList.add('disabled');
            try {
                const { values, failed } = await structureImport({
                    list,
                    rawText: raw,
                    provider: prof ? { baseUrl: prof.baseUrl, apiKey: prof.apiKey, model: prof.model } : undefined,
                    onProgress: (i, n) => { structBtn.textContent = n > 1 ? `结构化中…第 ${i}/${n} 批` : '结构化中……'; },
                });
                draft = { listId: list.id, providerId: pid, entries: values.map(v => ({ values: v, keep: true })) };
                persistUi();
                rerender();
                if (failed.length) {
                    toastr.warning(`${failed.length} 批没整理成功（其中一批开头：「${failed[0].head}」…）——其余 ${values.length} 条已进草稿；没成的那段可单独粘回来重试`);
                } else {
                    toastr.success(`模型整理出 ${values.length} 条草稿——审改后点「入库选中」`);
                }
            } catch (err) {
                toastr.error(String(err.message ?? err));
            } finally {
                structBtn.classList.remove('disabled');
                structBtn.textContent = '结构化导入';
            }
        });
        if (!draft || draft.listId !== list.id) return;
        // 草稿审改：勾选/字段即时回存草稿、逐条删、整批弃、入库（全部随留底层刷新不丢）
        container.querySelectorAll('[data-dkeep]').forEach(cb => cb.addEventListener('change', () => {
            draft.entries[Number(cb.dataset.dkeep)].keep = cb.checked;
            persistUi();
            rerender();
        }));
        container.querySelectorAll('[data-dfield]').forEach(inp => inp.addEventListener('input', () => {
            const [i, f] = inp.dataset.dfield.split('|');
            draft.entries[Number(i)].values[f] = inp.value;
            persistUi();
        }));
        container.querySelectorAll('[data-ddel]').forEach(btn => btn.addEventListener('click', () => {
            draft.entries.splice(Number(btn.dataset.ddel), 1);
            persistUi();
            rerender();
        }));
        container.querySelectorAll('[data-kdiscard]').forEach(btn => btn.addEventListener('click', () => {
            draft = null;   // 只丢结构化草稿；粘贴的原文留着，可改完重新结构化
            persistUi();
            rerender();
        }));
        container.querySelector('#pp_kb_commit')?.addEventListener('click', () => {
            const picked = draft.entries.filter(d => d.keep).map(d => d.values);
            if (!picked.length) { toastr.warning('没有勾选任何草稿条目'); return; }
            const n = addEntries(list.id, picked);
            draft = null;
            rawText = '';   // 入库即收工：原文一并清空，下次导入从干净状态开始
            view = { type: 'entries', listId: list.id };
            editingEntryId = null; query = ''; tagFilter = null;
            persistUi();
            rerender();
            toastr.success(`已入库 ${n} 条（冷却从 0 起，抓取即可选中）`);
        });
    },
};
