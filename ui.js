import { autoMatch, autoMatchScoped, buildUpdate, canonical, cleanEntryName, classifyIncoming, listEntries, orderWithPinned, pairChanged, pairManually, parseBook, parseNameList, scopeMatch, title, unmatchedNames, workKeysOf } from './core.js';

function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

export class UpdaterWindow {
    constructor(service) {
        this.service = service;
        this.books = [];
        this.oldBook = this.newBook = this.backup = null;
        this.oldName = this.newName = '';
        this.sourceKind = 'book';
        this.pairs = [];
        this.changeCache = new Map();
        this.incomingCache = null;
        this.newSelection = new Map();
        this.forcedNew = new Set();
        this.selectedOld = this.selectedNew = null;
        this.previewOpen = false;
        this.listSplit = globalThis.matchMedia?.('(max-width: 680px)').matches && globalThis.innerHeight > 600 ? 60 : 68;
        this.mode = 'content';
        this.fusion = false;
        this.scopeNames = [];
        this.scopeWorks = [];
        this.pinMatches = true;
        this.busy = false;
        this.disposed = false;
        this.events = new AbortController();
        this.urls = new Set();
        this.timers = new Set();
        this.previousFocus = null;
        this.build();
        const syncViewport = () => {
            const viewport = globalThis.visualViewport;
            const layoutHeight = globalThis.innerHeight || 0;
            const measured = viewport?.height || 0;
            // Android WebView 在弹窗刚插入或输入法切换瞬间可能报一个很小的 visualViewport，
            // 直接压扁整个窗口（表现为只看得见一个条目）。小于 200px 时退回布局视口。
            const viewportHeight = Math.max(320, measured >= 200 ? measured : layoutHeight);
            this.dialog.classList.toggle('stwu-keyboard', !!(viewport && viewport.height < globalThis.innerHeight - 100 && document.activeElement?.matches('[data-search], [data-scope]')));
            this.dialog.style.setProperty('--wu-vh', viewportHeight + 'px');
            const expanded = this.dialog.classList.contains('stwu-expanded');
            const mobile = globalThis.matchMedia?.('(max-width: 680px)').matches;
            const dialogHeight = expanded ? viewportHeight - (mobile ? 0 : 12) : mobile ? viewportHeight - 16 : Math.min(840, viewportHeight - 32);
            const verticalInset = expanded && mobile ? 0 : expanded ? 6 : Math.max(8, (viewportHeight - dialogHeight) / 2);
            this.dialog.style.setProperty('--wu-top', ((viewport?.offsetTop || 0) + verticalInset) + 'px');
        };
        this.syncViewport = syncViewport;
        this.on(globalThis, 'resize', syncViewport);
        this.on(this.dialog, 'focusin', syncViewport);
        this.on(this.dialog, 'focusout', () => queueMicrotask(syncViewport));
        if (globalThis.visualViewport) {
            this.on(globalThis.visualViewport, 'resize', syncViewport);
            this.on(globalThis.visualViewport, 'scroll', syncViewport);
        }
        syncViewport();
    }

    on(node, type, fn) { node.addEventListener(type, fn, { signal: this.events.signal }); }
    find(selector) { return this.dialog.querySelector(selector); }

    build() {
        this.dialog = element('dialog', 'popup wider_dialogue_popup stwu stwu-dialog');
        if (typeof this.dialog.showModal !== 'function') throw new Error('当前浏览器不支持对照窗口，请更新浏览器或 Android WebView。');
        this.dialog.id = 'st-worldbook-updater-window';
        this.dialog.setAttribute('aria-labelledby', 'stwu-heading');
        // This template is static. Imported names and content are always assigned with textContent.
        this.dialog.innerHTML = `
          <div class="popup-body"><div class="popup-content stwu-layout">
            <header class="stwu-header">
              <div><h2 id="stwu-heading">世界书更新器</h2><p>左右对照，点击条目后在下方查看正文</p></div>
              <div class="stwu-header-actions">
                <button type="button" class="menu_button stwu-icon-button" data-action="toggle-size" aria-label="放大窗口" aria-expanded="false" title="放大窗口"><i class="fa-solid fa-expand" aria-hidden="true"></i></button>
                <details class="stwu-header-menu">
                  <summary class="menu_button stwu-icon-button" aria-label="更多操作" title="更多操作"><i class="fa-solid fa-ellipsis" aria-hidden="true"></i></summary>
                  <div class="stwu-header-menu-content"><button type="button" class="menu_button" data-action="reload">重新载入</button><button type="button" class="menu_button" data-action="close">关闭窗口</button></div>
                </details>
              </div>
            </header>
            <div class="stwu-notice" role="status" aria-live="polite">先选择原世界书，再选择新版或打开 JSON 文件。</div>
            <div class="stwu-workspace" data-preview-open="false">
              <div class="stwu-panels">
                <section class="stwu-pane" data-side="old" aria-label="原世界书">
                  <div class="stwu-pane-head"><h3>原世界书</h3><span class="stwu-count"></span></div>
                  <select class="text_pole" aria-label="选择原世界书" data-book="old"></select>
                  <div class="stwu-source-line">原书独有条目会保留</div>
                  <input class="text_pole" type="search" data-search="old" aria-label="搜索原世界书条目" placeholder="搜索标题、关键词" autocomplete="off">
                  <ol class="stwu-list" data-list="old" aria-label="原世界书条目"></ol>
                </section>
                <section class="stwu-pane" data-side="new" aria-label="新版世界书">
                  <div class="stwu-pane-head"><h3>新版世界书</h3><span class="stwu-count"></span></div>
                  <select class="text_pole" aria-label="选择新版世界书" data-book="new"></select>
                  <div class="stwu-source-line"><button type="button" class="menu_button" data-action="file">打开 JSON 文件</button><input type="file" data-file accept=".json,application/json" hidden></div>
                  <input class="text_pole" type="search" data-search="new" aria-label="搜索新版世界书条目" placeholder="搜索标题、关键词" autocomplete="off">
                  <ol class="stwu-list" data-list="new" aria-label="新版世界书条目"></ol>
                </section>
              </div>
              <div class="stwu-splitter" role="separator" aria-label="调整列表和正文区域高度" aria-orientation="horizontal" aria-valuemin="15" aria-valuemax="92" aria-valuenow="68" tabindex="0" data-splitter><span></span></div>
              <section class="stwu-preview" aria-label="正文对照">
                <div class="stwu-preview-head"><h3><i class="fa-solid fa-align-left" aria-hidden="true"></i> 正文对照</h3><button type="button" class="menu_button stwu-icon-button" data-action="collapse-preview" aria-label="收起正文对照" title="收起正文对照"><i class="fa-solid fa-chevron-down" aria-hidden="true"></i></button></div>
                <div class="stwu-preview-grid">
                  <article class="stwu-preview-pane" data-preview-side="old">
                    <h4>原书 · <span data-preview-title="old">未选择条目</span></h4><p class="stwu-preview-keys" data-preview-keys="old"></p>
                    <div class="stwu-preview-scroll"><pre class="stwu-content" data-preview-content="old">点击任一条目后，正文会显示在这里。</pre><details class="stwu-entry-settings"><summary>查看条目设置</summary><pre class="stwu-content" data-preview-settings="old"></pre></details></div>
                  </article>
                  <article class="stwu-preview-pane" data-preview-side="new">
                    <h4>新版 · <span data-preview-title="new">未选择条目</span></h4><p class="stwu-preview-keys" data-preview-keys="new"></p>
                    <div class="stwu-preview-scroll"><pre class="stwu-content" data-preview-content="new">点击任一条目后，正文会显示在这里。</pre><details class="stwu-entry-settings"><summary>查看条目设置</summary><pre class="stwu-content" data-preview-settings="new"></pre></details></div>
                  </article>
                </div>
              </section>
            </div>
            <details class="stwu-pairbar">
              <summary><i class="fa-solid fa-link" aria-hidden="true"></i><span>配对与条目操作</span><span class="stwu-pairhint">点击两边条目可手动配对</span></summary>
              <div class="stwu-pairbar-content"><select class="text_pole" data-pair-action aria-label="配对操作"><option value="" disabled selected>配对操作</option><option value="pair">配对所选</option><option value="unpair">解除所选配对</option><option value="unpair-all">解除全部配对</option><option value="auto">重新自动匹配</option><option value="new">标记为新条目</option></select></div>
            </details>
            <footer class="stwu-footer">
              <details class="stwu-scope">
                <summary><span>定点名单</span><span class="stwu-scope-state" data-scope-state>整本参与</span></summary>
                <div class="stwu-scope-content">
                  <label for="stwu-scope-input">每行一个名字；留空时处理整本</label>
                  <textarea class="text_pole" id="stwu-scope-input" data-scope rows="2" placeholder="每行一个名字；可先写一行「作品别名：原神=Genshin」用于去掉名字里的作品前缀。留空则整本参与。"></textarea>
                  <div class="stwu-scope-actions"><button type="button" class="menu_button" data-action="copy-names">复制来源条目名</button><label class="stwu-scope-pin"><input type="checkbox" data-scope-pin checked><span>匹配置顶（仅显示）</span></label></div>
                  <p class="stwu-scope-report" data-scope-report role="status"></p>
                  <details class="stwu-scope-spec"><summary>名单怎么写才一定匹配</summary><ol><li>每行一个角色名，写全名，不带编号、书名号、引号和说明文字。</li><li>别名或英文名写在括号里或跟在等号后。</li><li>形态/皮肤自动归到主名下。</li><li>不要写作品名；要写需声明“作品别名：原神=Genshin”。</li></ol><p>多写名字不会误伤：没命中的只会出现在「未找到」里，不会写进世界书。</p></details>
                </div>
              </details>
              <div class="stwu-options"><select class="text_pole" data-selection aria-label="勾选操作"><option value="" disabled selected>勾选操作</option><option value="all">全部勾选</option><option value="none">全部取消</option><option value="updates">仅勾选更新</option><option value="additions">仅勾选新增</option></select><select class="text_pole" data-mode aria-label="操作与替换范围"><option value="content">更新 · 仅正文</option><option value="full">更新 · 完整条目</option><option value="merge-content">融合 · 仅正文</option><option value="merge-full">融合 · 完整条目</option></select></div>
              <div class="stwu-bottom"><details class="stwu-backup"><summary>备份与恢复</summary><div><p class="stwu-backup-info">选择原世界书后查看备份。</p><button type="button" class="menu_button" data-action="download">下载备份</button><button type="button" class="menu_button" data-action="restore">恢复备份</button></div></details><span class="stwu-selection" aria-live="polite">已选 0 条</span><button type="button" class="menu_button stwu-primary" data-action="apply">替换所选</button></div>
            </footer>
          </div></div>`;
        document.body.append(this.dialog);
        this.find('.stwu-scope').open = globalThis.matchMedia?.('(min-width: 681px) and (min-height: 521px)').matches ?? true;
        const workspace = this.find('.stwu-workspace');
        workspace.style.setProperty('--stwu-list-size', `${this.listSplit}%`);
        const headerMenu = this.find('.stwu-header-menu');
        this.on(headerMenu, 'toggle', () => this.dialog.classList.toggle('stwu-tools-expanded', headerMenu.open));
        this.on(this.dialog, 'cancel', event => { event.preventDefault(); if (!this.busy) this.hide(); });
        this.on(this.dialog, 'click', event => {
            const action = event.target.closest('[data-action]')?.dataset.action;
            if (!action || this.busy) return;
            if (action === 'close') this.hide();
            if (action === 'toggle-size') {
                const expanded = !this.dialog.classList.contains('stwu-expanded');
                this.dialog.classList.toggle('stwu-expanded', expanded);
                const button = this.find('[data-action="toggle-size"]');
                button.setAttribute('aria-expanded', String(expanded));
                button.setAttribute('aria-label', expanded ? '还原窗口' : '放大窗口');
                button.title = expanded ? '还原窗口' : '放大窗口';
                button.querySelector('i').className = `fa-solid ${expanded ? 'fa-compress' : 'fa-expand'}`;
                this.syncViewport();
            }
            if (action === 'collapse-preview') {
                this.previewOpen = false;
                this.renderPreview();
            }
            if (action === 'reload') { this.find('.stwu-header-menu').open = false; this.run(() => this.reload()); }
            if (action === 'file') this.find('[data-file]').click();
            if (action === 'apply') this.run(() => this.apply());
            if (action === 'copy-names') this.run(() => this.copySourceNames());
            if (action === 'restore') this.run(() => this.restore());
            if (action === 'download') this.download();
        });
        const splitter = this.find('[data-splitter]');
        const setListSplit = value => {
            const maximum = Math.max(15, Math.min(92, 100 - (76 / Math.max(1, workspace.clientHeight)) * 100));
            this.listSplit = Math.max(15, Math.min(maximum, value));
            workspace.style.setProperty('--stwu-list-size', `${this.listSplit}%`);
            splitter.setAttribute('aria-valuemax', String(Math.floor(maximum)));
            splitter.setAttribute('aria-valuenow', String(Math.round(this.listSplit)));
        };
        setListSplit(this.listSplit);
        this.on(splitter, 'pointerdown', event => {
            if (!this.previewOpen || (event.pointerType === 'mouse' && event.button !== 0)) return;
            event.preventDefault();
            splitter.setPointerCapture(event.pointerId);
        });
        this.on(splitter, 'pointermove', event => {
            if (!splitter.hasPointerCapture(event.pointerId)) return;
            const bounds = workspace.getBoundingClientRect();
            setListSplit(((event.clientY - bounds.top) / bounds.height) * 100);
        });
        for (const type of ['pointerup', 'pointercancel']) this.on(splitter, type, event => {
            if (splitter.hasPointerCapture(event.pointerId)) splitter.releasePointerCapture(event.pointerId);
        });
        this.on(splitter, 'keydown', event => {
            if (!this.previewOpen) return;
            if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
                event.preventDefault(); setListSplit(this.listSplit + (event.key === 'ArrowUp' ? -5 : 5));
            } else if (event.key === 'Home') { event.preventDefault(); setListSplit(15); }
            else if (event.key === 'End') { event.preventDefault(); setListSplit(92); }
        });
        for (const side of ['old', 'new']) {
            this.on(this.find(`[data-book="${side}"]`), 'change', e => this.run(() => this.loadSide(side, e.target.value)));
            this.on(this.find(`[data-search="${side}"]`), 'input', () => this.renderList(side));
            const list = this.find(`[data-list="${side}"]`);
            this.on(list, 'click', event => {
                const button = event.target.closest('.stwu-entry-button');
                if (button) this.select(side, button.closest('[data-id]').dataset.id);
            });
            this.on(list, 'change', event => {
                if (!event.target.matches('input[type="checkbox"]')) return;
                const id = event.target.closest('[data-id]').dataset.id;
                const pair = this.pairs.find(p => p[side === 'old' ? 'oldId' : 'newId'] === id);
                if (pair && this.changed(pair)) pair.checked = event.target.checked;
                else if (side === 'new' && this.addable(id)) this.newSelection.set(id, event.target.checked);
                this.render();
            });
        }
        this.on(this.find('[data-mode]'), 'change', event => {
            this.fusion = event.target.value.startsWith('merge-');
            this.mode = event.target.value.endsWith('full') ? 'full' : 'content';
            this.message(this.fusion ? '融合模式：勾选的新条目会追加到左侧；待处理条目需先配对或标记新增。' : '更新模式：只更新已配对条目，不新增。');
            this.render();
        });
        this.on(this.find('[data-scope]'), 'change', () => this.applyScope());
        this.on(this.find('[data-scope-pin]'), 'change', event => { this.pinMatches = event.target.checked; this.render(); });
        this.on(this.find('[data-selection]'), 'change', event => {
            const action = event.target.value; event.target.value = '';
            this.setSelection(action);
        });
        this.on(this.find('[data-pair-action]'), 'change', event => {
            const action = event.target.value; event.target.value = '';
            if (action === 'pair') this.manualPair();
            if (action === 'unpair') this.unpair();
            if (action === 'unpair-all') { this.pairs = []; this.invalidateIncoming(); this.message('已解除全部配对，可在配对操作中重新自动匹配。'); this.render(); }
            if (action === 'auto') { this.repair(); this.message(`已重新自动匹配 ${this.pairs.length} 组，并重置本次勾选。`); this.render(); }
            if (action === 'new' && this.selectedNew) {
                const id = this.selectedNew;
                if (this.forcedNew.has(id)) { this.forcedNew.delete(id); this.newSelection.set(id, false); }
                else if (this.incoming().get(id) === 'review') { this.forcedNew.add(id); this.newSelection.set(id, true); }
                this.message(this.forcedNew.has(id) ? '已标记为新条目，执行融合时会分配新编号追加。' : '已取消新增标记。'); this.render();
            }
        });
        this.on(this.find('[data-file]'), 'change', event => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file) this.run(async () => {
                if (file.size > 20 * 1024 * 1024) throw new Error('文件超过 20 MB，请先拆分世界书。');
                const book = parseBook(await file.text());
                this.newBook = book; this.newName = file.name; this.sourceKind = 'file';
                this.repair(); this.selectors(); this.message(`已载入 ${file.name}，自动配对 ${this.pairs.length} 组。`);
            });
        });
        this.selectors(); this.render();
    }

    async open() {
        if (this.dialog.open || this.disposed) return;
        this.previousFocus = document.activeElement;
        this.dialog.showModal();
        if (!this.books.length) await this.run(() => this.reload());
    }

    hide() {
        this.dialog.close();
        this.previousFocus?.focus?.();
    }

    message(text, error = false) {
        const node = this.find('.stwu-notice');
        node.textContent = text;
        node.classList.toggle('stwu-error', error);
        node.setAttribute('role', error ? 'alert' : 'status');
    }

    async run(work) {
        if (this.busy || this.disposed) return;
        this.busy = true; this.renderControls();
        try { await work(); }
        catch (error) { if (!this.disposed) this.message(error.message || '操作未完成，请重试。', true); }
        finally { this.busy = false; if (!this.disposed) this.render(); }
    }

    selectors() {
        for (const side of ['old', 'new']) {
            const select = this.find(`[data-book="${side}"]`);
            select.replaceChildren(new Option(side === 'old' ? '选择原世界书' : '选择新版世界书', ''));
            for (const book of this.books) select.add(new Option(book.label, 'book:' + book.name));
            if (side === 'new' && this.sourceKind === 'file' && this.newBook) select.add(new Option('文件：' + this.newName, 'file:'));
            select.value = side === 'old' ? (this.oldName ? 'book:' + this.oldName : '') : (this.newBook ? (this.sourceKind === 'file' ? 'file:' : 'book:' + this.newName) : '');
        }
    }

    async reload() {
        this.message('正在读取世界书列表…');
        this.books = await this.service.list();
        if (this.oldName) {
            this.oldBook = null; this.backup = null;
            if (this.books.some(x => x.name === this.oldName)) this.oldBook = await this.service.read(this.oldName);
            else this.oldName = '';
        }
        if (this.sourceKind === 'book' && this.newName) {
            this.newBook = null;
            if (this.books.some(x => x.name === this.newName)) this.newBook = await this.service.read(this.newName);
            else this.newName = '';
        }
        this.repair(); this.selectors();
        const recoveryMessage = await this.loadBackup();
        this.message(recoveryMessage || (this.oldBook && this.newBook ? `已重新载入，自动配对 ${this.pairs.length} 组。` : '先选择原世界书，再选择新版或打开 JSON 文件。'));
    }

    async loadSide(side, value) {
        if (value === 'file:') return;
        const name = value.startsWith('book:') ? value.slice(5) : '';
        if (side === 'old') { this.oldBook = null; this.oldName = name; this.backup = null; }
        else { this.newBook = null; this.newName = name; this.sourceKind = 'book'; }
        this.repair(); this.render();
        if (!name) { this.message('请选择两边的世界书。'); return; }
        this.message('正在读取世界书…');
        const book = await this.service.read(name);
        if (side === 'old') this.oldBook = book;
        else this.newBook = book;
        this.repair();
        const recoveryMessage = side === 'old' ? await this.loadBackup() : '';
        this.message(recoveryMessage || `已读取 ${name}。${this.oldBook && this.newBook ? `自动配对 ${this.pairs.length} 组。` : ''}`);
    }

    async loadBackup() {
        this.backup = null;
        if (!this.oldBook) return '';
        const { backup, message } = await this.service.inspectBackup(this.oldName, this.oldBook);
        this.backup = backup;
        return message;
    }

    repair() {
        this.selectedOld = this.selectedNew = null;
        this.changeCache.clear();
        this.invalidateIncoming(); this.newSelection.clear(); this.forcedNew.clear();
        this.pairs = this.oldBook && this.newBook
            ? (this.scopeNames.length ? autoMatchScoped(this.oldBook, this.newBook, this.scopeNames, workKeysOf(this.scopeWorks)) : autoMatch(this.oldBook, this.newBook))
            : [];
    }

    applyScope() {
        const { names, works } = parseNameList(this.find('[data-scope]').value);
        const sameNames = names.length === this.scopeNames.length && names.every((name, index) => name === this.scopeNames[index]);
        const sameWorks = works.length === this.scopeWorks.length && works.every((work, index) => work === this.scopeWorks[index]);
        if (sameNames && sameWorks) return;
        this.scopeNames = names;
        this.scopeWorks = works;
        this.repair();
        this.message(this.scopeText() || '未设置定点名单：整本参与替换与复制。');
        this.render();
        for (const side of ['old', 'new']) this.find(`[data-list="${side}"]`).scrollTop = 0;
    }

    async copySourceNames() {
        if (!this.newBook) { this.message('先选择来源世界书，再复制条目名。', true); return; }
        const names = [];
        for (const { entry } of listEntries(this.newBook)) {
            const name = cleanEntryName(entry.comment || '') || title(entry);
            if (name && !names.includes(name)) names.push(name);
        }
        if (!names.length) { this.message('来源世界书没有可用的条目名。', true); return; }
        const text = names.join('\n');
        try {
            if (!navigator.clipboard?.writeText) throw new Error('clipboard');
            await navigator.clipboard.writeText(text);
            this.message(`已复制 ${names.length} 个来源条目名；交给 AI 挑出属于这本书的角色，再粘回定点名单即可 100% 对上。`);
        } catch {
            this.message(`当前浏览器不允许自动复制（共 ${names.length} 个条目名）。可改用电脑浏览器，或按右侧列表手动核对。`, true);
        }
    }

    inScope(id) {
        if (!this.scopeNames.length) return true;
        return !!this.newBook?.entries?.[id] && !!scopeMatch(this.newBook.entries[id], this.scopeNames, workKeysOf(this.scopeWorks));
    }

    scopeText() {
        if (!this.scopeNames.length || !this.newBook) return '';
        const workKeys = workKeysOf(this.scopeWorks);
        const hit = Object.values(this.newBook.entries).filter(entry => scopeMatch(entry, this.scopeNames, workKeys)).length;
        const paired = new Set(this.pairs.map(pair => pair.newId));
        let addable = 0, blocked = 0;
        for (const [id, state] of this.incoming()) {
            if (!this.inScope(id) || paired.has(id)) continue;
            if (state === 'new') addable++;
            else if (state === 'review') blocked++;
        }
        const missing = unmatchedNames(this.newBook, this.scopeNames, workKeys);
        const parts = [`名单 ${this.scopeNames.length} 个${this.scopeWorks.length ? `（作品 ${this.scopeWorks.length} 个）` : ''} → 母本命中 ${hit} 条`, `已配对 ${paired.size} 条（替换）`, `可新增 ${addable} 条（复制）`];
        if (blocked) parts.push(`待处理 ${blocked} 条（需手动配对或标记新增）`);
        if (missing.length) parts.push(`名单未找到 ${missing.length} 个：${missing.slice(0, 6).join('、')}${missing.length > 6 ? '…' : ''}`);
        return parts.join('；');
    }

    invalidateIncoming() { this.incomingCache = null; }
    incoming() {
        if (!this.oldBook || !this.newBook) return new Map();
        return this.incomingCache ||= classifyIncoming(this.oldBook, this.newBook, this.pairs);
    }
    addable(id) { const state = this.incoming().get(id); return this.fusion && this.inScope(id) && (state === 'new' || (state === 'review' && this.forcedNew.has(id))); }
    selectedAdditions() { return [...this.incoming().keys()].filter(id => this.addable(id) && this.newSelection.get(id) !== false); }
    setSelection(action) {
        const wantUpdates = action === 'all' || action === 'updates', wantAdditions = action === 'all' || action === 'additions';
        for (const pair of this.pairs) pair.checked = wantUpdates && this.inScope(pair.newId) && this.changed(pair);
        for (const id of this.incoming().keys()) this.newSelection.set(id, wantAdditions && this.addable(id));
        const filtered = !!(this.find('[data-search="old"]').value || this.find('[data-search="new"]').value);
        const labels = { all: '已勾选所有可执行项；待处理和重复条目未选。', none: '已全部取消勾选。', updates: '已仅勾选需要更新的配对。', additions: '已仅勾选可新增的条目。' };
        const scoped = this.scopeNames.length ? '当前只处理定点名单内的人物。' : '';
        this.message(labels[action] + scoped + (filtered && action !== 'none' ? '本次勾选也包含搜索隐藏的条目。' : ''));
        this.render();
    }

    changed(pair) {
        if (!this.oldBook || !this.newBook) return false;
        const key = [pair.oldId, pair.newId, this.mode].join(':');
        if (!this.changeCache.has(key)) this.changeCache.set(key, pairChanged(this.oldBook, this.newBook, pair, this.mode));
        return this.changeCache.get(key);
    }
    selectedPairs() { return this.pairs.filter(pair => pair.checked && this.changed(pair)); }

    select(side, id) {
        if (this.busy) return;
        if (side === 'old') this.selectedOld = id; else this.selectedNew = id;
        this.previewOpen = true;
        const pair = this.pairs.find(p => p[side === 'old' ? 'oldId' : 'newId'] === id);
        if (pair) { this.selectedOld = pair.oldId; this.selectedNew = pair.newId; }
        this.render();
        if (pair) {
            const otherSide = side === 'old' ? 'new' : 'old';
            const other = this.find(`[data-list="${otherSide}"]`);
            const counterpart = side === 'old' ? pair.newId : pair.oldId;
            if (!other.querySelector(`[data-id="${counterpart}"]`)) {
                this.find(`[data-search="${otherSide}"]`).value = '';
                this.renderList(otherSide);
            }
            other.querySelector(`[data-id="${side === 'old' ? pair.newId : pair.oldId}"]`)?.scrollIntoView({ block: 'nearest' });
            this.message(`配对依据：${pair.reason}。${this.changed(pair) ? '有变化，正文已在下方显示。' : '当前替换范围内没有变化。'}`);
        }
    }

    manualPair() {
        try {
            if (!this.selectedOld || !this.selectedNew) return;
            if (!this.inScope(this.selectedNew)) { this.message('这个来源条目不在定点名单内；请先把它加入名单，或清空名单后整本处理。', true); return; }
            this.pairs = pairManually(this.pairs, this.selectedOld, this.selectedNew);
            this.forcedNew.delete(this.selectedNew); this.newSelection.delete(this.selectedNew); this.invalidateIncoming();
            this.message('已配对，正文已在下方并排显示。'); this.render();
        } catch (error) { this.message(error.message, true); }
    }

    unpair() {
        this.pairs = this.pairs.filter(p => p.oldId !== this.selectedOld && p.newId !== this.selectedNew);
        this.invalidateIncoming();
        this.message('已解除所选配对，点击两边条目可以重新配对。'); this.render();
    }

    render() {
        for (const side of ['old', 'new']) this.renderList(side);
        this.renderControls();
        this.renderPreview();
    }

    renderList(side) {
        const book = side === 'old' ? this.oldBook : this.newBook;
        const list = this.find(`[data-list="${side}"]`), scrollTop = list.scrollTop;
        const focused = list.contains(document.activeElement) ? document.activeElement : null;
        const focusedId = focused?.closest('[data-id]')?.dataset.id;
        const focusedTag = focused?.tagName;
        const search = this.find(`[data-search="${side}"]`).value.trim().toLocaleLowerCase();
        const fragment = document.createDocumentFragment();
        const pairsById = new Map(this.pairs.map((p, i) => [side === 'old' ? p.oldId : p.newId, { pair: p, number: i + 1 }]));
        const pinning = this.pinMatches && this.scopeNames.length > 0;
        const pinned = new Set();
        let rows = book ? listEntries(book) : [];
        if (pinning) {
            // 块内顺序按母本：母本里先出现的角色，置顶后也排在前面。
            const block = [];
            for (const { id: newId } of listEntries(this.newBook)) {
                if (!this.inScope(newId)) continue;
                if (side === 'new') block.push(newId);
                else {
                    const pair = this.pairs.find(item => String(item.newId) === String(newId));
                    if (pair) block.push(pair.oldId);
                }
            }
            for (const id of block) pinned.add(String(id));
            rows = orderWithPinned(rows, block);
        }
        let visible = 0;
        for (const { id, entry } of rows) {
            if (search && ![entry.comment || '', ...(entry.key || []), ...(entry.keysecondary || [])].join('\n').toLocaleLowerCase().includes(search)) continue;
            visible++;
            const linked = pairsById.get(id), pair = linked?.pair, changed = pair && this.changed(pair);
            const li = element('li', 'stwu-entry wi-card-entry'); li.dataset.id = id;
            li.classList.toggle('stwu-entry-selected', id === (side === 'old' ? this.selectedOld : this.selectedNew));
            {
                const label = element('label', 'stwu-entry-check');
                const outScope = side === 'new' && !this.inScope(id);
                const adding = side === 'new' && !pair && this.addable(id);
                const check = element('input'); check.type = 'checkbox'; check.checked = pair ? !!(changed && pair.checked) : adding && this.newSelection.get(id) !== false; check.disabled = this.busy || outScope || !(changed || adding);
                check.setAttribute('aria-label', `${pair ? '更新' : side === 'new' ? outScope ? '名单外，不参与' : '新增' : '保留'}：${title(entry)}`);
                label.append(check); li.append(label);
            }
            const button = element('button', 'menu_button stwu-entry-button'); button.type = 'button'; button.disabled = this.busy;
            button.setAttribute('aria-pressed', String(li.classList.contains('stwu-entry-selected')));
            button.append(element('span', 'stwu-entry-title', title(entry)));
            const state = side === 'new' ? this.incoming().get(id) : null;
            const unpairedLabel = side === 'old' ? '保留'
                : side === 'new' && !this.inScope(id) ? '名单外'
                : state === 'duplicate' ? '相同条目已跳过' : state === 'review' ? (this.forcedNew.has(id) ? '已标记新增' : '待处理') : state === 'new' ? '新条目' : '待载入原书';
            li.classList.toggle('stwu-entry-pinned', pinned.has(id));
            const status = element('span', 'stwu-entry-status', (pinned.has(id) ? '置顶 · ' : '') + (pair ? `配对 ${linked.number} · ${changed ? '有变化' : '无变化'}` : unpairedLabel));
            status.classList.toggle('stwu-paired', !!pair || (side === 'new' && this.addable(id))); button.append(status);
            li.append(button); fragment.append(li);
        }
        if (!visible) fragment.append(element('li', 'stwu-empty', book ? (Object.keys(book.entries).length ? '没有符合条件的条目' : '这本世界书还没有条目') : '尚未载入世界书'));
        list.replaceChildren(fragment); list.scrollTop = scrollTop;
        if (focusedId) list.querySelector(`[data-id="${focusedId}"] ${focusedTag === 'INPUT' ? 'input' : 'button'}`)?.focus({ preventScroll: true });
        this.find(`[data-side="${side}"] .stwu-count`).textContent = book ? `${visible}/${Object.keys(book.entries).length}` : '';
    }

    renderControls() {
        for (const node of this.dialog.querySelectorAll('select, input, button, textarea')) node.disabled = this.busy;
        this.find('[data-scope-report]').textContent = this.scopeText();
        this.find('[data-scope-state]').textContent = this.scopeNames.length ? `限定 ${this.scopeNames.length} 个名字` : '整本参与';
        const dirty = this.pairs.filter(p => this.changed(p)), selected = this.selectedPairs(), additions = this.selectedAdditions();
        this.find('[data-selection]').disabled = this.busy || (!dirty.length && ![...this.incoming().keys()].some(id => this.addable(id)) && !this.pairs.some(p => p.checked) && !this.newSelection.size);
        for (const action of ['updates', 'additions']) {
            const option = this.find(`[data-selection] [value="${action}"]`);
            option.hidden = !this.fusion; option.disabled = !this.fusion;
        }
        this.find('.stwu-selection').textContent = this.busy ? '处理中…' : this.fusion ? `更新 ${selected.length} · 新增 ${additions.length}` : `已选 ${selected.length} 条`;
        this.find('[data-action="apply"]').textContent = this.fusion ? '融合所选' : '替换所选';
        this.find('[data-action="apply"]').disabled = this.busy || !(selected.length + additions.length) || this.service.requiresReload;
        const paired = this.pairs.some(p => p.oldId === this.selectedOld || p.newId === this.selectedNew);
        const menu = this.find('[data-pair-action]');
        menu.disabled = this.busy || !this.oldBook || !this.newBook;
        menu.querySelector('[value="pair"]').disabled = !this.selectedOld || !this.selectedNew || paired;
        menu.querySelector('[value="unpair"]').disabled = !paired;
        menu.querySelector('[value="unpair-all"]').disabled = !this.pairs.length;
        const newOption = menu.querySelector('[value="new"]');
        newOption.disabled = !this.fusion || !this.selectedNew || this.incoming().get(this.selectedNew) !== 'review';
        newOption.textContent = this.forcedNew.has(this.selectedNew) ? '取消新增标记' : '标记为新条目';
        this.find('[data-action="download"]').disabled = this.busy || !this.backup;
        this.find('[data-action="restore"]').disabled = this.busy || !this.backup || this.service.requiresReload;
        this.find('.stwu-backup-info').textContent = this.backup ? `最近备份：${new Date(this.backup.date).toLocaleString()}。仅保存在当前浏览器，可下载留存。` : '这本世界书尚无备份，写入前会自动保存。';
        for (const side of ['old', 'new']) {
            const pairsById = new Map(this.pairs.map(p => [side === 'old' ? p.oldId : p.newId, p]));
            for (const li of this.dialog.querySelectorAll(`[data-list="${side}"] .stwu-entry`)) {
                const pair = pairsById.get(li.dataset.id);
                li.querySelector('input').disabled = this.busy || !(pair ? this.changed(pair) : side === 'new' && this.addable(li.dataset.id));
            }
        }
        this.find('.stwu-pairhint').textContent = this.selectedOld && this.selectedNew ? '已选两侧条目' : '点击两边条目可手动配对';
    }

    renderPreview() {
        const workspace = this.find('.stwu-workspace');
        workspace.dataset.previewOpen = String(this.previewOpen);
        const entries = {
            old: this.oldBook?.entries[this.selectedOld],
            new: this.newBook?.entries[this.selectedNew],
        };
        for (const side of ['old', 'new']) {
            const entry = entries[side];
            this.find(`[data-preview-title="${side}"]`).textContent = entry ? title(entry) : '未选择对应条目';
            this.find(`[data-preview-keys="${side}"]`).textContent = entry ? `关键词：${entry.key?.join('、') || '无'}` : '';
            this.find(`[data-preview-content="${side}"]`).textContent = entry?.content ?? '尚未选择对应条目。';
            const { content: _content, ...settings } = entry || {};
            this.find(`[data-preview-settings="${side}"]`).textContent = entry ? JSON.stringify(settings, null, 2) : '';
        }
    }

    async apply() {
        const additions = this.selectedAdditions();
        const result = buildUpdate(this.oldBook, this.newBook, this.pairs, this.mode, { merge: this.fusion, additions, approvedNew: [...this.forcedNew] });
        if (!(result.updated + result.added)) { this.message('没有需要写入的内容。'); return; }
        const scope = this.mode === 'content' ? '仅替换正文，保留原设置' : '完整更新条目，同步新版标题、关键词及设置';
        const addedNote = result.added ? '\n新增条目保留完整设置。' : '';
        const scopeNote = this.scopeNames.length ? `定点名单：${this.scopeNames.length} 个名字，名单外人物不参与。\n` : '';
        if (!globalThis.confirm(`将向“${this.oldName}”写入：更新 ${result.updated} 条，新增 ${result.added} 条。\n来源：${this.newName}\n${scopeNote}已有条目：${scope}${addedNote}\n写入前自动备份。确认继续？`)) return;
        this.message('正在备份、保存并核验世界书…');
        try {
            const saved = await this.service.update(this.oldName, this.oldBook, result.data);
            this.oldBook = saved.data;
            this.changeCache.clear();
            this.pairs = [...this.pairs.map(p => ({ ...p, checked: false })), ...result.addedPairs];
            for (const pair of result.addedPairs) { this.newSelection.delete(pair.newId); this.forcedNew.delete(pair.newId); }
            this.invalidateIncoming();
            await this.loadBackup();
            this.message(`已核验：更新 ${result.updated} 条，新增 ${result.added} 条，跳过 ${result.skipped} 条。${saved.note || ''}`);
        } finally { this.backup = await this.service.store.get(this.oldName).catch(() => this.backup); }
    }

    async restore() {
        if (!this.oldName || !this.backup) return;
        const current = await this.service.read(this.oldName);
        const changedLater = canonical(current) !== canonical(this.backup.after) && canonical(current) !== canonical(this.backup.before);
        const warning = changedLater ? '\n注意：备份后还有其他修改，恢复整本书会覆盖这些修改。建议先在酒馆导出当前世界书。' : '';
        if (!globalThis.confirm(`恢复“${this.oldName}”到 ${new Date(this.backup.date).toLocaleString()} 的操作前备份？${warning}`)) return;
        this.message('正在恢复备份并核验…');
        const saved = await this.service.restore(this.oldName, current, this.backup);
        this.oldBook = saved.data; this.repair(); await this.loadBackup();
        this.message('备份已恢复并核验。' + (saved.note || ''));
    }

    download() {
        if (!this.backup) return;
        const url = URL.createObjectURL(new Blob([JSON.stringify(this.backup.before, null, 2)], { type: 'application/json' }));
        this.urls.add(url);
        const link = element('a'); link.href = url; link.download = this.oldName.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_') + '_更新前备份.json';
        document.body.append(link); link.click(); link.remove();
        const timer = setTimeout(() => { URL.revokeObjectURL(url); this.urls.delete(url); this.timers.delete(timer); }, 10000);
        this.timers.add(timer);
    }

    destroy() {
        this.disposed = true;
        this.events.abort();
        this.dialog.close(); this.dialog.remove();
        for (const timer of this.timers) clearTimeout(timer);
        for (const url of this.urls) URL.revokeObjectURL(url);
        this.timers.clear(); this.urls.clear();
        this.service.close();
    }
}
