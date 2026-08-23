// 剧情规划器 (Plot Planner) — SillyTavern 第三方扩展入口
// 装配：顶部下拉主面板 + 魔法棒菜单入口；挂接聊天切换 / 新消息事件
// 依赖酒馆全局环境（jQuery / toastr / SillyTavern），纯浏览器端 ES Module，无构建步骤
import { eventSource, event_types } from "/script.js";
import { initDrawer, openDrawer } from "./js/ui/drawer.js";
import { initWandMenu } from "./js/ui/wandMenu.js";
import { replayScopedInjections, tickInjectionExpiries } from "./js/injection.js";
import { scanAndApplyStorage } from "./js/store.js";
import { syncMemory, mergeMirrorFromSource, persistMemory } from "./js/memoryTable.js";
import { resetGuidance } from "./js/ui/tabs/tab-guidance.js";

// 记忆表格自动维护：同步原表库（含备份/清空保护），有变化时把新内容合并进镜像
// （用户编辑过的镜像行不会被覆盖，删除过的行内容不变不复活）
function autoSyncMemory() {
    try {
        const r = syncMemory();
        if (r.wiped && r.state.wipeAlert && !r.state.wipeAlert.notified) {
            r.state.wipeAlert.notified = true;
            persistMemory();
            toastr.warning('剧情规划器：检测到记忆表格疑似被清空，已保留原表库备份，可在「记忆表格」页恢复');
        } else if (r.changed) {
            mergeMirrorFromSource();
        }
    } catch (e) {
        console.warn('[PlotPlanner] 记忆表格自动同步失败', e);
    }
}

jQuery(() => {
    initDrawer();
    initWandMenu();

    // 聊天切换：按 scope 重放/清理 M4 注入，重算 M5 储存条目，同步记忆表格镜像，
    // 并清掉剧情向导的进行中进度（剧情数据本身存 chatMetadata，随聊天自动切换）
    eventSource.on(event_types.CHAT_CHANGED, () => {
        replayScopedInjections();
        scanAndApplyStorage();
        autoSyncMemory();
        resetGuidance();
    });

    // 新消息到达：推进「按层数过期」的计数，重扫储存条目，同步记忆表格镜像
    eventSource.on(event_types.MESSAGE_RECEIVED, () => {
        tickInjectionExpiries();
        scanAndApplyStorage();
        autoSyncMemory();
    });

    // 消息被编辑（AI 改写/重新掷骰）也可能改动表格数据
    eventSource.on(event_types.MESSAGE_EDITED, () => {
        autoSyncMemory();
    });
});

// 调试入口：浏览器控制台执行 PlotPlanner.open() 可直接打开面板
window.PlotPlanner = { open: openDrawer };
