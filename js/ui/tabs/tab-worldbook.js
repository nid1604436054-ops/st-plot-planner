// 世界书库（第四十三轮从主面板页签搬进设置页，瘦成纯内容库）：导入（酒馆 JSON / 纯文本单条）、
// 书改名/删书、条目编辑（标题/关键词/内容/删除/添加）、书的类型（普通/动作指导书）、回收站。
// 搬走的东西：书的「启用」与条目三档状态（停用/关键词/常驻）→ 监听页「世界书条目」窗按聊天存；
// 「检索测试」→ 监听页（改按监听口径测）。条目上的关键词数据留在库里随条目编辑——一键勾选
// 与监听的关键词档都吃它
import { settings, save } from "../../settings.js";
import {
    importSillyTavernJson, createTextBook, addLorebook, removeLorebook,
    findEntry, addEntry, removeEntry, parseKeys, setBookKind,
    trashBook, trashEntry, restoreTrashItem, purgeTrashItem, clearTrash,
} from "../../lorebook.js";
import { bindNewBookToChat } from "../../context.js";
import { escapeHtml, clamp, readFileAsText } from "../../utils.js";

// 展开状态跨重渲染保持：展开条目列表的书 / 正在添加条目的书
const openBooks = new Set();
let addingEntry = null;

export function renderWorldbookLibrary(container) {
    container.innerHTML = `
    <div class="pp-btn-row">
        <label class="menu_button" for="pp_wb_import_json">导入世界书</label>
        <input id="pp_wb_import_json" type="file" accept=".json,application/json" hidden />
        <div id="pp_wb_import_txt" class="menu_button">导入纯文本</div>
        <div id="pp_wb_trash" class="menu_button" title="删除的书和条目先进回收站（最多 30 条，超出丢最旧）：可恢复或彻底删除。恢复的书按原样放回内容、按「默认未启用」处理（启用归监听页按聊天存，恢复不主动接回书单）；恢复条目回原书、原书没了会提示先恢复那本书；「彻底删除」和「清空」才真的不可恢复">回收站</div>
    </div>
    <div id="pp_wb_txt_editor" style="display:none">
        <label class="pp-label">世界书名称</label>
        <input id="pp_wb_txt_name" class="text_pole textarea_compact" type="text" />
        <label class="pp-label" title="书的类型（建好后在书行上可改）：普通世界书＝条目照常进规划材料；动作指导书＝条目进剧情规划材料时，规划提示词额外加「动作参考」段——动作写法照条目、关键动作与节点挂钩（长线不接）">书类型</label>
        <select id="pp_wb_txt_kind" class="text_pole textarea_compact">
            <option value="normal">普通世界书</option>
            <option value="action">动作指导书</option>
        </select>
        <label class="pp-label" title="可选；多个词用逗号分隔。保存后可随时在条目旁修改">本条关键词（可选，逗号分隔）</label>
        <input id="pp_wb_txt_keys" class="text_pole textarea_compact" type="text" />
        <label class="pp-label" title="整块作为一条条目导入，不分块">内容</label>
        <textarea id="pp_wb_txt_content" class="text_pole textarea_compact" rows="8"></textarea>
        <div class="pp-btn-row">
            <div id="pp_wb_txt_confirm" class="menu_button">确认导入</div>
            <div id="pp_wb_txt_cancel" class="menu_button">取消</div>
        </div>
    </div>
    <div id="pp_wb_list" style="margin-top:6px"></div>
    <div id="pp_wb_trash_wrap" style="display:none">
        <b>回收站</b>
        <div class="pp-btn-row">
            <div id="pp_wb_trash_clear" class="menu_button" title="两次点击确认：点一次变成确认提示，再点一次才执行">清空回收站</div>
        </div>
        <div id="pp_wb_trash_list" style="margin-top:6px"></div>
    </div>`;

    container.querySelector('#pp_wb_import_json').addEventListener('change', async e => {
        const file = e.target.files?.[0];
        if (!file) return;
        try {
            const book = importSillyTavernJson(await readFileAsText(file), file.name.replace(/\.json$/i, ''));
            addLorebook(book);
            openBooks.add(book.id);
            save();
            bindNewBookToChat(book);
            toastr.success(`已导入「${book.name}」：${book.entries.length} 个条目`);
            // 既没关键词也没法被常驻的条目提醒：关键词数据是「按关键词一键选择」与监听「关键词」档
            // 唯一的自动通道——没有它，这条只能靠手动勾选或监听页设常驻
            const keyless = book.entries.filter(en => !(en.keys ?? []).length).length;
            if (keyless) {
                toastr.warning(`「${book.name}」有 ${keyless} 条没有关键词：不会进「按关键词一键选择」、也不会被监听的关键词档带出。请到条目旁补关键词（如条目标题或剧情常提的词），或在监听页把它设为「常驻」`);
            }
            renderBooks(container);
        } catch (err) {
            toastr.error(`导入失败：${err.message}`);
        }
        e.target.value = '';
    });

    // 两个内嵌区（纯文本导入编辑框 / 回收站）互斥展开，再点同一个键收起
    const txtEditor = container.querySelector('#pp_wb_txt_editor');
    const trashWrap = container.querySelector('#pp_wb_trash_wrap');
    const showExclusive = target => {
        const show = target.style.display === 'none';
        [txtEditor, trashWrap].forEach(w => { w.style.display = 'none'; });
        target.style.display = show ? '' : 'none';
        return show;
    };
    container.querySelector('#pp_wb_import_txt').addEventListener('click', () => {
        showExclusive(txtEditor);
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
            container.querySelector('#pp_wb_txt_kind').value === 'action' ? 'action' : 'normal',
        );
        addLorebook(book);
        openBooks.add(book.id);
        save();
        bindNewBookToChat(book);
        toastr.success(`已导入「${book.name}」，可在条目旁补充关键词`);
        container.querySelector('#pp_wb_txt_cancel').click();
        renderBooks(container);
    });

    container.querySelector('#pp_wb_trash').addEventListener('click', () => {
        if (showExclusive(trashWrap)) renderTrash(container);
    });
    container.querySelector('#pp_wb_trash_clear').addEventListener('click', () => {
        if (!clearArmed) {
            clearArmed = true;
            container.querySelector('#pp_wb_trash_clear').textContent = '确认清空？（不可恢复）';
            return;
        }
        clearTrash();
        save();
        toastr.success('回收站已清空');
        renderTrash(container);
        updateTrashLabel(container);
    });
    updateTrashLabel(container);
    renderBooks(container);
}

// 回收站清空按钮的两次点击确认状态：点一次只变文案，再点才执行；每次重渲染回收站时复位
let clearArmed = false;

function updateTrashLabel(container) {
    const btn = container.querySelector('#pp_wb_trash');
    if (!btn) return;
    const n = (settings.lorebookTrash ?? []).length;
    btn.innerHTML = `回收站${n ? `（${n}）` : ''}`;
}

function renderTrash(container) {
    clearArmed = false;
    const wrap = container.querySelector('#pp_wb_trash_wrap');
    if (!wrap) return;
    const listEl = wrap.querySelector('#pp_wb_trash_list');
    const clearBtn = wrap.querySelector('#pp_wb_trash_clear');
    clearBtn.textContent = '清空回收站';
    const trash = settings.lorebookTrash ?? [];
    listEl.innerHTML = trash.length ? trash.map(t => {
        const isBook = t.kind === 'book';
        const title = isBook
            ? `书「${t.book.name}」（${t.book.entries.length} 个条目）`
            : `条目「${t.entry.comment}」（原属「${t.bookName}」）`;
        return `
        <div class="pp-item">
            <div class="pp-item-main">
                <div class="pp-item-title"><i class="fa-solid ${isBook ? 'fa-book' : 'fa-file-lines'}" style="margin-right:4px"></i>${escapeHtml(title)}</div>
                <div class="pp-muted">删于 ${new Date(t.at).toLocaleString()}</div>
            </div>
            <div class="pp-item-ops">
                <span class="menu_button" data-trestore="${t.id}" title="放回原来的位置（书按原样放回、默认未启用——要启用去监听页「世界书条目」窗；条目回原书）">恢复</span>
                <span class="menu_button fa-solid fa-trash" data-tpurge="${t.id}" title="彻底删除，不可恢复"></span>
            </div>
        </div>`;
    }).join('') : '<div class="pp-muted">回收站是空的</div>';

    listEl.querySelectorAll('[data-trestore]').forEach(el => el.addEventListener('click', () => {
        const r = restoreTrashItem(el.dataset.trestore);
        if (!r.ok) {
            toastr.error(r.error);
            return;
        }
        save();
        openBooks.add(r.bookId);
        toastr.success('已恢复（默认未启用——要启用去监听页「世界书条目」窗）');
        renderTrash(container);
        renderBooks(container);
        updateTrashLabel(container);
    }));
    listEl.querySelectorAll('[data-tpurge]').forEach(el => el.addEventListener('click', () => {
        purgeTrashItem(el.dataset.tpurge);
        save();
        renderTrash(container);
        updateTrashLabel(container);
    }));
}

function updateBookCount(list, bookId) {
    const book = settings.lorebooks.find(b => b.id === bookId);
    const toggle = list.querySelector(`[data-toggle="${bookId}"]`);
    if (!book || !toggle) return;
    toggle.innerHTML = `条目 ${book.entries.length} <i class="fa-solid fa-chevron-${openBooks.has(bookId) ? 'down' : 'right'}"></i>`;
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
                    <span class="menu_button" data-toggle="${b.id}">条目 ${b.entries.length} <i class="fa-solid fa-chevron-${open ? 'down' : 'right'}"></i></span>
                    <span class="pp-seg" data-bkind="${b.id}" title="书的类型（2026-09-02 动作指导书）：普通＝条目照常进规划材料；动作指导＝条目进剧情规划材料时提示词额外加「动作参考」段（动作写法照条目、关键动作与节点挂钩）。被动标签——条目收录规则完全不变，长线与检查不接">
                        <span class="pp-seg-opt${b.kind === 'action' ? '' : ' on'}" data-kind="normal">普通书</span>
                        <span class="pp-seg-opt${b.kind === 'action' ? ' on' : ''}" data-kind="action">动作指导书</span>
                    </span>
                    <span class="menu_button fa-solid fa-trash" data-del="${b.id}" title="删除整本"></span>
                </div>
            </div>
            <div class="pp-entries" ${open ? '' : 'hidden'}>
                <div class="pp-btn-row">
                    <span class="menu_button" data-add="${b.id}">添加条目</span>
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
                        <input type="text" class="text_pole pp-entry-name" data-ename="${b.id}:${e.uid}" value="${escapeHtml(e.comment)}" placeholder="条目标题" title="条目标题，可直接修改" />
                        <input type="text" class="text_pole pp-entry-keys" data-ekeys="${b.id}:${e.uid}" value="${escapeHtml((e.keys ?? []).join(','))}" placeholder="关键词，逗号分隔" title="关键词数据：「按关键词一键选择」（剧情指导页）与监听「关键词」档都拿它做匹配；留空则两边都带不出这条（除非手动勾选或监听页设常驻）" />
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
    // 书类型切换（2026-09-02 动作指导书）：普通 ⇄ 动作指导，被动标签——条目规则不动
    list.querySelectorAll('[data-bkind]').forEach(seg => seg.querySelectorAll('.pp-seg-opt').forEach(opt => opt.addEventListener('click', () => {
        const id = seg.dataset.bkind;
        const book = settings.lorebooks.find(b => b.id === id);
        const next = opt.dataset.kind === 'action' ? 'action' : 'normal';
        if (!book || (book.kind === 'action') === (next === 'action')) return;
        setBookKind(id, next);
        save();
        renderBooks(container);
        toastr.info(next === 'action'
            ? `「${book.name}」已标为动作指导书：条目进剧情规划材料时，提示词额外加「动作参考」段（动作写法照条目、关键动作与节点挂钩）；长线与检查报告不接`
            : `「${book.name}」恢复为普通世界书`);
    })));
    list.querySelectorAll('[data-del]').forEach(el => el.addEventListener('click', () => {
        const book = settings.lorebooks.find(b => b.id === el.dataset.del);
        if (book) trashBook(book);
        removeLorebook(el.dataset.del);
        openBooks.delete(el.dataset.del);
        save();
        toastr.success(`已删除「${book?.name ?? ''}」，进了回收站，可恢复`);
        renderBooks(container);
        updateTrashLabel(container);
        if (container.querySelector('#pp_wb_trash_wrap')?.style.display !== 'none') renderTrash(container);
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
        const book = settings.lorebooks.find(b => b.id === bookId);
        const entry = findEntry(bookId, uid);
        if (book && entry) trashEntry(book, entry);
        removeEntry(bookId, uid);
        save();
        toastr.success('已删除条目，进了回收站，可恢复');
        renderBooks(container);
        updateTrashLabel(container);
        if (container.querySelector('#pp_wb_trash_wrap')?.style.display !== 'none') renderTrash(container);
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
}

// 聊天切换时由 index.js 调用：世界书库在设置页的折叠区里，只有它开着才需要刷新（文档级查找）
export function resetWorldbook() {
    const host = document.getElementById('pp_set_wb_body');
    if (host) renderWorldbookLibrary(host);
}
