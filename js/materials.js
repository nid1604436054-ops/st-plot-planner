// 材料小节构建（自 planner.js 抽出）：规划分析 / 检查报告 / 随机事件 / 路人反应共用同一批
// 材料小节——「查看完整提示词」预览与各模型调用之间口径一致，才能互相对账。
// 依赖方向约束：本模块不得 import planner.js / injection.js / reactions.js（reactions.js
// 反向依赖本模块拿材料，而 planner.js → injection.js → reactions.js 已成链，再回指会成环）。
// 「路人反应」小节因此不在这里，由 planner.js 在外层插入（见 planner.materialSections）。
import { collectPlanningContext, formatChatLog, characterSummary, chatMeta, persistChat } from "./context.js";
import { buildLoreContext } from "./lorebook.js";
import { buildMemoryContext, buildRepeatGuardContext } from "./memoryTable.js";
import { settings } from "./settings.js";

// 记忆表格小节标题：向模型说明这批行的用途与本次召回方式（规划查重 / 路人反应背景各有口径）
export function memorySectionHeader(memoryTags, purpose = '已有剧情事件记录，用于检查新规划是否与之重复、并可作为推新发展方向的参考') {
    const mode = memoryTags == null
        ? '按记忆表格页召回标签筛选'
        : (Array.isArray(memoryTags) && memoryTags.length ? `按标签召回：${memoryTags.join('、')}` : '全量召回');
    return `## 记忆表格（${purpose}；${mode}）`;
}

// 游戏玩法小节：各调用方共用同一格式（每条带名字做小标题）
export function gameplaySection(items, header) {
    const list = (items ?? []).filter(i => String(i?.content ?? '').trim());
    if (!list.length) return [];
    return [header, list.map(i => `### ${String(i.name ?? '未命名')}\n${String(i.content).trim()}`).join('\n\n')];
}

// 用户预设（格式/文风等固定要求）拼装：显式传入列表时按传入的来（向导/路人反应的本次勾选），
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

// 反应卡自己的材料勾选（chatMetadata.plotPlannerReactionPicks，按对话存聊天文件）——
// 独立于向导第 1 步的勾选（plotPlannerPicks 管规划分析），两边互不影响：
//   books     null = 沿用本对话「世界书」页的启用书单；数组 = 本批独立书单（String id）
//   memSheets 勾选的记忆表 uid（空 = 不附带记忆；反应卡不做标签层，勾了全量）
//   gpIds     null = 附带当前生效中的玩法条目；数组 = 本批勾选（空 = 不附带）
//   presetIds null = 附带启用中的预设；数组 = 本批勾选（空 = 不附带）
//   plan      是否附带进行中剧情（默认 true）
export function reactionPicks() {
    const p = chatMeta().plotPlannerReactionPicks;
    return {
        books: Array.isArray(p?.books) ? p.books.map(String) : null,
        memSheets: Array.isArray(p?.memSheets) ? p.memSheets : [],
        gpIds: Array.isArray(p?.gpIds) ? p.gpIds : null,
        presetIds: Array.isArray(p?.presetIds) ? p.presetIds : null,
        plan: p ? p.plan !== false : true,
    };
}

export function saveReactionPicks(picks) {
    chatMeta().plotPlannerReactionPicks = { version: 1, ...picks };
    persistChat();
}

/**
 * 组装共用的材料小节：角色摘要 / 最近对话 / 世界书命中 / 记忆表格 / 已发生的同类事件 / 游戏玩法 / 进行中剧情 / 历史摘要。
 * 各小节标题带用途说明；调用方用途不同时可用 headers 覆写对应小节的口径文字。
 * @param {*}      [options.memoryTags]        记忆表格召回方式：null=按记忆表格页召回标签，
 *                                             []=全量, ['a','b']=按标签, false=本次不附带
 * @param {*}      [options.memorySheets]      记忆表格表范围：null=全部（开了召回的表），数组=只带勾选的表（空数组=不带）
 * @param {boolean} [options.repeatGuard]      是否附带「已发生的同类事件」防重复小节（词表里标了
 *                                             防重复的标签→带这些标签的行自动附上，要求新规划避免流程雷同）。
 *                                             规划分析与随机事件开（planner.materialSections 统一开），反应卡不开
 * @param {Array}  [options.storageItems]      游戏玩法条目（{name, content}）
 * @param {string} [options.activePlan]        进行中剧情全文
 * @param {string[]} [options.historySummaries] 历史剧情摘要（查重用）
 * @param {object} [options.headers]           小节标题覆写：{ memoryPurpose, gameplay, activePlan }
 * @param {string[]} [options.enabledIds]      世界书书单覆盖（缺省 = 本对话启用的书单）
 */
export function materialSections({ memoryTags = null, memorySheets = null, repeatGuard = false, storageItems = [], activePlan = '', historySummaries = [], headers = {}, enabledIds } = {}) {
    const { chatList, hits } = collectPlanningContext({ enabledIds });
    if (!chatList.length) throw new Error('当前没有可分析的聊天记录');
    const memoryText = memoryTags === false ? '' : buildMemoryContext({ tagFilter: memoryTags, sheetUids: memorySheets });
    const guard = repeatGuard ? buildRepeatGuardContext() : { text: '', rows: 0 };
    const summaries = (historySummaries ?? []).filter(Boolean);
    const parts = [
        '## 角色设定摘要',
        characterSummary() || '（无角色卡）',
        '## 最近对话记录',
        formatChatLog(chatList),
        '## 检索命中的世界书条目',
        buildLoreContext(hits),
        ...(memoryText ? [memorySectionHeader(memoryTags, headers.memoryPurpose), memoryText] : []),
        ...(guard.rows ? ['## 已发生的同类事件（防重复：这些同类事件已经写过，新规划不要再复刻其流程与桥段——可以再安排同类型事件，但过程、重点或走向必须有明显新意）', guard.text] : []),
        ...gameplaySection(storageItems, headers.gameplay ?? '## 游戏玩法（当前生效的玩法规则，规划必须遵守其约束）'),
        ...(activePlan ? [headers.activePlan ?? '## 进行中剧情（正在执行的规划，检查进度与重复时对照它）', activePlan] : []),
        ...(summaries.length ? ['## 历史剧情摘要（只用于查重）', summaries.map((s, i) => `${i + 1}. ${s}`).join('\n')] : []),
    ];
    return { parts, hits };
}
