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
    search: {
        provider: 'tavily',    // 联网搜索供应商（当前仅 Tavily，浏览器直连）
        apiKey: '',
        maxResults: 5,         // 单次搜索带回的结果条数
        toolMode: true,        // 剧情分析/检查报告调用时把 web_search 作为工具交给模型自主调用
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
    events: {
        libraryRatio: 60,   // 掷骰走事件库条目的百分比，其余次数按维度加权走自由生成
        recent: [],         // 最近掷出的事件（防重复与密度规则用）：{title, dimension, source, at}
    },
    lorebooks: [],          // M1 世界书库
    injections: [],         // M4 隐身注入项
    storageItems: [],       // M5 额外存储条目
    eventRules: [],         // M3 随机事件条目（事件库）：{id, name, dimension, severity, keywords, probability, weight, cooldownLayers, promptHint, enabled, lastFloor}
    eventDimensions: [      // M3 维度层：库内条目的分组骨架，也是自由生成的方向池
        { id: 'dim-favor', name: '顺向', weight: 1, enabled: true, prompt: '对主角有利的小惊喜：意外之喜（中奖、多送、捡到东西）、被善意注视（被夸、被小孩盯着看、被陌生人帮忙）。以轻为主，让世界显得有温度，不扭转剧情走向。' },
        { id: 'dim-chance', name: '机会', weight: 1, enabled: true, prompt: '新的方向与邀约：临时邀约（招人、比赛、演出）、竞争性小游戏（街机、娃娃机、赌约）、被认可（搭话、递名片）。给 user 一个可拉可不拉的新选项。' },
        { id: 'dim-env', name: '环境', weight: 1, enabled: true, prompt: '舞台本身的变化：天气突变、设施故障、场所自带事件（争执、表演、有人在拍、排队）、他人求助。改变环境而不针对主角。' },
        { id: 'dim-friction', name: '摩擦', weight: 1.2, enabled: true, prompt: '有张力、会发酵的麻烦：曝光被识别、舆情发酵、小意外、过去浮现、外部觊觎、群体内部摩擦（谁付钱、坐哪、点什么）。危机可以重，出口必须存在。' },
        { id: 'dim-rel', name: '关系与旧事', weight: 1, enabled: true, prompt: '围绕具体人物的涟漪：旧识突然出现、旧情旧怨被提起、关系出现微妙变化。' },
    ],
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
    // M3 三层化迁移：老安装补维度层与掷骰配置，已有条目挂上维度/轻重/关键词（不覆盖已写内容）
    if (!Array.isArray(store.eventDimensions) || !store.eventDimensions.length) {
        store.eventDimensions = JSON.parse(JSON.stringify(DEFAULTS.eventDimensions));
    }
    store.events ??= { libraryRatio: 60, recent: [] };
    if (Array.isArray(store.eventRules)) {
        const legacyDim = { '偶遇旧识': 'dim-rel', '环境突变': 'dim-env', '意外阻碍': 'dim-friction', '有利线索': 'dim-favor' };
        for (const r of store.eventRules) {
            r.dimension ??= legacyDim[r.name] ?? store.eventDimensions[0]?.id ?? '';
            r.severity ??= 'light';
            r.keywords ??= '';
        }
    }
    return store;
}

export const settings = ensureDefaults();

export function save() {
    saveSettingsDebounced();
}

export function newId(prefix = '') {
    return `${prefix}${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
