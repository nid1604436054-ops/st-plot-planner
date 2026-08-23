// M2 剧情指导：检查（OOC/剧情重复/文风重复/进度）+ 剧情规划（隐藏剧本）+ 检查报告
// 与 M3 共用「上下文收集 + 世界书检索 + 独立 API」管线，全程不碰主对话连接
import { chatCompletion, chatCompletionWithTools, searchToolReady } from "./api.js";
import { collectRecentChat, formatChatLog, characterSummary } from "./context.js";
import { scanLorebooks, buildLoreContext } from "./lorebook.js";
import { buildMemoryContext } from "./memoryTable.js";
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
    '只输出一个符合如下结构的 JSON 对象，不要输出 JSON 以外的任何文字：',
    REVIEW_SCHEMA,
].join('\n');

// 用户预设（格式/文风等固定要求）拼装：显式传入列表时按传入的来（向导的本次勾选），
// 缺省取设置里启用的；按列表顺序拼成带名小节。JSON 输出格式不能被预设改掉，否则解析会失败
function assemblePresets(presets) {
    const src = Array.isArray(presets) ? presets : (settings.guidance?.presets ?? []).filter(p => p.enabled);
    return src
        .filter(p => String(p.content ?? '').trim())
        .map(p => `### ${p.name}\n${String(p.content).trim()}`)
        .join('\n\n');
}

function withPresets(base, custom) {
    return custom ? `${base}\n\n## 用户固定要求（在不改变上述 JSON 输出格式的前提下遵照执行）\n${custom}` : base;
}

// 剧情分析 / 检查报告的统一出口：搜索工具配置齐且开启时，把 web_search 交给模型自主调用
// （并提示它什么情况该搜）；端点不支持 tools 参数时由 chatCompletionWithTools 自动降级为普通请求
async function guidanceCompletion(messages) {
    if (!(settings.search?.toolMode && searchToolReady())) return chatCompletion({ messages });
    const SEARCH_HINT = '\n\n## 联网搜索\n你可以调用 web_search 工具检索现实世界的真实信息：'
        + '涉及现实事实、时效性内容（近期事件、数据、新闻）或你不确定的现实细节时，先搜索再下结论；纯虚构设定不要搜索。'
        + '搜索结果仅供参考，最终仍只输出上面规定的 JSON，不要输出 JSON 以外的任何文字。';
    const { content, searchLogs } = await chatCompletionWithTools({
        messages: messages.map(m => (m.role === 'system' ? { ...m, content: m.content + SEARCH_HINT } : m)),
    });
    if (searchLogs.length) toastr.info(`模型自主联网检索了：${searchLogs.join('；')}`);
    return content;
}

// 本地检索统计（向导第 1 步展示用；纯本地，不调模型）
// memoryTags 语义与 buildGuidanceMessages 相同：null 默认召回 / [] 全量 / 数组按标签 / false 不附带
// memorySheets：null = 全部（开了召回的表）；数组 = 只算勾选的表（空数组 = 一张都不带）
export function collectStats({ memoryTags = null, memorySheets = null } = {}) {
    const chatList = collectRecentChat(settings.retrieval.contextLayers);
    const hits = scanLorebooks(formatChatLog(chatList.slice(-settings.retrieval.scanDepth)));
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
 */
export function buildGuidanceMessages(options = {}) {
    const { userNote = '', previousPlan = '', revisionNote = '', eventText = '', activePlan = '', historySummaries = [], presets, memoryTags = null, memorySheets = null } = options;
    const chatList = collectRecentChat(settings.retrieval.contextLayers);
    if (!chatList.length) throw new Error('当前没有可分析的聊天记录');

    const scanText = formatChatLog(chatList.slice(-settings.retrieval.scanDepth));
    const hits = scanLorebooks(scanText);
    const memoryText = memoryTags === false ? '' : buildMemoryContext({ tagFilter: memoryTags, sheetUids: memorySheets });

    const summaries = (historySummaries ?? []).filter(Boolean);
    const userContent = [
        '## 角色设定摘要',
        characterSummary() || '（无角色卡）',
        '## 最近对话记录',
        formatChatLog(chatList),
        '## 检索命中的世界书条目',
        buildLoreContext(hits),
        ...(memoryText ? [memorySectionHeader(memoryTags), memoryText] : []),
        ...(activePlan ? ['## 进行中剧情（正在执行的规划，检查进度与重复时对照它）', activePlan] : []),
        ...(summaries.length ? ['## 历史剧情摘要（只用于查重）', summaries.map((s, i) => `${i + 1}. ${s}`).join('\n')] : []),
        ...(eventText ? ['## 随机事件（本次规划需要融入的事件与走向）', eventText] : []),
        ...(previousPlan ? ['## 上一版规划（请按修改意见修订）', previousPlan] : []),
        ...(revisionNote ? ['## 修改意见', revisionNote] : []),
        ...(userNote ? ['## 用户剧情构思与补充说明', userNote] : ''),
    ].join('\n\n');

    return {
        system: withPresets(GUIDANCE_SYSTEM_PROMPT, assemblePresets(presets)),
        user: userContent,
        hits: hits.length,
    };
}

/**
 * 运行一次剧情规划分析（检查 + 设计）。参数见 buildGuidanceMessages。
 * @returns {Promise<{result: object, raw: string, hits: number}>}
 */
export async function runPlotGuidance(options = {}) {
    const { system, user, hits } = buildGuidanceMessages(options);
    const raw = await guidanceCompletion([
        { role: 'system', content: system },
        { role: 'user', content: user },
    ]);
    return { result: extractJson(raw), raw, hits };
}

/**
 * 检查报告：对照进行中剧情与最近对话，输出完成度/推进/文风/OOC/其他问题/建议。
 * @param {object} [options]
 * @param {string} options.planText   进行中剧情全文
 * @param {string} [options.userNote] 补充说明
 * @param {Array}  [options.presets]  本次启用的预设（缺省取设置里启用的）
 */
export async function runStoryReview({ planText = '', userNote = '', presets } = {}) {
    const chatList = collectRecentChat(settings.retrieval.contextLayers);
    if (!chatList.length) throw new Error('当前没有可分析的聊天记录');

    const scanText = formatChatLog(chatList.slice(-settings.retrieval.scanDepth));
    const hits = scanLorebooks(scanText);
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
        ...(userNote ? ['## 用户补充说明', userNote] : []),
    ].join('\n\n');

    const raw = await guidanceCompletion([
        { role: 'system', content: withPresets(REVIEW_SYSTEM_PROMPT, assemblePresets(presets)) },
        { role: 'user', content: userContent },
    ]);
    return { result: extractJson(raw), raw, hits: hits.length };
}
