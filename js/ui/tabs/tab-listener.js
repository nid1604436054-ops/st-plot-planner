// 监听页签（2.0 新页签）：状态条 / 当前单位区 / 本轮指导区 / 旋钮区 四块 + 留痕折叠按钮（悬浮窗）。
// 面板只做展示与低频操作；逐轮判定循环在 js/listener.js，写完一轮派发 pp-listener-updated，
// 本页签挂着的时候就地刷新（不在 DOM 里的事件直接丢弃，下次激活重渲染）。
import { settings, save } from "../../settings.js";
import { escapeHtml, clamp } from "../../utils.js";
import { storyState } from "../../story.js";
import { resolveLorePicks } from "../../lorebook.js";
import { memoryState } from "../../memoryTable.js";   // 判定材料区的记忆挑选器（第三十七轮）：读镜像表与标签
// 监听槽一动就对一次长线账本（listener.js 不能反向引 longform.js——longform 已经引了监听，只能在界面层搭桥）
import { syncLfProgress, scheduleReentryFor } from "../../longform.js";
import {
    listenerState, listenerCfg, listenerProvider, listenerModeLabel, persistListener,
    runListenerRound, resumeListener, setListenerEnabled, manualLitCurrentNode,
    opMountUnit, opUnmountUnit, opRecallSidelined, opDiscardSidelined,
    makeUnitFromText, makeUnitFromStory, lastListenerPrompt,
} from "../../listener.js";

let traceWinOpen = false;   // 留痕悬浮窗开着（跨页签会话记忆）

const SOURCE_BADGE = { manual: '手动导入', plan10: '剧情规划导入', longform: '长线章' };

// 回归判定的偏离三档（第三十三轮）：措辞给用户看，不照搬模型内部词
const DEV_LABEL = { on_track: '没偏——剧情仍在规划轨迹上', minor: '偏了，但能自然拉回', major: '⚠ 偏大了——继续演会损坏后续章节的安排' };

// 材料清单一行（第三十三轮透明化、第三十四轮改世界书自选）：留痕里的 materials 小账拼成大白话
function materialsLine(m) {
    if (!m) return '';
    const parts = [];
    if (m.window) parts.push(`五章窗口 ${m.window}（${Number(m.windowChars || 0).toLocaleString()} 字）`);
    else parts.push(m.light ? '轻量检查（无单位）' : `单位全文 ${Number(m.unitChars || 0).toLocaleString()} 字`);
    if (!m.light) parts.push(`节点 ${m.nodeIdx ?? 0}/${m.nodesTotal ?? 0}`);
    parts.push(Number(m.lorePicks) > 0 ? `世界书自选 ${m.lorePicks} 条（${Number(m.picksChars || 0).toLocaleString()} 字）` : '世界书自选 未勾');
    if (m.floors) parts.push(`楼层 ${m.floors.first}-${m.floors.last}（${m.floors.count} 层${m.floorsLimited ? ' · 限最近范围' : ''}）`);
    else parts.push('楼层 无');
    parts.push(m.loreHits == null ? '世界书检索 关' : `世界书命中 ${m.loreHits} 条`);
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

// 最新一条留痕记录（指导区与问题区都从它读）
function lastTrace(state) {
    return Array.isArray(state.trace) ? state.trace[0] ?? null : null;
}

// 三项小结一行（页内静默轮/留痕共用口径）：无发现的项亮「无」、有发现的写实际发现
function lightChecksLine(f = {}) {
    const ooc = f.ooc?.found ? `OOC×${f.ooc.items?.length ?? 1}` : 'OOC 无';
    const plot = f.plotRepeat?.found ? '剧情重复' : '剧情重复 无';
    const style = f.styleRepeat?.level && f.styleRepeat.level !== '无' ? `文风${f.styleRepeat.level}` : '文风 无';
    return `${ooc} ／ ${plot} ／ ${style}`;
}

function traceSummary(rec) {
    if (!rec) return '';
    if (!rec.ok) return `失败：${clamp(rec.error, 60)}`;
    if (rec.mode === 'reentry') {
        const d = { on_track: '没偏', minor: '偏了可拉回', major: '偏大了⚠' }[rec.reentry?.deviation] ?? '';
        return `回归判定 · ${d} · 到第 ${rec.reentry?.applied ?? 0}/${rec.reentry?.nodesTotal ?? '?'} 节点`;
    }
    if (rec.mode === 'unit') {
        const j = { achieved: '达成✓', not_yet: '未达成', stuck: '卡死⚠' }[rec.judgment] ?? rec.judgment;
        return rec.guidance ? `${j} · 已发指导` : `${j} · 静默（${clamp(rec.noGuidanceReason || '未给原因', 40)}）`;
    }
    const f = rec.findings ?? {};
    const parts = [
        f.ooc?.found ? `OOC×${f.ooc.items?.length ?? 1}` : '',
        f.plotRepeat?.found ? '剧情重复' : '',
        f.styleRepeat && f.styleRepeat.level !== '无' ? `文风${f.styleRepeat.level}` : '',
    ].filter(Boolean);
    return parts.length ? `发现：${parts.join('、')}${rec.guidance ? ' · 已发修正' : ''}` : '三项无发现（静默）';
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
                    ? `<span id="pp_ls_next" class="menu_button" title="末节点已点亮后的手动衔接（无自动档）：退位槽有单位就接回，没有就去下面导入下一个">接续下一单位</span>`
                    : `<span id="pp_ls_lit" class="menu_button" title="人工拍板：不等模型判定，直接把当前待判节点记为达成（两本账里用户显式操作可改进度账）">标记达成</span>`}
                <span id="pp_ls_unmount" class="menu_button" title="卸下当前单位（进退位槽，进度原样保留，可再接回）；卸下后本聊天按轻量口径执勤">卸下</span>
            </div>
        </div>
        <div class="pp-ls-nodes">
            ${unit.nodes.map((n, i) => `
            <div class="pp-ls-node ${i < unit.nodeIdx ? 'pp-ls-node-lit' : ''} ${i === unit.nodeIdx ? 'pp-ls-node-cur' : ''}">
                <span class="pp-ls-node-state">${i < unit.nodeIdx ? '✓' : (i === unit.nodeIdx ? (stuckShown ? '⚠卡死' : '待判') : '未到')}</span>
                <span class="pp-ls-node-title" title="${escapeHtml(n.criterion)}">${escapeHtml(n.title)}</span>
                <span class="pp-muted pp-ls-node-crit">${escapeHtml(clamp(n.criterion, 44))}</span>
            </div>`).join('')}
        </div>
    </div>` : `
    <div class="pp-section">
        <div class="pp-muted">当前没有挂载单位——轻量执勤中（OOC / 剧情重复 / 文风重复三项检查）。要按规划逐节点推进，从下面挂载一个单位。</div>
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
        ${rec.tokens ? `<span class="pp-muted">${rec.tokens.promptTokens.toLocaleString()}/${rec.tokens.completionTokens.toLocaleString()} tok</span>` : ''}
    </div>` : `
    <div class="pp-section pp-ls-reentry">
        <b>回归判定失败</b>
        <div class="pp-ls-err">${escapeHtml(rec.error ?? '')}</div>
        <div class="pp-muted">账面进度不变；下一轮扮演输出后照常例行判定。</div>
    </div>`) : ''}

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
            <label title="介入强度——管指导发多勤（接管全部频控行为）。单位模式：低＝仅明显偏航或停滞时发；中＝例行轻推，允许静默轮；高＝每轮都发（卡死除外）。轻量模式：发现问题就发——低＝仅很轻微的不发（OOC 轻微／文风轻微静默），中／高＝有任何发现就发（轻微也发）">
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
        <b>挂载单位</b>
        <div class="pp-ls-mount">
            <div class="pp-ls-mount-col">
                <span class="pp-ls-mount-title" title="把一份带完成标准的规划文本挂进单位槽；先做成单节点（整个文本一块判），2.0 管线产物会自带节点表">手动导入</span>
                <input id="pp_ls_m_title" class="text_pole textarea_compact" type="text" placeholder="单位标题（可留空）" />
                <textarea id="pp_ls_m_text" class="text_pole textarea_compact" rows="4" placeholder="粘贴单位全文（规划文本／指导材料）"></textarea>
                <div><span id="pp_ls_mount_manual" class="menu_button">挂载</span></div>
            </div>
            <div class="pp-ls-mount-col">
                <span class="pp-ls-mount-title" title="1.0 剧情规划产物视为同等的最小剧情单位：规划的各阶段行直接当节点（完成标准＝该阶段安排实际发生）；只读取规划，不改 1.0 本身">从 1.0 剧情规划导入</span>
                ${(() => {
                    const s = storyState();
                    const list = s.history ?? [];
                    if (!list.length) return '<div class="pp-muted">当前聊天还没有剧情档案（在剧情指导页「确认采用」后才有）</div>';
                    return `<select id="pp_ls_m_story" class="text_pole">
                        ${list.map(h => `<option value="${escapeHtml(h.id)}">${escapeHtml(clamp(h.summary || h.note || '未命名规划', 40))}${h.id === s.activeId ? '（进行中）' : ''}</option>`).join('')}
                    </select>
                    <div><span id="pp_ls_mount_story" class="menu_button">挂载</span></div>`;
                })()}
            </div>
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
            toastr.info('退位槽是空的：到下方「挂载单位」导入下一个（手动导入 / 1.0 剧情规划导入）');
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

    container.querySelector('#pp_ls_mount_manual')?.addEventListener('click', () => {
        const title = String(container.querySelector('#pp_ls_m_title')?.value ?? '').trim();
        const text = String(container.querySelector('#pp_ls_m_text')?.value ?? '').trim();
        if (!text) { toastr.warning('单位内容为空'); return; }
        const r = opMountUnit(makeUnitFromText(title, text));
        if (r.ok) { syncLfProgress(); renderTab(container); toastr.success('单位已挂载（单节点：整个文本一块判）'); }
        else toastr.warning(r.reason);
    });

    container.querySelector('#pp_ls_mount_story')?.addEventListener('click', () => {
        const id = container.querySelector('#pp_ls_m_story')?.value;
        const entry = (storyState().history ?? []).find(h => h.id === id);
        const unit = entry ? makeUnitFromStory(entry) : null;
        if (!unit) { toastr.warning('这份规划是空的'); return; }
        const r = opMountUnit(unit);
        if (r.ok) { syncLfProgress(); renderTab(container); toastr.success(`已挂载「${unit.title}」：${unit.nodes.length} 个节点（各阶段直接当节点，完成标准＝该阶段安排实际发生）`); }
        else toastr.warning(r.reason);
    });

    container.querySelector('#pp_ls_trace_btn')?.addEventListener('click', () => {
        traceWinOpen = true;
        openTraceWindow();
    });

    bindMatZone(container);
}

// ---------------------------------------------------------------------------
// 判定材料区（第三十七轮，用户拍板）：两套材料单各自独立、按聊天存——「日常监听」＝每轮例行
// 判定（单位轮＋轻量轮共用），「重挂对账」＝重挂有进度的章那一刻、你开口对话前自动跑的一次性
// 回归判定。选择范围相同：世界书自选 / 记忆表格挑选器（照向导第 1 步同款克隆——用户定则：
// 一切提示词材料都在全量版本上做减法、一套机器，不做每板块单独算法）/ 世界书检索 / 楼层数。
// ---------------------------------------------------------------------------

let matPage = 'routine';   // 当前展开的页签（会话记忆；默认日常监听）

function matStore(kind) {
    const st = listenerState();
    return kind === 'reentry' ? st.matReentry : st.matRoutine;
}

function matPicksArr(kind) {
    return kind === 'reentry' ? (listenerState().matReentry.picks ?? []) : listenerState().lorePicks;
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
    <div class="pp-seg" id="pp_ls_mattab" title="两套材料单都按聊天存、勾选互不影响，选择范围相同（世界书自选 / 记忆表格 / 世界书检索 / 楼层数）">
        <span class="pp-seg-opt${kind === 'routine' ? ' on' : ''}" data-mpage="routine">日常监听</span>
        <span class="pp-seg-opt${kind === 'reentry' ? ' on' : ''}" data-mpage="reentry">重挂对账</span>
    </div>
    <span class="pp-muted">${zoneTip}</span>
    <div class="pp-ls-knobs">
        <span id="pp_ls_lore" class="menu_button" title="勾选世界书条目固定进本页材料单：整条原文、不截断、不看关键词/常驻/启用状态；与本页「世界书检索」自动去重（这边优先）">世界书自选（已勾 ${resolveLorePicks(matPicksArr(kind)).length} 条）</span>
        <label title="按最近楼层重扫世界书、命中条目随本页判定附带（共用「世界书」页的检索口径）；与本页「世界书自选」自动去重（自选优先）"><input type="checkbox" id="pp_ls_scan" ${mat.scan ? 'checked' : ''} /> 世界书检索</label>
        <label title="本页判定携带的楼层原文范围：0 = 全量（默认，判定引证最全）；N = 只带最近 N 层角色楼（其间夹的用户消息保留、楼层号仍是全聊天绝对号）——长对话省钱用，砍太狠可能伤判定准头，自己权衡">楼层数 <input id="pp_ls_floors" class="text_pole" type="number" min="0" step="5" value="${mat.floors}" /></label>
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
    zone.querySelector('#pp_ls_lore')?.addEventListener('click', () => openLorePickWindow(matPage));

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
// 世界书自选悬浮窗（第三十四轮；第三十七轮起按材料单分家）：勾选存监听自己的聊天块——
// 日常单写 state.lorePicks、重挂单写 state.matReentry.picks，与向导第 1 步 / 长线页互不影响。
// 交互照长线页同款：按书折叠、搜索、整书全勾/全清
// ---------------------------------------------------------------------------

function openLorePickWindow(kind = 'routine') {
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
        if (btn) btn.textContent = `世界书自选（已勾 ${resolveLorePicks(matPicksArr(kind)).length} 条）`;
    };

    const render = () => {
        const books = settings.lorebooks ?? [];
        const sel = new Set(matPicksArr(kind));
        if (!books.length) {
            win.innerHTML = `
            <div class="pp-ls-float-head"><b>世界书自选 · ${kind === 'reentry' ? '重挂对账' : '日常监听'}</b><span id="pp_ls_lore_close" class="menu_button fa-solid fa-xmark" title="关闭"></span></div>
            <div class="pp-ls-float-body"><div class="pp-muted">还没有世界书——在「世界书」页签导入或新建后再来</div></div>`;
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
            <label title="勾上＝这条的原文整条固定进${kind === 'reentry' ? '重挂对账那次判定' : '每轮例行判定'}的材料（不截断）"><input type="checkbox" data-lore="${escapeHtml(key)}" ${on ? 'checked' : ''} /></label>
            <span class="pp-kb-ebody" title="${escapeHtml(String(e.content ?? ''))}">${escapeHtml(String(e.comment ?? `条目 ${e.uid + 1}`))}</span>
        </div>`; }).join('')}`;
        }).join('');

        win.innerHTML = `
        <div class="pp-ls-float-head">
            <b>世界书自选 · ${kind === 'reentry' ? '重挂对账' : '日常监听'}</b>
            <span class="pp-muted">勾上＝整条原文固定进${kind === 'reentry' ? '重挂对账那次判定' : '每轮例行判定'}的材料</span>
            <span id="pp_ls_lore_close" class="menu_button fa-solid fa-xmark" title="关闭"></span>
        </div>
        <div class="pp-ls-float-body">
        <input type="text" class="text_pole textarea_compact" id="pp_ls_lore_q" placeholder="搜条目（标题 / 内容 / 关键词）——只筛显示，不动勾选；检索时命中的书自动展开…" value="${escapeHtml(query)}" style="width:100%" />
        ${groupHtml || '<div class="pp-muted">没有命中检索词的条目，清空检索词看全部</div>'}
        <div class="pp-muted" style="margin-top:6px">勾上＝整条原文固定进${kind === 'reentry' ? '重挂对账那次判定' : '每轮例行判定'}的材料（不截断）。条目行只显示名字，原文悬浮可看全文；不看关键词/常驻/书与条目的启用状态——勾选是唯一口径，禁用的书与条目照样能勾；与本页「世界书检索」自动去重（这边优先）。只管监听本页材料单——与「剧情指导」第 1 步、长线页、另一页材料单互不影响；无冷却</div>
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
            const s = listenerState();
            if (kind === 'reentry') s.matReentry.picks = [...keys];
            else s.lorePicks = [...keys];
            persistListener();
            render();
            syncBtn();
        };
        win.querySelectorAll('[data-lore]').forEach(cb => cb.addEventListener('change', () => {
            const s = new Set(listenerState().lorePicks);
            if (cb.checked) s.add(cb.dataset.lore); else s.delete(cb.dataset.lore);
            apply(s);
        }));
        win.querySelectorAll('[data-lbook]').forEach(cb => cb.addEventListener('change', () => {
            const s = new Set(listenerState().lorePicks);
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
    const rows = state.trace.map(rec => `
    <details class="pp-fold pp-ls-trace-item">
        <summary>
            <b>#${rec.round}</b> ${rec.mode === 'unit' ? '单位' : rec.mode === 'reentry' ? '回归' : '轻量'} · ${fmtTime(rec.at)} · ${escapeHtml(traceSummary(rec))}
            ${rec.tokens ? `<span class="pp-muted">${rec.tokens.promptTokens.toLocaleString()}/${rec.tokens.completionTokens.toLocaleString()} tok</span>` : ''}
        </summary>
        <div class="pp-ls-trace-body">
        ${!rec.ok ? `<div class="pp-ls-err">${escapeHtml(rec.error ?? '')}</div>` : ''}
        ${rec.mode === 'unit' && rec.ok ? `
            <div>判定：<b>${escapeHtml(rec.judgment)}</b>${rec.litNode ? ` · 点亮节点：${escapeHtml(rec.litNode)}` : ''}</div>
            ${rec.progressNote ? `<div class="pp-muted">${escapeHtml(rec.progressNote)}</div>` : ''}
            ${(rec.evidence ?? []).map(e => `<div class="pp-ls-ev">${e.floor != null ? `<b>[楼层${e.floor}]</b> ` : ''}「${escapeHtml(clamp(e.quote, 120))}」<span class="pp-muted">${escapeHtml(clamp(e.note, 80))}</span></div>`).join('')}
            ${(rec.watch && (rec.watch.ooc || rec.watch.slowBurn || rec.watch.fakeCompletion || rec.watch.notes)) ? `<div class="pp-muted">watch：${[rec.watch.ooc ? 'OOC元对话' : '', rec.watch.slowBurn ? '慢热' : '', rec.watch.fakeCompletion ? '疑似假装完成' : '', rec.watch.notes ? escapeHtml(clamp(rec.watch.notes, 80)) : ''].filter(Boolean).join('｜')}</div>` : ''}
        ` : ''}
        ${rec.mode === 'reentry' && rec.ok ? `
            <div>${escapeHtml(DEV_LABEL[rec.reentry?.deviation] ?? '')} · 走到第 ${rec.reentry?.applied ?? 0}/${rec.reentry?.nodesTotal ?? '?'} 节点（挂载时账面 ${rec.reentry?.before ?? 0}）</div>
            ${rec.reentry?.window ? `<div class="pp-muted">对照窗口：${escapeHtml(rec.reentry.window)}</div>` : ''}
            ${rec.reentry?.deviationNote ? `<div class="pp-muted">${escapeHtml(rec.reentry.deviationNote)}</div>` : ''}
            ${rec.reentry?.summary ? `<div class="pp-ls-reentry-summary">${escapeHtml(rec.reentry.summary)}</div>` : ''}
            ${(rec.reentry?.evidence ?? []).map(e => `<div class="pp-ls-ev">${e.floor != null ? `<b>[楼层${e.floor}]</b> ` : ''}「${escapeHtml(clamp(e.quote, 120))}」<span class="pp-muted">${escapeHtml(clamp(e.note, 80))}</span></div>`).join('')}
        ` : ''}
        ${rec.mode === 'light' && rec.ok ? `
            ${(rec.findings?.ooc?.items ?? []).map(it => `<div class="pp-ls-ev"><b>OOC·${escapeHtml(it.aspect)}·${escapeHtml(it.severity)}</b> ${escapeHtml(clamp(it.evidence, 100))}<span class="pp-muted">建议：${escapeHtml(clamp(it.fix, 80))}</span></div>`).join('')}
            ${(rec.findings?.plotRepeat && (rec.findings.plotRepeat.found || rec.findings.plotRepeat.note)) ? `<div class="pp-ls-ev"><b>剧情重复${rec.findings.plotRepeat.found ? '' : '·无'}</b> ${escapeHtml(rec.findings.plotRepeat.note)}</div>` : ''}
            ${(rec.findings?.styleRepeat && (rec.findings.styleRepeat.level !== '无' || rec.findings.styleRepeat.note)) ? `<div class="pp-ls-ev"><b>文风重复·${escapeHtml(rec.findings.styleRepeat.level)}</b> ${escapeHtml(rec.findings.styleRepeat.note)}</div>` : ''}
        ` : ''}
        ${rec.guidance ? `<div class="pp-ls-guidance">${escapeHtml(rec.guidance)}</div>` : (rec.ok && rec.mode !== 'reentry' ? `<div class="pp-muted">静默原因：${escapeHtml(rec.noGuidanceReason || '未给原因')}</div>` : '')}
        ${rec.materials ? `<div class="pp-muted" title="本轮实际喂给监听模型的材料清单">材料：${escapeHtml(materialsLine(rec.materials))}</div>` : ''}
        ${rec.retried ? '<div class="pp-muted">（本轮经过一次坏输出自动修复重试）</div>' : ''}
        </div>
    </details>`).join('');

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
