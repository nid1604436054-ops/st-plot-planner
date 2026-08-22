// M3 随机事件：开放情境下的动态遭遇生成
// 与剧情指导的差别：剧情指导面向固定场景做预编排；随机事件是「走在路上」式的意外遭遇（开发方案 §M3）
import { chatCompletion } from "./api.js";
import { collectRecentChat, formatChatLog, characterSummary } from "./context.js";
import { scanLorebooks, buildLoreContext } from "./lorebook.js";
import { settings, newId } from "./settings.js";
import { extractJson } from "./utils.js";

const EVENT_SYSTEM_PROMPT = '你是文字角色扮演的随机遭遇生成器。基于当前情境与给定的事件方向，'
    + '生成一次合理的意外遭遇（动态事件而非预编排剧本），并给出若干可选走向。'
    + '只输出一个 JSON 对象，不要输出 JSON 以外的任何文字：\n'
    + '{ "title": "事件标题", "description": "遭遇描述（150 字内）", '
    + '"options": [ { "label": "选项名", "hint": "选后的幕后走向提示" } ] }\n'
    + 'options 给 3 个左右。';

export function defaultEventRules() {
    return [
        { id: newId('ev-'), name: '偶遇旧识', enabled: true, probability: 0.3, weight: 1, cooldownLayers: 30, promptHint: '一个与主角有旧怨或旧情的次要角色意外出现，带来新的张力' },
        { id: newId('ev-'), name: '环境突变', enabled: true, probability: 0.2, weight: 1, cooldownLayers: 20, promptHint: '天气、人流或周围环境发生显著变化，迫使剧情转向' },
        { id: newId('ev-'), name: '意外阻碍', enabled: true, probability: 0.2, weight: 1, cooldownLayers: 20, promptHint: '一件小意外打断当前行动（丢失物品、临时状况、陌生人搭话）' },
        { id: newId('ev-'), name: '有利线索', enabled: true, probability: 0.15, weight: 1, cooldownLayers: 40, promptHint: '主角意外获得一条与当前目标相关的有用线索或机会' },
    ];
}

/**
 * 掷骰：先按 probability 过筛，再在命中池内按 weight 加权随机取一。
 * 冷却（cooldownLayers）在 Phase 3 接消息钩子后启用，当前为手动掷骰。
 * @returns {EventRule|null} 未命中返回 null
 */
export function rollEventRule(rules, rng = Math.random) {
    const pool = (rules ?? []).filter(r => r.enabled && rng() < r.probability);
    if (!pool.length) return null;
    const total = pool.reduce((s, r) => s + Math.max(Number(r.weight) || 0, 0), 0);
    if (total <= 0) return pool[0];
    let pick = rng() * total;
    for (const r of pool) {
        pick -= Math.max(Number(r.weight) || 0, 0);
        if (pick <= 0) return r;
    }
    return pool[pool.length - 1];
}

/**
 * 生成一次随机事件。
 * @returns {Promise<{title:string, description:string, options:Array<{label:string, hint:string}>}>}
 */
export async function generateRandomEvent(rule) {
    const chatList = collectRecentChat(settings.retrieval.contextLayers);
    const scanText = formatChatLog(chatList.slice(-settings.retrieval.scanDepth));
    const hits = scanLorebooks(scanText);

    const raw = await chatCompletion({
        messages: [
            { role: 'system', content: EVENT_SYSTEM_PROMPT },
            {
                role: 'user',
                content: [
                    '## 角色设定摘要',
                    characterSummary() || '（无角色卡）',
                    '## 最近对话',
                    formatChatLog(chatList),
                    '## 世界书命中',
                    buildLoreContext(hits),
                    '## 事件方向',
                    `${rule.name}：${rule.promptHint}`,
                ].join('\n\n'),
            },
        ],
    });
    return extractJson(raw);
}
