// 主面板：顶部下拉抽屉 + 五个功能页签（四个模块 + 设置；随机事件并入剧情指导页下部）
// 高度只在「打开抽屉 / 切换页签」时按内容适配一次，封顶在聊天输入框上沿；
// 页签内的勾选、输入、展开收起不再改变面板高度，内容超出在面板内部滚动。
// 右下角手柄可手动拉——条目很多时可拉下去盖住输入框一次看更多；
// 用户手动拉过后（本次打开期间）不再自动适配，关掉重开恢复自适应。
// 点到酒馆顶栏/魔法棒菜单的原生按钮时自动收起本抽屉。
// 页签间跳转用全局事件 pp-switch-tab，避免页签模块反向依赖本文件
import { worldbookTab } from "./tabs/tab-worldbook.js";
import { memoryTab } from "./tabs/tab-memory.js";
import { guidanceTab } from "./tabs/tab-guidance.js";
import { storageTab } from "./tabs/tab-storage.js";
import { settingsTab } from "./tabs/tab-settings.js";

const TABS = [worldbookTab, memoryTab, guidanceTab, storageTab, settingsTab];
let activeId = TABS[0].id;

// 上次自动适配写入的高度；当前内联高度与它不一致 = 用户拖过，停止自动适配
let lastApplied = 0;

function drawerEl() {
    return document.getElementById('pp_drawer');
}

function contentEl() {
    return document.getElementById('pp_tab_content');
}

// 自动适配的上限：聊天输入框上沿（拿不到就退回 min(640px, 75vh)）
function capToInput() {
    const el = drawerEl();
    const top = el.getBoundingClientRect().top;
    const form = document.getElementById('form_sheld') ?? document.getElementById('send_form');
    if (form) {
        const h = form.getBoundingClientRect().top - top - 8;
        if (h > 240) return h;
    }
    return Math.min(640, window.innerHeight * 0.75);
}

function fitHeight() {
    const el = drawerEl();
    if (!el?.classList.contains('pp-open')) return;
    const current = parseFloat(el.style.height);
    if (Number.isFinite(current) && lastApplied && Math.abs(current - lastApplied) > 2) return; // 用户拖过
    const content = contentEl();
    const top = el.getBoundingClientRect().top;
    const maxAvail = Math.max(240, window.innerHeight - top - 8);
    // 头部+页签条等非滚动部分的开销 = 面板高 - 内容可视高
    const overhead = el.offsetHeight - content.clientHeight;
    const needed = content.scrollHeight + overhead + 8;
    const h = Math.round(Math.min(Math.max(240, needed), Math.min(capToInput(), maxAvail)));
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

    // 点到酒馆顶栏 / 魔法棒菜单里的原生按钮时自动收起本抽屉，避免和原生面板叠在一起；
    // 魔法棒菜单里「剧情规划器」入口本身除外（那是打开入口）
    $(document).on('click', (e) => {
        const el = drawerEl();
        if (!el?.classList.contains('pp-open')) return;
        if (e.target.closest?.('#pp_drawer, #pp_wand_open')) return;
        if (e.target.closest?.('#top-bar, #extensionsMenu')) closeDrawer();
    });

    // 窗口尺寸变化：把当前高度夹进新视口（用户拖过的也夹，但不重置）
    $(window).on('resize', () => {
        const el = drawerEl();
        if (!el?.classList.contains('pp-open')) return;
        const top = el.getBoundingClientRect().top;
        const maxAvail = Math.max(240, window.innerHeight - top - 8);
        const current = parseFloat(el.style.height) || lastApplied || 0;
        el.style.height = `${Math.round(Math.max(240, Math.min(current, maxAvail)))}px`;
    });
}

export function openDrawer() {
    const el = drawerEl();
    el.style.height = '';
    lastApplied = 0;
    $(el).addClass('pp-open');
    activateTab(activeId);
}

export function closeDrawer() {
    const el = drawerEl();
    el.style.height = '';
    lastApplied = 0;
    $(el).removeClass('pp-open');
}

export function activateTab(id) {
    const tab = TABS.find(t => t.id === id) ?? TABS[0];
    activeId = tab.id;
    $('.pp-tab').removeClass('pp-active').filter(`[data-tab="${tab.id}"]`).addClass('pp-active');
    const container = contentEl();
    container.innerHTML = '';
    tab.render(container);
    fitHeight();
}
