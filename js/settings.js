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
        thinkingOff: false, // 推理模型关闭思考（生成侧总开关；监听恒关不吃它——第十七轮分家）：请求体附加主流关闭参数（GLM 系 thinking / Qwen 系 enable_thinking 等），端点不认时自动去参重试
        format: 'chat',     // 接口格式（第四十四轮）：'chat'＝对话补全 /chat/completions（默认，绝大多数兼容层）；'responses'＝OpenAI 新接口 /responses。方案库里每条方案各存各的格式，切换方案整套跟着换
        profiles: [],       // 供应商方案库：{id, name, baseUrl, apiKey, model, format}，设置页存当前连接、下拉一键切换（温度等其余参数全局共用）；
                            // 第四十轮起同一地址下不同模型各存一条（名字可改）——存取走 upsertApiProfile/renameApiProfile
    },
    search: {
        provider: 'tavily',    // 联网搜索供应商（当前仅 Tavily，浏览器直连）
        apiKey: '',
        maxResults: 5,         // 单次搜索带回的结果条数
        enabled: true,         // 联网搜索总开关：分析与检查可联网取现实信息（关 = 完全不联网，只留手动试搜）
        preJudge: true,        // 模型搜索前判断：搜前先轻量判断要不要搜（关 = 每次直接检索，轻量调用只为取关键词）
    },
    retrieval: {
        scanDepth: 20,      // 事件库关键词扫描最近多少层消息（随机事件掷骰的条目资格窗口）；0 = 不限。
                            // 第四十三轮前它兼管世界书检索——世界书侧已改：向导一键看全部未隐藏楼层、
                            // 监听用自己的「关键词扫描层数」（监听页判定材料区、按聊天存）
        maxEntries: 10,     // 监听的世界书检索单次最多带出的条目数（常驻档不占名额）；0 = 不限
        maxChars: 6000,     // 监听的世界书检索拼装字符上限；0 = 不限
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
        minBeats: 5,        // 规划节点数下限（第七轮：用户构思没点名数量时的兜底；节点是将来监听挂载的判断点——0 = 不设下限）
        alignPass: true,    // 生成后自动追加第二遍对齐审校（第十二轮，用户拍板两遍调用治时间错位）——两遍提示词开头
                            // 逐字节相同（第十三轮尾巴化），支持前缀缓存的服务商约×1.2～1.4、不做缓存的接近×2；关掉只跑第一遍
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
    knowledge: {            // 2.0 知识库（§6.9）：全局共享（不绑聊天不绑角色），条目与冷却账都在这
        grabCount: 5,       // 每张清单每次抓取的条数（设置页可调）
        cooldownGens: 3,    // 选用条目的冷却采用次数（结算在确认采用/转隐身注入时，草稿放弃不记；提案值待数值终审；0 = 不冷却）
        lists: [],          // 清单 {id, name, fields[], entries[], nextCode, queue[]}：fields = 自定义表头，导入时定死永不迁移；queue = 轮换队列（本轮剩余未发条目 id，抓取时懒初始化）
    },
    listener: {             // 2.0 监听（全局项；逐轮留痕/挂载单位在 chatdata 的 listener 块按聊天走）
        enabled: false,     // 总开关：关 = 不分析、不注入、不扣发送（默认关，打开前不上路，防意外计费）
        depth: 2,           // 注入槽深度（0 = 紧贴上下文末尾；默认比 1.0 剧情注入的 4 更靠近末端）
        strictness: 'standard', // 达成判定松紧：loose 宽 / standard 标准 / strict 严
        intervene: 'medium',    // 介入强度：low 低 / medium 中 / high 高（两模式的发与不发都归它管）
        traceRounds: 50,    // 留痕滚动轮数
        stuckWindow: 3,     // 卡死参考窗口（连续约 N 轮无推进也无有效对话才考虑 stuck；提案值）
        progressMin: 400,   // 换算锚：一层楼有效推进字数区间的低端（示意默认，两端可调）
        progressMax: 800,   // 换算锚：区间高端
        // 材料开关（世界书检索/记忆表/楼层数）第三十七轮搬进按聊天的双材料单（监听页「判定材料」区），
        // 全局不再留默认键；旧存档的这三个键由 listenerState 迁移播种读走后删除
    },
    chatData: {},           // 每聊天数据的冷层留底（见 js/chatdata.js）：{ [聊天身份]: { memory/story/picks/reaction/books } }
    placeModels: {},        // 分处模型（第四十九轮）：{ [档位id]: 方案id }——每一处调用大模型的功能可单独
                            // 指定供应商方案；空/缺省＝跟随当前配置（主连接）。档位表见 api.js MODEL_PLACES，
                            // 界面在设置页最底部「分处模型」区；随导出备份的 global 段走
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
    delete store.guidance.customPrompt;   // 迁移完清残留旧键（§5：旧值不能留在设置文件里）
    // 顶层 ??= 只对新装用户生效，老安装的嵌套新字段在这里补
    store.api.profiles ??= [];        // 老安装补供应商方案列表
    store.api.format ??= 'chat';      // 老安装补接口格式（第四十四轮；存量方案一律按 chat 对话补全对待）
    store.retrieval.memChars ??= 4000;
    store.guidance.inject ??= { depth: 4, role: 'system', expires: 'never', layers: 20 };
    store.guidance.minBeats ??= 5;   // 老安装补规划节点下限（第七轮，默认 5）
    store.guidance.alignPass ??= true;   // 老安装补第二遍对齐审校开关（第十二轮，默认开）
    store.storageScanLayers ??= 20;   // 老安装补玩法触发词扫描窗口（沿用此前写死的 20）
    store.storageConsult ??= { idea: '', usePlan: false, useGp: false, draft: null };   // 玩法咨询的思路/材料勾选/草案（随全局设置留底）
    store.lorebookTrash ??= [];       // 老安装补世界书回收站
    store.knowledge ??= { grabCount: 5, cooldownGens: 3, lists: [] };   // 老安装补知识库（§6.9）
    store.knowledge.lists ??= [];
    store.chatData ??= {};            // 老安装补每聊天数据冷层
    store.placeModels ??= {};         // 老安装补分处模型（第四十九轮）
    migrateListenerProviderIntoPlaces(store);   // 监听模型固定项（旧键）搬进分处模型的监听档
    // 搜索开关拆分迁移：旧 toolMode（总闸+判断一体）折算成 enabled，preJudge 默认开（保持原行为）
    store.search.enabled ??= store.search.toolMode !== false;
    store.search.preJudge ??= true;
    delete store.search.toolMode;     // 残留键清掉，旧值不能再悄悄改行为
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

// 监听模型固定项迁移（第四十九轮）：旧键 settings.listener.providerId 的语义是
// ''＝方案库第一条 / '__main__'＝主连接 / 其他＝方案 id。新语义（placeModels.listener）：
// ''＝跟随当前配置（主连接）、其他＝方案 id。显式选过方案的 id 原样搬走；
// ''（默认）与 '__main__'（明确选主连接）都归 ''——旧默认「方案库第一条」按新口径
// 废弃（用户拍板：默认每一处都跟随当前配置）。导出成函数供离线测试台直测
export function migrateListenerProviderIntoPlaces(store) {
    store.placeModels ??= {};
    const old = store.listener?.providerId;
    if (typeof old === 'string' && old && old !== '__main__') store.placeModels.listener = old;
    if (store.listener) delete store.listener.providerId;   // 迁移完清残留旧键（§5：旧值不能留在设置文件里）
}

export function save() {
    saveSettingsDebounced();
}

export function newId(prefix = '') {
    return `${prefix}${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// 供应商方案保存（第四十轮：用户拍板「一个网站下可选不同模型配置分别保存＋自己改名」）。
// 去重键 = 地址＋密钥＋模型＋接口格式四件套：同地址同密钥换个模型再存＝另存一条（旧逻辑按地址＋密钥
// 去重，一个网站永远只有一条、换模型就覆盖——第四十轮按用户要求废掉）；四件套全同＝命中已有不新建。
// 新条目名字自动取 域名·模型名（地址不规范用原文），重名自动加 -2 -3；名字随时可在设置页改。
// format（第四十四轮）＝接口格式 chat/responses，同三件套不同格式也算两条不同方案——端点都不同
export function upsertApiProfile(baseUrl, apiKey, model, format = 'chat') {
    const list = settings.api.profiles ??= [];
    const fmt = format === 'responses' ? 'responses' : 'chat';
    const same = list.find(x => x.baseUrl === baseUrl && x.apiKey === apiKey && x.model === model && (x.format ?? 'chat') === fmt);
    if (same) return { profile: same, created: false };
    let host = baseUrl;
    try { host = new URL(baseUrl).host; } catch { /* 地址不规范就用原文当名字 */ }
    const base = model ? `${host}·${model}` : host;
    let name = base, n = 2;
    while (list.some(x => x.name === name)) name = `${base}-${n++}`;
    const profile = { id: newId('ap-'), name, baseUrl, apiKey, model, format: fmt };
    list.push(profile);
    return { profile, created: true };
}

// 供应商方案改名：只动显示名（监听/长线/知识库都按 id 取方案，名字纯装饰）。
// 空名与他人重名会被拒——下拉里两条同名会分不清
export function renameApiProfile(id, name) {
    const list = settings.api.profiles ?? [];
    const p = list.find(x => x.id === id);
    if (!p) return { ok: false, reason: '方案不存在（可能刚被删除），刷新下拉后重试' };
    const n = String(name ?? '').trim();
    if (!n) return { ok: false, reason: '名字不能为空' };
    if (list.some(x => x.id !== id && x.name === n)) return { ok: false, reason: `已有同名方案「${n}」，换一个名字` };
    p.name = n;
    return { ok: true };
}
