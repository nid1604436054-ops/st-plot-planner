// 世界书页签：导入（酒馆 JSON / 纯文本单条粘贴）、书改名/启停/删除、
// 条目级编辑（标题/关键词/内容/删除/添加）、检索测试。
// 「启用」勾选按对话记忆（chatMetadata.plotPlannerBooks）：每个对话一套书单、
// 随聊天文件保存，切换对话自动恢复各自的勾选，不用每次重勾
import { settings, save } from "../../settings.js";
import {
    importSillyTavernJson, createTextBook, addLorebook, removeLorebook,
    findEntry, addEntry, removeEntry, scanLorebooks, parseKeys,
} from "../../lorebook.js";
import { chatMeta, persistChat, chatEnabledBookIds, collectRecentChat, formatChatLog } from "../../context.js";
import { escapeHtml, clamp, readFileAsText } from "../../utils.js";

// 展开状态跨页签重渲染保持：展开条目列表的书 / 正在添加条目的书
const openBooks = new Set();
let addingEntry = null;

// 某本书在当前对话是否启用：有绑定书单看书单，没绑定沿用全局 enabled 默认
function bookEnabledInChat(book) {
    const ids = chatEnabledBookIds();
    return ids ? ids.includes(String(book.id)) : Boolean(book.enabled);
}

// 勾选写进当前对话的书单（第一次勾选时先把各书现状快照成书单，再改这一本）
function toggleBookInChat(id, on) {
    const books = (chatMeta().plotPlannerBooks ??= {});
    if (!Array.isArray(books.enabledIds)) {
        books.enabledIds = settings.lorebooks.filter(b => b.enabled).map(b => String(b.id));
    }
    const ids = new Set(books.enabledIds.map(String));
    on ? ids.add(String(id)) : ids.delete(String(id));
    books.enabledIds = [...ids];
    persistChat();
}

// 新导入的书自动加进本对话书单：已绑定的对话里不在书单就是灭的，不自动加会像没导入成功
function bindNewBook(book) {
    const books = chatMeta().plotPlannerBooks;
    if (Array.isArray(books?.enabledIds) && book.enabled) {
        books.enabledIds.push(String(book.id));
        persistChat();
    }
}

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
                <label class="pp-label">书名</label>
                <input id="pp_wb_txt_name" class="text_pole textarea_compact" type="text" placeholder="文本世界书名称" />
                <label class="pp-label">本条关键词（可选，逗号分隔；之后可随时在条目旁修改）</label>
                <input id="pp_wb_txt_keys" class="text_pole textarea_compact" type="text" placeholder="扑克,德扑" />
                <label class="pp-label">内容（整块作为一条条目导入，不分块）</label>
                <textarea id="pp_wb_txt_content" class="text_pole textarea_compact" rows="8" placeholder="粘贴这一条的完整内容……"></textarea>
                <div class="pp-btn-row">
                    <div id="pp_wb_txt_confirm" class="menu_button">确认导入</div>
                    <div id="pp_wb_txt_cancel" class="menu_button">取消</div>
                </div>
            </div>
            <div class="pp-muted" title="勾选存在聊天文件里（chatMetadata），每个对话一套书单；条目的启停与常驻仍是全局的">「启用」按对话记忆：勾选只对当前对话生效、随聊天文件保存，切换对话自动恢复各自的勾选；还没动过勾选的对话沿用各书的默认启停</div>
            <div id="pp_wb_list" style="margin-top:6px"></div>
        </div>
        <div id="pp_wb_scan_wrap" class="pp-section" style="display:none">
            <b>检索测试</b>
            <span class="pp-muted">输入一段测试剧情，看会命中哪些条目；留空则用最近 ${settings.retrieval.scanDepth} 层对话来测。命中规则：条目已启用，且（勾了常驻，或任一关键词出现在这段文本里）。常驻条目没有关键词也会出现在结果里。</span>
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
                bindNewBook(book);
                toastr.success(`已导入「${book.name}」：${book.entries.length} 个条目`);
                // 酒馆原生常驻条目不写关键词：现在导入时会带上常驻标记（恒带出），无需提醒；
                // 仍要提醒的是既没关键词也没勾常驻的条目——它们永远不会被带进规划
                const keyless = book.entries.filter(en => !en.disabled && !en.constant && !(en.keys ?? []).length).length;
                if (keyless) {
                    toastr.warning(`「${book.name}」有 ${keyless} 条既没有关键词也不是常驻：这些条目永远不会被带进规划。请到条目旁补关键词（如条目标题或剧情常提的词），或勾选「常驻」`);
                }
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
            container.querySelector('#pp_wb_txt_keys').value = '';
            container.querySelector('#pp_wb_txt_content').value = '';
        });
        container.querySelector('#pp_wb_txt_confirm').addEventListener('click', () => {
            const content = container.querySelector('#pp_wb_txt_content').value.trim();
            if (!content) {
                toastr.warning('请先粘贴内容');
                return;
            }
            const name = container.querySelector('#pp_wb_txt_name').value.trim();
            const book = createTextBook(
                name,
                parseKeys(container.querySelector('#pp_wb_txt_keys').value),
                content,
            );
            addLorebook(book);
            openBooks.add(book.id);
            save();
            bindNewBook(book);
            toastr.success(`已导入「${book.name}」，可在条目旁补充关键词`);
            container.querySelector('#pp_wb_txt_cancel').click();
            renderBooks(container);
        });

        const scanWrap = container.querySelector('#pp_wb_scan_wrap');
        container.querySelector('#pp_wb_scan').addEventListener('click', () => {
            scanWrap.style.display = scanWrap.style.display === 'none' ? '' : 'none';
        });
        container.querySelector('#pp_wb_scan_run').addEventListener('click', () => {
            const typed = container.querySelector('#pp_wb_scan_text').value.trim();
            const text = typed || formatChatLog(collectRecentChat(settings.retrieval.scanDepth));
            const hits = scanLorebooks(text, { enabledIds: chatEnabledBookIds() });
            container.querySelector('#pp_wb_scanned_text').textContent = `扫描文本：${clamp(text.replace(/\s+/g, ' '), 160)}`;
            container.querySelector('#pp_wb_hits').innerHTML = hits.length
                ? hits.map(h => `
                    <div class="pp-hit">
                        <b>${escapeHtml(h.bookName)} / ${escapeHtml(h.comment)}${h.constant ? '（常驻）' : ''}</b>
                        <div>${escapeHtml(clamp(h.content, 300))}</div>
                    </div>`).join('')
                : '<div class="pp-muted">未命中任何条目</div>';
        });

        renderBooks(container);
    },
};

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
        const adding = addingEntry === b.id;
        return `
        <div class="pp-book">
            <div class="pp-item">
                <div class="pp-item-main">
                    <input type="text" class="text_pole textarea_compact pp-book-name" data-bname="${b.id}" value="${escapeHtml(b.name)}" title="点击修改书名" />
                </div>
                <div class="pp-item-ops">
                    <span class="menu_button" data-toggle="${b.id}">条目 ${enabledCount(b)}/${b.entries.length} <i class="fa-solid fa-chevron-${open ? 'down' : 'right'}"></i></span>
                    <label title="按对话记忆：勾选随当前聊天文件保存，切换对话自动恢复各自的勾选"><input type="checkbox" data-en="${b.id}" ${bookEnabledInChat(b) ? 'checked' : ''} /> 启用</label>
                    <span class="menu_button fa-solid fa-trash" data-del="${b.id}" title="删除整本"></span>
                </div>
            </div>
            <div class="pp-entries" ${open ? '' : 'hidden'}>
                <div class="pp-btn-row">
                    <span class="menu_button" data-add="${b.id}">添加条目</span>
                    <span class="menu_button" data-all="${b.id}">全选</span>
                    <span class="menu_button" data-none="${b.id}">全不选</span>
                </div>
                ${adding ? `
                <div class="pp-entry-add">
                    <input type="text" class="text_pole textarea_compact" data-add-name="${b.id}" placeholder="条目标题" />
                    <input type="text" class="text_pole textarea_compact" data-add-keys="${b.id}" placeholder="检索关键词，逗号分隔" />
                    <textarea class="text_pole textarea_compact" data-add-content="${b.id}" rows="5" placeholder="条目内容"></textarea>
                    <div class="pp-btn-row">
                        <span class="menu_button" data-add-confirm="${b.id}">确认添加</span>
                        <span class="menu_button" data-add-cancel="${b.id}">取消</span>
                    </div>
                </div>` : ''}
                ${b.entries.map(e => `
                <div class="pp-entry">
                    <div class="pp-entry-row">
                        <input type="checkbox" data-een="${b.id}:${e.uid}" ${e.disabled ? '' : 'checked'} title="启用/停用该条目" />
                        <label class="pp-entry-const" title="常驻：不看关键词，每次检索恒带出（对齐酒馆原生的常驻条目），排在关键词命中前面"><input type="checkbox" data-econst="${b.id}:${e.uid}" ${e.constant ? 'checked' : ''} /> 常驻</label>
                        <input type="text" class="text_pole pp-entry-name" data-ename="${b.id}:${e.uid}" value="${escapeHtml(e.comment)}" placeholder="条目标题" title="条目标题，可直接修改" />
                        <input type="text" class="text_pole pp-entry-keys" data-ekeys="${b.id}:${e.uid}" value="${escapeHtml((e.keys ?? []).join(','))}" placeholder="关键词，逗号分隔" title="检索关键词，逗号分隔；留空则只有勾「常驻」才会带出" />
                        <span class="menu_button fa-solid fa-pen" data-eedit="${b.id}:${e.uid}" title="编辑内容"></span>
                        <span class="menu_button fa-solid fa-trash" data-edel="${b.id}:${e.uid}" title="删除条目"></span>
                    </div>
                </div>`).join('')}
            </div>
        </div>`;
    }).join('');

    list.querySelectorAll('[data-bname]').forEach(el => el.addEventListener('change', () => {
        const book = settings.lorebooks.find(b => b.id === el.dataset.bname);
        if (!book) return;
        book.name = el.value.trim() || book.name;
        el.value = book.name;
        save();
    }));

    list.querySelectorAll('[data-toggle]').forEach(el => el.addEventListener('click', () => {
        const id = el.dataset.toggle;
        openBooks.has(id) ? openBooks.delete(id) : openBooks.add(id);
        renderBooks(container);
    }));
    list.querySelectorAll('[data-en]').forEach(el => el.addEventListener('change', () => {
        toggleBookInChat(el.dataset.en, el.checked);
    }));
    list.querySelectorAll('[data-del]').forEach(el => el.addEventListener('click', () => {
        openBooks.delete(el.dataset.del);
        removeLorebook(el.dataset.del);
        save();
        renderBooks(container);
    }));

    list.querySelectorAll('[data-een]').forEach(el => el.addEventListener('change', () => {
        const [bookId, uid] = el.dataset.een.split(':');
        const entry = findEntry(bookId, uid);
        if (!entry) return;
        entry.disabled = !el.checked;
        save();
        updateBookCount(list, bookId);
    }));
    list.querySelectorAll('[data-econst]').forEach(el => el.addEventListener('change', () => {
        const [bookId, uid] = el.dataset.econst.split(':');
        const entry = findEntry(bookId, uid);
        if (!entry) return;
        entry.constant = el.checked;
        save();
    }));
    list.querySelectorAll('[data-ename]').forEach(el => el.addEventListener('change', () => {
        const [bookId, uid] = el.dataset.ename.split(':');
        const entry = findEntry(bookId, uid);
        if (!entry) return;
        entry.comment = el.value.trim() || '未命名';
        if (!el.value.trim()) el.value = entry.comment;
        save();
    }));
    list.querySelectorAll('[data-ekeys]').forEach(el => el.addEventListener('change', () => {
        const [bookId, uid] = el.dataset.ekeys.split(':');
        const entry = findEntry(bookId, uid);
        if (!entry) return;
        entry.keys = parseKeys(el.value);
        el.value = entry.keys.join(',');
        save();
    }));
    list.querySelectorAll('[data-eedit]').forEach(el => el.addEventListener('click', () => {
        const [bookId, uid] = el.dataset.eedit.split(':');
        const entry = findEntry(bookId, uid);
        if (!entry) return;
        const row = el.closest('.pp-entry');
        const existing = row.querySelector('.pp-entry-edit');
        if (existing) {
            existing.remove();
            return;
        }
        // 内容编辑框就地展开，不整体重渲染，避免长列表滚动位置丢失
        const editor = document.createElement('div');
        editor.className = 'pp-entry-edit';
        editor.innerHTML = `
            <textarea class="text_pole textarea_compact" rows="6" placeholder="条目内容"></textarea>
            <div class="pp-btn-row"><span class="menu_button pp-entry-save">保存内容</span></div>`;
        editor.querySelector('textarea').value = entry.content;
        editor.querySelector('.pp-entry-save').addEventListener('click', () => {
            entry.content = editor.querySelector('textarea').value.trim();
            save();
            toastr.success('内容已保存');
        });
        row.appendChild(editor);
    }));
    list.querySelectorAll('[data-edel]').forEach(el => el.addEventListener('click', () => {
        const [bookId, uid] = el.dataset.edel.split(':');
        removeEntry(bookId, uid);
        save();
        renderBooks(container);
    }));

    list.querySelectorAll('[data-add]').forEach(el => el.addEventListener('click', () => {
        addingEntry = addingEntry === el.dataset.add ? null : el.dataset.add;
        renderBooks(container);
    }));
    list.querySelectorAll('[data-add-cancel]').forEach(el => el.addEventListener('click', () => {
        addingEntry = null;
        renderBooks(container);
    }));
    list.querySelectorAll('[data-add-confirm]').forEach(el => el.addEventListener('click', () => {
        const id = el.dataset.addConfirm;
        const q = attr => list.querySelector(`[data-add-${attr}="${id}"]`);
        const content = q('content').value.trim();
        if (!content) {
            toastr.warning('内容不能为空');
            return;
        }
        addEntry(id, {
            comment: q('name').value.trim(),
            keys: parseKeys(q('keys').value),
            content,
        });
        addingEntry = null;
        save();
        toastr.success('已添加条目');
        renderBooks(container);
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

// 聊天切换时由 index.js 调用：「启用」按对话记忆，列表要刷成新对话的勾选
export function resetWorldbook() {
    const container = document.getElementById('pp_tab_content');
    if (container?.querySelector('#pp_wb_list')) worldbookTab.render(container);
}
