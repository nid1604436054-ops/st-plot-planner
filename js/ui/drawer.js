// 主面板：顶部下拉抽屉 + 六个功能页签（五个模块 + 设置）
// 页签间跳转用全局事件 pp-switch-tab，避免页签模块反向依赖本文件
import { worldbookTab } from "./tabs/tab-worldbook.js";
import { guidanceTab } from "./tabs/tab-guidance.js";
import { eventsTab } from "./tabs/tab-events.js";
import { injectionsTab } from "./tabs/tab-injections.js";
import { storageTab } from "./tabs/tab-storage.js";
import { settingsTab } from "./tabs/tab-settings.js";

const TABS = [worldbookTab, guidanceTab, eventsTab, injectionsTab, storageTab, settingsTab];
let activeId = TABS[0].id;

export function initDrawer() {
    const html = `
    <div id="pp_drawer" class="pp-drawer">
        <div class="pp-drawer-head">
            <b>剧情规划器</b>
            <div id="pp_close" class="menu_button fa-solid fa-xmark" title="关闭"></div>
        </div>
        <div class="pp-tabs">
            ${TABS.map(t => `<div class="pp-tab" data-tab="${t.id}" title="${t.title}">${t.title}</div>`).join('')}
        </div>
        <div id="pp_tab_content" class="pp-tab-content"></div>
    </div>`;
    $('body').append(html);

    $('#pp_close').on('click', closeDrawer);
    $('.pp-tab').on('click', function () {
        activateTab(this.dataset.tab);
    });
    document.addEventListener('pp-switch-tab', e => activateTab(e.detail?.id));
}

export function openDrawer() {
    $('#pp_drawer').addClass('pp-open');
    activateTab(activeId);
}

export function closeDrawer() {
    $('#pp_drawer').removeClass('pp-open');
}

export function activateTab(id) {
    const tab = TABS.find(t => t.id === id) ?? TABS[0];
    activeId = tab.id;
    $('.pp-tab').removeClass('pp-active').filter(`[data-tab="${tab.id}"]`).addClass('pp-active');
    const container = document.getElementById('pp_tab_content');
    container.innerHTML = '';
    tab.render(container);
}
