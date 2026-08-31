// 2.0 长线规划页签（第二十四轮重构；第二十五轮操作条挪位）：状态行＋ 参数/材料两个折叠区
// （生成前展开、过程中收起）＋ 操作条（四步生成按钮常驻、按流程置灰——放两个折叠区下面、
// 卷列表上面：用户在卷卡上下编辑时往上够按钮，不用每次跨过两行折叠头）＋ 卷列表（每卷折叠，
// 展开后三页签切换：骨架 / 卷文本 / 章与节点——同一附属区里切着看，不往下摞长页）＋ 执行区
// （当前章＋接续）。「按意见修订」下沉到每一步：骨架整书 / 单卷骨架 / 单卷卷文本 / 单卷带意见
// 重切，与手动编辑并存。状态与编排全在 js/longform.js，本文件只管界面；逐轮执行去看「监听」页。
// 生成走「单次选用」模型（主连接或供应商方案，不影响正在用的模型）。
import { settings } from "../../settings.js";
import { escapeHtml, clamp } from "../../utils.js";
import { storageItemsInEffect } from "../../store.js";
import { knowledgeLists } from "../../knowledge.js";
import { resolveLorePicks } from "../../lorebook.js";
import {
    lfState, persistLf, resetLf, runLfSkeleton, runLfDetailBatch, runLfRevise, runLfSplitBatch,
    runLfSkeletonRevise, runLfVolSkeletonRevise, runLfVolTextRevise, runLfVolSplit, stashLfRegenBackup,
    mountChapter, syncLfProgress, lfNextChapter, lfStats, lfMatOverview,
    LF_MIN_CHAPTER_FLOORS, LF_DEFAULT_FLOORS,
} from "../../longform.js";

export const longformTab = {
    id: 'longform',
    title: '长线规划',
    render(container) { renderTab(container); },
};

// 模块级瞬态（刷新即失、不动数据）
let lfBusy = null;   // { kind: 'skeleton'|'detail'|'revise'|'revsk'|'volsk'|'voltext'|'split'|'volsplit', ctl }
const BUSY_LABEL = {
    skeleton: '生成骨架中', detail: '具体化各卷中', revise: '按意见修订中', revsk: '按意见修订骨架中',
    volsk: '修订本卷骨架中', voltext: '修订本卷文本中', split: '再切小中', volsplit: '重切本卷中',
};
let providerId = '';        // 单次选用的模型（会话内记住上次选择；空 = 主连接）
let confirmReset = false;   // 「作废本长线」两步确认
const delArmVol = new Set();   // 「删除本卷」两步确认（卷号）
const veArmVol = new Set();    // 「取消」卷文本编辑两步确认（卷号，只在改过内容时启用）
const skArmVol = new Set();    // 「取消」骨架编辑两步确认（卷号，同上）
const chArm = new Set();       // 「取消」章文本编辑两步确认（`${vi}:${ci}`）
let lfOpinion = '';            // 整书修订意见草稿（会话内留底）
const volOpinions = new Map(); // 单卷意见草稿（键 `${vi}:sk|text|split`，会话内留底——攒的意见不算瞬态）
let revOpen = false;           // 操作条「按意见修订」的意见框展开位
let paramOpen = null, matOpen = null;   // 参数/材料折叠位（null＝首次按阶段自动定：生成前展开、之后收起）
let busyLast = 0;              // busy 实时字数的节流闸（流式回调很密，150ms 一拍够用）
let busyT0 = 0, busyTimer = null, busyThink = 0;   // busy 计时与思考计数（第二十四轮：横幅补模型·用时·思考）

// 卷内 UI 状态：open 展开、tab 页签（sk 骨架/text 卷文本/ch 章与节点）、skEdit/veEdit 编辑态、
// skRev/veRev/spRev 意见框、chView/chEdit 章文本查看与编辑
const volUi = new Map();
function volUiOf(i) {
    if (!volUi.has(i)) volUi.set(i, { open: false, tab: 'sk', skEdit: false, skRev: false, veEdit: false, veRev: false, spRev: false, chView: new Set(), chEdit: new Set() });
    return volUi.get(i);
}
function closeInlineBoxes(ui) {
    ui.skEdit = ui.skRev = ui.veEdit = ui.veRev = ui.spRev = false;
    ui.chEdit.clear();
}

const STAGE_LABEL = {
    none: ['① 未开始', '填参数，点「生成骨架」'],
    skeleton: ['② 骨架已定', '可修订/编辑骨架，然后具体化各卷'],
    detailed: ['③ 卷文本齐全', '可修订/手改，然后再切小'],
    split: ['④ 章/节点就绪', '执行期：按章挂进监听，节点逐轮点亮'],
};

function providerOptions(selectedId) {
    const profs = settings.api.profiles ?? [];
    return `<option value="" ${!selectedId ? 'selected' : ''}>主连接（${escapeHtml(clamp(settings.api.model || '未配置模型', 24))}）</option>`
        + profs.map(p => `<option value="${escapeHtml(p.id)}" ${p.id === selectedId ? 'selected' : ''}>${escapeHtml(clamp(p.name || p.model, 30))}</option>`).join('');
}

function providerFromId(pid) {
    if (!pid) return undefined;
    const p = (settings.api.profiles ?? []).find(x => x.id === pid);
    return p ? { baseUrl: p.baseUrl, apiKey: p.apiKey, model: p.model } : undefined;
}

// busy 横幅右侧的模型名（与下拉同源：方案名或主连接模型名）
function lfModelLabel() {
    if (!providerId) return clamp(settings.api.model || '主连接', 24);
    const p = (settings.api.profiles ?? []).find(x => x.id === providerId);
    return clamp(p?.name || p?.model || '供应商方案', 24);
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

function startBusy(kind) {
    lfBusy = { kind, ctl: new AbortController() };
    busyT0 = Date.now();
    busyThink = 0;
}
function endBusy() {
    lfBusy = null;
    stopBusyTimer();
}
function startBusyTimer() {
    stopBusyTimer();
    busyTimer = setInterval(updateBusyMeta, 1000);
    updateBusyMeta();
}
function stopBusyTimer() {
    if (busyTimer) { clearInterval(busyTimer); busyTimer = null; }
}
function updateBusyMeta() {
    const el = document.getElementById('pp_lf_busymeta');
    if (!el || !lfBusy) return;
    const sec = Math.max(0, Math.round((Date.now() - busyT0) / 1000));
    const mm = String(Math.floor(sec / 60)).padStart(2, '0');
    const ss = String(sec % 60).padStart(2, '0');
    el.textContent = `${lfModelLabel()} · ${mm}:${ss}${busyThink ? ` · 思考 ${busyThink.toLocaleString()} 字` : ''}`;
}

function renderTab(container) {
    stopBusyTimer();
    syncLfProgress();
    const st = lfState();
    if (paramOpen === null) { paramOpen = st.stage === 'none'; matOpen = st.stage === 'none'; }
    const [stageLabel, stageHint] = STAGE_LABEL[st.stage];
    const stats = lfStats(st);
    const next = lfNextChapter(st);
    const anyDetail = st.volumes.some(v => v.detailState === 'done');
    const busyLine = lfBusy ? `
        <div class="pp-item pp-lf-busy">
            <b>${BUSY_LABEL[lfBusy.kind] ?? '生成中'}…</b>
            <span class="pp-muted" id="pp_lf_busymeta">${escapeHtml(lfModelLabel())} · 00:00</span>
            <span class="pp-muted" id="pp_lf_busynote"></span>
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

    ${paramFoldHtml(st)}
    ${materialsHtml(st)}

    ${toolbarHtml(st, anyDetail)}

    ${st.stage !== 'none' ? `
    <div class="pp-section">
        <div class="pp-gd-layhead"><b>卷</b><span class="pp-muted">${st.volumes.length} 卷 · ${st.volumes.reduce((n, v) => n + v.floors, 0)} 层楼${st.minFloors ? ` · 保底 ${st.minFloors}` : ''}${st.idea ? ` · 想法：${escapeHtml(clamp(st.idea, 40))}` : ''}</span></div>
        <div id="pp_lf_vols">${st.volumes.map((v, i) => volCardHtml(v, i, st)).join('')}</div>
    </div>` : ''}

    ${stats.chapters ? execHtml(st, stats, next) : ''}`;

    bindTab(container, st);
    if (lfBusy) startBusyTimer();
}

// ---------------------------------------------------------------------------
// 操作条（第二十五轮起放在参数/材料折叠区下面、卷列表上面——编辑卷时往上够按钮不用跨过
// 折叠区）：四步生成按钮常驻（没到的步骤灰置、悬浮说明指路）＋生成模型下拉＋
// 「按意见修订」点开才带出整书意见框（骨架阶段修订骨架、有卷文本后修订卷文本）
// ---------------------------------------------------------------------------
function toolbarHtml(st, anyDetail) {
    const canDetail = st.stage !== 'none';
    const canRevise = st.stage !== 'none';
    const canSplit = anyDetail;
    const revTarget = st.stage === 'skeleton' ? '骨架' : '卷文本';
    return `
    <div class="pp-section">
        <div class="pp-lf-toolbar">
            <span class="menu_button pp-lf-go ${st.stage === 'none' ? '' : 'pp-lf-dim'}" id="pp_lf_skeleton" title="一次调用产出全书卷结构与楼数预算（骨架＋切块合并做；楼数总和由插件校验；楼数按剧情体量分配、不平均）">生成骨架</span>
            <span class="menu_button ${canDetail ? '' : 'pp-lf-dim'}" id="pp_lf_detail" title="逐卷并行生成卷级详细文本（一次一卷、只补没完成的卷——中途报错已成的卷不丢）；费用＝每卷一次调用">${st.volumes.some(v => v.detailState === 'done') ? '继续具体化（未完成的卷）' : '具体化各卷'}</span>
            <span class="menu_button ${canRevise ? '' : 'pp-lf-dim'}" id="pp_lf_revise" title="${st.stage === 'skeleton'
        ? '按意见修订全书骨架（卷名/楼数分配/概要/种子，只改意见涉及处）——单卷修订去各卷「骨架」页签'
        : '按意见修订全部卷的卷文本（逐卷下发意见、一次只重出一卷全文——没被意见点名的卷会原样带出；改动去各卷「卷文本」页签看）'}">按意见修订（${revTarget}）</span>
            <span class="menu_button ${canSplit ? '' : 'pp-lf-dim'}" id="pp_lf_split" title="逐卷并行：卷切成章（推进锚是刀口）、章内切节点，一步到位；只切「已具体化且未切章」的卷——单卷带意见重切去各卷「章与节点」页签">${st.volumes.some(v => v.splitState === 'done') ? '继续切章（未完成的卷）' : '再切小'}</span>
            ${st.stage !== 'none' ? `<span class="menu_button" id="pp_lf_reskel" title="回到参数表单从头再来（参数与想法留着；旧书自动备份——新骨架生成失败会自动恢复）">重新生成骨架</span>` : ''}
            <label class="pp-lf-prov" title="生成调用走哪个连接：主连接或供应商方案（单次选用，不影响正在使用的模型）——四步共用这一个选择">生成模型
                <select id="pp_lf_prov" class="text_pole">${providerOptions(providerId)}</select>
            </label>
        </div>
        ${revOpen && canRevise ? `
        <div class="pp-lf-form" style="margin-top:8px">
            <label class="pp-lf-grow" title="写给大模型的修订意见——只改意见涉及处；意见为空的「换一版」走「重新生成骨架」">修订意见（全书${revTarget}）
                <textarea id="pp_lf_opinion" class="text_pole textarea_compact" rows="3" placeholder="要改什么（例：第二卷的误会戏太拖，提前收掉；结尾加一场雨中告别）">${escapeHtml(lfOpinion)}</textarea>
            </label>
        </div>
        <div class="pp-btn-row"><span id="pp_lf_revise_go" class="menu_button">按意见修订全书</span></div>` : ''}
    </div>`;
}

// 参数折叠区（第二十四轮：生成前展开、之后收起——参数只在「生成骨架」时生效）
function paramFoldHtml(st) {
    const summary = `楼层总数 ${st.totalFloors}${st.minFloors ? ` · 保底 ${st.minFloors}` : ''} · ${st.newChars ? '允许新角色' : '不引入新角色'}${st.idea ? ` · 想法：${clamp(st.idea, 30)}` : ''}`;
    return `
    <div class="pp-section">
        <div class="pp-lf-foldhead" id="pp_lf_pfold" title="楼层总数/保底/新角色/想法——这些参数只在「生成骨架」时生效；生成之后各卷楼数在各卷「骨架」页签里改">
            <i class="fa-solid fa-chevron-${paramOpen ? 'down' : 'right'}"></i>
            <b>参数与想法</b>
            <span class="pp-muted">${escapeHtml(summary)}</span>
        </div>
        ${paramOpen ? `
        <div class="pp-lf-form">
            <label title="全书要走的楼数——最先输入的硬预算：切块分卷、切章都按它分（各卷之和必须等于它；不填默认 ${LF_DEFAULT_FLOORS}）">楼层总数
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
        </div>` : ''}
    </div>`;
}

// ---------------------------------------------------------------------------
// 材料面板（第十九轮：长线自备勾选；第二十四轮收进折叠区——材料只在每次生成时用，
// 途中收起不占页面）。记忆表格一个勾默认全量；玩法默认跟随生效中；知识库逐张清单勾
// （勾中的整表可用条目随行）；世界书自选走悬浮面板（勾选与 1.0 分开存）。
// ---------------------------------------------------------------------------
function materialsHtml(st) {
    const m = st.mats;
    const gpItems = (settings.storageItems ?? []).filter(i => i.enabled);
    const gpSel = new Set(m.gpIds ?? storageItemsInEffect().map(i => i.id));
    const gpHit = new Set(storageItemsInEffect().map(i => i.id));
    const kbLists = knowledgeLists();
    const loreN = resolveLorePicks(m.lorePicks).length;
    const inner = `
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
        <label class="pp-label" title="勾上＝这张清单的整表可用条目随长线生成随行（冷却中的跳过；长线不分抽样/全量——都按整表带），模型凡涉及该清单领域的内容必须从条目里选用；长线用条目不结冷却。清单与条目在「知识库」页签管理">知识库清单</label>
        <div class="pp-gd-selp">
            ${kbLists.map(l => {
            const coolN = l.entries.filter(e => Number(e.cooldown) > 0).length;
            const usable = l.entries.length - coolN;
            return `<label title="勾上＝整表可用 ${usable} 条随行（冷却中 ${coolN} 条跳过）"><input type="checkbox" data-lfkb="${escapeHtml(l.id)}" ${m.kbListIds.includes(l.id) ? 'checked' : ''}/> ${escapeHtml(l.name)}（${l.feed === 'full' ? '全量' : '抽样'} · 可用 ${usable} 条${coolN ? ` · ${coolN} 条冷却中` : ''}）</label>`;
        }).join('')}
        </div>` : ''}
        <div class="pp-btn-row">
            <span id="pp_lf_lore" class="menu_button" title="世界书自选（悬浮面板）：按书分组勾条目，勾中的整条原文随长线生成进材料——「照着写」的材料，与知识库「选着用」分工。不看关键词/常驻/书与条目的启用状态（勾选是唯一口径，禁用的照样能勾）；与检索命中自动去重（自选优先）。这里的勾选只管长线、与「剧情指导」第 1 步互不影响；无冷却">世界书自选（已勾 ${loreN} 条）</span>
        </div>`;
    return `
    <div class="pp-section" id="pp_lf_mats">
        <div class="pp-lf-foldhead" id="pp_lf_mfold" title="长线生成用的材料在这里勾——与「剧情指导」第 1 步互不影响；每次生成（骨架/具体化/修订/切章）都按当时的勾选现场拼。另自动随行：角色设定、检索命中的世界书、进行中剧情、历史摘要、最近对话。勾选存在本聊天里，刷新不丢、作废本长线也保留">
            <i class="fa-solid fa-chevron-${matOpen ? 'down' : 'right'}"></i>
            <b>材料</b>
            <span class="pp-muted">${escapeHtml(lfMatOverview())}</span>
        </div>
        ${matOpen ? inner : ''}
    </div>`;
}

// 材料面板的勾选变动：只就地刷新折叠头概览与世界书按钮计数（不整页重渲，勾选状态留在原地）
function refreshLfMatUi() {
    const head = document.getElementById('pp_lf_mfold');
    if (head) {
        const span = head.querySelector('.pp-muted');
        if (span) span.textContent = lfMatOverview();
    }
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
        <div class="pp-muted" style="margin-top:6px">勾上＝整条原文随长线生成进材料（照着写）。条目行只显示名字，原文悬浮可看全文；不看关键词/常驻/书与条目的启用状态——勾选是唯一口径，禁用的书与条目照样能勾；与「检索命中」自动去重（这边优先）。这里的勾选只管长线，与「剧情指导」第 1 步互不影响；无冷却</div>`;

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

// ---------------------------------------------------------------------------
// 卷卡：折叠行（第 X 卷 · 名字 · 楼数 · 徽章）＋ 展开后三页签（骨架/卷文本/章与节点），
// 同一附属区里切换、不往下摞；编辑与意见框互斥（一次一块），脏改动切换前先拦
// ---------------------------------------------------------------------------
function volCardHtml(v, i, st) {
    const ui = volUiOf(i);
    const chs = v.chapters ?? [];
    const chSum = chs.reduce((n, c) => n + c.floors, 0);
    const budgetStale = chs.length && chSum !== v.floors;
    const textStale = v.detailState === 'done' && v.skAt && v.skAt > v.textAt;
    const splitStale = chs.length && (!v.splitAt || v.textAt > v.splitAt);
    const badge = [
        v.detailState === 'done' ? `${v.anchors.length} 锚` : (DETAIL_BADGE[v.detailState] ?? ['', ''])[0],
        chs.length ? `${chs.length} 章` : '',
        v.splitState === 'error' ? `切章${SPLIT_BADGE.error[0]}` : '',
    ].filter(Boolean).join(' · ');
    return `
    <div class="pp-item pp-lf-vol">
        <div class="pp-item-main pp-lf-volhead" data-vfold="${i}" title="点开/收起本卷——里面分「骨架 / 卷文本 / 章与节点」三页切换">
            <i class="fa-solid fa-chevron-${ui.open ? 'down' : 'right'}"></i>
            <b>第 ${i + 1} 卷 · ${escapeHtml(v.title)}</b>
            <span class="pp-muted">${v.floors} 层楼</span>
            ${badge ? `<span class="pp-muted pp-lf-badge">${escapeHtml(badge)}</span>` : ''}
        </div>
        ${ui.open ? `
        <div class="pp-lf-volbody">
            <div class="pp-seg pp-lf-tabs">
                <span class="pp-seg-opt${ui.tab === 'sk' ? ' on' : ''}" data-vtab="sk" data-vi="${i}">骨架</span>
                <span class="pp-seg-opt${ui.tab === 'text' ? ' on' : ''}" data-vtab="text" data-vi="${i}">卷文本</span>
                <span class="pp-seg-opt${ui.tab === 'ch' ? ' on' : ''}" data-vtab="ch" data-vi="${i}">章与节点</span>
            </div>
            ${ui.tab === 'sk' ? skTabHtml(v, i) : ''}
            ${ui.tab === 'text' ? textTabHtml(v, i, textStale) : ''}
            ${ui.tab === 'ch' ? chTabHtml(v, i, st, budgetStale, splitStale) : ''}
        </div>` : ''}
    </div>`;
}

// 骨架页签：默认只读展示（概要/种子/楼数），点「编辑骨架」才出表单（第二十四轮用户拍板）
function skTabHtml(v, i) {
    const ui = volUiOf(i);
    if (ui.skEdit) return skEditHtml(v, i);
    if (ui.skRev) {
        return `
        <div class="pp-lf-form">
            <label class="pp-lf-grow" title="写给大模型的修订意见——只改意见涉及处（模型能看到本卷当前的卷名/楼数/概要/种子与全书骨架；楼数也能按意见改）">修订意见
                <textarea data-opin="${i}:sk" class="text_pole textarea_compact" rows="2" placeholder="例：这卷压成过渡卷，楼数减到 30，概要砍掉支线">${escapeHtml(volOpinions.get(`${i}:sk`) ?? '')}</textarea>
            </label>
        </div>
        <div class="pp-btn-row">
            <span class="menu_button" data-vskrev="${i}" title="按意见修订本卷骨架（一次调用；楼数改了楼层总数跟着各卷之和走）">修订本卷骨架</span>
            <span class="menu_button" data-vskrevx="${i}">收起</span>
        </div>`;
    }
    return `
    <div class="pp-lf-text">${escapeHtml(v.summary || '（无概要）')}</div>
    ${v.seeds && v.seeds !== '无' ? `<div class="pp-lf-text pp-muted">种子：${escapeHtml(v.seeds)}</div>` : ''}
    <div class="pp-btn-row">
        <span class="menu_button" data-vskedit="${i}" title="就地修改本卷的卷名/楼数/概要/种子，或删除本卷。楼数改了：楼层总数跟着各卷之和走；切过章的卷要重跑切章">编辑骨架</span>
        <span class="menu_button" data-vskrevgo="${i}" title="写意见让大模型改这一卷的骨架（能看到当前骨架数据与全书骨架）">按意见修订本卷</span>
    </div>`;
}

// 卷文本页签：只读全文＋锚清单一行；编辑/意见框互斥；脏改动收起走两步确认
function textTabHtml(v, i, textStale) {
    const ui = volUiOf(i);
    if (v.detailState !== 'done') {
        return `<div class="pp-muted">${v.detailState === 'error' ? `具体化失败：${escapeHtml(v.detailError)}` : v.detailState === 'run' ? '具体化中…' : '这一卷还没有卷文本——点上面的「具体化各卷」'}</div>`;
    }
    if (ui.veEdit) {
        return `
        ${textStale ? `<div class="pp-muted pp-lf-err">⚠ 概要/种子改过、卷文本没跟着动</div>` : ''}
        <textarea class="text_pole textarea_compact pp-lf-editarea" data-vetext="${i}" rows="10">${escapeHtml(v.text)}</textarea>
        <div class="pp-btn-row">
            <span class="menu_button" data-vesave="${i}" title="保存改动并收起（若已切章，章表会标过期）">保存卷文本</span>
            <span class="menu_button ${veArmVol.has(i) ? 'pp-danger-arm' : ''}" data-vecancel="${i}" title="不保存、收起编辑框${veArmVol.has(i) ? '——再点一下确认放弃改动' : '；改过内容的话会先问一句'}">${veArmVol.has(i) ? '确认放弃？' : '取消'}</span>
        </div>`;
    }
    const footer = ui.veRev ? `
        <div class="pp-lf-form">
            <label class="pp-lf-grow" title="写给大模型的修订意见——只改意见涉及处；一次只出这一卷的全文（不撞整书修订的输出上限）">修订意见
                <textarea data-opin="${i}:text" class="text_pole textarea_compact" rows="2" placeholder="例：误会提前一章收掉，加一场雨中戏">${escapeHtml(volOpinions.get(`${i}:text`) ?? '')}</textarea>
            </label>
        </div>
        <div class="pp-btn-row">
            <span class="menu_button" data-verev="${i}" title="按意见修订本卷卷文本（一次调用、只出这一卷全文）">修订本卷文本</span>
            <span class="menu_button" data-verevx="${i}">收起</span>
        </div>` : `
        <div class="pp-btn-row">
            <span class="menu_button" data-veedit="${i}" title="就地手改卷文本（改完记得重跑切章——章表按旧文本切的会过期）">编辑卷文本</span>
            <span class="menu_button" data-verevgo="${i}" title="写意见让大模型改这一卷的卷文本（一次只出这一卷）">按意见修订本卷</span>
        </div>`;
    return `
    ${textStale ? `<div class="pp-muted pp-lf-err">⚠ 概要/种子改过、卷文本没跟着动——需要就修订或重跑具体化</div>` : ''}
    <div class="pp-lf-text">${escapeHtml(v.text)}</div>
    <div class="pp-muted" title="锚是卷文本里的阶段级里程碑（切章刀口）——切章时按它下刀，平时只在这看一眼">锚（${v.anchors.length}）：${escapeHtml(v.anchors.map(a => a.title).join(' · ') || '—')}</div>
    ${footer}`;
}

// 章与节点页签：章卡（节点行＋挂载＋章文本/编辑）＋ 本卷带意见重切
function chTabHtml(v, i, st, budgetStale, splitStale) {
    const ui = volUiOf(i);
    const chs = v.chapters ?? [];
    const warns = [
        v.splitState === 'error' ? `切章失败：${escapeHtml(v.splitError)}` : '',
        budgetStale ? `⚠ 章预算合计对不上卷楼数——重切重配` : '',
        splitStale ? `⚠ 卷文本改过、章表需要重切` : '',
    ].filter(Boolean).map(t => `<div class="pp-muted pp-lf-err">${t}</div>`).join('');
    const revBox = ui.spRev ? `
        <div class="pp-lf-form">
            <label class="pp-lf-grow" title="写给大模型的重切意见——只作用于这次切章（章怎么切、节点怎么排），卷文本不动">重切意见（可选）
                <textarea data-opin="${i}:split" class="text_pole textarea_compact" rows="2" placeholder="例：别超过 2 章；节点按时间顺序排">${escapeHtml(volOpinions.get(`${i}:split`) ?? '')}</textarea>
            </label>
        </div>
        <div class="pp-btn-row">
            <span class="menu_button" data-sprev="${i}" title="带上面的意见重切本卷（旧章点亮进度按位置沿用）">按意见重切本卷</span>
            <span class="menu_button" data-sprevx="${i}">收起</span>
        </div>` : `
        <div class="pp-btn-row">
            <span class="menu_button" data-sprevgo="${i}" title="只重切这一卷，可带意见——切得不合适就在地修，不用整批重来">按意见重切本卷</span>
        </div>`;
    if (!chs.length) {
        return `
        ${warns}
        <div class="pp-muted">这一卷还没切章——点上面的「再切小」，或下面的单卷重切</div>
        ${revBox}`;
    }
    return `
    ${warns}
    ${chs.map((c, ci) => chapterCardHtml(c, i, ci, st)).join('')}
    ${revBox}`;
}

function chapterCardHtml(c, vi, ci, st) {
    const ui = volUiOf(vi);
    const open = ui.chView.has(ci);
    const editing = ui.chEdit.has(ci);
    const isMounted = st.mount && st.mount.vol === vi && st.mount.ch === ci;
    const done = c.done || (c.nodes.length > 0 && c.lit >= c.nodes.length);
    const armKey = `${vi}:${ci}`;
    return `
    <div class="pp-item pp-lf-ch ${isMounted ? 'pp-lf-ch-cur' : ''}">
        <div class="pp-item-main">
            <b>${done ? '✓ ' : ''}${escapeHtml(c.title)}</b>
            <span class="pp-muted">${c.floors} 层 · ${c.lit}/${c.nodes.length} 节点${isMounted ? ' · 执行中' : ''}</span>
        </div>
        <div class="pp-lf-nodesline">${c.nodes.map((n, ni) => `<span class="pp-lf-node ${ni < c.lit ? 'pp-lf-node-lit' : ''}" title="${escapeHtml(n.criterion)}">${ni < c.lit ? '●' : '○'}${escapeHtml(clamp(n.title, 16))}</span>`).join('')}</div>
        <div class="pp-item-ops">
            ${!isMounted ? `<span class="menu_button" data-chmount="${vi}:${ci}" title="把这一章挂进监听单位槽开始执行（若槽里有单位会被顶进退位槽；退位槽被占会拒绝，先去监听页处理）">挂载</span>` : ''}
            ${editing ? '' : `<span class="menu_button" data-chview="${vi}-${ci}">${open ? '收起章文本' : '章文本'}</span>
            <span class="menu_button" data-chedit="${vi}:${ci}" title="就地手改章文本（章挂载中改了不会跟着变——卸下再「挂载」才用新文本，点亮进度保留）">编辑章文本</span>`}
        </div>
        ${editing ? `
        <textarea class="text_pole textarea_compact pp-lf-editarea" data-chtext="${vi}:${ci}" rows="8">${escapeHtml(c.text)}</textarea>
        <div class="pp-btn-row">
            <span class="menu_button" data-chsave="${vi}:${ci}" title="保存并收起编辑框">保存章文本</span>
            <span class="menu_button ${chArm.has(armKey) ? 'pp-danger-arm' : ''}" data-chcancel="${vi}:${ci}" title="不保存、收起编辑框${chArm.has(armKey) ? '——再点一下确认放弃改动' : '；改过内容的话会先问一句'}">${chArm.has(armKey) ? '确认放弃？' : '取消'}</span>
        </div>` : (open ? `<div class="pp-lf-text">${escapeHtml(c.text)}</div>` : '')}
    </div>`;
}

// 卷文本编辑框脏检查：改过没保存＝true（收起/切换前问一道，防静默丢字）
function veDirty(container, i) {
    const v = lfState().volumes[i];
    const ta = container.querySelector(`[data-vetext="${i}"]`);
    return !!(v && ta && ta.value !== v.text);
}

// 骨架编辑表单脏检查（同上：卷名/楼数/概要/种子任一改过＝true）
function skDirty(container, i) {
    const v = lfState().volumes[i];
    const t = container.querySelector(`[data-vsktitle="${i}"]`);
    if (!v || !t) return false;
    const floors = Math.round(Number(container.querySelector(`[data-vskfloors="${i}"]`)?.value));
    const summary = container.querySelector(`[data-vsksum="${i}"]`)?.value ?? '';
    const seeds = container.querySelector(`[data-vskseeds="${i}"]`)?.value ?? '';
    return t.value !== v.title || floors !== v.floors || summary !== v.summary || seeds !== v.seeds;
}

// 章文本编辑脏检查（同上）
function chDirtyAt(container, vi, ci) {
    const c = lfState().volumes[vi]?.chapters?.[ci];
    const ta = container.querySelector(`[data-chtext="${vi}:${ci}"]`);
    return !!(c && ta && ta.value !== c.text);
}

// 本卷任意编辑块有没有没保存的改动（切页签/收起卷前统一拦一道）
function editDirtyAnywhere(container, i) {
    const ui = volUiOf(i);
    if (ui.veEdit && veDirty(container, i)) return true;
    if (ui.skEdit && skDirty(container, i)) return true;
    for (const ci of ui.chEdit) if (chDirtyAt(container, i, ci)) return true;
    return false;
}

// 任何卷的编辑框开着（批量生成中就地重刷的守门——重刷会拿状态旧值重建表单，正打一半的字不能丢）
function anyEditOpen() {
    for (const [, ui] of volUi) if (ui.skEdit || ui.veEdit || ui.chEdit.size) return true;
    return false;
}

// 取消编辑卷文本：内容没动一键收起；改过内容两步确认（4 秒回退）防手滑丢字。
// Armed 的视觉变化固定落在「取消」按钮上——不管这次是从哪颗按钮触发的收起
function cancelVeEdit(container, i) {
    if (veDirty(container, i) && !veArmVol.has(i)) {
        veArmVol.add(i);
        const b = container.querySelector(`[data-vecancel="${i}"]`);
        if (b) { b.textContent = '确认放弃？'; b.classList.add('pp-danger-arm'); }
        setTimeout(() => {
            veArmVol.delete(i);
            const b2 = container.querySelector(`[data-vecancel="${i}"]`);
            if (b2) { b2.textContent = '取消'; b2.classList.remove('pp-danger-arm'); }
        }, 4000);
        return;
    }
    veArmVol.delete(i);
    volUiOf(i).veEdit = false;
    renderTab(container);
}

// 取消骨架编辑：同款两步确认
function cancelSkEdit(container, i) {
    if (skDirty(container, i) && !skArmVol.has(i)) {
        skArmVol.add(i);
        const b = container.querySelector(`[data-vskcancel="${i}"]`);
        if (b) { b.textContent = '确认放弃？'; b.classList.add('pp-danger-arm'); }
        setTimeout(() => {
            skArmVol.delete(i);
            const b2 = container.querySelector(`[data-vskcancel="${i}"]`);
            if (b2) { b2.textContent = '取消'; b2.classList.remove('pp-danger-arm'); }
        }, 4000);
        return;
    }
    skArmVol.delete(i);
    volUiOf(i).skEdit = false;
    renderTab(container);
}

// 取消章文本编辑：同款两步确认
function cancelChEdit(container, vi, ci) {
    const armKey = `${vi}:${ci}`;
    if (chDirtyAt(container, vi, ci) && !chArm.has(armKey)) {
        chArm.add(armKey);
        const b = container.querySelector(`[data-chcancel="${armKey}"]`);
        if (b) { b.textContent = '确认放弃？'; b.classList.add('pp-danger-arm'); }
        setTimeout(() => {
            chArm.delete(armKey);
            const b2 = container.querySelector(`[data-chcancel="${armKey}"]`);
            if (b2) { b2.textContent = '取消'; b2.classList.remove('pp-danger-arm'); }
        }, 4000);
        return;
    }
    chArm.delete(armKey);
    volUiOf(vi).chEdit.delete(ci);
    renderTab(container);
}

// 骨架就地编辑表单（第二十轮起；第二十四轮起默认只读、点「编辑骨架」才出现，输入框带主题样式）
function skEditHtml(v, i) {
    const armed = delArmVol.has(i);
    return `
    <div class="pp-lf-form">
        <label title="本卷的名字">卷名
            <input type="text" class="text_pole" data-vsktitle="${i}" value="${escapeHtml(v.title)}" />
        </label>
        <label title="本卷的楼数预算（一章至少 ${LF_MIN_CHAPTER_FLOORS} 层楼、每卷至少要能切出一章）。改了之后：楼层总数＝各卷之和；切过章的卷要重跑切章">楼数
            <input type="number" class="text_pole" data-vskfloors="${i}" min="${LF_MIN_CHAPTER_FLOORS}" step="5" value="${v.floors}" />
        </label>
    </div>
    <div class="pp-lf-form">
        <label class="pp-lf-grow" title="这卷讲什么、从哪推进到哪、主要张力、出场角色——具体化各卷按它展开；末尾一句体量理由（重在哪/轻在哪）">概要
            <textarea data-vsksum="${i}" class="text_pole textarea_compact" rows="4">${escapeHtml(v.summary)}</textarea>
        </label>
    </div>
    <div class="pp-lf-form">
        <label class="pp-lf-grow" title="本卷埋设的伏笔与新要素（埋什么、预计哪里收）；没有写「无」">种子
            <textarea data-vskseeds="${i}" class="text_pole textarea_compact" rows="2">${escapeHtml(v.seeds)}</textarea>
        </label>
    </div>
    <div class="pp-btn-row">
        <span class="menu_button" data-vsksave="${i}" title="写回本卷骨架并重算楼层总数（各卷之和）">保存</span>
        <span class="menu_button" data-vskcancel="${i}" title="不保存、收起编辑框（改过内容会先问一句）">取消</span>
        <span class="menu_button ${armed ? 'pp-danger-arm' : ''}" data-vdel="${i}" title="删掉这一卷（两步确认；正在执行的章挂在这一卷里时先去「监听」页卸下）">${armed ? '确认删除？' : '删除本卷'}</span>
    </div>`;
}

// 保存骨架编辑：楼层总数跟着各卷之和走；切过章的卷改楼数⇒回「未切章」待重切（旧章表保留供沿用进度）
function saveVolSkeleton(container, i) {
    const s = lfState();
    const v = s.volumes[i];
    if (!v) return;
    const title = String(container.querySelector(`[data-vsktitle="${i}"]`)?.value ?? '').trim().slice(0, 120);
    const floors = Math.round(Number(container.querySelector(`[data-vskfloors="${i}"]`)?.value));
    const summary = String(container.querySelector(`[data-vsksum="${i}"]`)?.value ?? '').trim();
    const seeds = String(container.querySelector(`[data-vskseeds="${i}"]`)?.value ?? '').trim();
    if (!title) return toastr.warning('卷名不能为空');
    if (!Number.isFinite(floors) || floors < LF_MIN_CHAPTER_FLOORS) return toastr.warning(`每卷至少 ${LF_MIN_CHAPTER_FLOORS} 层楼（一章的最低楼数）`);
    const floorsChanged = floors !== v.floors;
    const structChanged = title !== v.title || summary !== v.summary || seeds !== v.seeds;
    v.title = title;
    v.summary = summary;
    v.seeds = seeds;
    v.floors = floors;
    if (floorsChanged || structChanged) v.skAt = Date.now();
    if (floorsChanged && v.chapters?.length) v.splitState = 'none';
    s.totalFloors = s.volumes.reduce((n, x) => n + x.floors, 0);
    persistLf();
    volUiOf(i).skEdit = false;
    renderTab(container);
    const bits = [`已保存（楼层总数现为 ${s.totalFloors} 层＝各卷之和）`];
    if (floorsChanged && v.chapters?.length) bits.push('本卷切过章：楼数变了，去「章与节点」页签重切重配章预算');
    if (structChanged && v.detailState === 'done') bits.push('概要/种子改了、卷文本没跟着动——需要就修订或重跑具体化');
    if (s.minFloors && s.totalFloors < s.minFloors) bits.push(`保底楼数 ${s.minFloors} 层高于总数——保底只随下次「生成骨架」发给模型`);
    toastr.success(bits.join('；'));
}

// 删除本卷（两步确认）：挂载中拒绝、只剩一卷拒绝（要重来走「重新生成骨架」）；删前卷后挂载索引顺移
function delVolume(container, i, btn) {
    const s = lfState();
    if (!delArmVol.has(i)) {
        delArmVol.add(i);
        if (btn) { btn.textContent = '确认删除？'; btn.classList.add('pp-danger-arm'); }
        setTimeout(() => {
            delArmVol.delete(i);
            const b = container.querySelector(`[data-vdel="${i}"]`);
            if (b) { b.textContent = '删除本卷'; b.classList.remove('pp-danger-arm'); }
        }, 4000);
        return;
    }
    delArmVol.delete(i);
    if (!s.volumes[i]) return;
    if (s.volumes.length <= 1) return toastr.warning('只剩这一卷——要重来走「重新生成骨架」');
    if (s.mount && s.mount.vol === i) return toastr.warning('这一卷里有正在执行的章——先到「监听」页卸下单位再删');
    s.volumes.splice(i, 1);
    if (s.mount && s.mount.vol > i) s.mount.vol -= 1;
    s.totalFloors = s.volumes.reduce((n, x) => n + x.floors, 0);
    persistLf();
    volUi.clear();   // 卷号整体前移，卷内 UI 状态跟着作废
    toastr.success(`已删除（剩 ${s.volumes.length} 卷、楼层总数 ${s.totalFloors} 层）`);
    renderTab(container);
}

// 执行区（第二十四轮瘦身）：只留当前挂载章＋接续按钮＋一行总进度；章卡在各卷「章与节点」页签
function execHtml(st, stats, next) {
    const mount = st.mount;
    const curCh = mount ? st.volumes[mount.vol]?.chapters?.[mount.ch] : null;
    const curDone = curCh ? curCh.done || curCh.lit >= curCh.nodes.length : false;
    return `
    <div class="pp-section" id="pp_lf_exec">
        <div class="pp-gd-layhead"><b>执行</b><span class="pp-muted">章 ${stats.done}/${stats.chapters} · 节点 ${stats.lit}/${stats.nodes}</span></div>
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
        </div>` : `<div class="pp-muted">还没挂载章——去各卷「章与节点」页签点某一章的「挂载」开始执行（挂进监听单位槽；扮演模型看不到章文本）。</div>`}
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
    container.querySelector('#pp_lf_prov')?.addEventListener('change', e => { providerId = e.target.value; updateBusyMeta(); });

    // 折叠头：参数/材料
    container.querySelector('#pp_lf_pfold')?.addEventListener('click', () => { paramOpen = !paramOpen; renderTab(container); });
    container.querySelector('#pp_lf_mfold')?.addEventListener('click', () => { matOpen = !matOpen; renderTab(container); });

    // 整书修订意见草稿：输入即留会话底
    const opEl = container.querySelector('#pp_lf_opinion');
    opEl?.addEventListener('input', () => { lfOpinion = opEl.value; });

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
        if (s.stage !== 'none') return toastr.info('要从头重来先点「重新生成骨架」回参数');
        const u = usageCollector();
        startBusy('skeleton');
        renderTab(container);
        try {
            await runLfSkeleton({
                totalFloors: s.totalFloors,
                minFloors: s.minFloors,
                idea: s.idea,
                newChars: s.newChars,
                provider: providerFromId(providerId),
                signal: lfBusy.ctl.signal,
                onUsage: u.onUsage,
                onDelta: len => setBusyNote(`已收 ${len.toLocaleString()} 字`),
                onReasoning: t => { busyThink = t.length; },
            });
            paramOpen = false;
            matOpen = false;
            volUi.clear();
            toastr.success(`骨架已定：${lfState().totalFloors} 层楼分 ${lfState().volumes.length} 卷；${u.line()}`);
        } catch (err) {
            if (err?.name !== 'AbortError') toastr.error(`生成骨架失败：${err?.message ?? err}`);
            markErr(err);
            if (lfState().stage !== 'none' && lfState().volumes.length) toastr.info('这次生成没成——原来的长线已恢复原样');
        } finally {
            endBusy();
            renderTab(container);
        }
    });

    container.querySelector('#pp_lf_detail')?.addEventListener('click', function () {
        if (lfState().stage === 'none') return toastr.info('先生成骨架——操作条第一颗按钮（参数/材料下面那排）');
        runBatch(container, 'detail');
    });
    container.querySelector('#pp_lf_split')?.addEventListener('click', function () {
        if (!lfState().volumes.some(v => v.detailState === 'done')) return toastr.info('先「具体化各卷」出卷文本，才能切章');
        runBatch(container, 'split');
    });

    container.querySelector('#pp_lf_reskel')?.addEventListener('click', () => backToParams(container));

    container.querySelector('#pp_lf_revise')?.addEventListener('click', function () {
        if (lfState().stage === 'none') return toastr.info('先生成骨架——骨架和卷文本都能按意见修订');
        revOpen = !revOpen;
        renderTab(container);
    });

    container.querySelector('#pp_lf_revise_go')?.addEventListener('click', async function () {
        if (lfBusy) return toastr.warning('有长线生成还在跑（先中断或等它完成）');
        const s = lfState();
        const opinion = String(container.querySelector('#pp_lf_opinion')?.value ?? '').trim();
        if (!opinion) return toastr.warning('先写修改意见——要换方向走「重新生成骨架」');
        const u = usageCollector();
        const common = {
            provider: providerFromId(providerId),
            signal: null,
            onUsage: u.onUsage,
            onDelta: len => setBusyNote(`已收 ${len.toLocaleString()} 字`),
            onReasoning: t => { busyThink = t.length; },
        };
        if (s.stage === 'skeleton') {
            startBusy('revsk');
            common.signal = lfBusy.ctl.signal;
            renderTab(container);
            try {
                const r = await runLfSkeletonRevise({ opinion, ...common });
                if (!r.updated) toastr.warning(`一处都没改成——全部卷原样带回；重试或把意见写具体些；${u.line()}`);
                else toastr.success(`已按意见改了 ${r.updated} 卷骨架${r.unchanged ? `、${r.unchanged} 卷未动` : ''}（楼数改过的卷记得去「章与节点」页签重切）；${u.line()}`);
            } catch (err) {
                if (err?.name !== 'AbortError') toastr.error(`修订失败：${err?.message ?? err}`);
                markErr(err);
            } finally {
                endBusy();
                renderTab(container);
            }
            return;
        }
        startBusy('revise');
        common.signal = lfBusy.ctl.signal;
        renderTab(container);
        // 逐卷执行的实时进度（第二十八轮）：已完成 N/M 卷＋流式字数逐卷累计，每卷落定重刷卷卡
        const lens = new Map();
        let settledN = 0, totalN = 0;
        const chars = () => { let n = 0; for (const x of lens.values()) n += x; return n; };
        const note = () => `已完成 ${settledN}/${totalN} 卷 · 已收 ${chars().toLocaleString()} 字`;
        common.onDelta = (vi, len) => { lens.set(vi, Math.max(lens.get(vi) ?? 0, len)); setBusyNote(note()); };
        common.onProgress = p => { settledN = p.settled; totalN = p.total; rerenderVols(container); setBusyNote(note()); };
        try {
            const r = await runLfRevise({ opinion, ...common });
            if (!r.updated) {
                const why = r.failed?.length
                    ? `${r.failed.length} 卷调用失败（${r.failed.map(f => `第 ${f.vol + 1} 卷`).join('、')}）、其余原样带回`
                    : r.keptNoText ? `有 ${r.keptNoText} 卷没给正文、其余原样带回` : '全部卷都被原样带回';
                toastr.warning(`一处都没改成：${why}——重试一次，或去各卷「卷文本」页签按卷修订；${u.line()}`);
            } else {
                const bits = [`已按意见改了 ${r.updated} 卷（章表若已生成会标过期）`];
                if (r.unchanged) bits.push(`${r.unchanged} 卷原样带出——没被意见点名的卷属正常`);
                if (r.keptNoText) bits.push(`${r.keptNoText} 卷没给正文、保留原文`);
                if (r.failed?.length) bits.push(`${r.failed.length} 卷失败（${r.failed.map(f => `第 ${f.vol + 1} 卷`).join('、')}，重试或用各卷「卷文本」页签的修订）`);
                toastr.success(`${bits.join('；')}；${u.line()}`);
            }
        } catch (err) {
            if (err?.name !== 'AbortError') toastr.error(`修订失败：${err?.message ?? err}`);
            markErr(err);
        } finally {
            endBusy();
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
        volUi.clear();
        revOpen = false;
        paramOpen = true;
        matOpen = true;
        toastr.success('本长线已作废（监听侧挂载与 1.0 数据不动）');
        renderTab(container);
    });

    bindVolCards(container);
    wireExec(container);
}

// 卷内按钮统一接线（折叠/页签/骨架编辑与修订/卷文本编辑与修订/章文本与重切/意见草稿）。
// 批量生成中每卷落定会就地重刷卷卡区，按钮要能重接；编辑与意见框互斥、脏改动切换前先拦
function bindVolCards(container) {
    container.querySelectorAll('[data-vfold]').forEach(el => el.addEventListener('click', () => {
        const i = Number(el.dataset.vfold);
        const ui = volUiOf(i);
        if (!ui.open) { ui.open = true; return renderTab(container); }
        if (editDirtyAnywhere(container, i)) return toastr.warning('有没保存的改动——先保存或取消');
        ui.open = false;
        renderTab(container);
    }));
    container.querySelectorAll('[data-vtab]').forEach(el => el.addEventListener('click', () => {
        const i = Number(el.dataset.vi);
        const ui = volUiOf(i);
        if (ui.tab === el.dataset.vtab) return;
        if (editDirtyAnywhere(container, i)) return toastr.warning('有没保存的改动——先保存或取消');
        closeInlineBoxes(ui);
        ui.tab = el.dataset.vtab;
        renderTab(container);
    }));

    // 骨架页签
    container.querySelectorAll('[data-vskedit]').forEach(el => el.addEventListener('click', () => {
        const i = Number(el.dataset.vskedit);
        const ui = volUiOf(i);
        ui.skRev = false;
        ui.skEdit = true;
        renderTab(container);
    }));
    container.querySelectorAll('[data-vskcancel]').forEach(el => el.addEventListener('click', () => cancelSkEdit(container, Number(el.dataset.vskcancel))));
    container.querySelectorAll('[data-vsksave]').forEach(el => el.addEventListener('click', () => saveVolSkeleton(container, Number(el.dataset.vsksave))));
    container.querySelectorAll('[data-vdel]').forEach(el => el.addEventListener('click', function () { delVolume(container, Number(el.dataset.vdel), this); }));
    container.querySelectorAll('[data-vskrevgo]').forEach(el => el.addEventListener('click', () => {
        const i = Number(el.dataset.vskrevgo);
        const ui = volUiOf(i);
        if (ui.skEdit && skDirty(container, i)) return toastr.warning('骨架编辑里有没保存的改动——先点「保存」或「取消」');
        ui.skEdit = false;
        ui.skRev = true;
        renderTab(container);
    }));
    container.querySelectorAll('[data-vskrevx]').forEach(el => el.addEventListener('click', () => {
        volUiOf(Number(el.dataset.vskrevx)).skRev = false;
        renderTab(container);
    }));
    container.querySelectorAll('[data-vskrev]').forEach(el => el.addEventListener('click', () => {
        const i = Number(el.dataset.vskrev);
        runVolOp(container, 'volsk', i, volOpinions.get(`${i}:sk`) ?? '');
    }));

    // 卷文本页签
    container.querySelectorAll('[data-veedit]').forEach(el => el.addEventListener('click', () => {
        const i = Number(el.dataset.veedit);
        const ui = volUiOf(i);
        ui.veRev = false;
        ui.veEdit = true;
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
        veArmVol.delete(i);
        volUiOf(i).veEdit = false;
        renderTab(container);
    }));
    container.querySelectorAll('[data-vecancel]').forEach(el => el.addEventListener('click', () => cancelVeEdit(container, Number(el.dataset.vecancel))));
    container.querySelectorAll('[data-verevgo]').forEach(el => el.addEventListener('click', () => {
        const i = Number(el.dataset.verevgo);
        const ui = volUiOf(i);
        if (ui.veEdit && veDirty(container, i)) return toastr.warning('卷文本编辑里有没保存的改动——先点「保存卷文本」或「取消」');
        ui.veEdit = false;
        ui.veRev = true;
        renderTab(container);
    }));
    container.querySelectorAll('[data-verevx]').forEach(el => el.addEventListener('click', () => {
        volUiOf(Number(el.dataset.verevx)).veRev = false;
        renderTab(container);
    }));
    container.querySelectorAll('[data-verev]').forEach(el => el.addEventListener('click', () => {
        const i = Number(el.dataset.verev);
        runVolOp(container, 'voltext', i, volOpinions.get(`${i}:text`) ?? '');
    }));

    // 章与节点页签
    container.querySelectorAll('[data-chview]').forEach(el => el.addEventListener('click', () => {
        const [vi, ci] = el.dataset.chview.split('-').map(Number);
        const ui = volUiOf(vi);
        ui.chView.has(ci) ? ui.chView.delete(ci) : ui.chView.add(ci);
        renderTab(container);
    }));
    container.querySelectorAll('[data-chedit]').forEach(el => el.addEventListener('click', () => {
        const [vi, ci] = el.dataset.chedit.split(':').map(Number);
        volUiOf(vi).chEdit.add(ci);
        renderTab(container);
    }));
    container.querySelectorAll('[data-chsave]').forEach(el => el.addEventListener('click', () => {
        const [vi, ci] = el.dataset.chsave.split(':').map(Number);
        const ta = container.querySelector(`[data-chtext="${vi}:${ci}"]`);
        const s = lfState();
        const c = s.volumes[vi]?.chapters?.[ci];
        if (c && ta) {
            c.text = ta.value.trim();
            persistLf();
            const mounted = s.mount && s.mount.vol === vi && s.mount.ch === ci;
            toastr.success(`章文本已保存${mounted ? '——监听里挂着的还是旧文本，卸下再「挂载」才用新的（点亮进度保留）' : ''}`);
        }
        chArm.delete(`${vi}:${ci}`);
        volUiOf(vi).chEdit.delete(ci);
        renderTab(container);
    }));
    container.querySelectorAll('[data-chcancel]').forEach(el => el.addEventListener('click', () => {
        const [vi, ci] = el.dataset.chcancel.split(':').map(Number);
        cancelChEdit(container, vi, ci);
    }));
    container.querySelectorAll('[data-sprevgo]').forEach(el => el.addEventListener('click', () => {
        volUiOf(Number(el.dataset.sprevgo)).spRev = true;
        renderTab(container);
    }));
    container.querySelectorAll('[data-sprevx]').forEach(el => el.addEventListener('click', () => {
        volUiOf(Number(el.dataset.sprevx)).spRev = false;
        renderTab(container);
    }));
    container.querySelectorAll('[data-sprev]').forEach(el => el.addEventListener('click', () => {
        const i = Number(el.dataset.sprev);
        runVolOp(container, 'volsplit', i, volOpinions.get(`${i}:split`) ?? '');
    }));

    // 单卷意见草稿：输入即留会话底（批量刷新/整页重渲不丢）
    container.querySelectorAll('[data-opin]').forEach(ta => ta.addEventListener('input', () => { volOpinions.set(ta.dataset.opin, ta.value); }));
}

// 执行区按钮单独接线：监听每轮判定后执行区与卷卡会被局部重建（不打断用户打字），按钮要跟着重接
function wireExec(container) {
    container.querySelectorAll('[data-chmount]').forEach(el => el.addEventListener('click', () => {
        const [vi, ci] = el.dataset.chmount.split(':').map(Number);
        const r = mountChapter(vi, ci);
        if (r.ok) toastr.success(`已挂载：第 ${vi + 1} 卷「${lfState().volumes[vi].chapters[ci].title}」——监听将按节点逐轮判定`);
        else toastr.warning(r.reason);
        renderTab(container);
    }));
}

// busy 横幅的实时字样（节流 150ms 一拍——流式回调很密，DOM 不必跟着逐块跳）
function setBusyNote(t) {
    const now = Date.now();
    if (now - busyLast < 150) return;
    busyLast = now;
    const el = document.getElementById('pp_lf_busynote');
    if (el) el.textContent = t;
}

// 批量步逐卷落定后就地重刷卷卡区（徽章跟着变「已具体化/失败」）；用户开着编辑表单时跳过——
// 重刷会拿状态里的旧值重建表单，正打一半的字不能丢
function rerenderVols(container) {
    if (anyEditOpen()) return;
    const el = container.querySelector('#pp_lf_vols');
    if (!el) return;
    const st = lfState();
    el.innerHTML = st.volumes.map((v, i) => volCardHtml(v, i, st)).join('');
    bindVolCards(container);
    wireExec(container);
}

// 批量步（具体化 / 再切小）共用：并发跑、单卷失败不拖垮其余、逐卷留下失败原因；
// 流式字数逐卷累计＋每卷落定重刷卷卡徽章（第二十轮：生成中不再是黑盒）
async function runBatch(container, kind) {
    if (lfBusy) return toastr.warning('有长线生成还在跑（先中断或等它完成）');
    const u = usageCollector();
    startBusy(kind);
    renderTab(container);
    const lens = new Map();          // 卷号 → 已收字数（流式回调给的是累计值，取各卷最大）
    let settledN = null, totalN = null;
    const chars = () => { let n = 0; for (const x of lens.values()) n += x; return n; };
    const note = () => `${totalN != null ? `已完成 ${settledN}/${totalN} 卷 · ` : ''}已收 ${chars().toLocaleString()} 字`;
    const opts = {
        provider: providerFromId(providerId),
        signal: lfBusy.ctl.signal,
        onUsage: u.onUsage,
        onReasoning: t => { busyThink = t.length; },
        onDelta: (vi, len) => { lens.set(vi, Math.max(lens.get(vi) ?? 0, len)); setBusyNote(note()); },
        onProgress: p => { settledN = p.settled; totalN = p.total; rerenderVols(container); setBusyNote(note()); },
    };
    try {
        const r = kind === 'detail' ? await runLfDetailBatch(opts) : await runLfSplitBatch(opts);
        const name = kind === 'detail' ? '具体化' : '切章';
        if (!r.failed.length) toastr.success(`${name}完成 ${r.done} 卷；${u.line()}`);
        else {
            toastr.warning(`${name}完成 ${r.done} 卷、失败 ${r.failed.length} 卷（失败原因在对应卷的页签里，可重试——已成的卷都已保存，再跑只补失败卷）；${u.line()}`);
            const s = lfState();
            s.error = r.failed.map(f => `第 ${f.vol + 1} 卷：${clamp(f.reason, 80)}`).join('；');
            persistLf();
        }
    } catch (err) {
        if (err?.name !== 'AbortError') toastr.error(`失败：${err?.message ?? err}`);
        markErr(err);
    } finally {
        endBusy();
        renderTab(container);
    }
}

// 单卷操作（修订本卷骨架 / 修订本卷文本 / 按意见重切本卷）共用骨架：busy＋流式计数＋就地收起意见框
async function runVolOp(container, kind, i, opinion) {
    if (!String(opinion).trim() && kind !== 'volsplit') return toastr.warning('先写修订意见');
    if (lfBusy) return toastr.warning('有长线生成还在跑（先中断或等它完成）');
    const u = usageCollector();
    startBusy(kind);
    renderTab(container);
    try {
        const common = {
            provider: providerFromId(providerId),
            signal: lfBusy.ctl.signal,
            onUsage: u.onUsage,
            onDelta: kind === 'volsplit'
                ? (_vi, len) => setBusyNote(`已收 ${len.toLocaleString()} 字`)   // 单卷切章的 onDelta 带 (vi,len)
                : len => setBusyNote(`已收 ${len.toLocaleString()} 字`),
            onReasoning: t => { busyThink = t.length; },
        };
        if (kind === 'volsk') {
            const r = await runLfVolSkeletonRevise(i, { opinion, ...common });
            const bits = [];
            if (r.structChanged) bits.push('骨架字段已改');
            if (r.floorsChanged) bits.push('楼数已改（楼层总数跟着各卷之和走；切过章的卷要重切）');
            if (!bits.length) bits.push('模型原样带回、没改');
            toastr.success(`第 ${i + 1} 卷：${bits.join('；')}；${u.line()}`);
            volUiOf(i).skRev = false;
        } else if (kind === 'voltext') {
            await runLfVolTextRevise(i, { opinion, ...common });
            toastr.success(`第 ${i + 1} 卷文本已按意见修订（若已切章，章表标过期）；${u.line()}`);
            volUiOf(i).veRev = false;
        } else {
            await runLfVolSplit(i, {
                opinion,
                ...common,
                onProgress: p => setBusyNote(`已完成 ${p.settled}/${p.total} 卷`),
            });
            toastr.success(`第 ${i + 1} 卷已重切（旧章点亮进度按位置沿用）；${u.line()}`);
            volUiOf(i).spRev = false;
            volUiOf(i).tab = 'ch';
        }
    } catch (err) {
        if (err?.name !== 'AbortError') toastr.error(`失败：${err?.message ?? err}`);
        markErr(err);
    } finally {
        endBusy();
        renderTab(container);
    }
}

function markErr(err) {
    if (!err || err?.name === 'AbortError') return;
    const s = lfState();
    s.error = String(err?.message ?? err);
    persistLf();
}

// 重新生成骨架＝回参数表单（参数与想法已留底，改完直接再点「生成骨架」）；
// 旧书整份备份（第二十四轮）——新骨架生成失败/被中断自动恢复，不再一按就丢
function backToParams(container) {
    stashLfRegenBackup();
    const s = lfState();
    s.stage = 'none';
    s.volumes = [];
    s.mount = null;
    s.materialNote = '';
    s.createdAt = 0;
    s.error = '';
    persistLf();
    volUi.clear();
    revOpen = false;
    paramOpen = true;
    toastr.info('已回到参数（楼层/保底/新角色/想法都留着；旧书已备份——生成失败会自动恢复）');
    renderTab(container);
}

// 监听每轮判定后：长线页开着就同步点亮数并局部刷新执行区与卷卡（不打断用户在输入框里打字）；
// 有编辑框开着时跳过卷卡重刷（防丢输入），执行区没有输入框、照常刷
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
    if (!anyEditOpen()) {
        const vols = document.getElementById('pp_lf_vols');
        if (vols) {
            vols.innerHTML = st.volumes.map((v, i) => volCardHtml(v, i, st)).join('');
            bindVolCards(vols.parentElement ?? document);
            wireExec(vols.parentElement ?? document);
        }
    }
    const ops = root.querySelector('.pp-item-ops .pp-muted');
    if (ops && stats.chapters) ops.textContent = `章 ${stats.done}/${stats.chapters} · 节点 ${stats.lit}/${stats.nodes}`;
});
