// 2.0 知识库（DESIGN §6.9，2026-08-29 定稿后落码）：反模型偏好的候选池。
// 模型在「约会去哪、消费什么」这类选择上有训练分布尖峰——换模型、重 roll 也只在几个
// 常见选项里打转（用户 1.0 起实测确认）。知识库把候选集合整个换掉：清单只喂剧情规划向导
// （随机事件/路人反应不接，扮演模型注入一概不碰），每张清单随机抓一小把随材料发给模型。
// 数据全局共享（settings.knowledge，不绑聊天不绑角色）：清单 { name, fields[], entries[] }。
// fields 即自定义表头——导入时定死、永不做事后迁移（用户留存原始文本，重导即重建，
// 2026-08-29 用户拍板「不做迁徙，后面也不会做」）。
// 用后账：生成产物 JSON 自报选用了哪些条目（knowledgeUsed 编号），选用过的进冷却——
// 冷却期内抓取自动跳过、按采用次数计（2026-08-31 真机第五轮改定：结算在「确认采用/转隐身
// 注入」时，草稿放弃/重写不碰冷却），防「模型从小把里连挑最熟那条」。冷却可手动清零。
import { chatCompletion, parseModelJson } from "./api.js";
import { settings, save, newId } from "./settings.js";

// 配置兜底（ensureDefaults 已建好；这里再防一次形状伤——导入旧备份可能带残缺结构）
export function knowledgeCfg() {
    const k = settings.knowledge ??= {};
    k.lists = Array.isArray(k.lists) ? k.lists : [];
    k.grabCount = Math.min(Math.max(Math.round(Number(k.grabCount) || 5), 1), 20);
    let cg = Number(k.cooldownGens);
    if (!Number.isFinite(cg)) cg = 3;   // 字段缺失时的兜底默认（提案值，待数值终审）
    k.cooldownGens = Math.min(Math.max(Math.round(cg), 0), 50);
    return k;
}

export function knowledgeLists() {
    return knowledgeCfg().lists;
}

export function findList(id) {
    return knowledgeLists().find(l => l.id === id) ?? null;
}

/**
 * 新建清单。fields = 表头字段名数组（自定义：字段名任意，导入时定死永不迁移）。
 * 名字与字段不合法直接抛错（调用方 toast）。
 */
export function createList(name, fields) {
    const listName = String(name ?? '').trim().slice(0, 30);
    if (!listName) throw new Error('清单名不能为空');
    const clean = [...new Set((fields ?? []).map(f => String(f ?? '').trim()).filter(Boolean))].map(f => f.slice(0, 20));
    if (!clean.length) throw new Error('至少要有一个表头字段');
    if (knowledgeLists().some(l => l.name === listName)) throw new Error(`已有同名清单「${listName}」`);
    const list = {
        id: newId('kb-'),
        name: listName,
        fields: clean,
        entries: [],
        nextCode: 1,
        createdAt: Date.now(),
    };
    knowledgeLists().push(list);
    save();
    return list;
}

export function renameList(id, name) {
    const list = findList(id);
    if (!list) return;
    const listName = String(name ?? '').trim().slice(0, 30);
    if (listName && !knowledgeLists().some(l => l.id !== id && l.name === listName)) {
        list.name = listName;
        save();
    }
}

export function deleteList(id) {
    const cfg = knowledgeCfg();
    cfg.lists = cfg.lists.filter(l => l.id !== id);
    save();
}

// ---------------------------------------------------------------------------
// 条目：values 按表头字段存（多余字段丢弃、缺失字段补空）；code = 清单内两位流水号
// （发给模型的编号 = 清单序号-条目号，如 1-03；冷却与使用次数随条目走）
// ---------------------------------------------------------------------------

function normalizeValues(list, values) {
    const out = {};
    for (const f of list.fields) out[f] = String(values?.[f] ?? '').trim();
    return out;
}

// 条目正文（发给模型的一行 / 页签列表的一行共用）：各字段值用全角竖线连接，空字段跳过
export function entryText(list, entry) {
    const vals = list.fields.map(f => String(entry?.values?.[f] ?? '').trim()).filter(Boolean);
    return vals.join('｜');
}

export function addEntries(listId, valuesArr, { prepend = false } = {}) {
    const list = findList(listId);
    if (!list) return 0;
    const fresh = [];
    for (const values of valuesArr ?? []) {
        fresh.push({
            id: newId('ke-'),
            code: String(list.nextCode++).padStart(2, '0'),
            values: normalizeValues(list, values),
            cooldown: 0,
            used: 0,
            at: Date.now(),
        });
    }
    if (!fresh.length) return 0;
    // 手动添加走 prepend（新条目插到列表最上面，2026-08-29 真机反馈：加条目不该翻到列表底）；
    // 结构化入库走默认 append（成批进来看起来是按草稿顺序接着排）
    if (prepend) list.entries.unshift(...fresh);
    else list.entries.push(...fresh);
    save();
    return fresh.length;
}

export function deleteEntry(listId, entryId) {
    const list = findList(listId);
    if (!list) return;
    list.entries = list.entries.filter(e => e.id !== entryId);
    save();
}

export function updateEntry(listId, entryId, values) {
    const list = findList(listId);
    const entry = list?.entries.find(e => e.id === entryId);
    if (entry) {
        entry.values = normalizeValues(list, values);
        save();
    }
}

/**
 * 从一张清单纯随机抓 N 条（无语境过滤——2026-08-29 用户明确否决过滤机制）。
 * 冷却中的条目跳过；可用不足 N 条有多少抓多少。
 * @returns {{picked:Array, available:number}} available = 冷却外的全部条目数（面板提示用）
 */
export function grabFromList(list, n) {
    const available = (list?.entries ?? []).filter(e => !(Number(e.cooldown) > 0));
    const pool = [...available];
    for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    return { picked: pool.slice(0, Math.max(0, Math.round(n) || 0)), available: available.length };
}

// ---------------------------------------------------------------------------
// 发送侧：条目 id → 发送载荷（listPos = 清单在设置里的顺序号，发送与自报对账的锚）
// ---------------------------------------------------------------------------

export function payloadFromIds(ids) {
    const byId = new Map();
    knowledgeLists().forEach((list, i) => {
        for (const e of list.entries) byId.set(e.id, { listPos: i + 1, list, entry: e });
    });
    const seen = new Set();
    const out = [];
    for (const id of ids ?? []) {
        const hit = byId.get(id);
        if (hit && !seen.has(id)) {
            seen.add(id);
            out.push(hit);
        }
    }
    return out;
}

// 材料小节（planner.js 插进「进行中剧情」之前；只进规划向导，其他调用方一概不带）
export function knowledgeSection(payload) {
    const lines = (payload ?? []).map(({ listPos, list, entry }) =>
        `【编号 ${listPos}-${entry.code}】${entryText(list, entry) || '（空条目）'}`);
    if (!lines.length) return null;
    return [
        '## 知识库材料（从用户清单随机抓取的候选素材：规划从中选用并自然融入——保持条目核心特征，不生硬罗列、不改成清单复述）',
        lines.join('\n'),
    ];
}

// 模型自报编号（'1-03' / '1-3' 都认）→ 本次发送里的条目；对不上的编号静默忽略
function usedEntryIds(payload, usedCodes) {
    const ids = new Set();
    for (const raw of usedCodes ?? []) {
        const m = String(raw ?? '').trim().match(/^(\d+)\s*-\s*(\d+)$/);
        if (!m) continue;
        const hit = (payload ?? []).find(p =>
            String(p.listPos) === m[1] && String(p.entry.code) === m[2].padStart(2, '0'));
        if (hit) ids.add(hit.entry.id);
    }
    return ids;
}

/**
 * 用后账结算（2026-08-31 真机第五轮改定：只在规划真正上场时执行——「确认采用」或「转为
 * 隐身注入」，由向导侧 settleKbCharge 调；草稿放弃/重写不结算，分析成功只快照发送帐）：
 * 全部条目冷却 -1（冷却按采用次数计——只有带知识材料的采用才推动冷却；模型空选也照走，
 * 空选不算异常）、自报导选用过的条目冷却重置为 gens、使用次数 +1。
 * @returns {number} 本次判定为选用的条目数
 */
export function settleCooldown(payload, usedCodes, gens) {
    const used = usedEntryIds(payload, usedCodes);
    for (const list of knowledgeLists()) {
        for (const e of list.entries) {
            e.cooldown = Math.max(0, (Number(e.cooldown) || 0) - 1);
            if (used.has(e.id)) {
                e.cooldown = Math.min(Math.max(Math.round(Number(gens) || 0), 0), 50);
                e.used = (Number(e.used) || 0) + 1;
            }
        }
    }
    save();
    return used.size;
}

// 手动清零一条条目的冷却（知识库页点冷却徽章，2026-08-31 真机第五轮：冷却此前没有任何
// 取消出口）——用户判断这条可以再用就点掉，立刻恢复可抓
export function clearCooldown(listId, entryId) {
    const entry = findList(listId)?.entries.find(e => e.id === entryId);
    if (entry && Number(entry.cooldown) > 0) {
        entry.cooldown = 0;
        save();
    }
}

// ---------------------------------------------------------------------------
// 结构化导入：用户在外部用提示词批量起草 → 粘贴 → 模型照这张清单的表头把文本填成条目。
// 走副 API，供应商方案单次选用（与其他生成一致）；预设全局生效（chatCompletion 出口附带）
// ---------------------------------------------------------------------------

function structureSystemPrompt(list) {
    const fields = list.fields.map(f => `「${f}」`).join('、');
    const schema = '{ "entries": [ { ' + list.fields.map(f => `"${f}": "…"`).join(', ') + ' } ] }';
    return [
        `你是「知识库条目结构化器」。用户正在为清单「${list.name}」导入条目，这张清单的表头字段固定为：${fields}。`,
        '用户会粘贴一批在外部起草的原始文本（格式不定：可能是列表、分段、表格或自由文本）。你的任务是把它们整理成符合表头的结构化条目：',
        '- 每个独立条目对应草稿里一个独立的条目或要点：不拆散同一件事、不合并不同条目、不自行增删条目；',
        '- 原文信息填进对应字段；某个字段在原文里没有对应信息就填空字符串，绝不编造；',
        '- 字段名里含「标签」的填简短的标签词（多个用中文顿号「、」分隔），供日后筛选；',
        '- 你的工作是分类归位，不是改写：保留原文的事实与措辞，不扩写、不润色；',
        '- 条目数量不设上限：草稿里有几条就整理几条，不要照抄任何示例数量。',
        '字符串值里不要出现英文双引号（引用一律改写为中文「」），也不要在值内换行。',
        '输出为紧凑 JSON：整个对象写成一整行，不要换行、不要缩进——省下的输出长度留给条目内容。',
        '只输出一个符合如下结构的 JSON 对象，不要输出 JSON 以外的任何文字：',
        schema,
    ].join('\n');
}

// 长草稿分批（2026-08-29 真机反馈：101 条一把结构化，输出常被单次回复长度上限拦腰截断，
// 本地修不回、重试照样截断）：优先按空行切段、再按行、最后按字符硬切，打包成不超过
// CHUNK_CHARS 的批，一批一次调用。批边界可能切在条目中间——草稿本来就有逐条审改这道闸兜底。
const STRUCT_CHUNK_CHARS = 2000;

function splitDraftChunks(raw) {
    const units = [];
    for (const para of raw.split(/\n\s*\n+/).map(s => s.trim()).filter(Boolean)) {
        if (para.length <= STRUCT_CHUNK_CHARS) { units.push(para); continue; }
        for (const line of para.split('\n')) {
            for (let i = 0; i < line.length; i += STRUCT_CHUNK_CHARS) units.push(line.slice(i, i + STRUCT_CHUNK_CHARS));
        }
    }
    const chunks = [];
    let cur = '';
    for (const u of units) {
        if (cur && cur.length + u.length + 2 > STRUCT_CHUNK_CHARS) { chunks.push(cur); cur = u; }
        else cur = cur ? `${cur}\n\n${u}` : u;
    }
    if (cur) chunks.push(cur);
    return chunks;
}

/**
 * 把一段原始草稿结构化成条目值数组（用户在草稿页逐条审改后才入库）。
 * 长草稿自动分批：一批一次调用，某批失败不拖垮其余（失败批记入 failed，开头摘要有定位用）；
 * 全部批次失败或全部空结果才向上抛。onProgress(第几批, 共几批) 供调用方报进度。
 * @param {object} options
 * @param {object} options.list      目标清单（表头来自它）
 * @param {string} options.rawText   粘贴的原始草稿
 * @param {object} [options.provider] 供应商方案 {baseUrl,apiKey,model}；不传走当前主连接
 * @param {(i:number, n:number)=>void} [options.onProgress]
 * @returns {Promise<{values:Array<object>, failed:Array<{head:string, error:string}>}>}
 *          values 已按表头清洗（多余字段丢弃、缺失补空）
 */
export async function structureImport({ list, rawText, provider, onProgress } = {}) {
    const raw = String(rawText ?? '').trim();
    if (!raw) throw new Error('请先粘贴原始草稿');
    if (!list?.fields?.length) throw new Error('目标清单没有表头字段');
    const chunks = splitDraftChunks(raw);
    const values = [];
    const failed = [];
    for (let i = 0; i < chunks.length; i++) {
        if (typeof onProgress === 'function') onProgress(i + 1, chunks.length);
        const messages = [
            { role: 'system', content: structureSystemPrompt(list) },
            { role: 'user', content: chunks.length > 1 ? `（草稿第 ${i + 1}/${chunks.length} 批，只整理这一批，不要虚构其他批次的内容）\n\n${chunks[i]}` : chunks[i] },
        ];
        const req = { messages, ...(provider ? { provider } : {}) };
        try {
            const { result } = await parseModelJson(await chatCompletion(req), req);
            const arr = Array.isArray(result?.entries) ? result.entries : [];
            values.push(...arr.map(v => normalizeValues(list, v)));
        } catch (err) {
            failed.push({ head: chunks[i].slice(0, 30), error: String(err.message ?? err) });
        }
    }
    if (!values.length) {
        throw new Error(failed.length
            ? `结构化失败：${failed[0].error}${chunks.length > 1 ? `（共 ${chunks.length} 批都没成功）` : ''}`
            : '模型没整理出任何条目（输出里没有 entries），换个写法再试或手动添加');
    }
    return { values, failed };
}
