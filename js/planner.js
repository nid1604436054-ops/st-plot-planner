// M2 剧情指导：检查（OOC/剧情重复/文风重复/进度）+ 剧情规划（隐藏剧本）+ 检查报告
// 与 M3 共用「上下文收集 + 世界书检索 + 独立 API」管线，全程不碰主对话连接
import { chatCompletion, searchWeb, searchToolReady } from "./api.js";
import { collectPlanningContext, formatChatLog, characterSummary } from "./context.js";
import { buildLoreContext } from "./lorebook.js";
import { buildMemoryContext } from "./memoryTable.js";
import { storageItemsInEffect } from "./store.js";
import { activeReactionInjections } from "./injection.js";
import { settings } from "./settings.js";
import { extractJson, fingerprint } from "./utils.js";

// 输出 schema 两套变体：存在进行中剧情时才要求 progress（推进到哪个阶段 + 约百分比）。
// 首次规划没有可对照执行的剧情，不问进度——问了模型也会编一个出来（第 4 步曾出现
// 「还没采用的规划先有完成度」，根源就是 schema 无条件要这个字段）
const OUTPUT_SCHEMA_BASE = `{
  "checks": {
    "ooc": {
      "found": false,
      "items": [
        { "aspect": "性格|事实|关系|世界观|口吻", "evidence": "对话中的具体依据", "severity": "轻微|中等|严重", "fix": "修正建议" }
      ]
    },
    "plotRepeat": { "found": false, "note": "与进行中/历史剧情重复雷同之处；没有则空字符串" },
    "styleRepeat": { "level": "无|轻微|明显", "note": "仅判 char 的自发重复：user 是否先重复、char 重复了什么" }__PROGRESS__
  },
  "plan": {
    "summary": "一句话概括接下来的走向",
    "beats": [
      { "stage": "阶段名", "content": "该阶段的幕后剧情安排（不出现在对话文本中）" }
    ],
    "risks": ["可能跑偏的点"]
  }
}`;

const outputSchema = withProgress => OUTPUT_SCHEMA_BASE.replace(
    '__PROGRESS__',
    withProgress ? `,
    "progress": { "stage": "进行中剧情推进到哪个阶段", "pct": "约x%", "note": "判断依据" }` : '',
);

// 内置指令：保证返回 JSON（程序要解析成检查项 + 规划），用户预设追加在其后，见 assemblePresets。
// hasActivePlan 为真才要求 progress 字段，与 buildGuidanceMessages 是否附带「进行中剧情」小节同步
export function guidanceSystemPrompt(hasActivePlan = false) {
    return [
        '你是文字角色扮演的剧情顾问，负责两件事：',
        `1) 检查：结合角色设定与世界书条目，判断最近对话是否存在 OOC（脱离人设、事实、关系或世界观）、是否与已有剧情重复、文风是否重复${hasActivePlan ? '、正在执行的剧情推进到什么程度' : ''}；`,
        '2) 规划：为后续剧情设计「隐藏剧本」——只作为幕后指导的剧情安排，不会以对话形式呈现给用户。',
    '要求：判断必须引用对话依据；给出「进行中剧情」时对照它检查进度与重复；给了「随机事件」就将其自然融入规划；规划要具体、可执行、尊重既有设定；面向当前场景做预编排。',
    '文风重复的判定基准：只针对角色（char）的扮演文本——先检查用户（user）近期输入是否自己在重复动作、场景或指令；角色只是跟进用户发起的重复不算文风重复；只有用户没有重复而角色自发重复描写套路、桥段或句式时，才判「轻微/明显」，并在 note 里写明用户是否先重复、角色重复了什么。',
    '字符串值里不要出现英文双引号（引用一律写中文「」），也不要在值内换行。',
    '只输出一个符合如下结构的 JSON 对象，不要输出 JSON 以外的任何文字：',
    outputSchema(hasActivePlan),
].join('\n');
}

const REVIEW_SCHEMA = `{
  "completion": "约x%（当前处于规划中的哪个阶段）",
  "progress": { "moved": true, "note": "近几轮是否有效推进剧情，依据是什么" },
  "styleRepeat": { "level": "无|轻微|明显", "note": "仅判 char 的自发重复：user 是否先重复、char 重复了什么" },
  "ooc": {
    "found": false,
    "items": [
      { "aspect": "性格|事实|关系|世界观|口吻", "evidence": "对话中的具体依据", "severity": "轻微|中等|严重", "fix": "修正建议" }
    ]
  },
  "otherIssues": ["其他问题；没有则空数组"],
  "advice": "把上述所有问题点明，并给出接下来可直接执行的剧情指导"
}`;

export const REVIEW_SYSTEM_PROMPT = [
    '你是文字角色扮演的剧情监理。用户会给你一份「正在执行的剧情规划」和最近的对话记录，',
    '你对照规划检查执行情况：完成度、近几轮是否有效推进、文风是否重复、是否 OOC、有无其他问题，',
    '最后把所有问题点明并给出可直接执行的剧情指导。',
    '文风重复只针对角色（char）的扮演文本判定：用户（user）自己在重复动作、场景或指令时，角色跟进不算；只有用户没有重复而角色自发重复描写套路、桥段或句式，才判轻微/明显，note 写明依据。',
    '字符串值里不要出现英文双引号（引用一律写中文「」），也不要在值内换行。',
    '只输出一个符合如下结构的 JSON 对象，不要输出 JSON 以外的任何文字：',
    REVIEW_SCHEMA,
].join('\n');

// 用户预设（格式/文风等固定要求）拼装：显式传入列表时按传入的来（向导的本次勾选），
// 缺省取设置里启用的；按列表顺序拼成带名小节。JSON 输出格式不能被预设改掉，否则解析会失败
export function assemblePresets(presets) {
    const src = Array.isArray(presets) ? presets : (settings.guidance?.presets ?? []).filter(p => p.enabled);
    return src
        .filter(p => String(p?.content ?? '').trim())
        .map(p => `### ${p.name}\n${String(p.content).trim()}`)
        .join('\n\n');
}

export function withPresets(base, custom) {
    return custom ? `${base}\n\n## 用户固定要求（在不改变上述 JSON 输出格式的前提下遵照执行）\n${custom}` : base;
}

// 真实账单提示（数字取服务商 usage 实报，非估算）：分析与检查调用结束就亮出来，
// 方便和「查看完整提示词」的材料字数对账——中文实际约 1.4~1.6 字/token，比预览粗估省。
// search：判断/检索阶段的信息（没开搜索时为 null，只报 token）；usage.streamNoUsage：
// 分析走了流式但服务商没在末包回传 usage，如实说明没有实报数字
function billToast(usage, search = null) {
    const parts = [];
    if (search) parts.push(search.searched
        ? `联网判断 1 次（轻量简报）+ Tavily 直查 ${search.queries} 个关键词（搜索不耗模型 token，全套材料只发 1 次）`
        : `联网判断 1 次（轻量简报）：本次不需要现实信息，未检索${search.reason ? `（${search.reason}）` : ''}`);
    if (usage?.promptTokens) parts.push(`合计输入 ${usage.promptTokens.toLocaleString()} · 输出 ${usage.completionTokens.toLocaleString()} tokens（服务商实报）`);
    else if (usage?.streamNoUsage) parts.push('本次分析走流式且服务商未在末包回传 usage，无实报 token 数字');
    if (search?.logs.length) parts.push(`检索词：${search.logs.join('；')}`);
    if (parts.length) toastr.info(parts.join('；'));
}

// 检索闸门的系统提示词：判断调用不带任何工具——模型手里没有 web_search 时才敢说「不需要」，
// 工具挂在请求里它总觉得该搜一下（上一版检索助手几乎逢开必搜的根源）。
// 判「需要」也只给关键词，执行由本地直查 Tavily，全程不再有大模型工具循环
const GATE_SYSTEM_PROMPT = [
    '你是「剧情是否需要联网检索」的判断员。用户正在为一篇文字角色扮演作品做剧情规划/执行检查，会给你一份浓缩的剧情背景简报。',
    '默认判「不需要」：联网检索是例外而非例行步骤，绝大多数纯虚构剧情用不上。只有当剧情明确依赖现实世界的具体事实、且写错会伤及真实感或剧情成立时，才判「需要」。',
    '判「需要」的典型：真实历史事件与年代细节、现实地域/机构/行业/法律/医学的具体运作方式、时效性信息（近期事件、价格、政策现状）、写错会露馅的专业流程细节。',
    '判「不需要」的典型：纯虚构世界观与设定、角色情感与关系走向、通用生活常识、可以虚构或模糊带过的地方。',
    '字符串值里不要出现英文双引号（引用一律写中文「」），也不要在值内换行。',
    '只输出一个 JSON 对象，不要输出 JSON 以外的任何文字：',
    '{ "need": false, "reason": "一句话判断理由", "queries": ["判「需要」时给 1-3 个搜索关键词；判「不需要」给空数组"] }',
].join('\n');

/**
 * 检索简报：给判断员的浓缩版剧情背景（千字级），字段与 buildGuidanceMessages 同源但全部截短。
 * 判断要不要联网只看这份小简报——全套材料与分析调用一起只发一次，计费不随检索增加；
 * 打回重写时把修改意见也带上，判断才知道要不要往新方向检索
 */
export function buildResearchBrief({ topic = '', userNote = '', eventText = '', activePlan = '', historySummaries = [], planText = '', revisionNote = '' } = {}) {
    const clip = (s, n) => String(s ?? '').trim().slice(0, n);
    const plan = clip(planText || activePlan, 500);
    const summaries = (historySummaries ?? []).filter(Boolean).join(' / ');
    const chatTail = formatChatLog(collectPlanningContext().chatList.slice(-6)).slice(-800);
    return [
        `## 检索任务\n${clip(topic, 120) || '判断本次剧情工作是否需要现实世界的具体事实'}`,
        `## 角色设定摘要\n${clip(characterSummary(200), 200) || '（无角色卡）'}`,
        plan ? `## 进行中剧情（节选）\n${plan}` : '',
        summaries ? `## 历史剧情摘要\n${clip(summaries, 300)}` : '',
        eventText ? `## 本次随机事件（节选）\n${clip(eventText, 200)}` : '',
        userNote ? `## 用户构思与要求\n${clip(userNote, 400)}` : '',
        revisionNote ? `## 修改意见（打回重写，判断检索方向时结合它）\n${clip(revisionNote, 300)}` : '',
        chatTail ? `## 最近对话节选\n${chatTail}` : '',
    ].filter(Boolean).join('\n\n');
}

/**
 * 联网检索管线：①判断调用（无工具）决定本次要不要联网、要查什么；②判「需要」才按
 * 它给的关键词直接调 Tavily（纯搜索 API，不耗模型 token），结果整理成纪要。
 * 判断与执行分离后，「逢开必搜」和「材料×轮数计费」一起消失，大模型工具循环整体退役
 * @returns {Promise<{notes:string, searchLogs:string[], reason:string, usage:object}>}
 *          usage 只含判断这一次调用的账单；notes 为空 = 本次未检索
 */
export async function runWebResearch(research = {}) {
    const gateUsage = { promptTokens: 0, completionTokens: 0 };
    let raw;
    try {
        raw = await chatCompletion({
            messages: [
                { role: 'system', content: GATE_SYSTEM_PROMPT },
                { role: 'user', content: buildResearchBrief(research) },
            ],
            onUsage: u => { gateUsage.promptTokens = u.prompt_tokens ?? 0; gateUsage.completionTokens = u.completion_tokens ?? 0; },
        });
    } catch (err) {
        err.usage = { requests: 1, ...gateUsage };   // 判断失败的账单也带上（空内容报错时 onUsage 已先行记到）
        throw err;
    }
    const usage = { requests: 1, ...gateUsage };

    let verdict = null;
    try {
        verdict = extractJson(raw);   // 判断输出坏了（解析失败/结构不对）按「不需要」处理，宁可少搜不多搜
    } catch { /* 保持 null */ }
    const queries = (Array.isArray(verdict?.queries) ? verdict.queries : [])
        .map(q => String(q ?? '').trim()).filter(Boolean).slice(0, 3);
    if (!verdict?.need || !queries.length) {
        return { notes: '', searchLogs: [], reason: String(verdict?.reason ?? '').slice(0, 40), usage };
    }

    const searchLogs = [];
    const blocks = [];
    for (const q of queries) {
        try {
            const results = await searchWeb(q);
            searchLogs.push(q);
            blocks.push(results.length
                ? `### ${q}\n` + results.slice(0, 3).map(r => `- ${r.title}（${r.url}）：${r.content.slice(0, 200)}`).join('\n')
                : `### ${q}\n（该关键词无结果）`);
        } catch (err) {
            blocks.push(`### ${q}\n（检索失败：${err.message}）`);
        }
    }
    return { notes: blocks.join('\n\n'), searchLogs, reason: String(verdict?.reason ?? '').slice(0, 40), usage };
}

/**
 * 预跑联网判断：在「分析前确认」页渲染时就开跑，用户核对材料的几秒正好把它跑完。
 * 返回 { fingerprint, promise }，采用条件是指纹（= 判断简报全文的哈希）仍与当时一致——
 * 换了随机事件、改了构思/修改意见、对话推进了，指纹都会对不上而自动作废重判
 */
export function startResearchPrefetch(research = {}) {
    const key = fingerprint(buildResearchBrief(research));
    const promise = runWebResearch(research);
    promise.catch(() => {});   // 没被采用就丢弃的预跑（取消向导/输入变了）不许弹「未处理的拒绝」
    return { fingerprint: key, promise };
}

// 规划分析的检索判断输入：runPlotGuidance 与向导预跑共用同一份拼装，指纹才对得上
export function guidanceResearchInputs(options = {}) {
    return {
        topic: '判断接下来的剧情规划是否需要现实世界的具体事实',
        userNote: options.userNote ?? '',
        eventText: options.eventText ?? '',
        activePlan: options.activePlan ?? '',
        historySummaries: options.historySummaries ?? [],
        revisionNote: options.revisionNote ?? '',
    };
}

// 剧情分析 / 检查报告的统一出口。搜索开着时在正式分析前多两小步：
// ① 判断——只发千字简报的一次无工具调用，决定本次要不要联网（默认不要）；
// ② 直查——判「要」才按它给的关键词调 Tavily（不耗模型 token），纪要附加进材料。
// 全套材料只在正式分析发一次（onDelta 提供时走流式，界面实时收字）；判断/检索失败都不拦分析。
// onStage('gate'|'analysis') 供界面标注当前等在哪一步；prefetch 指纹对得上就直接用预跑结果
async function guidanceCompletion(messages, research = {}, { onDelta, onStage, prefetch } = {}) {
    const total = { promptTokens: 0, completionTokens: 0, streamNoUsage: false };
    const add = u => {
        total.promptTokens += u?.promptTokens ?? u?.prompt_tokens ?? 0;
        total.completionTokens += u?.completionTokens ?? u?.completion_tokens ?? 0;
    };
    let search = null;
    let notes = '';

    if (settings.search?.toolMode && searchToolReady()) {
        try {
            onStage?.('gate');
            const key = fingerprint(buildResearchBrief(research));
            const r = prefetch && prefetch.fingerprint === key
                ? await prefetch.promise            // 预跑时输入与现在完全一致：直接采用
                : await runWebResearch(research);   // 输入变了（换事件/改构思/新修改意见）：重判
            add(r.usage);
            search = { searched: r.searchLogs.length > 0, queries: r.searchLogs.length, logs: r.searchLogs, reason: r.reason };
            notes = r.notes;
        } catch (err) {
            if (err.name === 'AbortError') throw err;
            add(err.usage);   // 判断阶段失败也可能已产生计费（如空内容报错），照实累计
            toastr.warning(`联网判断失败，跳过检索继续分析：${err.message}`);
        }
    }

    const withNotes = notes
        ? messages.map(m => (m.role === 'user'
            ? { ...m, content: `${m.content}\n\n## 联网检索纪要（判断本次需要现实信息，已按关键词检索；仅供参考）\n${notes}` }
            : m))
        : messages;

    let analysisBilled = false;
    try {
        onStage?.('analysis');
        const text = await chatCompletion({
            messages: withNotes,
            onUsage: u => { add(u); analysisBilled = true; },
            ...(onDelta ? { onDelta } : {}),
        });
        total.streamNoUsage = Boolean(onDelta) && !analysisBilled;
        billToast(total, search);
        return text;
    } catch (err) {
        total.streamNoUsage = Boolean(onDelta) && !analysisBilled;
        billToast(total, search);   // 失败也要报真实账单：空内容报错时的输入/输出对账全靠它
        err.usage = { requests: (search ? 1 : 0) + 1, ...total };
        throw err;
    }
}

// 本地检索统计（向导第 1 步展示用；纯本地，不调模型）
// memoryTags 语义与 buildGuidanceMessages 相同：null 默认召回 / [] 全量 / 数组按标签 / false 不附带
// memorySheets：null = 全部（开了召回的表）；数组 = 只算勾选的表（空数组 = 一张都不带）
export function collectStats({ memoryTags = null, memorySheets = null } = {}) {
    const { chatList, hits } = collectPlanningContext();
    const memChars = memoryTags === false ? 0 : buildMemoryContext({ tagFilter: memoryTags, sheetUids: memorySheets }).length;
    return { layers: chatList.length, hits: hits.length, memChars };
}

// 记忆表格小节标题：向模型说明这批行的用途（查重/推新）与本次召回方式
function memorySectionHeader(memoryTags) {
    const mode = memoryTags == null
        ? '按记忆表格页召回标签筛选'
        : (Array.isArray(memoryTags) && memoryTags.length ? `按标签召回：${memoryTags.join('、')}` : '全量召回');
    return `## 记忆表格（已有剧情事件记录，用于检查新规划是否与之重复、并可作为推新发展方向的参考；${mode}）`;
}

// 游戏玩法小节：分析与检查报告共用同一格式（每条带名字做小标题）
function gameplaySection(items, header) {
    const list = (items ?? []).filter(i => String(i?.content ?? '').trim());
    if (!list.length) return [];
    return [header, list.map(i => `### ${String(i.name ?? '未命名')}\n${String(i.content).trim()}`).join('\n\n')];
}

// 路人反应小节：生效中的反应卡注入自动附带（分析与检查报告共用）。
// 附带的正文就是主对话提示词里逐层换段的同一份文本——规划/检查模型与主对话模型看到同一口径
function reactionSection(header) {
    const list = activeReactionInjections();
    if (!list.length) return [];
    return [header, list.map(i => String(i.content).trim()).join('\n\n')];
}

/**
 * 组装剧情指导分析要发的 system/user 两条消息（runPlotGuidance 与「查看完整提示词」预览共用）。
 * @param {object} [options]
 * @param {string} [options.userNote]            用户剧情构思/补充说明
 * @param {string} [options.previousPlan]        打回重写时：上一版规划
 * @param {string} [options.revisionNote]        打回重写时：修改意见
 * @param {string} [options.eventText]           随机事件闸口选定的事件/走向文本
 * @param {string} [options.activePlan]          进行中剧情全文（查重与进度对照）
 * @param {string[]} [options.historySummaries]  历史剧情摘要（查重用）
 * @param {Array}  [options.presets]             本次启用的预设数组（缺省取设置里启用的）
 * @param {*}      [options.memoryTags]          记忆表格召回方式：null/缺省=按记忆表格页召回标签，
 *                                               []=全量, ['a','b']=按标签, false=本次不附带
 * @param {*}      [options.memorySheets]        记忆表格表范围：null/缺省=全部（开了召回的表），
 *                                               数组=只带勾选的表（空数组=一张都不带）
 * @param {Array}  [options.storageItems]        游戏玩法条目（{name, content}）：勾选后作为
 *                                               「游戏玩法」小节发给模型，规划须在其约束内设计
 */
// 供规划分析与随机事件生成共用的材料小节（两处口径完全一致）：
// 角色摘要 / 最近对话 / 世界书命中 / 记忆表格 / 游戏玩法 / 路人反应 / 进行中剧情 / 历史摘要。
// 随机事件是向导第 2 步，材料必须与第 1 步预览同一批——各算一份必然对不上账
export function materialSections({ memoryTags = null, memorySheets = null, storageItems = [], activePlan = '', historySummaries = [] } = {}) {
    const { chatList, hits } = collectPlanningContext();
    if (!chatList.length) throw new Error('当前没有可分析的聊天记录');
    const memoryText = memoryTags === false ? '' : buildMemoryContext({ tagFilter: memoryTags, sheetUids: memorySheets });
    const summaries = (historySummaries ?? []).filter(Boolean);
    const parts = [
        '## 角色设定摘要',
        characterSummary() || '（无角色卡）',
        '## 最近对话记录',
        formatChatLog(chatList),
        '## 检索命中的世界书条目',
        buildLoreContext(hits),
        ...(memoryText ? [memorySectionHeader(memoryTags), memoryText] : []),
        ...gameplaySection(storageItems, '## 游戏玩法（当前生效的玩法规则，规划必须遵守其约束）'),
        ...reactionSection('## 路人反应（当前生效的反应卡，后续剧情安排与其扩散、收束口径一致）'),
        ...(activePlan ? ['## 进行中剧情（正在执行的规划，检查进度与重复时对照它）', activePlan] : []),
        ...(summaries.length ? ['## 历史剧情摘要（只用于查重）', summaries.map((s, i) => `${i + 1}. ${s}`).join('\n')] : []),
    ];
    return { parts, hits };
}

export function buildGuidanceMessages(options = {}) {
    const { userNote = '', previousPlan = '', revisionNote = '', eventText = '', activePlan = '', historySummaries = [], presets, memoryTags = null, memorySheets = null, storageItems = [] } = options;
    const { parts, hits } = materialSections({ memoryTags, memorySheets, storageItems, activePlan, historySummaries });
    const all = [
        ...parts,
        ...(eventText ? ['## 随机事件（本次规划需要融入的事件与走向）', eventText] : []),
        ...(previousPlan ? ['## 上一版规划（请按修改意见修订）', previousPlan] : []),
        ...(revisionNote ? ['## 修改意见', revisionNote] : []),
        ...(userNote ? ['## 用户剧情构思与补充说明', userNote] : []),
    ];
    const userContent = all.join('\n\n');

    // 逐小节精确字数（「查看完整提示词」预览展示用）：数组按「标题、正文」交替排布。
    // 统计的是字符数不是 token 估算——世界书一节偏小，说明大部分词条没被关键词带出
    const sections = [];
    for (let i = 0; i < all.length; i += 2) {
        sections.push({
            title: all[i].replace(/^## /, '').replace(/（.*$/, ''),
            chars: all[i].length + (all[i + 1]?.length ?? 0),
        });
    }

    return {
        system: withPresets(guidanceSystemPrompt(Boolean(String(activePlan ?? '').trim())), assemblePresets(presets)),
        user: userContent,
        hits: hits.length,
        sections,
    };
}

/**
 * 运行一次剧情规划分析（检查 + 设计）。参数见 buildGuidanceMessages。
 * @returns {Promise<{result: object, raw: string, hits: number}>}
 */
export async function runPlotGuidance(options = {}) {
    const { system, user, hits } = buildGuidanceMessages(options);
    const raw = await guidanceCompletion(
        [
            { role: 'system', content: system },
            { role: 'user', content: user },
        ],
        guidanceResearchInputs(options),
        { onDelta: options.onDelta, onStage: options.onStage, prefetch: options.researchPrefetch },
    );
    try {
        return { result: extractJson(raw), raw, hits };
    } catch (err) {
        err.raw = raw;   // 解析失败也把原始输出附到错误上，方便上层展示排查
        throw err;
    }
}

/**
 * 检查报告：对照进行中剧情与最近对话，输出完成度/推进/文风/OOC/其他问题/建议。
 * 当前生效的游戏玩法条目与路人反应卡自动附带（与主对话注入同一判定），检查执行情况时对照它们。
 * @param {object} [options]
 * @param {string} options.planText   进行中剧情全文
 * @param {string} [options.userNote] 补充说明
 * @param {Array}  [options.presets]  本次启用的预设（缺省取设置里启用的）
 */
export async function runStoryReview({ planText = '', userNote = '', presets, onDelta, onStage } = {}) {
    const { chatList, hits } = collectPlanningContext();
    if (!chatList.length) throw new Error('当前没有可分析的聊天记录');

    const memoryText = buildMemoryContext();

    const userContent = [
        '## 角色设定摘要',
        characterSummary() || '（无角色卡）',
        '## 正在执行的剧情规划（检查对象）',
        String(planText || '（空）'),
        '## 最近对话记录',
        formatChatLog(chatList),
        '## 检索命中的世界书条目',
        buildLoreContext(hits),
        ...(memoryText ? ['## 记忆表格（已有剧情事件记录，用于查重与推新参考；按记忆表格页召回标签筛选）', memoryText] : []),
        ...gameplaySection(storageItemsInEffect(), '## 游戏玩法（当前生效的玩法规则，检查执行情况时对照它）'),
        ...reactionSection('## 路人反应（当前生效的反应卡，检查执行情况时对照它）'),
        ...(userNote ? ['## 用户补充说明', userNote] : []),
    ].join('\n\n');

    const raw = await guidanceCompletion(
        [
            { role: 'system', content: withPresets(REVIEW_SYSTEM_PROMPT, assemblePresets(presets)) },
            { role: 'user', content: userContent },
        ],
        {
            topic: '判断检查剧情执行情况是否需要核对现实世界信息',
            userNote,
            planText: String(planText || ''),
        },
        { onDelta, onStage },
    );
    try {
        return { result: extractJson(raw), raw, hits: hits.length };
    } catch (err) {
        err.raw = raw;
        throw err;
    }
}
