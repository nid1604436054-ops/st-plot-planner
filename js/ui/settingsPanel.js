// 扩展设置区块：挂在酒馆「扩展」面板里，负责独立 API 通道与检索参数配置
import { settings, save } from "../settings.js";
import { testConnection } from "../api.js";
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
                <label class="pp-label">API 地址（OpenAI 兼容，含 /v1）</label>
                <input id="pp_set_base" class="text_pole textarea_compact" type="text" placeholder="https://api.openai.com/v1" autocomplete="off" />
                <label class="pp-label">API 密钥</label>
                <input id="pp_set_key" class="text_pole textarea_compact" type="password" placeholder="sk-..." autocomplete="off" />
                <label class="pp-label">模型名称</label>
                <input id="pp_set_model" class="text_pole textarea_compact" type="text" placeholder="gpt-4o-mini / deepseek-chat / ..." autocomplete="off" />
                <div class="pp-grid2">
                    <div>
                        <label class="pp-label">温度</label>
                        <input id="pp_set_temp" class="text_pole textarea_compact" type="number" min="0" max="2" step="0.1" />
                    </div>
                    <div>
                        <label class="pp-label">单次上限 tokens</label>
                        <input id="pp_set_maxtok" class="text_pole textarea_compact" type="number" min="128" step="64" />
                    </div>
                </div>
                <hr class="pp-hr" />
                <label class="pp-label">世界书检索：扫描最近层数</label>
                <input id="pp_set_scan" class="text_pole textarea_compact" type="number" min="1" max="100" />
                <div class="pp-grid2">
                    <div>
                        <label class="pp-label">最多带出条目</label>
                        <input id="pp_set_maxent" class="text_pole textarea_compact" type="number" min="1" max="50" />
                    </div>
                    <div>
                        <label class="pp-label">检索结果字数上限</label>
                        <input id="pp_set_maxch" class="text_pole textarea_compact" type="number" min="500" step="500" />
                    </div>
                </div>
                <label class="pp-label">规划调用：携带对话层数</label>
                <input id="pp_set_ctx" class="text_pole textarea_compact" type="number" min="4" max="200" />
                <div class="pp-btn-row">
                    <div id="pp_set_test" class="menu_button">测试连接</div>
                    <div id="pp_set_open" class="menu_button">打开剧情规划器</div>
                </div>
                <div id="pp_set_test_result" class="pp-muted"></div>
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
