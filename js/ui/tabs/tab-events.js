// 随机事件页签：规则列表 + 掷骰 + 事件卡与选项走向 → 转隐身注入
import { settings, save, newId } from "../../settings.js";
import { defaultEventRules, rollEventRule, generateRandomEvent } from "../../randomEvents.js";
import { addInjection } from "../../injection.js";
import { escapeHtml } from "../../utils.js";

const state = { event: null, ruleName: '' };

export const eventsTab = {
    id: 'events',
    title: '随机事件',
    render(container) {
        if (!settings.eventRules.length) {
            settings.eventRules = defaultEventRules();
            save();
        }
        container.innerHTML = `
        <div class="pp-section">
            <b>事件规则</b>
            <div class="pp-muted">触发概率 / 权重 / 冷却。冷却的自动判定在 Phase 3 接入，当前为手动掷骰。</div>
            <div id="pp_ev_rules"></div>
            <div class="pp-btn-row">
                <div id="pp_ev_roll" class="menu_button">掷骰生成事件</div>
            </div>
            <div id="pp_ev_status" class="pp-muted"></div>
        </div>
        <div id="pp_ev_output"></div>`;

        renderRules(container);
        container.querySelector('#pp_ev_roll').addEventListener('click', () => roll(container));
        if (state.event) renderEvent(container);
    },
};

function renderRules(container) {
    const list = container.querySelector('#pp_ev_rules');
    list.innerHTML = settings.eventRules.map(r => `
        <div class="pp-item">
            <div class="pp-item-main">
                <span class="pp-item-title">${escapeHtml(r.name)}</span>
                <span class="pp-muted">概率 ${Math.round((r.probability ?? 0) * 100)}% · 权重 ${r.weight ?? 1} · 冷却 ${r.cooldownLayers ?? 0} 层</span>
            </div>
            <div class="pp-item-ops">
                <label><input type="checkbox" data-ev-en="${r.id}" ${r.enabled ? 'checked' : ''} /> 启用</label>
            </div>
        </div>`).join('');

    list.querySelectorAll('[data-ev-en]').forEach(el => el.addEventListener('change', () => {
        const rule = settings.eventRules.find(r => r.id === el.dataset.evEn);
        if (!rule) return;
        rule.enabled = el.checked;
        save();
    }));
}

async function roll(container) {
    const status = container.querySelector('#pp_ev_status');
    const rule = rollEventRule(settings.eventRules);
    if (!rule) {
        status.textContent = '本次未触发任何事件（概率未中），可再次掷骰';
        state.event = null;
        container.querySelector('#pp_ev_output').innerHTML = '';
        return;
    }
    status.textContent = `触发「${rule.name}」，生成中……`;
    try {
        state.event = await generateRandomEvent(rule);
        state.ruleName = rule.name;
        renderEvent(container);
        status.textContent = `来自规则「${rule.name}」`;
    } catch (err) {
        status.textContent = '';
        toastr.error(String(err.message ?? err));
    }
}

function renderEvent(container) {
    const ev = state.event;
    const options = Array.isArray(ev.options) ? ev.options : [];

    container.querySelector('#pp_ev_output').innerHTML = `
        <div class="pp-section">
            <b>${escapeHtml(ev.title ?? '随机事件')}</b>
            <div>${escapeHtml(ev.description ?? '')}</div>
            ${options.map((o, i) => `<div class="menu_button pp-option" data-opt="${i}">${escapeHtml(o.label ?? '')}</div>`).join('')}
            <div class="pp-muted">选择一个走向后将转为隐身注入（明盘，20 层后自动过期）</div>
        </div>`;

    container.querySelectorAll('[data-opt]').forEach(el => el.addEventListener('click', () => {
        const opt = options[Number(el.dataset.opt)] ?? {};
        const content = `【随机事件·${ev.title ?? ''}】${ev.description ?? ''}\n已选定走向：${opt.label ?? ''}\n幕后提示：${opt.hint ?? ''}`;
        addInjection({
            id: newId('inj-'),
            label: `事件：${ev.title ?? ''} · ${opt.label ?? ''}`,
            mode: 'open',
            content,
            depth: 4,
            role: 'system',
            scope: 'chat',
            enabled: true,
            source: 'event',
            createdAt: Date.now(),
            expires: { type: 'layers', layers: 20 },
        });
        toastr.success('已注入');
        document.dispatchEvent(new CustomEvent('pp-switch-tab', { detail: { id: 'injections' } }));
    }));
}
