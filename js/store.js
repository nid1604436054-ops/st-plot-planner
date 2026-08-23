// M5 游戏玩法（原「储存空间」）：游戏规则等一次性内容的条目库，按触发条件注入主对话
// 与 M4 共用 setExtensionPrompt，但键空间独立（pps:），互不干扰；
// 生效中的条目可在剧情向导第 1 步勾选，作为材料随规划分析一起发给模型（见 storageItemsInEffect）
import { setExtensionPrompt, extension_prompt_types, extension_prompt_roles } from "/script.js";
import { collectRecentChat, formatChatLog } from "./context.js";
import { settings, save } from "./settings.js";

const POSITION_IN_PROMPT = extension_prompt_types?.IN_PROMPT ?? 0;
const ROLE_SYSTEM = extension_prompt_roles?.SYSTEM ?? 0;

// StorageItem { id, name, keys[], constant, depth, content, enabled }

export function addItem(item) {
    settings.storageItems.push(item);
    scanAndApplyStorage();
    save();
    return item;
}

export function removeItem(id) {
    settings.storageItems = settings.storageItems.filter(i => i.id !== id);
    setExtensionPrompt(`pps:${id}`, '', POSITION_IN_PROMPT, 6, false, ROLE_SYSTEM);
    save();
}

/**
 * 当前生效中的条目（启用 且 常驻或触发词命中）：主对话注入与向导第 1 步默认勾选共用同一判定。
 */
export function storageItemsInEffect(scanLayers = 20) {
    const text = formatChatLog(collectRecentChat(scanLayers)).toLowerCase();
    return settings.storageItems.filter(item => item.enabled
        && (item.constant || (item.keys ?? []).some(k => k && text.includes(String(k).toLowerCase()))));
}

/**
 * 按最近对话扫描命中情况：命中注入、未命中清空对应键；常驻条目恒注入。
 * 由 index.js 在 CHAT_CHANGED / MESSAGE_RECEIVED 时调用，也可手动触发。
 */
export function scanAndApplyStorage(scanLayers = 20) {
    const inEffect = new Set(storageItemsInEffect(scanLayers).map(i => i.id));
    for (const item of settings.storageItems) {
        setExtensionPrompt(
            `pps:${item.id}`,
            inEffect.has(item.id) ? String(item.content ?? '') : '',
            POSITION_IN_PROMPT,
            Number(item.depth) || 6,
            false,
            ROLE_SYSTEM,
        );
    }
}
