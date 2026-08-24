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
        thinkingOff: false, // 推理模型关闭思考：请求体附加主流关闭参数（GLM 系 thinking / Qwen 系 enable_thinking），端点不认时自动去参重试
    },
    search: {
        provider: 'tavily',    // 联网搜索供应商（当前仅 Tavily，浏览器直连）
        apiKey: '',
        maxResults: 5,         // 单次搜索带回的结果条数
        toolMode: true,        // 分析/检查前先轻量判断要不要联网（只发剧情简报），判需要才按关键词直查 Tavily
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
        branches: {         // 掷骰三板块：每次掷骰先在勾选板块里按权重抽一个，再走该板块的抽取逻辑
            entries: { enabled: true, weight: 6 },   // 事件条目：从事件库按 权重×概率 抽一条
            free: { enabled: true, weight: 4 },      // 维度随机：按维度权重抽方向即兴
            ai: { enabled: false, weight: 2 },       // AI 自主：模型从维度清单里挑最贴合剧情的
        },
        recent: [],         // 最近掷出的事件（防重复与密度规则用）：{title, dimension, source, at}
    },
    lorebooks: [],          // M1 世界书库
    lorebookTrash: [],      // 世界书回收站：删的书/条目先进这里，页面上可恢复或彻底删除
    chatData: {},           // 每聊天数据的冷层留底（见 js/chatdata.js）：{ [聊天身份]: { memory/story/picks/reaction/books } }
    uiZoom: 100,            // 面板内容缩放百分比（80–160，抽屉头部步进器调）：字与控件等比放大、页面相应变长
    injections: [],         // M4 隐身注入项
    storageItems: [],       // M5 额外存储条目
    storageScanLayers: 20,  // M5 玩法触发词扫描窗口：触发词在最近几层对话里出现过才算命中；0 = 不限（扫全部对话）
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
    store.storageScanLayers ??= 20;   // 老安装补玩法触发词扫描窗口（沿用此前写死的 20）
    store.lorebookTrash ??= [];       // 老安装补世界书回收站
    store.chatData ??= {};            // 老安装补每聊天数据冷层
    // M3 三层化迁移：老安装补维度层与掷骰配置，已有条目挂上维度/轻重/关键词（不覆盖已写内容）
    if (!Array.isArray(store.eventDimensions) || !store.eventDimensions.length) {
        store.eventDimensions = JSON.parse(JSON.stringify(DEFAULTS.eventDimensions));
    }
    store.events ??= { recent: [] };
    // 掷骰三板块迁移：旧的「事件库占比」百分比换算成 条目/随机 权重，AI 自主默认关（不改变既有口味）
    if (!store.events.branches) {
        const ratio = Math.min(Math.max(Number(store.events.libraryRatio ?? 60) || 0, 0), 100);
        store.events.branches = {
            entries: { enabled: true, weight: ratio / 10 },
            free: { enabled: true, weight: (100 - ratio) / 10 },
            ai: { enabled: false, weight: 2 },
        };
    }
    delete store.events.libraryRatio;
    delete store.events.sections;
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
