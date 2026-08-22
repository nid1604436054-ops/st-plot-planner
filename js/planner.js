// M2 剧情指导：OOC 检测 + 剧情规划（隐藏剧本）
// 与 M3 共用「上下文收集 + 世界书检索 + 独立 API」管线，全程不碰主对话连接
import { chatCompletion } from "./api.js";
import { collectRecentChat, formatChatLog, characterSummary } from "./context.js";
import { scanLorebooks, buildLoreContext } from "./lorebook.js";
import { buildMemoryContext } from "./memoryTable.js";
import { settings } from "./settings.js";
import { extractJson } from "./utils.js";

const OUTPUT_SCHEMA = `{
  "ooc": {
    "found": true,
    "items": [
      { "aspect": "性格|事实|关系|世界观|口吻", "evidence": "对话中的具体依据", "severity": "轻微|中等|严重", "fix": "修正建议" }
    ]
  },
  "plan": {
    "summary": "一句话概括接下来的走向",
    "beats": [
      { "stage": "阶段名", "content": "该阶段的幕后剧情安排（不出现在对话文本中）" }
    ],
    "risks": ["可能跑偏的点"]
  }
}`;

// 内置指令：保证返回 JSON（程序要解析成 OOC + 规划），用户预设追加在其后，见 runPlotGuidance
export const GUIDANCE_SYSTEM_PROMPT = [
    '你是文字角色扮演的剧情顾问，负责两件事：',
    '1) 结合角色设定与世界书条目，判断最近对话是否存在 OOC（脱离人设、事实、关系或世界观）；',
    '2) 为后续剧情规划「隐藏剧本」——只作为幕后指导的剧情安排，不会以对话形式呈现给用户。',
    '要求：OOC 判断必须引用对话依据；规划要具体、可执行、尊重既有设定；面向当前场景做预编排。',
    '只输出一个符合如下结构的 JSON 对象，不要输出 JSON 以外的任何文字：',
    OUTPUT_SCHEMA,
].join('\n');

/**
 * 运行一次剧情指导分析。
 * @param {object} [options]
 * @param {string} [options.userNote]       用户补充说明（本次规划的关注点/约束）
 * @param {string} [options.previousPlan]   迭代时：上一版规划（当前编辑框内容）
 * @param {string} [options.revisionNote]   迭代时：修改意见
 * @returns {Promise<{result: object, raw: string, hits: number}>}
 */
export async function runPlotGuidance({ userNote = '', previousPlan = '', revisionNote = '' } = {}) {
    const chatList = collectRecentChat(settings.retrieval.contextLayers);
    if (!chatList.length) throw new Error('当前没有可分析的聊天记录');

    const scanText = formatChatLog(chatList.slice(-settings.retrieval.scanDepth));
    const hits = scanLorebooks(scanText);
    const memoryText = buildMemoryContext();

    // 用户预设（格式/文风等固定要求）追加在内置指令后；JSON 输出格式不能被预设改掉，否则解析会失败
    const custom = (settings.guidance?.customPrompt ?? '').trim();
    const systemPrompt = custom
        ? `${GUIDANCE_SYSTEM_PROMPT}\n\n## 用户固定要求（在不改变上述 JSON 输出格式的前提下遵照执行）\n${custom}`
        : GUIDANCE_SYSTEM_PROMPT;

    const userContent = [
        '## 角色设定摘要',
        characterSummary() || '（无角色卡）',
        '## 最近对话记录',
        formatChatLog(chatList),
        '## 检索命中的世界书条目',
        buildLoreContext(hits),
        ...(memoryText ? ['## 记忆表格（已按标签筛选，未删除的行）', memoryText] : []),
        ...(previousPlan ? ['## 上一版规划（请按修改意见修订）', previousPlan] : []),
        ...(revisionNote ? ['## 修改意见', revisionNote] : []),
        ...(userNote ? ['## 用户补充说明', userNote] : []),
    ].join('\n\n');

    const raw = await chatCompletion({
        messages: [
            { role: 'system', content: GUIDANCE_SYSTEM_PROMPT },
            { role: 'user', content: userContent },
        ],
    });
    return { result: extractJson(raw), raw, hits: hits.length };
}

// 密封注入内容生成：给模型一段幕后设定（如对手手牌），调用方不展示给用户（开发方案 §M4）
export async function generateSealedContent(instruction) {
    const chatList = collectRecentChat(settings.retrieval.contextLayers);
    const scanText = formatChatLog(chatList.slice(-settings.retrieval.scanDepth));
    const loreText = buildLoreContext(scanLorebooks(scanText));

    const raw = await chatCompletion({
        messages: [
            {
                role: 'system',
                content: '你是角色扮演的幕后设定生成器。根据指令与上下文生成一段仅供扮演模型私下参考的设定文本'
                    + '（例如隐藏身份、暗牌、未公开的动机或事实）。直接输出设定内容本身：不要标题、不要解释、不要 JSON。'
                    + '内容需自包含、具体、可直接作为后续扮演的依据。',
            },
            {
                role: 'user',
                content: [
                    '## 生成指令',
                    String(instruction),
                    '## 最近对话',
                    formatChatLog(chatList),
                    '## 世界书命中',
                    loreText,
                ].join('\n\n'),
            },
        ],
    });
    return raw.trim();
}
