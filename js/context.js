// 上下文收集：对酒馆 getContext() 的唯一依赖点（版本兼容层，见开发方案 §4）
// 规划 / 检查报告 / 事件生成统一从这里取聊天记录与角色卡摘要
import { clamp } from "./utils.js";
import { settings } from "./settings.js";
import { loadChatData, saveChatData } from "./chatdata.js";

export function getTavernContext() {
    return SillyTavern.getContext();
}

// 当前对话的世界书绑定（chatdata.js 的 books 块）：
// null = 该对话没动过世界书勾选，沿用每本书的全局 enabled 默认；
// 数组 = 该对话自己的启用书单（空数组 = 全不启用），换对话自动换回各自的
// 第四十三轮起书单的界面在监听页（写入用下面两个助手），读取方＝监听检索与新导入书的自动入单
export function chatEnabledBookIds() {
    const books = loadChatData('books', null);
    return Array.isArray(books?.enabledIds) ? books.enabledIds : null;
}

// 某本书在当前对话是否启用：有绑定书单看书单，没绑定沿用全局 enabled 默认（界面显示用）
export function chatBookEnabled(book) {
    const ids = chatEnabledBookIds();
    return ids ? ids.includes(String(book.id)) : Boolean(book.enabled);
}

// 勾选写进当前对话的书单（第一次勾选时先把各书现状快照成书单，再改这一本）——第四十三轮
// 起从世界书页搬来监听页用，逻辑不变
export function setChatBookEnabled(id, on) {
    const books = loadChatData('books', () => ({}));
    if (!Array.isArray(books.enabledIds)) {
        books.enabledIds = settings.lorebooks.filter(b => b.enabled).map(b => String(b.id));
    }
    const ids = new Set(books.enabledIds.map(String));
    on ? ids.add(String(id)) : ids.delete(String(id));
    books.enabledIds = [...ids];
    saveChatData('books', books);
}

// 新导入的书自动加进本对话书单：已绑定的对话里不在书单就是灭的，不自动加会像没导入成功
export function bindNewBookToChat(book) {
    const books = loadChatData('books', null);
    if (Array.isArray(books?.enabledIds) && book.enabled) {
        books.enabledIds.push(String(book.id));
        saveChatData('books', books);
    }
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
// 最近对话取 contextLayers 层。世界书检索已从这里撤出（第四十三轮：一次性生成只带
// 勾选条目，自动检索归监听）——以后改对话窗口口径只动这里，各调用方不再各写一遍
export function collectPlanningContext() {
    const chatList = collectRecentChat(settings.retrieval.contextLayers);
    return { chatList };
}

// 当前楼层（聊天消息数，含 user 楼）：事件条目冷却的基准。
// 注入计层不用它——那里要「一层 = 一条角色回复」，只数角色楼（injection.js 的 replyFloorCount）
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
