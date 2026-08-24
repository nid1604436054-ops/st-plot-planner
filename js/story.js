// 进行中剧情 + 历史归档：经 chatdata.js 双层存储按聊天走（不再写聊天文件）
// 条目结构：{ id, at, planText, summary, note, event:{mode,title,choice}, report, reportAt }
// （历史条目里的 presetIds 字段已随预设全局化退役，读回时忽略）
import { newId } from "./settings.js";
import { loadChatData, saveChatData, flushChatData } from "./chatdata.js";

const MAX_HISTORY = 20;

export function storyState() {
    const state = loadChatData('story', () => ({
        version: 1,
        activeId: null,   // 正在执行的剧情条目 id（指向 history 里一条）
        history: [],      // 每次确认采用的规划，最新在前
    }));
    if (!Array.isArray(state.history)) state.history = [];
    return state;
}

export function activeStory() {
    const s = storyState();
    return s.history.find(h => h.id === s.activeId) ?? null;
}

// 剧情操作都是低频的刻意动作（采用/完结/挂报告/删除）：写热层后立即冲写冷层留底
export function persistStory() {
    saveChatData('story', storyState());
    flushChatData();
}

// 确认采用一份新规划：置为进行中；原进行中的自动留在历史里
export function confirmPlot({ planText = '', summary = '', note = '', event = null } = {}) {
    const s = storyState();
    const entry = {
        id: newId('st-'),
        at: Date.now(),
        planText: String(planText ?? ''),
        summary: String(summary ?? '').slice(0, 120),
        note: String(note ?? ''),
        event: event ?? null,
        report: null,
        reportAt: 0,
    };
    s.history.unshift(entry);
    // 超上限丢最旧的归档；进行中那条（此刻还是旧 activeId）永不丢
    for (let i = s.history.length - 1; i >= 0 && s.history.length > MAX_HISTORY; i--) {
        if (s.history[i].id === s.activeId) continue;
        s.history.splice(i, 1);
    }
    s.activeId = entry.id;
    persistStory();
    return entry;
}

// 剧情完结：退出进行中状态，归档保留
export function endActive() {
    const s = storyState();
    s.activeId = null;
    persistStory();
}

// 检查报告挂到对应条目（每条剧情只保留最近一次）
export function attachReport(id, report) {
    const s = storyState();
    const entry = s.history.find(h => h.id === id);
    if (!entry) return null;
    entry.report = report ?? null;
    entry.reportAt = Date.now();
    persistStory();
    return entry;
}

export function deleteStory(id) {
    const s = storyState();
    s.history = s.history.filter(h => h.id !== id);
    if (s.activeId === id) s.activeId = null;
    persistStory();
}

// 清空归档；进行中那条保留
export function clearHistory() {
    const s = storyState();
    const active = s.history.find(h => h.id === s.activeId);
    s.history = active ? [active] : [];
    persistStory();
}
