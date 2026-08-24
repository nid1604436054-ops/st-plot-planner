// 路人反应校准卡：模型从最近对话里认出「刚发生的引人注目的事」，转成有边界、会到期的幕后注入。
// 解决两个极端：模型要么每层都全场哗哗地重复路人反应，要么一笔带过后世界装失忆。
// 卡片定位是给主对话模型的「反应口径」，不是替它写好的正文：即时口径（谁、什么形式、什么烈度）+
// 余波口径（消息传开或平息的方向）+ 底线（不可逆伤害一律禁止）+ 楼层预算（一层 = 一条角色回复，
// user 消息不计，到期自动撤下）。旧版按楼层分段的「扩散链」卡片还存在旧注入里，
// composeReactionText 走兼容分支继续逐层换段——3~4 层根本扩散不开，新卡不再产扩散链。
// 材料用反应区自己的「材料勾选」（materials.reactionPicks，存对话记忆，独立于向导第 1 步）：
// 预设拼进系统提示词，世界书（书单之外可再按条目标签筛一层）/记忆表格/游戏玩法/进行中剧情
// 按勾选发送——长线剧情里角色的身世、名声在世界书与记忆里，不带就没法校准路人认知。
import { chatCompletion } from "./api.js";
import { activeStory } from "./story.js";
import { materialSections, reactionPicks, assemblePresets, withPresets } from "./materials.js";
import { storageItemsInEffect } from "./store.js";
import { settings } from "./settings.js";
import { extractJson } from "./utils.js";

const DEFAULT_BOUNDARY = '不得导致感情实质破裂、主要角色受异性实质侵犯、user 无法逆转的损失；危机可以重，出口必须存在。';

const CARD_SYSTEM_PROMPT = '你是文字角色扮演的「路人反应校准器」。用户会给你最近对话与相关材料（角色设定、世界书、既往记忆、玩法规则、进行中剧情），'
    + '你从中找出最近一件最引人注目的事，生成一张「路人反应卡」，注入幕后指导主对话模型。'
    + '先想清楚这张卡是什么：它是给主对话模型的「反应口径」，不是替它写好的正文——你定身份、形式、烈度与边界，'
    + '具体台词、镜头、人选由主对话模型当轮就地呈现。铁律：'
    + '一、反应织进当前场景：只写在场者当场可见的反应；不得把镜头切到不在场的人身上，'
    + '不得给路人写内心独白，不得虚构具体路人再跟进他们事后做了什么。'
    + '二、反应不是剧情：路人证明角色存在感即可，绝大多数止步一到三句，不喧宾夺主，不自行发展成独立事件。'
    + '三、余波只给方向：扩散是「消息逐渐传开」的口径（经什么渠道、到多大范围、以什么形式被提起），'
    + '不是传播过程的场面描写。'
    + '字符串值里不要出现英文双引号（引用一律写中文「」），也不要在值内换行。'
    + '只输出一个 JSON 对象，不要输出 JSON 以外的任何文字：\n'
    + '{ "salience": 1~5 的整数（显著性：1=只有身边几人注意到，3=在场者普遍反应，5=全场围观且会留下记录）,\n'
    + '  "immediate": "即时反应口径：什么身份的旁观者、以什么动作或低语作出反应、烈度如何；每轮 1-3 句的量。写身份与形式，不写现成台词与画面",\n'
    + '  "aftermath": "余波口径：显著性 1-3 写不外传方向（在场者议论几句后自然平息）；显著性 4-5 写传播走向（经什么渠道传开、到多大范围、后续场景里陌生人以什么形式提起）。贴世界观：现代用拍摄上传、本地群、热搜边缘等，古风奇幻用口耳相传、悬赏告示、教会或官府注意等",\n'
    + '  "boundaries": "底线：不得导致感情实质破裂、主要角色受异性实质侵犯、user 无法逆转的损失；危机可以重，出口必须存在。再列出本事件可接受的余波（如虚惊一场、舆情压力、短期经济困难、身份暴露）",\n'
    + '  "floors": 楼层预算，2-30 的整数（一层 = 一条角色回复，user 消息不计），与显著性匹配：1-2 级取 2-4，3 级取 4-8，4 级取 10-18，5 级取 16-30 }';

/**
 * 生成一张路人反应卡（引人注目的事从最近对话里自动判定，不手填）。
 * 材料用反应区自己的「材料勾选」（存对话记忆，独立于向导第 1 步——在那里增删不影响规划分析）；
 * 预设按勾选拼进系统提示词。
 * @param {object} [options]
 * @param {string} [options.note]  指导意见（期望烈度、余波方向、要避开什么）
 * @returns {Promise<{salience:number, immediate:string, aftermath:string, boundaries:string, floors:number}>}
 */
export async function generateReactionCard({ note = '' } = {}) {
    const picks = reactionPicks();
    const gpIds = picks.gpIds ?? storageItemsInEffect().map(i => i.id);
    const presets = picks.presetIds == null
        ? (settings.guidance?.presets ?? []).filter(x => x.enabled)
        : (settings.guidance?.presets ?? []).filter(x => picks.presetIds.includes(x.id));
    const activePlan = picks.plan ? (activeStory()?.planText ?? '').trim() : '';
    const { parts } = materialSections({
        memoryTags: [],                       // 反应卡不做记忆标签层：勾了表就全量，全不勾 = 不附带
        memorySheets: picks.memSheets,
        storageItems: (settings.storageItems ?? []).filter(i => gpIds.includes(i.id)),
        activePlan,
        enabledIds: picks.books ?? undefined, // null = 沿用本对话「世界书」页的启用书单
        loreTags: picks.loreMatch ? picks.loreTags : null, // 按标签筛条目；开了没勾 = 一条不带
        headers: {
            memoryPurpose: '既往剧情事件记录，是路人与世界已有认知的背景',
            gameplay: '## 游戏玩法（当前生效的玩法规则，路人与世界的反应须遵守其约束）',
            activePlan: '## 进行中剧情（正在执行的规划，反应口径与其方向一致）',
        },
    });
    const user = [
        ...parts,
        '## 任务',
        '从最近对话里找出最近一件最引人注目的事，围绕它生成反应卡；实在没有就按日常被注视处理，salience 取 1。',
        note.trim() ? `## 指导意见\n${note.trim()}` : '',
    ].filter(Boolean).join('\n\n');

    const raw = await chatCompletion({
        messages: [
            { role: 'system', content: withPresets(CARD_SYSTEM_PROMPT, assemblePresets(presets)) },
            { role: 'user', content: user },
        ],
    });
    return normalizeCard(extractJson(raw));
}

export function normalizeCard(card) {
    const floors = Math.min(Math.max(Number(card?.floors) || 6, 2), 30);
    return {
        salience: Math.min(Math.max(Math.round(Number(card?.salience) || 2), 1), 5),
        immediate: String(card?.immediate ?? '').trim(),
        // 余波口径是一段方向描述；楼层预算随显著性走（大事件才给长预算——短窗口里根本扩散不开）
        aftermath: String(card?.aftermath ?? '').trim() || '不会扩散：在场者议论几句后自然平息，不外传、不发酵。',
        boundaries: String(card?.boundaries ?? '').trim() || DEFAULT_BOUNDARY,
        floors,
    };
}

// ------ 旧版「扩散链」兼容：按楼层分段的卡片还存在旧注入里，换段逻辑保留 ------

// "1-2" / "3-5" / "6+" → {from, to}（to=Infinity 表示到最后）；解析失败整段按 1 起步兜底
function parseFloors(tag) {
    const m = String(tag ?? '').match(/^(\d+)\s*[-–~]\s*(\d+|\+)?$/);
    if (!m) return { from: 1, to: Infinity };
    return { from: Math.max(Number(m[1]), 1), to: m[2] ? Number(m[2]) : Infinity };
}

// age = 已过去的楼层数（0 = 刚发生）；返回当前应处的扩散段。
// 模型给的区间可能不连续（首段不从 1 起、中间留空档）：空档楼层归入「已开始的最近一段」，
// 早于首段的楼层用第一段——绝不能直落末段，否则第一层就把收束文案写进正文
function reactionStageAt(card, age) {
    const f = age + 1;
    let fallback = null;
    for (const s of card.diffusion) {
        if (f >= s.from && f <= s.to) return s;
        if (s.from <= f) fallback = s;
    }
    return fallback ?? card.diffusion[0];
}

/**
 * 组装注入正文：新卡按「即时口径 + 余波口径」，旧卡（diffusion 数组）继续随 age 前进换扩散段；
 * 临近到期提示自然收束。每层由 tick 重算。
 */
export function composeReactionText(card, age) {
    const remain = card.floors - age;
    const head = `【路人反应校准｜显著性 ${card.salience}/5｜第 ${Math.min(age + 1, card.floors)}/${card.floors} 层（一层 = 一条角色回复）】`;
    const lines = [
        head,
        '这件事已经发生。下面的指导只管世界如何回应它：反应不是剧情，路人是背景不是主角；user 主动追问不算新触发。',
        '',
        '## 即时反应口径（每轮 1-3 句，织进当前场景；不切镜头、不写路人内心戏）',
        card.immediate,
        '',
    ];
    if (Array.isArray(card.diffusion) && card.diffusion.length) {
        const stage = reactionStageAt(card, age);
        lines.push(`## 当前扩散阶段（事发后第 ${stage.floors} 层段）`, stage.text, '');
    } else {
        lines.push('## 余波口径（消息传开/平息的方向；具体谁说什么由本轮叙述就地呈现）', card.aftermath, '');
    }
    lines.push(
        '## 底线（覆盖其余规则）',
        card.boundaries,
        '',
        '## 密度与收束',
        '同时最多推进 2 条事件线；重事件后 2-3 层只出轻的；user 正在处理事件时不叠加新事件；已发生过的不复现。',
    );
    if (remain <= 0) {
        lines.push('本指引已到期：路人反应回归常态，除非 user 主动提起，不再渲染此事。');
    } else if (remain <= 2) {
        lines.push('本指引即将到期：让反应自然收束（议论平息、注意力转移），不要开新枝。');
    } else {
        lines.push(`本指引共 ${card.floors} 层有效，到期后路人反应回归常态，除非 user 主动提起。`);
    }
    return lines.join('\n');
}
