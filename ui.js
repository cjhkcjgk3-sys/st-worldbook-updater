const VERSION = '1.13.2';
const MOTHER_SIDE_KEY = 'st-worldbook-updater.mother-side';

import { SETTINGS_FIELDS, applySettingsPatch, autoMatch, buildConsolidation, buildDirectDeletion, buildMatchedDeletion, buildResolvedRosterUpdate, buildSettingsPatch, buildUpdate, cleanEntryName, classifyIncoming, clone, consolidationCandidates, listEntries, matchRosterEntries, orderWithPinned, pairChanged, pairManually, parseBook, parseNameList, pickSettings, pinBlock, scopeMatch, setBookEntrySettings, title, workKeysOf } from './core.js';

const retainedPair = pair => pair.reason === '手动配对' || pair.reason === '本次新增';
const entryIdentity = entry => entry && JSON.stringify([entry.comment?.trim() || '', [...(entry.key || [])].sort()]);

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
        this.oldBook = this.newBook = null;
        this.oldName = this.newName = '';
        this.sourceKind = 'book';
        this.pairs = [];
        this.pairBySource = new Map();
        this.pairByTarget = new Map();
        this.changeCache = new Map();
        this.incomingCache = null;
        // newSelection is the one checkbox state shared by Copy, Replace, and checked-item settings.
        this.newSelection = new Map();
        this.targetChecks = new Set();
        this.pairChecks = new Map();
        this.unpairedOld = new Set();
        this.unpairedNew = new Set();
        this.selectionCountsValid = false;
        this.selectedUpdateCount = 0;
        this.selectedEntryCount = 0;
        this.visibleCopyCount = 0;
        this.pageSize = { old: 25, new: 25 };
        this.page = { old: 1, new: 1 };
        this.filteredRows = { old: [], new: [] };
        this.visibleSourceSet = new Set();
        this.selectedOld = this.selectedNew = null;
        this.lastSelectedSide = null;
        this.previewOpen = false;
        this.splitMode = 'balanced';
        this.mode = 'content';
        this.scopeNames = [];
        this.scopeGroups = [];
        this.scopeWorks = [];
        this.scopeWorkKeys = workKeysOf(this.scopeWorks);
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
              <div><h2 id="stwu-heading">世界书更新器 <span class="stwu-version" data-version></span></h2><p>左右对照，点击条目后在下方查看正文</p></div>
              <div class="stwu-header-actions">
                <button type="button" class="menu_button stwu-icon-button" data-action="reload" aria-label="重新载入" title="重新载入"><i class="fa-solid fa-rotate-right" aria-hidden="true"></i></button>
                <button type="button" class="menu_button stwu-icon-button" data-action="toggle-size" aria-label="放大窗口" aria-expanded="false" title="放大窗口"><i class="fa-solid fa-expand" aria-hidden="true"></i></button>
                <button type="button" class="menu_button stwu-icon-button stwu-close-button" data-action="close" aria-label="关闭窗口" title="关闭窗口"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>
              </div>
            </header>
            <div class="stwu-notice" role="status" aria-live="polite">请选择母本和目标书。母本也可以从 JSON 文件打开。</div>
            <div class="stwu-tools" aria-label="配对、名单与条目设置">
              <details class="stwu-tool stwu-pairbar">
                <summary class="menu_button"><i class="fa-solid fa-link" aria-hidden="true"></i><span>配对操作</span></summary>
                <div class="stwu-tool-content stwu-pairbar-content">
                  <div class="stwu-pair-actions">
                    <button type="button" class="menu_button" data-pair-btn="pair" data-pair-toggle>配对所选</button>
                    <button type="button" class="menu_button" data-pair-btn="auto">重新匹配</button>
                    <button type="button" class="menu_button" data-pair-btn="auto-reset">重置配对</button>
                    <button type="button" class="menu_button" data-pair-btn="unpair-all">全部解除</button>
                    <button type="button" class="menu_button" data-pair-btn="consolidate">合并或删除目标条目</button>
                    <button type="button" class="menu_button" data-action="swap-sides">交换左右</button>
                  </div>
                  <span class="stwu-pairhint">点击两侧条目后，可在此配对或解除</span>
                </div>
              </details>
              <details class="stwu-tool stwu-scope">
                <summary class="menu_button"><i class="fa-solid fa-bullseye" aria-hidden="true"></i><span>定点名单</span><span class="stwu-scope-state" data-scope-state>未填写</span></summary>
                <div class="stwu-tool-content stwu-scope-content">
                  <label for="stwu-scope-input">填写目标书应收录的人名，再点底部「按名单更新」。</label>
                  <textarea class="text_pole" id="stwu-scope-input" data-scope rows="2" placeholder="每行一个名字；可先写一行「作品别名：原神=Genshin」用于去掉名字里的作品前缀。"></textarea>
                  <div class="stwu-scope-actions"><button type="button" class="menu_button" data-action="copy-names">复制母本条目名</button><label class="stwu-scope-pin"><input type="checkbox" data-scope-pin checked><span>匹配置顶（仅显示）</span></label></div>
                  <p class="stwu-scope-report" data-scope-report role="status"></p>
                  <details class="stwu-scope-spec"><summary>名单格式说明</summary><ol><li>每行一个角色名，写全名，不带编号、书名号、引号和说明文字。</li><li>别名或英文名写在括号里或跟在等号后。</li><li>同名或形态匹配不明确时，预览会列出待核对的人名。</li><li>原神和 Genshin 前缀可直接识别，其他作品可声明“作品别名：作品甲=别称”。</li></ol></details>
                </div>
              </details>
              <details class="stwu-tool stwu-settings">
                <summary class="menu_button"><i class="fa-solid fa-sliders" aria-hidden="true"></i><span>条目设置</span><span class="stwu-settings-state" data-settings-state>批量设置</span></summary>
                <div class="stwu-tool-content stwu-settings-content">
                  <div class="stwu-set-scope">
                    <label>操作
                      <select class="text_pole" data-set-operation>
                        <option value="new">修改母本</option>
                        <option value="old">修改目标书</option>
                        <option value="sync">从母本同步</option>
                      </select>
                    </label>
                    <label>作用范围
                      <select class="text_pole" data-set-scope>
                        <option value="current">当前查看的条目</option>
                        <option value="checked">当前勾选的条目</option>
                        <option value="search">当前搜索结果</option>
                        <option value="scope">定点名单命中</option>
                        <option value="all">整本</option>
                      </select>
                    </label>
                    <span class="stwu-set-count" data-set-count></span>
                  </div>
                  <div class="stwu-set-rows" data-set-rows></div>
                  <p class="stwu-set-hint" data-set-hint></p>
                  <div class="stwu-set-actions">
                    <button type="button" class="menu_button" data-action="apply-settings">应用到母本</button>
                  </div>
                </div>
              </details>
            </div>
            <div class="stwu-selection-bar">
              <select class="text_pole" data-selection-category aria-label="母本批量勾选类别">
                <option value="paired">已配对</option><option value="review">待核对</option><option value="new">可新增</option>
              </select>
              <button type="button" class="menu_button" data-action="toggle-selection" aria-pressed="false">批量勾选</button>
              <button type="button" class="menu_button" data-quick-pair data-pair-btn="pair" title="将当前两侧选中的条目配对，或解除已配对" disabled>快速配对</button>
              <span class="stwu-selection stwu-selection-compact" data-selection-summary="compact" aria-live="polite"></span>
            </div>
            <div class="stwu-workspace" data-preview-open="false" data-split="balanced">
              <section class="stwu-entry-window" aria-label="条目对照窗口">
              <div class="stwu-panels">
                <section class="stwu-pane" data-side="new" aria-label="母本">
                  <div class="stwu-pane-head"><h3>母本</h3><button type="button" class="menu_button stwu-review-jump" data-review-jump="new" title="跳到母本待核对条目" hidden></button><span class="stwu-count"></span></div>
                  <select class="text_pole" aria-label="选择母本" data-book="new"></select>
                  <div class="stwu-source-line"><button type="button" class="menu_button" data-action="file">打开 JSON 文件</button><input type="file" data-file accept=".json,application/json" hidden></div>
                  <input class="text_pole" type="search" data-search="new" aria-label="搜索母本条目" placeholder="搜索标题、关键词" title="单字按完整标题或关键词搜索" autocomplete="off">
                  <ol class="stwu-list" data-list="new" aria-label="母本条目"></ol>
                  <div class="stwu-pagebar"><label>每页 <select class="text_pole" data-page-size="new" aria-label="母本每页条数"><option>10</option><option selected>25</option><option>50</option><option>100</option><option>500</option><option>1000</option></select></label><button type="button" class="menu_button" data-page-step="new:-1" aria-label="母本上一页">‹</button><span data-page-status="new">0 / 0</span><button type="button" class="menu_button" data-page-step="new:1" aria-label="母本下一页">›</button></div>
                </section>
                <section class="stwu-pane" data-side="old" aria-label="目标书">
                  <div class="stwu-pane-head"><h3>目标书</h3><button type="button" class="menu_button stwu-review-jump" data-review-jump="old" title="跳到目标书待核对条目" hidden></button><span class="stwu-count"></span></div>
                  <select class="text_pole" aria-label="选择目标书" data-book="old"></select>
                  <div class="stwu-source-line"><button type="button" class="menu_button" data-action="toggle-target-selection" title="按目标书当前搜索结果批量勾选已配对条目，目标书独有条目会保留" aria-pressed="false">勾选已配对</button><button type="button" class="menu_button" data-action="target-operation" title="合并重复条目，或直接删除目标书勾选/选中的条目">合并/删除</button></div>
                  <input class="text_pole" type="search" data-search="old" aria-label="搜索目标书条目" placeholder="搜索标题、关键词" title="单字按完整标题或关键词搜索" autocomplete="off">
                  <ol class="stwu-list" data-list="old" aria-label="目标书条目"></ol>
                  <div class="stwu-pagebar"><label>每页 <select class="text_pole" data-page-size="old" aria-label="目标书每页条数"><option>10</option><option selected>25</option><option>50</option><option>100</option><option>500</option><option>1000</option></select></label><button type="button" class="menu_button" data-page-step="old:-1" aria-label="目标书上一页">‹</button><span data-page-status="old">0 / 0</span><button type="button" class="menu_button" data-page-step="old:1" aria-label="目标书下一页">›</button></div>
                </section>
              </div>
              <div class="stwu-resize-handle" data-resize-handle="entry" role="separator" aria-label="拖动调整条目窗口高度" title="上下拖动调整条目窗口高度"></div>
              </section>
              <div class="stwu-hard-divider" role="separator" aria-label="条目窗口与正文窗口分界"></div>
              <section class="stwu-body-window stwu-preview" aria-label="正文对照">
                <div class="stwu-preview-head">
                  <h3><i class="fa-solid fa-align-left" aria-hidden="true"></i> 正文对照</h3>
                  <div class="stwu-preview-actions">
                    <button type="button" class="menu_button stwu-mini-btn" data-action="cycle-split" title="切换或重置条目与正文窗口高度比例">高度：均分</button>
                    <button type="button" class="menu_button stwu-mini-btn" data-action="close-preview">收起</button>
                  </div>
                </div>
                <div class="stwu-preview-grid">
                  <article class="stwu-preview-pane" data-preview-side="new">
                    <h4>母本 · <span data-preview-title="new">未选择条目</span></h4><p class="stwu-preview-keys" data-preview-keys="new"></p>
                    <div class="stwu-preview-scroll"><pre class="stwu-content" data-preview-content="new">点击任一条目后，正文会显示在这里。</pre><details class="stwu-entry-settings"><summary>查看条目设置</summary><pre class="stwu-content" data-preview-settings="new"></pre></details></div>
                  </article>
                  <article class="stwu-preview-pane" data-preview-side="old">
                    <h4>目标书 · <span data-preview-title="old">未选择条目</span></h4><p class="stwu-preview-keys" data-preview-keys="old"></p>
                    <div class="stwu-preview-scroll"><pre class="stwu-content" data-preview-content="old">点击任一条目后，正文会显示在这里。</pre><details class="stwu-entry-settings"><summary>查看条目设置</summary><pre class="stwu-content" data-preview-settings="old"></pre></details></div>
                  </article>
                </div>
                <div class="stwu-resize-handle" data-resize-handle="body" role="separator" aria-label="拖动调整正文窗口高度" title="上下拖动调整正文窗口高度"></div>
              </section>
            </div>
            <footer class="stwu-footer">
              <label class="stwu-replace-scope">替换范围<select class="text_pole" data-mode aria-label="替换范围"><option value="content">仅正文</option><option value="full">完整条目</option></select></label>
              <div class="stwu-bottom"><span class="stwu-selection" aria-live="polite">已勾选 0 条 · 可替换 0 组</span><button type="button" class="menu_button" data-action="copy" title="只复制母本当前结果中已勾选的缺失条目">复制所选</button><button type="button" class="menu_button stwu-primary" data-action="replace">替换所选</button><button type="button" class="menu_button stwu-primary" data-action="preview-roster" hidden>按名单更新</button></div>
            </footer>
          </div></div>
          <dialog class="stwu-roster-dialog" aria-labelledby="stwu-roster-heading" data-roster-dialog>
            <h3 id="stwu-roster-heading">按名单更新</h3>
            <p data-roster-summary></p>
            <pre class="stwu-content stwu-roster-report" data-roster-report tabindex="0"></pre>
            <div class="stwu-roster-actions">
              <button type="button" class="menu_button" data-action="close-roster" autofocus>返回</button>
              <button type="button" class="menu_button stwu-primary" data-action="save-roster">确认更新</button>
            </div>
          </dialog>
          <dialog class="stwu-roster-dialog stwu-consolidate-dialog" aria-labelledby="stwu-consolidate-heading" data-consolidate-dialog>
            <h3 id="stwu-consolidate-heading">合并或删除目标条目</h3>
            <p data-consolidate-context></p>
            <div class="stwu-consolidate-controls">
              <label>操作<select class="text_pole" data-target-operation><option value="consolidate">合并为一条</option><option value="delete">删除匹配条目</option></select></label>
              <label data-consolidate-keep-label>保留<select class="text_pole" data-consolidate-keep></select></label>
            </div>
            <ul data-consolidate-candidates aria-label="目标书候选条目"></ul>
            <p data-consolidate-summary aria-live="polite"></p>
            <div class="stwu-roster-actions">
              <button type="button" class="menu_button" data-action="close-consolidation" autofocus>返回</button>
              <button type="button" class="menu_button stwu-primary" data-action="save-consolidation" disabled>确认合并</button>
            </div>
          </dialog>`;
        try {
            if (globalThis.localStorage.getItem(MOTHER_SIDE_KEY) === 'right') this.swapColumns();
        } catch {
            // The layout still works when browser storage is unavailable.
        }
        document.body.append(this.dialog);
        for (const tool of this.dialog.querySelectorAll('.stwu-tool')) this.on(tool, 'toggle', () => {
            if (tool.open) for (const other of this.dialog.querySelectorAll('.stwu-tool')) if (other !== tool) other.open = false;
        });
        this.on(this.dialog, 'cancel', event => {
            if (event.target !== this.dialog) return;
            event.preventDefault(); if (!this.busy) this.hide();
        });
        this.on(this.find('[data-roster-dialog]'), 'cancel', () => { this.rosterPreview = null; });
        this.on(this.find('[data-consolidate-dialog]'), 'cancel', () => { this.targetOperation = null; });
        this.on(this.find('[data-consolidate-dialog]'), 'change', event => {
            if (event.target.matches('[data-target-operation]')) {
                for (const input of this.dialog.querySelectorAll('[data-consolidate-remove]')) input.checked = false;
            }
            this.renderTargetOperation();
        });
        this.on(this.dialog, 'click', event => {
            if (!event.target.closest('.stwu-tool')) this.closeTools();
            const pairBtn = event.target.closest('[data-pair-btn]');
            if (pairBtn && !this.busy) { this.runPairAction(pairBtn.dataset.pairBtn); return; }
            const action = event.target.closest('[data-action]')?.dataset.action;
            if (!action || this.busy) return;
            if (action === 'close') this.hide();
            if (action === 'cycle-split') this.cycleSplitMode();
            if (action === 'close-preview') { this.previewOpen = false; this.clearManualHeights(); this.renderPreview(); }
            if (action === 'toggle-size') {
                this.setExpanded(!this.dialog.classList.contains('stwu-expanded'));
            }
            if (action === 'reload') { this.closeTools(); this.run(() => this.reload()); }
            if (action === 'swap-sides') {
                this.swapColumns();
                const motherOnLeft = this.find('.stwu-panels').firstElementChild.dataset.side === 'new';
                try {
                    globalThis.localStorage.setItem(MOTHER_SIDE_KEY, motherOnLeft ? 'left' : 'right');
                } catch {
                    // Keep the current layout even if the preference cannot be saved.
                }
                this.closeTools();
                this.find('.stwu-pairbar > summary').focus();
            }
            if (action === 'file') this.find('[data-file]').click();
            if (action === 'replace') this.run(() => this.apply());
            if (action === 'copy') this.run(() => this.copySelected());
            if (action === 'preview-roster') this.run(() => this.previewRoster());
            if (action === 'close-roster') {
                this.rosterPreview = null;
                this.find('[data-roster-dialog]').close();
            }
            if (action === 'save-roster') {
                this.find('[data-roster-dialog]').close();
                this.run(() => this.saveRoster());
            }
            if (action === 'close-consolidation') {
                this.targetOperation = null;
                this.find('[data-consolidate-dialog]').close();
            }
            if (action === 'save-consolidation') this.run(() => this.saveTargetOperation());
            if (action === 'toggle-selection') this.toggleFilteredSelection();
            if (action === 'toggle-target-selection') this.toggleFilteredSelection('old');
            if (action === 'target-operation') this.run(() => this.openTargetOperation());
            if (action === 'copy-names') this.run(() => this.copySourceNames());
            if (action === 'apply-settings') this.run(() => {
                const operation = this.find('[data-set-operation]').value;
                return operation === 'sync' ? this.syncSettingsToTarget() : this.applySettings(operation);
            });
        });
        for (const side of ['old', 'new']) {
            this.on(this.find(`[data-book="${side}"]`), 'change', e => this.run(() => this.loadSide(side, e.target.value)));
            this.on(this.find(`[data-review-jump="${side}"]`), 'click', () => this.jumpToReview(side));
            this.on(this.find(`[data-search="${side}"]`), 'input', () => {
                clearTimeout(this.searchTimers?.[side]);
                const count = Object.keys(this[side === 'old' ? 'oldBook' : 'newBook']?.entries ?? {}).length;
                const applySearch = () => { this.page[side] = 1; this.renderList(side); this.renderControls(); };
                if (count > 100) {
                    this.searchTimers ??= {};
                    this.searchTimers[side] = setTimeout(applySearch, 120);
                } else applySearch();
            });
            this.on(this.find(`[data-page-size="${side}"]`), 'change', event => { this.pageSize[side] = Number(event.target.value) || 25; this.page[side] = 1; this.find(`[data-list="${side}"]`).scrollTop = 0; this.renderList(side); this.renderControls(); });
            for (const btn of this.dialog.querySelectorAll(`[data-page-step^="${side}:"]`)) {
                this.on(btn, 'click', event => {
                    const step = Number(event.currentTarget.dataset.pageStep.split(':')[1]);
                    this.page[side] += step; this.find(`[data-list="${side}"]`).scrollTop = 0; this.renderList(side); this.renderControls();
                });
            }
            const list = this.find(`[data-list="${side}"]`);
            this.on(list, 'click', event => {
                const button = event.target.closest('.stwu-entry-button');
                if (button) this.select(side, button.closest('[data-id]').dataset.id);
            });
            this.on(list, 'change', event => {
                if (!event.target.matches('input[type="checkbox"]')) return;
                const id = event.target.closest('[data-id]').dataset.id;
                const pair = side === 'old' ? this.pairByTarget.get(id) : this.pairBySource.get(id);
                if (side === 'old' && !pair) {
                    if (event.target.checked) this.targetChecks.add(id);
                    else this.targetChecks.delete(id);
                    this.renderSettingsInfo();
                    this.renderPairControls();
                    return;
                }
                if (!this.selectionCountsValid) this.refreshSelectionCounts();
                const sourceId = pair?.newId ?? id;
                const wasSelected = this.isEntryChecked(sourceId);
                this.newSelection.set(sourceId, event.target.checked);
                if (pair) { pair.checked = event.target.checked; this.pairChecks.set(sourceId, event.target.checked); }
                const change = event.target.checked ? 1 : -1;
                if (wasSelected !== event.target.checked) {
                    this.selectedEntryCount += change;
                    if (this.visibleSourceSet.has(sourceId) && this.incoming().states.get(sourceId) === 'new') this.visibleCopyCount += change;
                    if (pair && this.inScope(pair.newId) && this.changed(pair)) this.selectedUpdateCount += change;
                }
                this.selectionCountsValid = true;
                if (this.pinMatches && pair && wasSelected !== event.target.checked) {
                    this.render();
                    return;
                }
                this.updateSelectionRows(sourceId, event.target.checked);
                this.renderSelectionSummary();
                if (this.find('.stwu-settings').open && this.find('[data-set-scope]').value === 'checked') this.renderSettingsInfo();
            });
        }
        this.on(this.find('[data-mode]'), 'change', event => {
            this.mode = event.target.value === 'full' ? 'full' : 'content';
            this.changeCache.clear(); this.selectionCountsValid = false;
            this.message(this.mode === 'content' ? '替换范围：只替换正文，保留目标条目的设置。' : '替换范围：同步标题、关键词、正文和条目设置。');
            this.render();
        });
        this.on(this.find('[data-scope]'), 'change', () => this.applyScope());
        this.on(this.find('[data-selection-category]'), 'change', () => this.renderBulkSelection());
        this.on(this.find('[data-scope-pin]'), 'change', event => { this.pinMatches = event.target.checked; this.render(); });
        this.on(this.find('[data-file]'), 'change', event => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file) this.run(async () => {
                if (file.size > 20 * 1024 * 1024) throw new Error('文件超过 20 MB，请先拆分世界书。');
                const book = parseBook(await file.text());
                if (this.hasManualDecisions() && !globalThis.confirm('更换母本会清除当前的人工配对和勾选。确认更换？')) return;
                this.newBook = book; this.newName = file.name; this.sourceKind = 'file';
                this.repair(true); this.selectors(); this.message(`已载入 ${file.name}，自动配对 ${this.pairs.length} 组。`);
            });
        });
        this.buildSettingsRows();
        this.bindResizeHandles();
        void this.loadVersion();
        this.selectors(); this.render();
    }

    setExpanded(expanded) {
        this.dialog.classList.toggle('stwu-expanded', expanded);
        const button = this.find('[data-action="toggle-size"]');
        if (button) {
            button.setAttribute('aria-expanded', String(expanded));
            button.setAttribute('aria-label', expanded ? '还原窗口' : '放大窗口');
            button.title = expanded ? '还原窗口' : '放大窗口';
            button.querySelector('i').className = `fa-solid ${expanded ? 'fa-compress' : 'fa-expand'}`;
        }
        this.syncViewport();
    }

    async open() {
        if (this.dialog.open || this.disposed) return;
        this.previousFocus = document.activeElement;
        this.dialog.showModal();
        if (!this.books.length) await this.run(() => this.reload());
    }

    hide() {
        this.closeTools();
        this.dialog.close();
        this.previousFocus?.focus?.();
    }

    closeTools() {
        if (!this.dialog) return;
        for (const tool of this.dialog.querySelectorAll('.stwu-tool')) tool.open = false;
    }

    swapColumns() {
        for (const selector of ['.stwu-panels', '.stwu-preview-grid']) {
            const grid = this.find(selector);
            grid.append(grid.firstElementChild);
        }
    }

    clearManualHeights() {
        for (const cls of ['.stwu-entry-window', '.stwu-body-window']) {
            const panel = this.find(cls);
            panel?.style?.removeProperty('height');
            panel?.style?.removeProperty('flex');
        }
    }

    setSplitMode(mode) {
        if (!['list', 'balanced', 'body'].includes(mode)) return;
        this.splitMode = mode;
        this.clearManualHeights();
        this.renderPreview();
    }

    bindResizeHandles() {
        for (const area of ['entry', 'body']) {
            const handle = this.find(`[data-resize-handle="${area}"]`);
            const panel = this.find(area === 'entry' ? '.stwu-entry-window' : '.stwu-body-window');
            if (!handle || !panel) continue;
            let drag = null;
            this.on(handle, 'pointerdown', event => {
                if (event.button && event.button !== 0) return;
                event.preventDefault();
                const other = this.find(area === 'entry' ? '.stwu-body-window' : '.stwu-entry-window');
                if (other && this.previewOpen && !other.style.height) {
                    other.style.flex = '0 0 auto';
                    other.style.height = `${Math.round(other.getBoundingClientRect().height)}px`;
                }
                drag = { id: event.pointerId, startY: event.clientY, startH: panel.getBoundingClientRect().height };
                handle.setPointerCapture?.(event.pointerId);
            });
            this.on(handle, 'pointermove', event => {
                if (!drag || event.pointerId !== drag.id) return;
                const minH = area === 'entry' ? 215 : 140;
                const next = Math.round(Math.max(minH, Math.min(2400, drag.startH + (event.clientY - drag.startY))));
                panel.style.flex = '0 0 auto';
                panel.style.height = `${next}px`;
            });
            const end = event => {
                if (!drag || event.pointerId !== drag.id) return;
                if (handle.hasPointerCapture?.(event.pointerId)) handle.releasePointerCapture(event.pointerId);
                drag = null;
            };
            this.on(handle, 'pointerup', end);
            this.on(handle, 'pointercancel', end);
        }
    }

    cycleSplitMode() {
        const order = ['balanced', 'body', 'list'];
        const next = order[(order.indexOf(this.splitMode || 'balanced') + 1) % order.length];
        this.setSplitMode(next);
    }

    runPairAction(action) {
        if (action === 'pair') this.manualPair();
        else if (action === 'unpair') this.unpair();
        else if (action === 'unpair-all') this.unpairAll();
        else if (action === 'consolidate') this.run(() => this.openTargetOperation());
        else if (action === 'auto') { this.repair(); this.message(`已重新自动匹配，共 ${this.pairs.length} 组；保留人工配对、解除和勾选。`); this.render(); }
        else if (action === 'auto-reset' && globalThis.confirm('将清除人工配对、解除记录及当前勾选，重新自动匹配。确认？')) {
            this.resetPairDecisions(); this.repair(); this.message(`已重置配对决定，自动匹配 ${this.pairs.length} 组。`); this.render();
        }
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
            select.replaceChildren(new Option(side === 'old' ? '选择目标书' : '选择母本', ''));
            for (const book of this.books) select.add(new Option(book.label, 'book:' + book.name));
            if (side === 'new' && this.sourceKind === 'file' && this.newBook) select.add(new Option('文件：' + this.newName, 'file:'));
            select.value = side === 'old' ? (this.oldName ? 'book:' + this.oldName : '') : (this.newBook ? (this.sourceKind === 'file' ? 'file:' : 'book:' + this.newName) : '');
        }
    }

    async reload() {
        this.message('正在读取世界书列表…');
        const books = await this.service.list();
        const names = new Set(books.map(book => book.name));
        const oldName = names.has(this.oldName) ? this.oldName : '';
        const fromFile = this.sourceKind === 'file';
        const newName = fromFile || names.has(this.newName) ? this.newName : '';
        const target = oldName ? this.service.read(oldName) : null;
        const source = fromFile ? this.newBook : !newName ? null : newName === oldName ? target : this.service.read(newName);
        const [oldBook, newBook] = await Promise.all([target, source]);
        const discarded = this.reconcileReload(oldBook, newBook);
        Object.assign(this, { books, oldBook, newBook, oldName, newName });
        this.repair(); this.selectors();
        const status = this.oldBook && this.newBook
            ? `已重新载入，自动配对 ${this.pairs.length} 组。`
            : '请选择母本和目标书。母本也可以从 JSON 文件打开。';
        const note = discarded ? `有 ${discarded} 组旧配对因标题或主关键词变化已重新核对，相关勾选已清除。` : '';
        this.message(status + note);
    }

    reconcileReload(oldBook, newBook) {
        const unchanged = (before, after, id) => {
            const original = before?.entries[id], current = after?.entries[id];
            return original && current && entryIdentity(original) === entryIdentity(current);
        };
        const oldUnchanged = id => unchanged(this.oldBook, oldBook, id);
        const newUnchanged = id => unchanged(this.newBook, newBook, id);
        const retained = this.pairs.filter(pair => {
            if (oldUnchanged(pair.oldId) && newUnchanged(pair.newId)) return true;
            this.pairChecks.delete(pair.newId);
            this.newSelection.delete(pair.newId);
            return false;
        });
        const discarded = this.pairs.length - retained.length;
        this.pairs = retained;
        for (const checks of [this.targetChecks, this.unpairedOld]) {
            for (const id of checks) if (!oldUnchanged(id)) checks.delete(id);
        }
        for (const checks of [this.newSelection, this.pairChecks, this.unpairedNew]) {
            for (const id of checks.keys()) if (!newUnchanged(id)) checks.delete(id);
        }
        if (this.selectedOld != null && !oldUnchanged(this.selectedOld)) {
            this.selectedOld = null;
            this.lastSelectedSide = null;
        }
        if (this.selectedNew != null && !newUnchanged(this.selectedNew)) {
            this.selectedNew = null;
            this.lastSelectedSide = null;
        }
        return discarded;
    }

    async loadSide(side, value) {
        if (value === 'file:') return;
        const name = value.startsWith('book:') ? value.slice(5) : '';
        const role = side === 'old' ? '目标书' : '母本';
        const previous = side === 'old' ? this.oldName : (this.sourceKind === 'book' ? this.newName : null);
        if (name === previous) return;
        const clearsChecks = side === 'old' && this.targetChecks.size;
        if ((this.hasManualDecisions() || clearsChecks) && !globalThis.confirm(`更换${role}会清除当前的人工配对和${side === 'new' ? '母本勾选' : '勾选'}。确认更换？`)) { this.selectors(); return; }
        if (side === 'old') { this.oldBook = null; this.oldName = name; }
        else { this.newBook = null; this.newName = name; this.sourceKind = 'book'; }
        this.repair(true); this.render();
        if (!name) { this.message(`请选择${role}。`); return; }
        this.message(`正在读取${role}…`);
        const book = await this.service.read(name);
        if (side === 'old') this.oldBook = book;
        else this.newBook = book;
        this.repair();
        this.message(`已读取${role}「${name}」。${this.oldBook && this.newBook ? `自动配对 ${this.pairs.length} 组。` : ''}`);
    }

    hasManualDecisions() {
        return !!(this.pairChecks.size || this.newSelection.size || this.unpairedOld.size || this.unpairedNew.size || this.pairs.some(pair => pair.reason === '手动配对'));
    }

    resetPairDecisions() {
        this.pairs = []; this.pairChecks.clear(); this.newSelection.clear();
        this.unpairedOld.clear(); this.unpairedNew.clear();
    }

    repair(reset = false, resetPage = true) {
        if (reset) {
            this.resetPairDecisions();
            this.selectedOld = this.selectedNew = null;
            this.lastSelectedSide = null;
        }
        this.changeCache.clear();
        this.invalidateIncoming();
        this.selectionCountsValid = false;
        for (const id of this.targetChecks) if (!this.oldBook?.entries[id]) this.targetChecks.delete(id);
        if (resetPage) this.page.old = this.page.new = 1;
        if (!this.oldBook || !this.newBook) { this.pairs = []; this.syncPairIndex(); return; }
        const oldEntries = this.oldBook.entries, newEntries = this.newBook.entries;
        const previous = new Map(this.pairs.map(pair => [pair.newId, pair]));
        const manual = this.pairs.filter(pair => retainedPair(pair) && oldEntries[pair.oldId] && newEntries[pair.newId]);
        const usedOld = new Set(manual.map(pair => pair.oldId)), usedNew = new Set(manual.map(pair => pair.newId));
        const roster = this.resolvedRoster(manual);
        const outsideRoster = autoMatch(this.oldBook, this.newBook, this.scopeWorkKeys)
            .filter(pair => !roster?.states.has(pair.newId) && !roster?.reviewRows.old.has(pair.oldId));
        const proposals = [...(roster?.pairs ?? []), ...outsideRoster];
        const pairs = [...manual];
        for (const proposal of proposals) {
            const pair = { ...proposal };
            if (usedOld.has(pair.oldId) || usedNew.has(pair.newId) || this.unpairedOld.has(pair.oldId) || this.unpairedNew.has(pair.newId)) continue;
            const prior = previous.get(pair.newId);
            pair.checked = this.pairChecks.get(pair.newId) ?? this.newSelection.get(pair.newId)
                ?? (prior?.oldId === pair.oldId ? prior.checked : undefined) ?? (this.inScope(pair.newId) && this.changed(pair));
            usedOld.add(pair.oldId); usedNew.add(pair.newId); pairs.push(pair);
        }
        this.pairs = pairs;
        this.syncPairIndex();
        if (!oldEntries[this.selectedOld]) this.selectedOld = null;
        if (!newEntries[this.selectedNew]) this.selectedNew = null;
    }

    applyScope() {
        const { names, works, groups } = parseNameList(this.find('[data-scope]').value, { includeGroups: true });
        const sameGroups = JSON.stringify(groups) === JSON.stringify(this.scopeGroups);
        const sameWorks = works.length === this.scopeWorks.length && works.every((work, index) => work === this.scopeWorks[index]);
        if (sameGroups && sameWorks) return;
        this.scopeNames = names;
        this.scopeGroups = groups;
        this.scopeWorks = works;
        this.scopeWorkKeys = workKeysOf(works);
        this.repair();
        this.message(this.scopeText() || '定点名单为空。可手动勾选条目，再复制或替换。');
        this.render();
        for (const side of ['old', 'new']) this.find(`[data-list="${side}"]`).scrollTop = 0;
    }

    async copySourceNames() {
        if (!this.newBook) { this.message('先选择母本，再复制条目名。', true); return; }
        const names = [];
        for (const { entry } of listEntries(this.newBook)) {
            const name = cleanEntryName(entry.comment || '') || title(entry);
            if (name && !names.includes(name)) names.push(name);
        }
        if (!names.length) { this.message('母本没有可用的条目名。', true); return; }
        const text = names.map(name => /[,，、=＝;；|｜\n\r"]/u.test(name) || /^(?:作品别名|作品|work)\s*[:：]/i.test(name) ? JSON.stringify(name) : name).join('\n');
        try {
            if (!navigator.clipboard?.writeText) throw new Error('clipboard');
            await navigator.clipboard.writeText(text);
            this.message(`已复制 ${names.length} 个母本条目名；粘回名单后请核对命中和配对，避免同名误匹配。`);
        } catch {
            this.message(`当前浏览器不允许自动复制（共 ${names.length} 个条目名）。可改用电脑浏览器，或按母本列表手动核对。`, true);
        }
    }

    async loadVersion() {
        const node = this.find('[data-version]');
        if (!node) return;
        try {
            const response = await fetch(new URL('manifest.json', import.meta.url), { cache: 'no-store' });
            if (!response.ok) throw new Error('manifest');
            const manifest = await response.json();
            if (manifest?.version) node.textContent = 'v' + manifest.version;
        } catch { node.textContent = 'v' + VERSION; }
    }

    buildSettingsRows() {
        const host = this.find('[data-set-rows]');
        if (!host) return;
        for (const field of SETTINGS_FIELDS) {
            const row = element('div', 'stwu-set-row');
            row.dataset.field = field.key;
            row.append(element('span', 'stwu-set-label', field.label));
            const mode = document.createElement('select');
            mode.className = 'text_pole';
            mode.dataset.setMode = '';
            mode.append(new Option('不改', ''), new Option('设为', 'set'));
            if (field.kind === 'number') mode.append(new Option('调整', 'add'));
            row.append(mode);
            let control;
            if (field.kind === 'enum') {
                control = document.createElement('select');
                control.className = 'text_pole';
                for (const option of field.options) control.append(new Option(option.label, String(option.value)));
            } else if (field.kind === 'boolean') {
                control = document.createElement('select');
                control.className = 'text_pole';
                control.append(new Option('开', 'true'), new Option('关', 'false'));
            } else {
                control = document.createElement('input');
                control.type = 'number';
                control.className = 'text_pole';
                control.min = String(field.min ?? 0);
                control.max = String(field.max ?? 9999);
                control.value = String(field.min ?? 0);
            }
            control.dataset.setValue = '';
            control.disabled = true;
            this.on(mode, 'change', () => this.renderSettingsInfo());
            row.append(control);
            host.append(row);
        }
        for (const selector of ['[data-set-operation]', '[data-set-scope]']) {
            this.on(this.find(selector), 'change', () => this.renderSettingsInfo());
        }
    }

    settingsFields() {
        return [...this.dialog.querySelectorAll('.stwu-set-row')].map(row => ({
            key: row.dataset.field,
            mode: row.querySelector('[data-set-mode]').value,
            value: row.querySelector('[data-set-value]').value,
        }));
    }

    collectSettingsPatch() { return buildSettingsPatch(this.settingsFields()); }

    settingsIds(side = 'new') {
        const scope = this.find('[data-set-scope]').value;
        const target = side === 'old';
        const entries = (target ? this.oldBook : this.newBook)?.entries ?? {};
        if (scope === 'current') {
            const id = target ? this.selectedOld : this.selectedNew;
            return entries[id] ? [id] : [];
        }
        if (scope === 'search') {
            if (!this.find(`[data-search="${side}"]`).value.trim()) return [];
            return this.filteredRows[side].map(({ id }) => id).filter(id => entries[id]);
        }
        const all = Object.keys(entries);
        if (scope === 'all') return all;
        if (scope === 'scope') {
            if (!this.newBook || !this.scopeGroups.length) return [];
            const roster = this.resolvedRoster();
            if (target) return roster?.pairs.map(pair => pair.oldId) ?? [];
            const { states } = roster ?? matchRosterEntries({ entries: {} }, this.newBook, this.scopeGroups, { workKeys: this.scopeWorkKeys });
            return all.filter(id => states.has(id) && states.get(id) !== 'review');
        }
        return scope === 'checked' ? all.filter(id => target ? this.isTargetChecked(id) : this.isEntryChecked(id)) : [];
    }

    settingsSyncPairs(ids) {
        const sourceIds = new Set(ids);
        const roster = this.find('[data-set-scope]').value === 'scope';
        const pairs = roster ? this.resolvedRoster()?.pairs ?? [] : this.pairs;
        return pairs.filter(pair => sourceIds.has(pair.newId));
    }

    settingsSyncPlan(ids) {
        const keys = this.settingsFields().filter(field => field.mode).map(field => field.key);
        const pairs = this.settingsSyncPairs(ids);
        const updates = keys.length ? pairs.map(pair => ({ pair, values: pickSettings(this.newBook.entries[pair.newId], keys) }))
            .filter(({ values }) => Object.keys(values).length) : [];
        return { keys, pairs, updates };
    }

    renderSettingsInfo() {
        const count = this.find('[data-set-count]');
        if (!count) return;
        const operation = this.find('[data-set-operation]').value;
        const sync = operation === 'sync', target = operation === 'old';
        const ids = this.settingsIds(target ? 'old' : 'new');
        const plan = sync ? this.settingsSyncPlan(ids) : null;
        const affected = plan ? (plan.keys.length ? plan.updates.length : plan.pairs.length) : ids.length;
        count.textContent = `${target ? '目标书' : '母本'} ${ids.length} 条${sync ? ` · 可同步 ${affected} 条` : ''}`;
        const file = operation === 'new' && this.sourceKind === 'file';
        const emptySearch = this.find('[data-set-scope]').value === 'search'
            && !this.find(`[data-search="${target ? 'old' : 'new'}"]`).value.trim();
        const missingValues = plan?.keys.length && plan.pairs.length && !affected;
        this.find('[data-set-hint]').textContent = emptySearch
            ? `先在${target ? '目标书' : '母本'}输入搜索词。`
            : missingValues ? '母本里没有对应的设置值可同步。'
            : sync
            ? '选中要同步的字段，按母本现有值写入已配对的目标条目。'
            : file ? '母本来自 JSON 文件。选择酒馆内的母本即可保存设置。'
                : '只保存设为或调整的字段，确认后写入。';
        const apply = this.find('[data-action="apply-settings"]');
        apply.textContent = sync ? '同步设置到目标书' : target ? '应用到目标书' : '应用到母本';
        apply.disabled = this.busy || !!this.service.requiresReload || file || !affected;
        for (const row of this.dialog.querySelectorAll('.stwu-set-row')) {
            row.querySelector('[data-set-value]').disabled = this.busy || sync || !row.querySelector('[data-set-mode]').value;
        }
    }

    async applySettings(side) {
        const target = side === 'old';
        const [name, book, role] = target ? [this.oldName, this.oldBook, '目标书'] : [this.newName, this.newBook, '母本'];
        if (!book) { this.message(`先选择${role}。`, true); return; }
        if (!target && this.sourceKind === 'file') { this.message('当前母本是 JSON 文件。选择酒馆内的母本即可保存设置。', true); return; }
        const patch = this.collectSettingsPatch();
        const keys = Object.keys(patch);
        if (!keys.length) { this.message('先选一个要修改的设置字段。', true); return; }
        const ids = this.settingsIds(side);
        if (!ids.length) { this.message('当前作用范围没有条目。', true); return; }
        const summary = keys.map(key => SETTINGS_FIELDS.find(field => field.key === key)?.label ?? key).join('、');
        const scope = this.find('[data-set-scope]').selectedOptions[0].textContent;
        const visible = new Set(this.filteredRows[side].map(({ id }) => id));
        const hidden = ids.filter(id => !visible.has(id)).length;
        if (!globalThis.confirm(`将修改${role}「${name}」的 ${ids.length} 条设置（${summary}）。\n范围为${scope}。${hidden ? `其中 ${hidden} 条被搜索隐藏，仍参与。` : ''}\n确认保存？`)) return;
        this.message(`正在保存${role}设置…`);
        const next = clone(book);
        for (const id of ids) {
            const changed = applySettingsPatch(next.entries[id], patch);
            setBookEntrySettings(next, id, pickSettings(changed, keys));
        }
        const byRoster = this.find('[data-set-scope]').value === 'scope';
        const dependency = byRoster && !target && this.oldBook ? { name: this.oldName, data: this.oldBook } : undefined;
        const saved = byRoster && target
            ? await this.saveTargetFromMother(next)
            : await this.service.updateDirect(name, book, next, dependency);
        if (target || this.sameNamedBook()) this.oldBook = saved.data;
        if (!target || this.sameNamedBook()) this.newBook = saved.data;
        this.changeCache.clear(); this.invalidateIncoming();
        this.selectionCountsValid = false;
        this.message(saved.changed === false ? saved.note : `${role}已保存：${ids.length} 条设置已更新。${saved.note || ''}`);
    }

    async syncSettingsToTarget() {
        if (!this.oldBook || !this.newBook) { this.message('先选择母本和目标书。', true); return; }
        const { keys, pairs, updates } = this.settingsSyncPlan(this.settingsIds());
        if (!keys.length) { this.message('先选一个要同步的设置字段。', true); return; }
        if (!pairs.length) { this.message('当前范围没有可同步的配对条目。', true); return; }
        if (!updates.length) { this.message('母本里没有对应的设置值可同步。', true); return; }
        const summary = keys.map(key => SETTINGS_FIELDS.find(field => field.key === key)?.label ?? key).join('、');
        const scope = this.find('[data-set-scope]').selectedOptions[0].textContent;
        const visible = new Set(this.visibleSourceIds());
        const hidden = updates.filter(({ pair }) => !visible.has(pair.newId)).length;
        const missing = pairs.length - updates.length;
        if (!globalThis.confirm(`将把母本的 ${summary} 同步到目标书「${this.oldName}」的 ${updates.length} 条配对条目。\n范围为${scope}。${hidden ? `其中 ${hidden} 条被搜索隐藏，仍参与。` : ''}${missing ? `另有 ${missing} 条缺少所选字段，已跳过。` : ''}\n确认保存？`)) return;
        this.message('正在同步设置…');
        const next = clone(this.oldBook);
        for (const { pair, values } of updates) setBookEntrySettings(next, pair.oldId, values);
        const saved = await this.saveTargetFromMother(next);
        this.oldBook = saved.data;
        if (this.sourceKind === 'book' && this.oldName === this.newName) this.newBook = saved.data;
        this.invalidateIncoming();
        this.changeCache.clear();
        this.selectionCountsValid = false;
        this.message(saved.changed === false ? saved.note : `已同步 ${updates.length} 条设置到目标书。${saved.note || ''}`);
    }

    inScope(id) {
        if (!this.scopeNames.length) return true;
        const roster = this.resolvedRoster();
        if (roster) return roster.states.has(id);
        return !!this.newBook?.entries?.[id] && !!scopeMatch(this.newBook.entries[id], this.scopeNames, this.scopeWorkKeys ?? workKeysOf(this.scopeWorks));
    }

    scopeText() {
        if (!this.scopeNames.length || !this.newBook) return '';
        const hit = this.resolvedRoster()?.states.size
            ?? Object.values(this.newBook.entries).filter(entry => scopeMatch(entry, this.scopeNames, this.scopeWorkKeys)).length;
        return `母本命中 ${hit} 条。打开「按名单更新」查看处理结果。`;
    }

    resolvedRoster(manualPairs) {
        if (!this.oldBook || !this.newBook || !this.scopeGroups?.length) return null;
        return this.rosterMatch ??= matchRosterEntries(this.oldBook, this.newBook, this.scopeGroups, this.rosterPairingOptions(manualPairs));
    }

    invalidateIncoming() { this.incomingCache = null; this.rosterMatch = null; }

    incoming() {
        const roster = this.resolvedRoster();
        if (roster) return roster;
        const reviewRows = { new: new Set(), old: new Set() };
        const reviewReasons = new Map();
        if (!this.oldBook || !this.newBook) return { states: new Map(), reviewRows, reviewReasons };
        if (this.incomingCache) return this.incomingCache;
        const states = classifyIncoming(this.oldBook, this.newBook, this.pairs, reviewRows.old, reviewReasons, this.scopeWorkKeys);
        for (const [id, state] of states) if (state === 'review') reviewRows.new.add(id);
        return this.incomingCache = { states, reviewRows, reviewReasons };
    }

    jumpToReview(side) {
        const reviewIds = this.incoming().reviewRows[side];
        const index = this.filteredRows[side].findIndex(({ id }) => reviewIds.has(id));
        if (index === -1) return;
        const { id } = this.filteredRows[side][index];
        this.page[side] = Math.floor(index / this.pageSize[side]) + 1;
        this.renderList(side);
        this.renderControls();
        const list = this.find(`[data-list="${side}"]`);
        const row = this.rowElements[side].get(id);
        list.scrollTop += row.getBoundingClientRect().top - list.getBoundingClientRect().top;
        row.querySelector('.stwu-entry-button').focus({ preventScroll: true });
    }
    syncPairIndex() {
        this.pairBySource = new Map(this.pairs.map(pair => [pair.newId, pair]));
        this.pairByTarget = new Map(this.pairs.map(pair => [pair.oldId, pair]));
        for (const id of this.targetChecks) if (this.pairByTarget.has(id)) this.targetChecks.delete(id);
    }
    pairForSource(id) { return this.pairBySource.get(id); }
    isEntryChecked(id) {
        if (this.newSelection.has(id)) return this.newSelection.get(id) === true;
        return !!this.pairForSource(id)?.checked;
    }
    isTargetChecked(id) {
        const pair = this.pairByTarget.get(id);
        return pair ? this.isEntryChecked(pair.newId) : this.targetChecks.has(id);
    }
    selectedSourceIds() { return Object.keys(this.newBook?.entries ?? {}).filter(id => this.isEntryChecked(id)); }

    visibleCopyIds() {
        const { states } = this.incoming();
        return this.visibleSourceIds().filter(id => states.get(id) === 'new' && this.isEntryChecked(id));
    }

    visibleSourceIds() {
        return this.filteredRows.new.map(({ id }) => id);
    }

    updateSelectionRows(sourceId, checked) {
        const pair = this.pairForSource(sourceId);
        for (const [side, id] of [['new', sourceId], ['old', pair?.oldId]]) {
            if (id == null) continue;
            const row = this.rowElements?.[side]?.get(String(id));
            const input = row?.querySelector('input[type="checkbox"]');
            if (input) input.checked = checked;
        }
    }

    bulkSelectionIds(category, side) {
        if (side === 'old') {
            return this.filteredRows.old.map(({ id }) => this.pairByTarget.get(id))
                .filter(pair => pair && this.inScope(pair.newId)).map(pair => pair.newId);
        }
        const { states, reviewRows } = this.incoming();
        return this.filteredRows.new.filter(({ id }) => {
            if (!this.inScope(id)) return false;
            if (reviewRows.new.has(id)) return category === 'review';
            if (this.pairForSource(id)) return category === 'paired';
            return category === 'new' && states.get(id) === 'new';
        }).map(({ id }) => id);
    }

    toggleFilteredSelection(side = 'new') {
        const category = side === 'new' ? this.find('[data-selection-category]') : null;
        const ids = this.bulkSelectionIds(category?.value, side);
        if (!ids.length) return;
        const select = !ids.every(id => this.isEntryChecked(id));
        for (const id of ids) {
            this.newSelection.set(id, select);
            const pair = this.pairForSource(id);
            if (pair) { pair.checked = select; this.pairChecks.set(id, select); }
        }
        this.selectionCountsValid = false;
        const label = category?.selectedOptions[0].textContent ?? '已配对';
        this.message(`${side === 'new' ? '母本' : '目标书'}当前搜索结果：${select ? '已勾选' : '已取消勾选'} ${ids.length} 条「${label}」。`);
        this.render();
    }

    changed(pair) {
        if (!this.oldBook || !this.newBook) return false;
        const key = [pair.oldId, pair.newId, this.mode].join(':');
        if (!this.changeCache.has(key)) this.changeCache.set(key, pairChanged(this.oldBook, this.newBook, pair, this.mode));
        return this.changeCache.get(key);
    }
    selectedPairs() { return this.pairs.filter(pair => pair.checked && this.inScope(pair.newId) && this.changed(pair)); }

    select(side, id) {
        if (this.busy) return;
        const previousOld = this.selectedOld, previousNew = this.selectedNew;
        if (side === 'old') this.selectedOld = id; else this.selectedNew = id;
        this.previewOpen = true;
        const pair = this.pairs.find(p => p[side === 'old' ? 'oldId' : 'newId'] === id);
        const followPair = this.lastSelectedSide === null || this.lastSelectedSide === side;
        if (pair && followPair && side === 'old') this.selectedNew = pair.newId;
        if (pair && followPair && side === 'new') this.selectedOld = pair.oldId;
        this.lastSelectedSide = side;
        if (this.dialog) {
            this.updateSelectedRow('old', previousOld, false);
            this.updateSelectedRow('new', previousNew, false);
            this.updateSelectedRow('old', this.selectedOld, true);
            this.updateSelectedRow('new', this.selectedNew, true);
            this.renderPreview();
            this.renderPairControls();
            this.renderSelectionSummary();
            if (this.find('.stwu-settings').open && this.find('[data-set-scope]').value === 'current') this.renderSettingsInfo();
        } else this.render();
        if (pair) {
            const otherSide = side === 'old' ? 'new' : 'old';
            const counterpart = side === 'old' ? pair.newId : pair.oldId;
            const selectedCounterpart = side === 'old' ? this.selectedNew : this.selectedOld;
            const targetIndex = this.filteredRows[otherSide].findIndex(row => row.id === counterpart);
            if (targetIndex >= 0 && (followPair || selectedCounterpart === counterpart)) {
                const targetPage = Math.floor(targetIndex / this.pageSize[otherSide]) + 1;
                if (targetPage !== this.page[otherSide]) {
                    this.page[otherSide] = targetPage;
                    this.renderList(otherSide);
                    this.renderControls();
                }
            }
            const other = this.find(`[data-list="${otherSide}"]`);
            const counterpartRow = other.querySelector(`[data-id="${counterpart}"]`);
            if (selectedCounterpart === counterpart && counterpartRow) {
                const row = counterpartRow.getBoundingClientRect(), list = other.getBoundingClientRect();
                if (row.top < list.top) other.scrollTop += row.top - list.top;
                else if (row.bottom > list.bottom) other.scrollTop += row.bottom - list.bottom;
            }
            const location = targetIndex < 0 ? '配对的对侧条目不在当前搜索结果中。' : counterpartRow ? '' : `配对的对侧条目位于第 ${Math.floor(targetIndex / this.pageSize[otherSide]) + 1} 页。`;
            this.message(`现有配对依据：${pair.reason}。${selectedCounterpart === counterpart ? (this.changed(pair) ? '有变化，正文已在下方显示。' : '当前替换范围内没有变化。') : '两侧选中的条目不同于现有配对，可手动重新配对。'}${location}`);
        } else {
            const { reviewRows, reviewReasons } = this.incoming();
            if (reviewRows[side].has(id)) {
                this.message(side === 'new' ? reviewReasons.get(id) : '这是待核对的目标候选。可选择母本条目后手动配对。');
            }
        }
    }

    manualPair() {
        try {
            if (!this.selectedOld || !this.selectedNew) return;
            const displaced = this.pairs.filter(pair => (pair.oldId === this.selectedOld || pair.newId === this.selectedNew) && !(pair.oldId === this.selectedOld && pair.newId === this.selectedNew));
            const manualConflicts = displaced.filter(retainedPair);
            if (manualConflicts.length && !globalThis.confirm(`新的手动配对将解除 ${manualConflicts.length} 组之前手动决定的配对。确认继续？`)) return;
            const remaining = this.pairs.filter(pair => pair.oldId !== this.selectedOld && pair.newId !== this.selectedNew);
            this.pairs = pairManually(remaining, this.selectedOld, this.selectedNew);
            this.syncPairIndex();
            for (const pair of displaced) {
                if (pair.oldId !== this.selectedOld) this.unpairedOld.add(pair.oldId);
                if (pair.newId !== this.selectedNew) this.unpairedNew.add(pair.newId);
                if (!this.newSelection.has(pair.newId)) this.newSelection.set(pair.newId, pair.checked);
            }
            this.unpairedOld.delete(this.selectedOld); this.unpairedNew.delete(this.selectedNew);
            this.invalidateIncoming();
            const selected = this.inScope(this.selectedNew);
            const pair = this.pairForSource(this.selectedNew);
            if (pair) pair.checked = selected;
            this.pairChecks.set(this.selectedNew, selected);
            this.newSelection.set(this.selectedNew, selected); this.selectionCountsValid = false;
            if (this.scopeGroups?.length) this.repair(false, false);
            const changed = displaced.length ? `已解除 ${displaced.length} 组冲突配对。` : '';
            this.message((this.inScope(this.selectedNew) ? '已手动配对，正文已在下方并排显示。' : '已手动配对；此条在名单外，不参与当前批量写入。') + changed); this.render();
        } catch (error) { this.message(error.message, true); }
    }

    unpair() {
        const removed = this.pairs.filter(p => p.oldId === this.selectedOld || p.newId === this.selectedNew);
        for (const pair of removed) {
            this.unpairedOld.add(pair.oldId); this.unpairedNew.add(pair.newId);
            if (!this.newSelection.has(pair.newId)) this.newSelection.set(pair.newId, pair.checked);
        }
        this.pairs = this.pairs.filter(p => !removed.includes(p));
        this.syncPairIndex();
        this.invalidateIncoming(); this.selectionCountsValid = false;
        if (this.scopeGroups?.length) this.repair(false, false);
        this.message('已解除所选配对；重新自动匹配时会保留此决定。'); this.render();
    }

    unpairAll() {
        for (const pair of this.pairs) {
            this.unpairedOld.add(pair.oldId); this.unpairedNew.add(pair.newId);
            if (!this.newSelection.has(pair.newId)) this.newSelection.set(pair.newId, pair.checked);
        }
        this.pairs = []; this.syncPairIndex(); this.invalidateIncoming(); this.selectionCountsValid = false;
        this.message('已解除全部配对；要恢复自动配对，请选择重置配对决定。'); this.render();
    }

    render() {
        for (const side of ['old', 'new']) this.renderList(side);
        this.renderControls();
        this.renderPreview();
    }

    updateSelectedRow(side, id, selected) {
        if (id == null) return;
        const row = this.rowElements?.[side]?.get(String(id));
        if (!row) return;
        row.classList.toggle('stwu-entry-selected', selected);
        row.querySelector('.stwu-entry-button')?.setAttribute('aria-pressed', String(selected));
    }

    renderList(side) {
        const book = side === 'old' ? this.oldBook : this.newBook;
        const list = this.find(`[data-list="${side}"]`), scrollTop = list.scrollTop;
        const focused = list.contains(document.activeElement) ? document.activeElement : null;
        const focusedId = focused?.closest('[data-id]')?.dataset.id;
        const focusedTag = focused?.tagName;
        const search = this.find(`[data-search="${side}"]`).value.trim().toLocaleLowerCase();
        const fragment = document.createDocumentFragment();
        const rowElements = new Map();
        const pairsById = new Map(this.pairs.map((p, i) => [side === 'old' ? p.oldId : p.newId, { pair: p, number: i + 1 }]));
        const { states, reviewRows, reviewReasons } = this.incoming();
        const reviewIds = reviewRows[side];
        const pinning = this.pinMatches && this.newBook && (this.pairs.length > 0 || this.scopeNames.length > 0 || reviewIds.size > 0);
        const pinned = new Set();
        let rows = book ? listEntries(book) : [];
        if (pinning) {
            const sourceRows = side === 'new' ? rows : listEntries(this.newBook);
            const scopedIds = this.scopeNames.length ? sourceRows.filter(({ id }) => this.inScope(id)).map(({ id }) => id) : [];
            const reviewOrder = rows.filter(({ id }) => reviewIds.has(id)).map(({ id }) => id);
            const scopedPairs = this.scopeNames.length ? this.pairs.filter(pair => this.inScope(pair.newId)) : this.pairs;
            const block = pinBlock(sourceRows, scopedPairs, side, scopedIds, pair => this.isEntryChecked(pair.newId), reviewOrder);
            for (const id of block) pinned.add(String(id));
            rows = orderWithPinned(rows, block);
        }
        const single = [...search].length === 1;
        const filtered = rows.filter(({ entry }) => !search || [entry.comment || '', ...(entry.key || []), ...(entry.keysecondary || [])].some(value => {
            const field = value.trim().toLocaleLowerCase();
            return single ? field === search : field.includes(search);
        }));
        const reviewCount = reviewIds.size ? filtered.filter(({ id }) => reviewIds.has(id)).length : 0;
        const reviewJump = this.find(`[data-review-jump="${side}"]`);
        reviewJump.hidden = !reviewCount;
        if (reviewCount) reviewJump.textContent = `待核对 ${reviewCount}`;
        this.filteredRows[side] = filtered;
        if (side === 'new') this.visibleSourceSet = new Set(filtered.map(({ id }) => id));
        const pageCount = Math.max(1, Math.ceil(filtered.length / this.pageSize[side]));
        this.page[side] = Math.max(1, Math.min(pageCount, this.page[side]));
        const start = (this.page[side] - 1) * this.pageSize[side];
        const pageRows = filtered.slice(start, start + this.pageSize[side]);
        if (side === 'new') this.visibleCopyCount = this.visibleCopyIds().length;
        for (const { id, entry } of pageRows) {
            const linked = pairsById.get(id), pair = linked?.pair, changed = pair && this.changed(pair);
            const li = element('li', 'stwu-entry wi-card-entry'); li.dataset.id = id;
            li.classList.toggle('stwu-entry-selected', id === (side === 'old' ? this.selectedOld : this.selectedNew));
            {
                const label = element('label', 'stwu-entry-check');
                const check = element('input'); check.type = 'checkbox';
                check.checked = side === 'new' ? this.isEntryChecked(id) : this.isTargetChecked(id);
                check.disabled = this.busy;
                const checkLabel = side === 'old' && !pair
                    ? (reviewIds.has(id) ? '待核对目标候选' : '目标书独有条目') : '选择条目';
                check.setAttribute('aria-label', `${checkLabel}：${title(entry)}`);
                label.append(check); li.append(label);
            }
            const button = element('button', 'menu_button stwu-entry-button'); button.type = 'button'; button.disabled = this.busy;
            button.setAttribute('aria-pressed', String(li.classList.contains('stwu-entry-selected')));
            button.append(element('span', 'stwu-entry-title', title(entry)));
            const state = side === 'new' ? states.get(id) : null;
            const needsReview = reviewIds.has(id);
            const unpairedLabel = side === 'old' ? '目标书独有 · 保留'
                : !this.inScope(id) ? '名单外'
                : state === 'new' ? '未配对 · 可复制' : '待载入目标书';
            li.classList.toggle('stwu-entry-pinned', pinned.has(id));
            const pairing = pair ? `配对 ${linked.number} · ${changed ? '有变化' : '无变化'}${this.inScope(pair.newId) ? '' : ' · 名单外'}` : unpairedLabel;
            const reason = side === 'new' ? reviewReasons.get(id) : '';
            const label = needsReview ? ['待核对', reason, pair ? pairing : ''].filter(Boolean).join(' · ') : pairing;
            const status = element('span', 'stwu-entry-status', (pinned.has(id) ? '置顶 · ' : '') + label);
            if (reason) button.title = reason;
            status.classList.toggle('stwu-paired', !!pair); button.append(status);
            li.append(button); fragment.append(li); rowElements.set(String(id), li);
        }
        if (!filtered.length) fragment.append(element('li', 'stwu-empty', book ? (Object.keys(book.entries).length ? '没有符合条件的条目' : '这本世界书还没有条目') : '尚未载入世界书'));
        list.replaceChildren(fragment); list.scrollTop = scrollTop;
        this.rowElements ??= {};
        this.rowElements[side] = rowElements;
        if (focusedId) list.querySelector(`[data-id="${focusedId}"] ${focusedTag === 'INPUT' ? 'input' : 'button'}`)?.focus({ preventScroll: true });
        this.find(`[data-side="${side}"] .stwu-count`).textContent = book ? `${filtered.length}/${Object.keys(book.entries).length}` : '';
        this.find(`[data-page-status="${side}"]`).textContent = `${filtered.length ? this.page[side] : 0} / ${filtered.length ? pageCount : 0}`;
    }

    renderControls() {
        for (const node of this.dialog.querySelectorAll('select, input, button, textarea')) node.disabled = this.busy;
        this.find('[data-scope-report]').textContent = this.scopeText();
        this.find('[data-scope-state]').textContent = this.scopeNames.length ? '已填写' : '未填写';
        if (!this.selectionCountsValid) this.refreshSelectionCounts();
        for (const side of ['old', 'new']) {
            this.find(`[data-page-size="${side}"]`).value = String(this.pageSize[side]);
            const pages = Math.max(1, Math.ceil(this.filteredRows[side].length / this.pageSize[side]));
            this.find(`[data-page-step="${side}:-1"]`).disabled = this.busy || this.page[side] <= 1;
            this.find(`[data-page-step="${side}:1"]`).disabled = this.busy || this.page[side] >= pages;
        }
        this.renderSelectionSummary();
        this.renderPairControls();
        this.renderSettingsInfo();
        if (this.targetOperation) this.renderTargetOperation();
    }

    renderBulkSelection() {
        const category = this.find('[data-selection-category]');
        for (const [side, action] of [['new', 'toggle-selection'], ['old', 'toggle-target-selection']]) {
            const toggle = this.find(`[data-action="${action}"]`);
            const ids = this.bulkSelectionIds(category.value, side);
            const allSelected = ids.length > 0 && ids.every(id => this.isEntryChecked(id));
            const verb = allSelected ? '取消勾选' : '勾选';
            toggle.textContent = ids.length ? `${verb} ${ids.length} 条` : side === 'old' ? '勾选已配对' : '批量勾选';
            toggle.setAttribute('aria-pressed', String(allSelected));
            toggle.disabled = this.busy || !ids.length;
        }
    }

    renderSelectionSummary() {
        this.renderBulkSelection();
        if (!this.selectionCountsValid) this.refreshSelectionCounts();
        const hasRoster = this.scopeNames.length > 0;
        const summary = this.busy ? '处理中…' : `已勾选 ${this.selectedEntryCount} 条 · 当前结果可复制 ${this.visibleCopyCount} 条 · 可替换 ${this.selectedUpdateCount} 组`;
        for (const node of this.dialog.querySelectorAll('.stwu-selection')) {
            if (hasRoster && !this.busy) node.textContent = `已勾选 ${this.selectedEntryCount} 条`;
            else node.textContent = node.classList.contains('stwu-selection-compact')
                ? (this.busy ? '处理中…' : `已选 ${this.selectedEntryCount} · 可替换 ${this.selectedUpdateCount}`)
                : summary;
        }
        const copy = this.find('[data-action="copy"]');
        const replace = this.find('[data-action="replace"]');
        const roster = this.find('[data-action="preview-roster"]');
        copy.hidden = replace.hidden = hasRoster;
        roster.hidden = !hasRoster;
        roster.disabled = this.busy || this.service.requiresReload || !this.oldBook || !this.newBook;
        copy.textContent = `复制所选${this.visibleCopyCount ? ` (${this.visibleCopyCount})` : ''}`;
        replace.textContent = `替换所选${this.selectedUpdateCount ? ` (${this.selectedUpdateCount})` : ''}`;
        copy.disabled = this.busy || !!this.service.requiresReload || !this.visibleCopyCount || !this.oldBook;
        replace.disabled = this.busy || !!this.service.requiresReload || !this.selectedUpdateCount || !this.oldBook || !this.newBook;
    }

    refreshSelectionCounts() {
        this.selectedUpdateCount = this.selectedPairs().length;
        this.selectedEntryCount = this.selectedSourceIds().length;
        this.visibleCopyCount = this.visibleCopyIds().length;
        this.selectionCountsValid = true;
    }

    renderPairControls() {
        const samePair = !!(this.selectedOld && this.selectedNew && this.pairs.some(p => p.oldId === this.selectedOld && p.newId === this.selectedNew));
        const pairedSingle = !!(this.selectedOld && !this.selectedNew && this.pairByTarget.has(this.selectedOld))
            || !!(!this.selectedOld && this.selectedNew && this.pairBySource.has(this.selectedNew));
        const canUnpair = samePair || pairedSingle;
        const canPair = !!(this.selectedOld && this.selectedNew && !samePair);
        const ready = !this.busy && !!this.oldBook && !!this.newBook;
        for (const toggleBtn of [this.find('[data-pair-toggle]'), this.find('[data-quick-pair]')].filter(Boolean)) {
            const isQuick = toggleBtn.hasAttribute?.('data-quick-pair');
            toggleBtn.dataset.pairBtn = canUnpair ? 'unpair' : 'pair';
            toggleBtn.textContent = canUnpair ? (isQuick ? '快速解除' : '解除配对') : (isQuick ? '快速配对' : '配对所选');
            toggleBtn.disabled = !ready || (!canUnpair && !canPair);
        }
        const setDisabled = (name, disabled) => {
            const btn = this.find(`[data-pair-btn="${name}"]`);
            if (btn) btn.disabled = disabled;
        };
        setDisabled('unpair-all', !ready || !this.pairs.length);
        setDisabled('auto', !ready);
        setDisabled('auto-reset', !ready);
        const hasTargetSelection = !!(this.oldBook && (this.oldBook.entries[this.selectedOld] || this.targetChecks.size));
        const hasMotherMatch = !!(ready && !this.sameNamedBook() && this.newBook?.entries[this.selectedNew]);
        const canTargetOp = !this.busy && !!this.oldBook && !this.service.requiresReload && (hasMotherMatch || hasTargetSelection);
        setDisabled('consolidate', !canTargetOp);
        const targetOpBtn = this.find('[data-action="target-operation"]');
        if (targetOpBtn) targetOpBtn.disabled = !canTargetOp;
        const hint = this.find('.stwu-pairbar .stwu-pairhint');
        if (hint) hint.textContent = canUnpair ? '当前条目已配对，可直接解除' : canPair ? '已选两侧条目，可执行配对' : '点击两侧条目后，可在此配对或解除';
    }

    renderPreview() {
        const workspace = this.find('.stwu-workspace');
        workspace.dataset.previewOpen = String(this.previewOpen);
        const split = this.splitMode || 'balanced';
        workspace.dataset.split = split;
        const splitBtn = this.find('[data-action="cycle-split"]');
        if (splitBtn) {
            const labels = { balanced: '高度：均分', body: '高度：正文大', list: '高度：列表大' };
            splitBtn.textContent = labels[split] || labels.balanced;
        }
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
        const selectedUpdateIds = new Set(this.selectedPairs().map(pair => pair.newId));
        const pairs = this.pairs.map(pair => ({ ...pair, checked: selectedUpdateIds.has(pair.newId) }));
        const result = buildUpdate(this.oldBook, this.newBook, pairs, this.mode);
        if (!result.updated) { this.message(`所选配对条目没有需要替换的内容。${result.skipped ? `无变化 ${result.skipped} 组已跳过。` : ''}`); return; }
        const scope = this.mode === 'content' ? '仅替换正文，保留目标书设置' : '完整更新条目，同步母本的标题、关键词和设置';
        const scopeNote = this.scopeNames.length ? `定点名单：${this.scopeNames.join('、')}；名单外不参与替换。\n` : '处理范围：整本。\n';
        const visible = new Set(this.visibleSourceIds());
        const hidden = [...selectedUpdateIds].filter(id => !visible.has(id)).length;
        const hiddenNote = hidden ? `其中 ${hidden} 条被搜索隐藏，但仍参与替换。\n` : '';
        const skipNote = result.skipped ? `无变化 ${result.skipped} 组将跳过。\n` : '';
        if (!globalThis.confirm(`将用母本「${this.newName}」的内容替换目标书「${this.oldName}」中已配对的 ${result.updated} 条条目。\n${scopeNote}替换范围：${scope}。\n${hiddenNote}${skipNote}确认继续？`)) return;
        this.message('正在保存并核验目标书…');
        const saved = await this.saveTargetFromMother(result.data);
        this.oldBook = saved.data;
        if (this.sourceKind === 'book' && this.oldName === this.newName) this.newBook = saved.data;
        this.changeCache.clear();
        this.pairs = this.pairs.map(pair => selectedUpdateIds.has(pair.newId) ? { ...pair, checked: false } : pair);
        this.syncPairIndex();
        for (const id of selectedUpdateIds) { this.pairChecks.set(id, false); this.newSelection.set(id, false); }
        this.selectionCountsValid = false;
        this.invalidateIncoming();
        this.message(`已核验并替换 ${result.updated} 组，跳过无变化 ${result.skipped} 组。${saved.note || ''}`);
    }

    async copySelected() {
        if (!this.oldBook || !this.newBook) throw new Error('请先载入母本和目标书。');
        const visible = new Set(this.visibleSourceIds());
        const selectedIds = this.selectedSourceIds();
        const additions = this.visibleCopyIds();
        const { states } = this.incoming();
        const hidden = selectedIds.filter(id => !visible.has(id)).length;
        const paired = selectedIds.filter(id => visible.has(id) && states.get(id) === 'paired').length;
        const review = selectedIds.filter(id => visible.has(id) && states.get(id) === 'review').length;
        const notes = [
            paired && `已配对 ${paired} 条，可通过「替换所选」更新。`,
            review && `待核对 ${review} 条，可先确认配对。`,
            hidden && `搜索隐藏 ${hidden} 条，保留勾选。`,
        ].filter(Boolean).join(' ');
        if (!additions.length) { this.message(`当前搜索结果没有可复制的缺失条目。${notes}`); return; }
        const pairs = this.pairs.map(pair => ({ ...pair, checked: false }));
        const result = buildUpdate(this.oldBook, this.newBook, pairs, this.mode, { merge: true, additions, workKeys: this.scopeWorkKeys });
        const skipped = result.skipped ? `已有相同条目 ${result.skipped} 条，已跳过。` : '';
        if (!result.added) { this.message(`没有需要新增的条目。${skipped}${notes}`); return; }
        const names = result.addedPairs.slice(0, 12).map(({ newId }) => `- ${title(this.newBook.entries[newId])}`).join('\n');
        const more = result.added > 12 ? `\n- 另有 ${result.added - 12} 条` : '';
        if (!globalThis.confirm([`将从母本「${this.newName}」向目标书「${this.oldName}」复制以下 ${result.added} 条缺失条目：\n${names}${more}`, skipped, notes, '确认继续？'].filter(Boolean).join('\n'))) return;
        this.message('正在向目标书复制条目并核验…');
        const saved = await this.saveTargetFromMother(result.data);
        this.oldBook = saved.data;
        if (this.sourceKind === 'book' && this.oldName === this.newName) this.newBook = saved.data;
        this.changeCache.clear();
        this.pairs = [...this.pairs, ...result.addedPairs];
        this.syncPairIndex();
        for (const pair of result.addedPairs) {
            this.newSelection.set(pair.newId, false);
            this.unpairedNew.delete(pair.newId); this.pairChecks.set(pair.newId, false);
        }
        this.selectionCountsValid = false;
        this.invalidateIncoming();
        this.message(`已核验：复制 ${result.added} 条缺失条目。${skipped}${notes}${saved.note || ''}`);
    }

    sameNamedBook() {
        return this.sourceKind === 'book' && this.oldName === this.newName;
    }

    saveTargetFromMother(next, { target = this.oldName, before = this.oldBook, mother = this.newBook } = {}) {
        const source = this.sourceKind === 'book' ? { name: this.newName, data: mother } : undefined;
        return this.service.updateDirect(target, before, next, source);
    }

    openTargetOperation() {
        if (!this.oldBook) return;
        const newId = !this.sameNamedBook() && this.newBook?.entries[this.selectedNew] ? this.selectedNew : null;
        const matched = newId ? consolidationCandidates(this.oldBook, this.newBook, newId, this.scopeWorkKeys) : [];
        const matches = new Set(matched);
        if (newId) {
            const linked = this.pairForSource(newId);
            if (linked && this.oldBook.entries[linked.oldId]) matches.add(linked.oldId);
            if (matches.size && this.oldBook.entries[this.selectedOld]) matches.add(this.selectedOld);
        }
        const directIds = [...new Set([...this.targetChecks, ...(this.oldBook.entries[this.selectedOld] ? [this.selectedOld] : [])])];
        const isMatched = matches.size > 0;
        const candidateIds = isMatched ? matches : new Set(directIds);
        if (!candidateIds.size) {
            this.message('目标书没有可核对的匹配条目；如需直接删除，请先在目标书勾选或点选条目。');
            return;
        }
        this.targetOperation = isMatched
            ? { kind: 'matched', target: this.oldName, before: this.oldBook, mother: this.newBook, newId, mode: this.mode, matchedIds: new Set(matched) }
            : { kind: 'direct', target: this.oldName, before: this.oldBook, mother: this.newBook, newId: null, mode: this.mode, matchedIds: new Set() };
        this.find('[data-consolidate-context]').textContent = isMatched
            ? `母本条目「${title(this.newBook.entries[newId])}」 · 目标书「${this.oldName}」`
            : `目标书「${this.oldName}」 · 直接删除所选条目（共 ${candidateIds.size} 条）`;
        const opSelect = this.find('[data-target-operation]');
        opSelect.value = isMatched && matches.size >= 2 ? 'consolidate' : 'delete';
        const keep = this.find('[data-consolidate-keep]');
        const labels = document.createDocumentFragment(), rows = document.createDocumentFragment();
        const preChecked = !isMatched ? candidateIds : (opSelect.value === 'delete' ? new Set(directIds) : new Set());
        for (const { id, entry } of listEntries(this.oldBook)) {
            if (!candidateIds.has(id)) continue;
            const name = `${title(entry)} · UID ${id}`;
            labels.append(new Option(name, id));
            const row = element('li', 'stwu-consolidate-candidate');
            const label = element('label'), check = element('input');
            check.type = 'checkbox';
            check.checked = preChecked.has(id);
            check.dataset.consolidateRemove = id;
            label.append(check, element('span', '', name));
            row.append(label);
            if (entry.key?.length) row.append(element('small', '', `主关键词：${entry.key.join('、').slice(0, 160)}`));
            if (entry.content.trim()) row.append(element('p', '', entry.content.trim().slice(0, 120)));
            rows.append(row);
        }
        keep.replaceChildren(labels);
        const linked = newId ? this.pairForSource(newId) : null;
        if (isMatched && matches.has(linked?.oldId)) keep.value = linked.oldId;
        this.find('[data-consolidate-candidates]').replaceChildren(rows);
        this.find('[data-consolidate-dialog]').showModal();
        this.renderTargetOperation();
    }

    targetOperationSelection() {
        const deleting = this.find('[data-target-operation]').value === 'delete';
        const retained = this.find('[data-consolidate-keep]').value;
        const oldIds = [...this.dialog.querySelectorAll('[data-consolidate-remove]')]
            .filter(input => input.checked && (deleting || input.dataset.consolidateRemove !== retained))
            .map(input => input.dataset.consolidateRemove);
        return { deleting, retained, oldIds };
    }

    renderTargetOperation() {
        if (!this.targetOperation) return;
        const directOnly = this.targetOperation.kind === 'direct';
        const opSelect = this.find('[data-target-operation]');
        if (directOnly) opSelect.value = 'delete';
        opSelect.disabled = this.busy || directOnly;
        const { deleting, retained, oldIds } = this.targetOperationSelection();
        const label = this.find('[data-consolidate-keep-label]');
        label.hidden = deleting;
        this.find('[data-consolidate-keep]').disabled = this.busy || deleting;
        const inputs = this.dialog.querySelectorAll('[data-consolidate-remove]');
        for (const input of inputs) {
            const keep = !deleting && input.dataset.consolidateRemove === retained;
            if (keep) input.checked = false;
            input.disabled = this.busy || keep;
        }
        const button = this.find('[data-action="save-consolidation"]');
        button.textContent = deleting ? '确认删除' : '确认合并';
        button.disabled = this.busy || this.service.requiresReload || !oldIds.length || (!deleting && !retained);
        const removing = oldIds.map(id => `UID ${id}`).join('、');
        const scope = this.targetOperation.mode === 'full' ? '完整条目' : '仅正文';
        const remaining = inputs.length - oldIds.length - Number(!deleting);
        const unselected = oldIds.length && remaining > 0 ? `另有 ${remaining} 条未勾选的候选将保留。` : '';
        this.find('[data-consolidate-summary]').textContent = deleting
            ? (oldIds.length ? `将从目标书删除 ${oldIds.length} 条（${removing}）。${unselected}` : '勾选要从目标书删除的条目。')
            : (oldIds.length ? `保留 UID ${retained}，用母本更新（${scope}），删除 ${removing}。${unselected}`
                : inputs.length < 2 ? '合并需要至少两条候选。' : '选择保留条目，再勾选要移除的同一人物副本。');
    }

    async saveTargetOperation() {
        const operation = this.targetOperation;
        if (!operation) return;
        const { deleting, retained, oldIds } = this.targetOperationSelection();
        if (!oldIds.length) return;
        this.targetOperation = null;
        this.find('[data-consolidate-dialog]').close();
        const { kind, target, before, mother, newId, mode, matchedIds } = operation;
        if (target !== this.oldName || before !== this.oldBook || (kind === 'matched' && (mother !== this.newBook || this.sameNamedBook()))) {
            throw new Error('世界书在预览后已变化，请重新选择条目。');
        }
        const result = deleting
            ? (kind === 'matched' && oldIds.every(id => matchedIds.has(id))
                ? buildMatchedDeletion(before, mother, { newId, oldIds }, this.scopeWorkKeys)
                : buildDirectDeletion(before, oldIds))
            : buildConsolidation(before, mother, { newId, oldId: retained, duplicateOldIds: oldIds }, mode, this.scopeWorkKeys);
        this.message('正在保存并核验目标书…');
        const saved = await this.saveTargetFromMother(result.data, operation);
        this.oldBook = saved.data;
        if (this.sameNamedBook()) this.newBook = saved.data;
        const removed = new Set(result.removedOldIds);
        this.pairs = this.pairs.filter(pair => !removed.has(pair.oldId)
            && (deleting || (pair.oldId !== retained && pair.newId !== newId)));
        for (const id of removed) this.unpairedOld.delete(id);
        if (!deleting && newId) {
            this.pairs.push({ oldId: retained, newId, checked: false, reason: '手动配对' });
            this.unpairedOld.delete(retained);
            this.unpairedNew.delete(newId);
            this.newSelection.set(newId, false);
            this.pairChecks.set(newId, false);
            this.selectedOld = retained;
        }
        this.repair(false, false);
        const done = deleting ? `已核验并删除 ${result.removed} 条目标条目。`
            : `已核验并合并：保留 UID ${retained}，移除 ${result.removed} 条目标副本。`;
        this.message(done + (saved.note || ''));
    }

    rosterPairingOptions(manualPairs = this.pairs.filter(retainedPair)) {
        return {
            workKeys: this.scopeWorkKeys,
            manualPairs,
            unpairedOld: this.unpairedOld,
            unpairedNew: this.unpairedNew,
        };
    }

    previewRoster() {
        this.applyScope();
        const roster = this.resolvedRoster();
        if (!roster) return;
        const plan = buildResolvedRosterUpdate(this.oldBook, this.newBook, roster, this.mode, this.scopeWorkKeys);
        this.rosterPreview = { plan, before: this.oldBook, mother: this.newBook, target: this.oldName };
        const sections = [
            ['替换', plan.replace], ['复制', plan.copy], ['无变化', plan.unchanged],
            ['待核对', plan.review], ['母本未找到', plan.missing],
        ];
        const mode = this.mode === 'content' ? '仅正文' : '完整条目';
        this.find('[data-roster-summary]').textContent = `母本「${this.newName}」 → 目标书「${this.oldName}」 · 替换范围：${mode}。\n`
            + sections.map(([label, names]) => `${label} ${names.length}`).join(' · ');
        this.find('[data-roster-report]').textContent = sections.filter(([, names]) => names.length)
            .map(([label, names]) => `${label}\n${names.join('\n')}`).join('\n\n');
        this.find('[data-action="save-roster"]').hidden = !(plan.result.updated || plan.result.added);
        const dialog = this.find('[data-roster-dialog]');
        dialog.showModal();
        this.find('[data-roster-report]').scrollTop = 0;
    }

    async saveRoster() {
        const preview = this.rosterPreview;
        this.rosterPreview = null;
        if (!preview) return;
        if (preview.target !== this.oldName || preview.before !== this.oldBook || preview.mother !== this.newBook) {
            throw new Error('世界书在预览后已变化，请重新预览。');
        }
        const { plan } = preview;
        const { result } = plan;
        if (!(result.updated || result.added)) return;
        this.message('正在写入并核验目标书…');
        const saved = await this.saveTargetFromMother(result.data, preview);
        this.oldBook = saved.data;
        if (this.sourceKind === 'book' && this.oldName === this.newName) this.newBook = saved.data;
        this.pairs.push(...result.addedPairs);
        this.repair();
        this.message(`已核验：替换 ${result.updated} 条，复制 ${result.added} 条，无变化 ${plan.unchanged.length} 条，待核对 ${plan.review.length} 个，母本未找到 ${plan.missing.length} 个。${saved.note || ''}`);
    }

    destroy() {
        this.disposed = true;
        this.events.abort();
        this.dialog.close(); this.dialog.remove();
        for (const timer of this.timers) clearTimeout(timer);
        if (this.searchTimers) for (const timer of Object.values(this.searchTimers)) clearTimeout(timer);
        for (const url of this.urls) URL.revokeObjectURL(url);
        this.timers.clear(); this.urls.clear();
        this.service.close();
    }
}
