// M4 隐身注入：把幕后内容写进主对话提示词（模型可见、聊天界面不渲染）
// 所有对酒馆 setExtensionPrompt 的调用集中在本文件（兼容层，见开发方案 §4）
import { setExtensionPrompt, extension_prompt_types, extension_prompt_roles } from "/script.js";
import { getTavernContext } from "./context.js";
import { settings, save } from "./settings.js";
import { composeReactionText } from "./reactions.js";

const POSITION_IN_PROMPT = extension_prompt_types?.IN_PROMPT ?? 0;
const ROLE_SYSTEM = extension_prompt_roles?.SYSTEM ?? 0;
const ROLE_USER = extension_prompt_roles?.USER ?? 1;

const promptKey = id => `pp:${id}`;

function roleValue(role) {
    return role === 'user' ? ROLE_USER : ROLE_SYSTEM;
}

// 写入一条注入；enabled=false 时等价于撤销（深度 0 = 紧贴上下文末尾，是合法值）
export function applyInjection(item) {
    const depth = Number(item.depth);
    setExtensionPrompt(
        promptKey(item.id),
        item.enabled ? String(item.content ?? '') : '',
        POSITION_IN_PROMPT,
        Number.isFinite(depth) && depth >= 0 ? depth : 4,
        false,
        roleValue(item.role),
    );
}

export function revokeInjection(id) {
    setExtensionPrompt(promptKey(id), '', POSITION_IN_PROMPT, 4, false, ROLE_SYSTEM);
}

export function addInjection(item) {
    // scope=chat 的注入绑定创建时的聊天
    if (item.scope === 'chat' && item.chatId === undefined) {
        item.chatId = getTavernContext().chatId;
    }
    settings.injections.push(item);
    applyInjection(item);
    save();
}

export function updateInjection(item) {
    applyInjection(item);
    save();
}

export function removeInjection(id) {
    settings.injections = settings.injections.filter(i => i.id !== id);
    revokeInjection(id);
    save();
}

// 聊天切换：撤销不属于当前聊天的 scope=chat 注入，重放其余启用的
export function replayScopedInjections() {
    const chatId = getTavernContext().chatId;
    for (const item of settings.injections) {
        const foreign = item.scope === 'chat' && item.chatId !== undefined && item.chatId !== chatId;
        if (foreign || !item.enabled) {
            revokeInjection(item.id);
        } else {
            applyInjection(item);
        }
    }
}

// 当前生效的反应卡注入（正文即主对话提示词里逐层换段的同一份文本）。
// 剧情规划与检查报告通道附带它用（planner.js）：规划模型与主对话模型看到同一批反应指导
export function activeReactionInjections() {
    const chatId = getTavernContext().chatId;
    return settings.injections.filter(i => i.enabled && i.source === 'reaction'
        && String(i.content ?? '').trim()
        && !(i.scope === 'chat' && i.chatId !== undefined && i.chatId !== chatId));
}

// 每收到一条消息，推进「按层数过期」的计数（开发方案 §M4 生命周期）；
// 带反应卡的注入（source=reaction）同时按新楼层重写正文（扩散链逐层换段、临近到期提示收束）。
// 绑定其他聊天的 scope=chat 注入不跟着别的聊天计数。
export function tickInjectionExpiries() {
    const chatId = getTavernContext().chatId;
    let changed = false;
    for (const item of settings.injections) {
        if (!item.enabled) continue;
        if (item.scope === 'chat' && item.chatId !== undefined && item.chatId !== chatId) continue;
        if (item.expires?.type !== 'layers') continue;
        item.age = (item.age ?? 0) + 1;
        if (item.age >= item.expires.layers) {
            item.enabled = false;
            revokeInjection(item.id);
            if (item.source === 'reaction') {
                toastr.info(`路人反应注入「${item.label}」已到期自动撤下`);
            }
            changed = true;
        } else if (item.reaction && !item.reaction.edited) {
            // 用户没手改过正文才自动换段；手改过的只按层数过期
            item.content = composeReactionText(item.reaction, item.age);
            applyInjection(item);
            changed = true;
        }
    }
    if (changed) save();
}
