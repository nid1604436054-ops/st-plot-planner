// 剧情规划器 (Plot Planner) — SillyTavern 第三方扩展入口
// 装配：顶部下拉主面板 + 魔法棒菜单入口；挂接聊天切换 / 新消息事件
// 依赖酒馆全局环境（jQuery / toastr / SillyTavern），纯浏览器端 ES Module，无构建步骤
import { eventSource, event_types } from "/script.js";
import { initDrawer, openDrawer } from "./js/ui/drawer.js";
import { initWandMenu } from "./js/ui/wandMenu.js";
import { replayScopedInjections, tickInjectionExpiries } from "./js/injection.js";
import { scanAndApplyStorage } from "./js/store.js";
import { syncMemory, persistMemory } from "./js/memoryTable.js";

// 记忆表格镜像自动同步：聊天切换 / 新消息 / 编辑消息后跑一次（后台静默）
function autoSyncMemory() {
    try {
        const r = syncMemory({ auto: true });
        if (r.wiped && r.state.wipeAlert && !r.state.wipeAlert.notified) {
            r.state.wipeAlert.notified = true;
            persistMemory();
            toastr.warning('剧情规划器：检测到记忆表格疑似被清空，已保留镜像备份，可在「记忆表格」页恢复');
        }
    } catch (e) {
        console.warn('[PlotPlanner] 记忆表格自动同步失败', e);
    }
}

jQuery(() => {
    initDrawer();
    initWandMenu();

    // 聊天切换：按 scope 重放/清理 M4 注入，重算 M5 储存条目，并同步记忆表格镜像
    eventSource.on(event_types.CHAT_CHANGED, () => {
        replayScopedInjections();
        scanAndApplyStorage();
        autoSyncMemory();
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
