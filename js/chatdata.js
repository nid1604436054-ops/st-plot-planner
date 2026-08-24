// 每聊天数据的统一存取层：记忆表格镜像库 / 剧情档案 / 向导勾选 / 反应卡勾选 / 对话书单。
// 这些数据原先存 chatMetadata（跟聊天文件走），每次改动都要 saveChat——几千层的大聊天
// 一序列化就是上百毫秒，插件里点一下卡一下。现改双层存储：
//   热层 localStorage：每次改动同步写（只串这一小块数据，毫秒级），完全不碰聊天文件；
//   冷层 settings.chatData：随全局设置存服务器端 settings.json（清浏览器缓存不丢），
//     只在低频时机冲写（切聊天 / 确认采用剧情 / 表格合并 / 关面板 / 5 分钟兜底），
//     冲写走 saveSettingsDebounced（1 秒防抖，只序列化设置文件）。
// 读序：会话缓存 → 热层 → 冷层 → 旧 chatMetadata 数据一次性迁移（迁完即从聊天文件删掉）。
// 聊天身份 = 角色头像文件名｜聊天文件名：开分支、改聊天名、换新聊天文件都会被认成新聊天，
// 旧数据用设置页「数据备份与搬家」的导出/导入/过户接回来。
import { settings, save } from "./settings.js";

// 本模块故意不经 context.js 取 getContext（chatdata ← context 与 context ← chatdata 会成环），
// 直接用酒馆全局对象——这是对「getContext 统一走 context.js」约定的唯一例外
const tavernCtx = () => SillyTavern.getContext();

const LS_PREFIX = 'ppChatData:';
const LEGACY_META_KEYS = {
    memory: 'plotPlannerMemory',
    story: 'plotPlannerStory',
    picks: 'plotPlannerPicks',
    reaction: 'plotPlannerReactionPicks',
    books: 'plotPlannerBooks',
};

// 本会话已加载的数据（"身份:数据名" → 对象）：加载过就以内存对象为准，
// 防止「就地改动还没 persist」时被存储层的旧副本覆盖回去
const sessionCache = new Map();

let dirty = false;
let legacyTimer = null;

export function chatDataKey() {
    const ctx = tavernCtx();
    const card = Array.isArray(ctx.characters) ? ctx.characters[ctx.characterId] : null;
    return card ? `${card.avatar || card.name}｜${card.chat || ''}` : 'no-character';
}

function bucketOf(key) {
    settings.chatData ??= {};
    return (settings.chatData[key] ??= {});
}

function lsKey(key, name) { return LS_PREFIX + key + ':' + name; }

/**
 * 读当前聊天的某块数据（带缓存）。
 * @param {string} name  数据名：memory / story / picks / reaction / books
 * @param {Function|null} makeDefaults  全新聊天时的初始值工厂；传 null = 没存过就返回 null（调用方按未配置处理）
 */
export function loadChatData(name, makeDefaults) {
    const key = chatDataKey();
    // 旧版存在聊天文件里的键：每次读取都顺手看一眼，有就读走并删掉（聊天文件一次性瘦身），
    // 下次 saveChat 生效——删除动作和保存时机解耦，切聊天/跨会话都不会漏
    const legacyValue = takeLegacy(name);
    const ck = key + ':' + name;
    if (sessionCache.has(ck)) return sessionCache.get(ck);

    let value;
    try {
        const raw = localStorage.getItem(lsKey(key, name));
        if (raw) value = JSON.parse(raw);
    } catch { /* localStorage 不可用或副本损坏时落到下一层 */ }
    if (value === undefined && bucketOf(key)[name] !== undefined) value = bucketOf(key)[name];
    if (value === undefined) value = legacyValue;

    if (value === undefined) {
        if (!makeDefaults) return null;
        value = makeDefaults();
    }
    bucketOf(key)[name] = value;
    sessionCache.set(ck, value);
    return value;
}

// 读走旧键并从 chatMetadata 删除，防抖保存一次；没有旧键时零成本（一次属性查询）
function takeLegacy(name) {
    const meta = tavernCtx().chatMetadata;
    const legacyKey = LEGACY_META_KEYS[name];
    if (!meta || !legacyKey || meta[legacyKey] === undefined) return undefined;
    const value = meta[legacyKey];
    delete meta[legacyKey];
    clearTimeout(legacyTimer);
    legacyTimer = setTimeout(() => {
        try { tavernCtx().saveChat?.(); }
        catch (e) { console.warn('[PlotPlanner] 聊天文件旧数据清理保存失败', e); }
    }, 3000);
    return value;
}

// 每次改动调用：写热层 + 标脏（不立即写设置文件——那是 flushChatData 的事）
export function saveChatData(name, value) {
    const key = chatDataKey();
    bucketOf(key)[name] = value;
    sessionCache.set(key + ':' + name, value);
    try { localStorage.setItem(lsKey(key, name), JSON.stringify(value)); } catch { /* 写不进就算了，还有冷层 */ }
    dirty = true;
}

// 把脏数据写进设置文件；稍后清掉非当前聊天的热层副本（冷层已是最新，控制 localStorage 占用）
export function flushChatData() {
    if (dirty) {
        dirty = false;
        save();
    }
    setTimeout(() => {
        const keep = LS_PREFIX + chatDataKey() + ':';
        try {
            for (let i = localStorage.length - 1; i >= 0; i--) {
                const k = localStorage.key(i);
                if (k?.startsWith(LS_PREFIX) && !k.startsWith(keep)) localStorage.removeItem(k);
            }
        } catch { /* 清不掉不影响正确性 */ }
    }, 5000);
}

// 导入备份 / 过户后调用：作废会话缓存与热层，后续读取回落到冷层（刚写入的那份）
export function resetChatDataCache() {
    sessionCache.clear();
    try {
        for (let i = localStorage.length - 1; i >= 0; i--) {
            const k = localStorage.key(i);
            if (k?.startsWith(LS_PREFIX)) localStorage.removeItem(k);
        }
    } catch { /* 同上 */ }
}

// 兜底：最长 5 分钟必有一次冲写（异常退出最多丢这一窗口内的改动）
setInterval(flushChatData, 5 * 60 * 1000);
