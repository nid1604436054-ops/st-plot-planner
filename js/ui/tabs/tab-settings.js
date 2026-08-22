// 设置页签：独立大模型通道（地址/密钥/模型）+ 检索与生成参数
// 配置直接放在主面板里，魔法棒 → 剧情规划器 → 设置，无需再去扩展面板
import { settings, save } from "../../settings.js";
import { testConnection, fetchModels } from "../../api.js";
import { escapeHtml } from "../../utils.js";

// 拉取过的模型列表缓存：页签每次激活都会重渲染，缓存避免切换后下拉列表丢失
let modelIds = [];

export const settingsTab = {
    id: 'settings',
    title: '设置',
    render(container) {
        container.innerHTML = `
        <div class="pp-section">
            <b>大模型连接</b>
            <span class="pp-muted">独立于酒馆主对话 API，只用于本插件的规划请求。OpenAI 兼容接口，需服务商允许浏览器跨域（CORS）。</span>
            <label class="pp-label">API 地址（含 /v1）</label>
            <input id="pp_set_base" class="text_pole textarea_compact" type="text" placeholder="https://api.openai.com/v1" autocomplete="off" />
            <label class="pp-label">API 密钥</label>
            <input id="pp_set_key" class="text_pole textarea_compact" type="password" placeholder="sk-..." autocomplete="off" />
            <label class="pp-label">模型</label>
            <div class="pp-model-row">
                <input id="pp_set_model" class="text_pole textarea_compact" type="text" list="pp_model_list" placeholder="点右侧按钮拉取列表" autocomplete="off" />
                <div id="pp_set_fetch_models" class="menu_button" title="从 API 拉取可用模型列表，之后点击输入框即可下拉选择">获取模型列表</div>
            </div>
            <datalist id="pp_model_list">${
                modelIds.map(id => `<option value="${escapeHtml(id)}"></option>`).join('')
            }</datalist>
            <div class="pp-btn-row">
                <div id="pp_set_test" class="menu_button">测试连接</div>
            </div>
            <div id="pp_set_test_result" class="pp-muted"></div>
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
            </div>
            <hr class="pp-hr" />
            <div class="pp-label pp-group-title">世界书检索</div>
            <label class="pp-label" title="在世界书里找条目时，拿最近几层对话文本去匹配关键词；范围越大越不容易漏，但越费 token">用最近几层对话找关键词</label>
            <input id="pp_set_scan" class="text_pole textarea_compact" type="number" min="1" max="100" />
            <div class="pp-grid2">
                <div>
                    <label class="pp-label" title="单次检索最多带出的世界书条目数">最多带出条目</label>
                    <input id="pp_set_maxent" class="text_pole textarea_compact" type="number" min="1" max="50" />
                </div>
                <div>
                    <label class="pp-label" title="命中的条目内容拼在一起的总字数上限，防止撑爆请求">结果字数上限</label>
                    <input id="pp_set_maxch" class="text_pole textarea_compact" type="number" min="500" step="500" />
                </div>
            </div>
            <hr class="pp-hr" />
            <label class="pp-label" title="「剧情指导 / 随机事件」调用大模型时，附带最近几层对话当上下文（只影响本插件的规划请求，不影响主对话）">规划时附带最近几层对话</label>
            <input id="pp_set_ctx" class="text_pole textarea_compact" type="number" min="4" max="200" />
        </div>`;

        const bind = (id, get, set) => {
            const el = container.querySelector(id);
            el.value = get();
            el.addEventListener('change', () => { set(el.value); save(); });
        };
        const bindNum = (id, get, set) => bind(id, () => get(), v => set(Number(v) || 0));

        bind('#pp_set_base', () => settings.api.baseUrl, v => settings.api.baseUrl = String(v).trim());
        bind('#pp_set_key', () => settings.api.apiKey, v => settings.api.apiKey = String(v).trim());
        bind('#pp_set_model', () => settings.api.model, v => settings.api.model = String(v).trim());
        bindNum('#pp_set_temp', () => settings.api.temperature, v => settings.api.temperature = v);
        bindNum('#pp_set_maxtok', () => settings.api.maxTokens, v => settings.api.maxTokens = v);
        bindNum('#pp_set_scan', () => settings.retrieval.scanDepth, v => settings.retrieval.scanDepth = v);
        bindNum('#pp_set_maxent', () => settings.retrieval.maxEntries, v => settings.retrieval.maxEntries = v);
        bindNum('#pp_set_maxch', () => settings.retrieval.maxChars, v => settings.retrieval.maxChars = v);
        bindNum('#pp_set_ctx', () => settings.retrieval.contextLayers, v => settings.retrieval.contextLayers = v);

        container.querySelector('#pp_set_fetch_models').addEventListener('click', async function () {
            const input = container.querySelector('#pp_set_model');
            const list = container.querySelector('#pp_model_list');
            const result = container.querySelector('#pp_set_test_result');
            this.classList.add('disabled');
            result.textContent = '正在拉取模型列表……';
            try {
                // 显式同步输入框当前值，避免依赖 blur/change 触发时序
                settings.api.baseUrl = String(container.querySelector('#pp_set_base').value || '').trim();
                settings.api.apiKey = String(container.querySelector('#pp_set_key').value || '').trim();
                save();
                modelIds = await fetchModels();
                list.innerHTML = modelIds.map(id => `<option value="${escapeHtml(id)}"></option>`).join('');
                if (!input.value.trim()) {
                    input.value = modelIds[0];
                    settings.api.model = modelIds[0];
                    save();
                }
                result.textContent = `已获取 ${modelIds.length} 个模型，点击模型输入框下拉选择`;
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
    },
};
