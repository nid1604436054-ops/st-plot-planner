// 游戏玩法工具区（原「储存空间」页签并入并改名）：游戏规则等一次性内容的条目库
// + 按触发词/常驻注入主对话 + 导入导出。折叠区追加挂载进剧情指导页底部的折叠区容器
// （与「事件库设置」「AI 建库」同容器，三个根折叠区边距统一合并、间距一致）。
// 条目本身仍随消息事件自动扫描注入（store.js）；生效中的条目在分步向导第 1 步默认勾选、
// 作为「游戏玩法」材料随规划分析一起发给模型，检查报告（runStoryReview）也自动附带。
import { settings, save, newId } from "../../settings.js";
import { addItem, removeItem, scanAndApplyStorage } from "../../store.js";
import { escapeHtml, clamp, downloadJson, readFileAsText } from "../../utils.js";

let stFold = false;   // 折叠区展开状态（跨重渲染保留）

// 渲染游戏玩法折叠区（添加表单 + 条目列表 + 导入导出），追加到剧情指导页底部的折叠区容器
export function renderStorageTools(container) {
    if (!container) return;
    const fold = document.createElement('details');
    fold.className = 'pp-fold pp-fold-root';
    fold.dataset.fold = 'storage';
    if (stFold) fold.open = true;
    fold.innerHTML = `
        <summary><i class="fa-solid fa-gamepad"></i> 游戏玩法（条目库 · 按触发注入主对话）</summary>
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
        <label class="pp-label">条目列表</label>
        <div id="pp_st_list"></div>`;
    container.appendChild(fold);

    fold.addEventListener('toggle', () => { stFold = fold.open; });

    fold.querySelector('#pp_st_add').addEventListener('click', () => {
        const content = fold.querySelector('#pp_st_content').value.trim();
        const name = fold.querySelector('#pp_st_name').value.trim();
        if (!content || !name) {
            toastr.warning('请填写名称与内容');
            return;
        }
        // 深度 0 是合法值（紧贴上下文末尾，同 injection 语义），不能被 || 6 吞掉；留空才回退默认
        const depthRaw = fold.querySelector('#pp_st_depth').value.trim();
        const depth = depthRaw !== '' && Number.isFinite(Number(depthRaw))
            ? Math.min(Math.max(Math.round(Number(depthRaw)), 0), 16) : 6;
        addItem({
            id: newId('si-'),
            name,
            keys: fold.querySelector('#pp_st_keys').value.split(/[,，]/).map(s => s.trim()).filter(Boolean),
            constant: fold.querySelector('#pp_st_const').checked,
            depth,
            content,
            enabled: true,
        });
        toastr.success('已添加并按当前剧情注入');
        renderList(fold);
    });

    fold.querySelector('#pp_st_replay').addEventListener('click', () => {
        scanAndApplyStorage();
        toastr.info('已按当前剧情重放玩法条目');
    });

    fold.querySelector('#pp_st_export').addEventListener('click', () => {
        downloadJson('plot-planner-storage.json', settings.storageItems);
    });

    fold.querySelector('#pp_st_import').addEventListener('change', async e => {
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
            renderList(fold);
        } catch (err) {
            toastr.error(`导入失败：${err.message}`);
        }
        e.target.value = '';
    });

    renderList(fold);
}

function renderList(root) {
    const list = root.querySelector('#pp_st_list');
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
        renderList(root);
    }));
}
