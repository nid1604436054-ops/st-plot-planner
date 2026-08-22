// 入口：酒馆左下「扩展」魔法棒下拉菜单里加一项「剧情规划器」
// 结构对齐酒馆核心扩展的菜单项（list-group-item flex-container flexGap5）
import { openDrawer } from "./drawer.js";

export function initWandMenu() {
    const html = `
    <div id="pp_wand_open" class="list-group-item flex-container flexGap5" title="打开剧情规划器面板">
        <div class="fa-fw fa-solid fa-compass-drafting extensionsMenuExtensionButton"></div>
        <span>剧情规划器</span>
    </div>`;

    const tryAppend = () => {
        const menu = $('#extensionsMenu');
        if (!menu.length) return false;
        menu.append(html);
        $('#pp_wand_open').on('click', openDrawer);
        return true;
    };

    // 扩展菜单由核心先建好，正常情况一次就挂上；万一抢跑则短暂轮询
    if (!tryAppend()) {
        const timer = setInterval(() => {
            if (tryAppend()) clearInterval(timer);
        }, 500);
    }
}
