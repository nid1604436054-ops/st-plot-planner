// 世界书页签：导入（酒馆 JSON / 纯文本）、启停删除、检索测试
import { settings, save } from "../../settings.js";
import { importSillyTavernJson, importPlainText, addLorebook, removeLorebook, scanLorebooks } from "../../lorebook.js";
import { collectRecentChat, formatChatLog } from "../../context.js";
import { escapeHtml, clamp, readFileAsText } from "../../utils.js";

export const worldbookTab = {
    id: 'worldbook',
    title: '世界书',
    render(container) {
        container.innerHTML = `
        <div class="pp-section">
            <div class="pp-btn-row">
                <label class="menu_button" for="pp_wb_import_json">导入酒馆 JSON</label>
                <input id="pp_wb_import_json" type="file" accept=".json,application/json" hidden />
                <label class="menu_button" for="pp_wb_import_txt">导入纯文本</label>
                <input id="pp_wb_import_txt" type="file" accept=".txt,text/plain" hidden />
                <div id="pp_wb_scan" class="menu_button">检索测试</div>
            </div>
            <div class="pp-muted">纯文本格式约定见 docs/DEVELOPMENT_PLAN.md §M1（“---” 分隔条目，“# 标题 | 关键词1,关键词2” 作头部，[常驻] 标记常驻）</div>
            <div id="pp_wb_list"></div>
        </div>
        <div id="pp_wb_hits_wrap" class="pp-section" style="display:none">
            <b>检索命中（基于当前聊天）</b>
            <div id="pp_wb_hits"></div>
        </div>`;

        container.querySelector('#pp_wb_import_json').addEventListener('change', async e => {
            const file = e.target.files?.[0];
            if (!file) return;
            try {
                const book = importSillyTavernJson(await readFileAsText(file), file.name.replace(/\.json$/i, ''));
                addLorebook(book);
                save();
                toastr.success(`已导入「${book.name}」：${book.entries.length} 个条目`);
                renderBooks(container);
            } catch (err) {
                toastr.error(`导入失败：${err.message}`);
            }
            e.target.value = '';
        });

        container.querySelector('#pp_wb_import_txt').addEventListener('change', async e => {
            const file = e.target.files?.[0];
            if (!file) return;
            try {
                const book = importPlainText(await readFileAsText(file), file.name.replace(/\.txt$/i, ''));
                addLorebook(book);
                save();
                toastr.success(`已导入「${book.name}」：${book.entries.length} 个条目`);
                renderBooks(container);
            } catch (err) {
                toastr.error(`导入失败：${err.message}`);
            }
            e.target.value = '';
        });

        container.querySelector('#pp_wb_scan').addEventListener('click', () => {
            const scanText = formatChatLog(collectRecentChat(settings.retrieval.scanDepth));
            const hits = scanLorebooks(scanText);
            container.querySelector('#pp_wb_hits_wrap').style.display = '';
            container.querySelector('#pp_wb_hits').innerHTML = hits.length
                ? hits.map(h => `
                    <div class="pp-hit">
                        <b>${escapeHtml(h.bookName)} / ${escapeHtml(h.comment)}</b>
                        <div>${escapeHtml(clamp(h.content, 300))}</div>
                    </div>`).join('')
                : '<div class="pp-muted">未命中任何条目</div>';
        });

        renderBooks(container);
    },
};

function renderBooks(container) {
    const list = container.querySelector('#pp_wb_list');
    if (!settings.lorebooks.length) {
        list.innerHTML = '<div class="pp-muted">还没有导入世界书</div>';
        return;
    }
    list.innerHTML = settings.lorebooks.map(b => `
        <div class="pp-item">
            <div class="pp-item-main">
                <span class="pp-item-title">${escapeHtml(b.name)}</span>
                <span class="pp-muted">${b.entries.length} 条 · ${b.source === 'st-json' ? '酒馆JSON' : '纯文本'}</span>
            </div>
            <div class="pp-item-ops">
                <label><input type="checkbox" data-en="${b.id}" ${b.enabled ? 'checked' : ''} /> 启用</label>
                <span class="menu_button fa-solid fa-trash" data-del="${b.id}" title="删除"></span>
            </div>
        </div>`).join('');

    list.querySelectorAll('[data-en]').forEach(el => el.addEventListener('change', () => {
        const book = settings.lorebooks.find(b => b.id === el.dataset.en);
        if (!book) return;
        book.enabled = el.checked;
        save();
    }));
    list.querySelectorAll('[data-del]').forEach(el => el.addEventListener('click', () => {
        removeLorebook(el.dataset.del);
        save();
        renderBooks(container);
    }));
}
