// 材料小节构建（自 planner.js 抽出）：规划分析 / 检查报告 / 随机事件 / 路人反应共用同一批
// 材料小节——「查看完整提示词」预览与各模型调用之间口径一致，才能互相对账。
// 依赖方向约束：本模块不得 import planner.js / injection.js / reactions.js（reactions.js
// 反向依赖本模块拿材料，而 planner.js → injection.js → reactions.js 已成链，再回指会成环）。
// 「路人反应」小节因此不在这里，由 planner.js 在外层插入（见 planner.materialSections）。
import { collectPlanningContext, formatChatLog, characterSummary } from "./context.js";
import { buildLoreContext } from "./lorebook.js";
import { buildMemoryContext, memoryState } from "./memoryTable.js";
import { loadChatData, saveChatData } from "./chatdata.js";

// 档位统计（记忆小节标题的口径文字用）：与 buildMemoryContext 同一集合——
// 开了「参与召回」的镜像表按 sheetModes 数档，没进映射的表算常驻
function sheetModeCounts(sheetModes) {
    const state = memoryState();
    const counts = { always: 0, tags: 0, off: 0 };
    for (const s of state.mirror.sheets) {
        if ((state.sheetRecall[s.uid] ?? {}).enabled === false) continue;
        counts[sheetModes[s.uid] ?? 'always']++;
    }
    return counts;
}

// 记忆表格小节标题：向模型说明这批行的用途与本次召回方式（规划查重 / 路人反应背景各有口径）。
// 带档位时写明「常驻 N 表全量 · 按标签 M 表（…）· 停用 K 表」——模型需要知道哪些行是
// 无视标签全量来的、哪些行是表尾最新补底（recent > 0 时注明，那是刚发生的近期事件）
export function memorySectionHeader(memoryTags, purpose = '已有剧情事件记录，用于检查新规划是否与之重复、并可作为推新发展方向的参考', recent = 0, sheetModes = null) {
    let mode;
    if (sheetModes) {
        const c = sheetModeCounts(sheetModes);
        const tagSide = !Array.isArray(memoryTags) || !memoryTags.length
            ? (recent ? `未勾标签，只带每表最新 ${recent} 行` : '未勾标签，这些表本次不带')
            : `按标签召回：${memoryTags.join('、')}${recent ? `，无论标签另附每表最新 ${recent} 行` : ''}`;
        mode = [
            c.always ? `常驻 ${c.always} 表全量` : '',
            c.tags ? `按标签 ${c.tags} 表（${tagSide}）` : '',
            c.off ? `停用 ${c.off} 表` : '',
        ].filter(Boolean).join('，') || '全部停用';
    } else {
        mode = memoryTags == null
            ? '按记忆表格页召回标签筛选'
            : (Array.isArray(memoryTags) && memoryTags.length ? `按标签召回：${memoryTags.join('、')}` : '全量召回');
        if (recent > 0 && Array.isArray(memoryTags) && memoryTags.length) mode += `，无论标签另附每表最新 ${recent} 行`;
    }
    return `## 记忆表格（${purpose}；${mode}）`;
}

// 游戏玩法小节：各调用方共用同一格式（每条带名字做小标题）
export function gameplaySection(items, header) {
    const list = (items ?? []).filter(i => String(i?.content ?? '').trim());
    if (!list.length) return [];
    return [header, list.map(i => `### ${String(i.name ?? '未命名')}\n${String(i.content).trim()}`).join('\n\n')];
}

// 用户预设已全局化（应用户要求：发给大模型的任何调用都带上）：拼装与注入统一在
// api.js（globalPresetBlock / withGlobalPresets，chatCompletion 出口自动附加），
// 本模块与各调用方不再经手预设

// 反应卡自己的材料勾选（chatdata.js 的 reaction 块，按对话存）——
// 独立于向导第 1 步的勾选（picks 块管规划分析），两边互不影响：
//   books     null = 沿用本对话「世界书」页的启用书单；数组 = 本批独立书单（String id）
//   memSheets 勾选的记忆表 uid（空 = 不附带记忆；反应卡不做标签层，勾了全量）
//   gpIds     null = 附带当前生效中的玩法条目；数组 = 本批勾选（空 = 不附带）
//   plan      是否附带进行中剧情（默认 true）
//   （历史数据里的 presetIds 字段已随预设全局化退役，读回时直接忽略）
export function reactionPicks() {
    const p = loadChatData('reaction', () => ({ version: 1 }));
    return {
        books: Array.isArray(p?.books) ? p.books.map(String) : null,
        memSheets: Array.isArray(p?.memSheets) ? p.memSheets : [],
        gpIds: Array.isArray(p?.gpIds) ? p.gpIds : null,
        plan: p ? p.plan !== false : true,
    };
}

export function saveReactionPicks(picks) {
    saveChatData('reaction', { version: 1, ...picks });
}

/**
 * 组装共用的材料小节：角色摘要 / 最近对话 / 世界书命中 / 记忆表格 / 游戏玩法 / 进行中剧情 / 历史摘要。
 * 各小节标题带用途说明；调用方用途不同时可用 headers 覆写对应小节的口径文字。
 * 记忆行行尾自带标签（buildMemoryContext），同标签同类事件的防复刻由规划系统提示词一句话约束，不做专门功能
 * @param {*}      [options.memoryTags]        记忆表格召回方式：null=按记忆表格页召回标签,
 *                                             []/['a','b']=按标签, false=本次不附带（带 memoryModes
 *                                             时标签只作用于「标签」档的表）
 * @param {*}      [options.memorySheets]      记忆表格表范围：null=全部（开了召回的表），数组=只带勾选的表（空数组=不带）
 * @param {object} [options.memoryModes]       每表召回档位 { [uid]: 'off' 停用 | 'tags' 按标签 | 'always' 常驻全量 }；
 *                                             传了它档位优先（memorySheets 让位），常驻表无视标签全量、
 *                                             停用表整张不带、标签档只带命中行（没勾标签时只走最新窗口）
 * @param {number} [options.memoryRecent]      「标签」档每表无论标签都另附的表尾最新行数；0=不另附
 *                                             （常驻档全量已含全部行，本项无意义）
 * @param {Array}  [options.storageItems]      游戏玩法条目（{name, content}）
 * @param {string} [options.activePlan]        进行中剧情全文
 * @param {string[]} [options.historySummaries] 历史剧情摘要（查重用）
 * @param {object} [options.headers]           小节标题覆写：{ memoryPurpose, gameplay, activePlan }
 * @param {string[]} [options.enabledIds]      世界书书单覆盖（缺省 = 本对话启用的书单）
 */
export function materialSections({ memoryTags = null, memorySheets = null, memoryModes = null, memoryRecent = 0, storageItems = [], activePlan = '', historySummaries = [], headers = {}, enabledIds } = {}) {
    const { chatList, hits } = collectPlanningContext({ enabledIds });
    if (!chatList.length) throw new Error('当前没有可分析的聊天记录');
    const memoryText = memoryTags === false ? '' : buildMemoryContext({ tagFilter: memoryTags, sheetUids: memorySheets, sheetModes: memoryModes, latestPerSheet: memoryRecent });
    const summaries = (historySummaries ?? []).filter(Boolean);
    const parts = [
        '## 角色设定摘要',
        characterSummary() || '（无角色卡）',
        '## 最近对话记录',
        formatChatLog(chatList),
        '## 检索命中的世界书条目',
        buildLoreContext(hits),
        ...(memoryText ? [memorySectionHeader(memoryTags, headers.memoryPurpose, memoryRecent, memoryModes), memoryText] : []),
        ...gameplaySection(storageItems, headers.gameplay ?? '## 游戏玩法（当前生效的玩法规则，规划必须遵守其约束）'),
        ...(activePlan ? [headers.activePlan ?? '## 进行中剧情（正在执行的规划，检查进度与重复时对照它）', activePlan] : []),
        ...(summaries.length ? ['## 历史剧情摘要（只用于查重）', summaries.map((s, i) => `${i + 1}. ${s}`).join('\n')] : []),
    ];
    return { parts, hits };
}
