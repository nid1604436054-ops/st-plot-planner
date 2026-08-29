// M2 剧情指导：检查（OOC/剧情重复/文风重复/进度）+ 剧情规划（隐藏剧本）+ 检查报告
// 与 M3 共用「上下文收集 + 世界书检索 + 独立 API」管线，全程不碰主对话连接
import { chatCompletion, searchWeb, searchToolReady, parseModelJson } from "./api.js";
import { collectPlanningContext, formatChatLog, characterSummary } from "./context.js";
import { buildLoreContext } from "./lorebook.js";
import { buildMemoryContext } from "./memoryTable.js";
import { storageItemsInEffect } from "./store.js";
import { activeReactionInjections } from "./injection.js";
import { settings } from "./settings.js";
import { knowledgeSection } from "./knowledge.js";
import { materialSections as baseMaterialSections, gameplaySection, memorySectionHeader } from "./materials.js";
import { extractJson, fingerprint } from "./utils.js";

// 输出 schema 两套变体：存在进行中剧情时才要求 progress（推进到哪个阶段 + 约百分比）。
// 首次规划没有可对照执行的剧情，不问进度——问了模型也会编一个出来（人工二检页曾出现
// 「还没采用的规划先有完成度」，根源就是 schema 无条件要这个字段）
// plan 对象的 schema 两处复用（第一遍分析与第二遍对齐审校，第十二轮）：currentTime 是时间锚——
// 相对时间（今天/明天/第二天）没有固定寄存的「现在」就会随体裁惯性漂移（今天上午的事被归档成
// 「昨天」、一处写错后续参照系整体漂走），模型先把「现在是什么时候」读出来写在这里，锚点
// 外化到生成点上；材料无线索也如实写「未指明」，结果页原样展示供人工核对
const planSchemaBlock = (withKnowledge) => `{
      "currentTime": "排程的时间基准：从对话记录/用户构思/记忆表格里读出「现在」（如「当天上午」「次日傍晚」）；材料里没有时间线索就写「未指明」",
      "summary": "一句话概括接下来的走向",
      "beats": [
        { "stage": "阶段名", "content": "该阶段的幕后剧情安排（不出现在对话文本中）。不得替 user 编排：不写 user 的动作、台词或心理（对话或构思里 user 已明说的意愿可当前提）；涉及 user 一律写「若 user X，则 Y」的条件式接口，且本节点的核心推进不依赖 user 的回应" }
      ],
      "risks": ["可能跑偏的点；checks 判出、需要后续持续规避的要点也放这里"]${withKnowledge ? `,
      "knowledgeUsed": ["从「知识库材料」小节选用条目的编号（形如 1-03）；一条都没用给空数组"]` : ''}
    }`;

const OUTPUT_SCHEMA_BASE = `{
  "checks": {
    "ooc": {
      "found": false,
      "items": [
        { "aspect": "性格|事实|关系|世界观|口吻", "evidence": "对话中的具体依据", "severity": "轻微|中等|严重", "fix": "修正建议" }
      ]
    },
    "plotRepeat": { "found": false, "note": "已完结情节被当新剧情重演、或复刻已有桥段之处；同一剧情线的延续不算；没有则空字符串" },
    "styleRepeat": { "level": "无|轻微|明显", "note": "仅判 char 的自发重复：user 是否先重复、char 重复了什么" }__PROGRESS__
  },
    "plan": __PLAN__
}`;

const outputSchema = (withProgress, withKnowledge) => OUTPUT_SCHEMA_BASE.replace(
    '__PROGRESS__',
    withProgress ? `,
    "progress": { "stage": "进行中剧情推进到哪个阶段", "pct": "约x%", "note": "判断依据" }` : '',
).replace('__PLAN__', planSchemaBlock(withKnowledge));

// 内置指令：保证返回 JSON（程序要解析成检查项 + 规划）。用户预设已全局化——启用中的
// 由 api.js 的 chatCompletion 出口统一拼进 system 末尾（见 globalPresetBlock），此处不再单独拼。
// hasActivePlan 为真才要求 progress 字段，与 buildGuidanceMessages 是否附带「进行中剧情」小节同步；
// hasKnowledge 为真才要求 plan.knowledgeUsed 自报字段（§6.9 用后账），与「知识库材料」小节同步；
// hasSkeleton 为真才带防复刻骨架条款、minBeats>0 才带节点下限条款（均与随行小节/设置同步，
// 2026-08-29 真机第七轮：时间顺序 / user 不可编排 / 构思硬要求三组无条件常驻——实测病灶全是
// 系统提示词里没说、模型就按默认分布走）
export function guidanceSystemPrompt(hasActivePlan = false, hasKnowledge = false, hasSkeleton = false, minBeats = 0) {
    return [
        '你是文字角色扮演的剧情顾问，负责两件事：',
        `1) 检查：结合角色设定与世界书条目，判断最近对话是否存在 OOC（脱离人设、事实、关系或世界观）、是否与已有剧情重复、文风是否重复${hasActivePlan ? '、正在执行的剧情推进到什么程度' : ''}；`,
        '2) 规划：为后续剧情设计「隐藏剧本」——只作为幕后指导的剧情安排，不会以对话形式呈现给用户。',
        '要求：判断必须引用对话依据；给出「进行中剧情」时对照它检查进度与重复；给了「随机事件」就将其自然融入规划；给了「路人反应」就视为已发生之事的世界回应口径，规划为其留出呈现空间、不与余波和收束口径冲突；规划要具体、可执行、尊重既有设定；面向当前场景做预编排。',
        '时间顺序：材料各小节与条目的排列顺序不代表时间先后——知识库、世界书、记忆表格各按自己的清单顺序罗列，不构成时间线，不得按罗列顺序安排先后；对话记录或用户构思里给出了当前时间的，一律以它为准排程，接下来的安排从当前时段往后推（现在是上午就排午饭前后，不排晚饭，也不倒排上午）；条目带时段类字段（表头含「时段」或字段值含时间词）的，按该字段排。排程前先把读到的「现在」写进 plan.currentTime，全部相对时间以它为锚——今天发生的事留在今天，不得挪到第二天。',
        '事实一致性：对话记录、记忆表格、历史摘要里已经发生的事是既定事实——发生在哪天就是哪天，今天上午发生的事就留在今天，不得把当天的安排改写成第二天或更晚，后续排程只能从既定事实之后接着往后推；角色与 user 的既定设定（年龄、身份、能力、资格——从对话、人设卡、记忆表格里读到的）同样是硬约束，规划不得安排设定不允许的事（如未成年角色开车、无证从业、与身份不符的行为）；「剧情需要」与既定事实或设定冲突时，事实与设定赢。',
        'user 不可编排：user 是用户本人扮演的角色，规划只编排角色（char）与世界，不得替 user 决定。三条禁令：①不替 user 做出动作；②不替 user 说出台词或给出回应——「user 答应后」「user 同意之后」这类把 user 的回应写成既成事实的写法同属此列；③不预设 user 的心理反应（user 怎么想、会不会感动，由用户自己写）。唯一豁免：对话记录或用户构思里 user 已明确说出的意愿，可以作为前提使用。涉及 user 的部分只有一种合法写法——条件式接口「若 user X，则 Y」（可以给多个接口、可以分支）；并且每个节点的核心推进必须独立成立、不依赖 user 的任何具体回应：user 接口是挂在节点上的加分分支，不是节点赖以成立的地基，删掉它节点照样走得通。',
        'user 不可编排的对照示例（学结构、不学内容——示例里的具体事件不要写进规划）：坏：「两人到猫咖，user 抚摸猫咪逗她开心，user 承诺下周再带她来，她感动地靠过来」——替 user 做了动作、许了承诺，节点核心全押在 user 的回应上。好：「两人到猫咖，久违的猫咪围观让她露出少见的放松神态，主动点了两份甜品；若 user 主动逗猫或拍下她与猫的合照，则她顺势把合照设成聊天背景」——节点核心是她自己的状态与行动，user 接口只是加分分支。',
        '构思与修改意见里的点名要求是硬要求：数量（点名几个节点就不少于几个）、价位或金额（点名了下限或上限就按它选材，候选条目带价格区间的以条目为准）、时间日期、由谁发起或由谁挑选（点名了发起权归谁就不得转手，尤其不得转给 user）、地点、身份资格等——凡点名了的逐条落实，不得打折、不得反着写、不得自作主张换成别的方案；与模型自己的偏好或习惯冲突时，用户要求赢。',
        ...(minBeats > 0 ? [`没点名数量要求时，beats 也不得少于 ${minBeats} 个节点（不设上限——${minBeats} 是下限不是目标值，剧情需要更多就给更多）。`] : []),
        ...(hasSkeleton ? ['给了「近期草稿骨架」小节时：那是近期被放弃或换掉的规划草稿的骨架清单——新规划的走向、节点顺序与核心桥段不得与其中任何一份高度雷同；要换方向、换顺序、换桥段，不是换个说法把同一版再写一遍。'] : []),
        ...(hasKnowledge ? ['给了「知识库材料」小节时：那是用户自建清单的候选素材（反模型偏好用），按小节内各分组的口径办——全量清单分组＝该领域内容的完整候选表，规划凡涉及这类内容必须从中选用、不得自拟同类；抽样清单分组＝优先从中选用，选材面没覆盖的方向可以自拟。选用的素材要自然融入规划，保持条目的核心特征，不生硬罗列、不逐条复述；并在 plan.knowledgeUsed 里如实报出本次选用条目的编号（小节里【编号 x-xx】的写法），一条都没用就给空数组，不算异常。'] : []),
        '检查与规划必须耦合：checks 判出的每个问题都要在 plan 里得到处置，判了不改等于白判——OOC 在 beats 里写明怎么拉回人设/事实/关系，剧情与文风重复写明怎么绕开、往哪个新方向走；需要扮演模型后续持续注意的规避要点（如别再重复某类描写）放进 risks；不允许 checks 报了问题而 plan 与之无关。',
        '记忆表格里若已有多条同标签或同类型的既有事件（行尾带标签，如多次约会、多次同类冲突），视为这类事件已经写过：规划可以再安排同类事件，但不要复刻已有记录的流程与桥段，过程或走向须有新意。',
    '文风重复的判定基准：只针对角色（char）的扮演文本——先检查用户（user）近期输入是否自己在重复动作、场景或指令；角色只是跟进用户发起的重复不算文风重复；只有用户没有重复而角色自发重复描写套路、桥段或句式时，才判「轻微/明显」，并在 note 里写明用户是否先重复、角色重复了什么。',
    'OOC 的判定基准：只判角色（char）自身的问题——用户（user）在对话里明确指示、纠正或要求改变走向时（包括括号指令与作者式安排），角色照做不算 OOC，用户指示优先于人设与既有走向；只有用户没有指示、角色自行脱离人设/事实/关系/世界观时才判，evidence 写明对话依据。',
    '剧情重复的判定基准：同一剧情线的自然延续不算重复——「进行中剧情」正是该接着写的走向；历史摘要与记忆表格里同一剧情线有多条记录，只说明它跨度大、还在发展，对照它们看的是推进到哪一步，而非是否重复；只有把已完结、已发生并被总结过的情节当作新剧情原样重演，或复刻已有记录的流程与桥段，才判重复。',
    '字符串值里不要出现英文双引号（引用一律写中文「」），也不要在值内换行。',
    '只输出一个符合如下结构的 JSON 对象，不要输出 JSON 以外的任何文字：',
    outputSchema(hasActivePlan, hasKnowledge),
].join('\n');
}

// 第二遍对齐审校的追加尾巴（第十二轮落地两遍调用；第十三轮尾巴化）。生成态（第一遍）被规划的
// 体裁惯性拽着走，审校态（第二遍）手里只有一份草稿和一份对账清单——同一个模型换到审校位上，
// 相对时间不再跟着「下一段最常写什么」漂。只重发 plan：checks 是对对话的判断，不随 plan 修订
// 而变，重查重发纯属多花输出 token。
// 尾巴化（第十三轮，用户拍板走前缀缓存）：前缀缓存按请求开头逐字节匹配计费，第二遍若换掉
// system，前缀从第一个字节分叉、缓存全灭。故第二遍 messages 与第一遍逐字节相同，本尾巴追加
// 在 user 消息末尾（其后紧跟第一遍草稿）——第二遍新增输入只剩这一段。规则不在尾巴里复述
// （时间顺序/事实一致性/user 不可编排/点名要求 system 里都在、走缓存价），只留四条对账要点；
// 「覆盖上文的生成任务与输出要求」一句负责压过 system 末尾的输出结构（checks 不再输出）
export function alignTailPrompt(hasKnowledge = false) {
    return [
        '## 第二遍任务：对齐审校（覆盖上文的生成任务与输出要求）',
        '同一份材料你刚生成过一版剧情规划草稿（附在本节之后）。现在换到审校位：不是重新生成，是逐条对账后只把草稿里违反要求的地方改对。对账清单：',
        '①时间基准：从材料（对话记录、用户构思、记忆表格、历史摘要）重读「现在是什么时候」写进 plan.currentTime；草稿里所有相对时间（今天/明天/第二天/昨晚/上午/晚上）一律以它为锚——第一遍把今天上午的事排成第二天、把刚发生的写成昨天是常见病；已发生的事留在它实际发生的那天，后续排程只从既定事实之后往后推。',
        '②既定事实与设定：材料里已发生的事不得挪动；角色与 user 的既定设定（年龄、身份、能力、资格——从对话、人设卡、记忆表格里读到的）是硬约束，不得安排设定不允许的事（如未成年角色开车）。',
        '③点名要求：用户构思与修改意见里点名的要求（数量、价位或金额、时间日期、由谁发起或由谁挑选、地点、身份资格）逐条落实，不得打折、不得反着写、不得自作主张换方案；点名了发起权归谁就不得转手，尤其不得转给 user。',
        '④user 不可编排：不替 user 做动作、不说台词、不预设心理（对话或构思里 user 已明说的意愿可当前提）；涉及 user 只能写「若 user X，则 Y」的条件式接口，且每个节点的核心推进不依赖 user 的回应。',
        '只改违反上述各项的地方，其余原样保留——这是校对不是重写：走向、节点结构、选材与 plan.knowledgeUsed 都不动，改完仍是同一版规划。每处改动在 fixes 里逐条报出（改了哪里、从什么改成什么、依据哪条要求）；草稿本就全对就原样返回、fixes 给空数组。本次不输出 checks（第一遍的检查沿用）。',
        '只输出一个符合如下结构的 JSON 对象，不要输出 JSON 以外的任何文字：',
        `{
  "plan": ${planSchemaBlock(hasKnowledge)},
  "fixes": ["逐条报出改动：改了哪里、从什么改成什么、依据哪条要求；没有改动给空数组"]
}`,
    ].join('\n');
}

const REVIEW_SCHEMA = `{
  "completion": "约x%（当前处于规划中的哪个阶段）",
  "progress": { "moved": true, "note": "近几轮是否有效推进剧情，依据是什么" },
  "styleRepeat": { "level": "无|轻微|明显", "note": "仅判 char 的自发重复：user 是否先重复、char 重复了什么" },
  "ooc": {
    "found": false,
    "items": [
      { "aspect": "性格|事实|关系|世界观|口吻", "evidence": "对话中的具体依据", "severity": "轻微|中等|严重", "fix": "修正建议" }
    ]
  },
  "otherIssues": ["其他问题；没有则空数组"],
  "advice": "把上述所有问题点明，并给出接下来可直接执行的剧情指导"
}`;

export const REVIEW_SYSTEM_PROMPT = [
    '你是文字角色扮演的剧情监理。用户会给你一份「正在执行的剧情规划」和最近的对话记录，',
    '你对照规划检查执行情况：完成度、近几轮是否有效推进、文风是否重复、是否 OOC、有无其他问题，',
    '最后把所有问题点明并给出可直接执行的剧情指导。',
    '文风重复只针对角色（char）的扮演文本判定：用户（user）自己在重复动作、场景或指令时，角色跟进不算；只有用户没有重复而角色自发重复描写套路、桥段或句式，才判轻微/明显，note 写明依据。',
    'OOC 只判角色（char）自身的问题：用户（user）在对话里明确指示、纠正或要求改变走向时（包括括号指令与作者式安排），角色照做不算 OOC，用户指示优先于人设与既有走向。',
    '字符串值里不要出现英文双引号（引用一律写中文「」），也不要在值内换行。',
    '只输出一个符合如下结构的 JSON 对象，不要输出 JSON 以外的任何文字：',
    REVIEW_SCHEMA,
].join('\n');

// 材料小节构建已抽到 materials.js（reactions.js 也要用、又不能依赖本文件——
// planner → injection → reactions 已成链）。预设拼装（assemblePresets/withPresets）
// 已随全局化退役：启用中的预设由 api.js 出口统一附带，各调用方不再各自拼

// 真实账单提示（数字取服务商 usage 实报，非估算）：分析与检查调用结束就亮出来，
// 方便和「查看完整提示词」的材料字数对账——中文实际约 1.4~1.6 字/token，比预览粗估省。
// search：判断/检索阶段的信息（没开搜索时为 null，只报 token）；usage.streamNoUsage：
// 分析走了流式但服务商没在末包回传 usage，如实说明没有实报数字
function billToast(usage, search = null) {
    const parts = [];
    if (search) parts.push(search.direct
        ? `联网取关键词 1 次（轻量简报）${search.searched ? `+ Tavily 直查 ${search.queries} 个关键词（搜索不耗模型 token，全套材料只发 1 次）` : '：未取得关键词，未检索'}`
        : search.searched
            ? `联网判断 1 次（轻量简报）+ Tavily 直查 ${search.queries} 个关键词（搜索不耗模型 token，全套材料只发 1 次）`
            : `联网判断 1 次（轻量简报）：本次不需要现实信息，未检索${search.reason ? `（${search.reason}）` : ''}`);
    if (usage?.promptTokens) parts.push(`合计输入 ${usage.promptTokens.toLocaleString()} · 输出 ${usage.completionTokens.toLocaleString()} tokens（服务商实报）`);
    else if (usage?.streamNoUsage) parts.push('本次分析走流式且服务商未在末包回传 usage，无实报 token 数字');
    if (search?.logs.length) parts.push(`检索词：${search.logs.join('；')}`);
    if (parts.length) toastr.info(parts.join('；'));
}

// 检索闸门的系统提示词：判断调用不带任何工具——模型手里没有 web_search 时才敢说「不需要」，
// 工具挂在请求里它总觉得该搜一下（上一版检索助手几乎逢开必搜的根源）。
// 判「需要」也只给关键词，执行由本地直查 Tavily，全程不再有大模型工具循环
const GATE_SYSTEM_PROMPT = [
    '你是「剧情是否需要联网检索」的判断员。用户正在为一篇文字角色扮演作品做剧情规划/执行检查，会给你一份浓缩的剧情背景简报。',
    '默认判「不需要」：联网检索是例外而非例行步骤，绝大多数纯虚构剧情用不上。只有当剧情明确依赖现实世界的具体事实、且写错会伤及真实感或剧情成立时，才判「需要」。',
    '判「需要」的典型：真实历史事件与年代细节、现实地域/机构/行业/法律/医学的具体运作方式、时效性信息（近期事件、价格、政策现状）、写错会露馅的专业流程细节。',
    '判「不需要」的典型：纯虚构世界观与设定、角色情感与关系走向、通用生活常识、可以虚构或模糊带过的地方。',
    '字符串值里不要出现英文双引号（引用一律写中文「」），也不要在值内换行。',
    '只输出一个 JSON 对象，不要输出 JSON 以外的任何文字：',
    '{ "need": false, "reason": "一句话判断理由", "queries": ["判「需要」时给 1-3 个搜索关键词；判「不需要」给空数组"] }',
].join('\n');

// 「模型搜索前判断」关掉时的直查模式提示词：联网已确定执行，不再判要不要，
// 轻量调用只负责产关键词（关键词没有本地来源，必须由模型给）
const GATE_DIRECT_PROMPT = [
    '你是「剧情联网检索」的关键词参谋。用户正在为一篇文字角色扮演作品做剧情规划/执行检查，会给你一份浓缩的剧情背景简报。',
    '联网检索已确定执行，你的任务只有一件事：给出 1-3 个最值得检索的关键词。优先剧情依赖的现实世界具体事实（真实历史事件与年代细节、现实地域/机构/行业/法律/医学的运作方式、时效性信息、写错会露馅的专业流程）；纯虚构剧情没有可搜的现实信息时，给剧情核心名词（人名/地名/作品/物品等）也可以。',
    '字符串值里不要出现英文双引号（引用一律写中文「」），也不要在值内换行。',
    '只输出一个 JSON 对象，不要输出 JSON 以外的任何文字：',
    '{ "queries": ["1-3 个搜索关键词"] }',
].join('\n');

/**
 * 检索简报：给判断员的浓缩版剧情背景（千字级），字段与 buildGuidanceMessages 同源但全部截短。
 * 判断要不要联网只看这份小简报——全套材料与分析调用一起只发一次，计费不随检索增加；
 * 打回重写时把修改意见也带上，判断才知道要不要往新方向检索
 */
export function buildResearchBrief({ topic = '', userNote = '', eventText = '', activePlan = '', historySummaries = [], planText = '', revisionNote = '' } = {}) {
    const clip = (s, n) => String(s ?? '').trim().slice(0, n);
    const plan = clip(planText || activePlan, 500);
    const summaries = (historySummaries ?? []).filter(Boolean).join(' / ');
    const chatTail = formatChatLog(collectPlanningContext().chatList.slice(-6)).slice(-800);
    return [
        `## 检索任务\n${clip(topic, 120) || '判断本次剧情工作是否需要现实世界的具体事实'}`,
        `## 角色设定摘要\n${clip(characterSummary(200), 200) || '（无角色卡）'}`,
        plan ? `## 进行中剧情（节选）\n${plan}` : '',
        summaries ? `## 历史剧情摘要\n${clip(summaries, 300)}` : '',
        eventText ? `## 本次随机事件（节选）\n${clip(eventText, 200)}` : '',
        userNote ? `## 用户构思与要求\n${clip(userNote, 400)}` : '',
        revisionNote ? `## 修改意见（打回重写，判断检索方向时结合它）\n${clip(revisionNote, 300)}` : '',
        chatTail ? `## 最近对话节选\n${chatTail}` : '',
    ].filter(Boolean).join('\n\n');
}

/**
 * 联网检索管线：①判断调用（无工具）决定本次要不要联网、要查什么；②判「需要」才按
 * 它给的关键词直接调 Tavily（纯搜索 API，不耗模型 token），结果整理成纪要。
 * 判断与执行分离后，「逢开必搜」和「材料×轮数计费」一起消失，大模型工具循环整体退役
 * @returns {Promise<{notes:string, searchLogs:string[], reason:string, usage:object}>}
 *          usage 只含判断这一次调用的账单；notes 为空 = 本次未检索
 */
export async function runWebResearch(research = {}, { signal } = {}) {
    // preJudge 关 = 直查模式：轻量调用换「直接给关键词」提示词、必搜不判（判断关掉的是
    // 「要不要搜」这一问，轻量调用本身省不掉——关键词必须由模型产）
    const direct = settings.search?.preJudge === false;
    const gateUsage = { promptTokens: 0, completionTokens: 0 };
    let raw;
    try {
        raw = await chatCompletion({
            messages: [
                { role: 'system', content: direct ? GATE_DIRECT_PROMPT : GATE_SYSTEM_PROMPT },
                { role: 'user', content: buildResearchBrief(research) },
            ],
            signal,
            onUsage: u => { gateUsage.promptTokens = u.prompt_tokens ?? 0; gateUsage.completionTokens = u.completion_tokens ?? 0; },
        });
    } catch (err) {
        err.usage = { requests: 1, ...gateUsage };   // 判断失败的账单也带上（空内容报错时 onUsage 已先行记到）
        throw err;
    }
    const usage = { requests: 1, ...gateUsage };

    let verdict = null;
    try {
        verdict = extractJson(raw);   // 判断输出坏了（解析失败/结构不对）按「不需要」处理，宁可少搜不多搜
    } catch { /* 保持 null */ }
    const queries = (Array.isArray(verdict?.queries) ? verdict.queries : [])
        .map(q => String(q ?? '').trim()).filter(Boolean).slice(0, 3);
    if ((!direct && !verdict?.need) || !queries.length) {
        return { notes: '', searchLogs: [], reason: direct ? '未取得关键词' : String(verdict?.reason ?? '').slice(0, 40), usage };
    }

    const searchLogs = [];
    const blocks = [];
    for (const q of queries) {
        try {
            const results = await searchWeb(q);
            searchLogs.push(q);
            blocks.push(results.length
                ? `### ${q}\n` + results.slice(0, 3).map(r => `- ${r.title}（${r.url}）：${r.content.slice(0, 200)}`).join('\n')
                : `### ${q}\n（该关键词无结果）`);
        } catch (err) {
            blocks.push(`### ${q}\n（检索失败：${err.message}）`);
        }
    }
    return { notes: blocks.join('\n\n'), searchLogs, reason: String(verdict?.reason ?? '').slice(0, 40), usage };
}

/**
 * 预跑联网判断：在「分析前确认」页渲染时就开跑，用户核对材料的几秒正好把它跑完。
 * 返回 { fingerprint, promise }，采用条件是指纹（= 判断简报全文的哈希）仍与当时一致——
 * 换了随机事件、改了构思/修改意见、对话推进了，指纹都会对不上而自动作废重判
 */
export function startResearchPrefetch(research = {}) {
    const key = fingerprint(buildResearchBrief(research));
    const promise = runWebResearch(research);
    promise.catch(() => {});   // 没被采用就丢弃的预跑（取消向导/输入变了）不许弹「未处理的拒绝」
    return { fingerprint: key, promise };
}

// 规划分析的检索判断输入：runPlotGuidance 与向导预跑共用同一份拼装，指纹才对得上
export function guidanceResearchInputs(options = {}) {
    return {
        topic: '判断接下来的剧情规划是否需要现实世界的具体事实',
        userNote: options.userNote ?? '',
        eventText: options.eventText ?? '',
        activePlan: options.activePlan ?? '',
        historySummaries: options.historySummaries ?? [],
        revisionNote: options.revisionNote ?? '',
    };
}

// 剧情分析 / 检查报告的统一出口。搜索开着时在正式分析前多两小步：
// ① 判断——只发千字简报的一次无工具调用，决定本次要不要联网（默认不要）；
// ② 直查——判「要」才按它给的关键词调 Tavily（不耗模型 token），纪要附加进材料。
// 全套材料只在正式分析发一次（onDelta 提供时走流式，界面实时收字）；判断/检索失败都不拦分析。
// onStage('gate'|'analysis') 供界面标注当前等在哪一步；prefetch 指纹对得上就直接用预跑结果。
// signal（第八轮「中断」）一路传到 fetch；预跑的判断调用发出去就没法从外面掐，只能不等它。
// 返回 { text, usage, search }：usage＝本次全部调用的实报合计（判断+分析），界面留页展示
function raceAbort(promise, signal) {
    if (!signal) return promise;
    let onAbort = () => {};
    const guard = new Promise((_, reject) => {
        onAbort = () => { const e = new Error('已中断'); e.name = 'AbortError'; reject(e); };
        if (signal.aborted) return onAbort();
        signal.addEventListener('abort', onAbort, { once: true });
    });
    return Promise.race([promise, guard]).finally(() => signal.removeEventListener('abort', onAbort));
}

async function guidanceCompletion(messages, research = {}, { onDelta, onStage, prefetch, signal, onReasoning } = {}) {
    const total = { promptTokens: 0, completionTokens: 0, streamNoUsage: false };
    const add = u => {
        total.promptTokens += u?.promptTokens ?? u?.prompt_tokens ?? 0;
        total.completionTokens += u?.completionTokens ?? u?.completion_tokens ?? 0;
    };
    let search = null;
    let notes = '';

    if (settings.search?.enabled !== false && searchToolReady()) {
        try {
            onStage?.('gate');
            const key = fingerprint(buildResearchBrief(research));
            const r = prefetch && prefetch.fingerprint === key
                ? await raceAbort(prefetch.promise, signal)   // 预跑时输入与现在完全一致：直接采用
                : await runWebResearch(research, { signal });   // 输入变了（换事件/改构思/新修改意见）：重判
            add(r.usage);
            search = { searched: r.searchLogs.length > 0, queries: r.searchLogs.length, logs: r.searchLogs, reason: r.reason, direct: settings.search?.preJudge === false };
            notes = r.notes;
        } catch (err) {
            if (err.name === 'AbortError') throw err;
            add(err.usage);   // 判断阶段失败也可能已产生计费（如空内容报错），照实累计
            toastr.warning(`联网${settings.search?.preJudge === false ? '取关键词' : '判断'}失败，跳过检索继续分析：${err.message}`);
        }
    }

    const withNotes = notes
        ? messages.map(m => (m.role === 'user'
            ? { ...m, content: `${m.content}\n\n## 联网检索纪要（判断本次需要现实信息，已按关键词检索；仅供参考）\n${notes}` }
            : m))
        : messages;

    let analysisBilled = false;
    try {
        onStage?.('analysis');
        const text = await chatCompletion({
            messages: withNotes,
            signal,
            onUsage: u => { add(u); analysisBilled = true; },
            ...(onDelta ? { onDelta } : {}),
            ...(onReasoning ? { onReasoning } : {}),
        });
        total.streamNoUsage = Boolean(onDelta) && !analysisBilled;
        billToast(total, search);
        // messages（联网纪要已拼进正文的那份）一并带回：第二遍对齐审校复用同一份材料，
        // 联网不重判、检索不重跑（第十二轮）
        return { text, usage: total, search, messages: withNotes };
    } catch (err) {
        total.streamNoUsage = Boolean(onDelta) && !analysisBilled;
        billToast(total, search);   // 失败也要报真实账单：空内容报错时的输入/输出对账全靠它
        err.usage = { requests: (search ? 1 : 0) + 1, ...total };
        throw err;
    }
}

// 本地检索统计（向导第 1 步展示用；纯本地，不调模型）
// memoryTags / memoryModes / memoryRecent 语义与 buildGuidanceMessages 相同：
// 标签数组（只作用于「标签」档的表）、每表档位 {uid:'off'|'tags'|'always'}、标签档表尾最新窗口行数
// memorySheets：null = 全部（开了召回的表）；数组 = 只算勾选的表（空数组 = 一张都不带）
export function collectStats({ memoryTags = null, memorySheets = null, memoryModes = null, memoryRecent = 0 } = {}) {
    const { chatList, hits } = collectPlanningContext();
    const memChars = memoryTags === false ? 0 : buildMemoryContext({ tagFilter: memoryTags, sheetUids: memorySheets, sheetModes: memoryModes, latestPerSheet: memoryRecent }).length;
    return { layers: chatList.length, hits: hits.length, memChars };
}

// 记忆表格 / 游戏玩法小节的构建在 materials.js（与路人反应校准共用同一批口径）

// 路人反应小节：生效中的反应卡注入自动附带（分析与检查报告共用）；
// 向导第 1 步「计入规划材料」的反应卡（未注入）由 extraText 一并拼进来——
// 附带的正文就是主对话提示词里的同一份文本，规划/检查模型与主对话模型看到同一口径
function reactionSection(header, extraText = '') {
    const list = activeReactionInjections().map(i => String(i.content).trim()).filter(Boolean);
    const extra = String(extraText ?? '').trim();
    if (!list.length && !extra) return [];
    if (extra) list.push(extra);
    return [header, list.join('\n\n')];
}

/**
 * 组装剧情指导分析要发的 system/user 两条消息（runPlotGuidance 与「查看完整提示词」预览共用）。
 * @param {object} [options]
 * @param {string} [options.userNote]            用户剧情构思/补充说明
 * @param {string} [options.previousPlan]        打回重写时：上一版规划
 * @param {string} [options.revisionNote]        打回重写时：修改意见
 * @param {string} [options.eventText]           第 1 步「插入单元」勾选的事件单元正文（多单元已由
 *                                               调用方拼好；进「随机事件」小节，位置在剧情与反应之间）
 * @param {string} [options.reactionText]         第 1 步「插入单元」勾选的未注入反应单元正文
 *                                               （与生效中的反应注入合并进「路人反应」小节）
 * @param {Array}  [options.knowledgePayload]    知识库抓取载荷（knowledge.payloadFromIds 的返回；
 *                                               只进规划向导——随机事件/路人反应/检查报告不带，
 *                                               §6.9 清单只喂剧情规划类生成）。
 *                                               进「知识库材料」小节，第十三轮重排后垫在检索命中/最近对话之前（抽样轮换＝开头会变的小节）
 * @param {string} [options.activePlan]          进行中剧情全文（查重与进度对照）
 * @param {string[]} [options.historySummaries]  历史剧情摘要（查重用）
 * @param {*}      [options.memoryTags]          记忆表格召回标签：['a','b']=按标签（只作用于「标签」档的表），
 *                                               空数组=没勾标签, false=本次不附带
 * @param {*}      [options.memorySheets]        记忆表格表范围：null/缺省=全部（开了召回的表），
 *                                               数组=只带勾选的表（空数组=一张都不带）
 * @param {object} [options.memoryModes]         每表召回档位 { [uid]: 'off' 停用 | 'tags' 按标签 | 'always' 常驻全量 }：
 *                                               传了它档位优先，常驻表无视标签全量、停用表整张不带、
 *                                               标签档只带命中行（没勾标签时只走最新窗口）
 * @param {number} [options.memoryRecent]        「标签」档每表无论标签都另附的表尾最新行数；0=不另附
 * @param {Array}  [options.storageItems]        游戏玩法条目（{name, content}）：勾选后作为
 *                                               「游戏玩法」小节发给模型，规划须在其约束内设计
 */
// 供规划分析与检查报告共用的材料小节：
// 角色摘要 / 最近对话 / 世界书命中 / 记忆表格 / 游戏玩法 / 进行中剧情 / 路人反应 / 历史摘要。
// 小节本体在 materials.js（reactions.js / randomEvents.js 也直接用它，工具生成不走本函数——
// 已生效注入不自动进工具生成，防双算）；「路人反应」小节在这里插入，
// opts.reactionText = 第 1 步「插入单元」勾选的未注入反应单元正文（与生效注入合并成一节）。
// 注入模板序固定：剧情 → 事件 → 反应——反应小节插在进行中剧情之后（事件小节由
// buildGuidanceMessages 再插在两者中间），不给排顺序的旋钮
// 第十三轮插入锚点：剧情类插入小节统一锚在「历史剧情摘要」之前（无摘要时退到检索命中/
// 最近对话之前）——材料重排后这三节是「开头会变」的垫底小节，插在它们之前才留在稳定区、
// 不破跨调用缓存。剧情→事件→反应相邻序保持：反应锚稳定区头、事件锚反应之前
const stableTailIdx = parts => parts.findIndex(p => p.startsWith('## 历史剧情摘要')
    || p.startsWith('## 检索命中的世界书条目')
    || p.startsWith('## 最近对话记录'));

export function materialSections(opts = {}) {
    const { parts, hits } = baseMaterialSections(opts);
    const at = stableTailIdx(parts);
    parts.splice(at === -1 ? parts.length : at, 0,
        ...reactionSection('## 路人反应（世界对引人注目之事的回应口径，后续剧情安排与其余波、收束口径一致）', opts.reactionText));
    return { parts, hits };
}

export function buildGuidanceMessages(options = {}) {
    const { userNote = '', previousPlan = '', revisionNote = '', eventText = '', reactionText = '', knowledgePayload = [], activePlan = '', historySummaries = [], memoryTags = null, memorySheets = null, memoryModes = null, memoryRecent = 0, storageItems = [], lorePicks = [], draftSkeletons = [] } = options;
    const { parts, hits } = materialSections({ memoryTags, memorySheets, memoryModes, memoryRecent, storageItems, activePlan, historySummaries, reactionText, lorePicks });
    // 知识库材料小节与近期草稿骨架（第七轮防复刻：连 roll 收敛的根因＝放弃的草稿不在任何
    // 往后看的材料里，对话/记忆/历史摘要都只记正式剧情）同锚插在检索命中之前——第十三轮
    // 重排：知识库抽样分组每把轮换换新＝「开头会变」的小节，与检索命中/对话一起垫底，别让
    // 它断掉前面稳定小节的缓存；骨架（少变）排在知识库（每把换新）之前。同锚一次插入：
    // 分两次 findIndex 的话先插的一节会让锚点后移、后插的落到它后面去
    const skeletons = (draftSkeletons ?? []).filter(Boolean);
    const kbSection = knowledgeSection(knowledgePayload);
    if (kbSection || skeletons.length) {
        const idx = parts.findIndex(p => p.startsWith('## 检索命中的世界书条目') || p.startsWith('## 最近对话记录'));
        parts.splice(idx === -1 ? parts.length : idx, 0,
            ...(skeletons.length ? [
                '## 近期草稿骨架（防复刻清单：近期被放弃或换掉的规划草稿，各版一句话概括与节点阶段名——新规划的走向与节点安排不得与其中任何一份高度雷同）',
                skeletons.map((s, i) => `${i + 1}. ${s}`).join('\n'),
            ] : []),
            ...(kbSection ?? []));
    }
    // 注入模板序固定：剧情 → 事件 → 反应——事件小节插在路人反应之前（无反应小节时退到
    // 稳定区头，仍在检索命中/对话之前），顺序不提供旋钮
    const evt = String(eventText ?? '').trim();
    if (evt) {
        const rIdx = parts.findIndex(p => p.startsWith('## 路人反应'));
        const at = rIdx !== -1 ? rIdx : stableTailIdx(parts);
        parts.splice(at === -1 ? parts.length : at, 0, '## 随机事件（本次规划需要融入的事件与走向）', evt);
    }
    const all = [
        ...parts,
        // 重新生成的两副面孔（第七轮）：带修改意见＝按意见修订；意见为空＝换一版（上一版随行只是
        // 为了不与它雷同，不是让它照着续写）——原来无脑「请按修改意见修订」会把模型锚定在上一版上复读
        ...(previousPlan ? [String(revisionNote ?? '').trim()
            ? '## 上一版规划（请按修改意见修订）'
            : '## 上一版规划（换一版：不要沿用它的骨架与内容安排，另行设计——修改意见为空＝要的是全新一版，不是修订）', previousPlan] : []),
        ...(revisionNote ? ['## 修改意见', revisionNote] : []),
        ...(userNote ? ['## 用户剧情构思与补充说明', userNote] : []),
    ];
    const userContent = all.join('\n\n');

    // 逐小节精确字数（「查看完整提示词」预览展示用）：数组按「标题、正文」交替排布。
    // 统计的是字符数不是 token 估算——世界书一节偏小，说明大部分词条没被关键词带出。
    // header/body 随条带回：预览的悬浮查看器按小节分块折叠，每块要有自己的正文
    const sections = [];
    for (let i = 0; i < all.length; i += 2) {
        sections.push({
            title: all[i].replace(/^## /, '').replace(/（.*$/, ''),
            header: all[i],
            body: all[i + 1] ?? '',
            chars: all[i].length + (all[i + 1]?.length ?? 0),
        });
    }

    // 节点下限（第七轮方案⑤）：设置项「规划节点下限」，0 = 不设；用户构思点名数量时以构思为准
    // （提示词里已写明点名的按不少于落实，这里的 minBeats 只是没点名时的兜底）
    const minBeats = Math.min(50, Math.max(0, Math.round(Number(settings.guidance?.minBeats) || 0)));
    return {
        // 预设不在这里拼：启用中的由 chatCompletion 出口统一附加（api.withGlobalPresets），
        // 预览侧用同一个函数拼装，保证「看到的」与「发出的」一致
        system: guidanceSystemPrompt(Boolean(String(activePlan ?? '').trim()), Boolean(kbSection), skeletons.length > 0, minBeats),
        user: userContent,
        hits: hits.length,
        hasKnowledge: Boolean(kbSection),   // 第二遍对齐审校的 schema 要带同款 knowledgeUsed 字段（第十二轮）
        sections,
    };
}

/**
 * 运行一次剧情规划分析（检查 + 设计）。参数见 buildGuidanceMessages。
 * 第十二轮起默认两遍调用：第一遍生成，第二遍对齐审校（alignPass，用户拍板「第一次生成、
 * 第二次对齐要求修改」治时间错位）——设置「生成后对齐修改（第二遍）」可关。
 * @param {AbortSignal} [options.signal]       中断（运行页「中断」键）：一路传到 fetch；第二遍中途
 *                                             中断＝保留第一遍结果交付，不整轮报废
 * @param {(reasonText:string)=>void} [options.onReasoning] 流式思考增量累计回调，收思考全文（两遍拼接，
 *                                             【第二遍思考】分节；长度即字数；诊断「关闭思考」是否被执行）
 * @returns {Promise<{result: object, raw: string, hits: number, usage: object, search: object|null}>}
 *          result.fixes＝第二遍逐条改动清单、result.alignState＝'done'|'failed'|'aborted'（第二遍
 *          未运行时无此键）；usage/search＝两遍全部调用的实报合计与检索信息（界面留页展示用）
 */
export async function runPlotGuidance(options = {}) {
    const { system, user, hits, hasKnowledge } = buildGuidanceMessages(options);
    // 思考全文先经这里过一手：第二遍的思考要与第一遍拼接后再上屏，计数才是两遍合计
    let reasonSoFar = '';
    const onReasoning = options.onReasoning
        ? t => { reasonSoFar = String(t ?? ''); options.onReasoning(reasonSoFar); }
        : undefined;
    const first = await guidanceCompletion(
        [
            { role: 'system', content: system },
            { role: 'user', content: user },
        ],
        guidanceResearchInputs(options),
        { onDelta: options.onDelta, onStage: options.onStage, prefetch: options.researchPrefetch, signal: options.signal, onReasoning },
    );
    let result;
    try {
        result = extractJson(first.text);
    } catch (err) {
        err.raw = first.text;   // 解析失败也把原始输出附到错误上，方便上层展示排查
        throw err;
    }
    const done = { result, raw: first.text, hits, usage: first.usage, search: first.search };
    if (settings.guidance?.alignPass === false || !result?.plan) return done;
    return alignPass(done, first.messages, {
        hasKnowledge,
        onDelta: options.onDelta,
        onStage: options.onStage,
        signal: options.signal,
        onReasoning: options.onReasoning ? t => { reasonSoFar += `\n\n【第二遍思考】\n${t}`; options.onReasoning(reasonSoFar); } : undefined,
    });
}

// 第二遍对齐审校（第十二轮）：同一份材料（联网纪要已在正文里，联网不重判）＋第一遍 plan 草稿
// 再发一次。只改违反四类要求的地方（见 alignTailPrompt）；失败/被中断不报废第一遍——
// 结果照常交付、alignState 如实标注，两遍计费都实报累计（中断前已生成的部分服务商照常计费）
// 第十三轮尾巴化：messages 原样保留、不再换 system——第二遍请求与第一遍逐字节共享前缀，
// 支持前缀缓存的服务商（DeepSeek/部分中转）第二遍的输入大头走缓存价；审校指令以追加尾巴
// 挂在最后一条 user 消息末尾（联网纪要之后、第一遍草稿之前），差异只出现在请求最末尾
async function alignPass(done, messages, { hasKnowledge = false, onDelta, onStage, signal, onReasoning } = {}) {
    const draft = done.result.plan;
    const tail = `${alignTailPrompt(hasKnowledge)}\n\n## 第一遍草稿（对齐审校的对象——只改违反要求处，其余原样保留）\n${JSON.stringify(draft, null, 2)}`;
    const lastUser = messages.map(m => m.role === 'user').lastIndexOf(true);
    const alignMessages = messages.map((m, i) => (i === lastUser
        ? { ...m, content: `${m.content}\n\n${tail}` }
        : m));
    const alignUsage = { promptTokens: 0, completionTokens: 0 };
    const mergeBill = () => {
        done.usage = {
            ...done.usage,
            promptTokens: (done.usage?.promptTokens ?? 0) + alignUsage.promptTokens,
            completionTokens: (done.usage?.completionTokens ?? 0) + alignUsage.completionTokens,
        };
    };
    let alignBilled = false;
    const billText = () => (alignUsage.promptTokens || alignUsage.completionTokens)
        ? `两遍合计输入 ${done.usage.promptTokens.toLocaleString()} · 输出 ${done.usage.completionTokens.toLocaleString()} tokens（实报）`
        : (onDelta ? '第二遍流式未回传 usage，无第二遍实报数字' : '');
    try {
        onStage?.('align');
        const text = await chatCompletion({
            messages: alignMessages,
            signal,
            onUsage: u => {
                alignUsage.promptTokens += u?.prompt_tokens ?? 0;
                alignUsage.completionTokens += u?.completion_tokens ?? 0;
                alignBilled = true;
            },
            ...(onDelta ? { onDelta } : {}),
            ...(onReasoning ? { onReasoning } : {}),
        });
        const parsed = extractJson(text);
        if (!parsed?.plan || !Array.isArray(parsed.plan.beats)) throw new Error('第二遍输出里没有可用的 plan');
        done.result = { ...done.result, plan: parsed.plan };
        done.result.fixes = (Array.isArray(parsed.fixes) ? parsed.fixes : []).map(f => String(f ?? '').trim()).filter(Boolean);
        done.result.alignState = 'done';
        if (onDelta && !alignBilled) done.usage = { ...done.usage, streamNoUsage: true };
        mergeBill();
        toastr.info(`第二遍对齐修改完成：${done.result.fixes.length ? `改动 ${done.result.fixes.length} 处（第 3 步「第二遍对齐修改」行有逐条清单）` : '草稿本就全对，未改动'}${billText() ? `；${billText()}` : ''}`);
    } catch (err) {
        mergeBill();   // 失败/中断前已计费的照实累计（空内容报错的输入账单不吞）
        if (err.name === 'AbortError') {
            done.result.alignState = 'aborted';
            toastr.info('第二遍对齐修改被中断：保留第一遍结果交付（中断前已生成的部分服务商照常计费）');
        } else {
            done.result.alignState = 'failed';
            toastr.warning(`第二遍对齐修改失败（${String(err.message ?? err)}）——保留第一遍结果交付`);
        }
    }
    return done;
}

/**
 * 检查报告：对照进行中剧情与最近对话，输出完成度/推进/文风/OOC/其他问题/建议。
 * 当前生效的游戏玩法条目与路人反应卡自动附带（与主对话注入同一判定），检查执行情况时对照它们。
 * 记忆表格口径继承向导第 1 步（调用方从对话记忆的 picks 块读来传入）：单人卡全量无感；
 * 群像卡只查同类事件重复、无关事件不计入；不带参数 = 全量（老口径兜底）。
 * @param {object} [options]
 * @param {string} options.planText        进行中剧情全文
 * @param {string} [options.userNote]      补充说明
 * @param {*}      [options.memoryTags]    第 1 步勾的标签（数组；null/[] 语义同 buildMemoryContext）
 * @param {object} [options.memoryModes]   第 1 步的每表档位 { [uid]: 'off'|'tags'|'always' }
 * @param {number} [options.memoryRecent]  「标签」档每表另附的表尾最新行数
 */
export async function runStoryReview({ planText = '', userNote = '', memoryTags = null, memoryModes = null, memoryRecent = 0, onDelta, onStage, signal, onReasoning } = {}) {
    const { chatList, hits } = collectPlanningContext();
    if (!chatList.length) throw new Error('当前没有可分析的聊天记录');

    const memoryText = buildMemoryContext({ tagFilter: memoryTags, sheetModes: memoryModes, latestPerSheet: memoryRecent });

    // 第十三轮重排（与 buildGuidanceMessages 同款原则）：检查对象/玩法/反应/记忆这些跨次
    // 调用稳定的小节在前，检索命中（按最近楼层重扫）与最近对话（滑动窗口）垫底
    const userContent = [
        '## 角色设定摘要',
        characterSummary() || '（无角色卡）',
        '## 正在执行的剧情规划（检查对象）',
        String(planText || '（空）'),
        ...gameplaySection(storageItemsInEffect(), '## 游戏玩法（当前生效的玩法规则，检查执行情况时对照它）'),
        ...reactionSection('## 路人反应（当前生效的反应卡，检查执行情况时对照它）'),
        ...(memoryText ? [memorySectionHeader(memoryTags, '已有剧情事件记录，用于查重与推新参考', memoryRecent, memoryModes), memoryText] : []),
        '## 检索命中的世界书条目',
        buildLoreContext(hits),
        '## 最近对话记录',
        formatChatLog(chatList),
        ...(userNote ? ['## 用户补充说明', userNote] : []),
    ].join('\n\n');

    const messages = [
        { role: 'system', content: REVIEW_SYSTEM_PROMPT },
        { role: 'user', content: userContent },
    ];
    const research = {
        topic: '判断检查剧情执行情况是否需要核对现实世界信息',
        userNote,
        planText: String(planText || ''),
    };
    const stream = { onDelta, onStage, signal, onReasoning };
    // 账单跨两次调用累计（首次分析＋坏输出的修复重试），报告页留页展示用
    const acc = { promptTokens: 0, completionTokens: 0, streamNoUsage: false };
    const accAdd = u => {
        acc.promptTokens += u?.promptTokens ?? 0;
        acc.completionTokens += u?.completionTokens ?? 0;
        acc.streamNoUsage = acc.streamNoUsage || Boolean(u?.streamNoUsage);
    };
    const first = await guidanceCompletion(messages, research, stream);
    accAdd(first.usage);
    const raw = first.text;
    try {
        // 坏输出带修复提示回炉一次；call 仍走 guidanceCompletion，联网判断与账单口径不变
        const parsed = await parseModelJson(raw, {
            messages,
            call: async req => {
                const r = await guidanceCompletion(req.messages, research, stream);
                accAdd(r.usage);
                return r.text;
            },
        });
        return { result: parsed.result, raw: parsed.raw, hits: hits.length, usage: acc, search: first.search };
    } catch (err) {
        err.raw ??= raw;   // 解析失败也把原始输出附到错误上，方便上层展示排查
        throw err;
    }
}
