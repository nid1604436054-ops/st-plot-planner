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
    // 按层数过期的注入记下计层基线（楼数口径见 replyFloorCount），此后已过层数按楼层净增推导
    if (item.expires?.type === 'layers' && item.floorBase == null) {
        item.floorBase = replyFloorCount();
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

// 计层楼数 = 已落地的角色回复数（user 消息不计，一层 = 一条角色回复）。
// 滑动/重新生成只是替换最后一条回复，楼数不变；删楼层只会让楼数变少——
// 按净增推导对这三种情况都天然免疫
function replyFloorCount() {
    const chat = getTavernContext().chat;
    if (!Array.isArray(chat)) return 0;
    return chat.reduce((n, m) => n + (m?.is_user ? 0 : 1), 0);
}

// 已过层数按「聊天楼层净增」推导（2026-08-26 用户拍板）：注入创建时记下基线楼数
// （addInjection），此后 age = 当前楼数 - 基线。MESSAGE_RECEIVED 在滑动/重新生成时也会
// 触发，但楼数没变 → 不吃层，多触发无害；删楼层楼数只减，推导结果不为负。
// 带反应卡的注入（source=reaction）同时按新楼层重写正文（旧式扩散链卡逐层换段，新卡口径
// 不变、临近到期提示收束）。绑定其他聊天的 scope=chat 注入不跟着别的聊天计数。
export function tickInjectionExpiries() {
    const chatId = getTavernContext().chatId;
    const floors = replyFloorCount();
    let changed = false;
    for (const item of settings.injections) {
        if (!item.enabled) continue;
        if (item.scope === 'chat' && item.chatId !== undefined && item.chatId !== chatId) continue;
        if (item.expires?.type !== 'layers') continue;
        if (item.floorBase == null) {
            // 升级前创建的老注入按现有进度折算基线，剩余层数原样保留不跳变；
            // 楼层被删过时基线可能为负——不能夹 0，夹了反而把已过层数放大
            item.floorBase = floors - (item.age ?? 0);
        }
        const age = Math.max(0, floors - item.floorBase);
        if (age === (item.age ?? 0)) continue;   // 楼数没有净增（滑动/重新生成）不吃层
        item.age = age;
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
