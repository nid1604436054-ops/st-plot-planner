// 设置单例：读写酒馆 extension_settings，持久化到服务器端 settings.json
// 所有模块统一从这里取 settings，禁止各自直接碰 extension_settings
import { extension_settings } from "/scripts/extensions.js";
import { saveSettingsDebounced } from "/script.js";

export const MODULE_KEY = 'plot-planner';

const DEFAULTS = {
    api: {
        baseUrl: '',        // OpenAI 兼容接口根地址，如 https://api.openai.com/v1
        apiKey: '',
        model: '',
        temperature: 0.7,
        maxTokens: 1500,
    },
    retrieval: {
        scanDepth: 20,      // 世界书检索扫描最近多少层消息；0 = 不限（扫全部对话）
        maxEntries: 10,     // 单次检索最多带出的条目数；0 = 不限（命中多少带多少）
        maxChars: 6000,     // 检索结果拼装的字符上限（控制规划调用的输入规模）；0 = 不限
        contextLayers: 30,  // 规划调用携带的最近对话层数；0 = 不限（有多少层带多少层）
        memChars: 4000,     // 记忆表格召回拼装的字符上限；0 = 不限
    },
    guidance: {
        presets: [],        // 剧情指导预设：{id, name, content, enabled}，启用的按列表顺序拼进系统提示词
        inject: {           // 「转注入 / 剧情自动注入」的默认参数（界面改动会记住）
            depth: 4,
            role: 'system',
            expires: 'never',   // 'never' 永久 | 'layers' N 层后过期
            layers: 20,
        },
    },
    lorebooks: [],          // M1 世界书库
    injections: [],         // M4 隐身注入项
    storageItems: [],       // M5 额外存储条目
    eventRules: [],         // M3 随机事件规则
};

function ensureDefaults() {
    const store = (extension_settings[MODULE_KEY] ??= {});
    for (const [key, value] of Object.entries(DEFAULTS)) {
        if (store[key] === undefined) {
            store[key] = JSON.parse(JSON.stringify(value));
        }
    }
    // 旧版单预设（customPrompt）迁移成列表第一条，已写的内容不丢
    if (store.guidance && !Array.isArray(store.guidance.presets)) {
        store.guidance.presets = store.guidance.customPrompt
            ? [{ id: newId('gd-'), name: '我的预设', content: store.guidance.customPrompt, enabled: true }]
            : [];
    }
    // 顶层 ??= 只对新装用户生效，老安装的嵌套新字段在这里补
    store.retrieval.memChars ??= 4000;
    store.guidance.inject ??= { depth: 4, role: 'system', expires: 'never', layers: 20 };
    return store;
}

export const settings = ensureDefaults();

export function save() {
    saveSettingsDebounced();
}

export function newId(prefix = '') {
    return `${prefix}${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
