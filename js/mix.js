// 2.0 混合重编（2026-09-02 设计对齐轮定稿落码，DESIGN §6.4「打碎重混」的现行版）：
// 长线规划执行到某一章、实际演出与新材料/新想法需要对齐时，把「规划」与「实际已发生」混合，
// 整章重写当前执行位的章。三件事：
//   ① 基底定位（mixTarget）：监听单位槽里的长线章＝在岗；否则全书顺序第一个未演完的章
//      （暂停中或未开演）——没有全书选择器（可驳默认：执行位只有一个，别的地方要混先去挂它）。
//   ② 一次生成调用（runMixChapter）：输入＝向导第 1 步材料（面板拼好传入，装扮单元不参与）＋
//      全书骨架＋本卷整份卷文本＋本卷各章一览＋当前章全文与节点表（含已点亮数）＋校准窗口
//      （最近 N 层实际演出，0＝全部未隐藏楼层）＋本次想法（最高优先级）；输出七字段一个不能少。
//   ③ 产物落两处：长线侧就地改写该章（文本＋节点表；旧版整份进该章「混合历史」可回看、
//      进度账不动）＋重新挂进监听（在岗＝同章就地换新；暂停/未开演＝挂载，退位槽被占＝拒绝并指路）。
// 依赖方向：mix → longform → listener 单向（longform/listener 不得反向引 mix，界面层搭桥）。
import { settings } from "./settings.js";
import { chatCompletion, parseModelJson } from "./api.js";
import { loadChatData, saveChatData, flushChatData } from "./chatdata.js";
import { getTavernContext } from "./context.js";
import {
    lfState, persistLf, bookOutlineBlock, chapterUnit, syncLfProgress, lfNextChapter,
    lfCommonSystem, nodesFromText, LF_MIN_NODES, LF_MIX_LOG_KEEP,
} from "./longform.js";
import { listenerState, opMountUnit, pushTraceRecord, collectFloorsFromChat, limitFloors, formatFloors } from "./listener.js";

// ---------------------------------------------------------------------------
// 每聊天草稿（chatdata 的 mix 块）：面板里攒的想法与校准窗口层数——刷新不丢（向导/知识库同款教训）
// ---------------------------------------------------------------------------

export function mixDraft() {
    const d = loadChatData('mix', () => ({ version: 1, idea: '', windowFloors: 0 }));
    d.version = 1;
    d.idea = String(d.idea ?? '');
    d.windowFloors = Math.max(0, Math.round(Number(d.windowFloors) || 0));
    return d;
}

export function persistMixDraft() {
    saveChatData('mix', mixDraft());
}

// ---------------------------------------------------------------------------
// 基底定位：长线当前执行位章
// ---------------------------------------------------------------------------

/**
 * 找当前执行位章。在岗（监听槽里挂着的长线章）优先；否则全书顺序第一个未演完的章
 * （暂停中有进度／未开演零进度都算——执行位按书序只有一个）。返回 null＝没有可混的基底。
 */
export function mixTarget() {
    const st = syncLfProgress();   // 先对账：mount 即真实执行位（监听页卸下/丢弃后这里会清）
    const ls = listenerState();
    if (ls.unit?.source === 'longform' && ls.unit.lfRef) {
        const { vol, ch } = ls.unit.lfRef;
        const c = st.volumes[vol]?.chapters?.[ch];
        if (c && c.unitId === ls.unit.id) {
            return { vi: vol, ci: ch, vol: st.volumes[vol], ch: c, mounted: true };
        }
    }
    const next = lfNextChapter(st);
    if (!next) return null;
    const vol = st.volumes[next.vol];
    if (!vol?.chapters?.[next.ch]) return null;
    return { vi: next.vol, ci: next.ch, vol, ch: vol.chapters[next.ch], mounted: false };
}

// 基底状态一句话（面板与测试共用口径）
export function mixTargetStatus(t) {
    if (!t) return '';
    if (t.mounted) return '在岗（监听单位槽）';
    return t.ch.lit > 0 ? `已暂停（已点亮 ${t.ch.lit}/${t.ch.nodes.length} 节点，可挂载恢复）` : '未开演（还没挂载过）';
}

// ---------------------------------------------------------------------------
// 提示词（全新起草，随交付报告送审；结构照长线管线：system 用 lfCommonSystem 公共头、
// 任务段在 user 末尾——与长线各步共享同一份 system 前缀，前缀缓存照吃）
// ---------------------------------------------------------------------------

/**
 * 混合重编的任务段（纯函数）。核心语义：新节点表的前 N 个（N＝已点亮数）按校准窗口的
 * 实际演出重写（账面对齐实际——「混合」的一半），其后是新安排的后续（融进想法与材料——另一半）。
 */
export function mixTaskPrompt() {
    return [
        '## 当前任务：混合重编（整章重写）',
        '你是长线剧情的章节重写编辑。长线规划执行到「当前重写章」，实际演出与新材料/新想法需要对齐——把规划与实际已发生的剧情混合，重写这一章的章文本与节点表。',
        '任务要求：',
        '- 只重写当前章：不输出其他章、不改动卷文本与骨架；重写内容不得与本卷后续各章的安排冲突（后续各章的标题与节点名在「本卷各章一览」里；确有冲突点在变更说明里点名，由用户回长线页处理，不归这次重写顺手改）。',
        '- 新节点表的前 N 个节点（N＝当前章已点亮节点数，见重写对象块）对应「已经实际演过的部分」：这些节点的判据与对应章文段按校准窗口的实际演出重写，让账面与实际对齐（已演出的关键事件不抹除、不复写、不重演）；其后的节点是新安排的后续剧情（融进本次想法与材料）。进度账不动：新表节点数可以多于或少于旧表，但「已演到哪」以 N 为准。',
        '- 校准窗口里偏出旧规划的内容，能吸收进新章的就地吸收（混合的意义所在）；不能吸收的在变更说明里点名。',
        '- 本次想法是本次重写的最高优先级输入：点名的数量、地点、人物、走向等逐条落实，不得打折、不得自作主张换成别的方案；与你自己的习惯偏好冲突时，用户要求赢。',
        '- 材料消化：材料小节（记忆表格／世界书／玩法／知识库／单元）里的相关内容自然融入重写——知识库条目按其核心特征选用、不得自拟同类；材料里已发生的事与既定设定是硬约束。',
        '- 章文本按【节点 N】节点名——完成标准 行分段（每段＝一个节点的演绎区间），章层写法：场景怎么开、节拍顺序、关键行动怎么做、关键台词的要点；每段落到可指认的具体事件上（这些事件是节点判据的素材）。',
        `- 节点至少 ${LF_MIN_NODES} 个、不设上限：判据可对照楼层内容逐条核对（写「演到什么样算这个节点完成」），禁空话（「气氛变好」「关系推进」这类不算）；相邻节点判据不得同义反复。`,
        '- 伏笔：旧章埋设或收束的伏笔、材料里点名的伏笔，新章里保留去向或写明处理，逐处在伏笔处理字段里交代。',
        '- 楼层推荐：按新章的剧情体量估一个建议楼数（本章预算不变——推荐只给用户参考，不改预算、不传导）。',
        '只输出一个符合如下结构的 JSON 对象，不要输出 JSON 以外的任何文字：',
        '{',
        '  "text": "重写后的章全文（按【节点 N】节点名——完成标准 行分段，换行写 \\n）",',
        '  "nodes": [ { "title": "节点名", "criterion": "完成标准（可对照楼层内容核对）" } ],',
        '  "floors_rec": 建议楼数（数值）,',
        '  "materials_note": "材料消化说明：本次重写消化了哪些材料内容、怎么融入的",',
        '  "changes_note": "变更说明：相对旧章改了什么、为什么；不能吸收的实际演出与后续章的冲突点在这点名",',
        '  "foreshadow_note": "伏笔处理：旧章伏笔的去向逐条交代（保留／已收／移交后续章）",',
        '  "calib_note": "校准备注：新章从校准窗口的哪一处衔接、吸收了哪些实际演出内容"',
        '}',
        '说明：nodes 数组与 text 里的【节点 N】行一一对应，两边都要给全；字符串值里不要出现英文双引号（引用一律写中文「」）。',
    ].join('\n');
}

/**
 * 组装混合重编要发的 system/user 两条消息（纯函数：全部材料以字符串传入，
 * 离线测试台与交付报告送审用同一份）。
 */
export function mixChapterMessages({ materials = '', outline = '', volumeBlock = '', chaptersBlock = '', chapterBlock = '', floorsText = '', floorsNote = '', idea = '' } = {}) {
    return [
        { role: 'system', content: lfCommonSystem() },
        { role: 'user', content: [
            materials,
            outline,
            volumeBlock,
            chaptersBlock,
            chapterBlock,
            `<校准窗口（${floorsNote || '当前聊天全部未隐藏楼层'}，带楼层号——实际已演出的剧情；楼层号只数角色回复）>`,
            String(floorsText ?? '').trim() || '（当前聊天还没有楼层——这是一次没有实际演出可校准的重写，按材料与想法直接重排本章）',
            '</校准窗口>',
            mixTaskPrompt(),
            '## 本次想法（本次重写的最高优先级输入）',
            String(idea ?? '').trim() || '（未填——材料与实际演出对齐为主）',
        ].filter(Boolean).join('\n\n') },
    ];
}

// 长线侧的输入块拼装（runMixChapter 内部用；独立函数便于对账）
function mixInputBlocks(t, st) {
    const volumeBlock = [
        '## 本卷当前卷文本（重写目标的母本卷；只读上下文——本次不重写它）',
        `### 第 ${t.vi + 1} 卷「${t.vol.title}」（预算 ${t.vol.floors} 层楼）`,
        String(t.vol.text ?? ''),
        `锚：${(t.vol.anchors ?? []).map(a => a.title).join('、') || '（无）'}`,
    ].join('\n');
    const chaptersBlock = [
        '## 本卷各章一览（重写不得与后续各章的安排冲突；当前重写章标注如下）',
        ...t.vol.chapters.map((c, i) => i === t.ci
            ? `【第 ${i + 1} 章·当前重写章】《${c.title}》（${c.floors} 层 · 账面已点亮前 ${c.lit} 个节点）`
            : `【第 ${i + 1} 章】《${c.title}》（${c.floors} 层）——节点：${c.nodes.map(n => n.title).join('、') || '（无）'}`),
    ].join('\n');
    const chapterBlock = [
        '## 当前重写章全文与节点表（重写对象——旧版，重写后将被新版整份替换）',
        `《${t.ch.title}》（预算 ${t.ch.floors} 层楼 · ${t.ch.lit}/${t.ch.nodes.length} 节点已点亮）`,
        String(t.ch.text ?? ''),
        '旧节点表：',
        ...(t.ch.nodes ?? []).map((n, k) => `${k + 1}. ${n.title}——完成标准：${n.criterion}`),
    ].join('\n');
    return { volumeBlock, chaptersBlock, chapterBlock };
}

// ---------------------------------------------------------------------------
// 输出契约规约（七字段：text 与 nodes 是硬字段——错值即违契约；其余宽容收敛）
// ---------------------------------------------------------------------------

export function normalizeMixResult(obj) {
    if (!obj || typeof obj !== 'object') throw new Error('输出不是一个 JSON 对象');
    const text = String(obj.text ?? '').trim();
    if (!text) throw new Error('新章文本为空（可能被输出上限截断）——本章保留原样未动，重试或把想法拆小');
    let nodes = (Array.isArray(obj.nodes) ? obj.nodes : [])
        .filter(n => n && typeof n === 'object')
        .map(n => ({ title: String(n.title ?? '').slice(0, 120), criterion: String(n.criterion ?? '') }))
        .filter(n => n.title);
    if (nodes.length < LF_MIN_NODES) {
        const fromText = nodesFromText(text);   // 章文本【节点 N】行兜底（与切章同款：节点是监听判定表，丢了没得判）
        if (fromText.length > nodes.length) nodes = fromText;
    }
    if (nodes.length < LF_MIN_NODES) throw new Error(`节点少于 ${LF_MIN_NODES} 个（解析到 ${nodes.length} 个）——节点是监听的判定表，请重试`);
    return {
        text,
        nodes,
        floorsRec: Math.max(0, Math.round(Number(obj.floors_rec) || 0)),
        materialsNote: String(obj.materials_note ?? '').slice(0, 600),
        changesNote: String(obj.changes_note ?? '').slice(0, 600),
        foreshadowNote: String(obj.foreshadow_note ?? '').slice(0, 600),
        calibNote: String(obj.calib_note ?? '').slice(0, 600),
    };
}

// ---------------------------------------------------------------------------
// 调用编排（输出上限 ×3——整章全文重出，与切章同档；onDelta 给了就走流式）
// ---------------------------------------------------------------------------

function mixMaxTokens() {
    const t = Math.round(Number(settings.api.maxTokens) || 0);
    return t ? Math.round(t * 3) : 0;
}

/**
 * 跑一次混合重编。产物就地落账：该章文本＋节点表整份换新、旧版进「混合历史」、
 * 进度账不动（只在节点变少时夹住防越界），然后重新挂进监听。
 * @param {object} [options]
 * @param {string} [options.idea]           本次想法（必填——最高优先级输入）
 * @param {number} [options.windowFloors]  校准窗口层数；0＝全部未隐藏楼层
 * @param {string} [options.materials]     向导第 1 步材料（面板拼好的整段文本）
 * @param {*}      [options.provider]      连接（缺省＝主连接，与向导分析同款）
 * @param {AbortSignal} [options.signal]
 */
export async function runMixChapter({ idea = '', windowFloors = 0, materials = '', provider, signal, onUsage, onDelta } = {}) {
    const note = String(idea ?? '').trim();
    if (!note) throw new Error('本次想法是空的——写一句这次要把剧情混成什么样（点名的数量/地点/走向会逐条落实）');
    const t = mixTarget();
    if (!t) throw new Error('本聊天还没有可重写的长线章——先去「长线剧情」页把章节生成出来（骨架→卷文本→生成章节）');
    const st = lfState();

    // 校准窗口：最近 N 层实际演出（0＝全部未隐藏楼层），楼层号与监听同口径
    const chat = Array.isArray(getTavernContext().chat) ? getTavernContext().chat : [];
    const all = collectFloorsFromChat(chat);
    const n = Math.max(0, Math.round(Number(windowFloors) || 0));
    const floorsText = formatFloors(limitFloors(all, n));
    const floorsNote = n > 0 ? `最近 ${n} 层角色楼（楼层号为全聊天绝对号）` : '';

    const messages = mixChapterMessages({
        materials: String(materials ?? ''),
        outline: bookOutlineBlock(st),
        ...mixInputBlocks(t, st),
        floorsText,
        floorsNote,
        idea: note,
    });
    const req = {
        messages,
        place: 'mix',   // 分处模型·混合重编档（第四十九轮）
        maxTokens: mixMaxTokens(),
        ...(provider ? { provider } : {}),
        ...(signal ? { signal } : {}),
        ...(onUsage ? { onUsage } : {}),
        ...(onDelta ? { onDelta: x => onDelta(String(x ?? '').length) } : {}),
    };
    const result = normalizeMixResult((await parseModelJson(await chatCompletion(req), req)).result);

    // —— 落账①：就地改写该章（旧版进混合历史；进度账不动） ——
    const st2 = lfState();
    const vol = st2.volumes[t.vi];
    const ch = vol?.chapters?.[t.ci];
    if (!ch) throw new Error('重写目标章不见了（生成期间长线数据被改动）——本章未动，请重试');
    const wasLit = Math.min(ch.lit, ch.nodes.length);
    ch.mixLog = Array.isArray(ch.mixLog) ? ch.mixLog : [];
    ch.mixLog.unshift({
        at: Date.now(),
        idea: note,
        windowFloors: n,
        floorsRec: result.floorsRec,
        materialsNote: result.materialsNote,
        changesNote: result.changesNote,
        foreshadowNote: result.foreshadowNote,
        calibNote: result.calibNote,
        prevText: String(ch.text ?? ''),
        prevNodes: (ch.nodes ?? []).map(x => ({ title: x.title, criterion: x.criterion })),
    });
    if (ch.mixLog.length > LF_MIX_LOG_KEEP) ch.mixLog.length = LF_MIX_LOG_KEEP;
    ch.text = result.text;
    ch.nodes = result.nodes.map(x => ({ title: x.title || '未命名节点', criterion: x.criterion }));
    ch.lit = Math.min(wasLit, result.nodes.length);   // 进度账不动；只在节点变少时夹住防越界
    persistLf();

    // —— 落账②：重新挂进监听（在岗＝同章就地换新；否则挂载；退位槽被占＝拒绝并指路） ——
    const wasMounted = t.mounted;
    const unit = chapterUnit(st2, t.vi, t.ci);   // unitId 沿用（重挂不换身份）、nodeIdx＝lit
    const r = opMountUnit(unit);   // 挂载即清停进提示/挂起（打碎混合是偏离处置出口之一）
    if (r.ok) {
        st2.mount = { vol: t.vi, ch: t.ci, unitId: unit.id, at: Date.now() };
    }
    persistLf();
    flushChatData();
    if (!r.ok) {
        // 章已重写成功、挂载被拒：不回滚文本（混合历史里旧版还在，要回滚手动改回），指路处理退位槽
        pushTraceRecord({
            at: Date.now(),
            mode: 'mix',
            src: 'mix',
            ok: true,
            mix: {
                title: `${vol.title} · ${ch.title}`,
                idea: note.slice(0, 200),
                floorsRec: result.floorsRec,
                changesNote: result.changesNote,
                remount: 'rejected',
                remountReason: String(r.reason ?? '').slice(0, 200),
            },
        });
        throw new Error(`章已重写完成（旧版在「混合历史」里），但重新挂载被拒：${r.reason}——处理完退位槽后到长线页该章点「挂载」用新文本`);
    }
    pushTraceRecord({
        at: Date.now(),
        mode: 'mix',
        src: 'mix',
        ok: true,
        mix: {
            title: `${vol.title} · ${ch.title}`,
            idea: note.slice(0, 200),
            floorsRec: result.floorsRec,
            changesNote: result.changesNote,
            remount: wasMounted ? 'inplace' : 'mounted',
        },
    });
    return { ...result, vol: t.vi, ch: t.ci, remount: wasMounted ? 'inplace' : 'mounted', wasLit };
}
