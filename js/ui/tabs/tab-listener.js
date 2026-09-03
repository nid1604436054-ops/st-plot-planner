// 监听页签（2.0 新页签）：状态条 / 当前单位区 / 本轮指导区 / 旋钮区 四块 + 留痕折叠按钮（悬浮窗）。
// 面板只做展示与低频操作；逐轮判定循环在 js/listener.js，写完一轮派发 pp-listener-updated，
// 本页签挂着的时候就地刷新（不在 DOM 里的事件直接丢弃，下次激活重渲染）。
import { settings, save } from "../../settings.js";
import { escapeHtml, clamp } from "../../utils.js";
import { resolveLorePicks, scanLorebooks, buildLoreContext } from "../../lorebook.js";
import { chatEnabledBookIds, chatBookEnabled, setChatBookEnabled, collectRecentChat, formatChatLog } from "../../context.js";
import { memoryState } from "../../memoryTable.js";   // 判定材料区的记忆挑选器（第三十七轮）：读镜像表与标签
// 监听槽一动就对一次长线账本（listener.js 不能反向引 longform.js——longform 已经引了监听，只能在界面层搭桥）
import { syncLfProgress, scheduleReentryFor, rollbackLfChapterOf } from "../../longform.js";
import {
    listenerState, listenerCfg, listenerProvider, listenerModeLabel, persistListener,
    runListenerRound, resumeListener, setListenerEnabled, setListenerHold, manualLitCurrentNode, rollbackOneNode,
    opUnmountUnit, opRecallSidelined, opDiscardSidelined, lastListenerPrompt,
    clearListenerHalt, haltHintText, limitFloors, formatFloors,
} from "../../listener.js";
import { collectFloorsFromChat } from "../../listener.js";
import { outfitState, outfitRemaining, setOutfitMode, setOutfitFloors, withdrawOutfit } from "../../outfit.js";

let traceWinOpen = false;   // 留痕悬浮窗开着（跨页签会话记忆）
let reportOpen = false;     // 「检查报告」折叠区开着（会话内记忆——新一轮重渲染不强迫收起，用户点开的就保持）

const SOURCE_BADGE = { manual: '手动导入', plan10: '剧情规划导入', longform: '长线章' };
// 「返回上一节点」按钮的提示与渲染（第五十六轮）：误判达成的手动纠错口，在岗（未演完）与已演完两个分支共用
const NODEBACK_TIP = '误判达成的手动纠错：把最近点亮的节点退回待判——模型把还没演到的节点错判成达成、或手滑点了「标记达成」时用。点了以后节点数减一、注入槽里的旧方向清空，下一轮判定对这个节点重新跑；剧情重新演到它会再次点亮。可连点退多步（一次一个节点）。长线章会同步把长线页的进度账倒回去';
const NODEBACK_BTN = `<span id="pp_ls_nodeback" class="menu_button" title="${NODEBACK_TIP}">返回上一节点</span>`;
// 留痕来源标签（2026-09-02 三来源；同日混合重编入池）：换装记录来自 outfit.js、混合重编来自 mix.js；
// 判定轮的标签在 listener.js 落账时写
const TRACE_SRC_LABEL = { plan: '普通剧情规划', longform: '长线剧情', outfit: '换装', mix: '混合重编' };

// 回归判定的偏离三档（第三十三轮）：措辞给用户看，不照搬模型内部词
const DEV_LABEL = { on_track: '没偏——剧情仍在规划轨迹上', minor: '偏了，但能自然拉回', major: '⚠ 偏大了——继续演会损坏后续章节的安排' };

// 材料清单一行（第三十三轮透明化；第四十三轮改口径）：留痕里的 materials 小账拼成大白话。
// 例行轮的 世界书常驻 X 条（loreAlways）＝监听页三按钮「常驻」档；重挂单的 世界书自选 X 条
// （lorePicks）＝重挂单手选——两代留痕字段并存，按有啥显啥（旧留痕的 lorePicks 照显不误）
function materialsLine(m) {
    if (!m) return '';
    const parts = [];
    if (m.window) parts.push(`五章窗口 ${m.window}（${Number(m.windowChars || 0).toLocaleString()} 字）`);
    else parts.push(m.light ? '轻量检查（无单位）' : `单位全文 ${Number(m.unitChars || 0).toLocaleString()} 字`);
    if (!m.light) parts.push(`节点 ${m.nodeIdx ?? 0}/${m.nodesTotal ?? 0}`);
    if (m.loreAlways != null) {
        parts.push(Number(m.loreAlways) > 0
            ? `世界书常驻 ${m.loreAlways} 条（${Number(m.loreAlwaysChars || 0).toLocaleString()} 字）`
            : '世界书常驻 未设');
    } else {
        parts.push(Number(m.lorePicks) > 0 ? `世界书自选 ${m.lorePicks} 条（${Number(m.picksChars || 0).toLocaleString()} 字）` : '世界书自选 未勾');
    }
    if (m.floors) parts.push(`楼层 ${m.floors.first}-${m.floors.last}（${m.floors.count} 层${m.floorsLimited ? ' · 限最近范围' : ''}）`);
    else parts.push('楼层 无');
    // 检索行只对有这个账的留痕显示（例行轮有；重挂单第四十三轮撤检索、新留痕没有这个键，
    // 旧留痕的照显；null＝检索关、数字＝开了的命中数）
    if (m.loreHits !== undefined) parts.push(m.loreHits == null ? '世界书检索 关' : `世界书命中 ${m.loreHits} 条`);
    // 第三十七轮起 memory 记字数（全停用＝0）；旧留痕是布尔，兼容显示
    parts.push(typeof m.memory === 'number'
        ? (m.memory > 0 ? `记忆表 ${m.memory.toLocaleString()} 字` : '记忆表 不带')
        : (m.memory ? '记忆表 已带' : '记忆表 关'));
    return parts.join(' · ');
}

function fmtTime(at) {
    const d = new Date(Number(at) || 0);
    const pad = n => String(n).padStart(2, '0');
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// 最新一条判定留痕记录（指导区与问题区都从它读）——换装（mode=outfit）与混合重编（mode=mix）
// 不是判定轮，删楼回退（mode=rollback）是纯账本操作，指导区不该拿它们当「本轮」显示，
// 跳过取第一条判定记录
function lastTrace(state) {
    if (!Array.isArray(state.trace)) return null;
    return state.trace.find(r => r?.mode !== 'outfit' && r?.mode !== 'mix' && r?.mode !== 'rollback') ?? null;
}

// 四项小结一行（页内静默轮/留痕共用口径）：无发现的项亮「无」、有发现的写实际发现
function lightChecksLine(f = {}) {
    const ooc = f.ooc?.found ? `OOC×${f.ooc.items?.length ?? 1}` : 'OOC 无';
    const plot = f.plotRepeat?.found ? '剧情重复' : '剧情重复 无';
    const style = f.styleRepeat?.level && f.styleRepeat.level !== '无' ? `文风${f.styleRepeat.level}` : '文风 无';
    const echo = f.userEcho?.found ? '复读user的话' : '复读 无';   // 第五十四轮第四查
    return `${ooc} ／ ${plot} ／ ${style} ／ ${echo}`;
}

function traceSummary(rec) {
    if (!rec) return '';
    if (!rec.ok) return `失败：${clamp(rec.error, 60)}`;
    if (rec.mode === 'mix') {
        return `混合重编 · ${clamp(rec.mix?.idea ?? '', 40)}${rec.mix?.remount === 'rejected' ? ' · 挂载被拒' : ''}`;
    }
    if (rec.mode === 'reentry') {
        const d = { on_track: '没偏', minor: '偏了可拉回', major: '偏大了⚠' }[rec.reentry?.deviation] ?? '';
        return `回归判定 · ${d} · 到第 ${rec.reentry?.applied ?? 0}/${rec.reentry?.nodesTotal ?? '?'} 节点`;
    }
    if (rec.mode === 'unit') {
        const j = { achieved: '达成✓', not_yet: '未达成', stuck: '卡死⚠' }[rec.judgment] ?? rec.judgment;
        return rec.guidance ? `${j} · 已发指导` : `${j} · 静默（${clamp(rec.noGuidanceReason || '未给原因', 40)}）`;
    }
    if (rec.mode === 'rollback') {
        const r = rec.rollback ?? {};
        if (r.guide) return r.guide.reuse ? `第 ${r.guide.target} 层重做 · 沿用原指导` : `第 ${r.guide.target} 层重做 · 无原账（裸跑）`;
        if (r.kind === 'manual') return `节点回退 · ${r.from ?? '?'}→${r.to ?? '?'} · 手动纠正误判`;   // 第五十六轮
        return `删楼回退 · ${r.from ?? '?'}→${r.to ?? '?'} 节点 · 现存最后一层 ${r.lastFloor ?? 0}`;
    }
    const f = rec.findings ?? {};
    const parts = [
        f.ooc?.found ? `OOC×${f.ooc.items?.length ?? 1}` : '',
        f.plotRepeat?.found ? '剧情重复' : '',
        f.styleRepeat && f.styleRepeat.level !== '无' ? `文风${f.styleRepeat.level}` : '',
        f.userEcho?.found ? '复读user的话' : '',
    ].filter(Boolean);
    return parts.length ? `发现：${parts.join('、')}${rec.guidance ? ' · 已发修正' : ''}` : '四项无发现（静默）';
}

export const listenerTab = {
    id: 'listener',
    title: '监听',
    render(container) {
        renderTab(container);
        // 每轮写完就地刷新（页签还挂在 DOM 里才刷；换页签后事件自然落空，下次激活重渲染）
        if (!renderTab.bound) {
            renderTab.bound = true;
            document.addEventListener('pp-listener-updated', () => {
                if (!document.getElementById('pp_ls_root')) return;
                renderTab(containerById());
                refreshTraceWindow();
            });
        }
    },
};

function containerById() {
    return document.getElementById('pp_tab_content');
}

function renderTab(container) {
    const cfg = listenerCfg();
    const state = listenerState();
    const prov = listenerProvider();
    const mode = listenerModeLabel(state);
    const rec = lastTrace(state);
    const unit = state.unit;
    const curNode = unit && unit.nodeIdx < unit.nodes.length ? unit.nodes[unit.nodeIdx] : null;
    const stuckShown = rec?.ok && rec.mode === 'unit' && rec.judgment === 'stuck';

    // 打开监听页 = 看过问题了：清红点旗标（失联 ⚠ 由 paused 持有，不受这清）
    if (state.dot) {
        state.dot = false;
        state.dotReason = '';
        try { persistListener(); } catch { /* 存不进不阻断渲染 */ }
    }

    container.innerHTML = `
    <div class="pp-section" id="pp_ls_root">
        <div class="pp-ls-status">
            <div>
                <b class="pp-ls-mode pp-ls-mode-${mode.key}">${mode.label}</b>
                <span class="pp-muted" title="${escapeHtml(mode.hint)}">${escapeHtml(clamp(mode.hint, 40))}</span>
            </div>
            <div class="pp-item-ops">
                <span class="pp-muted" title="监听模型固定项（设置页「监听」区可改）：判定与指导都走它，2.0 里唯一不逐次选模型的调用">模型：${escapeHtml(clamp(prov.name, 36))}</span>
                <span id="pp_ls_run" class="menu_button" title="不等下一轮扮演输出，立刻按当前楼层判定一轮（测试与体检用）">立即判定一轮</span>
                <label class="menu_button" title="监听总开关：关 = 完全不分析、不注入、不扣发送；打开前确认上面的模型配置可用">启用 <input type="checkbox" id="pp_ls_enable" ${cfg.enabled ? 'checked' : ''} /></label>
            </div>
        </div>
        ${state.paused ? `
        <div class="pp-ls-problem">
            <b>⚠ 监听失联</b>
            <div>连续失败 ${3} 次，已自动暂停。检查监听模型连接（设置页「监听」区的固定项与「大模型连接」）后点恢复。</div>
            <div class="pp-btn-row"><span id="pp_ls_resume" class="menu_button">恢复监听</span></div>
        </div>` : ''}
        ${state.dotReason || (!rec?.ok && rec) || stuckShown ? `
        <div class="pp-ls-problem">
            <b>红点 · 问题与建议</b>
            ${stuckShown ? `<div>卡死：连续多轮无节点推进也无有效对话。出路：换指导方式（手动改单位/换单位）、点下面「标记达成」跳过该节点，或继续观察。</div>` : ''}
            ${!rec?.ok && rec ? `<div>最近一轮失败：${escapeHtml(rec.error ?? '')}</div>` : ''}
            ${state.dotReason ? `<div class="pp-muted">${escapeHtml(state.dotReason)}</div>` : ''}
            ${rec?.guidance && !state.guideVoidReason ? `<div class="pp-ls-problem-advice">指导建议：${escapeHtml(clamp(rec.guidance, 160))}</div>` : ''}
        </div>` : ''}
    </div>

    ${unit ? `
    <div class="pp-section">
        <div class="pp-item">
            <div class="pp-item-main">
                <b>${escapeHtml(unit.title)}</b>
                <span class="pp-ls-badge pp-ls-badge-${unit.source}" title="单位槽来源：手动导入粘贴 / 1.0 剧情规划产物直接挂载（规划产物只被读取，1.0 自己的剧情注入不受影响，撤不撤由你在剧情指导页定）/ 2.0 长线的章（进度同步回长线页的账本）">${SOURCE_BADGE[unit.source] ?? unit.source}</span>
                <span class="pp-muted">${unit.nodeIdx}/${unit.nodes.length} 节点已点亮${unit.nodeIdx >= unit.nodes.length ? ' · 已演完' : ''}</span>
            </div>
            <div class="pp-item-ops">
                ${unit.nodeIdx >= unit.nodes.length
                    ? `<span id="pp_ls_next" class="menu_button" title="末节点已点亮后的手动衔接（无自动档）：退位槽有单位就接回，没有就去下面导入下一个">接续下一单位</span>
                    ${unit.nodeIdx > 0 ? NODEBACK_BTN : ''}`
                    : `${state.hold
                        ? `<span id="pp_ls_hold" class="menu_button" title="暂停推进中（你点的）：节点方向指导与角色暗牌停发、点亮冻结——判定照跑、四查（OOC/剧情重复/文风重复/复读 user 的话）照常出报告、达门槛的修正照发。当前事件演完点这里恢复，恢复时会立刻补一轮判定把方向指导写回来">▶ 恢复推进（暂停中）</span>`
                        : `<span id="pp_ls_hold" class="menu_button" title="想在当前节点停留（插个话题/动作自由演绎）时点这个：停发节点方向指导并清掉注入槽里的旧指导、进度冻结（判定不再点亮），免得它一直拉模型去下一个节点；四查与检查报告照常运行。当前事件演完再点一下恢复">⏸ 暂停推进</span>`}
                    <span id="pp_ls_lit" class="menu_button" title="人工拍板：不等模型判定，直接把当前待判节点记为达成（两本账里用户显式操作可改进度账）${state.hold ? '；暂停推进中也能点——手动点亮是用户显式操作，不算自动推进' : ''}">标记达成</span>
                    ${unit.nodeIdx > 0 ? NODEBACK_BTN : ''}`}
                <span id="pp_ls_unmount" class="menu_button" title="卸下当前单位（进退位槽，进度原样保留，可再接回）；卸下后本聊天按轻量口径执勤">卸下</span>
            </div>
        </div>
        <div class="pp-ls-nodes">
            ${unit.nodes.map((n, i) => `
            <div class="pp-ls-node ${i < unit.nodeIdx ? 'pp-ls-node-lit' : ''} ${i === unit.nodeIdx ? 'pp-ls-node-cur' : ''}">
                <span class="pp-ls-node-state">${i < unit.nodeIdx ? '✓' : (i === unit.nodeIdx ? (state.hold ? '⏸暂停' : (stuckShown ? '⚠卡死' : '待判')) : '未到')}</span>
                <span class="pp-ls-node-title" title="${escapeHtml(n.criterion)}">${escapeHtml(n.title)}</span>
                <span class="pp-muted pp-ls-node-crit">${escapeHtml(clamp(n.criterion, 44))}</span>
            </div>`).join('')}
        </div>
    </div>` : `
    <div class="pp-section">
        <div class="pp-muted">当前没有挂载单位——轻量执勤中（OOC / 剧情重复 / 文风重复 / 复读 user 的话 四项检查）。要按规划逐节点推进：剧情指导页「确认采用」会自动挂载（历史剧情里也可手动补挂）；长线章在长线页章卡上挂。</div>
    </div>`}

    ${/* 退位槽行独立于单位块（第三十一轮）：卸下后没有活动单位时「接回/丢弃」也得够得着，别跟着单位卡一起消失 */ ''}
    ${state.sidelined ? `
    <div class="pp-section">
        <div class="pp-ls-sidelined">
            <span>退位槽：${escapeHtml(state.sidelined.title)}（${state.sidelined.nodeIdx}/${state.sidelined.nodes.length} 点亮，进度冻结）</span>
            <span class="pp-item-ops">
                <span id="pp_ls_recall" class="menu_button" title="退位单位重新上岗；当前活动单位（若有）换进退位槽">接回</span>
                <span id="pp_ls_discard" class="menu_button" title="彻底删除退位槽里的单位（不可恢复）">丢弃</span>
            </span>
        </div>
    </div>` : ''}

    ${/* 回归判定报告卡（第三十三轮）：重挂有进度的长线章自动跑一次「走到哪、偏没偏」，报告留到下一次例行判定落账 */ ''}
    ${rec?.mode === 'reentry' ? (rec.ok ? `
    <div class="pp-section pp-ls-reentry">
        <b>回归判定</b>
        <span class="pp-muted" title="重新挂载有进度的长线章时自动跑一次：对照五章规划窗口判定「走到哪、偏没偏」。报告只给你看——不注入扮演模型、不出指导">（重挂自动判定）</span>
        <div class="pp-ls-dev pp-ls-dev-${rec.reentry?.deviation ?? 'on_track'}">${escapeHtml(DEV_LABEL[rec.reentry?.deviation] ?? rec.reentry?.deviation ?? '')}</div>
        ${rec.reentry?.deviationNote ? `<div class="pp-muted">${escapeHtml(rec.reentry.deviationNote)}</div>` : ''}
        <div>走到哪：第 ${rec.reentry?.applied ?? 0}/${rec.reentry?.nodesTotal ?? '?'} 节点（挂载时账面 ${rec.reentry?.before ?? 0}${(rec.reentry?.applied ?? 0) > (rec.reentry?.before ?? 0) ? `，补点亮 ${(rec.reentry.applied) - (rec.reentry.before)} 个` : '，持平'}）</div>
        ${rec.reentry?.window ? `<div class="pp-muted">对照窗口：${escapeHtml(rec.reentry.window)}</div>` : ''}
        ${rec.reentry?.summary ? `<div class="pp-ls-reentry-summary">${escapeHtml(rec.reentry.summary)}</div>` : ''}
        ${(rec.reentry?.evidence ?? []).slice(0, 4).map(e => `<div class="pp-ls-ev">${e.floor != null ? `<b>[楼层${e.floor}]</b> ` : ''}「${escapeHtml(clamp(e.quote, 120))}」<span class="pp-muted">${escapeHtml(clamp(e.note, 80))}</span></div>`).join('')}
        ${rec.reentry?.deviation === 'major' ? `
        <div class="pp-ls-dev pp-ls-dev-major" style="margin-top:4px">偏大挂起中：判定与进度账照跑、指导暂停注入、停进提示在岗（独立注入槽）。</div>
        <div class="pp-muted">处置出口：① 剧情指导页第 1 步「打碎混合」就地重写本章并重新挂上（重挂即解除挂起）；② 卸下后去长线页「按意见修订所有卷/所有章」或单卷重切——记忆表格默认随行，改完重新挂载、回归判定重跑；③ 本页「标记达成」手动点亮跳过（同步解除挂起）。等你处理，不自动动。</div>` : ''}
        ${rec.tokens ? `<span class="pp-muted">${rec.tokens.promptTokens.toLocaleString()}/${rec.tokens.completionTokens.toLocaleString()} tok</span>` : ''}
    </div>` : `
    <div class="pp-section pp-ls-reentry">
        <b>回归判定失败</b>
        <div class="pp-ls-err">${escapeHtml(rec.error ?? '')}</div>
        <div class="pp-muted">账面进度不变；下一轮扮演输出后照常例行判定。</div>
    </div>`) : ''}

    ${/* 检查报告折叠区（第五十二轮，用户开工令；第五十四轮起四项）：最近一轮判定的检查明细——OOC 逐条/剧情重复/文风重复/复读 user 的话。
        默认收起（点开才看报告）；不达介入门槛只出报告不干预，达门槛的发现已自动并进下方「本轮指导」 */ ''}
    ${rec?.ok && rec.findings ? `
    <div class="pp-section">
        <details class="pp-fold" id="pp_ls_report" ${reportOpen ? 'open' : ''}>
            <summary><b>检查报告</b><span class="pp-muted" title="四项检查（OOC／剧情重复／文风重复／复读 user 的话）随判定同行：默认收起、只出报告不干预；发现达到「介入」旋钮门槛时修正自动并入下方「本轮指导」（复读 user 的话无轻重档、发现就算过门槛）">第 ${rec.round} 轮 · ${rec.mode === 'unit' ? '单位' : '轻量'} · ${escapeHtml(lightChecksLine(rec.findings))}</span></summary>
            <div class="pp-ls-trace-body">
                ${(rec.findings.ooc?.items ?? []).map(it => `<div class="pp-ls-ev"><b>OOC·${escapeHtml(it.aspect)}·${escapeHtml(it.severity)}</b> ${escapeHtml(clamp(it.evidence, 100))}<span class="pp-muted">建议：${escapeHtml(clamp(it.fix, 80))}</span></div>`).join('')}
                ${(rec.findings.plotRepeat && (rec.findings.plotRepeat.found || rec.findings.plotRepeat.note)) ? `<div class="pp-ls-ev"><b>剧情重复${rec.findings.plotRepeat.found ? '' : '·无'}</b> ${escapeHtml(rec.findings.plotRepeat.note)}${rec.findings.plotRepeat.fix ? `<span class="pp-muted">改法：${escapeHtml(clamp(rec.findings.plotRepeat.fix, 100))}</span>` : ''}</div>` : ''}
                ${(rec.findings.styleRepeat && (rec.findings.styleRepeat.level !== '无' || rec.findings.styleRepeat.note)) ? `<div class="pp-ls-ev"><b>文风重复·${escapeHtml(rec.findings.styleRepeat.level)}</b> ${escapeHtml(rec.findings.styleRepeat.note)}${rec.findings.styleRepeat.fix ? `<span class="pp-muted">改法：${escapeHtml(clamp(rec.findings.styleRepeat.fix, 100))}</span>` : ''}</div>` : ''}
                ${(rec.findings.userEcho && (rec.findings.userEcho.found || rec.findings.userEcho.note)) ? `<div class="pp-ls-ev"><b>复读 user 的话${rec.findings.userEcho.found ? '' : '·无'}</b> ${escapeHtml(rec.findings.userEcho.note)}${rec.findings.userEcho.fix ? `<span class="pp-muted">改法：${escapeHtml(clamp(rec.findings.userEcho.fix, 100))}</span>` : ''}</div>` : ''}
                ${!rec.findings.ooc?.found && !rec.findings.plotRepeat?.found && (!rec.findings.styleRepeat || rec.findings.styleRepeat.level === '无') && !rec.findings.userEcho?.found ? '<div class="pp-muted">本轮四项无发现。</div>' : ''}
                <div class="pp-muted">门槛＝「介入」旋钮同一档口径：低＝仅轻微发现（OOC／文风轻微）只出报告不修正，中／高＝有发现就修正；剧情重复与复读 user 的话没有轻重档、发现就过门槛（低档也修正）。修正段以【检查修正】开头并进指导。</div>
            </div>
        </details>
    </div>` : ''}

    ${/* 第三十七轮（用户立规「功能按钮不与生成文本混排」）：指导区只留纯文本——两个按钮分别搬去
        留痕行（看提示词全文）与判定材料区（世界书自选）；轮号按甲案挪到留痕行「已判定 N 轮」、作废期间隐藏 */ ''}
    <div class="pp-section">
        <b title="注入槽里当前生效的指导全文（微量指导或轻量修正指导）；静默轮显示静默原因">本轮指导</b>
        ${rec?.materials ? `<div class="pp-muted" title="本次判定实际喂给监听模型的材料清单">材料：${escapeHtml(materialsLine(rec.materials))}</div>` : ''}
        ${state.guideVoidReason ? `
        <div class="pp-muted">上一轮指导已随「${escapeHtml(state.guideVoidReason)}」作废：注入槽已清空、下一轮不再注入；等新一轮判定重新生成。</div>` : rec && rec.ok && rec.guidance ? `
        <div class="pp-ls-guidance">${escapeHtml(rec.guidance)}</div>` : rec && rec.ok ? `
        ${rec.mode === 'light' ? `<div class="pp-muted">${escapeHtml(lightChecksLine(rec.findings))}</div>` : ''}
        <div class="pp-muted">本轮静默：${escapeHtml(rec.noGuidanceReason || '未给原因')}</div>` : `
        <div class="pp-muted">${rec ? '最近一轮失败，注入槽已清空（绝不复用过期指导）' : '还没有判定记录'}</div>`}
    </div>

    ${/* 停进提示区（2026-09-02 暂停收尾）：撤下长线章（paused）或回归判定偏大挂起（suspended）时
        写进独立注入槽的剧情口径——别再推进这条线。与监听总开关无关；挂载/接回/打碎混合重挂自动撤，
        这里也可手动撤 */ ''}
    ${state.halt ? `
    <div class="pp-section" id="pp_ls_haltzone">
        <b title="停进提示：写给扮演模型的剧情口径（独立隐身注入槽，深度与指导槽相同）。手动「卸下」长线章时自动发（防止模型继续推进已暂停的剧情线走歪）；回归判定偏大挂起时也发（别硬拉回规划）。挂载/接回/剧情指导页「打碎混合」重挂都会自动撤下；与监听总开关无关">${state.halt.kind === 'paused' ? '停进提示（长线已暂停）' : '停进提示（长线偏离挂起）'}</b>
        <div class="pp-ls-guidance">${escapeHtml(haltHintText(state.halt))}</div>
        ${state.halt.note ? `<div class="pp-muted" title="挂起来源的备注">${escapeHtml(clamp(state.halt.note, 200))}</div>` : ''}
        <div class="pp-btn-row">
            <span id="pp_ls_halt_clear" class="menu_button" title="手动撤下停进提示（注入槽清空）。撤下后监听照常：没挂单位＝轻量检查；偏离挂起的解除靠重挂后回归判定没偏，或点「标记达成」">撤下停进提示</span>
            ${state.halt.kind === 'suspended' ? `<span class="pp-muted">处置出口见上方回归判定卡的指路行；判定与进度账照跑、只有指导暂停注入</span>` : `<span class="pp-muted">恢复去长线页该章点「挂载」（或剧情指导页「打碎混合」重写后自动挂上）</span>`}
        </div>
    </div>` : ''}

    ${/* 装扮注入区（2026-09-02）：当前装扮的注入设置——两框互斥联动（勾一个灰另一个）、层数随角色楼
        自动递减可直接改数、走完自动清框停注（两框都灰＝停注）；「撤下」进留痕。与监听总开关无关 */ ''}
    ${outfitZoneHtml()}

    <div class="pp-section">
        <b>旋钮</b>
        <div class="pp-ls-knobs">
            <label title="达成判定松紧——管多严算「节点达成」。宽：动作方向与完成标准相符即算；标准：明显偏向即算；严：关键动作实质发生才算">
                <span>松紧</span>
                <select id="pp_ls_strict" class="text_pole">
                    <option value="loose" ${cfg.strictness === 'loose' ? 'selected' : ''}>宽</option>
                    <option value="standard" ${cfg.strictness === 'standard' ? 'selected' : ''}>标准</option>
                    <option value="strict" ${cfg.strictness === 'strict' ? 'selected' : ''}>严</option>
                </select>
            </label>
            <label title="介入强度——管指导发多勤（接管全部频控行为）。单位模式：低＝仅明显偏航或停滞时发；中＝例行轻推，允许静默轮；高＝每轮都发（卡死除外）。单位模式检查修正（第五十二轮起）：同一档口径——低＝仅轻微发现（OOC／文风轻微）只出报告不修正，中／高＝有发现就把【检查修正】并进指导；剧情重复与复读 user 的话没有轻重档、发现就过门槛（低档也修正）。轻量模式：发现问题就发——低＝仅很轻微的不发（OOC 轻微／文风轻微静默），中／高＝有任何发现就发（轻微也发）">
                <span>介入</span>
                <select id="pp_ls_inter" class="text_pole">
                    <option value="low" ${cfg.intervene === 'low' ? 'selected' : ''}>低</option>
                    <option value="medium" ${cfg.intervene === 'medium' ? 'selected' : ''}>中</option>
                    <option value="high" ${cfg.intervene === 'high' ? 'selected' : ''}>高</option>
                </select>
            </label>
            <label title="留痕滚动轮数：监听页留痕记录最多保留多少轮，超出清最旧（最新在前）">
                <span>留痕轮数</span>
                <input id="pp_ls_tracer" class="text_pole" type="number" min="5" max="500" step="5" value="${cfg.traceRounds}" />
            </label>
            <label title="卡死参考窗口：连续约多少轮既无节点推进也无有效对话，才允许判「卡死」（刻意慢节奏不算）">
                <span>卡死窗口</span>
                <input id="pp_ls_stuckw" class="text_pole" type="number" min="2" max="20" step="1" value="${cfg.stuckWindow}" />
            </label>
        </div>
    </div>

    <div class="pp-section">
        <div class="pp-ls-tracebar">
            <span id="pp_ls_trace_btn" class="menu_button" title="滚动查看逐轮判定记录：判定三态、楼层作证、watch 标记、指导或静默原因">留痕记录 <span class="pp-ls-count">${state.trace.length}</span></span>
            <span id="pp_ls_prompt" class="menu_button" title="查看最近一次判定（例行轮或回归判定）实际发给监听模型的提示词全文——只保留最近一次、刷新页面后清空（全文随楼层膨胀，不进聊天存档）">看提示词全文</span>
            ${!state.guideVoidReason && state.round > 0 ? `<span class="pp-muted" title="本聊天例行判定的累计次数（挂单位的轮与轻量轮都计；回归判定不计数；指导作废期间不显示——作废行只说作废）">已判定 ${state.round} 轮</span>` : ''}
            <span class="pp-muted">最新在前 · 滚动保留 ${cfg.traceRounds} 轮</span>
        </div>
        <pre id="pp_ls_prompt_pre" class="pp-ls-prompt" hidden></pre>
    </div>

    ${/* 判定材料区（第三十七轮，用户拍板）：监听页最下面、两套页签——「日常监听」管每轮例行判定（单位轮＋轻量轮），
        「重挂对账」管重挂有进度的章那一刻、你开口对话前自动跑的一次性回归判定；选择范围相同、勾选互不影响、按聊天存 */ ''}
    <div class="pp-section" id="pp_ls_matzone">
        ${matZoneHtml()}
    </div>`;

    bindTab(container);
}

function bindTab(container) {
    const root = container.querySelector('#pp_ls_root');
    if (!root) return;

    container.querySelector('#pp_ls_enable')?.addEventListener('change', e => {
        setListenerEnabled(e.target.checked);
        if (e.target.checked) toastr.info('监听已启用：扮演模型每轮输出完毕后自动判定，指导写入独立注入槽');
    });

    container.querySelector('#pp_ls_run')?.addEventListener('click', async function () {
        this.classList.add('disabled');
        try {
            const r = await runListenerRound({ manual: true });
            if (r.skipped) toastr.warning(`本轮没跑：${({ disabled: '总开关没开', paused: '监听处于失联暂停', 'no-chat': '当前聊天没有楼层', busy: '上一轮还在跑' })[r.skipped] ?? r.skipped}`);
            else if (r.ok) toastr.success(`第 ${r.round} 轮判定完成（${r.mode === 'unit' ? '单位' : '轻量'}执勤）`);
        } finally {
            this.classList.remove('disabled');
        }
    });

    container.querySelector('#pp_ls_report')?.addEventListener('toggle', e => { reportOpen = e.target.open; });
    container.querySelector('#pp_ls_prompt')?.addEventListener('click', () => {
        const pre = container.querySelector('#pp_ls_prompt_pre');
        if (!pre) return;
        const text = lastListenerPrompt();
        if (!text) { toastr.info('还没有可看的提示词——至少跑过一轮判定（或重挂触发一次回归判定）后才有'); return; }
        if (pre.hidden) { pre.textContent = text; pre.hidden = false; }
        else pre.hidden = true;
    });

    container.querySelector('#pp_ls_resume')?.addEventListener('click', () => {
        resumeListener();
        toastr.success('监听已恢复，下一轮扮演输出后自动续跑');
    });

    container.querySelector('#pp_ls_lit')?.addEventListener('click', () => {
        if (manualLitCurrentNode()) toastr.success('当前节点已手动记为达成（进度账·用户显式操作）');
    });

    // 返回上一节点（第五十六轮，用户开工令）：误判达成的纠错口——纯账本回退＋清槽，
    // 不立刻补判（原楼层还在，马上重判大概率原样再点亮）；长线章的进度账同步倒回
    container.querySelector('#pp_ls_nodeback')?.addEventListener('click', () => {
        const r = rollbackOneNode();
        if (r === false) { toastr.info('没有已点亮的节点，退无可退'); return; }
        if (r.src === 'longform') rollbackLfChapterOf(r.unit);
        renderTab(container);
        toastr.info(`已回退「${r.label.slice(0, 30)}」：第 ${r.from} → ${r.to} 节点——退回的节点重新待判，下一轮判定对它重跑`);
    });

    // 暂停推进两态键（第五十三轮，用户开工令）：暂停＝清槽冻结（四查照跑）；恢复＝立刻补一轮判定，
    // 方向指导马上回注入槽——不等下一条消息落地（用户点恢复的时机就是「这段演完了」）
    container.querySelector('#pp_ls_hold')?.addEventListener('click', async () => {
        const on = setListenerHold(!listenerState().hold);
        renderTab(container);
        if (on) {
            toastr.info('已暂停推进：方向指导停发、注入槽已清、进度冻结；检查报告与修正照常。演完这段后点「恢复推进」');
        } else {
            const r = await runListenerRound({ manual: true });   // 补判：把方向指导写回槽
            if (r?.ok) toastr.success('已恢复推进：方向指导已写回注入槽');
            else if (r?.skipped) toastr.warning(`已恢复推进（本轮补判没跑：${({ disabled: '总开关没开', paused: '监听处于失联暂停', 'no-chat': '当前聊天没有楼层', busy: '上一轮还在跑' })[r.skipped] ?? r.skipped}）——下一轮扮演输出后自动续跑`);
        }
    });

    container.querySelector('#pp_ls_next')?.addEventListener('click', () => {
        const state = listenerState();
        if (state.sidelined) {
            const title = state.sidelined.title;
            const r = opRecallSidelined();
            if (r.ok) {
                syncLfProgress();
                scheduleReentryFor(listenerState().unit);   // 接回的是有进度的长线章 → 回归判定（第三十三轮）
                renderTab(container);
                toastr.success(`已接回「${title}」`);
            }
            else toastr.warning(r.reason);
        } else {
            toastr.info('退位槽是空的：新规划在剧情指导页「确认采用」时自动挂载（历史剧情里也可手动补挂）；长线章在长线页章卡上挂');
        }
    });

    container.querySelector('#pp_ls_unmount')?.addEventListener('click', () => {
        const r = opUnmountUnit();
        if (r.ok) { syncLfProgress(); renderTab(container); toastr.success('已卸下（进退位槽，进度保留）'); }
        else toastr.warning(r.reason);
    });

    container.querySelector('#pp_ls_recall')?.addEventListener('click', () => {
        const r = opRecallSidelined();
        if (r.ok) {
            syncLfProgress();
            scheduleReentryFor(listenerState().unit);   // 接回的是有进度的长线章 → 回归判定（第三十三轮）
            renderTab(container);
            toastr.success('已接回');
        }
        else toastr.warning(r.reason);
    });

    container.querySelector('#pp_ls_discard')?.addEventListener('click', () => {
        const r = opDiscardSidelined();
        if (r.ok) { syncLfProgress(); renderTab(container); toastr.success('退位单位已删除'); }
        else toastr.warning(r.reason);
    });

    container.querySelector('#pp_ls_halt_clear')?.addEventListener('click', () => {
        if (clearListenerHalt()) {
            renderTab(container);
            toastr.success('停进提示已撤下（注入槽清空）');
        }
    });

    const bindSel = (id, key, map) => {
        container.querySelector(id)?.addEventListener('change', e => {
            listenerCfg()[key] = map ? map[e.target.value] : e.target.value;
            save();
        });
    };
    bindSel('#pp_ls_strict', 'strictness');
    bindSel('#pp_ls_inter', 'intervene');
    container.querySelector('#pp_ls_tracer')?.addEventListener('change', e => {
        listenerCfg().traceRounds = Math.min(500, Math.max(5, Number(e.target.value) || 50));
        save();
    });
    container.querySelector('#pp_ls_stuckw')?.addEventListener('change', e => {
        listenerCfg().stuckWindow = Math.min(20, Math.max(2, Number(e.target.value) || 3));
        save();
    });

    container.querySelector('#pp_ls_trace_btn')?.addEventListener('click', () => {
        traceWinOpen = true;
        openTraceWindow();
    });

    bindMatZone(container);
    bindOutfitZone(container);
}

// ---------------------------------------------------------------------------
// 装扮注入区（2026-09-02）：当前装扮（outfit 块的 active）的注入设置。用户设计的两框互斥联动——
// 勾「持续」灰掉层数框、勾「注入几层楼」灰掉持续框；层数随角色楼自动递减（一条角色回复＝一层）、
// 数字可直接改；层数走完自动清掉第二个框＝两框都灰＝停注；「撤下」进留痕。新装扮在装扮面板确认时
// 旧的自动进留痕。不依赖监听总开关（这格注入与监听引擎互不相干，开关管不到它）
// ---------------------------------------------------------------------------

function outfitZoneHtml() {
    return `<div class="pp-section" id="pp_ls_outfitzone">${outfitZoneInner()}</div>`;
}

function outfitZoneInner() {
    const st = outfitState();
    const active = st.active;
    if (!active) return `
        <b title="给扮演模型的装扮状态注入：装扮单元在剧情指导页第 1 步「装扮」面板确认立卡后自动开始注入，设置在这里">装扮注入</b>
        <div class="pp-muted">当前没有生效装扮——去剧情指导页第 1 步点「装扮」生成/抽取并确认立卡</div>`;
    const remaining = outfitRemaining();
    const mode = active.mode;
    const statusText = mode === 'always' ? '持续注入中'
        : mode === 'floors' ? `按层数注入中（剩 ${remaining} 层）`
        : '已停注（两框都空）——勾任意一框恢复注入';
    return `
        <b title="给扮演模型的装扮状态注入（隐身槽，比监听指导更靠前）；与监听总开关无关">装扮注入</b>
        <div class="pp-ls-knobs">
            <label title="持续注入：不限层数，一直注入到被新装扮覆盖或点「撤下」"><input type="checkbox" id="pp_ls_ot_always" ${mode === 'always' ? 'checked' : ''} ${mode === 'floors' ? 'disabled' : ''} /> 持续</label>
            <label title="注入几层楼：一条角色回复＝一层，层数随角色发言自动往下走、走完自动停注（两框都空）；数字可以随时直接改。勾这个会灰掉「持续」，取消勾选＝停注"><input type="checkbox" id="pp_ls_ot_floors" ${mode === 'floors' ? 'checked' : ''} ${mode === 'always' ? 'disabled' : ''} /> 注入几层楼</label>
            <input type="number" class="text_pole" id="pp_ls_ot_n" min="1" max="500" step="1" value="${mode === 'floors' ? Math.max(1, remaining) : 20}" ${mode === 'floors' ? '' : 'disabled'} title="剩余层数（可直接改）：随角色楼自动递减，走完自动清框停注" />
            <span id="pp_ls_ot_withdraw" class="menu_button" title="撤下当前装扮：停止注入、进监听留痕（结束状态＝手动撤下）。装扮单元还在暂存池里，想重来去装扮面板重新确认">撤下</span>
        </div>
        <div>「${escapeHtml(active.title)}」 <span class="pp-muted">${statusText}</span></div>
        <details class="pp-fold">
            <summary title="这套装扮的注入正文快照（立卡那一刻的单元正文）">装扮正文</summary>
            <div class="pp-ls-guidance">${escapeHtml(active.text)}</div>
        </details>`;
}

function bindOutfitZone(container) {
    const zone = container.querySelector('#pp_ls_outfitzone');
    if (!zone) return;
    const rerender = () => {
        zone.innerHTML = outfitZoneInner();   // 就地换内层，不整页重渲染
        bindOutfitZone(container);
    };
    zone.querySelector('#pp_ls_ot_always')?.addEventListener('change', e => {
        setOutfitMode(e.target.checked ? 'always' : 'none');
        rerender();
    });
    zone.querySelector('#pp_ls_ot_floors')?.addEventListener('change', e => {
        if (!e.target.checked) { setOutfitMode('none'); }
        else {
            const n = Number(zone.querySelector('#pp_ls_ot_n')?.value);
            setOutfitMode('floors', Number.isFinite(n) && n > 0 ? n : 20);
        }
        rerender();
    });
    zone.querySelector('#pp_ls_ot_n')?.addEventListener('change', e => {
        setOutfitFloors(Number(e.target.value) || 1);
        rerender();
    });
    zone.querySelector('#pp_ls_ot_withdraw')?.addEventListener('click', () => {
        if (withdrawOutfit()) toastr.success('已撤下：装扮进监听留痕（结束状态＝手动撤下）');
        rerender();
    });
}

// ---------------------------------------------------------------------------
// 判定材料区（第三十七轮，用户拍板）：两套材料单各自独立、按聊天存——「日常监听」＝每轮例行
// 判定（单位轮＋轻量轮共用），「重挂对账」＝重挂有进度的章那一刻、你开口对话前自动跑的一次性
// 回归判定。选择范围相同：世界书自选 / 记忆表格挑选器（照向导第 1 步同款克隆——用户定则：
// 一切提示词材料都在全量版本上做减法、一套机器，不做每板块单独算法）/ 世界书检索 / 楼层数×2
// （第三十八轮：判定正文的楼层数与「世界书检索」关键词激活的回看层数分开，各管各的窗口）。
// ---------------------------------------------------------------------------

let matPage = 'routine';   // 当前展开的页签（会话记忆；默认日常监听）

function matStore(kind) {
    const st = listenerState();
    return kind === 'reentry' ? st.matReentry : st.matRoutine;
}

function matPicksArr(kind) {
    return kind === 'reentry' ? (listenerState().matReentry.picks ?? []) : [];
}

// 日常单的世界书三档状态计数（按钮文案用）：只数本聊天启用书里的条目，状态缺省＝关键词
function loreMgrCounts() {
    const state = listenerState();
    const ids = new Set((chatEnabledBookIds() ?? (settings.lorebooks ?? []).filter(b => b.enabled).map(b => String(b.id))).map(String));
    const c = { off: 0, key: 0, always: 0 };
    for (const book of settings.lorebooks ?? []) {
        if (!ids.has(String(book.id))) continue;
        for (const e of book.entries ?? []) {
            if (!e.content) continue;
            const st = state.loreStatus[`${book.id}:${e.uid}`] ?? 'key';
            c[st] = (c[st] ?? 0) + 1;
        }
    }
    return c;
}

function matModeOf(mat, uid) {
    return (mat?.memModes ?? {})[uid] ?? 'always';
}

// 标签 chips（照第 1 步口径）：计数只统计未停用表格里的行
function matTagChips(mat) {
    const ms = memoryState();
    const sheets = ms.mirror.sheets ?? [];
    const scope = new Set(sheets.filter(s => matModeOf(mat, s.uid) !== 'off').map(s => s.uid));
    const counts = new Map();
    for (const sheet of sheets) {
        if (!scope.has(sheet.uid)) continue;
        for (const r of sheet.rows) for (const t of (ms.tags[r.rid] ?? [])) counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    const tags = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    return tags.length
        ? `<label class="pp-mem-chip" title="没全勾时勾上=一键勾选全部标签；已全勾时点掉=一键全清"><input type="checkbox" data-mtag-all /> 全选</label>`
            + tags.map(([t, n]) => `<label class="pp-mem-chip" title="带这个标签的记忆行"><input type="checkbox" data-mtag="${escapeHtml(t)}" ${(mat.memTags ?? []).includes(t) ? 'checked' : ''}/> ${escapeHtml(t)} (${n})</label>`).join('')
        : '<span class="pp-muted">所选表格里还没有带标签的行：到「记忆表格」页打标签</span>';
}

function matZoneHtml() {
    const kind = matPage;
    const mat = matStore(kind);
    const sheets = memoryState().mirror.sheets ?? [];
    const zoneTip = kind === 'routine'
        ? '本页＝日常监听的材料单：挂单位的判定轮与无单位的轻量轮都用这一份，每轮判定都生效'
        : '本页＝重挂对账的材料单：重新挂上有进度的章、你开口对话前自动跑的那一次回归判定用这一份（只那一次；之后的日常轮回到上一页的材料单）';
    const loreCnt = loreMgrCounts();
    // 日常单的世界书＝书单＋三档状态（第四十三轮，激活机制的新家）；重挂单＝纯手选勾选（不上三按钮机制）
    const loreKnob = kind === 'routine'
        ? `<span id="pp_ls_lore" class="menu_button" title="世界书条目（激活机制的新家）：书的启用＋每条条目的三档状态（停用/关键词/常驻）都按聊天存、就在监听页就地编辑；窗口里还有「检索测试」。常驻＝每轮判定无条件整条带上；关键词＝条目关键词出现在对话里才带（往回看几层归旁边的「关键词扫描层数」管）；停用＝永不带；未启用的书整本不扫">世界书条目（常驻 ${loreCnt.always} · 关键词 ${loreCnt.key}${loreCnt.off ? ` · 停用 ${loreCnt.off}` : ''}）</span>`
        : `<span id="pp_ls_lore" class="menu_button" title="勾选世界书条目整条原文固定进重挂对账那次判定的材料（不截断）——重挂单不上三按钮机制，纯手选">世界书自选（已勾 ${resolveLorePicks(matPicksArr('reentry')).length} 条）</span>`;
    // 检索开关与关键词扫描层数只属日常单（重挂单的自动检索第四十三轮整块撤掉）
    const scanKnobs = kind === 'routine' ? `
        <label title="按对话里出现的关键词激活世界书「关键词」档条目、命中随每轮判定附带（书单与三档状态在「世界书条目」窗里配；往回看几层由「关键词扫描层数」管）。只管关键词档——「常驻」档条目不受这个开关管、恒带"><input type="checkbox" id="pp_ls_scan" ${mat.scan ? 'checked' : ''} /> 世界书检索</label>
        <label title="「世界书检索」按关键词激活时往回看多少层角色楼找关键词（窗口内夹的用户消息也算「对话里出现」）：0 = 全聊天（默认——很久前提过的关键词也能激活）；N = 只看最近 N 层，窗外提过的不激活。只管激活范围，不改变判定正文带几层（那个归「楼层数」管）">关键词扫描层数 <input id="pp_ls_scan_floors" class="text_pole" type="number" min="0" step="5" value="${mat.scanFloors}" /></label>` : '';
    const sheetRows = sheets.map(s => `
    <div class="pp-gd-sheetrow">
        <span class="pp-gd-sheetname" title="${escapeHtml(s.name)} · ${s.rows.length} 行">${escapeHtml(s.name)} · ${s.rows.length} 行</span>
        <div class="pp-seg" data-mseg="${escapeHtml(s.uid)}" title="停用＝本页判定不带这张表；标签＝只带命中所勾标签的行（没打标签的表用这档带不出东西，那类表选常驻）；常驻＝无论标签全量带出">
            <span class="pp-seg-opt${matModeOf(mat, s.uid) === 'off' ? ' on' : ''}" data-state="off">停用</span>
            <span class="pp-seg-opt${matModeOf(mat, s.uid) === 'tags' ? ' on' : ''}" data-state="tags">标签</span>
            <span class="pp-seg-opt${matModeOf(mat, s.uid) === 'always' ? ' on' : ''}" data-state="always">常驻</span>
        </div>
    </div>`).join('');
    return `
    <b>判定材料</b>
    <div class="pp-seg" id="pp_ls_mattab" title="两套材料单都按聊天存、勾选互不影响（日常监听＝每轮例行判定；重挂对账＝重挂有进度的章那一刻的一次性回归判定；世界书两页不同形——日常单是书单＋三档状态，重挂单是纯手选勾选）">
        <span class="pp-seg-opt${kind === 'routine' ? ' on' : ''}" data-mpage="routine">日常监听</span>
        <span class="pp-seg-opt${kind === 'reentry' ? ' on' : ''}" data-mpage="reentry">重挂对账</span>
    </div>
    <span class="pp-muted">${zoneTip}</span>
    <div class="pp-ls-knobs">
        ${loreKnob}
        ${scanKnobs}
        <label title="本页判定携带的楼层原文范围：0 = 全量（默认，判定引证最全）；N = 只带最近 N 层角色楼（其间夹的用户消息保留、楼层号仍是全聊天绝对号）——长对话省钱用，砍太狠可能伤判定准头，自己权衡。只管判定正文带几层；日常页的「世界书检索」按关键词往回看几层由「关键词扫描层数」单独管，两者互不影响">楼层数 <input id="pp_ls_floors" class="text_pole" type="number" min="0" step="5" value="${mat.floors}" /></label>
    </div>
    ${sheets.length ? `
    <label class="pp-label" title="照向导第 1 步同款（一套机器，在全量版本上做减法）：每张表一个档位、标签过滤、表尾最新行；选择随本页材料单按聊天存，两页互不影响">记忆表格召回</label>
    <div class="pp-gd-memlay">
        <div>
            <b class="pp-gd-layname">表格档位</b>
            <div class="pp-gd-sheetlist">${sheetRows}</div>
        </div>
        <div>
            <b class="pp-gd-layname">标签过滤</b>
            <div class="pp-gd-selp" id="pp_ls_mem_chips">${matTagChips(mat)}</div>
            <label class="pp-gd-recentrow" title="标签过滤会漏掉近期发生但没打标签的事件：填 N，「标签」档的每张表无论标签都把表尾最新 N 行一并带给本页判定——常驻档本来就全量、用不上本项；记忆行没有时间戳、新记录在表尾，「最新」即表尾；0 = 不另附">「标签」档每表另附最新 <input type="number" class="text_pole" id="pp_ls_mem_recent" min="0" step="1" value="${mat.memRecent}" /> 行</label>
        </div>
    </div>` : '<div class="pp-muted">镜像里还没有记忆表，本页判定不带记忆表格</div>'}`;
}

function bindMatZone(container) {
    const zone = container.querySelector('#pp_ls_matzone');
    if (!zone) return;
    const persist = () => persistListener();

    zone.querySelectorAll('#pp_ls_mattab .pp-seg-opt').forEach(el => el.addEventListener('click', () => {
        if (el.classList.contains('on')) return;
        matPage = el.dataset.mpage === 'reentry' ? 'reentry' : 'routine';
        zone.innerHTML = matZoneHtml();   // 就地重建本区（不整页重渲染、不丢滚动位置）
        bindMatZone(container);
    }));

    zone.querySelector('#pp_ls_scan')?.addEventListener('change', e => { matStore(matPage).scan = e.target.checked; persist(); });
    zone.querySelector('#pp_ls_floors')?.addEventListener('change', e => {
        const mat = matStore(matPage);
        mat.floors = Math.max(0, Math.floor(Number(e.target.value) || 0));
        e.target.value = String(mat.floors);
        persist();
    });
    zone.querySelector('#pp_ls_scan_floors')?.addEventListener('change', e => {
        const mat = matStore(matPage);
        mat.scanFloors = Math.max(0, Math.floor(Number(e.target.value) || 0));
        e.target.value = String(mat.scanFloors);
        persist();
    });
    zone.querySelector('#pp_ls_lore')?.addEventListener('click', () => {
        if (matPage === 'routine') openLoreMgrWindow();   // 日常单：书单＋三按钮＋检索测试（第四十三轮新家）
        else openLorePickWindow('reentry');               // 重挂单：纯手选勾选照旧
    });

    const chipsBox = zone.querySelector('#pp_ls_mem_chips');
    const applyTags = () => {
        if (!chipsBox) return;
        matStore(matPage).memTags = [...chipsBox.querySelectorAll('[data-mtag]:checked')].map(x => x.dataset.mtag);
        persist();
    };
    const syncAll = () => {
        const allBox = chipsBox?.querySelector('[data-mtag-all]');
        if (!allBox) return;
        const boxes = [...chipsBox.querySelectorAll('[data-mtag]')];
        allBox.checked = boxes.length > 0 && boxes.every(b => b.checked);
        allBox.indeterminate = !allBox.checked && boxes.some(b => b.checked);
    };
    // 档位三段：就地翻高亮＋重建标签 chips（照第 1 步手法，不整页重渲染不丢滚动位置）
    const rewireChips = () => {
        if (!chipsBox) return;
        chipsBox.innerHTML = matTagChips(matStore(matPage));
        syncAll();
        chipsBox.querySelector('[data-mtag-all]')?.addEventListener('change', () => {
            const allBox = chipsBox.querySelector('[data-mtag-all]');
            chipsBox.querySelectorAll('[data-mtag]').forEach(cb => { cb.checked = allBox.checked; });
            applyTags();
            syncAll();
        });
        chipsBox.querySelectorAll('[data-mtag]').forEach(cb => cb.addEventListener('change', () => {
            applyTags();
            syncAll();
        }));
    };
    zone.querySelectorAll('.pp-seg[data-mseg] .pp-seg-opt').forEach(el => el.addEventListener('click', () => {
        if (el.classList.contains('on')) return;
        const mat = matStore(matPage);
        mat.memModes = { ...(mat.memModes ?? {}), [el.closest('.pp-seg').dataset.mseg]: el.dataset.state };
        persist();
        el.closest('.pp-seg').querySelectorAll('.pp-seg-opt').forEach(o => o.classList.toggle('on', o === el));
        rewireChips();
    }));
    rewireChips();

    zone.querySelector('#pp_ls_mem_recent')?.addEventListener('change', e => {
        const mat = matStore(matPage);
        mat.memRecent = Math.max(0, Math.round(Number(e.target.value) || 0));
        e.target.value = String(mat.memRecent);
        persist();
    });
}

// ---------------------------------------------------------------------------
// 重挂单的「世界书自选」悬浮窗（第三十四轮起；第四十三轮收窄到重挂专用）：纯手选勾选——
// 勾上＝整条原文固定进重挂对账那次判定的材料。存 state.matReentry.picks，与向导第 1 步 /
// 长线页互不影响。交互照长线页同款：按书折叠、搜索、整书全勾/全清。
// （第四十三轮顺带修掉一个存量暗 bug：旧窗不分页签一律读日常单的勾选集——重挂页里勾单条
// 会把日常单的内容误写进重挂单；拆成专用窗后自然消失）
// ---------------------------------------------------------------------------

function openLorePickWindow() {
    let query = '';
    const foldState = new Map();
    let win = document.getElementById('pp_ls_lorewin');
    if (win) { win.remove(); }
    win = document.createElement('div');
    win.id = 'pp_ls_lorewin';
    win.className = 'pp-ls-float';
    document.body.appendChild(win);
    const isFolded = (book, searching) => (foldState.has(book.id) ? foldState.get(book.id) : !searching);
    const syncBtn = () => {
        const btn = document.getElementById('pp_ls_lore');
        if (btn) btn.textContent = `世界书自选（已勾 ${resolveLorePicks(listenerState().matReentry.picks ?? []).length} 条）`;
    };

    const render = () => {
        const books = settings.lorebooks ?? [];
        const sel = new Set(listenerState().matReentry.picks ?? []);
        if (!books.length) {
            win.innerHTML = `
            <div class="pp-ls-float-head"><b>世界书自选 · 重挂对账</b><span id="pp_ls_lore_close" class="menu_button fa-solid fa-xmark" title="关闭"></span></div>
            <div class="pp-ls-float-body"><div class="pp-muted">还没有世界书——在设置页「世界书库」区导入或新建后再来</div></div>`;
            win.querySelector('#pp_ls_lore_close').addEventListener('click', () => win.remove());
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
            <label title="勾上＝这条的原文整条固定进重挂对账那次判定的材料（不截断）"><input type="checkbox" data-lore="${escapeHtml(key)}" ${on ? 'checked' : ''} /></label>
            <span class="pp-kb-ebody" title="${escapeHtml(String(e.content ?? ''))}">${escapeHtml(String(e.comment ?? `条目 ${e.uid + 1}`))}</span>
        </div>`; }).join('')}`;
        }).join('');

        win.innerHTML = `
        <div class="pp-ls-float-head">
            <b>世界书自选 · 重挂对账</b>
            <span class="pp-muted">勾上＝整条原文固定进重挂对账那次判定的材料</span>
            <span id="pp_ls_lore_close" class="menu_button fa-solid fa-xmark" title="关闭"></span>
        </div>
        <div class="pp-ls-float-body">
        <input type="text" class="text_pole textarea_compact" id="pp_ls_lore_q" placeholder="搜条目（标题 / 内容 / 关键词）——只筛显示，不动勾选；检索时命中的书自动展开…" value="${escapeHtml(query)}" style="width:100%" />
        ${groupHtml || '<div class="pp-muted">没有命中检索词的条目，清空检索词看全部</div>'}
        <div class="pp-muted" style="margin-top:6px">勾上＝整条原文固定进重挂对账那次判定的材料（不截断）。条目行只显示名字，原文悬浮可看全文；不看关键词/常驻/书与条目的启用状态——勾选是唯一口径，禁用的书与条目照样能勾。重挂单不上三按钮机制（纯手选）——与「剧情指导」第 1 步、长线页、日常单的书单三按钮互不影响；无冷却</div>
        </div>`;

        win.querySelector('#pp_ls_lore_close').addEventListener('click', () => win.remove());
        const qEl = win.querySelector('#pp_ls_lore_q');
        qEl?.addEventListener('input', () => {
            query = qEl.value;
            render();
            const nq = win.querySelector('#pp_ls_lore_q');
            nq?.focus();
            nq?.setSelectionRange(nq.value.length, nq.value.length);
        });
        const apply = keys => {
            listenerState().matReentry.picks = [...keys];
            persistListener();
            render();
            syncBtn();
        };
        win.querySelectorAll('[data-lore]').forEach(cb => cb.addEventListener('change', () => {
            const s = new Set(listenerState().matReentry.picks ?? []);
            if (cb.checked) s.add(cb.dataset.lore); else s.delete(cb.dataset.lore);
            apply(s);
        }));
        win.querySelectorAll('[data-lbook]').forEach(cb => cb.addEventListener('change', () => {
            const s = new Set(listenerState().matReentry.picks ?? []);
            const book = (settings.lorebooks ?? []).find(b => b.id === cb.dataset.lbook);
            if (!book) return;
            for (const e of (book.entries ?? []).filter(e => e.content)) {
                const k = `${book.id}:${e.uid}`;
                if (cb.checked) s.add(k); else s.delete(k);
            }
            apply(s);
        }));
        win.querySelectorAll('[data-lfold]').forEach(el => el.addEventListener('click', () => {
            const id = el.dataset.lfold;
            const book = (settings.lorebooks ?? []).find(b => b.id === id);
            if (!book) return;
            const q2 = query.trim().toLowerCase();
            foldState.set(id, !isFolded(book, Boolean(q2)));
            render();
        }));
    };
    render();
}

// ---------------------------------------------------------------------------
// 日常单的「世界书条目」管理窗（第四十三轮，激活机制的新家）：书的启用（按聊天）＋每条
// 条目三档状态（停用/关键词/常驻，按聊天）＋检索测试（从世界书页搬来、按监听口径测）。
// 存储两处：书单＝chatdata 的 books 块（setChatBookEnabled）；条目状态＝监听聊天块的
// loreStatus（persistListener）。与向导第 1 步勾选、长线页勾选、重挂单手选互不影响
// ---------------------------------------------------------------------------

function openLoreMgrWindow() {
    let query = '';
    const foldState = new Map();
    let win = document.getElementById('pp_ls_lorewin');
    if (win) { win.remove(); }
    win = document.createElement('div');
    win.id = 'pp_ls_lorewin';
    win.className = 'pp-ls-float';
    document.body.appendChild(win);
    const isFolded = (book, searching) => (foldState.has(book.id) ? foldState.get(book.id) : !searching);
    const statusOf = key => listenerState().loreStatus[key] ?? 'key';
    const syncBtn = () => {
        const btn = document.getElementById('pp_ls_lore');
        if (!btn) return;
        const c = loreMgrCounts();
        btn.textContent = `世界书条目（常驻 ${c.always} · 关键词 ${c.key}${c.off ? ` · 停用 ${c.off}` : ''}）`;
    };

    const render = () => {
        const books = settings.lorebooks ?? [];
        if (!books.length) {
            win.innerHTML = `
            <div class="pp-ls-float-head"><b>世界书条目 · 日常监听</b><span id="pp_ls_lore_close" class="menu_button fa-solid fa-xmark" title="关闭"></span></div>
            <div class="pp-ls-float-body"><div class="pp-muted">还没有世界书——在设置页「世界书库」区导入或新建后再来</div></div>`;
            win.querySelector('#pp_ls_lore_close').addEventListener('click', () => win.remove());
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
            const enabled = chatBookEnabled(book);
            const folded = isFolded(book, searching);
            const st = { off: 0, key: 0, always: 0 };
            for (const e of entries) st[statusOf(`${book.id}:${e.uid}`)] = (st[statusOf(`${book.id}:${e.uid}`)] ?? 0) + 1;
            return `
        <div class="pp-gd-ughead">
            <label class="pp-label" title="本书是否参加本聊天的监听扫描：勾上＝书里的条目按各自状态参与；不勾＝整本不扫（常驻档也不带）。按聊天存——别的聊天不受影响；没动过书单的聊天沿用书的全局默认（导入时默认启用）"><input type="checkbox" data-lmen="${escapeHtml(book.id)}" ${enabled ? 'checked' : ''} /> ${escapeHtml(book.name)}${enabled ? '' : '（未启用）'}（常驻 ${st.always} · 关键词 ${st.key}${st.off ? ` · 停用 ${st.off}` : ''}）</label>
            <span class="menu_button" data-lfold="${escapeHtml(book.id)}"><i class="fa-solid fa-chevron-${folded ? 'right' : 'down'}"></i> ${folded ? '展开' : '收起'}</span>
        </div>
        ${folded ? '' : entries.map(e => {
            const key = `${book.id}:${e.uid}`;
            const cur = statusOf(key);
            return `
        <div class="pp-kb-erow">
            <div class="pp-seg" data-lseg="${escapeHtml(key)}" title="条目状态（按聊天存）：常驻＝每轮判定无条件整条带上（不看关键词）；关键词＝条目关键词出现在「关键词扫描层数」窗口的对话里才带；停用＝永不带。缺省＝关键词">
                <span class="pp-seg-opt${cur === 'off' ? ' on' : ''}" data-lstate="off">停用</span>
                <span class="pp-seg-opt${cur === 'key' ? ' on' : ''}" data-lstate="key">关键词</span>
                <span class="pp-seg-opt${cur === 'always' ? ' on' : ''}" data-lstate="always">常驻</span>
            </div>
            <span class="pp-kb-ebody" title="${escapeHtml(String(e.content ?? ''))}${(e.keys ?? []).length ? `\n\n〔关键词：${escapeHtml((e.keys ?? []).join('、'))}〕` : ''}">${escapeHtml(String(e.comment ?? `条目 ${e.uid + 1}`))}</span>
        </div>`; }).join('')}`;
        }).join('');

        win.innerHTML = `
        <div class="pp-ls-float-head">
            <b>世界书条目 · 日常监听</b>
            <span class="pp-muted">书的启用＋条目三档状态，按聊天存、就地编辑</span>
            <span id="pp_ls_lore_close" class="menu_button fa-solid fa-xmark" title="关闭"></span>
        </div>
        <div class="pp-ls-float-body">
        <input type="text" class="text_pole textarea_compact" id="pp_ls_lore_q" placeholder="搜条目（标题 / 内容 / 关键词）——只筛显示，不动状态；检索时命中的书自动展开…" value="${escapeHtml(query)}" style="width:100%" />
        ${groupHtml || '<div class="pp-muted">没有命中检索词的条目，清空检索词看全部</div>'}
        <details class="pp-fold" style="margin-top:8px">
            <summary title="从世界书页搬来的检索测试，改按监听口径测：用本窗的书单＋三档状态跑一次命中预览——「常驻」档无条件在列、「关键词」档按输入文本（留空＝「关键词扫描层数」窗口的最近楼层）匹配、「停用」档与未启用的书不出现">检索测试（按监听口径）</summary>
            <textarea id="pp_ls_lore_test_text" class="text_pole textarea_compact" rows="3" placeholder="输入一段测试剧情看会命中哪些条目；留空则按「关键词扫描层数」窗口的最近楼层来测"></textarea>
            <div class="pp-btn-row"><span id="pp_ls_lore_test_run" class="menu_button" title="按本窗书单与三档状态跑一次命中预览">测试命中</span></div>
            <div id="pp_ls_lore_test_out" class="pp-muted"></div>
        </details>
        <div class="pp-muted" style="margin-top:6px">这里管的是每轮例行判定自动带哪些世界书：「常驻」无条件整条带上、「关键词」按对话出现的关键词带（往回几层归判定材料区的「关键词扫描层数」管）、「停用」永不带、书不启用整本不扫。按聊天存——A 聊天的设定 B 聊天可以不同。条目正文与关键词数据在设置页「世界书库」区改。与「剧情指导」第 1 步勾选、长线页勾选、重挂单手选互不影响</div>
        </div>`;

        win.querySelector('#pp_ls_lore_close').addEventListener('click', () => win.remove());
        const qEl = win.querySelector('#pp_ls_lore_q');
        qEl?.addEventListener('input', () => {
            query = qEl.value;
            render();
            const nq = win.querySelector('#pp_ls_lore_q');
            nq?.focus();
            nq?.setSelectionRange(nq.value.length, nq.value.length);
        });
        win.querySelectorAll('[data-lmen]').forEach(cb => cb.addEventListener('change', () => {
            setChatBookEnabled(cb.dataset.lmen, cb.checked);
            render();   // 整窗重画：计数行与未启用标记跟着变
            syncBtn();
        }));
        win.querySelectorAll('[data-lseg] .pp-seg-opt').forEach(opt => opt.addEventListener('click', () => {
            if (opt.classList.contains('on')) return;
            const key = opt.closest('.pp-seg').dataset.lseg;
            const state = listenerState();
            if (opt.dataset.lstate === 'key') delete state.loreStatus[key];   // 关键词＝缺省档，不占键（残键纪律）
            else state.loreStatus[key] = opt.dataset.lstate;
            persistListener();
            render();
            syncBtn();
        }));
        win.querySelectorAll('[data-lfold]').forEach(el => el.addEventListener('click', () => {
            const id = el.dataset.lfold;
            const book = (settings.lorebooks ?? []).find(b => b.id === id);
            if (!book) return;
            const q2 = query.trim().toLowerCase();
            foldState.set(id, !isFolded(book, Boolean(q2)));
            render();
        }));
        win.querySelector('#pp_ls_lore_test_run')?.addEventListener('click', () => {
            const out = win.querySelector('#pp_ls_lore_test_out');
            const typed = win.querySelector('#pp_ls_lore_test_text')?.value.trim() ?? '';
            let text = typed;
            let note = '输入文本';
            if (!text) {
                const chat = SillyTavern.getContext().chat;
                const all = collectFloorsFromChat(Array.isArray(chat) ? chat : []);
                text = formatFloors(limitFloors(all, Number(listenerState().matRoutine.scanFloors) || 0));
                note = `最近楼层（「关键词扫描层数」窗口${Number(listenerState().matRoutine.scanFloors) || 0 ? ` ${listenerState().matRoutine.scanFloors} 层` : '＝全聊天'}）`;
            }
            const hits = scanLorebooks(text, { enabledIds: chatEnabledBookIds(), statusMap: listenerState().loreStatus });
            const always = hits.filter(h => h.constant);
            const keyed = hits.filter(h => !h.constant);
            out.innerHTML = `
            <div class="pp-muted">扫描文本（${note}，夹 ${clamp(text.replace(/\s+/g, ' '), 120)}）</div>
            ${hits.length ? hits.map(h => `
            <div class="pp-hit"><b>${escapeHtml(h.bookName)} / ${escapeHtml(h.comment ?? '')}${h.constant ? '（常驻）' : ''}</b><div>${escapeHtml(clamp(h.content, 300))}</div></div>`).join('') : '<div class="pp-muted">未命中任何条目（常驻 ${always.length} · 关键词命中 ${keyed.length}）</div>'}
            <div class="pp-muted">共 ${hits.length} 条（常驻 ${always.length} · 关键词命中 ${keyed.length}）——这就是下一次例行判定会自动带的世界书</div>`;
        });
    };
    render();
    syncBtn();
}

// ---------------------------------------------------------------------------
// 留痕悬浮窗（平时折叠成按钮，点开才看；挂 body、不吃 .pp-drawer 作用域）
// ---------------------------------------------------------------------------

function openTraceWindow() {
    if (document.getElementById('pp_ls_tracewin')) {
        refreshTraceWindow();
        return;
    }
    const win = document.createElement('div');
    win.id = 'pp_ls_tracewin';
    win.className = 'pp-ls-float';
    document.body.appendChild(win);
    refreshTraceWindow();
}

function refreshTraceWindow() {
    if (!traceWinOpen) return;
    const win = document.getElementById('pp_ls_tracewin');
    if (!win) return;
    const state = listenerState();
    const cfg = listenerCfg();
    const rows = state.trace.map(rec => {
    // 留痕来源标签（2026-09-02 三来源共用滚动池）：普通剧情规划 / 长线剧情 / 换装；
    // 轻量轮不带标签（无挂载规划的例行检查不属于三来源）；旧记录无 src 也不带
    const srcChip = TRACE_SRC_LABEL[rec.src]
        ? `<span class="pp-ls-srclabel pp-ls-srclabel-${rec.src}" title="留痕来源：${TRACE_SRC_LABEL[rec.src]}（三来源共用同一个滚动池）">${TRACE_SRC_LABEL[rec.src]}</span>`
        : '';
    const head = rec.mode === 'outfit'
        ? `<b>换装</b> · ${fmtTime(rec.at)} · 「${escapeHtml(rec.outfit?.title ?? '')}」${escapeHtml(rec.outfit?.setting ?? '')}${rec.outfit?.end ? ` · 已${escapeHtml(rec.outfit.end.status)}` : ' · 注入中'}`
        : rec.mode === 'mix'
        ? `<b>混合重编</b> · ${fmtTime(rec.at)} · 「${escapeHtml(rec.mix?.title ?? '')}」`
        : rec.mode === 'rollback'
        ? `<b>${rec.rollback?.guide ? '指导沿用' : rec.rollback?.kind === 'manual' ? '节点回退' : '删楼回退'}</b> · ${fmtTime(rec.at)} · ${escapeHtml(traceSummary(rec))}`
        : `<b>#${rec.round}</b> ${rec.mode === 'unit' ? '单位' : rec.mode === 'reentry' ? '回归' : '轻量'} · ${fmtTime(rec.at)} · ${escapeHtml(traceSummary(rec))}`;
    return `
    <details class="pp-fold pp-ls-trace-item">
        <summary>
            ${head}${srcChip}
            ${rec.tokens ? `<span class="pp-muted">${rec.tokens.promptTokens.toLocaleString()}/${rec.tokens.completionTokens.toLocaleString()} tok</span>` : ''}
        </summary>
        <div class="pp-ls-trace-body">
        ${!rec.ok ? `<div class="pp-ls-err">${escapeHtml(rec.error ?? '')}</div>` : ''}
        ${rec.mode === 'outfit' && rec.ok ? `
            <div>开始注入：${escapeHtml(rec.outfit?.setting ?? '')}${rec.outfit?.end ? ` · 结束：${escapeHtml(rec.outfit.end.status)}（${fmtTime(rec.outfit.end.at)}）` : ' · 注入中'}</div>
            <div class="pp-ls-guidance" title="这套装扮的全文快照（开始注入那一刻记的；到期/被覆盖/撤下时在这一条上补结束状态）">${escapeHtml(rec.outfit?.text ?? '')}</div>
        ` : ''}
        ${rec.mode === 'mix' && rec.ok ? `
            <div>${rec.mix?.remount === 'inplace' ? '在岗章就地换新' : rec.mix?.remount === 'rejected' ? '挂载被拒——章已重写，处理完退位槽后去长线页手动挂载' : '重新挂载'}${rec.mix?.floorsRec ? ` · 楼层推荐 ${rec.mix.floorsRec} 层（本章预算不变）` : ''}；点亮进度不动、旧版在该章「混合历史」（长线页章卡可看）</div>
            ${rec.mix?.idea ? `<div class="pp-muted">想法：${escapeHtml(clamp(rec.mix.idea, 200))}</div>` : ''}
            ${rec.mix?.remountReason ? `<div class="pp-ls-err">${escapeHtml(rec.mix.remountReason)}</div>` : ''}
            ${rec.mix?.changesNote ? `<div class="pp-ls-reentry-summary">${escapeHtml(rec.mix.changesNote)}</div>` : ''}
        ` : ''}
        ${rec.mode === 'unit' && rec.ok ? `
            <div>判定：<b>${escapeHtml(rec.judgment)}</b>${rec.litNode ? ` · 点亮节点：${escapeHtml(rec.litNode)}${rec.litFloor ? `（第 ${rec.litFloor} 层点亮）` : ''}` : ''}</div>
            ${rec.suspended ? '<div class="pp-muted">挂起轮：判定与进度账照跑、指导未注入（偏大挂起中）</div>' : ''}
            ${rec.hold ? '<div class="pp-muted">暂停推进轮（手动）：节点方向与暗牌停发、点亮冻结；四查照跑、达门槛的修正照发</div>' : ''}
            ${rec.progressNote ? `<div class="pp-muted">${escapeHtml(rec.progressNote)}</div>` : ''}
            ${(rec.evidence ?? []).map(e => `<div class="pp-ls-ev">${e.floor != null ? `<b>[楼层${e.floor}]</b> ` : ''}「${escapeHtml(clamp(e.quote, 120))}」<span class="pp-muted">${escapeHtml(clamp(e.note, 80))}</span></div>`).join('')}
            ${(rec.watch && (rec.watch.ooc || rec.watch.slowBurn || rec.watch.fakeCompletion || rec.watch.notes)) ? `<div class="pp-muted">watch：${[rec.watch.ooc ? 'OOC元对话' : '', rec.watch.slowBurn ? '慢热' : '', rec.watch.fakeCompletion ? '疑似假装完成' : '', rec.watch.notes ? escapeHtml(clamp(rec.watch.notes, 80)) : ''].filter(Boolean).join('｜')}</div>` : ''}
            ${(rec.findings && (rec.findings.ooc?.found || rec.findings.plotRepeat?.found || (rec.findings.styleRepeat && rec.findings.styleRepeat.level !== '无') || rec.findings.userEcho?.found)) ? `<div class="pp-muted">四查：${escapeHtml(lightChecksLine(rec.findings))}（明细在监听页「检查报告」区，达门槛的修正已并入本轮指导）</div>` : ''}
        ` : ''}
        ${rec.mode === 'reentry' && rec.ok ? `
            <div>${escapeHtml(DEV_LABEL[rec.reentry?.deviation] ?? '')} · 走到第 ${rec.reentry?.applied ?? 0}/${rec.reentry?.nodesTotal ?? '?'} 节点（挂载时账面 ${rec.reentry?.before ?? 0}${rec.reentry?.anchorFloor ? ` · 新点亮锚定第 ${rec.reentry.anchorFloor} 层` : ''}）</div>
            ${rec.reentry?.window ? `<div class="pp-muted">对照窗口：${escapeHtml(rec.reentry.window)}</div>` : ''}
            ${rec.reentry?.deviationNote ? `<div class="pp-muted">${escapeHtml(rec.reentry.deviationNote)}</div>` : ''}
            ${rec.reentry?.summary ? `<div class="pp-ls-reentry-summary">${escapeHtml(rec.reentry.summary)}</div>` : ''}
            ${(rec.reentry?.evidence ?? []).map(e => `<div class="pp-ls-ev">${e.floor != null ? `<b>[楼层${e.floor}]</b> ` : ''}「${escapeHtml(clamp(e.quote, 120))}」<span class="pp-muted">${escapeHtml(clamp(e.note, 80))}</span></div>`).join('')}
        ` : ''}
        ${rec.mode === 'light' && rec.ok ? `
            ${(rec.findings?.ooc?.items ?? []).map(it => `<div class="pp-ls-ev"><b>OOC·${escapeHtml(it.aspect)}·${escapeHtml(it.severity)}</b> ${escapeHtml(clamp(it.evidence, 100))}<span class="pp-muted">建议：${escapeHtml(clamp(it.fix, 80))}</span></div>`).join('')}
            ${(rec.findings?.plotRepeat && (rec.findings.plotRepeat.found || rec.findings.plotRepeat.note)) ? `<div class="pp-ls-ev"><b>剧情重复${rec.findings.plotRepeat.found ? '' : '·无'}</b> ${escapeHtml(rec.findings.plotRepeat.note)}${rec.findings.plotRepeat.fix ? `<span class="pp-muted">改法：${escapeHtml(clamp(rec.findings.plotRepeat.fix, 100))}</span>` : ''}</div>` : ''}
            ${(rec.findings?.styleRepeat && (rec.findings.styleRepeat.level !== '无' || rec.findings.styleRepeat.note)) ? `<div class="pp-ls-ev"><b>文风重复·${escapeHtml(rec.findings.styleRepeat.level)}</b> ${escapeHtml(rec.findings.styleRepeat.note)}${rec.findings.styleRepeat.fix ? `<span class="pp-muted">改法：${escapeHtml(clamp(rec.findings.styleRepeat.fix, 100))}</span>` : ''}</div>` : ''}
            ${(rec.findings?.userEcho && (rec.findings.userEcho.found || rec.findings.userEcho.note)) ? `<div class="pp-ls-ev"><b>复读 user 的话${rec.findings.userEcho.found ? '' : '·无'}</b> ${escapeHtml(rec.findings.userEcho.note)}${rec.findings.userEcho.fix ? `<span class="pp-muted">改法：${escapeHtml(clamp(rec.findings.userEcho.fix, 100))}</span>` : ''}</div>` : ''}
        ` : ''}
        ${rec.mode === 'rollback' && rec.ok && rec.rollback?.guide ? `
            <div>${rec.rollback.guide.trigger === 'delete' ? `删楼后重做第 ${rec.rollback.guide.target} 层` : `滑动/重新生成第 ${rec.rollback.guide.target} 层`}：${rec.rollback.guide.reuse ? '注入槽已换回那一轮的原指导' : '那一轮没有原指导记录（升级前生成/超出留存/单位换过主人），本次不注入指导'}${rec.rollback.lastFloor != null ? `（现存最后一层 ${rec.rollback.lastFloor}）` : ''}</div>
            <div class="pp-muted">只换注入内容：重做落地后判定轮照常重跑、节点可再次点亮</div>
        ` : ''}
        ${rec.mode === 'rollback' && rec.ok && !rec.rollback?.guide && rec.rollback?.kind !== 'manual' ? `
            <div>「${escapeHtml(rec.rollback?.label ?? '')}」：第 ${rec.rollback?.from} → ${rec.rollback?.to} 节点（现存最后一层 ${rec.rollback?.lastFloor}）</div>
            ${(rec.rollback?.unlit ?? []).map(u => `<div class="pp-ls-ev">熄灭：${escapeHtml(u.title)}${u.anchor ? `（锚定第 ${u.anchor} 层——该楼已删）` : ''}</div>`).join('')}
            <div class="pp-muted">纯账本回退、不调用模型；被删楼层里的剧情后续重新演出会再次点亮</div>
        ` : ''}
        ${rec.mode === 'rollback' && rec.ok && rec.rollback?.kind === 'manual' ? `
            <div>「${escapeHtml(rec.rollback?.label ?? '')}」：第 ${rec.rollback?.from} → ${rec.rollback?.to} 节点（手动回退，误判达成的纠错）</div>
            ${(rec.rollback?.unlit ?? []).map(u => `<div class="pp-ls-ev">退回待判：${escapeHtml(u.title)}${u.anchor ? `（原点亮锚定第 ${u.anchor} 层）` : ''}</div>`).join('')}
            <div class="pp-muted">纯账本回退、不调用模型，注入槽里的旧方向已清空；退回的节点下一轮判定重新对它跑，剧情演到会再次点亮</div>
        ` : ''}
        ${rec.guidance ? `<div class="pp-ls-guidance">${escapeHtml(rec.guidance)}</div>` : (rec.ok && rec.mode !== 'reentry' && rec.mode !== 'outfit' && rec.mode !== 'rollback' ? `<div class="pp-muted">静默原因：${escapeHtml(rec.noGuidanceReason || '未给原因')}</div>` : '')}
        ${rec.materials ? `<div class="pp-muted" title="本轮实际喂给监听模型的材料清单">材料：${escapeHtml(materialsLine(rec.materials))}</div>` : ''}
        ${rec.retried ? '<div class="pp-muted">（本轮经过一次坏输出自动修复重试）</div>' : ''}
        </div>
    </details>`;
    }).join('');

    win.innerHTML = `
    <div class="pp-ls-float-head">
        <b>监听留痕</b>
        <span class="pp-muted">最新在前 · 共 ${state.trace.length} 条（滚动保留 ${cfg.traceRounds} 轮）</span>
        <span id="pp_ls_trace_close" class="menu_button fa-solid fa-xmark" title="关闭"></span>
    </div>
    <div class="pp-ls-float-body">${rows || '<div class="pp-muted">还没有留痕记录</div>'}</div>`;
    win.querySelector('#pp_ls_trace_close').addEventListener('click', () => {
        traceWinOpen = false;
        win.remove();
    });
}
