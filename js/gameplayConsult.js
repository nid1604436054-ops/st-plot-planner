// 玩法咨询（向导第 1 步「游戏玩法」区的 AI 生成）：用户给一句大概思路，模型扩写成一份
// 完整、可直接执行的玩法规则，可改后存进玩法条目库（settings.storageItems，store.js）。
// 材料刻意轻量——不复用向导第 1 步的整套材料面板：角色摘要/最近对话/世界书命中是
// materialSections 的固定底座（本地检索，不花调用），调用方只按需追加进行中剧情与
// 已勾选的现有玩法；记忆表格那类既往事件流水对玩法设计没用，一律不带。
// 预设已全局化，由 chatCompletion 出口自动附带
import { chatCompletion } from "./api.js";
import { materialSections } from "./materials.js";

const CONSULT_SYSTEM_PROMPT = '你是文字角色扮演的玩法设计师。用户会给你一条玩法的「大概思路」与相关材料（角色设定摘要、最近对话、检索命中的世界书条目，可能还有进行中剧情与现有玩法），你把思路扩写成一份完整、可直接执行的玩法规则，给主对话模型在角色扮演中执行。要求：'
    + '一、条目式写全：玩法目标；何时触发、如何开始；进行流程与回合结构；判定或随机要素的处理办法（文字角色扮演没有外部工具——需要随机时写明由模型代掷并如实报点，或按叙事逻辑裁定，二选一写死）；成功、失败各自的后果；奖励或代价；结束条件。'
    + '二、写给执行者：指令式条目，直接说「怎么做、怎么判」，不写设计理由，不写给人看的说明书。'
    + '三、与材料兼容：不与世界观、角色设定、进行中剧情、现有玩法冲突，能自然嵌进当前剧情阶段更好。'
    + '四、user 是玩法的一方：对其行动的判定要公平，保留其选择权，不得借规则剥夺 user 的行动自由或把它逼进不可逆处境；危机可以有，出口必须有。'
    + '只输出规则正文（条目可用小标题分节），不要输出玩法名、解释、前言或结尾。总长 300-800 字。';

/**
 * 把一句玩法思路扩写成完整可执行的玩法规则（纯文本，不带 JSON 包壳）。
 * 底座材料固定（角色摘要/最近对话/世界书命中），追加项由调用方勾选：
 * activePlan 传空 = 不带进行中剧情，storageItems 传空数组 = 不带现有玩法。
 * @param {object} [options]
 * @param {string} [options.idea]         玩法的大概思路（一句话方向）
 * @param {string} [options.activePlan]   进行中剧情全文（空串 = 不附带）
 * @param {Array}  [options.storageItems] 现有玩法条目（{name, content}，空数组 = 不附带）
 * @returns {Promise<string>} 规则正文
 */
export async function generateGameplayDraft({ idea = '', activePlan = '', storageItems = [] } = {}) {
    const { parts } = materialSections({
        memoryTags: false,   // 玩法设计用不上记忆表格的既往事件流水
        storageItems,
        activePlan: String(activePlan ?? '').trim(),
        headers: {
            gameplay: '## 现有玩法（已定规则，新玩法不得与其冲突，能衔接更好）',
            activePlan: '## 进行中剧情（新玩法须贴合当前剧情阶段，不与其走向冲突）',
        },
    });
    const user = [
        ...parts,
        '## 任务',
        '把下面的玩法思路扩写成完整、可直接执行的玩法规则；思路没说到的地方按材料合理补全，不要留「待定」。',
        `## 玩法思路\n${String(idea ?? '').trim()}`,
    ].filter(Boolean).join('\n\n');

    const raw = await chatCompletion({
        messages: [
            { role: 'system', content: CONSULT_SYSTEM_PROMPT },
            { role: 'user', content: user },
        ],
    });
    return String(raw ?? '').trim();
}
