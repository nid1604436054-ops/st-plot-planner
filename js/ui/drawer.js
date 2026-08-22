// 主面板：顶部下拉抽屉 + 六个功能页签（五个模块 + 设置）
// 高度：默认一直伸到聊天输入框上沿；右下角可手动拖拉，拉过的高度本次会话内记住
// 页签间跳转用全局事件 pp-switch-tab，避免页签模块反向依赖本文件
import { worldbookTab } from "./tabs/tab-worldbook.js";
import { guidanceTab } from "./tabs/tab-guidance.js";
import { eventsTab } from "./tabs/tab-events.js";
import { injectionsTab } from "./tabs/tab-injections.js";
import { storageTab } from "./tabs/tab-storage.js";
import { settingsTab } from "./tabs/tab-settings.js";

const TABS = [worldbookTab, guidanceTab, eventsTab, injectionsTab, storageTab, settingsTab];
let activeId = TABS[0].id;

// 用户手动拉过的高度（px）；0 = 没拉过，每次打开都按“贴到输入框上沿”重算
let userHeight = 0;
// 上次 open 时我们写入的高度，用来在关闭时判断“当前高度是否被用户拉过”
let lastApplied = 0;

function drawerEl() {
    return document.getElementById('pp_drawer');
}

function computeDefaultHeight() {
    const el = drawerEl();
    const top = el.getBoundingClientRect().top;
    const maxAvail = Math.max(240, window.innerHeight - top - 8);
    const form = document.getElementById('form_sheld') ?? document.getElementById('send_form');
    if (form) {
        const h = form.getBoundingClientRect().top - top - 8;
        if (h > 240) return Math.min(h, maxAvail);
    }
    return Math.min(640, maxAvail);
}

function applyHeight() {
    const el = drawerEl();
    const top = el.getBoundingClientRect().top;
    const maxAvail = Math.max(240, window.innerHeight - top - 8);
    const h = Math.round(Math.min(userHeight || computeDefaultHeight(), maxAvail));
    lastApplied = h;
    el.style.height = `${h}px`;
}

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

    // 窗口尺寸变了：开着就按新视口重新夹取高度（用户拉过的长度仍保留，只夹到不超出屏幕）
    $(window).on('resize', () => {
        if (drawerEl()?.classList.contains('pp-open')) applyHeight();
    });
}

export function openDrawer() {
    applyHeight();
    $('#pp_drawer').addClass('pp-open');
    activateTab(activeId);
}

export function closeDrawer() {
    const el = drawerEl();
    // 拖拉手柄改的是元素内联高度：和上次打开时写入的不一样，说明用户拉过，记住它
    const h = parseFloat(el.style.height);
    if (Number.isFinite(h) && Math.abs(h - lastApplied) > 4) {
        userHeight = Math.round(h);
    }
    el.style.height = '';
    $(el).removeClass('pp-open');
}

export function activateTab(id) {
    const tab = TABS.find(t => t.id === id) ?? TABS[0];
    activeId = tab.id;
    $('.pp-tab').removeClass('pp-active').filter(`[data-tab="${tab.id}"]`).addClass('pp-active');
    const container = document.getElementById('pp_tab_content');
    container.innerHTML = '';
    tab.render(container);
}
