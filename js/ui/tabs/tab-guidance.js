// 剧情指导页签：OOC 检测 + 剧情规划
// 工作流：分析 → 编辑/按意见重写（迭代）→ 转为隐身注入（明盘）
// 「规划预设」：多条命名预设，勾选启用的按顺序拼进系统提示词（区别于单次生效的「补充说明」）
import { runPlotGuidance, GUIDANCE_SYSTEM_PROMPT } from "../../planner.js";
import { addInjection } from "../../injection.js";
import { settings, save, newId } from "../../settings.js";
import { escapeHtml } from "../../utils.js";

// 会话内状态：切换页签后保留本次结果；预设区折叠/编辑中状态跨重渲染保持
const state = { result: null, raw: '', planText: '', hits: 0 };
let presetOpen = false;
let editingPreset = null;   // 正在编辑内容的预设 id

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

// 规划预设区：多条命名预设（默认折叠成一条摘要行，交互同记忆表格「原表库」）。
// 勾选「启用」的预设按列表顺序拼接、随每次分析追加进系统提示词；所有改动即时保存。
function findPreset(id) {
    return (settings.guidance?.presets ?? []).find(p => p.id === id);
}

function presetSummary() {
    const list = settings.guidance?.presets ?? [];
    const n = list.filter(p => p.enabled).length;
    return list.length ? `${list.length} 个预设 · ${n} 个启用` : '未设置';
}

function presetRow(p, i, total) {
    const editing = editingPreset === p.id;
    return `
    <div class="pp-item" data-preset-item="${p.id}">
        <div class="pp-item-main">
            <label title="勾选后该预设随每次分析生效"><input type="checkbox" data-pena="${p.id}" ${p.enabled ? 'checked' : ''} /> <b class="pp-gd-pname">${escapeHtml(p.name)}</b></label>
        </div>
        <div class="pp-item-ops">
            <span class="pp-muted pp-gd-plen">${String(p.content ?? '').trim().length} 字</span>
            <span class="menu_button fa-solid fa-arrow-up" data-pup="${p.id}" title="上移（越靠前越先拼进提示词）" ${i === 0 ? 'style="visibility:hidden"' : ''}></span>
            <span class="menu_button fa-solid fa-arrow-down" data-pdown="${p.id}" title="下移" ${i === total - 1 ? 'style="visibility:hidden"' : ''}></span>
            <span class="menu_button" data-pedit="${p.id}">${editing ? '收起' : '编辑'}</span>
            <span class="menu_button fa-solid fa-trash" data-pdel="${p.id}" title="删除该预设"></span>
        </div>
    </div>
    ${editing ? `
    <div class="pp-gd-editor">
        <label class="pp-label">预设名</label>
        <input type="text" class="text_pole" data-pname="${p.id}" value="${escapeHtml(p.name)}" />
        <label class="pp-label">内容（对规划的内容格式、文风、篇幅、侧重点的要求，改动即时保存）</label>
        <textarea class="text_pole textarea_compact" rows="6" data-pcontent="${p.id}" placeholder="例：&#10;1. 用中文写，文风克制、不堆形容词；&#10;2. 每个阶段 content 至少两句话，写清幕后安排和动因；&#10;3. beats 按「铺垫→推进→转折→收束」组织。">${escapeHtml(p.content ?? '')}</textarea>
    </div>` : ''}`;
}

function renderPreset(container) {
    const el = container.querySelector('#pp_gd_preset');
    const presets = settings.guidance?.presets ?? [];
    const head = `
    <div class="pp-item" id="pp_gd_preset_head" title="写一次、每次分析都自动生效的固定要求；勾选启用的按顺序拼进系统提示词，「补充说明」则是只对本次分析生效">
        <div class="pp-item-main"><b>规划预设（固定要求）</b></div>
        <div class="pp-item-ops">
            <span class="pp-muted">${presetSummary()}</span>
            <span class="menu_button" id="pp_gd_preset_toggle">${presetOpen ? '收起' : '编辑'} <i class="fa-solid fa-chevron-${presetOpen ? 'down' : 'right'}"></i></span>
        </div>
    </div>`;

    if (!presetOpen) {
        el.innerHTML = head;
        el.querySelector('#pp_gd_preset_toggle').addEventListener('click', () => {
            presetOpen = true;
            renderPreset(container);
        });
        return;
    }

    el.innerHTML = `
    ${head}
    <label class="pp-label">勾选「启用」的预设按列表顺序拼接（每条自带预设名做小标题），随每次分析追加进系统提示词，可多条同时启用做组合。输出须仍是 JSON 骨架（程序要解析），所以格式要求写在内容层面（写法、语言、详细程度），别要求改成纯正文。</label>
    ${presets.map((p, i) => presetRow(p, i, presets.length)).join('') || '<div class="pp-muted">还没有预设，点下面「新建预设」加一条</div>'}
    <div class="pp-btn-row">
        <span id="pp_gd_preset_new" class="menu_button"><i class="fa-solid fa-plus"></i> 新建预设</span>
        <span id="pp_gd_preset_builtin" class="menu_button" title="展开查看内置的系统指令和预设拼接的位置">查看内置指令</span>
    </div>
    <div id="pp_gd_preset_view" class="pp-gd-builtin" style="display:none"></div>`;

    const refreshHead = () => {
        el.querySelector('#pp_gd_preset_head .pp-muted').textContent = presetSummary();
    };
    const movePreset = (id, delta) => {
        const list = settings.guidance.presets;
        const i = list.findIndex(x => x.id === id);
        const j = i + delta;
        if (i < 0 || j < 0 || j >= list.length) return;
        [list[i], list[j]] = [list[j], list[i]];
        save();
        renderPreset(container);
    };

    el.querySelector('#pp_gd_preset_toggle').addEventListener('click', () => {
        presetOpen = false;
        editingPreset = null;
        renderPreset(container);
    });
    el.querySelector('#pp_gd_preset_new').addEventListener('click', () => {
        const list = settings.guidance.presets;
        const p = { id: newId('gd-'), name: `预设 ${list.length + 1}`, content: '', enabled: true };
        list.push(p);
        editingPreset = p.id;
        save();
        renderPreset(container);
        el.querySelector(`[data-pcontent="${p.id}"]`)?.focus();
    });
    el.querySelectorAll('[data-pena]').forEach(cb => cb.addEventListener('change', () => {
        const p = findPreset(cb.dataset.pena);
        if (p) { p.enabled = cb.checked; save(); refreshHead(); }
    }));
    el.querySelectorAll('[data-pedit]').forEach(btn => btn.addEventListener('click', () => {
        editingPreset = editingPreset === btn.dataset.pedit ? null : btn.dataset.pedit;
        renderPreset(container);
    }));
    el.querySelectorAll('[data-pdel]').forEach(btn => btn.addEventListener('click', () => {
        const list = settings.guidance.presets;
        const idx = list.findIndex(x => x.id === btn.dataset.pdel);
        if (idx >= 0) {
            const [removed] = list.splice(idx, 1);
            save();
            toastr.success(`已删除预设「${removed.name}」`);
        }
        if (editingPreset === btn.dataset.pdel) editingPreset = null;
        renderPreset(container);
    }));
    el.querySelectorAll('[data-pup]').forEach(btn => btn.addEventListener('click', () => movePreset(btn.dataset.pup, -1)));
    el.querySelectorAll('[data-pdown]').forEach(btn => btn.addEventListener('click', () => movePreset(btn.dataset.pdown, 1)));
    // 名字/内容编辑即时保存，只更新行内文字，不整块重渲染（避免打断输入）
    el.querySelectorAll('[data-pname]').forEach(inp => inp.addEventListener('input', () => {
        const p = findPreset(inp.dataset.pname);
        if (!p) return;
        p.name = inp.value;
        save();
        const row = el.querySelector(`[data-preset-item="${p.id}"]`);
        row.querySelector('.pp-gd-pname').textContent = p.name || '（未命名）';
    }));
    el.querySelectorAll('[data-pcontent]').forEach(ta => ta.addEventListener('input', () => {
        const p = findPreset(ta.dataset.pcontent);
        if (!p) return;
        p.content = ta.value;
        save();
        el.querySelector(`[data-preset-item="${p.id}"] .pp-gd-plen`).textContent = `${ta.value.trim().length} 字`;
    }));
    el.querySelector('#pp_gd_preset_builtin').addEventListener('click', () => {
        const view = el.querySelector('#pp_gd_preset_view');
        const show = view.style.display === 'none';
        view.style.display = show ? '' : 'none';
        if (show) {
            view.textContent = `${GUIDANCE_SYSTEM_PROMPT}\n\n## 用户固定要求（在不改变上述 JSON 输出格式的前提下遵照执行）\n（勾选启用的预设按顺序追加在这里，每条带「### 预设名」小标题，随每次分析一起发给模型）`;
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
