// 上下文收集：对酒馆 getContext() 的唯一依赖点（版本兼容层，见开发方案 §4）
// 规划 / 检查报告 / 事件生成统一从这里取聊天记录与角色卡摘要
import { clamp } from "./utils.js";
import { settings } from "./settings.js";
import { scanLorebooks } from "./lorebook.js";
import { loadChatData } from "./chatdata.js";

export function getTavernContext() {
    return SillyTavern.getContext();
}

// 当前对话的世界书绑定（chatdata.js 的 books 块）：
// null = 该对话没动过世界书勾选，沿用每本书的全局 enabled 默认；
// 数组 = 该对话自己的启用书单（空数组 = 全不启用），换对话自动换回各自的
export function chatEnabledBookIds() {
    const books = loadChatData('books', null);
    return Array.isArray(books?.enabledIds) ? books.enabledIds : null;
}

export function collectRecentChat(layers) {
    const chat = Array.isArray(getTavernContext().chat) ? getTavernContext().chat : [];
    return chat
        .filter(m => m?.is_system !== true)   // 「对 AI 隐藏」的楼层不带入（深度 0 = 不限也一样跳过）
        .slice(-layers)
        .map(m => ({
            name: String(m?.name ?? (m?.is_user ? '用户' : '角色')),
            isUser: Boolean(m?.is_user),
            text: String(m?.mes ?? ''),
        }))
        .filter(m => m.text);
}

export function formatChatLog(list) {
    return list.map(m => `${m.isUser ? '{{user}}' : m.name}: ${m.text}`).join('\n\n');
}

// 规划 / 检查报告 / 反应卡 / 随机事件共用的上下文收集口径：
// 最近对话取 contextLayers 层，世界书检索只扫其中最近 scanDepth 层（0 = 不限）。
// 以后改检索口径只动这里，各调用方不再各写一遍。
// enabledIds：调用方自带书单时用它覆盖本对话的启用书单（反应卡的独立勾选用；缺省 = 本对话书单）
export function collectPlanningContext({ enabledIds } = {}) {
    const chatList = collectRecentChat(settings.retrieval.contextLayers);
    const scanText = formatChatLog(chatList.slice(-settings.retrieval.scanDepth));
    const hits = scanLorebooks(scanText, { enabledIds: enabledIds ?? chatEnabledBookIds() });
    return { chatList, scanText, hits };
}

// 当前楼层（聊天消息数）：事件条目冷却与反应注入计层的基准
export function currentFloor() {
    const chat = getTavernContext().chat;
    return Array.isArray(chat) ? chat.length : 0;
}

export function characterSummary(maxChars = 800) {
    const ctx = getTavernContext();
    const card = Array.isArray(ctx.characters) ? ctx.characters[ctx.characterId] : null;
    if (!card) return '';
    const parts = [
        `角色名：${card.name ?? ''}`,
        card.description ? `描述：${card.description}` : '',
        card.personality ? `性格：${card.personality}` : '',
        card.scenario ? `场景：${card.scenario}` : '',
    ].filter(Boolean);
    return clamp(parts.join('\n'), maxChars);
}
