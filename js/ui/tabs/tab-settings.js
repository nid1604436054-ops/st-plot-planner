// 设置页签：独立大模型通道（地址/密钥/模型）+ 检索与生成参数 + 预设（全局固定要求）管理 + 生效中注入的管理
// 配置直接放在主面板里，魔法棒 → 剧情规划器 → 设置，无需再去扩展面板
import { settings, save, newId } from "../../settings.js";
import { testConnection, fetchModels, searchWeb } from "../../api.js";
import { updateInjection, removeInjection } from "../../injection.js";
import { guidanceSystemPrompt } from "../../planner.js";
import { activeStory } from "../../story.js";
import { escapeHtml, clamp, fingerprint } from "../../utils.js";

// 拉取过的模型列表缓存：页签每次激活都会重渲染，缓存避免切换后下拉列表丢失
let modelIds = [];
// true = 手动填模型名（拉取的列表里没有时用），false = 下拉选择
let manualModel = false;

// 重建模型下拉框；当前已保存的模型若不在列表里，作为「当前自定义」置顶保留
function rebuildModelSelect(container) {
    const select = container.querySelector('#pp_set_model');
    if (!select) return;
    const current = settings.api.model;
    let html = '';
    if (!modelIds.length) {
        html += `<option value="">${current ? `当前自定义：${escapeHtml(current)}` : '请先点「获取模型列表」'}</option>`;
    } else {
        if (!current || !modelIds.includes(current)) {
            html += `<option value="${escapeHtml(current)}" selected>${current ? `当前自定义：${escapeHtml(current)}` : '（未选择）'}</option>`;
        }
        html += modelIds.map(id => `<option value="${escapeHtml(id)}" ${id === current ? 'selected' : ''}>${escapeHtml(id)}</option>`).join('');
    }
    select.innerHTML = html;
}

// 按 manualModel 切换 下拉框/手动输入框 两个控件
function applyModelMode(container) {
    const select = container.querySelector('#pp_set_model');
    const text = container.querySelector('#pp_set_model_text');
    const toggle = container.querySelector('#pp_set_model_toggle');
    if (!select || !text || !toggle) return;
    select.hidden = manualModel;
    text.hidden = !manualModel;
    toggle.textContent = manualModel ? '改为下拉' : '手动输入';
    toggle.title = manualModel ? '切换回下拉选择' : '列表里没有想要的模型？点这里手动填模型名';
    if (manualModel) text.value = settings.api.model;
    else rebuildModelSelect(container);
}

export const settingsTab = {
    id: 'settings',
    title: '设置',
    render(container) {
        container.innerHTML = `
        <div class="pp-section">
            <b>大模型连接</b>
            <label class="pp-label">API 地址（含 /v1）</label>
            <input id="pp_set_base" class="text_pole textarea_compact" type="text" placeholder="https://api.openai.com/v1" autocomplete="off" />
            <label class="pp-label">API 密钥</label>
            <input id="pp_set_key" class="text_pole textarea_compact" type="password" placeholder="sk-..." autocomplete="off" />
            <label class="pp-label">模型</label>
            <div class="pp-model-row">
                <select id="pp_set_model" class="text_pole"></select>
                <input id="pp_set_model_text" class="text_pole textarea_compact" type="text" placeholder="手动填写模型名" hidden autocomplete="off" />
                <div id="pp_set_model_toggle" class="menu_button">手动输入</div>
                <div id="pp_set_fetch_models" class="menu_button" title="从 API 拉取可用模型列表，之后在下拉框中选择">获取模型列表</div>
            </div>
            <div class="pp-btn-row">
                <div id="pp_set_test" class="menu_button">测试连接</div>
            </div>
            <div id="pp_set_test_result" class="pp-muted"></div>
        </div>
        <div class="pp-section">
            <b>联网搜索（Tavily）</b>
            <label class="pp-label">搜索 API 密钥（tvly- 开头，tavily.com 注册）</label>
            <input id="pp_set_skey" class="text_pole textarea_compact" type="password" placeholder="tvly-..." autocomplete="off" />
            <div class="pp-grid2">
                <div>
                    <label class="pp-label" title="单次搜索带回并塞给模型的结果条数">每次带回条数</label>
                    <input id="pp_set_smax" class="text_pole textarea_compact" type="number" min="1" max="10" />
                </div>
                <div>
                    <label class="pp-label" title="勾上后：分析/检查前先由一次轻量判断（只发剧情简报）决定要不要联网，纯虚构剧情默认不检索；判「需要」才按给出的关键词直查（搜索不耗模型 token），结果附进材料；取消则完全不联网，只保留下方的手动试搜">分析前联网判断</label>
                    <input id="pp_set_stool" type="checkbox" />
                </div>
            </div>
            <label class="pp-label">试搜（验证搜索真的能用）</label>
            <input id="pp_set_stestq" class="text_pole textarea_compact" type="text" placeholder="输入关键词，如：最近的新闻" autocomplete="off" />
            <div class="pp-btn-row">
                <div id="pp_set_stest" class="menu_button">测试搜索</div>
            </div>
            <div id="pp_set_stest_result" class="pp-muted"></div>
        </div>
        <div class="pp-section">
            <b>高级设置（保持默认即可）</b>
            <div class="pp-grid2">
                <div>
                    <label class="pp-label" title="越低输出越稳定，越高越发散">温度</label>
                    <input id="pp_set_temp" class="text_pole textarea_compact" type="number" min="0" max="2" step="0.1" />
                </div>
                <div>
                    <label class="pp-label" title="规划类请求单次最多生成的 tokens">单次上限 tokens</label>
                    <input id="pp_set_maxtok" class="text_pole textarea_compact" type="number" min="128" step="64" />
                </div>
                <div>
                    <label class="pp-label" title="推理模型把「单次上限 tokens」全花在思考上、正文一个字不出（报空内容且 finish_reason=length）时勾上：请求会带上主流服务商的关闭思考参数（GLM 系 thinking / Qwen 系 enable_thinking），端点不认这些参数时自动去掉重发一次">关闭思考</label>
                    <input id="pp_set_thinkoff" type="checkbox" />
                </div>
            </div>
            <hr class="pp-hr" />
            <div class="pp-label pp-group-title">世界书检索</div>
            <label class="pp-label" title="在世界书里找条目时，拿最近几层对话文本去匹配关键词；范围越大越不容易漏，但越费 token；0 = 不限（扫全部对话）">用最近几层对话找关键词（0 = 不限）</label>
            <input id="pp_set_scan" class="text_pole textarea_compact" type="number" min="0" max="100" />
            <div class="pp-grid2">
                <div>
                    <label class="pp-label" title="单次检索最多带出的世界书条目数；0 = 不限（命中多少带多少）">最多带出条目（0 = 不限）</label>
                    <input id="pp_set_maxent" class="text_pole textarea_compact" type="number" min="0" max="50" />
                </div>
                <div>
                    <label class="pp-label" title="命中的条目内容拼在一起的总字数上限，防止撑爆请求；0 = 不截断">结果字数上限（0 = 不限）</label>
                    <input id="pp_set_maxch" class="text_pole textarea_compact" type="number" min="0" step="500" />
                </div>
            </div>
            <hr class="pp-hr" />
            <label class="pp-label" title="记忆表格召回结果拼进提示词的字符上限；0 = 不限。全量召回表格很大时注意 token 消耗">记忆表格召回字数上限（0 = 不限）</label>
            <input id="pp_set_memch" class="text_pole textarea_compact" type="number" min="0" step="500" />
            <hr class="pp-hr" />
            <label class="pp-label" title="「剧情指导 / 随机事件」调用大模型时，附带最近几层对话当上下文（只影响本插件的规划请求，不影响主对话）；0 = 不限（有多少层带多少层）">规划时附带最近几层对话（0 = 不限）</label>
            <input id="pp_set_ctx" class="text_pole textarea_compact" type="number" min="0" max="200" />
        </div>
        <div class="pp-section" id="pp_set_preset"></div>
        <div class="pp-section">
            <details class="pp-fold" id="pp_set_injfold">
                <summary><i class="fa-solid fa-eye-slash"></i> 生效中的隐身注入（查看 / 提前撤下）</summary>
                <div id="pp_set_injlist"></div>
            </details>
        </div>`;

        const bind = (id, get, set) => {
            const el = container.querySelector(id);
            el.value = get();
            el.addEventListener('change', () => { set(el.value); save(); });
        };
        const bindNum = (id, get, set) => bind(id, () => get(), v => set(Number(v) || 0));

        bind('#pp_set_base', () => settings.api.baseUrl, v => settings.api.baseUrl = String(v).trim());
        bind('#pp_set_key', () => settings.api.apiKey, v => settings.api.apiKey = String(v).trim());
        bindNum('#pp_set_temp', () => settings.api.temperature, v => settings.api.temperature = v);
        bindNum('#pp_set_maxtok', () => settings.api.maxTokens, v => settings.api.maxTokens = v);
        bindNum('#pp_set_scan', () => settings.retrieval.scanDepth, v => settings.retrieval.scanDepth = v);
        bindNum('#pp_set_maxent', () => settings.retrieval.maxEntries, v => settings.retrieval.maxEntries = v);
        bindNum('#pp_set_maxch', () => settings.retrieval.maxChars, v => settings.retrieval.maxChars = v);
        bindNum('#pp_set_memch', () => settings.retrieval.memChars, v => settings.retrieval.memChars = v);
        bindNum('#pp_set_ctx', () => settings.retrieval.contextLayers, v => settings.retrieval.contextLayers = v);
        const thinkOff = container.querySelector('#pp_set_thinkoff');
        thinkOff.checked = settings.api.thinkingOff === true;
        thinkOff.addEventListener('change', () => { settings.api.thinkingOff = thinkOff.checked; save(); });

        bind('#pp_set_skey', () => settings.search.apiKey, v => settings.search.apiKey = String(v).trim());
        bindNum('#pp_set_smax', () => settings.search.maxResults, v => settings.search.maxResults = Math.min(Math.max(v || 5, 1), 10));
        const sTool = container.querySelector('#pp_set_stool');
        sTool.checked = settings.search.toolMode !== false;
        sTool.addEventListener('change', () => { settings.search.toolMode = sTool.checked; save(); });

        applyModelMode(container);
        container.querySelector('#pp_set_model').addEventListener('change', () => {
            settings.api.model = String(container.querySelector('#pp_set_model').value || '').trim();
            save();
        });
        container.querySelector('#pp_set_model_text').addEventListener('change', () => {
            settings.api.model = String(container.querySelector('#pp_set_model_text').value || '').trim();
            save();
        });
        container.querySelector('#pp_set_model_toggle').addEventListener('click', () => {
            manualModel = !manualModel;
            applyModelMode(container);
        });

        container.querySelector('#pp_set_fetch_models').addEventListener('click', async function () {
            const result = container.querySelector('#pp_set_test_result');
            this.classList.add('disabled');
            result.textContent = '正在拉取模型列表……';
            try {
                // 显式同步输入框当前值，避免依赖 blur/change 触发时序
                settings.api.baseUrl = String(container.querySelector('#pp_set_base').value || '').trim();
                settings.api.apiKey = String(container.querySelector('#pp_set_key').value || '').trim();
                save();
                modelIds = await fetchModels();
                if (!settings.api.model) {
                    settings.api.model = modelIds[0];
                    save();
                }
                // 拉到列表就切回下拉模式，方便直接选
                manualModel = false;
                applyModelMode(container);
                result.textContent = `已获取 ${modelIds.length} 个模型，点击「模型」下拉框选择`;
                toastr.success(`已获取 ${modelIds.length} 个模型`);
            } catch (err) {
                result.textContent = '';
                toastr.error(String(err.message ?? err));
            } finally {
                this.classList.remove('disabled');
            }
        });

        container.querySelector('#pp_set_test').addEventListener('click', async function () {
            const result = container.querySelector('#pp_set_test_result');
            this.classList.add('disabled');
            result.textContent = '测试中……';
            try {
                const reply = await testConnection();
                result.textContent = `连接成功：${reply.slice(0, 50)}`;
                toastr.success('API 连接正常');
            } catch (err) {
                result.textContent = '';
                toastr.error(String(err.message ?? err));
            } finally {
                this.classList.remove('disabled');
            }
        });

        container.querySelector('#pp_set_stest').addEventListener('click', async function () {
            const box = container.querySelector('#pp_set_stest_result');
            // 显式同步密钥输入框当前值，避免依赖 blur/change 触发时序
            settings.search.apiKey = String(container.querySelector('#pp_set_skey').value || '').trim();
            save();
            const query = String(container.querySelector('#pp_set_stestq').value || '').trim();
            if (!settings.search.apiKey) { toastr.warning('请先填写搜索 API 密钥'); return; }
            if (!query) { toastr.warning('请先在输入框里填一个关键词'); return; }
            this.classList.add('disabled');
            box.textContent = '搜索中……';
            try {
                const results = await searchWeb(query);
                box.innerHTML = results.length
                    ? `共 ${results.length} 条结果：<div class="pp-search-list">` + results.map(r =>
                        `<div class="pp-search-hit"><a href="${escapeHtml(r.url)}" target="_blank" rel="noopener">${escapeHtml(r.title || r.url)}</a>`
                        + `<span class="pp-muted">${escapeHtml(r.content.slice(0, 140))}</span></div>`).join('') + '</div>'
                    : '搜索请求成功，但没有命中结果：换个关键词试试';
                toastr.success('联网搜索可用');
            } catch (err) {
                box.textContent = '';
                toastr.error(String(err.message ?? err));
            } finally {
                this.classList.remove('disabled');
            }
        });

        renderPreset(container);
        renderInjList(container);
    },
};

// ---------------------------------------------------------------------------
// 生效中的隐身注入：各功能确认后创建，这里只做查看 / 停用 / 删除
// ---------------------------------------------------------------------------

function injSourceName(item) {
    if (item.source === 'reaction') return '路人反应';
    const names = { manual: '手动', event: '随机事件', planner: '剧情规划', story: '剧情绑定' };
    return names[item.source] ?? item.source ?? '手动';
}

function renderInjList(container) {
    const list = container.querySelector('#pp_set_injlist');
    if (!list) return;
    if (!settings.injections.length) {
        list.innerHTML = '<div class="pp-muted">暂无生效中的注入</div>';
        return;
    }
    list.innerHTML = settings.injections.slice().reverse().map(i => `
        <div class="pp-item">
            <div class="pp-item-main">
                <span class="pp-item-title">${escapeHtml(i.label)}</span>
                <span class="pp-muted">
                    深度 ${i.depth ?? 4} · ${i.scope === 'global' ? '全局' : '本聊天'} · 来源 ${injSourceName(i)}
                    ${i.expires?.type === 'layers' ? ` · ${i.age ?? 0}/${i.expires.layers} 层` : ''}${i.enabled ? '' : ' · 已停用'}
                </span>
                ${i.mode === 'sealed'
                    ? `<span class="pp-muted">密封内容（历史条目） · ${fingerprint(i.content)}</span>`
                    : `<span class="pp-muted">${escapeHtml(clamp(i.content, 100))}</span>`}
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
        renderInjList(container);
    }));
    list.querySelectorAll('[data-inj-del]').forEach(el => el.addEventListener('click', () => {
        removeInjection(el.dataset.injDel);
        renderInjList(container);
    }));
}

// ---------------------------------------------------------------------------
// 预设（全局固定要求）：多条命名预设，默认折叠成一条摘要行（交互同记忆表格「原表库」）。
// 勾选「启用」即全局生效——插件发给大模型的每一次调用（规划分析/检查报告/随机事件/路人反应/
// AI 打标/AI 建库/联网判断）都会把启用中的预设按列表顺序拼进系统提示词末尾（chatCompletion
// 出口统一附加，见 api.globalPresetBlock）。所有改动即时保存。
// 管理入口在本页（原挂剧情指导页底部，应用户要求挪到设置）；向导第 1 步与反应卡的
// 逐次预设勾选已随全局化移除——这里的启用开关是唯一开关
// ---------------------------------------------------------------------------

let presetOpen = false;
let editingPreset = null;   // 正在编辑内容的预设 id

function findPreset(id) {
    return (settings.guidance?.presets ?? []).find(p => p.id === id);
}

function presetSummary() {
    const list = settings.guidance?.presets ?? [];
    const n = list.filter(p => p.enabled).length;
    return list.length ? `${list.length} 个预设 · ${n} 个全局生效` : '未设置';
}

function presetRow(p, i, total) {
    const editing = editingPreset === p.id;
    return `
    <div class="pp-item" data-preset-item="${p.id}">
        <div class="pp-item-main">
            <label title="勾选后全局生效：插件发给大模型的任何调用都会附上这条预设"><input type="checkbox" data-pena="${p.id}" ${p.enabled ? 'checked' : ''} /> <b class="pp-gd-pname">${escapeHtml(p.name)}</b></label>
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
        <label class="pp-label">内容（固定要求：内容格式、文风、篇幅、侧重点等；全局生效，改动即时保存）</label>
        <textarea class="text_pole textarea_compact" rows="6" data-pcontent="${p.id}" placeholder="例：&#10;1. 用中文写，文风克制、不堆形容词；&#10;2. 每个阶段 content 至少两句话，写清幕后安排和动因；&#10;3. beats 按「铺垫→推进→转折→收束」组织。">${escapeHtml(p.content ?? '')}</textarea>
    </div>` : ''}`;
}

function renderPreset(container) {
    const el = container.querySelector('#pp_set_preset');
    if (!el) return;
    const presets = settings.guidance?.presets ?? [];
    const head = `
    <div class="pp-item" id="pp_set_preset_head" title="写一次、处处生效的固定要求（格式/文风/篇幅/侧重点等）。勾选「启用」的按列表顺序拼接（每条自带预设名做小标题），拼进插件发给大模型的每一次调用的系统提示词末尾——规划分析、检查报告、随机事件、路人反应、AI 打标、AI 建库、联网判断全都带上，可多条同时启用做组合；开关只有这里这一处。注意：输出须仍是各任务的 JSON 骨架（程序要解析），格式要求写在内容层面（写法、语言、详细程度），别要求改成纯正文——预设头部自带格式保护语，但别刻意对抗">
        <div class="pp-item-main"><b>预设（全局固定要求）</b></div>
        <div class="pp-item-ops">
            <span class="pp-muted">${presetSummary()}</span>
            <span class="menu_button" id="pp_set_preset_toggle">${presetOpen ? '收起' : '编辑'} <i class="fa-solid fa-chevron-${presetOpen ? 'down' : 'right'}"></i></span>
        </div>
    </div>`;

    if (!presetOpen) {
        el.innerHTML = head;
        el.querySelector('#pp_set_preset_toggle').addEventListener('click', () => {
            presetOpen = true;
            renderPreset(container);
        });
        return;
    }

    el.innerHTML = `
    ${head}
    ${presets.map((p, i) => presetRow(p, i, presets.length)).join('') || '<div class="pp-muted">还没有预设，点下面「新建预设」加一条</div>'}
    <div class="pp-btn-row">
        <span id="pp_set_preset_new" class="menu_button"><i class="fa-solid fa-plus"></i> 新建预设</span>
        <span id="pp_set_preset_builtin" class="menu_button" title="展开查看内置的系统指令和预设拼接的位置">查看内置指令</span>
    </div>
    <div id="pp_set_preset_view" class="pp-gd-builtin" style="display:none"></div>`;

    const refreshHead = () => {
        el.querySelector('#pp_set_preset_head .pp-muted').textContent = presetSummary();
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

    el.querySelector('#pp_set_preset_toggle').addEventListener('click', () => {
        presetOpen = false;
        editingPreset = null;
        renderPreset(container);
    });
    el.querySelector('#pp_set_preset_new').addEventListener('click', () => {
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
    el.querySelector('#pp_set_preset_builtin').addEventListener('click', () => {
        const view = el.querySelector('#pp_set_preset_view');
        const show = view.style.display === 'none';
        view.style.display = show ? '' : 'none';
        if (show) {
            const hasActive = Boolean((activeStory()?.planText ?? '').trim());
            view.textContent = `${guidanceSystemPrompt(hasActive)}\n\n## 用户全局预设（启用中的预设按顺序追加在这里——所有模型调用共用这一拼法，规划分析/检查报告/随机事件/路人反应/AI 打标/AI 建库/联网判断都会带上，每条带「### 预设名」小标题）`
                + `\n（上面是「${hasActive ? '有' : '无'}进行中剧情」时的版本：progress 进度项只在该版本出现，第 4 步的「剧情进度」行同理）`;
        }
    });
}
