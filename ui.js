import { autoMatch, buildUpdate, canonical, classifyIncoming, listEntries, pairChanged, pairManually, parseBook, title } from './core.js';

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
        this.mode = 'content';
        this.fusion = false;
        this.busy = false;
        this.disposed = false;
        this.events = new AbortController();
        this.urls = new Set();
        this.timers = new Set();
        this.previousFocus = null;
        this.build();
        const syncViewport = () => {
            const viewport = globalThis.visualViewport;
            this.dialog.classList.toggle('stwu-keyboard', !!(viewport && viewport.height < globalThis.innerHeight - 100 && document.activeElement?.matches('[data-search]')));
            for (const dialog of [this.dialog, this.compareDialog]) if (dialog) {
                dialog.style.setProperty('--wu-vh', (viewport?.height || globalThis.innerHeight) + 'px');
                dialog.style.setProperty('--wu-top', (viewport?.offsetTop || 0) + 'px');
            }
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
        this.dialog = element('dialog', 'stwu stwu-dialog');
        if (typeof this.dialog.showModal !== 'function') throw new Error('当前浏览器不支持对照窗口，请更新浏览器或 Android WebView。');
        this.dialog.id = 'st-worldbook-updater-window';
        this.dialog.setAttribute('aria-labelledby', 'stwu-heading');
        // This template is static. Imported names and content are always assigned with textContent.
        this.dialog.innerHTML = `
          <header class="stwu-header">
            <div><h2 id="stwu-heading">世界书更新器</h2><p>右侧来源，更新或融合到左侧</p></div>
            <div class="stwu-header-actions"><button type="button" data-action="reload">重新载入</button><button type="button" data-action="close" aria-label="关闭世界书更新器">关闭</button></div>
          </header>
          <div class="stwu-notice" role="status" aria-live="polite">先选择原世界书，再选择新版或打开 JSON 文件。</div>
          <div class="stwu-panels">
            <section class="stwu-pane" data-side="old" aria-label="原世界书">
              <div class="stwu-pane-head"><h3>原世界书</h3><span class="stwu-count"></span></div>
              <select aria-label="选择原世界书" data-book="old"></select>
              <div class="stwu-source-line">原书独有条目会保留</div>
              <input type="search" data-search="old" aria-label="搜索原世界书条目" placeholder="搜索标题、关键词" autocomplete="off">
              <ol class="stwu-list" data-list="old" aria-label="原世界书条目"></ol>
            </section>
            <section class="stwu-pane" data-side="new" aria-label="新版世界书">
              <div class="stwu-pane-head"><h3>新版世界书</h3><span class="stwu-count"></span></div>
              <select aria-label="选择新版世界书" data-book="new"></select>
              <div class="stwu-source-line"><button type="button" data-action="file">打开 JSON 文件</button><input type="file" data-file accept=".json,application/json" hidden></div>
              <input type="search" data-search="new" aria-label="搜索新版世界书条目" placeholder="搜索标题、关键词" autocomplete="off">
              <ol class="stwu-list" data-list="new" aria-label="新版世界书条目"></ol>
            </section>
          </div>
          <div class="stwu-pairbar">
            <span class="stwu-pairhint">点击两边条目可手动配对</span>
            <div><select data-pair-action aria-label="配对操作"><option value="" disabled selected>配对操作</option><option value="pair">配对所选</option><option value="unpair">解除所选配对</option><option value="unpair-all">解除全部配对</option><option value="auto">重新自动匹配</option><option value="new">标记为新条目</option></select><button type="button" data-action="compare">查看正文</button></div>
          </div>
          <footer class="stwu-footer">
            <div class="stwu-options"><select data-selection aria-label="勾选操作"><option value="" disabled selected>勾选操作</option><option value="all">全部勾选</option><option value="none">全部取消</option><option value="updates">仅勾选更新</option><option value="additions">仅勾选新增</option></select><select data-mode aria-label="操作与替换范围"><option value="content">更新 · 仅正文</option><option value="full">更新 · 完整条目</option><option value="merge-content">融合 · 仅正文</option><option value="merge-full">融合 · 完整条目</option></select></div>
            <div class="stwu-bottom"><details class="stwu-backup"><summary>备份与恢复</summary><div><p class="stwu-backup-info">选择原世界书后查看备份。</p><button type="button" data-action="download">下载备份</button><button type="button" data-action="restore">恢复备份</button></div></details><span class="stwu-selection" aria-live="polite">已选 0 条</span><button type="button" class="stwu-primary" data-action="apply">替换所选</button></div>
          </footer>`;
        document.body.append(this.dialog);
        this.on(this.dialog, 'cancel', event => { event.preventDefault(); if (!this.busy) this.hide(); });
        this.on(this.dialog, 'click', event => {
            const action = event.target.closest('[data-action]')?.dataset.action;
            if (!action || this.busy) return;
            if (action === 'close') this.hide();
            if (action === 'reload') this.run(() => this.reload());
            if (action === 'file') this.find('[data-file]').click();
            if (action === 'compare') this.compare();
            if (action === 'apply') this.run(() => this.apply());
            if (action === 'restore') this.run(() => this.restore());
            if (action === 'download') this.download();
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
        this.pairs = this.oldBook && this.newBook ? autoMatch(this.oldBook, this.newBook) : [];
    }

    invalidateIncoming() { this.incomingCache = null; }
    incoming() {
        if (!this.oldBook || !this.newBook) return new Map();
        return this.incomingCache ||= classifyIncoming(this.oldBook, this.newBook, this.pairs);
    }
    addable(id) { const state = this.incoming().get(id); return this.fusion && (state === 'new' || (state === 'review' && this.forcedNew.has(id))); }
    selectedAdditions() { return [...this.incoming().keys()].filter(id => this.addable(id) && this.newSelection.get(id) !== false); }
    setSelection(action) {
        const wantUpdates = action === 'all' || action === 'updates', wantAdditions = action === 'all' || action === 'additions';
        for (const pair of this.pairs) pair.checked = wantUpdates && this.changed(pair);
        for (const id of this.incoming().keys()) this.newSelection.set(id, wantAdditions && this.addable(id));
        const filtered = !!(this.find('[data-search="old"]').value || this.find('[data-search="new"]').value);
        const labels = { all: '已勾选所有可执行项；待处理和重复条目未选。', none: '已全部取消勾选。', updates: '已仅勾选需要更新的配对。', additions: '已仅勾选可新增的条目。' };
        this.message(labels[action] + (filtered && action !== 'none' ? '本次勾选也包含搜索隐藏的条目。' : ''));
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
            this.message(`配对依据：${pair.reason}。${this.changed(pair) ? '有变化，可查看正文。' : '当前替换范围内没有变化。'}`);
        }
    }

    manualPair() {
        try {
            if (!this.selectedOld || !this.selectedNew) return;
            this.pairs = pairManually(this.pairs, this.selectedOld, this.selectedNew);
            this.forcedNew.delete(this.selectedNew); this.newSelection.delete(this.selectedNew); this.invalidateIncoming();
            this.message('已配对，可以查看正文或勾选替换。'); this.render();
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
        let visible = 0;
        for (const { id, entry } of book ? listEntries(book) : []) {
            if (search && ![entry.comment || '', ...(entry.key || []), ...(entry.keysecondary || [])].join('\n').toLocaleLowerCase().includes(search)) continue;
            visible++;
            const linked = pairsById.get(id), pair = linked?.pair, changed = pair && this.changed(pair);
            const li = element('li', 'stwu-entry'); li.dataset.id = id;
            li.classList.toggle('stwu-entry-selected', id === (side === 'old' ? this.selectedOld : this.selectedNew));
            {
                const label = element('label', 'stwu-entry-check');
                const adding = side === 'new' && !pair && this.addable(id);
                const check = element('input'); check.type = 'checkbox'; check.checked = pair ? !!(changed && pair.checked) : adding && this.newSelection.get(id) !== false; check.disabled = this.busy || !(changed || adding);
                check.setAttribute('aria-label', `${pair ? '更新' : side === 'new' ? '新增' : '保留'}：${title(entry)}`);
                label.append(check); li.append(label);
            }
            const button = element('button', 'stwu-entry-button'); button.type = 'button'; button.disabled = this.busy;
            button.setAttribute('aria-pressed', String(li.classList.contains('stwu-entry-selected')));
            button.append(element('span', 'stwu-entry-title', title(entry)));
            const state = side === 'new' ? this.incoming().get(id) : null;
            const unpairedLabel = side === 'old' ? '保留' : state === 'duplicate' ? '相同条目已跳过' : state === 'review' ? (this.forcedNew.has(id) ? '已标记新增' : '待处理') : state === 'new' ? '新条目' : '待载入原书';
            const status = element('span', 'stwu-entry-status', pair ? `配对 ${linked.number} · ${changed ? '有变化' : '无变化'}` : unpairedLabel);
            status.classList.toggle('stwu-paired', !!pair || (side === 'new' && this.addable(id))); button.append(status);
            li.append(button); fragment.append(li);
        }
        if (!visible) fragment.append(element('li', 'stwu-empty', book ? (Object.keys(book.entries).length ? '没有符合条件的条目' : '这本世界书还没有条目') : '尚未载入世界书'));
        list.replaceChildren(fragment); list.scrollTop = scrollTop;
        if (focusedId) list.querySelector(`[data-id="${focusedId}"] ${focusedTag === 'INPUT' ? 'input' : 'button'}`)?.focus({ preventScroll: true });
        this.find(`[data-side="${side}"] .stwu-count`).textContent = book ? `${visible}/${Object.keys(book.entries).length}` : '';
    }

    renderControls() {
        for (const node of this.dialog.querySelectorAll('select, input, button')) node.disabled = this.busy;
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
        this.find('[data-action="compare"]').disabled = this.busy || !(this.selectedOld || this.selectedNew);
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

    compare() {
        const oldEntry = this.oldBook?.entries[this.selectedOld], newEntry = this.newBook?.entries[this.selectedNew];
        if (!oldEntry && !newEntry) return;
        const dialog = element('dialog', 'stwu stwu-dialog stwu-compare');
        dialog.setAttribute('aria-label', '新旧条目正文对照');
        const header = element('header', 'stwu-header');
        header.append(element('h2', '', '正文对照'));
        const close = element('button', '', '返回列表'); close.type = 'button'; header.append(close);
        const content = element('div', 'stwu-compare-grid');
        for (const [label, entry] of [['原条目', oldEntry], ['新版条目', newEntry]]) {
            const pane = element('section', 'stwu-compare-pane');
            if (!entry) {
                pane.append(element('h3', '', label));
                pane.append(element('p', 'stwu-keys', label === '原条目' ? '未选中对应原条目；新条目可在融合模式下追加。' : '未选中新版条目，原条目会保留。'));
                content.append(pane); continue;
            }
            pane.append(element('h3', '', label + ' · ' + title(entry)));
            pane.append(element('p', 'stwu-keys', '关键词：' + (entry.key?.join('、') || '无')));
            const body = element('div', 'stwu-compare-scroll');
            body.append(element('pre', 'stwu-content', entry.content));
            const details = element('details', 'stwu-entry-settings'); details.append(element('summary', '', '查看条目设置'));
            const { content: _text, ...settings } = entry;
            details.append(element('pre', 'stwu-content', JSON.stringify(settings, null, 2))); body.append(details);
            pane.append(body); content.append(pane);
        }
        dialog.append(header, content); document.body.append(dialog); this.compareDialog = dialog;
        this.syncViewport();
        const dismiss = () => { dialog.close(); dialog.remove(); this.compareDialog = null; this.find('[data-action="compare"]').focus(); };
        close.addEventListener('click', dismiss);
        dialog.addEventListener('cancel', e => { e.preventDefault(); dismiss(); });
        dialog.showModal();
    }

    async apply() {
        const result = buildUpdate(this.oldBook, this.newBook, this.pairs, this.mode, { merge: this.fusion, additions: this.selectedAdditions(), approvedNew: [...this.forcedNew] });
        if (!(result.updated + result.added)) { this.message('没有需要写入的内容。'); return; }
        const scope = this.mode === 'content' ? '仅替换正文，保留原设置' : '完整更新条目，同步新版标题、关键词及设置';
        const addedNote = result.added ? '\n新增条目保留完整设置。' : '';
        if (!globalThis.confirm(`将向“${this.oldName}”写入：更新 ${result.updated} 条，新增 ${result.added} 条。\n来源：${this.newName}\n已有条目：${scope}${addedNote}\n写入前自动备份。确认继续？`)) return;
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
        this.compareDialog?.close(); this.compareDialog?.remove();
        this.dialog.close(); this.dialog.remove();
        for (const timer of this.timers) clearTimeout(timer);
        for (const url of this.urls) URL.revokeObjectURL(url);
        this.timers.clear(); this.urls.clear();
        this.service.close();
    }
}
