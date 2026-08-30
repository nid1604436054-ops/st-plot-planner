// 2.0 长线规划页签：六步管线的操作台＋书-卷-章-节点总览。
// 状态与编排全在 js/longform.js，本文件只管界面、按钮与状态徽；逐轮执行去看「监听」页。
// 生成走「单次选用」模型（与知识库结构化导入同款下拉：主连接或供应商方案，不影响正在用的模型）。
import { settings } from "../../settings.js";
import { escapeHtml, clamp } from "../../utils.js";
import { storageItemsInEffect } from "../../store.js";
import { knowledgeLists } from "../../knowledge.js";
import { resolveLorePicks } from "../../lorebook.js";
import {
    lfState, persistLf, resetLf, runLfSkeleton, runLfDetailBatch, runLfRevise, runLfSplitBatch,
    mountChapter, syncLfProgress, lfNextChapter, lfStats, lfMatOverview,
    LF_MIN_CHAPTER_FLOORS, LF_DEFAULT_FLOORS, LF_MIN_ANCHORS, LF_MIN_NODES,
} from "../../longform.js";

export const longformTab = {
    id: 'longform',
    title: '长线规划',
    render(container) { renderTab(container); },
};

// 模块级瞬态：一次生成在途（kind＋中断闸）与展开集合（刷新即失，不动数据）
let lfBusy = null;   // { kind: 'skeleton'|'detail'|'revise'|'split', ctl: AbortController }
const expanded = new Set();   // 'v0' 卷文本展开 / 'c0-1' 章文本展开
let confirmReset = false;     // 「作废本长线」两步确认的 Armed 位

const STAGE_LABEL = {
    none: ['① 未开始', '填参数生成骨架'],
    skeleton: ['① 骨架已定', '卷结构与楼数预算就绪，下一步具体化各卷'],
    detailed: ['③ 卷文本齐全', '可修订/手改，然后「再切小」出章与节点'],
    split: ['⑥ 章/节点就绪', '执行期：按章挂进监听，节点逐轮点亮'],
};

function providerOptions(selectedId) {
    const profs = settings.api.profiles ?? [];
    return `<option value="" ${!selectedId ? 'selected' : ''}>主连接（${escapeHtml(clamp(settings.api.model || '未配置模型', 24))}）</option>`
        + profs.map(p => `<option value="${escapeHtml(p.id)}" ${p.id === selectedId ? 'selected' : ''}>${escapeHtml(clamp(p.name || p.model, 30))}</option>`).join('');
}

let providerId = '';   // 单次选用的模型（会话内记住上次选择；空 = 主连接）
function providerFromId(pid) {
    if (!pid) return undefined;
    const p = (settings.api.profiles ?? []).find(x => x.id === pid);
    return p ? { baseUrl: p.baseUrl, apiKey: p.apiKey, model: p.model } : undefined;
}

function usageCollector() {
    const u = { requests: 0, promptTokens: 0, completionTokens: 0, reported: false };
    return {
        onUsage: x => {
            u.requests++;
            if (x?.promptTokens) {
                u.promptTokens += x.promptTokens;
                u.completionTokens += x.completionTokens || 0;
                u.reported = true;
            }
        },
        line: () => u.reported
            ? `输入 ${u.promptTokens.toLocaleString()} · 输出 ${u.completionTokens.toLocaleString()} tokens（实报 · ${u.requests} 次调用）`
            : `${u.requests || 1} 次调用（服务商未回传 usage，无实报数字）`,
    };
}

const DETAIL_BADGE = {
    none: ['未具体化', ''],
    run: ['具体化中…', ''],
    done: ['已具体化', ''],
    error: ['失败', '重试'],
};
const SPLIT_BADGE = {
    none: ['未切章', ''],
    run: ['切章中…', ''],
    done: ['已切章', ''],
    error: ['失败', '重试'],
};

function renderTab(container) {
    syncLfProgress();
    const st = lfState();
    const [stageLabel, stageHint] = STAGE_LABEL[st.stage];
    const stats = lfStats(st);
    const next = lfNextChapter(st);
    const busyLine = lfBusy ? `
        <div class="pp-item pp-lf-busy">
            <b>${({ skeleton: '生成骨架中', detail: '具体化各卷中', revise: '按意见修订中', split: '再切小中' })[lfBusy.kind]}…</b>
            <span class="pp-muted">长线产物一次要用很久，生成可以慢；中途可离开本页（切回来状态还在）</span>
            <span id="pp_lf_abort" class="menu_button" title="中断这一批调用（已被服务商收下的部分照常计费）">中断</span>
        </div>` : '';

    container.innerHTML = `
    <div class="pp-section" id="pp_lf_root">
        <div class="pp-lf-status">
            <div>
                <b>${stageLabel}</b>
                <span class="pp-muted" title="${escapeHtml(stageHint)}">${escapeHtml(stageHint)}</span>
            </div>
            ${st.stage !== 'none' ? `
            <div class="pp-item-ops">
                <span class="pp-muted">${stats.chapters ? `章 ${stats.done}/${stats.chapters} · 节点 ${stats.lit}/${stats.nodes}` : `卷 ${st.volumes.length} · ${st.volumes.reduce((n, v) => n + v.floors, 0)} 层楼`}</span>
                <span id="pp_lf_reset" class="menu_button ${confirmReset ? 'pp-danger-arm' : ''}" title="清空本聊天的长线数据（卷/章/节点与挂载记录；监听侧与 1.0 数据不动）。两步确认">${confirmReset ? '确认作废？' : '作废本长线'}</span>
            </div>` : ''}
        </div>
        ${busyLine}
        ${st.error ? `<div class="pp-muted pp-lf-err">最近一次操作失败：${escapeHtml(st.error)}</div>` : ''}
    </div>

    ${st.stage === 'none' ? paramFormHtml(st) : ''}

    ${materialsHtml(st)}

    ${st.stage !== 'none' ? `
    <div class="pp-section">
        <b>全书骨架</b>
        <span class="pp-muted" title="骨架与切块一次生成：卷结构与楼数预算由模型出、楼数算术由插件校验（总和＝楼层总数，各卷不低于一章下限）">${escapeHtml(clamp(`楼层总数 ${st.totalFloors} 层${st.minFloors ? ` · 保底 ${st.minFloors} 层` : ''} · ${st.newChars ? '允许新角色' : '不引入新角色'}${st.idea ? ` · 想法：${clamp(st.idea, 60)}` : ''}`, 90))}</span>
        <span class="pp-muted" title="生成骨架那一刻实际携带的材料概览（材料勾选在上方「材料」区改——具体化/修订/切章每次调用都按当时的勾选拼）">材料：${escapeHtml(st.materialNote || '—')}</span>
        <div id="pp_lf_vols">${st.volumes.map((v, i) => volCardHtml(v, i, st)).join('')}</div>
        <div class="pp-btn-row">
            ${st.stage === 'skeleton' ? `<span id="pp_lf_detail" class="menu_button" title="逐卷并行生成卷级详细文本（一次一卷、内嵌推进锚——锚是将来切章与判定进度的刀口）；费用＝每卷一次调用">具体化各卷</span>` : ''}
            ${st.stage === 'skeleton' ? `<span id="pp_lf_reskel" class="menu_button" title="作废当前骨架从头再来（参数与想法框在下面改）">重新生成骨架</span>` : ''}
        </div>
    </div>` : ''}

    ${st.stage !== 'none' && st.volumes.some(v => v.detailState === 'done') ? reviseHtml(st) : ''}

    ${st.volumes.some(v => v.detailState === 'done') ? `
    <div class="pp-section">
        <b>再切小</b>
        <span class="pp-muted" title="逐卷并行：卷切成章（每章至少 ${LF_MIN_CHAPTER_FLOORS} 层楼、推进锚是切章刀口）、章内切节点（每章至少 ${LF_MIN_NODES} 个、带可对照的完成标准）；章预算算术插件校验（各章之和＝本卷预算）">卷 → 章 → 节点，一步到位</span>
        <div class="pp-btn-row">
            <span id="pp_lf_split" class="menu_button" title="对全部「已具体化且未切章」的卷并行切章（每卷一次调用）">${st.volumes.some(v => v.splitState === 'done') ? '继续切章（未完成的卷）' : '再切小：卷→章→节点'}</span>
        </div>
        ${st.volumes.some(v => v.splitAt && v.textAt > v.splitAt) ? `<div class="pp-muted" title="修订/手改之后章表没重切——旧章表对着旧文本，建议重跑「再切小」（重切会按位置沿用旧章的点亮进度）">⚠ 有卷的文本在切章后改过：章表已过期</div>` : ''}
    </div>` : ''}

    ${stats.chapters ? execHtml(st, stats, next) : ''}

    ${st.stage === 'none' ? `
    <div class="pp-section">
        <span class="pp-muted" title="长线产出的「章」挂进监听当最小剧情单位：扮演模型看不到章文本，监听按节点完成标准逐轮判定、逐轮放行微量指导（§6.1 反剧透）；节点衔接只做手动——一章演完去下面点「接续下一章」">流程：生成骨架 → 具体化各卷 → 修订 → 再切小 → 按章挂进「监听」执行。每步生成单次选用模型（质量优先用贵模型）；换聊天各自独立一本。</span>
    </div>` : ''}`;

    bindTab(container, st);
}

function paramFormHtml(st) {
    return `
    <div class="pp-section">
        <b>开一本长线</b>
        <div class="pp-lf-form">
            <label title="全书要走的楼数——最先输入的硬预算：切块分卷、切章都按它分（各卷之和必须等于它；用户不填默认 ${LF_DEFAULT_FLOORS})">楼层总数
                <input id="pp_lf_floors" class="text_pole" type="number" min="${LF_MIN_CHAPTER_FLOORS}" step="10" value="${st.totalFloors}" />
            </label>
            <label title="全书剧情体量的下限（保底要求，随材料发给模型）；0/留空＝不设">保底楼数
                <input id="pp_lf_minfloors" class="text_pole" type="number" min="0" step="10" value="${st.minFloors || ''}" placeholder="不设" />
            </label>
            <label title="勾上＝允许在概要里安排新角色入场（第几卷入、起什么作用）；不勾＝全书只用已有角色与世界要素">允许新角色
                <input id="pp_lf_newchars" type="checkbox" ${st.newChars ? 'checked' : ''} />
            </label>
        </div>
        <div class="pp-lf-form">
            <label class="pp-lf-grow" title="这本长线想要什么——走向、要素、点名要求（数量/价位/时间/由谁发起/地点等都按硬要求落实）；这是最高优先级输入">本次长线的想法
                <textarea id="pp_lf_idea" class="text_pole textarea_compact" rows="4" placeholder="例：大学运动会前后两三天：遇到新对手、赛前摩擦、意外受伤、最后赢下接力赛；（留空＝按材料自由设计）">${escapeHtml(st.idea)}</textarea>
            </label>
        </div>
        <div class="pp-lf-form">
            <label title="骨架调用走哪个连接：主连接或供应商方案（单次选用，不影响正在使用的模型）——长线一次要用很久，质量优先选贵模型">生成模型
                <select id="pp_lf_prov" class="text_pole">${providerOptions(providerId)}</select>
            </label>
            <span class="menu_button pp-lf-go" id="pp_lf_skeleton" title="一次调用产出全书卷结构与楼数预算（骨架＋切块合并做；楼数总和由插件校验）">生成骨架</span>
        </div>
    </div>`;
}

// ---------------------------------------------------------------------------
// 材料面板（第十九轮用户拍板：复制「剧情指导」第 1 步、去掉标签列——长线自己勾自己的，
// 不再沿用 1.0 的勾选）：记忆表格一个勾默认全量；玩法默认跟随生效中；知识库逐张清单勾
// （勾中的整表可用条目随行）；世界书自选走悬浮面板（勾选与 1.0 分开存）。
// 骨架/具体化/修订/切章每次调用都按这里的勾选现场拼材料——面板常驻不随 stage 收起
// ---------------------------------------------------------------------------
function materialsHtml(st) {
    const m = st.mats;
    const gpItems = (settings.storageItems ?? []).filter(i => i.enabled);
    const gpSel = new Set(m.gpIds ?? storageItemsInEffect().map(i => i.id));
    const gpHit = new Set(storageItemsInEffect().map(i => i.id));
    const kbLists = knowledgeLists();
    const loreN = resolveLorePicks(m.lorePicks).length;
    return `
    <div class="pp-section" id="pp_lf_mats">
        <div class="pp-gd-layhead">
            <label class="pp-label" title="长线生成用的材料在这里勾——与「剧情指导」第 1 步互不影响。每次生成（骨架/具体化/修订/切章）都按当时的勾选现场拼同一批材料；勾选存在本聊天里，刷新不丢、作废本长线也保留">材料</label>
            <span class="pp-muted">长线生成用的材料在这里勾（与 1.0 互不影响）</span>
        </div>
        <label class="pp-label" title="勾上＝全部记忆表格的全部行随材料发送（长线不看标签、不分档位——要的就是全量）；不勾＝记忆表格整节不带">记忆表格</label>
        <div class="pp-gd-selp">
            <label title="默认全量：全部表格的全部行"><input type="checkbox" id="pp_lf_mat_mem" ${m.memory ? 'checked' : ''}/> 全量附带（全部表格的全部行）</label>
        </div>
        <label class="pp-label" title="勾选的玩法规则随每次生成发给模型，长线按其约束设计；没动过时默认勾当前生效中的条目。条目的添加与咨询在「剧情指导」页底部「游戏玩法」区">游戏玩法</label>
        <div class="pp-gd-selp">
            ${gpItems.map(i => `<label title="勾选后该条玩法规则作为材料发给长线模型（不影响它注入主对话）"><input type="checkbox" data-lfgp="${i.id}" ${gpSel.has(i.id) ? 'checked' : ''}/> ${escapeHtml(i.name)}${gpHit.has(i.id) ? ' <span class="pp-badge pp-badge-open">生效中</span>' : ''}</label>`).join('')
            || '<span class="pp-muted">还没有玩法条目</span>'}
        </div>
        ${kbLists.length ? `
        <label class="pp-label" title="勾上＝这张清单的整表可用条目随长线生成随行（冷却中的跳过；长线不分抽样/全量——都按整表带），模型凡涉及该清单领域的内容必须从条目里选用；长线用条目不结冷却（冷却只在「剧情指导」确认采用时记）。清单与条目在「知识库」页签管理">知识库清单</label>
        <div class="pp-gd-selp">
            ${kbLists.map(l => {
                const coolN = l.entries.filter(e => Number(e.cooldown) > 0).length;
                const usable = l.entries.length - coolN;
                return `<label title="勾上＝整表可用 ${usable} 条随行（冷却中 ${coolN} 条跳过；抽样/全量在长线这边不分——都整表带）"><input type="checkbox" data-lfkb="${escapeHtml(l.id)}" ${m.kbListIds.includes(l.id) ? 'checked' : ''}/> ${escapeHtml(l.name)}（${l.feed === 'full' ? '全量' : '抽样'} · 可用 ${usable} 条${coolN ? ` · ${coolN} 条冷却中` : ''}）</label>`;
            }).join('')}
        </div>` : ''}
        <div class="pp-btn-row">
            <span id="pp_lf_lore" class="menu_button" title="世界书自选（悬浮面板）：按书分组勾条目，勾中的整条原文随长线生成进材料——「照着写」的材料，与知识库「选着用」分工。不看关键词/常驻/书与条目的启用状态（勾选是唯一口径，禁用的照样能勾）；与检索命中自动去重（自选优先）。这里的勾选只管长线、与「剧情指导」第 1 步的互不影响；无冷却">世界书自选（已勾 ${loreN} 条）</span>
        </div>
        <span class="pp-muted" id="pp_lf_matnote">${escapeHtml(lfMatOverview())}；另自动随行：角色设定、检索命中的世界书、进行中剧情、历史摘要、最近对话</span>
    </div>`;
}

// 材料面板的勾选变动：只就地刷新概览行与世界书按钮计数（不整页重渲，勾选状态留在原地）
function refreshLfMatUi() {
    const note = document.getElementById('pp_lf_matnote');
    if (note) note.textContent = `${lfMatOverview()}；另自动随行：角色设定、检索命中的世界书、进行中剧情、历史摘要、最近对话`;
    const btn = document.getElementById('pp_lf_lore');
    if (btn) btn.textContent = `世界书自选（已勾 ${resolveLorePicks(lfState().mats.lorePicks).length} 条）`;
}

// ---- 悬浮查看器（照剧情指导页同款：居中大窗＋Esc/点窗外关闭） ----
let lfViewerEsc = null;
function closeLfViewer() {
    if (lfViewerEsc) { document.removeEventListener('keydown', lfViewerEsc); lfViewerEsc = null; }
    document.querySelector('.pp-viewer-mask')?.remove();
}
function openLfViewer(title) {
    closeLfViewer();
    const mask = document.createElement('div');
    mask.className = 'pp-viewer-mask';
    mask.innerHTML = `
    <div class="pp-viewer" role="dialog" aria-label="${escapeHtml(title)}">
        <div class="pp-viewer-head">
            <b>${escapeHtml(title)}</b>
            <span class="menu_button pp-viewer-close fa-solid fa-xmark" title="关闭（Esc 或点窗外空白处也行）"></span>
        </div>
        <div class="pp-viewer-body"></div>
    </div>`;
    document.body.appendChild(mask);
    lfViewerEsc = e => { if (e.key === 'Escape') closeLfViewer(); };
    document.addEventListener('keydown', lfViewerEsc);
    mask.addEventListener('mousedown', e => { if (e.target === mask) closeLfViewer(); });
    mask.querySelector('.pp-viewer-close').addEventListener('click', closeLfViewer);
    return mask;
}

// 世界书自选悬浮面板（长线自己的勾选存 longform 块——与 1.0 的 picks 分家；交互照第 1 步同款：
// 按书折叠、搜索、整书全勾/全清）
function openLfLorePanel() {
    const body = openLfViewer('世界书自选 · 长线').querySelector('.pp-viewer-body');
    let query = '';
    const selSet = () => new Set(lfState().mats.lorePicks);
    const foldState = new Map();
    const isFolded = (book, searching) => (foldState.has(book.id) ? foldState.get(book.id) : !searching);

    const render = () => {
        const books = settings.lorebooks ?? [];
        const sel = selSet();
        if (!books.length) {
            body.innerHTML = '<div class="pp-muted">还没有世界书——在「世界书」页签导入或新建后再来</div>';
            return;
        }
        const q = query.trim().toLowerCase();
        const searching = Boolean(q);
        const groupHtml = books.map(book => {
            const entries = (book.entries ?? []).filter(e => !q
                || String(e.comment ?? '').toLowerCase().includes(q)
                || String(e.content ?? '').toLowerCase().includes(q)
                || (Array.isArray(e.keys) ? e.keys : []).some(k => String(k).toLowerCase().includes(q)));
            if (!entries.length) return '';
            const onN = entries.filter(e => sel.has(`${book.id}:${e.uid}`)).length;
            const allOn = entries.length > 0 && onN === entries.length;
            const folded = isFolded(book, searching);
            return `
        <div class="pp-gd-ughead">
            <label class="pp-label" title="整本书一起勾/一起清（已勾＝全勾；再点＝全清）"><input type="checkbox" data-lbook="${escapeHtml(book.id)}" ${allOn ? 'checked' : ''} /> ${escapeHtml(book.name)}（已勾 ${onN}/${entries.length}）</label>
            <span class="menu_button" data-lfold="${escapeHtml(book.id)}"><i class="fa-solid fa-chevron-${folded ? 'right' : 'down'}"></i> ${folded ? '展开' : '收起'}</span>
        </div>
        ${folded ? '' : entries.map(e => {
            const key = `${book.id}:${e.uid}`;
            const on = sel.has(key);
            return `
        <div class="pp-kb-erow${on ? '' : ' pp-kb-unsel'}">
            <label title="勾上＝这条的原文整条随长线生成进材料（照着写，不是选着用）"><input type="checkbox" data-lore="${escapeHtml(key)}" ${on ? 'checked' : ''} /></label>
            <span class="pp-kb-ebody" title="${escapeHtml(String(e.content ?? ''))}">${escapeHtml(String(e.comment ?? `条目 ${e.uid + 1}`))}</span>
        </div>`; }).join('')}`;
        }).join('');
        body.innerHTML = `
        <input type="text" class="text_pole textarea_compact" id="pp_lf_lore_q" placeholder="搜条目（标题 / 内容 / 关键词）——只筛显示，不动勾选；检索时命中的书自动展开…" value="${escapeHtml(query)}" style="width:100%" />
        ${groupHtml || '<div class="pp-muted">没有命中检索词的条目，清空检索词看全部</div>'}
        <div class="pp-muted" style="margin-top:6px">勾上＝整条原文随长线生成进材料（照着写）。条目行只显示名字，原文悬浮可看全文；不看关键词/常驻/书与条目的启用状态——勾选是唯一口径，禁用的书与条目照样能勾；与「检索命中」自动去重（这边优先，同一条不进材料两次）。这里的勾选只管长线，与「剧情指导」第 1 步的互不影响；无冷却</div>`;

        const qEl = body.querySelector('#pp_lf_lore_q');
        qEl?.addEventListener('input', () => {
            query = qEl.value;
            render();
            const nq = body.querySelector('#pp_lf_lore_q');
            nq?.focus();
            nq?.setSelectionRange(nq.value.length, nq.value.length);
        });
        const apply = keys => {
            const s = lfState();
            s.mats.lorePicks = [...keys];
            persistLf();
            render();
            refreshLfMatUi();
        };
        body.querySelectorAll('[data-lore]').forEach(cb => cb.addEventListener('change', () => {
            const s = selSet();
            if (cb.checked) s.add(cb.dataset.lore); else s.delete(cb.dataset.lore);
            apply(s);
        }));
        body.querySelectorAll('[data-lbook]').forEach(cb => cb.addEventListener('change', () => {
            const s = selSet();
            const book = (settings.lorebooks ?? []).find(b => b.id === cb.dataset.lbook);
            if (!book) return;
            const keys = (book.entries ?? []).map(e => `${book.id}:${e.uid}`);
            keys.forEach(k => { if (cb.checked) s.add(k); else s.delete(k); });
            apply(s);
        }));
        body.querySelectorAll('[data-lfold]').forEach(el => el.addEventListener('click', () => {
            const book = (settings.lorebooks ?? []).find(b => b.id === el.dataset.lfold);
            if (!book) return;
            const searching = Boolean(query.trim());
            foldState.set(book.id, !isFolded(book, searching));
            render();
        }));
    };
    render();
}

function volCardHtml(v, i, st) {
    const [dLabel] = DETAIL_BADGE[v.detailState] ?? ['', ''];
    const [sLabel] = SPLIT_BADGE[v.splitState] ?? ['', ''];
    const open = expanded.has(`v${i}`);
    const editing = expanded.has(`ve${i}`);
    const chs = v.chapters ?? [];
    return `
    <div class="pp-item pp-lf-vol">
        <div class="pp-item-main">
            <b>第 ${i + 1} 卷 · ${escapeHtml(v.title)}</b>
            <span class="pp-muted">${v.floors} 层楼</span>
            <span class="pp-muted pp-lf-badge">${v.detailState === 'done' ? `${v.anchors.length} 锚${v.splitState === 'done' ? ` · ${chs.length} 章` : ''}` : dLabel}${v.splitState === 'error' ? ` · 切章${sLabel}` : ''}</span>
        </div>
        <div class="pp-muted pp-lf-volsum">${escapeHtml(clamp(v.summary, 110))}</div>
        ${v.seeds && v.seeds !== '无' ? `<div class="pp-muted" title="${escapeHtml(v.seeds)}">种子：${escapeHtml(clamp(v.seeds, 90))}</div>` : ''}
        ${v.detailError ? `<div class="pp-muted pp-lf-err">具体化失败：${escapeHtml(v.detailError)}</div>` : ''}
        ${v.splitError ? `<div class="pp-muted pp-lf-err">切章失败：${escapeHtml(v.splitError)}</div>` : ''}
        <div class="pp-item-ops">
            ${v.detailState === 'done' ? `<span class="menu_button" data-vol="${i}">${open ? '收起文本' : '卷文本'}</span>` : ''}
            ${v.detailState === 'done' && !editing ? `<span class="menu_button" data-vedit="${i}" title="就地手改卷文本（改完记得重跑「再切小」——章表按旧文本切的会过期）">编辑</span>` : ''}
        </div>
        ${open ? `<div class="pp-lf-text">${escapeHtml(v.text)}</div>` : ''}
        ${editing ? `
        <div>
            <textarea class="text_pole textarea_compact pp-lf-editarea" data-vetext="${i}" rows="10">${escapeHtml(v.text)}</textarea>
            <div class="pp-btn-row"><span class="menu_button" data-vesave="${i}">保存卷文本</span></div>
        </div>` : ''}
    </div>`;
}

function reviseHtml(st) {
    return `
    <div class="pp-section">
        <b>审阅与修订</b>
        <span class="pp-muted" title="整体审阅、修改：在下面写意见整书修订（只改意见涉及处），或点各卷「编辑」就地手改；修订/手改后章表会标过期，需重跑再切小">逐卷点「卷文本」通读；不满意就写意见修订或就地手改</span>
        <textarea id="pp_lf_opinion" class="text_pole textarea_compact" rows="3" placeholder="修改意见：要改什么（例：第二卷的误会戏太拖，提前收掉；结尾加一场雨中告别）"></textarea>
        <div class="pp-btn-row"><span id="pp_lf_revise" class="menu_button" title="按意见修订全部卷（一次调用、全部卷的全文重出——输出比单卷长，费用也高；只改意见涉及处）">按意见修订全书</span></div>
    </div>`;
}

function execHtml(st, stats, next) {
    const mount = st.mount;
    const curCh = mount ? st.volumes[mount.vol]?.chapters?.[mount.ch] : null;
    const curDone = curCh ? curCh.done || curCh.lit >= curCh.nodes.length : false;
    return `
    <div class="pp-section" id="pp_lf_exec">
        <b>执行总览</b>
        <span class="pp-muted">章 ${stats.done}/${stats.chapters} 已演完 · 节点 ${stats.lit}/${stats.nodes} 已点亮</span>
        ${settings.listener?.enabled ? '' : `<div class="pp-muted pp-lf-err">监听总开关没开——挂上章也不会逐轮判定（「监听」页或设置页打开）</div>`}
        ${mount && curCh ? `
        <div class="pp-item">
            <div class="pp-item-main">
                <b>执行中：第 ${mount.vol + 1} 卷 · ${escapeHtml(curCh.title)}</b>
                <span class="pp-muted">${curCh.lit}/${curCh.nodes.length} 节点点亮${curDone ? ' · 已演完' : ''}</span>
            </div>
            <div class="pp-item-ops">
                ${next ? `<span id="pp_lf_next" class="menu_button" title="${curDone ? `接全书顺序的下一章：第 ${next.vol + 1} 卷「${st.volumes[next.vol].chapters[next.ch].title}」` : '当前章还有没点亮的节点——先演完，或到「监听」页「标记达成」手动点亮'}">${curDone ? '接续下一章' : '当前章未演完'}</span>` : `<span class="pp-muted">全书章已演完——作废重来或开新一本</span>`}
            </div>
        </div>` : `<div class="pp-muted">还没挂载章——点下面任意章的「挂载」开始执行（挂进监听单位槽；扮演模型看不到章文本）。</div>`}
        <div id="pp_lf_chapters">${st.volumes.map((v, vi) => (v.chapters ?? []).length ? `
        <div class="pp-lf-volgroup">
            <div class="pp-lf-volhead">第 ${vi + 1} 卷 · ${escapeHtml(v.title)} <span class="pp-muted">${v.floors} 层</span></div>
            ${v.chapters.map((c, ci) => chapterCardHtml(c, vi, ci, st)).join('')}
        </div>` : '').join('')}</div>
    </div>`;
}

function chapterCardHtml(c, vi, ci, st) {
    const open = expanded.has(`c${vi}-${ci}`);
    const isMounted = st.mount && st.mount.vol === vi && st.mount.ch === ci;
    const done = c.done || (c.nodes.length > 0 && c.lit >= c.nodes.length);
    return `
    <div class="pp-item pp-lf-ch ${isMounted ? 'pp-lf-ch-cur' : ''}">
        <div class="pp-item-main">
            <b>${done ? '✓ ' : ''}${escapeHtml(c.title)}</b>
            <span class="pp-muted">${c.floors} 层 · ${c.lit}/${c.nodes.length} 节点${isMounted ? ' · 执行中' : ''}</span>
        </div>
        <div class="pp-lf-nodesline">${c.nodes.map((n, ni) => `<span class="pp-lf-node ${ni < c.lit ? 'pp-lf-node-lit' : ''}" title="${escapeHtml(n.criterion)}">${ni < c.lit ? '●' : '○'}${escapeHtml(clamp(n.title, 16))}</span>`).join('')}</div>
        <div class="pp-item-ops">
            ${!isMounted ? `<span class="menu_button" data-chmount="${vi}:${ci}" title="把这一章挂进监听单位槽开始执行（若槽里有单位会被顶进退位槽；退位槽被占会拒绝，先去监听页处理）">挂载</span>` : ''}
            <span class="menu_button" data-chview="${vi}-${ci}">${open ? '收起章文本' : '章文本'}</span>
        </div>
        ${open ? `<div class="pp-lf-text">${escapeHtml(c.text)}</div>` : ''}
    </div>`;
}

function bindTab(container, st) {
    const root = container.querySelector('#pp_lf_root');
    if (!root) return;

    container.querySelector('#pp_lf_abort')?.addEventListener('click', () => {
        lfBusy?.ctl.abort();
        toastr.info('已中断——收尾后状态回置（已被服务商收下的调用照常计费）');
    });

    // 参数表单：输入即留底（刷新不丢——向导/知识库的教训：用户攒的想法不算瞬态）
    const floorsEl = container.querySelector('#pp_lf_floors');
    const minEl = container.querySelector('#pp_lf_minfloors');
    const ideaEl = container.querySelector('#pp_lf_idea');
    const ncEl = container.querySelector('#pp_lf_newchars');
    if (floorsEl) {
        const stash = () => {
            const s = lfState();
            s.totalFloors = Math.max(LF_MIN_CHAPTER_FLOORS, Math.round(Number(floorsEl.value) || 0)) || LF_DEFAULT_FLOORS;
            s.minFloors = Math.max(0, Math.round(Number(minEl.value) || 0));
            s.idea = ideaEl.value;
            s.newChars = ncEl.checked;
            persistLf();
        };
        [floorsEl, minEl, ideaEl, ncEl].forEach(el => el.addEventListener('change', stash));
    }
    container.querySelector('#pp_lf_prov')?.addEventListener('change', e => { providerId = e.target.value; });

    // 材料面板：勾选即留底（存 longform 块的 mats——刷新不丢、作废本长线也保留）
    container.querySelector('#pp_lf_mat_mem')?.addEventListener('change', e => {
        const s = lfState();
        s.mats.memory = e.target.checked;
        persistLf();
        refreshLfMatUi();
    });
    container.querySelectorAll('[data-lfgp]').forEach(cb => cb.addEventListener('change', () => {
        const s = lfState();
        const cur = new Set(s.mats.gpIds ?? storageItemsInEffect().map(i => i.id));   // null＝跟随生效中，动第一下时固化
        if (cb.checked) cur.add(cb.dataset.lfgp); else cur.delete(cb.dataset.lfgp);
        s.mats.gpIds = [...cur];
        persistLf();
        refreshLfMatUi();
    }));
    container.querySelectorAll('[data-lfkb]').forEach(cb => cb.addEventListener('change', () => {
        const s = lfState();
        const cur = new Set(s.mats.kbListIds);
        if (cb.checked) cur.add(cb.dataset.lfkb); else cur.delete(cb.dataset.lfkb);
        s.mats.kbListIds = [...cur];
        persistLf();
        refreshLfMatUi();
    }));
    container.querySelector('#pp_lf_lore')?.addEventListener('click', () => openLfLorePanel());

    container.querySelector('#pp_lf_skeleton')?.addEventListener('click', async function () {
        if (lfBusy) return toastr.warning('有长线生成还在跑（先中断或等它完成）');
        const s = lfState();
        const u = usageCollector();
        lfBusy = { kind: 'skeleton', ctl: new AbortController() };
        this.classList.add('disabled');
        renderBusy(container);
        try {
            await runLfSkeleton({
                totalFloors: s.totalFloors,
                minFloors: s.minFloors,
                idea: s.idea,
                newChars: s.newChars,
                provider: providerFromId(providerId),
                signal: lfBusy.ctl.signal,
                onUsage: u.onUsage,
            });
            toastr.success(`骨架已定：${s.totalFloors} 层楼分 ${lfState().volumes.length} 卷；${u.line()}`);
        } catch (err) {
            if (err?.name !== 'AbortError') toastr.error(`生成骨架失败：${err?.message ?? err}`);
            markErr(err);
        } finally {
            lfBusy = null;
            renderTab(container);
        }
    });

    container.querySelector('#pp_lf_detail')?.addEventListener('click', () => runBatch(container, 'detail'));
    container.querySelector('#pp_lf_split')?.addEventListener('click', () => runBatch(container, 'split'));

    container.querySelector('#pp_lf_reskel')?.addEventListener('click', () => {
        const s = lfState();
        saveAndReform(container, s);
    });

    container.querySelector('#pp_lf_revise')?.addEventListener('click', async function () {
        if (lfBusy) return toastr.warning('有长线生成还在跑（先中断或等它完成）');
        const opinion = String(container.querySelector('#pp_lf_opinion')?.value ?? '').trim();
        if (!opinion) return toastr.warning('先写修改意见——长线的「换一版」＝重新生成骨架');
        const u = usageCollector();
        lfBusy = { kind: 'revise', ctl: new AbortController() };
        this.classList.add('disabled');
        renderBusy(container);
        try {
            await runLfRevise({ opinion, provider: providerFromId(providerId), signal: lfBusy.ctl.signal, onUsage: u.onUsage });
            toastr.success(`全书已按意见修订（章表若已生成会标过期）；${u.line()}`);
        } catch (err) {
            if (err?.name !== 'AbortError') toastr.error(`修订失败：${err?.message ?? err}`);
            markErr(err);
        } finally {
            lfBusy = null;
            renderTab(container);
        }
    });

    container.querySelector('#pp_lf_next')?.addEventListener('click', () => {
        const s = syncLfProgress();
        const m = s.mount;
        const curCh = m ? s.volumes[m.vol]?.chapters?.[m.ch] : null;
        if (curCh && curCh.lit < curCh.nodes.length) {
            return toastr.info(`当前章还有 ${curCh.nodes.length - curCh.lit} 个节点没点亮——继续扮演等监听判定，或到「监听」页「标记达成」手动点亮`);
        }
        const next = lfNextChapter(s);
        if (!next) return toastr.info('全书章已演完');
        const r = mountChapter(next.vol, next.ch);
        if (r.ok) toastr.success(`已挂载下一章：第 ${next.vol + 1} 卷「${s.volumes[next.vol].chapters[next.ch].title}」`);
        else toastr.warning(r.reason);
        renderTab(container);
    });

    container.querySelector('#pp_lf_reset')?.addEventListener('click', function () {
        if (!confirmReset) {
            confirmReset = true;
            this.textContent = '确认作废？';
            this.classList.add('pp-danger-arm');
            setTimeout(() => { confirmReset = false; this.textContent = '作废本长线'; this.classList.remove('pp-danger-arm'); }, 4000);
            return;
        }
        resetLf();
        confirmReset = false;
        expanded.clear();
        toastr.success('本长线已作废（监听侧挂载与 1.0 数据不动）');
        renderTab(container);
    });

    container.querySelectorAll('[data-vol]').forEach(el => el.addEventListener('click', () => {
        const k = `v${el.dataset.vol}`;
        expanded.has(k) ? expanded.delete(k) : expanded.add(k);
        renderTab(container);
    }));
    container.querySelectorAll('[data-vedit]').forEach(el => el.addEventListener('click', () => {
        expanded.add(`ve${el.dataset.vedit}`);
        renderTab(container);
    }));
    container.querySelectorAll('[data-vesave]').forEach(el => el.addEventListener('click', () => {
        const i = Number(el.dataset.vesave);
        const ta = container.querySelector(`[data-vetext="${i}"]`);
        const s = lfState();
        const v = s.volumes[i];
        if (v && ta) {
            v.text = ta.value.trim();
            v.textAt = Date.now();
            persistLf();
            toastr.success(`第 ${i + 1} 卷文本已保存（若已切章，章表标过期）`);
        }
        expanded.delete(`ve${i}`);
        renderTab(container);
    }));
    container.querySelectorAll('[data-chview]').forEach(el => el.addEventListener('click', () => {
        const k = `c${el.dataset.chview}`;
        expanded.has(k) ? expanded.delete(k) : expanded.add(k);
        renderTab(container);
    }));
    wireExec(container);
}

// 执行区的按钮单独接线：监听每轮判定后执行区会被局部重建（不打断用户打字），按钮要跟着重接
function wireExec(container) {
    container.querySelectorAll('[data-chmount]').forEach(el => el.addEventListener('click', () => {
        const [vi, ci] = el.dataset.chmount.split(':').map(Number);
        const r = mountChapter(vi, ci);
        if (r.ok) toastr.success(`已挂载：第 ${vi + 1} 卷「${lfState().volumes[vi].chapters[ci].title}」——监听将按节点逐轮判定`);
        else toastr.warning(r.reason);
        renderTab(container);
    }));
}

// 批量步（具体化 / 再切小）共用：并发跑、单卷失败不拖垮其余、逐卷留下失败原因
async function runBatch(container, kind) {
    if (lfBusy) return toastr.warning('有长线生成还在跑（先中断或等它完成）');
    const u = usageCollector();
    lfBusy = { kind, ctl: new AbortController() };
    renderBusy(container);
    try {
        const r = kind === 'detail'
            ? await runLfDetailBatch({ provider: providerFromId(providerId), signal: lfBusy.ctl.signal, onUsage: u.onUsage })
            : await runLfSplitBatch({ provider: providerFromId(providerId), signal: lfBusy.ctl.signal, onUsage: u.onUsage });
        const name = kind === 'detail' ? '具体化' : '切章';
        if (!r.failed.length) toastr.success(`${name}完成 ${r.done} 卷；${u.line()}`);
        else {
            toastr.warning(`${name}完成 ${r.done} 卷、失败 ${r.failed.length} 卷（失败原因在各卷卡片上，可重试）；${u.line()}`);
            const s = lfState();
            s.error = r.failed.map(f => `第 ${f.vol + 1} 卷：${clamp(f.reason, 80)}`).join('；');
            persistLf();
        }
    } catch (err) {
        if (err?.name !== 'AbortError') toastr.error(`失败：${err?.message ?? err}`);
        markErr(err);
    } finally {
        lfBusy = null;
        renderTab(container);
    }
}

function markErr(err) {
    if (!err || err?.name === 'AbortError') return;
    const s = lfState();
    s.error = String(err?.message ?? err);
    persistLf();
}

function renderBusy(container) {
    const root = container.querySelector('#pp_lf_root');
    if (root && !root.querySelector('.pp-lf-busy')) {
        root.insertAdjacentHTML('beforeend', `
        <div class="pp-item pp-lf-busy">
            <b>生成中…</b>
            <span id="pp_lf_abort" class="menu_button">中断</span>
        </div>`);
        root.querySelector('#pp_lf_abort')?.addEventListener('click', () => {
            lfBusy?.ctl.abort();
            toastr.info('已中断——收尾后状态回置（已被服务商收下的调用照常计费）');
        });
    }
}

// 重新生成骨架＝回参数表单（参数与想法已留底，改完直接再点「生成骨架」）
function saveAndReform(container, s) {
    const back = lfState();
    back.stage = 'none';
    back.volumes = [];
    back.mount = null;
    back.materialNote = '';
    back.createdAt = 0;
    back.error = '';
    persistLf();
    toastr.info('已回到参数表单（楼层/保底/新角色/想法都留着）——改完点「生成骨架」');
    renderTab(container);
}

// 监听每轮判定后：长线页开着就同步点亮数并局部刷新执行区（不打断用户在输入框里打字）
document.addEventListener('pp-listener-updated', () => {
    const root = document.getElementById('pp_lf_root');
    if (!root) return;
    syncLfProgress();
    const st = lfState();
    const stats = lfStats(st);
    const next = lfNextChapter(st);
    const exec = document.getElementById('pp_lf_exec');
    if (exec) {
        const scope = exec.parentElement ?? document.body;
        exec.outerHTML = execHtml(st, stats, next);
        wireExec(scope);
    }
    const ops = root.querySelector('.pp-item-ops .pp-muted');
    if (ops && stats.chapters) ops.textContent = `章 ${stats.done}/${stats.chapters} · 节点 ${stats.lit}/${stats.nodes}`;
});
