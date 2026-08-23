// 隐身注入页签：明盘/密封双模式注入的创建与管理（开发方案 §M4）
import { settings, newId } from "../../settings.js";
import { addInjection, updateInjection, removeInjection, replayScopedInjections } from "../../injection.js";
import { generateSealedContent } from "../../planner.js";
import { escapeHtml, clamp, fingerprint } from "../../utils.js";

export const injectionsTab = {
    id: 'injections',
    title: '隐身注入',
    render(container) {
        container.innerHTML = `
        <div class="pp-section">
            <b>新建明盘注入（内容你可见，聊天界面不显示）</b>
            <input id="pp_in_label" class="text_pole textarea_compact" placeholder="标签，如：酒馆对峙·幕后剧本" />
            <textarea id="pp_in_content" class="text_pole textarea_compact" rows="4" placeholder="注入内容"></textarea>
            <div class="pp-grid2">
                <div>
                    <label class="pp-label">深度</label>
                    <input id="pp_in_depth" class="text_pole textarea_compact" type="number" min="0" max="16" value="4" />
                </div>
                <div>
                    <label class="pp-label">范围</label>
                    <select id="pp_in_scope" class="text_pole textarea_compact">
                        <option value="chat">仅当前聊天</option>
                        <option value="global">全局</option>
                    </select>
                </div>
            </div>
            <div class="pp-grid2">
                <div>
                    <label class="pp-label">有效期</label>
                    <select id="pp_in_expire" class="text_pole textarea_compact">
                        <option value="never">永久</option>
                        <option value="layers">N 层后自动撤下</option>
                    </select>
                </div>
                <div>
                    <label class="pp-label">层数（有效期选层数时生效）</label>
                    <input id="pp_in_layers" class="text_pole textarea_compact" type="number" min="1" value="20" />
                </div>
            </div>
            <div class="pp-btn-row">
                <div id="pp_in_add" class="menu_button">保存并注入</div>
            </div>
        </div>
        <div class="pp-section">
            <b>新建密封注入（AI 生成，你自己也不显示内容，如对手手牌）</b>
            <textarea id="pp_seal_instr" class="text_pole textarea_compact" rows="3" placeholder="生成指令，如：为对面的扑克对手生成一手具体的牌与打法倾向"></textarea>
            <div class="pp-btn-row">
                <div id="pp_seal_gen" class="menu_button">生成并密封注入</div>
            </div>
            <div id="pp_seal_status" class="pp-muted"></div>
        </div>
        <div class="pp-section">
            <div class="pp-btn-row">
                <b>注入列表</b>
                <div id="pp_in_replay" class="menu_button" style="margin-left:auto">全部重放</div>
            </div>
            <div id="pp_in_list"></div>
        </div>`;

        container.querySelector('#pp_in_add').addEventListener('click', () => {
            const content = container.querySelector('#pp_in_content').value.trim();
            if (!content) {
                toastr.warning('注入内容为空');
                return;
            }
            const expireType = container.querySelector('#pp_in_expire').value;
            addInjection({
                id: newId('inj-'),
                label: container.querySelector('#pp_in_label').value.trim() || `手动注入 ${new Date().toLocaleTimeString()}`,
                mode: 'open',
                content,
                depth: Number(container.querySelector('#pp_in_depth').value) || 4,
                role: 'system',
                scope: container.querySelector('#pp_in_scope').value,
                enabled: true,
                source: 'manual',
                createdAt: Date.now(),
                expires: expireType === 'layers'
                    ? { type: 'layers', layers: Math.max(1, Number(container.querySelector('#pp_in_layers').value) || 20) }
                    : { type: 'never' },
            });
            toastr.success('已注入（明盘）');
            renderList(container);
        });

        container.querySelector('#pp_seal_gen').addEventListener('click', async () => {
            const instr = container.querySelector('#pp_seal_instr').value.trim();
            const status = container.querySelector('#pp_seal_status');
            if (!instr) {
                toastr.warning('请先填写生成指令');
                return;
            }
            status.textContent = '生成中……内容将不会展示给你';
            try {
                const content = await generateSealedContent(instr);
                addInjection({
                    id: newId('inj-'),
                    label: `密封 ${new Date().toLocaleTimeString()}`,
                    mode: 'sealed',
                    content,
                    depth: 4,
                    role: 'system',
                    scope: 'chat',
                    enabled: true,
                    source: 'manual',
                    createdAt: Date.now(),
                    expires: { type: 'never' },
                });
                status.textContent = `已密封注入（${fingerprint(content)}）`;
                renderList(container);
            } catch (err) {
                status.textContent = '';
                toastr.error(String(err.message ?? err));
            }
        });

        container.querySelector('#pp_in_replay').addEventListener('click', () => {
            replayScopedInjections();
            toastr.info('已按当前聊天重放全部启用的注入');
        });

        renderList(container);
    },
};

function sourceName(item) {
    if (item.source === 'reaction') return `路人反应（显著性 ${item.reaction?.salience ?? '?'}/5，逐层衰减）`;
    const names = { manual: '手动', event: '随机事件', planner: '剧情规划', story: '剧情绑定' };
    return names[item.source] ?? item.source ?? '手动';
}

function renderList(container) {
    const list = container.querySelector('#pp_in_list');
    if (!settings.injections.length) {
        list.innerHTML = '<div class="pp-muted">暂无注入</div>';
        return;
    }
    list.innerHTML = settings.injections.slice().reverse().map(i => `
        <div class="pp-item">
            <div class="pp-item-main">
                <span class="pp-item-title">
                    <span class="pp-badge ${i.mode === 'sealed' ? 'pp-badge-sealed' : 'pp-badge-open'}">${i.mode === 'sealed' ? '密封' : '明盘'}</span>
                    ${escapeHtml(i.label)}
                </span>
                <span class="pp-muted">
                    深度 ${i.depth ?? 4} · ${i.scope === 'global' ? '全局' : '本聊天'} · 来源 ${sourceName(i)}
                    ${i.expires?.type === 'layers' ? ` · ${i.age ?? 0}/${i.expires.layers} 层` : ''}
                    ${i.mode === 'sealed' ? ` · ${fingerprint(i.content)}` : ''}
                </span>
                ${i.mode !== 'sealed' ? `<span class="pp-muted">${escapeHtml(clamp(i.content, 100))}</span>` : ''}
            </div>
            <div class="pp-item-ops">
                <label><input type="checkbox" data-inj-en="${i.id}" ${i.enabled ? 'checked' : ''} /> 启用</label>
                <span class="menu_button fa-solid fa-trash" data-inj-del="${i.id}" title="删除"></span>
            </div>
        </div>`).join('');

    list.querySelectorAll('[data-inj-en]').forEach(el => el.addEventListener('change', () => {
        const item = settings.injections.find(x => x.id === el.dataset.injEn);
        if (!item) return;
        item.enabled = el.checked;
        updateInjection(item);
        renderList(container);
    }));
    list.querySelectorAll('[data-inj-del]').forEach(el => el.addEventListener('click', () => {
        removeInjection(el.dataset.injDel);
        renderList(container);
    }));
}
