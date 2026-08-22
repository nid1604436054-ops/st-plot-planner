// 剧情指导页签：OOC 检测 + 剧情规划
// 工作流：分析 → 编辑/按意见重写（迭代）→ 转为隐身注入（明盘）
// 「规划预设」：用户固定的格式/文风要求，每次分析自动追加进系统提示词（区别于单次生效的「补充说明」）
import { runPlotGuidance, GUIDANCE_SYSTEM_PROMPT } from "../../planner.js";
import { addInjection } from "../../injection.js";
import { settings, save } from "../../settings.js";
import { escapeHtml } from "../../utils.js";

// 会话内状态：切换页签后保留本次结果；预设区折叠状态跨重渲染保持
const state = { result: null, raw: '', planText: '', hits: 0 };
let presetOpen = false;

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
        <div class="pp-section" id="pp_gd_preset"></div>
        <div id="pp_gd_output"></div>`;

        container.querySelector('#pp_gd_run').addEventListener('click', () => analyze(container));
        renderPreset(container);
        if (state.result) renderResult(container);
    },
};

// 规划预设区：默认折叠成一条摘要行（和记忆表格「原表库」同款交互），写入即时保存
function renderPreset(container) {
    const el = container.querySelector('#pp_gd_preset');
    const value = settings.guidance?.customPrompt ?? '';
    const status = value.trim() ? `已设置 · ${value.trim().length} 字` : '未设置';
    const head = `
    <div class="pp-item" id="pp_gd_preset_head" title="写一次、每次分析都自动生效的固定要求；「补充说明」则是只对本次分析生效">
        <div class="pp-item-main"><b>规划预设（固定要求）</b></div>
        <div class="pp-item-ops">
            <span class="pp-muted">${status}</span>
            <span class="menu_button" id="pp_gd_preset_toggle">${presetOpen ? '收起' : '编辑'} <i class="fa-solid fa-chevron-${presetOpen ? 'down' : 'right'}"></i></span>
        </div>
    </div>`;

    el.innerHTML = `
    ${head}
    ${presetOpen ? `
    <label class="pp-label">每次分析都会随提示词发给模型：对规划的内容格式、文风、篇幅、侧重点的固定要求。改动即时保存。输出须仍是 JSON 骨架（程序要解析），所以格式要求写在内容层面（如每个阶段的写法、语言、详细程度），别要求改成纯正文。</label>
    <textarea id="pp_gd_preset_text" class="text_pole textarea_compact" rows="6" placeholder="例：&#10;1. 用中文写，文风克制、不堆形容词；&#10;2. 每个阶段 content 至少两句话，写清幕后安排和动因；&#10;3. beats 按「铺垫→推进→转折→收束」组织，共 4-6 个阶段。"></textarea>
    <div class="pp-btn-row">
        <span id="pp_gd_preset_clear" class="menu_button" title="清空预设（恢复为不追加任何固定要求）">清空预设</span>
        <span id="pp_gd_preset_builtin" class="menu_button" title="展开查看内置的系统指令和预设拼接的位置">查看内置指令</span>
    </div>
    <div id="pp_gd_preset_view" class="pp-gd-builtin" style="display:none"></div>` : ''}`;

    el.querySelector('#pp_gd_preset_toggle').addEventListener('click', () => {
        presetOpen = !presetOpen;
        renderPreset(container);
    });
    if (!presetOpen) return;

    const textEl = el.querySelector('#pp_gd_preset_text');
    textEl.value = value;
    textEl.addEventListener('input', () => {
        settings.guidance.customPrompt = textEl.value;
        save();
        const n = textEl.value.trim().length;
        el.querySelector('#pp_gd_preset_head .pp-muted').textContent = n ? `已设置 · ${n} 字` : '未设置';
    });
    el.querySelector('#pp_gd_preset_clear').addEventListener('click', () => {
        if (!settings.guidance.customPrompt) { toastr.info('预设本来就是空的'); return; }
        settings.guidance.customPrompt = '';
        save();
        renderPreset(container);
        toastr.success('已清空预设');
    });
    el.querySelector('#pp_gd_preset_builtin').addEventListener('click', () => {
        const view = el.querySelector('#pp_gd_preset_view');
        const show = view.style.display === 'none';
        view.style.display = show ? '' : 'none';
        if (show) {
            view.textContent = `${GUIDANCE_SYSTEM_PROMPT}\n\n## 用户固定要求（在不改变上述 JSON 输出格式的前提下遵照执行）\n（你在上面写的预设会追加在这里，随每次分析一起发给模型）`;
        }
    });
}

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
