// 路人反应校准卡：把「刚发生的引人注目的事」转成有边界、随楼层扩散再收束的幕后注入
// 解决两个极端：模型要么每层都全场哗哗地重复路人反应，要么一笔带过后世界装失忆。
// 卡片结构（吸收用户 NPC_Reaction 预设）：显著性分级 / 即时反应写法（写一次就够）/
// 扩散链（按楼层分段，贴世界观）/ 底线（不可逆伤害一律禁止）/ 楼层预算（到期自动撤下）。
import { chatCompletion } from "./api.js";
import { collectRecentChat, formatChatLog, characterSummary } from "./context.js";
import { scanLorebooks, buildLoreContext } from "./lorebook.js";
import { settings } from "./settings.js";
import { extractJson } from "./utils.js";

const DEFAULT_BOUNDARY = '不得导致感情实质破裂、主要角色受异性实质侵犯、user 无法逆转的损失；危机可以重，出口必须存在。';

const CARD_SYSTEM_PROMPT = '你是文字角色扮演的「路人反应校准器」。用户会描述一件引人注目的事（或让你从最近对话里判断），'
    + '你生成一张路人反应卡，用于注入幕后指导主对话模型。'
    + '核心认知：路人的功能是证明角色的存在感——绝大多数反应止步一到三句，不喧宾夺主，不自行发展成独立剧情；'
    + '少数反应有余地时才升级成事件，事件是副产物不是目的，要写成已发生、不写「可能会发生」，提供方向不提供剧情。'
    + '只输出一个 JSON 对象，不要输出 JSON 以外的任何文字：\n'
    + '{ "salience": 1~5 的整数（显著性：1=只有身边几人注意到，3=在场者普遍反应，5=全场围观且会留下记录）,\n'
    + '  "immediate": "即时反应的写法指导：谁在看、低语什么、侧身让路、回头、举起手机又放下等具体动作，每轮 1-3 句的量，身份符合场景，瞩目型优先于互动型",\n'
    + '  "diffusion": [ {"floors": "1-2", "text": "事发后第 1-2 层：旁观者的具体反应与传播起点"}, {"floors": "3-5", "text": "…"}, {"floors": "6+", "text": "…"} ],\n'
    + '  "boundaries": "底线：不得导致感情实质破裂、主要角色受异性实质侵犯、user 无法逆转的损失；危机可以重，出口必须存在。再列出本事件可接受的余波（如虚惊一场、舆情压力、短期经济困难、身份暴露）",\n'
    + '  "floors": 楼层预算，4-12 的整数，与显著性匹配（越高越长） }\n'
    + 'diffusion 给 2-4 段，贴当前世界观：现代背景用拍摄上传、本地群转发、热搜边缘、官方介入等；'
    + '古风/奇幻用口耳相传、悬赏告示、教会或官府注意等。段与段要递进（扩散、发酵或平息），区间加起来与 floors 匹配。';

/**
 * 生成一张路人反应卡。
 * @param {object} [options]
 * @param {string} [options.what]  刚发生的引人注目的事（空则让模型从最近对话里找）
 * @param {string} [options.note]  补充说明（期望烈度、扩散方向、要避开什么）
 * @returns {Promise<{salience:number, immediate:string, diffusion:Array, boundaries:string, floors:number}>}
 */
export async function generateReactionCard({ what = '', note = '' } = {}) {
    const chatList = collectRecentChat(settings.retrieval.contextLayers);
    const scanText = formatChatLog(chatList.slice(-settings.retrieval.scanDepth));
    const hits = scanLorebooks(scanText);
    const user = [
        '## 角色设定摘要',
        characterSummary() || '（无角色卡）',
        '## 最近对话',
        formatChatLog(chatList),
        '## 世界书命中',
        buildLoreContext(hits),
        '## 引人注目的事',
        what.trim() || '（未填写：请从最近对话里找出最近一件最引人注目的事；实在没有就按日常被注视处理，salience 取 1）',
        note.trim() ? `## 补充说明\n${note.trim()}` : '',
    ].filter(Boolean).join('\n\n');

    const raw = await chatCompletion({
        messages: [
            { role: 'system', content: CARD_SYSTEM_PROMPT },
            { role: 'user', content: user },
        ],
    });
    return normalizeCard(extractJson(raw));
}

// "1-2" / "3-5" / "6+" → {from, to}（to=Infinity 表示到最后）；解析失败整段按 1 起步兜底
function parseFloors(tag) {
    const m = String(tag ?? '').match(/^(\d+)\s*[-–~]\s*(\d+|\+)?$/);
    if (!m) return { from: 1, to: Infinity };
    return { from: Math.max(Number(m[1]), 1), to: m[2] ? Number(m[2]) : Infinity };
}

export function normalizeCard(card) {
    const floors = Math.min(Math.max(Number(card?.floors) || 6, 2), 30);
    const stages = (Array.isArray(card?.diffusion) ? card.diffusion : [])
        .map(s => {
            const { from, to } = parseFloors(s?.floors);
            return { from, to, floors: String(s?.floors ?? ''), text: String(s?.text ?? '').trim() };
        })
        .filter(s => s.text);
    const immediate = String(card?.immediate ?? '').trim();
    return {
        salience: Math.min(Math.max(Math.round(Number(card?.salience) || 2), 1), 5),
        immediate,
        diffusion: stages.length ? stages
            : [{ from: 1, to: Infinity, floors: '1+', text: immediate || '路人注意到并低声议论，随时间自然平息' }],
        boundaries: String(card?.boundaries ?? '').trim() || DEFAULT_BOUNDARY,
        floors,
    };
}

// age = 已过去的楼层数（0 = 刚发生）；返回当前应处的扩散段
export function reactionStageAt(card, age) {
    const f = age + 1;
    for (const s of card.diffusion) {
        if (f >= s.from && f <= s.to) return s;
    }
    return card.diffusion[card.diffusion.length - 1];
}

/**
 * 组装注入正文：随 age 前进换扩散段，临近到期提示自然收束。每层由 tick 重算。
 */
export function composeReactionText(card, age) {
    const stage = reactionStageAt(card, age);
    const remain = card.floors - age;
    const head = `【路人反应校准｜显著性 ${card.salience}/5｜第 ${Math.min(age + 1, card.floors)}/${card.floors} 层】`;
    const lines = [
        head,
        '这件事已经发生。下面的指导只管世界如何回应它：反应不是剧情，路人是背景不是主角；user 主动追问不算新触发。',
        '',
        '## 即时反应写法（每轮 1-3 句，身份符合场景，不喧宾夺主）',
        card.immediate,
        '',
        `## 当前扩散阶段（事发后第 ${stage.floors} 层段）`,
        stage.text,
        '',
        '## 底线（覆盖其余规则）',
        card.boundaries,
        '',
        '## 密度与收束',
        '同时最多推进 2 条事件线；重事件后 2-3 层只出轻的；user 正在处理事件时不叠加新事件；已发生过的不复现。',
    ];
    if (remain <= 0) {
        lines.push('本指引已到期：路人反应回归常态，除非 user 主动提起，不再渲染此事。');
    } else if (remain <= 2) {
        lines.push('本指引即将到期：让反应自然收束（议论平息、注意力转移），不要开新枝。');
    } else {
        lines.push(`本指引共 ${card.floors} 层有效，到期后路人反应回归常态，除非 user 主动提起。`);
    }
    return lines.join('\n');
}
