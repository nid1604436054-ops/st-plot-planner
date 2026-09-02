// 材料小节构建（自 planner.js 抽出）：规划分析 / 检查报告 / 随机事件 / 路人反应共用同一批
// 材料小节——「查看完整提示词」预览与各模型调用之间口径一致，才能互相对账。
// 依赖方向约束：本模块不得 import planner.js / injection.js / reactions.js（reactions.js
// 反向依赖本模块拿材料，而 planner.js → injection.js → reactions.js 已成链，再回指会成环）。
// 「路人反应」小节因此不在这里，由 planner.js 在外层插入（见 planner.materialSections）。
import { collectPlanningContext, formatChatLog, characterSummary } from "./context.js";
import { buildLoreContext, resolveLorePicks } from "./lorebook.js";
import { buildMemoryContext, memoryState } from "./memoryTable.js";

// 档位统计（记忆小节标题的口径文字用）：与 buildMemoryContext 同一集合——
// 镜像表按 sheetModes 数档，没进映射的表算常驻
function sheetModeCounts(sheetModes) {
    const state = memoryState();
    const counts = { always: 0, tags: 0, off: 0 };
    for (const s of state.mirror.sheets) {
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
        mode = Array.isArray(memoryTags) && memoryTags.length ? `按标签召回：${memoryTags.join('、')}` : '全量召回';
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

// 反应卡自己的「材料勾选」（chatdata 的 reaction 块）已退役：反应卡生成并进向导第 1 步，
// 与规划分析共用同一批材料（见 reactions.js / tab-guidance.js）；旧聊天数据里的 reaction 块
// 不再读写，留着无害

/**
 * 组装共用的材料小节（第十三轮排序：稳定在前、开头会变的垫底）：角色摘要 / 自选世界书 /
 * 游戏玩法 / 记忆表格 / 进行中剧情 / 历史剧情摘要 / 检索命中世界书 / 最近对话记录。
 * 各小节标题带用途说明；调用方用途不同时可用 headers 覆写对应小节的口径文字。
 * 记忆行行尾自带标签（buildMemoryContext），同标签同类事件的防复刻由规划系统提示词一句话约束，不做专门功能
 * @param {*}      [options.memoryTags]        记忆表格召回方式：null/[]=全量（带 memoryModes 时
 *                                             标签只作用于「标签」档的表）, ['a','b']=按标签,
 *                                             false=本次不附带
 * @param {*}      [options.memorySheets]      记忆表格表范围：null=全部（开了召回的表），数组=只带勾选的表（空数组=不带）
 * @param {object} [options.memoryModes]       每表召回档位 { [uid]: 'off' 停用 | 'tags' 按标签 | 'always' 常驻全量 }；
 *                                             传了它档位优先（memorySheets 让位），常驻表无视标签全量、
 *                                             停用表整张不带、标签档只带命中行（没勾标签时只走最新窗口）
 * @param {number} [options.memoryRecent]      「标签」档每表无论标签都另附的表尾最新行数；0=不另附
 *                                             （常驻档全量已含全部行，本项无意义）
 * @param {Array}  [options.storageItems]      游戏玩法条目（{name, content}）
 * @param {string} [options.activePlan]        进行中剧情全文
 * @param {string[]} [options.historySummaries] 历史剧情摘要（查重用）
 * @param {string[]} [options.lorePicks]       世界书自选勾选键（「bookId:uid」，第七轮 §6.10）：
 *                                             勾中的条目整条原文随行成「自选世界书条目」小节，
 *                                             并从检索命中里让位（自选优先，同一条不进材料两次）；
 *                                             只有规划向导的分析调用传它，其他调用方一概不带
 * @param {object} [options.headers]           小节标题覆写：{ memoryPurpose, gameplay, activePlan }
 * @param {string[]} [options.enabledIds]      世界书书单覆盖（缺省 = 本对话启用的书单）
 */
export function materialSections({ memoryTags = null, memorySheets = null, memoryModes = null, memoryRecent = 0, storageItems = [], activePlan = '', historySummaries = [], lorePicks = [], headers = {}, enabledIds } = {}) {
    const picks = resolveLorePicks(lorePicks);
    const { chatList, hits } = collectPlanningContext({ enabledIds, loreExclude: new Set(picks.map(p => p.key)) });
    if (!chatList.length) throw new Error('当前没有可分析的聊天记录');
    const memoryText = memoryTags === false ? '' : buildMemoryContext({ tagFilter: memoryTags, sheetUids: memorySheets, sheetModes: memoryModes, latestPerSheet: memoryRecent });
    const summaries = (historySummaries ?? []).filter(Boolean);
    // 第十三轮排序：稳定小节在前、「开头会变」的小节（检索命中、最近对话）垫底——前缀缓存
    // 按请求开头逐字节匹配，第一个变化字节之后全部按未命中计价。对话记录是滑动窗口（取最近
    // N 层，每轮聊天后窗口头就变）、检索命中按最近楼层重扫，这两节放最后，其余小节跨次调用
    // 字节不变；记忆表格/历史摘要只追加（旧行不变），放前面同样吃缓存。排列顺序系统提示词里
    // 已声明不代表时间先后，重排无语义迁移
    const parts = [
        '## 角色设定摘要',
        characterSummary() || '（无角色卡）',
        ...(picks.length ? [
            '## 自选世界书条目（用户点名随行的材料：原文整条、照着写——设定与口径以此为准；排列顺序不代表时间先后）',
            picks.map(p => `【${p.book.name} / ${p.entry.comment}】\n${p.entry.content}`).join('\n\n'),
        ] : []),
        ...gameplaySection(storageItems, headers.gameplay ?? '## 游戏玩法（当前生效的玩法规则，规划必须遵守其约束）'),
        ...(memoryText ? [memorySectionHeader(memoryTags, headers.memoryPurpose, memoryRecent, memoryModes), memoryText] : []),
        ...(activePlan ? [headers.activePlan ?? '## 进行中剧情（正在执行的规划，检查进度与重复时对照它）', activePlan] : []),
        ...(summaries.length ? ['## 历史剧情摘要（只用于查重）', summaries.map((s, i) => `${i + 1}. ${s}`).join('\n')] : []),
        '## 检索命中的世界书条目',
        buildLoreContext(hits),
        '## 最近对话记录',
        formatChatLog(chatList),
    ];
    // picks（2026-09-02 动作指导书）：把自选条目的解析结果一并带回——规划侧据此判断材料里
    // 有没有出自「动作指导书」的条目（检索命中自带 action 标记，自选走 book.kind）
    return { parts, hits, picks };
}
