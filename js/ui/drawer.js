// 主面板：顶部下拉抽屉 + 功能页签（世界书/知识库/记忆表格/剧情指导（含随机事件与游戏玩法）/监听/长线规划 + 设置）
// 高度只在「打开抽屉 / 切换页签」时按内容适配一次，封顶在聊天输入框上沿；
// 页签内的勾选、输入、展开收起不再改变面板高度，内容超出在面板内部滚动。
// 右下角手柄可手动拉——条目很多时可拉下去盖住输入框一次看更多；
// 用户手动拉过后（本次打开期间）不再自动适配，关掉重开恢复自适应。
// 点到酒馆顶栏/魔法棒菜单的原生按钮时自动收起本抽屉。
// 页签间跳转用全局事件 pp-switch-tab，避免页签模块反向依赖本文件
import { worldbookTab } from "./tabs/tab-worldbook.js";
import { knowledgeTab } from "./tabs/tab-knowledge.js";
import { memoryTab } from "./tabs/tab-memory.js";
import { guidanceTab } from "./tabs/tab-guidance.js";
import { listenerTab } from "./tabs/tab-listener.js";
import { longformTab } from "./tabs/tab-longform.js";
import { settingsTab } from "./tabs/tab-settings.js";
import { flushChatData } from "../chatdata.js";
import { settings, save } from "../settings.js";

const TABS = [worldbookTab, knowledgeTab, memoryTab, guidanceTab, listenerTab, longformTab, settingsTab];
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

// ---------------------------------------------------------------------------
// 面板内容等比缩放：只缩 #pp_tab_content（抽屉壳宽度不动，内容放大后页面变长、内部滚动；
// 记忆表格默认 100% 尺寸不变）。zoom 之下 scrollHeight/clientHeight 等几何量均为视觉像素，
// fitHeight 的各量纲保持一致，高度自适应公式不用改
// ---------------------------------------------------------------------------
const ZOOM_MIN = 80, ZOOM_MAX = 160;

function zoomVal() {
    const z = Number(settings.uiZoom);
    return Number.isFinite(z) ? Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z))) : 100;
}

function applyZoom(v) {
    settings.uiZoom = v;
    contentEl().style.zoom = v / 100;
    $('#pp_zoom_val').text(`${v}%`);
}

function changeZoom(by) {
    applyZoom(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoomVal() + by)));
    save();
    // 比例一换旧高度失去意义：清掉重新自适应（用户拖过的也重算）
    drawerEl().style.height = '';
    lastApplied = 0;
    fitHeight();
}

export function initDrawer() {
    const html = `
    <div id="pp_drawer" class="pp-drawer">
        <div class="pp-drawer-head">
            <b>剧情规划器</b>
            <div class="pp-head-ops">
                <span id="pp_zoom_out" class="menu_button fa-solid fa-minus" title="缩小面板内容（最低 80%）"></span>
                <span id="pp_zoom_val" class="pp-zoom-val" title="当前缩放比例，点一下恢复 100%">100%</span>
                <span id="pp_zoom_in" class="menu_button fa-solid fa-plus" title="放大面板内容：字与控件等比放大，页面相应变长（最高 160%）；记忆表格的表格放不下时，滚轮悬在表格上可左右翻看"></span>
                <div id="pp_close" class="menu_button fa-solid fa-xmark" title="关闭"></div>
            </div>
        </div>
        <div class="pp-tabs">
            ${TABS.map(t => `<div class="pp-tab" data-tab="${t.id}" title="${t.title}">${t.title}</div>`).join('')}
        </div>
        <div id="pp_tab_content" class="pp-tab-content"></div>
    </div>`;
    $('body').append(html);

    $('#pp_close').on('click', closeDrawer);
    applyZoom(zoomVal());   // 读回上次保存的缩放
    $('#pp_zoom_in').on('click', () => changeZoom(10));
    $('#pp_zoom_out').on('click', () => changeZoom(-10));
    $('#pp_zoom_val').on('click', () => { if (zoomVal() !== 100) changeZoom(100 - zoomVal()); });
    $('.pp-tab').on('click', function () {
        activateTab(this.dataset.tab);
    });
    document.addEventListener('pp-switch-tab', e => activateTab(e.detail?.id));

    // 点到酒馆顶栏 / 选项菜单 / 魔法棒菜单里的原生按钮时自动收起本抽屉，避免和原生面板叠在一起；
    // 魔法棒菜单里「剧情规划器」入口本身除外（那是打开入口）。
    // 选择器必须带 #top-settings-holder：酒馆顶栏的全部按钮（用户设置/背景/角色面板把手等）都住在
    // 它里面——#top-bar 是个空占位 div，只选它永远点不中（2026-08-27 用户报自动收起不生效的根因）
    $(document).on('click', (e) => {
        const el = drawerEl();
        if (!el?.classList.contains('pp-open')) return;
        if (e.target.closest?.('#pp_drawer, #pp_wand_open')) return;
        if (e.target.closest?.('#top-settings-holder, #top-bar, #options, #extensionsMenu')) closeDrawer();
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
    flushChatData();   // 关面板 = 一次使用结束：把这轮热层里的脏数据冲写进设置文件留底
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
