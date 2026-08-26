// M3 随机事件（三层结构）：维度层（骨架/方向池）→ 条目层（事件库）→ 掷骰管线
// 掷骰三板块并行（事件条目 / 维度随机 / AI 自主）：先在勾选且有货的板块里按板块权重抽一个，
// 条目板块按「权重×概率」加权抽一条（必出），随机板块按维度权重抽方向，AI 自主板块由模型挑维度。
// 设计取向（吸收用户 NPC_Reaction 预设）：轻重有别（轻＝一根针，重＝一个局）、宁重不轻、
// 危机可重但出口必须存在、密度受控（同维度连出两次暂停一轮、最近事件防重复）。
import { chatCompletion, parseModelJson } from "./api.js";
import { collectRecentChat, formatChatLog, currentFloor } from "./context.js";
import { settings, save, newId } from "./settings.js";
import { materialSections } from "./materials.js";
import { storyState, activeStory } from "./story.js";

const EVENT_SYSTEM_PROMPT = '你是文字角色扮演的随机遭遇生成器。基于当前情境与给定的事件方向，'
    + '生成一次合理的意外遭遇（动态事件而非预编排剧本），并给出若干可选走向。'
    + '事件要写成已经发生的既成事实，不写「可能会发生」；提供方向，不提供剧情，拉不拉、怎么拉由 user 决定。'
    + '字符串值里不要出现英文双引号（引用一律写中文「」），也不要在值内换行。'
    + '只输出一个 JSON 对象，不要输出 JSON 以外的任何文字：\n'
    + '{ "title": "事件标题", "description": "遭遇描述（150 字内）", '
    + '"options": [ { "label": "选项名", "hint": "选后的幕后走向提示" } ] }\n'
    + 'options 给 3 个左右。';

// 轻重是执行口径：轻的过轻会执行敷衍，所以默认宁重不轻；但重的必须留出口
const SEVERITY_HINT = {
    light: '本次事件走「轻」：一根针，点到即止，不自带走向，不喧宾夺主。',
    heavy: '本次事件走「重」：一个局，不处理会发酵；但出口必须存在，收束权在 user。',
};
const BOUNDARY_HINT = '底线：不得导致感情实质破裂、主要角色受异性实质侵犯、user 无法逆转的损失；'
    + '可接受的余波：虚惊一场、轻微受伤、舆情压力、短期经济困难、身份暴露。';

export function defaultEventRules() {
    return [
        { id: newId('ev-'), name: '偶遇旧识', enabled: true, probability: 0.3, weight: 1, cooldownLayers: 30, dimension: 'dim-rel', severity: 'light', keywords: '', promptHint: '一个与主角有旧怨或旧情的次要角色意外出现，带来新的张力' },
        { id: newId('ev-'), name: '环境突变', enabled: true, probability: 0.2, weight: 1, cooldownLayers: 20, dimension: 'dim-env', severity: 'light', keywords: '', promptHint: '天气、人流或周围环境发生显著变化，迫使剧情转向' },
        { id: newId('ev-'), name: '意外阻碍', enabled: true, probability: 0.2, weight: 1, cooldownLayers: 20, dimension: 'dim-friction', severity: 'light', keywords: '', promptHint: '一件小意外打断当前行动（丢失物品、临时状况、陌生人搭话）' },
        { id: newId('ev-'), name: '有利线索', enabled: true, probability: 0.15, weight: 1, cooldownLayers: 40, dimension: 'dim-favor', severity: 'light', keywords: '', promptHint: '主角意外获得一条与当前目标相关的有用线索或机会' },
        { id: newId('ev-'), name: '意外之喜', enabled: true, probability: 0.15, weight: 1, cooldownLayers: 30, dimension: 'dim-favor', severity: 'light', keywords: '', promptHint: '中奖、多送、捡到东西级别的小惊喜，被世界温柔对待一下，点到即止' },
        { id: newId('ev-'), name: '临时邀约', enabled: true, probability: 0.15, weight: 1, cooldownLayers: 40, dimension: 'dim-chance', severity: 'heavy', keywords: '', promptHint: '招人、比赛、演出、递名片式的新机会找上门，给 user 一个可拉可不拉的新方向' },
        { id: newId('ev-'), name: '他人求助', enabled: true, probability: 0.12, weight: 1, cooldownLayers: 40, dimension: 'dim-env', severity: 'heavy', keywords: '', promptHint: '路人向主角求助或主角撞进旁人的麻烦，事件提供方向不提供剧情' },
        { id: newId('ev-'), name: '曝光被识别', enabled: true, probability: 0.1, weight: 1, cooldownLayers: 50, dimension: 'dim-friction', severity: 'heavy', keywords: '', promptHint: '主角的某个身份或行为被认出、开始扩散，不处理会发酵，但总有办法收场' },
    ];
}

export function dimNameOf(id) {
    return (settings.eventDimensions ?? []).find(d => d.id === id)?.name ?? '未分组';
}

function keywordList(rule) {
    return String(rule.keywords ?? '').split(/[,，、;；]/).map(s => s.trim()).filter(Boolean);
}

function ruleOnCooldown(rule, floor) {
    const cd = Math.max(Number(rule.cooldownLayers) || 0, 0);
    return cd > 0 && rule.lastFloor != null && floor - rule.lastFloor < cd;
}

function weightedPick(list, rng, weightOf = x => Math.max(Number(x.weight) || 0, 0)) {
    const total = list.reduce((s, x) => s + weightOf(x), 0);
    if (total <= 0) return list[Math.floor(rng() * list.length)];
    let pick = rng() * total;
    for (const x of list) {
        pick -= weightOf(x);
        if (pick <= 0) return x;
    }
    return list[list.length - 1];
}

/**
 * 掷骰管线（纯掷骰，无副作用；生成成功后由调用方 commitRolledEvent 落账）。
 * 三板块并行：先按板块权重抽一个板块，再走该板块的抽取逻辑；没勾选或没货的板块不参与。
 * @returns {{mode:'library', rule:object, dimension:object}|{mode:'free', dimension:object}|{mode:'ai', dimensions:object[]}|{mode:'none', reason:string}}
 */
export function rollEventPipeline(rng = Math.random) {
    const dims = (settings.eventDimensions ?? []).filter(d => d.enabled !== false);
    if (!dims.length) return { mode: 'none', reason: '没有启用的维度' };

    // 密度规则：同一维度连出两次后，这一轮暂停该维度（没有别的维度时忽略）
    const recent = settings.events?.recent ?? [];
    const pausedId = recent.length >= 2 && recent[0]?.dimension && recent[0].dimension === recent[1]?.dimension
        ? recent[0].dimension : null;
    const dimPool = pausedId ? dims.filter(d => d.id !== pausedId) : dims;
    const openDims = dimPool.length ? dimPool : dims;

    const floor = currentFloor();
    const scanText = formatChatLog(collectRecentChat(settings.retrieval.scanDepth)).toLowerCase();
    const eligible = (settings.eventRules ?? []).filter(r => {
        if (r.enabled === false) return false;
        if (!openDims.some(d => d.id === r.dimension)) return false;
        if (ruleOnCooldown(r, floor)) return false;
        const kws = keywordList(r);
        return !kws.length || kws.some(k => scanText.includes(k.toLowerCase()));
    });

    // 三板块抽取：勾选且有货的板块按板块权重抽一个（全 0 权重时等机会）
    const branchOn = key => settings.events?.branches?.[key]?.enabled !== false;
    const branchW = key => Math.max(Number(settings.events?.branches?.[key]?.weight) || 0, 0);
    const branches = [];
    if (branchOn('entries') && eligible.length) branches.push({ key: 'entries', weight: branchW('entries') });
    if (branchOn('free') && openDims.length) branches.push({ key: 'free', weight: branchW('free') });
    if (branchOn('ai') && openDims.length) branches.push({ key: 'ai', weight: branchW('ai') });
    if (!branches.length) return { mode: 'none', reason: '没有可用的掷骰板块（都没勾选，或勾选的板块没货）' };

    const branch = weightedPick(branches, rng, b => b.weight);
    if (branch.key === 'entries') {
        // 触发概率并入权重参与抽取：概率只改变相对命中率，掷骰必出一条（全 0 时退化为等权抽一）
        const rule = weightedPick(eligible, rng,
            r => Math.max(Number(r.weight) || 0, 0) * Math.max(Number(r.probability) || 0, 0));
        return { mode: 'library', rule, dimension: dims.find(d => d.id === rule.dimension) ?? null };
    }
    if (branch.key === 'free') return { mode: 'free', dimension: weightedPick(openDims, rng) };
    return { mode: 'ai', dimensions: openDims };   // 密度暂停的维度已从清单剔除，AI 自主也只能从中选
}

/**
 * 掷骰结果落账：条目记冷却楼层 + 最近事件列表（供防重复与密度规则）。
 * 生成调用成功后才调用。
 */
export function commitRolledEvent({ rule = null, dimension = null, title = '', source = 'library' } = {}) {
    if (rule) rule.lastFloor = currentFloor();
    (settings.events ??= {}).recent ??= [];
    settings.events.recent.unshift({
        title: String(title || rule?.name || '').slice(0, 40),
        dimension: dimension?.id ?? rule?.dimension ?? '',
        source, at: Date.now(),
    });
    settings.events.recent = settings.events.recent.slice(0, 12);
    save();
}

export function recentEventTitles(limit = 8) {
    return (settings.events?.recent ?? []).slice(0, limit).map(r => r.title).filter(Boolean);
}

// 三类生成调用共享的上下文小节。材料与向导第 1 步完全同一批（materialSections）：
// 角色摘要 / 对话 / 世界书命中 / 记忆表格 / 游戏玩法 / 进行中剧情 / 历史摘要，
// 再追加事件专属小节（最近事件防重复 + 底线）。materials 由向导传入（记忆表范围/标签、
// 玩法勾选用第 1 步的本次选择）；预设已全局化，由 chatCompletion 出口自动附带。
// 单元制口径：已生效注入不自动进工具生成（防双算）——想让路人反应的单元影响本次事件，
// 走显式导入（materials.importedUnits，唯一影响通道）；材料小节从 materials.js 直取，
// 不再经 planner.js 的「路人反应」注入小节
function contextSections(materials = {}) {
    const s = storyState();
    const { parts } = materialSections({
        memoryTags: materials.memoryTags ?? null,
        memorySheets: materials.memorySheets ?? null,
        memoryModes: materials.memoryModes ?? null,
        memoryRecent: materials.memoryRecent ?? 0,
        storageItems: materials.storageItems ?? [],
        activePlan: activeStory()?.planText ?? '',
        historySummaries: s.history.filter(h => h.id !== s.activeId).map(h => h.summary),
    });
    const imported = (materials.importedUnits ?? [])
        .map(u => String(u?.text ?? '').trim()).filter(Boolean);
    const recent = recentEventTitles();
    return [...parts,
        ...(imported.length ? ['## 导入单元（来自路人反应工具的暂存产物，仅作参考材料，不是既成事实）', imported.join('\n\n')] : []),
        '## 最近已出过的事件（不要重复相近情节）',
        recent.length ? recent.map(t => `- ${t}`).join('\n') : '（暂无记录）',
        '## 底线',
        BOUNDARY_HINT,
    ];
}

// 预设不再在这里拼：启用中的由 chatCompletion 出口统一附加（api.withGlobalPresets）

/**
 * 按事件库条目生成一次随机事件。materials 见 contextSections（第 1 步的本次材料选择）。
 * @returns {Promise<{title:string, description:string, options:Array<{label:string, hint:string}>}>}
 */
export async function generateRandomEvent(rule, materials = {}) {
    const sections = [...contextSections(materials), '## 事件方向',
        `维度「${dimNameOf(rule.dimension)}」｜条目「${rule.name}」：${rule.promptHint ?? ''}`,
        SEVERITY_HINT[rule.severity] ?? SEVERITY_HINT.light].join('\n\n');

    const request = {
        messages: [
            { role: 'system', content: EVENT_SYSTEM_PROMPT },
            { role: 'user', content: sections },
        ],
    };
    const raw = await chatCompletion(request);
    const { result } = await parseModelJson(raw, request);   // 坏输出带修复提示回炉一次
    return result;
}

/**
 * 大模型自由随机：不经事件库掷骰，让模型即兴出一次意外遭遇（随机事件工具面板的「大模型随机」键 / 掷骰管线的自由分支）。
 * @param {object} [options]
 * @param {object} [options.dimension]      维度对象 {name, prompt}：按维度气质即兴
 * @param {boolean} [options.useLibrary]    true 时把事件库条目列给模型参考（可从中选方向也可另起）
 */
export async function generateFreeRandomEvent({ dimension = null, useLibrary = false, materials = {} } = {}) {
    const schema = '{ "title": "事件标题", "description": "遭遇描述（150 字内）", '
        + '"options": [ { "label": "选项名", "hint": "选后的幕后走向提示" } ] }';

    const system = '你是文字角色扮演的随机遭遇生成器。基于当前情境即兴生成一次合理的意外遭遇（动态事件而非预编排剧本），并给出若干可选走向。'
        + '事件要写成已经发生的既成事实，不写「可能会发生」；提供方向，不提供剧情，拉不拉、怎么拉由 user 决定。'
        + '轻重自定、宁重不轻（过轻会执行敷衍），但危机必须留出口。'
        + (dimension ? '用户指定了维度，按该维度的气质展开。' : '')
        + (useLibrary ? '用户提供了事件库条目，可从中选一个方向展开，也可另起更契合当前情境的事件。' : '')
        + '字符串值里不要出现英文双引号（引用一律写中文「」），也不要在值内换行。'
        + '只输出一个 JSON 对象，不要输出 JSON 以外的任何文字：\n'
        + schema + '\noptions 给 3 个左右。';

    const sections = contextSections(materials);
    if (dimension) {
        sections.push('## 事件方向（维度自由生成）', `维度「${dimension.name}」：${dimension.prompt ?? ''}\n按这个维度的气质即兴出一次事件。`);
    }
    if (useLibrary) {
        const rules = (settings.eventRules ?? []).filter(r => r.enabled !== false);
        sections.push('## 事件库条目（参考方向）', rules.length
            ? rules.map(r => `- ${r.name}：${r.promptHint ?? ''}`).join('\n')
            : '（事件库为空，请即兴生成）');
    }

    const request = {
        messages: [
            { role: 'system', content: system },
            { role: 'user', content: sections.join('\n\n') },
        ],
    };
    const raw = await chatCompletion(request);
    const { result } = await parseModelJson(raw, request);   // 坏输出带修复提示回炉一次
    return result;
}

/**
 * AI 自主板块：把候选维度清单交给模型，由它结合当前剧情挑最贴合的一个，按该维度气质即兴事件。
 * 挑选与生成在同一次调用里完成，不额外花调用。
 * @param {object} [options]
 * @param {object[]} [options.dimensions]  候选维度对象数组（密度暂停的维度已由管线剔除）
 * @returns {Promise<{title:string, description:string, dimension:string, options:Array<{label:string, hint:string}>}>}
 */
export async function generateAiChoiceRandomEvent({ dimensions = [], materials = {} } = {}) {
    const system = '你是文字角色扮演的随机遭遇生成器。基于当前情境即兴生成一次合理的意外遭遇（动态事件而非预编排剧本），并给出若干可选走向。'
        + '事件要写成已经发生的既成事实，不写「可能会发生」；提供方向，不提供剧情，拉不拉、怎么拉由 user 决定。'
        + '用户给出了维度清单：由你判断哪个维度最贴合当前剧情氛围，从中挑一个（只能挑清单里的），按它的气质展开。'
        + '轻重自定、宁重不轻（过轻会执行敷衍），但危机必须留出口。'
        + '字符串值里不要出现英文双引号（引用一律写中文「」），也不要在值内换行。'
        + '只输出一个 JSON 对象，不要输出 JSON 以外的任何文字：\n'
        + '{ "title": "事件标题", "description": "遭遇描述（150 字内）", '
        + '"dimension": "你选用的维度名（必须与清单里的一致）", '
        + '"options": [ { "label": "选项名", "hint": "选后的幕后走向提示" } ] }\n'
        + 'options 给 3 个左右。';

    const sections = contextSections(materials);
    sections.push('## 维度清单（从中挑最贴合当前剧情的一个）',
        dimensions.length ? dimensions.map(d => `- ${d.name}：${d.prompt ?? ''}`).join('\n') : '（清单为空，请即兴生成，dimension 填「即兴」）');

    const request = {
        messages: [
            { role: 'system', content: system },
            { role: 'user', content: sections.join('\n\n') },
        ],
    };
    const raw = await chatCompletion(request);
    const { result } = await parseModelJson(raw, request);   // 坏输出带修复提示回炉一次
    return result;
}

/**
 * AI 建库：按维度批量设计事件条目（名称/提示/轻重），供界面勾选后导入事件库。
 * @returns {Promise<Array<{name:string, promptHint:string, severity:'light'|'heavy'}>>}
 */
export async function generateEventEntries({ dimension, count = 5, note = '' } = {}) {
    const n = Math.min(Math.max(Number(count) || 5, 1), 10);
    const system = '你是文字角色扮演随机事件库的设计师，为给定「维度」批量设计事件条目。'
        + '要求：贴维度气质；轻重搭配、宁重不轻（重＝一个局，不处理会发酵；轻＝一根针，不自带走向）；'
        + 'name 是 2-6 字的事件名；promptHint 一句话写清触发情境与张力方向（30-60 字）；不与已有条目重复或近似。'
        + '字符串值里不要出现英文双引号（引用一律写中文「」），也不要在值内换行。'
        + '只输出一个 JSON 对象，不要输出 JSON 以外的任何文字：\n'
        + '{ "entries": [ { "name": "…", "promptHint": "…", "severity": "light|heavy" } ] }';
    const existing = (settings.eventRules ?? []).map(r => r.name).join('、') || '（空）';
    const user = [
        `## 维度\n${dimension.name}：${dimension.prompt ?? ''}`,
        `## 生成数量\n${n} 条`,
        note.trim() ? `## 补充说明\n${note.trim()}` : '',
        `## 已有条目（避免重复或近似）\n${existing}`,
    ].filter(Boolean).join('\n\n');

    const request = {
        messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
        ],
    };
    const raw = await chatCompletion(request);
    const { result: data } = await parseModelJson(raw, request);   // 坏输出带修复提示回炉一次
    const list = Array.isArray(data?.entries) ? data.entries : (Array.isArray(data) ? data : []);
    return list
        .filter(e => e && String(e?.name ?? '').trim())
        .map(e => ({
            name: String(e.name).trim().slice(0, 20),
            promptHint: String(e.promptHint ?? '').trim().slice(0, 120),
            severity: e.severity === 'heavy' ? 'heavy' : 'light',
        }));
}
