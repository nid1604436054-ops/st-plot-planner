// 储存空间页签：一次性内容（游戏规则等）的条目库 + 触发注入 + 导入导出
import { settings, newId } from "../../settings.js";
import { addItem, removeItem, scanAndApplyStorage } from "../../store.js";
import { escapeHtml, clamp, downloadJson, readFileAsText } from "../../utils.js";

export const storageTab = {
    id: 'storage',
    title: '储存空间',
    render(container) {
        container.innerHTML = `
        <div class="pp-section">
            <b>一次性内容库（游戏规则等，按触发词注入，不必写成世界书）</b>
            <div class="pp-grid2">
                <div>
                    <label class="pp-label">名称</label>
                    <input id="pp_st_name" class="text_pole textarea_compact" />
                </div>
                <div>
                    <label class="pp-label">触发词（逗号分隔，留空则需勾常驻）</label>
                    <input id="pp_st_keys" class="text_pole textarea_compact" placeholder="扑克,德扑,牌局" />
                </div>
            </div>
            <div class="pp-grid2">
                <div>
                    <label class="pp-label">注入深度</label>
                    <input id="pp_st_depth" class="text_pole textarea_compact" type="number" min="0" max="16" value="6" />
                </div>
                <div style="align-self:end">
                    <label><input type="checkbox" id="pp_st_const" /> 常驻（无条件注入）</label>
                </div>
            </div>
            <textarea id="pp_st_content" class="text_pole textarea_compact" rows="5" placeholder="内容，如扑克规则、地下城地图……"></textarea>
            <div class="pp-btn-row">
                <div id="pp_st_add" class="menu_button">添加</div>
                <div id="pp_st_replay" class="menu_button">按当前剧情重放</div>
                <div id="pp_st_export" class="menu_button">导出</div>
                <label class="menu_button" for="pp_st_import">导入</label>
                <input id="pp_st_import" type="file" accept=".json,application/json" hidden />
            </div>
        </div>
        <div class="pp-section">
            <b>条目列表</b>
            <div id="pp_st_list"></div>
        </div>`;

        container.querySelector('#pp_st_add').addEventListener('click', () => {
            const content = container.querySelector('#pp_st_content').value.trim();
            const name = container.querySelector('#pp_st_name').value.trim();
            if (!content || !name) {
                toastr.warning('请填写名称与内容');
                return;
            }
            addItem({
                id: newId('si-'),
                name,
                keys: container.querySelector('#pp_st_keys').value.split(/[,，]/).map(s => s.trim()).filter(Boolean),
                constant: container.querySelector('#pp_st_const').checked,
                depth: Number(container.querySelector('#pp_st_depth').value) || 6,
                content,
                enabled: true,
            });
            toastr.success('已添加并按当前剧情注入');
            renderList(container);
        });

        container.querySelector('#pp_st_replay').addEventListener('click', () => {
            scanAndApplyStorage();
            toastr.info('已按当前剧情重放储存条目');
        });

        container.querySelector('#pp_st_export').addEventListener('click', () => {
            downloadJson('plot-planner-storage.json', settings.storageItems);
        });

        container.querySelector('#pp_st_import').addEventListener('change', async e => {
            const file = e.target.files?.[0];
            if (!file) return;
            try {
                const data = JSON.parse(await readFileAsText(file));
                const items = Array.isArray(data) ? data : [];
                if (!items.length) throw new Error('文件中没有条目');
                let added = 0;
                for (const raw of items) {
                    if (!raw?.content || !raw?.id) continue;
                    if (settings.storageItems.some(i => i.id === raw.id)) continue;
                    settings.storageItems.push({
                        id: raw.id, name: raw.name ?? '未命名',
                        keys: Array.isArray(raw.keys) ? raw.keys.map(String) : [],
                        constant: Boolean(raw.constant),
                        depth: Number(raw.depth) || 6,
                        content: String(raw.content),
                        enabled: raw.enabled !== false,
                    });
                    added++;
                }
                scanAndApplyStorage();
                save();
                toastr.success(`导入 ${added} 条`);
                renderList(container);
            } catch (err) {
                toastr.error(`导入失败：${err.message}`);
            }
            e.target.value = '';
        });

        renderList(container);
    },
};

function renderList(container) {
    const list = container.querySelector('#pp_st_list');
    if (!settings.storageItems.length) {
        list.innerHTML = '<div class="pp-muted">暂无条目</div>';
        return;
    }
    list.innerHTML = settings.storageItems.map(i => `
        <div class="pp-item">
            <div class="pp-item-main">
                <span class="pp-item-title">${escapeHtml(i.name)}</span>
                <span class="pp-muted">
                    ${i.constant ? '常驻' : `触发词：${escapeHtml((i.keys ?? []).join('、') || '无')}`}
                    · 深度 ${i.depth ?? 6}
                </span>
                <span class="pp-muted">${escapeHtml(clamp(i.content, 80))}</span>
            </div>
            <div class="pp-item-ops">
                <label><input type="checkbox" data-st-en="${i.id}" ${i.enabled ? 'checked' : ''} /> 启用</label>
                <span class="menu_button fa-solid fa-trash" data-st-del="${i.id}" title="删除"></span>
            </div>
        </div>`).join('');

    list.querySelectorAll('[data-st-en]').forEach(el => el.addEventListener('change', () => {
        const item = settings.storageItems.find(x => x.id === el.dataset.stEn);
        if (!item) return;
        item.enabled = el.checked;
        save();
        scanAndApplyStorage();
    }));
    list.querySelectorAll('[data-st-del]').forEach(el => el.addEventListener('click', () => {
        removeItem(el.dataset.stDel);
        renderList(container);
    }));
}
