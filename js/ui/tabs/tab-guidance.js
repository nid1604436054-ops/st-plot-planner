// 剧情指导页签：OOC 检测 + 剧情规划
// 工作流：分析 → 编辑/按意见重写（迭代）→ 转为隐身注入（明盘）
import { runPlotGuidance } from "../../planner.js";
import { addInjection } from "../../injection.js";
import { escapeHtml } from "../../utils.js";

// 会话内状态：切换页签后保留本次结果
const state = { result: null, raw: '', planText: '', hits: 0 };

export const guidanceTab = {
    id: 'guidance',
    title: '剧情指导',
    render(container) {
        container.innerHTML = `
        <div class="pp-section">
            <label class="pp-label">补充说明（可选：本次规划的关注点、约束）</label>
            <textarea id="pp_gd_note" class="text_pole textarea_compact" rows="2"></textarea>
            <div class="pp-btn-row">
                <div id="pp_gd_run" class="menu_button">开始分析</div>
            </div>
            <div id="pp_gd_status" class="pp-muted"></div>
        </div>
        <div id="pp_gd_output"></div>`;

        container.querySelector('#pp_gd_run').addEventListener('click', () => analyze(container));
        if (state.result) renderResult(container);
    },
};

async function analyze(container, { revise = false } = {}) {
    const status = container.querySelector('#pp_gd_status');
    const note = container.querySelector('#pp_gd_note')?.value.trim() ?? '';
    status.textContent = '规划中……（走插件独立 API，不影响主对话）';
    try {
        const options = revise
            ? {
                userNote: note,
                previousPlan: state.planText,
                revisionNote: container.querySelector('#pp_gd_revise_note')?.value.trim() ?? '',
            }
            : { userNote: note };
        const data = await runPlotGuidance(options);
        state.result = data.result;
        state.raw = data.raw;
        state.hits = data.hits;
        state.planText = formatPlan(data.result.plan);
        renderResult(container);
        status.textContent = `完成（命中世界书 ${data.hits} 条）`;
    } catch (err) {
        status.textContent = '';
        toastr.error(String(err.message ?? err));
    }
}

function formatPlan(plan) {
    if (!plan) return '';
    const beats = (plan.beats ?? []).map((b, i) => `${i + 1}. [${b.stage ?? ''}] ${b.content ?? ''}`).join('\n');
    const risks = (plan.risks ?? []).length ? `风险注意：${plan.risks.join('；')}` : '';
    return [plan.summary ?? '', beats, risks].filter(Boolean).join('\n\n');
}

function renderResult(container) {
    const out = container.querySelector('#pp_gd_output');
    const ooc = state.result?.ooc;
    const items = ooc?.items ?? [];

    out.innerHTML = `
        <div class="pp-section">
            <b>OOC 检测</b>
            ${ooc?.found && items.length
                ? items.map(it => `
                    <div class="pp-hit">
                        <b>${escapeHtml(it.aspect ?? '')} · ${escapeHtml(it.severity ?? '')}</b>
                        <div>${escapeHtml(it.evidence ?? '')}</div>
                        <div class="pp-muted">建议：${escapeHtml(it.fix ?? '')}</div>
                    </div>`).join('')
                : '<div class="pp-muted">未发现明显 OOC</div>'}
        </div>
        <div class="pp-section">
            <b>剧情规划（可编辑，编辑结果即注入内容）</b>
            <textarea id="pp_gd_plan" class="text_pole textarea_compact" rows="10"></textarea>
            <label class="pp-label">修改意见（让 AI 按意见重写）</label>
            <textarea id="pp_gd_revise_note" class="text_pole textarea_compact" rows="2"></textarea>
            <div class="pp-btn-row">
                <div id="pp_gd_revise" class="menu_button">按意见重写</div>
                <div id="pp_gd_inject" class="menu_button">转为隐身注入</div>
            </div>
        </div>`;

    const planEl = out.querySelector('#pp_gd_plan');
    planEl.value = state.planText;
    planEl.addEventListener('input', () => { state.planText = planEl.value; });

    out.querySelector('#pp_gd_revise').addEventListener('click', () => analyze(container, { revise: true }));
    out.querySelector('#pp_gd_inject').addEventListener('click', () => {
        const content = state.planText.trim();
        if (!content) {
            toastr.warning('规划内容为空');
            return;
        }
        addInjection({
            id: `inj-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
            label: `剧情规划 ${new Date().toLocaleTimeString()}`,
            mode: 'open',
            content,
            depth: 4,
            role: 'system',
            scope: 'chat',
            enabled: true,
            source: 'planner',
            createdAt: Date.now(),
            expires: { type: 'never' },
        });
        toastr.success('已注入（明盘：模型可见，聊天界面不显示）');
        document.dispatchEvent(new CustomEvent('pp-switch-tab', { detail: { id: 'injections' } }));
    });
}
