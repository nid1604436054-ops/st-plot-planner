// 剧情规划器 (Plot Planner) — SillyTavern 第三方扩展入口
// 装配：扩展设置区块 + 右侧抽屉面板；挂接聊天切换 / 新消息事件
// 依赖酒馆全局环境（jQuery / toastr / SillyTavern），纯浏览器端 ES Module，无构建步骤
import { eventSource, event_types } from "/script.js";
import { initSettingsPanel } from "./js/ui/settingsPanel.js";
import { initDrawer, openDrawer } from "./js/ui/drawer.js";
import { initWandMenu } from "./js/ui/wandMenu.js";
import { replayScopedInjections, tickInjectionExpiries } from "./js/injection.js";
import { scanAndApplyStorage } from "./js/store.js";

jQuery(() => {
    initSettingsPanel();
    initDrawer();
    initWandMenu();

    // 聊天切换：按 scope 重放/清理 M4 注入，并重算 M5 储存条目
    eventSource.on(event_types.CHAT_CHANGED, () => {
        replayScopedInjections();
        scanAndApplyStorage();
    });

    // 新消息到达：推进「按层数过期」的计数，并重扫储存条目
    eventSource.on(event_types.MESSAGE_RECEIVED, () => {
        tickInjectionExpiries();
        scanAndApplyStorage();
    });
});

// 调试入口：浏览器控制台执行 PlotPlanner.open() 可直接打开面板
window.PlotPlanner = { open: openDrawer };
