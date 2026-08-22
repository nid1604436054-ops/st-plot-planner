// M5 储存空间：一次性内容（游戏规则等）的条目库，按触发条件注入主对话
// 与 M4 共用 setExtensionPrompt，但键空间独立（pps:），互不干扰
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
 * 按最近对话扫描命中情况：命中注入、未命中清空对应键；常驻条目恒注入。
 * 由 index.js 在 CHAT_CHANGED / MESSAGE_RECEIVED 时调用，也可手动触发。
 */
export function scanAndApplyStorage(scanLayers = 20) {
    const text = formatChatLog(collectRecentChat(scanLayers)).toLowerCase();
    for (const item of settings.storageItems) {
        const hit = item.enabled
            && (item.constant || (item.keys ?? []).some(k => k && text.includes(String(k).toLowerCase())));
        setExtensionPrompt(
            `pps:${item.id}`,
            hit ? String(item.content ?? '') : '',
            POSITION_IN_PROMPT,
            Number(item.depth) || 6,
            false,
            ROLE_SYSTEM,
        );
    }
}
