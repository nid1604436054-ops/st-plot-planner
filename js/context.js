// 上下文收集：对酒馆 getContext() 的唯一依赖点（版本兼容层，见开发方案 §4）
// 规划 / 事件 / 密封生成统一从这里取聊天记录与角色卡摘要
import { clamp } from "./utils.js";

export function getTavernContext() {
    return SillyTavern.getContext();
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
