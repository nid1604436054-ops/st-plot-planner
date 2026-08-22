// 扩展设置区块：挂在酒馆「扩展」面板里，负责独立 API 通道配置
// 常用项（地址/密钥/模型）置顶；检索与生成参数收进「高级设置」，悬停有说明
import { settings, save } from "../settings.js";
import { testConnection, fetchModels } from "../api.js";
import { escapeHtml } from "../utils.js";
import { openDrawer } from "./drawer.js";

export function initSettingsPanel() {
    const html = `
    <div class="plot-planner-ext">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>剧情规划器</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
              <div class="pp-settings-body">
                <label class="pp-label">API 地址（OpenAI 兼容，含 /v1）</label>
                <input id="pp_set_base" class="text_pole textarea_compact" type="text" placeholder="https://api.openai.com/v1" autocomplete="off" />
                <label class="pp-label">API 密钥</label>
                <input id="pp_set_key" class="text_pole textarea_compact" type="password" placeholder="sk-..." autocomplete="off" />
                <label class="pp-label">模型</label>
                <div class="pp-model-row">
                    <input id="pp_set_model" class="text_pole textarea_compact" type="text" list="pp_model_list" placeholder="点右侧按钮拉取列表" autocomplete="off" />
                    <div id="pp_set_fetch_models" class="menu_button" title="从 API 拉取可用模型列表，之后点击输入框即可下拉选择">获取模型列表</div>
                </div>
                <datalist id="pp_model_list"></datalist>
                <div class="pp-btn-row">
                    <div id="pp_set_test" class="menu_button">测试连接</div>
                    <div id="pp_set_open" class="menu_button">打开剧情规划器</div>
                </div>
                <div id="pp_set_test_result" class="pp-muted"></div>

                <div class="inline-drawer">
                    <div class="inline-drawer-toggle inline-drawer-header">
                        <b>高级设置（保持默认即可）</b>
                        <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                    </div>
                    <div class="inline-drawer-content">
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
                    </div>
                </div>
              </div>
            </div>
        </div>
    </div>`;
    $('#extensions_settings').append(html);

    const bind = (id, get, set) => {
        const el = $(id);
        el.val(get());
        el.on('change', () => { set(el.val()); save(); });
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

    $('#pp_set_fetch_models').on('click', async function () {
        const input = $('#pp_set_model');
        const list = $('#pp_model_list');
        const result = $('#pp_set_test_result');
        $(this).addClass('disabled');
        result.text('正在拉取模型列表……');
        try {
            // 显式同步输入框当前值，避免依赖 blur/change 触发时序
            settings.api.baseUrl = String($('#pp_set_base').val() || '').trim();
            settings.api.apiKey = String($('#pp_set_key').val() || '').trim();
            save();
            const ids = await fetchModels();
            list.empty().append(ids.map(id => `<option value="${escapeHtml(id)}"></option>`).join(''));
            if (!input.val().trim()) input.val(ids[0]).trigger('change');
            result.text(`已获取 ${ids.length} 个模型，点击模型输入框下拉选择`);
            toastr.success(`已获取 ${ids.length} 个模型`);
        } catch (err) {
            result.text('');
            toastr.error(String(err.message ?? err));
        } finally {
            $(this).removeClass('disabled');
        }
    });

    $('#pp_set_test').on('click', async function () {
        const result = $('#pp_set_test_result');
        $(this).addClass('disabled');
        result.text('测试中……');
        try {
            const reply = await testConnection();
            result.text(`连接成功：${reply.slice(0, 50)}`);
            toastr.success('API 连接正常');
        } catch (err) {
            result.text('');
            toastr.error(String(err.message ?? err));
        } finally {
            $(this).removeClass('disabled');
        }
    });

    $('#pp_set_open').on('click', openDrawer);
}
