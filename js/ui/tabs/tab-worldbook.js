// 世界书页签：导入（酒馆 JSON / 纯文本粘贴）、书籍与条目级启停、删除、检索测试
import { settings, save } from "../../settings.js";
import { importSillyTavernJson, importPlainText, addLorebook, removeLorebook, scanLorebooks } from "../../lorebook.js";
import { collectRecentChat, formatChatLog } from "../../context.js";
import { escapeHtml, clamp, readFileAsText } from "../../utils.js";

// 展开着条目列表的书 id：页签重渲染后仍保持展开状态
const openBooks = new Set();

export const worldbookTab = {
    id: 'worldbook',
    title: '世界书',
    render(container) {
        container.innerHTML = `
        <div class="pp-section">
            <div class="pp-btn-row">
                <label class="menu_button" for="pp_wb_import_json">导入世界书</label>
                <input id="pp_wb_import_json" type="file" accept=".json,application/json" hidden />
                <div id="pp_wb_import_txt" class="menu_button">导入纯文本</div>
                <div id="pp_wb_scan" class="menu_button">检索测试</div>
            </div>
            <div id="pp_wb_txt_editor" style="display:none">
                <label class="pp-label">名称</label>
                <input id="pp_wb_txt_name" class="text_pole textarea_compact" type="text" placeholder="文本世界书名称" />
                <label class="pp-label">内容：“---” 单独一行分隔条目；每条第一行可写 “# 标题 | 关键词1,关键词2”，关键词前加 [常驻] 表示一直生效</label>
                <textarea id="pp_wb_txt_content" class="text_pole textarea_compact" rows="8" placeholder="# 皇宫布局 | 皇宫,王室&#10;皇宫分为前三殿后六宫……&#10;---&#10;# 龙骑士团 | 龙骑士&#10;龙骑士团直属王室……"></textarea>
                <div class="pp-btn-row">
                    <div id="pp_wb_txt_confirm" class="menu_button">确认导入</div>
                    <div id="pp_wb_txt_cancel" class="menu_button">取消</div>
                </div>
            </div>
            <div id="pp_wb_list"></div>
        </div>
        <div id="pp_wb_scan_wrap" class="pp-section" style="display:none">
            <b>检索测试</b>
            <span class="pp-muted">输入一段测试剧情，看会命中哪些条目；留空则用最近 ${settings.retrieval.scanDepth} 层对话来测。</span>
            <textarea id="pp_wb_scan_text" class="text_pole textarea_compact" rows="3" placeholder="例如：她推开皇宫侧门，撞见了龙骑士团的队长"></textarea>
            <div class="pp-btn-row">
                <div id="pp_wb_scan_run" class="menu_button">测试命中</div>
            </div>
            <div id="pp_wb_scanned_text" class="pp-muted"></div>
            <div id="pp_wb_hits"></div>
        </div>`;

        container.querySelector('#pp_wb_import_json').addEventListener('change', async e => {
            const file = e.target.files?.[0];
            if (!file) return;
            try {
                const book = importSillyTavernJson(await readFileAsText(file), file.name.replace(/\.json$/i, ''));
                addLorebook(book);
                openBooks.add(book.id);
                save();
                toastr.success(`已导入「${book.name}」：${book.entries.length} 个条目`);
                renderBooks(container);
            } catch (err) {
                toastr.error(`导入失败：${err.message}`);
            }
            e.target.value = '';
        });

        const txtEditor = container.querySelector('#pp_wb_txt_editor');
        container.querySelector('#pp_wb_import_txt').addEventListener('click', () => {
            txtEditor.style.display = txtEditor.style.display === 'none' ? '' : 'none';
        });
        container.querySelector('#pp_wb_txt_cancel').addEventListener('click', () => {
            txtEditor.style.display = 'none';
            container.querySelector('#pp_wb_txt_name').value = '';
            container.querySelector('#pp_wb_txt_content').value = '';
        });
        container.querySelector('#pp_wb_txt_confirm').addEventListener('click', () => {
            const content = container.querySelector('#pp_wb_txt_content').value.trim();
            if (!content) {
                toastr.warning('请先粘贴内容');
                return;
            }
            try {
                const name = container.querySelector('#pp_wb_txt_name').value.trim() || '导入的文本世界书';
                const book = importPlainText(content, name);
                addLorebook(book);
                openBooks.add(book.id);
                save();
                toastr.success(`已导入「${book.name}」：${book.entries.length} 个条目`);
                container.querySelector('#pp_wb_txt_cancel').click();
                renderBooks(container);
            } catch (err) {
                toastr.error(`导入失败：${err.message}`);
            }
        });

        const scanWrap = container.querySelector('#pp_wb_scan_wrap');
        container.querySelector('#pp_wb_scan').addEventListener('click', () => {
            scanWrap.style.display = scanWrap.style.display === 'none' ? '' : 'none';
        });
        container.querySelector('#pp_wb_scan_run').addEventListener('click', () => {
            const typed = container.querySelector('#pp_wb_scan_text').value.trim();
            const text = typed || formatChatLog(collectRecentChat(settings.retrieval.scanDepth));
            const hits = scanLorebooks(text);
            container.querySelector('#pp_wb_scanned_text').textContent = `扫描文本：${clamp(text.replace(/\s+/g, ' '), 160)}`;
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

function entryKeySummary(e) {
    if (e.constant) return '常驻';
    const parts = [];
    if (e.keys.length) parts.push(e.keys.join('、'));
    if (e.secondaryKeys.length) parts.push(`次要：${e.secondaryKeys.join('、')}`);
    if (e.regex.length) parts.push(`正则×${e.regex.length}`);
    return parts.join(' · ') || '（无关键词，不会命中）';
}

function enabledCount(book) {
    return book.entries.filter(e => !e.disabled).length;
}

function updateBookCount(list, bookId) {
    const book = settings.lorebooks.find(b => b.id === bookId);
    const toggle = list.querySelector(`[data-toggle="${bookId}"]`);
    if (!book || !toggle) return;
    toggle.innerHTML = `条目 ${enabledCount(book)}/${book.entries.length} <i class="fa-solid fa-chevron-${openBooks.has(bookId) ? 'down' : 'right'}"></i>`;
}

function renderBooks(container) {
    const list = container.querySelector('#pp_wb_list');
    if (!settings.lorebooks.length) {
        list.innerHTML = '<div class="pp-muted">还没有导入世界书</div>';
        return;
    }
    list.innerHTML = settings.lorebooks.map(b => {
        const open = openBooks.has(b.id);
        return `
        <div class="pp-book">
            <div class="pp-item">
                <div class="pp-item-main">
                    <span class="pp-item-title">${escapeHtml(b.name)}</span>
                </div>
                <div class="pp-item-ops">
                    <span class="menu_button" data-toggle="${b.id}">条目 ${enabledCount(b)}/${b.entries.length} <i class="fa-solid fa-chevron-${open ? 'down' : 'right'}"></i></span>
                    <label><input type="checkbox" data-en="${b.id}" ${b.enabled ? 'checked' : ''} /> 启用</label>
                    <span class="menu_button fa-solid fa-trash" data-del="${b.id}" title="删除"></span>
                </div>
            </div>
            <div class="pp-entries" ${open ? '' : 'hidden'}>
                <div class="pp-btn-row">
                    <span class="menu_button" data-all="${b.id}">全选</span>
                    <span class="menu_button" data-none="${b.id}">全不选</span>
                </div>
                ${b.entries.map(e => `
                <div class="pp-entry-row">
                    <input type="checkbox" data-een="${b.id}:${e.uid}" ${e.disabled ? '' : 'checked'} title="启用/停用该条目" />
                    <span class="pp-entry-name">${escapeHtml(e.comment)}</span>
                    <span class="pp-muted">${escapeHtml(entryKeySummary(e))}</span>
                </div>`).join('')}
            </div>
        </div>`;
    }).join('');

    list.querySelectorAll('[data-toggle]').forEach(el => el.addEventListener('click', () => {
        const id = el.dataset.toggle;
        openBooks.has(id) ? openBooks.delete(id) : openBooks.add(id);
        renderBooks(container);
    }));
    list.querySelectorAll('[data-en]').forEach(el => el.addEventListener('change', () => {
        const book = settings.lorebooks.find(b => b.id === el.dataset.en);
        if (!book) return;
        book.enabled = el.checked;
        save();
    }));
    list.querySelectorAll('[data-del]').forEach(el => el.addEventListener('click', () => {
        openBooks.delete(el.dataset.del);
        removeLorebook(el.dataset.del);
        save();
        renderBooks(container);
    }));
    list.querySelectorAll('[data-een]').forEach(el => el.addEventListener('change', () => {
        const [bookId, uid] = el.dataset.een.split(':');
        const book = settings.lorebooks.find(b => b.id === bookId);
        const entry = book?.entries.find(e => String(e.uid) === uid);
        if (!entry) return;
        entry.disabled = !el.checked;
        save();
        updateBookCount(list, bookId);
    }));
    list.querySelectorAll('[data-all]').forEach(el => el.addEventListener('click', () => {
        setAllEntries(el.dataset.all, false, container);
    }));
    list.querySelectorAll('[data-none]').forEach(el => el.addEventListener('click', () => {
        setAllEntries(el.dataset.none, true, container);
    }));
}

function setAllEntries(bookId, disabled, container) {
    const book = settings.lorebooks.find(b => b.id === bookId);
    if (!book) return;
    book.entries.forEach(e => { e.disabled = disabled; });
    save();
    renderBooks(container);
}
