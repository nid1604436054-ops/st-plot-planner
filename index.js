// 剧情规划器 (Plot Planner) — SillyTavern 第三方扩展入口
// 装配：顶部下拉主面板 + 魔法棒菜单入口；挂接聊天切换 / 新消息事件
// 依赖酒馆全局环境（jQuery / toastr / SillyTavern），纯浏览器端 ES Module，无构建步骤
import { eventSource, event_types } from "/script.js";
import { initDrawer, openDrawer } from "./js/ui/drawer.js";
import { initWandMenu } from "./js/ui/wandMenu.js";
import { replayScopedInjections, tickInjectionExpiries } from "./js/injection.js";
import { replayOutfitSlot, tickOutfitExpiry } from "./js/outfit.js";
import { scanAndApplyStorage } from "./js/store.js";
import { syncMemory, mergeMirrorFromSource, persistMemory } from "./js/memoryTable.js";
import { flushChatData } from "./js/chatdata.js";
import { initListener, registerLitReconciler } from "./js/listener.js";
import { installCacheBust } from "./js/cachbust.js";
import { reconcileLfFloors } from "./js/longform.js";
import { resetGuidance } from "./js/ui/tabs/tab-guidance.js";
import { resetWorldbook } from "./js/ui/tabs/tab-worldbook.js";

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
            flushChatData();   // 原表真变了才走到这（低频）：顺手把热层数据冲写进设置文件留底
        }
    } catch (e) {
        console.warn('[PlotPlanner] 记忆表格自动同步失败', e);
    }
}

jQuery(() => {
    initDrawer();
    initWandMenu();
    initListener();   // 2.0 监听：楼层落地→逐轮判定；总开关默认关（settings.listener.enabled）
    registerLitReconciler(reconcileLfFloors);   // 删楼回退对账（第四十五轮）：监听侧管触发时机、长线侧管章账本回写
    // 第六十轮：扮演请求前缀缓存打散——在酒馆发往扮演模型的请求最前面塞一段每次都不同的短标记，
    // 令前缀缓存永不命中（Kiro 逆向端点吃缓存注意力劣化）；全局勾选 settings.bustRpCache 默认关、
    // 独立于监听总开关。cachbust.js 不碰酒馆全局（五门规），eventSource/event_types 由这里注入
    installCacheBust(eventSource, event_types);

    // 聊天切换：先把上一轮热层里的脏数据冲写进设置文件，再按 scope 重放/清理 M4 注入，
    // 重算 M5 储存条目，同步记忆表格镜像，清掉剧情向导的进行中进度
    // （剧情数据本身按聊天身份存 chatdata，随聊天自动切换），
    // 世界书页开着时刷新——「启用」勾选按对话记忆，要显示新对话的书单
    eventSource.on(event_types.CHAT_CHANGED, () => {
        flushChatData();
        replayScopedInjections();
        replayOutfitSlot();   // 装扮注入槽按新聊天的 outfit 块重放/清空（不受监听总开关管）
        scanAndApplyStorage();
        autoSyncMemory();
        resetGuidance();
        resetWorldbook();
    });

    // 新消息到达：按楼层净增推进「按层数过期」的计数（滑动/重新生成楼数不变、不吃层），
    // 重扫储存条目，同步记忆表格镜像；装扮的层数递减同一口径（走到 0 自动清框停注）
    eventSource.on(event_types.MESSAGE_RECEIVED, () => {
        tickInjectionExpiries();
        tickOutfitExpiry();
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
