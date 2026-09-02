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
    knowledgeLists, findList, createList, renameList, deleteList, setListFeed,
    addEntries, deleteEntry, updateEntry, entryText, structureImport, clearCooldown,
    isOutfitList, listVisibleInChat, outfitListsBoundElsewhere, setListOutfit, setListBind, updateListBind,
} from "../../knowledge.js";
import { resolveLorePicks } from "../../lorebook.js";
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
// 新建清单表单折叠态（第八轮真机反馈：表单常驻太占地方）——默认收起，点「新建清单」才展开；
// 投喂方式的选择随会话记住（收起再展开不用重选），创建成功后自动收起（新建的清单已展开导入区）
let newListOpen = false;
let newFeed = 'sample';
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
    const feedName = list.feed === 'full' ? '全量' : '抽样';
    const outfitMeta = isOutfitList(list) ? ` · 装扮（${list.bind ? '绑定' : '衣库·全局'}）` : '';
    const meta = `${list.entries.length} 条${cooling ? ` · ${cooling} 条冷却中` : ''} · ${feedName}${outfitMeta} · 表头：${list.fields.join('、')}`;
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
        ${cool ? `<span class="pp-badge" data-kclear="${escapeHtml(entry.id)}" title="选用后进冷却：接下来若干次采用里抓取自动跳过（次数在「设置 → 知识库」）。点一下＝立即清零，这条马上可以再被抓——你判断它该再用就点（冷却记在确认采用时，放弃草稿不记）">冷却 ${Number(entry.cooldown)} ✕</span>` : ''}
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

// 装扮用途与绑定⇄衣库（2026-09-02）：清单展开的条目区里配置。标记开着才显示绑定段；
// 绑定段左右按键两态（用户点名不要打钩式）——「衣库」全局跟随、「绑定」只与本聊天走，
// 绑定时选世界书条目（轻量选择的对照材料）与处理模型
function outfitCfgHtml(list) {
    if (!isOutfitList(list)) return `
    <div class="pp-kb-toolrow">
        <span class="pp-seg" data-koutfit="${escapeHtml(list.id)}" title="给这张清单打「装扮」标记：标记后它不再出现在剧情规划第 1 步与长线页的知识库勾选里（也不结冷却），只喂剧情指导页第 1 步的「装扮」悬浮面板（角色衣橱清单）">
            <span class="pp-seg-opt on">普通清单</span>
            <span class="pp-seg-opt" data-koutfit-on="1">装扮清单</span>
        </span>
    </div>`;
    const bind = list.bind;
    const profs = settings.api.profiles ?? [];
    const picked = bind ? resolveLorePicks(bind.picks ?? []) : [];
    return `
    <div class="pp-kb-toolrow">
        <span class="pp-seg" data-koutfit="${escapeHtml(list.id)}" title="「装扮」标记：关掉后绑定配置一并清除（暂存的世界书勾选与模型会留着，再开绑定时恢复）">
            <span class="pp-seg-opt">普通清单</span>
            <span class="pp-seg-opt on" data-koutfit-on="1">装扮清单</span>
        </span>
        <span class="pp-seg" data-kbind="${escapeHtml(list.id)}" title="左右按键两态（不是打钩）：「衣库」＝全局清单，跟随到所有聊天；「绑定」＝只与当前聊天走——其他聊天里整张清单不出现（在知识库页底部的收纳区可见、可转回衣库）。来回切换保留各自配置">
            <span class="pp-seg-opt${bind ? '' : ' on'}" data-kbind-set="shelf">衣库</span>
            <span class="pp-seg-opt${bind ? ' on' : ''}" data-kbind-set="bind">绑定本聊天</span>
        </span>
        ${bind ? `
        <select class="text_pole" data-kbprov="${escapeHtml(list.id)}" title="这张清单的轻量选择（装扮生成）走哪个连接：主连接或供应商方案；「默认」＝方案库第一条">
            <option value="" ${!bind.providerId ? 'selected' : ''}>默认（方案库第一条）</option>
            <option value="__main__" ${bind.providerId === '__main__' ? 'selected' : ''}>主连接</option>
            ${profs.map(p => `<option value="${escapeHtml(p.id)}" ${bind.providerId === p.id ? 'selected' : ''}>${escapeHtml(p.name)} · ${escapeHtml(p.model ?? '')}</option>`).join('')}
        </select>` : ''}
    </div>
    ${bind ? `
    <details class="pp-fold" data-kbwb="${escapeHtml(list.id)}">
        <summary title="绑定的世界书条目＝这张清单跑「模型生成」时的对照材料（角色与场合设定，整条原文随轻量选择发送）；只在这张清单绑定本聊天时随行">绑定世界书条目（已勾 ${picked.length} 条）</summary>
        <div class="pp-gd-selp">${outfitWbPickHtml(list)}</div>
    </details>
    <div class="pp-muted" title="绑定后这张清单只在本聊天出现；聊天删了也不丢——知识库页底部的「绑定在其他聊天的装扮清单」收纳区任何时候都能看到它、一键转回衣库">已绑定当前聊天（${escapeHtml(String(bind.chatId ?? '').slice(-8))}）；换聊天这里不出现，去页底收纳区转回衣库</div>` : ''}`;
}

// 绑定的世界书条目勾选（照监听页世界书自选的行样式，内联不另开窗）：按书折叠勾条目
function outfitWbPickHtml(list) {
    const books = settings.lorebooks ?? [];
    if (!books.length) return '<div class="pp-muted">还没有世界书——在设置页「世界书库」区导入后再来勾</div>';
    const sel = new Set(list.bind?.picks ?? []);
    return books.map(book => {
        const onN = book.entries.filter(e => sel.has(`${book.id}:${e.uid}`)).length;
        return `
        <label class="pp-mem-chip" title="整本书一起勾/清"><input type="checkbox" data-kbwbbook="${escapeHtml(list.id)}|${escapeHtml(book.id)}" ${onN > 0 && onN === book.entries.length ? 'checked' : ''} /> ${escapeHtml(book.name)}（${onN}/${book.entries.length}）</label>
        ${book.entries.map(e => {
            const key = `${book.id}:${e.uid}`;
            return `<label class="pp-mem-chip"><input type="checkbox" data-kbwbe="${escapeHtml(list.id)}|${escapeHtml(key)}" ${sel.has(key) ? 'checked' : ''} /> ${escapeHtml(e.comment ?? `条目 ${e.uid + 1}`)}</label>`;
        }).join('')}`;
    }).join(' ');
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
        // 视图指向的清单可能已被删掉：当收起处理；绑定到其他聊天的装扮清单在本页不可见，同样收起
        if (view && !lists.some(l => l.id === view.listId)) view = null;
        let viewList = view ? findList(view.listId) : null;
        if (viewList && !listVisibleInChat(viewList)) { view = null; viewList = null; }
        // 展开区跟在自家清单行正下方（2026-08-29 真机反馈第二轮：原来垫在所有行之后，
        // 加条目/入库都得翻到页底）——点哪行就地在哪行下面展开
        const panelHtml = viewList ? (view.type === 'entries' ? `
            <div class="pp-kb-entries">
                <div class="pp-kb-toolrow">
                    <input type="text" id="pp_kb_query" class="text_pole textarea_compact" placeholder="搜索编号或任意字段内容…" value="${escapeHtml(query)}" style="flex:1 1 auto" />
                    <span class="pp-seg" id="pp_kb_feed" title="这张清单怎么随规划发送（建好后随时可改）：抽样＝「知识库抓取」按轮换抓一小把让模型挑（一轮内不重复）；全量＝整表条目全部随分析发给模型挑、挑中的进冷却（冷却中的跳过）——礼物这类「整张候选表都该在场」的清单用全量">
                        <span class="pp-seg-opt${viewList.feed === 'full' ? '' : ' on'}" data-kfeed="sample">抽样</span>
                        <span class="pp-seg-opt${viewList.feed === 'full' ? ' on' : ''}" data-kfeed="full">全量</span>
                    </span>
                    <span class="menu_button" id="pp_kb_add" title="手动添加一条空条目，插到条目列表最上面（展开填写各字段）"><i class="fa-solid fa-plus"></i> 添加条目</span>
                    <span class="menu_button" id="pp_kb_import" title="粘贴外部起草的原始文本，模型照表头（${escapeHtml(viewList.fields.join('、'))}）结构化成条目草稿，审后入库">导入</span>
                </div>
                ${outfitCfgHtml(viewList)}
                <div id="pp_kb_elist">${entriesListHtml(viewList)}</div>
            </div>` : importHtml(viewList)) : '';
        container.innerHTML = `
        <div class="pp-kb-head" title="知识库＝反模型偏好的候选池：模型在「约会去哪、消费什么」这类选择上换模型重 roll 也只在几个常见选项里打转，清单把候选集合整个换掉。清单只喂剧情规划向导（剧情指导页第 1 步勾清单→「知识库抓取」抓一小把随材料发送→选用过的条目自动进冷却）；随机事件、路人反应与扮演模型注入不碰知识库">
            <b>素材清单</b><span class="pp-muted">${lists.length ? `${lists.length} 张清单 · 共 ${lists.reduce((n, l) => n + l.entries.length, 0)} 条` : '还没有清单，先在下面新建一张'}</span>
        </div>
        <div class="pp-section">
            <div class="pp-kb-toolrow">
                <span class="menu_button" id="pp_kb_newtoggle" title="新建一张清单：名字 + 自定义表头 + 投喂方式（建好后随时在清单展开区改投喂方式；表头新建后定死、永不迁移）"><i class="fa-solid fa-plus"></i> 新建清单 <i class="fa-solid fa-chevron-${newListOpen ? 'down' : 'right'}"></i></span>
            </div>
            <div id="pp_kb_newwrap" ${newListOpen ? '' : 'hidden'}>
                <div class="pp-kb-toolrow">
                    <input type="text" id="pp_kb_newname" class="text_pole textarea_compact" placeholder="新清单名，如：约会地点" style="flex:1 1 140px" />
                    <input type="text" id="pp_kb_newfields" class="text_pole textarea_compact" placeholder="表头字段，顿号分隔，如：名字、说明、标签" style="flex:2 1 260px" title="每张清单自定义表头（字段名任意定）——新建后定死、永不迁移；模型结构化导入时照它填，抓取按条抓" />
                    <span class="pp-seg" id="pp_kb_newfeed" title="投喂方式（建好后随时在清单展开区改）：抽样＝规划时按轮换抓一小把让模型挑；全量＝整表条目全部发给模型挑、挑中的进冷却——礼物这类清单用全量">
                        <span class="pp-seg-opt${newFeed === 'sample' ? ' on' : ''}" data-newfeed="sample">抽样</span>
                        <span class="pp-seg-opt${newFeed === 'full' ? ' on' : ''}" data-newfeed="full">全量</span>
                    </span>
                    <span class="menu_button" id="pp_kb_newcreate" title="建一张空清单，随后在展开区的「导入」里粘贴草稿结构化，或手动添加条目">创建</span>
                </div>
            </div>
            ${lists.filter(listVisibleInChat).map(list => listRowHtml(list) + (viewList?.id === list.id ? panelHtml : '')).join('')}
        </div>
        ${outfitListsBoundElsewhere().length ? `
        <div class="pp-section">
            <b title="这些装扮清单绑定在其他聊天（或绑定的聊天已删）：本页与装扮面板都不出现，只在这里收着——点「转为衣库」恢复全局可见（绑定配置暂存，再绑定时恢复）">绑定在其他聊天的装扮清单</b>
            ${outfitListsBoundElsewhere().map(l => `
            <div class="pp-kb-erow">
                <span class="pp-kb-ebody">${escapeHtml(l.name)}（${l.entries.length} 条 · 绑定聊天 ${escapeHtml(String(l.bind?.chatId ?? '').slice(-8))}）</span>
                <span class="menu_button" data-kshelf="${escapeHtml(l.id)}" title="解除绑定、转为全局衣库清单（在所有聊天可见；原来的世界书勾选与模型暂存，再绑定时恢复）">转为衣库</span>
            </div>`).join('')}
        </div>` : ''}`;
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

        // 新建清单（第八轮折叠）：点「新建清单」才展开表单；名字 + 表头（顿号/逗号分隔）+
        // 投喂方式（第七轮：抽样/全量二选一，建好可改；选择随会话记住，收起再展不用重选）
        container.querySelector('#pp_kb_newtoggle').addEventListener('click', () => {
            newListOpen = !newListOpen;
            rerender();
        });
        const newFeedSeg = container.querySelector('#pp_kb_newfeed');
        newFeedSeg?.querySelectorAll('.pp-seg-opt').forEach(opt => opt.addEventListener('click', () => {
            newFeed = opt.dataset.newfeed;
            newFeedSeg.querySelectorAll('.pp-seg-opt').forEach(o => o.classList.toggle('on', o === opt));
        }));
        container.querySelector('#pp_kb_newcreate').addEventListener('click', () => {
            const name = container.querySelector('#pp_kb_newname').value;
            const fields = container.querySelector('#pp_kb_newfields').value.split(/[、,，]/);
            try {
                const list = createList(name, fields, { feed: newFeed });
                container.querySelector('#pp_kb_newname').value = '';
                container.querySelector('#pp_kb_newfields').value = '';
                newListOpen = false;   // 创建成功即收起（新建的清单已自动展开导入区，表单用完了）
                view = { type: 'import', listId: list.id };   // 新建后直接进导入区
                query = ''; tagFilter = null; editingEntryId = null;
                persistUi();
                rerender();
                toastr.success(`清单「${list.name}」已建好（${list.feed === 'full' ? '全量' : '抽样'} · 表头：${list.fields.join('、')}）——粘贴草稿开始导入`);
            } catch (err) {
                toastr.warning(String(err.message ?? err));   // 建失败（空名/重名）：表单保持展开改了再建
            }
        });

        const viewList = view ? findList(view.listId) : null;
        if (view?.type === 'entries' && viewList) this.wireEntries(container, viewList, rerender);
        if (view?.type === 'import' && viewList) this.wireImport(container, viewList, rerender);
    },
    // 条目区接线：搜索就地刷新列表（输入框在刷新区外不掉焦点）/ 标签筛选 / 行展开编辑 / 删除 / 手动添加 / 投喂方式切换
    wireEntries(container, list, rerender) {
        const elist = container.querySelector('#pp_kb_elist');
        // 投喂方式切换（第七轮）：抽样/全量二段钮，点一下即改即存
        const feedSeg = container.querySelector('#pp_kb_feed');
        feedSeg?.querySelectorAll('.pp-seg-opt').forEach(opt => opt.addEventListener('click', () => {
            const next = opt.dataset.kfeed;
            if (list.feed === next) return;
            setListFeed(list.id, next);
            rerender();
            toastr.info(next === 'full'
                ? `「${list.name}」改为全量：整表条目全部随分析发给模型挑（冷却中的自动跳过），不再抓取/重抓、不占轮换队列`
                : `「${list.name}」改为抽样：规划时在「知识库抓取」面板按轮换抓一小把`);
        }));
        // 装扮标记与绑定⇄衣库（2026-09-02）：左右按键两态，点一下即改即存
        container.querySelectorAll('[data-koutfit]').forEach(seg => seg.querySelectorAll('.pp-seg-opt').forEach(opt => opt.addEventListener('click', () => {
            const id = seg.dataset.koutfit;
            const on = Boolean(opt.dataset.koutfitOn);
            const l = findList(id);
            if (isOutfitList(l) === on) return;
            setListOutfit(id, on);
            rerender();
            toastr.info(on
                ? `「${l.name}」已标记为装扮清单：从剧情规划第 1 步与长线页的知识库勾选里退出（不结冷却），只喂剧情指导页第 1 步「装扮」面板`
                : `「${l.name}」恢复为普通清单（绑定配置已暂存，再开标记时恢复）`);
        })));
        container.querySelectorAll('[data-kbind]').forEach(seg => seg.querySelectorAll('.pp-seg-opt').forEach(opt => opt.addEventListener('click', () => {
            const id = seg.dataset.kbind;
            const wantBind = opt.dataset.kbindSet === 'bind';
            const l = findList(id);
            if (!isOutfitList(l) || Boolean(l.bind) === wantBind) return;
            setListBind(id, wantBind ? { picks: undefined, providerId: undefined } : null);
            rerender();
            toastr.info(wantBind
                ? `「${l.name}」已绑定当前聊天：只在这个聊天里出现（衣库暂存配置保留，切回衣库时恢复）`
                : `「${l.name}」转为全局衣库：跟随到所有聊天（绑定配置暂存，再绑定时恢复）`);
        })));
        container.querySelectorAll('[data-kbprov]').forEach(sel => sel.addEventListener('change', () => {
            updateListBind(sel.dataset.kbprov, { providerId: sel.value });
        }));
        container.querySelectorAll('[data-kbwbbook]').forEach(cb => cb.addEventListener('change', () => {
            const [listId, bookId] = cb.dataset.kbwbbook.split('|');
            const l = findList(listId);
            const book = (settings.lorebooks ?? []).find(b => b.id === bookId);
            if (!l?.bind || !book) return;
            const keys = new Set(l.bind.picks ?? []);
            for (const e of book.entries) {
                const key = `${bookId}:${e.uid}`;
                if (cb.checked) keys.add(key); else keys.delete(key);
            }
            updateListBind(listId, { picks: [...keys] });
            rerender();
        }));
        container.querySelectorAll('[data-kbwbe]').forEach(cb => cb.addEventListener('change', () => {
            const [listId, key] = cb.dataset.kbwbe.split('|');
            const l = findList(listId);
            if (!l?.bind) return;
            const keys = new Set(l.bind.picks ?? []);
            if (cb.checked) keys.add(key); else keys.delete(key);
            updateListBind(listId, { picks: [...keys] });
        }));
        container.querySelectorAll('[data-kshelf]').forEach(btn => btn.addEventListener('click', () => {
            setListBind(btn.dataset.kshelf, null);
            rerender();
            toastr.success('已转为全局衣库清单（在所有聊天可见）');
        }));
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
                if (e.target.closest('input, textarea, select, [data-kedel], [data-kclear]')) return;
                editingEntryId = editingEntryId === row.dataset.kentry ? null : row.dataset.kentry;
                refreshList();
            }));
            elist.querySelectorAll('[data-kedel]').forEach(btn => btn.addEventListener('click', () => {
                deleteEntry(list.id, btn.dataset.kedel);
                if (editingEntryId === btn.dataset.kedel) editingEntryId = null;
                refreshList();
                rerender();   // 头行的条目计数也要跟
            }));
            // 冷却徽章点击＝清零这条的冷却（2026-08-29 真机第五轮：冷却此前无处取消）
            elist.querySelectorAll('[data-kclear]').forEach(b => b.addEventListener('click', () => {
                clearCooldown(list.id, b.dataset.kclear);
                refreshList();
                rerender();   // 头行的「N 条冷却中」计数也要跟
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
