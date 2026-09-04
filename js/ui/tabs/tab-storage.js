// 游戏玩法工具区（原「储存空间」页签并入并改名）：游戏规则等一次性内容的条目库
// + 按触发词/常驻注入主对话 + AI 咨询（一句思路→完整玩法规则，本区生成与入库，
// 不进向导第 1 步运行区）+ 导入导出。折叠区追加挂载进剧情指导页底部的折叠区容器
// （与「事件库设置」「AI 建库」同容器，三个根折叠区边距统一合并、间距一致）。
// 根折叠区内部分三个子折叠区（第六十一轮，用户点名三功能分开别挤）：手动添加 /
// AI 玩法创作 / 已有玩法（条目列表＋扫描窗口＋重扫导入导出），各开各收、状态各自记忆。
// 条目本身仍随消息事件自动扫描注入（store.js）；生效中的条目在分步向导第 1 步默认勾选、
// 作为「游戏玩法」材料随规划分析一起发给模型，检查报告（runStoryReview）也自动附带。
import { settings, save, newId } from "../../settings.js";
import { addItem, removeItem, scanAndApplyStorage, storageItemsInEffect } from "../../store.js";
import { activeStory } from "../../story.js";
import { generateGameplayDraft } from "../../gameplayConsult.js";
import { currentLorePicks } from "../../materials.js";
import { escapeHtml, clamp, downloadJson, readFileAsText } from "../../utils.js";

let stFold = false;   // 根折叠区展开状态（跨重渲染保留）
const stParts = { add: false, consult: false, list: true };   // 三个子折叠区各自记忆（默认只开「已有玩法」）
const stOpenRows = new Set();   // 展开详情的条目行 id（第六十二轮：条目行收起只留标题，点行展开）
let consultBusy = false;   // 玩法咨询生成在途标志（瞬时态，不落存储）

// 渲染游戏玩法折叠区（添加表单 + 条目列表 + 导入导出），追加到剧情指导页底部的折叠区容器
export function renderStorageTools(container) {
    if (!container) return;
    const fold = document.createElement('details');
    fold.className = 'pp-fold pp-fold-root';
    fold.dataset.fold = 'storage';
    if (stFold) fold.open = true;
    fold.innerHTML = `
        <summary title="条目库 · 按触发注入主对话"><i class="fa-solid fa-gamepad"></i> 游戏玩法</summary>
        <details class="pp-fold" data-stfold="add" ${stParts.add ? 'open' : ''}>
            <summary title="自己写规则存进条目库：触发词命中或勾常驻时自动注入主对话，生效中的条目在向导第 1 步默认勾选">手动添加</summary>
            <div class="pp-grid2">
                <div>
                    <label class="pp-label">名称</label>
                    <input id="pp_st_name" class="text_pole textarea_compact" />
                </div>
                <div>
                    <label class="pp-label" title="多个词用逗号分隔。留空时自动勾上常驻；有触发词时常驻可自行勾选或取消">触发词（逗号分隔）</label>
                    <input id="pp_st_keys" class="text_pole textarea_compact" />
                </div>
            </div>
            <div class="pp-grid2">
                <div>
                    <label class="pp-label">注入深度</label>
                    <input id="pp_st_depth" class="text_pole textarea_compact" type="number" min="0" max="16" value="6" />
                </div>
                <div style="align-self:end">
                    <label title="无条件注入"><input type="checkbox" id="pp_st_const" /> 常驻</label>
                </div>
            </div>
            <textarea id="pp_st_content" class="text_pole textarea_compact" rows="5"></textarea>
            <div class="pp-btn-row">
                <div id="pp_st_add" class="menu_button">添加</div>
            </div>
        </details>
        <details class="pp-fold" data-stfold="consult" ${stParts.consult ? 'open' : ''}>
            <summary title="填一句大概思路，花一次模型调用扩写成完整可执行的玩法规则，草案可改，入库后出现在「已有玩法」里。材料固定带角色摘要、最近对话与世界书自选（第四十三轮起只带「剧情指导」页第 1 步「世界书自选」面板里勾的条目〔含常驻〕，不再自动检索命中），下面两个勾选按需追加——记忆表格那类既往事件流水对玩法设计没用，一律不带；思路与草案随全局设置留底，刷新不丢">AI 玩法创作</summary>
            <textarea id="pp_st_c_idea" class="text_pole textarea_compact" rows="2"></textarea>
            <div class="pp-gd-selp">
                <label title="带上进行中剧情全文：生成的玩法贴合当前剧情阶段、不与其走向冲突"><input type="checkbox" id="pp_st_c_plan" /> 附进行中剧情</label>
                <label title="带当前注入生效中的玩法条目：新玩法与现有规则不冲突、能衔接"><input type="checkbox" id="pp_st_c_gp" /> 附生效中的玩法</label>
            </div>
            <div class="pp-muted" id="pp_st_c_loren" title="第四十三轮起 AI 玩法创作不再自动带检索命中——世界书材料只跟「剧情指导」页第 1 步「世界书自选」面板的勾选走（含常驻）；一条没勾＝本次不带世界书材料，模型不会报错但看不到这些设定"></div>
            <div class="pp-btn-row"><span id="pp_st_c_gen" class="menu_button">生成玩法草案</span></div>
            <div id="pp_st_c_card"></div>
        </details>
        <details class="pp-fold" data-stfold="list" ${stParts.list ? 'open' : ''}>
            <summary title="条目库总览：启用 / 就地编辑 / 删除；触发词扫描窗口、立即重扫与导入导出同在本区">已有玩法（<span id="pp_st_cnt">${settings.storageItems.length}</span> 条）</summary>
            <label class="pp-label" title="玩法条目的触发词要在最近几层对话里出现过才算命中（常驻条目不受影响）；0 = 不限（扫全部对话）。改动立即保存并按新窗口重扫一次">触发词扫描楼层（0 = 不限）</label>
            <input id="pp_st_scan" class="text_pole textarea_compact" type="number" min="0" max="200" step="1" />
            <div class="pp-btn-row">
                <div id="pp_st_replay" class="menu_button" title="立刻按最近对话重查各条目的触发词：命中的注入、未命中的撤下。平时切对话/收到新消息会自动做；自己编辑或删除消息后用它手动对齐">立即重扫注入</div>
                <div id="pp_st_export" class="menu_button">导出</div>
                <label class="menu_button" for="pp_st_import">导入</label>
                <input id="pp_st_import" type="file" accept=".json,application/json" hidden />
            </div>
            <div id="pp_st_list"></div>
        </details>`;
    container.appendChild(fold);

    fold.addEventListener('toggle', () => { stFold = fold.open; });
    // 三个子折叠区各自记忆展开状态（toggle 事件不冒泡，逐个绑——同事件库设置区的做法）
    fold.querySelectorAll('details[data-stfold]').forEach(el =>
        el.addEventListener('toggle', () => { stParts[el.dataset.stfold] = el.open; }));

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

    // 触发词留空 → 自动勾上常驻（空触发词 + 非常驻的条目永远不生效）；
    // 有触发词时不强动，常驻勾不勾由用户自己定
    const keysEl = fold.querySelector('#pp_st_keys');
    const constEl = fold.querySelector('#pp_st_const');
    const syncConstByKeys = () => { if (!keysEl.value.trim()) constEl.checked = true; };
    keysEl.addEventListener('input', syncConstByKeys);
    syncConstByKeys();

    fold.querySelector('#pp_st_replay').addEventListener('click', () => {
        scanAndApplyStorage();
        toastr.info('已重扫触发词：命中的注入、未命中的撤下');
    });

    // 触发词扫描楼层：全局窗口（对全部条目生效），改动即保存并立刻按新窗口重扫
    const scanEl = fold.querySelector('#pp_st_scan');
    scanEl.value = settings.storageScanLayers;
    scanEl.addEventListener('change', () => {
        const n = Number(scanEl.value);
        settings.storageScanLayers = Number.isFinite(n) ? Math.min(Math.max(Math.floor(n), 0), 200) : 20;
        scanEl.value = settings.storageScanLayers;
        save();
        scanAndApplyStorage();
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
                    // 深度 0 是合法值（同添加表单），不能被 || 6 吞掉；缺失/非法才回退默认
                    depth: raw.depth !== undefined && Number.isFinite(Number(raw.depth))
                        ? Math.min(Math.max(Math.round(Number(raw.depth)), 0), 16) : 6,
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

    // AI 咨询：思路 → 完整玩法草案 → 入库。状态存 settings.storageConsult（随全局设置留底，
    // save 是防抖的，逐字改动不会刷盘风暴）；入库走 addItem，与手动添加的条目同一套注入生命周期
    const consult = settings.storageConsult;
    // 防呆行（第四十三轮）：自动检索撤出后，「不勾就没有」要看得见——就地报当前自选条数
    const loreNRow = fold.querySelector('#pp_st_c_loren');
    if (loreNRow) {
        const n = currentLorePicks().length;
        loreNRow.textContent = `本次世界书材料：${n ? `自选 ${n} 条` : '未勾选、本次不带世界书材料'}`;
    }
    const cIdeaEl = fold.querySelector('#pp_st_c_idea');
    cIdeaEl.value = consult.idea;
    cIdeaEl.addEventListener('input', () => { consult.idea = cIdeaEl.value; save(); });
    const cPlanEl = fold.querySelector('#pp_st_c_plan');
    const cGpEl = fold.querySelector('#pp_st_c_gp');
    cPlanEl.checked = consult.usePlan;
    cGpEl.checked = consult.useGp;
    cPlanEl.addEventListener('change', () => { consult.usePlan = cPlanEl.checked; save(); });
    cGpEl.addEventListener('change', () => { consult.useGp = cGpEl.checked; save(); });

    const renderConsultDraft = () => {
        const box = fold.querySelector('#pp_st_c_card');
        if (!box) return;   // 生成回调落地时页面已重渲染：草案在 settings 里，重开后照常出
        const d = consult.draft;
        if (!d) { box.innerHTML = ''; return; }
        box.innerHTML = `
        <div class="pp-item pp-gd-evcard">
            <b>玩法草案（可改后入库）</b>
            <label class="pp-label" title="入库存的就是这份名称与正文：与下方条目列表同一格式，向导第 1 步可勾选随分析发送">名称</label>
            <input id="pp_st_c_name" class="text_pole textarea_compact" value="${escapeHtml(d.name)}" />
            <label class="pp-label">规则正文（可改）</label>
            <textarea id="pp_st_c_text" class="text_pole textarea_compact" rows="10">${escapeHtml(d.text)}</textarea>
            <label title="勾上＝入库为常驻条目，无条件注入主对话（玩法要在剧情里实际执行就该勾）；不勾＝不注入主对话，只在向导第 1 步作为可勾选的规划材料"><input type="checkbox" id="pp_st_c_inject" ${d.inject !== false ? 'checked' : ''}/> 常驻注入主对话（不勾＝只作规划材料）</label>
            <div class="pp-btn-row">
                <span id="pp_st_c_save" class="menu_button" title="加入下方条目列表（本区可再启用/删除），常驻项立即注入主对话">存为玩法条目</span>
                <span id="pp_st_c_drop" class="menu_button" title="丢弃草案；思路保留，可改完思路重新生成">放弃草案</span>
            </div>
        </div>`;
        const nameEl = box.querySelector('#pp_st_c_name');
        const textEl = box.querySelector('#pp_st_c_text');
        const injectEl = box.querySelector('#pp_st_c_inject');
        nameEl.addEventListener('input', () => { d.name = nameEl.value; save(); });
        textEl.addEventListener('input', () => { d.text = textEl.value; save(); });
        injectEl.addEventListener('change', () => { d.inject = injectEl.checked; save(); });
        box.querySelector('#pp_st_c_save').addEventListener('click', () => {
            const name = d.name.trim();
            const text = d.text.trim();
            if (!name || !text) { toastr.warning('请填写名称与规则正文'); return; }
            const inject = d.inject !== false;
            addItem({ id: newId('si-'), name, keys: [], constant: inject, depth: 6, content: text, enabled: true });
            consult.draft = null;
            save();
            renderConsultDraft();
            renderList(fold);
            toastr.success(`已入库「${name}」${inject ? '，常驻注入主对话' : '（不注入主对话，向导第 1 步可勾选作规划材料）'}`);
        });
        box.querySelector('#pp_st_c_drop').addEventListener('click', () => {
            consult.draft = null;
            save();
            renderConsultDraft();
        });
    };
    renderConsultDraft();

    fold.querySelector('#pp_st_c_gen').addEventListener('click', async () => {
        const idea = consult.idea.trim();
        if (!idea) { toastr.warning('先填一句大概思路'); return; }
        if (consultBusy) return;
        consultBusy = true;
        const btn = fold.querySelector('#pp_st_c_gen');
        btn.textContent = '生成中……';
        try {
            const text = await generateGameplayDraft({
                idea,
                activePlan: consult.usePlan ? activeStory()?.planText ?? '' : '',
                storageItems: consult.useGp ? storageItemsInEffect() : [],
            });
            if (!text) throw new Error('模型没有返回内容');
            consult.draft = { name: idea.slice(0, 20), text, inject: true };
            save();
            renderConsultDraft();
        } catch (err) {
            toastr.error(String(err.message ?? err));
        } finally {
            consultBusy = false;
            btn.textContent = '生成玩法草案';
        }
    });

    renderList(fold);
}

function renderList(root) {
    const list = root.querySelector('#pp_st_list');
    // 「已有玩法（N 条）」标题计数同步（增删导入后跟着变，不用重渲染整个折叠区）
    const cnt = root.querySelector('#pp_st_cnt');
    if (cnt) cnt.textContent = String(settings.storageItems.length);
    if (!settings.storageItems.length) {
        list.innerHTML = '<div class="pp-muted">暂无条目</div>';
        return;
    }
    list.innerHTML = settings.storageItems.map(i => {
        const open = stOpenRows.has(i.id);   // 收起＝只留标题一行（同知识库清单行的做法）
        return `
        <div class="pp-item pp-st-erow" data-strow="${i.id}" title="点这一行展开/收起详情">
            <span class="menu_button pp-kb-chev fa-solid ${open ? 'fa-chevron-down' : 'fa-chevron-right'}" title="展开/收起详情"></span>
            <span class="pp-item-title" title="${escapeHtml(i.name)}">${escapeHtml(i.name)}</span>
        </div>
        ${open ? `
        <div class="pp-st-edet">
            <div class="pp-item-main">
                <span class="pp-muted">
                    ${i.constant ? '常驻' : `触发词：${escapeHtml((i.keys ?? []).join('、') || '无')}`}
                    · 深度 ${i.depth ?? 6}
                </span>
                <span class="pp-muted">${escapeHtml(clamp(i.content, 80))}</span>
            </div>
            <div class="pp-item-ops">
                <label><input type="checkbox" data-st-en="${i.id}" ${i.enabled ? 'checked' : ''} /> 启用</label>
                <span class="menu_button fa-solid fa-pen" data-st-edit="${i.id}" title="编辑这个条目：名称/触发词/注入深度/常驻/正文都可改，保存后立即按新参数重扫注入"></span>
                <span class="menu_button fa-solid fa-trash" data-st-del="${i.id}" title="删除"></span>
            </div>
            <div class="pp-item-editbox" data-st-editbox="${i.id}" hidden>
                <div class="pp-grid2">
                    <div>
                        <label class="pp-label">名称</label>
                        <input class="text_pole textarea_compact" data-st-name value="${escapeHtml(i.name)}" />
                    </div>
                    <div>
                        <label class="pp-label" title="多个词用逗号分隔。留空时自动勾上常驻；有触发词时常驻可自行勾选或取消">触发词（逗号分隔）</label>
                        <input class="text_pole textarea_compact" data-st-keys value="${escapeHtml((i.keys ?? []).join(','))}" />
                    </div>
                </div>
                <div class="pp-grid2">
                    <div>
                        <label class="pp-label">注入深度</label>
                        <input class="text_pole textarea_compact" data-st-depth type="number" min="0" max="16" value="${i.depth ?? 6}" />
                    </div>
                    <div style="align-self:end">
                        <label title="无条件注入"><input type="checkbox" data-st-const ${i.constant ? 'checked' : ''} /> 常驻</label>
                    </div>
                </div>
                <textarea class="text_pole textarea_compact" rows="5" data-st-content>${escapeHtml(i.content)}</textarea>
                <div class="pp-btn-row">
                    <span class="menu_button" data-st-save title="保存修改并按新参数重扫注入">保存</span>
                    <span class="menu_button" data-st-cancel title="放弃未保存的改动，收起编辑框">取消</span>
                </div>
            </div>
        </div>` : ''}`;
    }).join('');

    // 条目行点行展开/收起（第六十二轮）：收起＝只留标题。编辑框开着且有未保存改动时先拦一道
    //（当场比对框里值与存量，不做脏标记跟踪——同长线 R23 防手滑丢字口径）
    list.querySelectorAll('[data-strow]').forEach(el => el.addEventListener('click', () => {
        const id = el.dataset.strow;
        if (stOpenRows.has(id)) {
            const box = list.querySelector(`[data-st-editbox="${id}"]`);
            if (box && !box.hidden) {
                const item = settings.storageItems.find(x => x.id === id);
                const dirty = item && (
                    box.querySelector('[data-st-name]').value !== item.name
                    || box.querySelector('[data-st-keys]').value !== (item.keys ?? []).join(',')
                    || box.querySelector('[data-st-depth]').value !== String(item.depth ?? 6)
                    || box.querySelector('[data-st-const]').checked !== item.constant
                    || box.querySelector('[data-st-content]').value !== item.content
                );
                if (dirty) { toastr.warning('这条的修改还没保存，先点编辑框里的「保存」或「取消」'); return; }
            }
            stOpenRows.delete(id);
        } else {
            stOpenRows.add(id);
        }
        renderList(root);
    }));

    list.querySelectorAll('[data-st-en]').forEach(el => el.addEventListener('change', () => {
        const item = settings.storageItems.find(x => x.id === el.dataset.stEn);
        if (!item) return;
        item.enabled = el.checked;
        save();
        scanAndApplyStorage();
    }));
    // 编辑框里的触发词同样留空自动勾常驻（与添加表单同一规则：空触发词 + 非常驻 = 死条目）
    list.querySelectorAll('[data-st-editbox]').forEach(box => {
        const keysInput = box.querySelector('[data-st-keys]');
        const constInput = box.querySelector('[data-st-const]');
        keysInput.addEventListener('input', () => { if (!keysInput.value.trim()) constInput.checked = true; });
    });
    // 编辑框展开/收起：一个条目一个框，打开几个互不影响
    list.querySelectorAll('[data-st-edit]').forEach(el => el.addEventListener('click', () => {
        const box = list.querySelector(`[data-st-editbox="${el.dataset.stEdit}"]`);
        if (box) box.hidden = !box.hidden;
    }));
    list.querySelectorAll('[data-st-editbox]').forEach(box => {
        const item = settings.storageItems.find(x => x.id === box.dataset.stEditbox);
        if (!item) return;
        box.querySelector('[data-st-save]').addEventListener('click', () => {
            const name = box.querySelector('[data-st-name]').value.trim();
            const content = box.querySelector('[data-st-content]').value.trim();
            if (!name || !content) { toastr.warning('请填写名称与内容'); return; }
            // 深度 0 是合法值（同添加表单），留空才回退默认
            const depthRaw = box.querySelector('[data-st-depth]').value.trim();
            item.name = name;
            item.keys = box.querySelector('[data-st-keys]').value.split(/[,，]/).map(s => s.trim()).filter(Boolean);
            item.constant = box.querySelector('[data-st-const]').checked;
            item.depth = depthRaw !== '' && Number.isFinite(Number(depthRaw))
                ? Math.min(Math.max(Math.round(Number(depthRaw)), 0), 16) : 6;
            item.content = content;
            save();
            scanAndApplyStorage();   // 正文/深度/触发词/常驻任一改动都靠这一次重扫落到注入
            renderList(root);
            toastr.success(`已保存「${name}」并按新参数重扫注入`);
        });
        box.querySelector('[data-st-cancel]').addEventListener('click', () => { box.hidden = true; });
    });
    list.querySelectorAll('[data-st-del]').forEach(el => el.addEventListener('click', () => {
        stOpenRows.delete(el.dataset.stDel);   // 行展开状态随条目一并清掉
        removeItem(el.dataset.stDel);
        renderList(root);
    }));
}
