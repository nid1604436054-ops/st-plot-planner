// M2 剧情指导：检查（OOC/剧情重复/文风重复/进度）+ 剧情规划（隐藏剧本）+ 检查报告
// 与 M3 共用「上下文收集 + 世界书检索 + 独立 API」管线，全程不碰主对话连接
import { chatCompletion, chatCompletionWithTools, searchToolReady } from "./api.js";
import { collectPlanningContext, formatChatLog, characterSummary } from "./context.js";
import { buildLoreContext } from "./lorebook.js";
import { buildMemoryContext } from "./memoryTable.js";
import { storageItemsInEffect } from "./store.js";
import { activeReactionInjections } from "./injection.js";
import { settings } from "./settings.js";
import { extractJson } from "./utils.js";

const OUTPUT_SCHEMA = `{
  "checks": {
    "ooc": {
      "found": false,
      "items": [
        { "aspect": "性格|事实|关系|世界观|口吻", "evidence": "对话中的具体依据", "severity": "轻微|中等|严重", "fix": "修正建议" }
      ]
    },
    "plotRepeat": { "found": false, "note": "与进行中/历史剧情重复雷同之处；没有则空字符串" },
    "styleRepeat": { "level": "无|轻微|明显", "note": "仅判 char 的自发重复：user 是否先重复、char 重复了什么" },
    "progress": { "stage": "进行中剧情推进到哪个阶段（无进行中剧情写「无」）", "pct": "约x%或「无」", "note": "判断依据" }
  },
  "plan": {
    "summary": "一句话概括接下来的走向",
    "beats": [
      { "stage": "阶段名", "content": "该阶段的幕后剧情安排（不出现在对话文本中）" }
    ],
    "risks": ["可能跑偏的点"]
  }
}`;

// 内置指令：保证返回 JSON（程序要解析成检查项 + 规划），用户预设追加在其后，见 assemblePresets
export const GUIDANCE_SYSTEM_PROMPT = [
    '你是文字角色扮演的剧情顾问，负责两件事：',
    '1) 检查：结合角色设定与世界书条目，判断最近对话是否存在 OOC（脱离人设、事实、关系或世界观）、是否与已有剧情重复、文风是否重复、正在执行的剧情推进到什么程度；',
    '2) 规划：为后续剧情设计「隐藏剧本」——只作为幕后指导的剧情安排，不会以对话形式呈现给用户。',
    '要求：判断必须引用对话依据；给出「进行中剧情」时对照它检查进度与重复；给了「随机事件」就将其自然融入规划；规划要具体、可执行、尊重既有设定；面向当前场景做预编排。',
    '文风重复的判定基准：只针对角色（char）的扮演文本——先检查用户（user）近期输入是否自己在重复动作、场景或指令；角色只是跟进用户发起的重复不算文风重复；只有用户没有重复而角色自发重复描写套路、桥段或句式时，才判「轻微/明显」，并在 note 里写明用户是否先重复、角色重复了什么。',
    '字符串值里不要出现英文双引号（引用一律写中文「」），也不要在值内换行。',
    '只输出一个符合如下结构的 JSON 对象，不要输出 JSON 以外的任何文字：',
    OUTPUT_SCHEMA,
].join('\n');

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
// researchReqs：检索助手阶段发掉的轻量请求数（每份只有千字简报，不含全套材料）
function billToast(usage, searchLogs = [], researchReqs = 0) {
    const parts = [];
    if (researchReqs > 0) parts.push(`联网检索 ${researchReqs} 次轻量请求（只发剧情简报，全套材料只发 1 次）`);
    if (usage?.promptTokens) parts.push(`合计输入 ${usage.promptTokens.toLocaleString()} · 输出 ${usage.completionTokens.toLocaleString()} tokens（服务商实报）`);
    if (searchLogs.length) parts.push(`模型检索了：${searchLogs.join('；')}`);
    if (parts.length) toastr.info(parts.join('；'));
}

// 检索助手的系统提示词：搜索是独立子调用，模型只在这一小份上下文里决定搜什么、汇总成纪要。
// 全套材料不进入工具循环——tools 协议要求每轮把 messages 原样重发，材料进去就是按轮数翻倍计费
const RESEARCH_SYSTEM_PROMPT = [
    '你是联网检索助手。用户正在为一篇文字角色扮演作品做剧情规划/执行检查，会给你一份浓缩的剧情背景简报。',
    '判断这份工作可能需要哪些现实世界的真实信息（时代背景、地域、行业、物品、机构、法规、近况、数据等），需要就调用 web_search 工具检索；纯虚构设定不要检索，与剧情无关的信息不要凑数。',
    '检索完成后输出一份纪要供规划模型使用：Markdown 列表，每条一句话并附来源网址，总共不超过 300 字；没有值得检索的内容或检索无所得时只写「（无补充）」。',
    '不要输出纪要以外的任何文字。',
].join('\n');

/**
 * 检索简报：给检索助手的浓缩版剧情背景（千字级），字段与 buildGuidanceMessages 同源但全部截短。
 * 工具循环每轮重发的是这份小简报而不是全套材料——搜索计费从「材料规模 × 请求次数」
 * 降回「材料 1 次 + 简报 × 次数」全靠它
 */
export function buildResearchBrief({ topic = '', userNote = '', eventText = '', activePlan = '', historySummaries = [], planText = '' } = {}) {
    const clip = (s, n) => String(s ?? '').trim().slice(0, n);
    const plan = clip(planText || activePlan, 500);
    const summaries = (historySummaries ?? []).filter(Boolean).join(' / ');
    const chatTail = formatChatLog(collectPlanningContext().chatList.slice(-6)).slice(-800);
    return [
        `## 检索任务\n${clip(topic, 120) || '为接下来的剧情规划收集现实世界背景信息'}`,
        `## 角色设定摘要\n${clip(characterSummary(200), 200) || '（无角色卡）'}`,
        plan ? `## 进行中剧情（节选）\n${plan}` : '',
        summaries ? `## 历史剧情摘要\n${clip(summaries, 300)}` : '',
        eventText ? `## 本次随机事件（节选）\n${clip(eventText, 200)}` : '',
        userNote ? `## 用户构思与要求\n${clip(userNote, 400)}` : '',
        chatTail ? `## 最近对话节选\n${chatTail}` : '',
    ].filter(Boolean).join('\n\n');
}

/**
 * 联网检索子调用：千字简报 + web_search 工具循环，产出一份检索纪要。
 * 检索轮次上限 2（含收尾至多 4 次轻量请求）；端点不支持 tools 参数时自动降级为不检索直接作答
 * @returns {Promise<{notes:string, searchLogs:string[], usage:object}>}
 */
export async function runWebResearch(research = {}) {
    const { content, searchLogs, usage } = await chatCompletionWithTools({
        messages: [
            { role: 'system', content: RESEARCH_SYSTEM_PROMPT },
            { role: 'user', content: buildResearchBrief(research) },
        ],
        maxToolRounds: 2,
    });
    return { notes: String(content ?? '').trim(), searchLogs, usage };
}

// 剧情分析 / 检查报告的统一出口。搜索开着时拆成两段：
// ① 检索助手——只有千字简报进工具循环，搜几轮重发的都是这份小简报；
// ② 正式分析——全套材料只发这一次（不带工具），纪要作为附加小节带进去。
// 检索失败不拦分析：警告一声继续（已产生的检索计费照实累计上报）
async function guidanceCompletion(messages, research = {}) {
    const total = { promptTokens: 0, completionTokens: 0 };
    const add = u => {
        total.promptTokens += u?.promptTokens ?? u?.prompt_tokens ?? 0;
        total.completionTokens += u?.completionTokens ?? u?.completion_tokens ?? 0;
    };
    let searchLogs = [];
    let researchReqs = 0;
    let notes = '';

    if (settings.search?.toolMode && searchToolReady()) {
        try {
            const r = await runWebResearch(research);
            add(r.usage);
            researchReqs = r.usage?.requests ?? 0;
            searchLogs = r.searchLogs ?? [];
            notes = r.notes;
        } catch (err) {
            if (err.name === 'AbortError') throw err;
            add(err.usage);   // 检索阶段失败也可能已产生计费（如空内容报错），照实累计
            toastr.warning(`联网检索失败，跳过检索继续分析：${err.message}`);
        }
    }

    const withNotes = notes && !/^（无补充）/.test(notes)
        ? messages.map(m => (m.role === 'user'
            ? { ...m, content: `${m.content}\n\n## 联网检索纪要（检索助手联网查到的现实信息，仅供参考）\n${notes}` }
            : m))
        : messages;

    try {
        const text = await chatCompletion({ messages: withNotes, onUsage: add });
        billToast(total, searchLogs, researchReqs);
        return text;
    } catch (err) {
        billToast(total, searchLogs, researchReqs);   // 失败也要报真实账单：空内容报错时的输入/输出对账全靠它
        err.usage = { requests: researchReqs + 1, ...total };
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
        system: withPresets(GUIDANCE_SYSTEM_PROMPT, assemblePresets(presets)),
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
        {
            topic: '为接下来的剧情规划收集需要的现实世界背景信息',
            userNote: options.userNote ?? '',
            eventText: options.eventText ?? '',
            activePlan: options.activePlan ?? '',
            historySummaries: options.historySummaries ?? [],
        },
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
export async function runStoryReview({ planText = '', userNote = '', presets } = {}) {
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
            topic: '检查剧情执行情况时，核对剧情涉及的现实世界信息',
            userNote,
            planText: String(planText || ''),
        },
    );
    try {
        return { result: extractJson(raw), raw, hits: hits.length };
    } catch (err) {
        err.raw = raw;
        throw err;
    }
}
