import test from 'node:test';
import assert from 'node:assert/strict';
import { UpdaterWindow } from '../ui.js';
import { parseNameList } from '../core.js';

const entry = (uid, comment, content, extra = {}) => ({ uid, comment, key: [comment], content, ...extra });
const book = entries => ({ entries: Object.fromEntries(entries.map(item => [item.uid, item])) });

class FakeNode {
    constructor(tag) {
        this.tagName = tag.toUpperCase();
        this.children = [];
        this.dataset = {};
        this.scrollTop = 0;
        this.attributes = {};
        this.classes = new Set();
        this.classList = {
            toggle: (name, force) => {
                const add = force === undefined ? !this.classes.has(name) : !!force;
                if (add) this.classes.add(name);
                else this.classes.delete(name);
            },
            contains: name => this.classes.has(name),
        };
    }
    append(...nodes) { this.children.push(...nodes); }
    setAttribute(key, value) { this.attributes[key] = value; }
    replaceChildren(fragment) { this.children = fragment.children; }
    contains() { return false; }
    querySelector() { return null; }
}

function setup() {
    const ui = Object.create(UpdaterWindow.prototype);
    Object.assign(ui, {
        oldBook: book([entry(0, 'Alice', 'old'), entry(1, 'Bob', 'old'), entry(2, 'Other', 'old')]),
        newBook: book([entry(10, 'Alice', 'new'), entry(11, 'Bob', 'new'), entry(12, 'Alice', 'different', { key: ['Alice extra'] }), entry(13, 'New', 'fresh')]),
        oldName: 'target', newName: 'mother', sourceKind: 'book', pairs: [],
        pairBySource: new Map(), pairByTarget: new Map(), changeCache: new Map(), incomingCache: null,
        newSelection: new Map(), pairChecks: new Map(), unpairedOld: new Set(), unpairedNew: new Set(),
        selectionCountsValid: false, selectedUpdateCount: 0, selectedCopyCount: 0, visibleCopyCount: 0,
        pageSize: { old: 25, new: 25 }, page: { old: 1, new: 1 },
        filteredRows: { old: [], new: [] }, visibleSourceSet: new Set(['10', '11', '12', '13']),
        selectedOld: null, selectedNew: null, lastSelectedSide: null,
        previewOpen: false, splitMode: 'balanced', mode: 'content',
        scopeNames: [], scopeWorks: [], scopeWorkKeys: [], pinMatches: true, busy: false,
    });
    const pairButtons = {
        toggle: { disabled: false, dataset: { pairBtn: 'pair' }, textContent: '配对所选' },
        'unpair-all': { disabled: false },
        auto: { disabled: false },
        'auto-reset': { disabled: false },
    };
    const nodes = {
        '[data-scope]': { value: '' },
        '[data-mode]': { value: 'content' },
        '[data-selection-category]': { value: 'paired', selectedOptions: [{ textContent: '已配对' }] },
        '[data-search="new"]': { value: '' },
        '[data-search="old"]': { value: '' },
        '[data-list="old"]': { scrollTop: 0 },
        '[data-list="new"]': { scrollTop: 0 },
        '[data-set-scope]': { value: 'current', selectedOptions: [{ textContent: '测试范围' }] },
        '.stwu-workspace': { dataset: { previewOpen: 'false', split: 'balanced' } },
        '[data-action="cycle-split"]': { textContent: '高度：均分' },
        '.stwu-pairbar .stwu-pairhint': { textContent: '' },
        '[data-pair-toggle]': pairButtons.toggle,
        '[data-pair-btn="unpair-all"]': pairButtons['unpair-all'],
        '[data-pair-btn="auto"]': pairButtons.auto,
        '[data-pair-btn="auto-reset"]': pairButtons['auto-reset'],
    };
    ui.find = selector => {
        if (nodes[selector]) return nodes[selector];
        return { textContent: '', value: '', disabled: false, dataset: {}, setAttribute() {} };
    };
    ui.render = () => {};
    ui.renderControls = () => {};
    ui.message = message => { ui.lastMessage = message; };
    ui.service = {
        writes: [],
        requiresReload: false,
        async updateDirect(name, expected, next) {
            this.writes.push({ name, expected, next: structuredClone(next) });
            return { data: structuredClone(next), note: '' };
        },
    };
    ui.repair();
    ui.filteredRows.old = Object.entries(ui.oldBook.entries).map(([id, item]) => ({ id, entry: item }));
    ui.filteredRows.new = Object.entries(ui.newBook.entries).map(([id, item]) => ({ id, entry: item }));
    return { ui, nodes, pairButtons };
}

async function withConfirm(answer, work) {
    const previous = globalThis.confirm;
    const calls = [];
    globalThis.confirm = text => { calls.push(text); return answer; };
    try { await work(calls); } finally { if (previous === undefined) delete globalThis.confirm; else globalThis.confirm = previous; }
}

test('automatic matches are selected for replacement, and cancellation never writes', async () => {
    const { ui } = setup();
    assert.ok(ui.selectedPairs().some(pair => pair.newId === '11'));
    await withConfirm(false, async calls => {
        await ui.apply();
        assert.equal(ui.service.writes.length, 0);
        assert.match(calls[0], /替换/);
    });
    await withConfirm(true, async () => {
        await ui.apply();
        assert.equal(ui.oldBook.entries['1'].content, 'new');
        assert.equal(ui.service.writes.length, 1);
    });
});

test('replacing changed pairs clears replaced pair check while retaining unchecked/other state', async () => {
    const { ui } = setup();
    ui.newBook.entries['13'] = entry(13, 'Other', 'old');
    ui.repair();
    const unchanged = ui.pairs.find(pair => pair.newId === '13');
    assert.equal(unchanged.checked, false);
    assert.equal(ui.changed(unchanged), false);
    await withConfirm(true, async () => {
        await ui.apply();
        assert.equal(ui.pairs.find(pair => pair.newId === '10').checked, false);
        assert.equal(ui.pairs.find(pair => pair.newId === '13').checked, false);
    });
});

test('applyScope restricts replacement pairs to matched names without deleting unpaired entries', async () => {
    const { ui, nodes } = setup();
    delete ui.newBook.entries['12'];
    nodes['[data-scope]'].value = 'Alice';
    ui.applyScope();
    assert.deepEqual(ui.scopeNames, ['Alice']);
    const bob = ui.pairs.find(pair => pair.newId === '11');
    assert.equal(ui.inScope('11'), false);
    assert.equal(ui.selectedPairs().some(pair => pair.newId === '11'), false);
    await withConfirm(true, async () => {
        await ui.apply();
        assert.equal(ui.oldBook.entries['1'].content, 'old');
        assert.equal(ui.oldBook.entries['0'].content, 'new');
        assert.equal(bob.checked, true);
    });
});

test('名单待核对的单字简称不会被整本回退自动勾选', () => {
    const { ui, nodes } = setup();
    ui.oldBook = book([entry(1, '琴·古恩希尔德', '旧', { key: [] })]);
    ui.newBook = book([entry(10, '琴·古恩希尔德', '新', { key: [] })]);
    ui.repair();
    assert.equal(ui.pairs.length, 1);
    nodes['[data-scope]'].value = '琴';
    ui.applyScope();
    assert.equal(ui.pairs.length, 0);
    assert.equal(ui.incoming().reviewRows.new.has('10'), true);
});

test('rematching and changing scope preserve manual pairing, unpairing and explicit unchecked choices', () => {
    const { ui, nodes } = setup();
    const bob = ui.pairs.find(pair => pair.newId === '11');
    bob.checked = false; ui.pairChecks.set('11', false); ui.newSelection.set('11', false);
    ui.selectedOld = '0'; ui.selectedNew = '10'; ui.unpair();
    ui.repair();
    assert.equal(ui.pairs.some(pair => pair.newId === '10'), false);
    assert.equal(ui.pairs.find(pair => pair.newId === '11').checked, false);
    ui.selectedOld = '2'; ui.selectedNew = '12'; ui.manualPair();
    nodes['[data-scope]'].value = 'Alice'; ui.applyScope();
    assert.ok(ui.pairs.some(pair => pair.oldId === '2' && pair.newId === '12' && pair.reason === '手动配对'));
    assert.equal(ui.pairs.some(pair => pair.newId === '10'), false);
    nodes['[data-scope]'].value = ''; ui.applyScope();
    assert.equal(ui.pairs.find(pair => pair.newId === '11').checked, false);
});

test('independent left and right selection re-pairs two existing automatic matches', () => {
    const { ui, nodes } = setup();
    for (const side of ['old', 'new']) {
        nodes[`[data-list="${side}"]`].getBoundingClientRect = () => ({ top: 0, bottom: 100 });
        nodes[`[data-list="${side}"]`].querySelector = () => ({ getBoundingClientRect: () => ({ top: 10, bottom: 30 }) });
    }
    ui.select('old', '0'); ui.select('new', '11');
    assert.equal(ui.selectedOld, '0'); assert.equal(ui.selectedNew, '11');
    ui.manualPair();
    assert.deepEqual(ui.pairs.find(pair => pair.newId === '11'), { oldId: '0', newId: '11', checked: true, reason: '手动配对' });
    assert.ok(ui.unpairedOld.has('1')); assert.ok(ui.unpairedNew.has('10'));
    assert.match(ui.lastMessage, /解除 2 组/);
    ui.repair();
    assert.equal(ui.pairs.length, 1);
    assert.equal(ui.pairs[0].newId, '11');
});

test('replacing a previous manual decision requires confirmation', async () => {
    const { ui } = setup();
    ui.selectedOld = '2'; ui.selectedNew = '13'; ui.manualPair();
    ui.selectedOld = '1'; ui.selectedNew = '13';
    await withConfirm(false, async calls => {
        ui.manualPair();
        assert.ok(ui.pairs.some(pair => pair.oldId === '2' && pair.newId === '13'));
        assert.match(calls[0], /手动决定/);
    });
});

test('toggleFilteredSelection only toggles current search results and preserves hidden selections', () => {
    const { ui } = setup();
    ui.newSelection.set('13', true);
    ui.filteredRows.new = [{ id: '11', entry: ui.newBook.entries['11'] }];
    ui.toggleFilteredSelection();
    assert.equal(ui.isEntryChecked('11'), false);
    ui.toggleFilteredSelection();
    assert.equal(ui.isEntryChecked('11'), true);
    assert.equal(ui.isEntryChecked('13'), true);
});

test('copySelected copies visible checked IDs and preserves the original pairing and hidden selections', async () => {
    const { ui } = setup();
    ui.newSelection.set('11', true);
    ui.newSelection.set('13', true);
    ui.filteredRows.new = [{ id: '11', entry: ui.newBook.entries['11'] }];
    await withConfirm(false, async calls => {
        await ui.copySelected();
        assert.equal(ui.service.writes.length, 0);
        assert.match(calls[0], /已有配对/);
        assert.match(calls[0], /搜索隐藏/);
    });
    await withConfirm(true, async () => {
        await ui.copySelected();
        assert.equal(ui.oldBook.entries['1'].content, 'old');
        assert.equal(Object.values(ui.oldBook.entries).filter(item => item.comment === 'Bob').length, 2);
        assert.equal(Object.values(ui.oldBook.entries).filter(item => item.comment === 'New').length, 0);
        assert.equal(ui.isEntryChecked('13'), true);
        assert.equal(ui.pairs.filter(pair => pair.newId === '11').length, 1);
        assert.equal(ui.pairForSource('11').oldId, '1');
        ui.repair();
        assert.equal(ui.pairForSource('11').oldId, '1');
        assert.equal(ui.isEntryChecked('11'), false);
    });
});

test('copySelected allows repeated identical copies of an unmatched entry', async () => {
    const { ui } = setup();
    ui.newSelection.set('12', true);
    await withConfirm(true, async () => {
        await ui.copySelected();
        const count = Object.keys(ui.oldBook.entries).length;
        ui.newSelection.set('12', true);
        await ui.copySelected();
        assert.equal(Object.keys(ui.oldBook.entries).length, count + 1);
        assert.equal(ui.pairs.filter(pair => pair.newId === '12').length, 1);
    });
});

test('copy failure preserves original books, pairs and explicit selections', async () => {
    const { ui } = setup();
    ui.newSelection.set('11', true);
    const pairs = structuredClone(ui.pairs), target = structuredClone(ui.oldBook);
    ui.service.updateDirect = async () => { throw new Error('write failed'); };
    await withConfirm(true, async () => {
        await assert.rejects(ui.copySelected(), /write failed/);
        assert.deepEqual(ui.oldBook, target);
        assert.deepEqual(ui.pairs, pairs);
        assert.equal(ui.isEntryChecked('11'), true);
    });
});

test('copied names quote list separators and round trip through name parser', async () => {
    const { ui } = setup();
    ui.newBook = book([entry(20, 'Name, One', 'x'), entry(21, 'Name=Two', 'x'), entry(22, 'Normal', 'x'), entry(23, 'work: Story', 'x')]);
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    let text = '';
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: async value => { text = value; } } } });
    try {
        await ui.copySourceNames();
        assert.deepEqual(parseNameList(text).names, ['Name, One', 'Name=Two', 'Normal', 'work: Story']);
        assert.match(ui.lastMessage, /核对/);
    } finally { if (previous) Object.defineProperty(globalThis, 'navigator', previous); else delete globalThis.navigator; }
});

test('mother settings use current, checked, scoped and all source IDs, with mirrored export settings', async () => {
    const { ui, nodes } = setup();
    ui.newBook.originalData = { entries: Object.values(ui.newBook.entries).map(item => ({ id: item.uid, content: item.content, extensions: {} })) };
    ui.selectedNew = '11';
    assert.deepEqual(ui.settingsSourceIds(), ['11']);
    nodes['[data-set-scope]'].value = 'checked';
    ui.newSelection.set('10', false);
    ui.newSelection.set('11', true);
    ui.newSelection.set('13', true);
    assert.deepEqual(ui.settingsSourceIds(), ['11', '13']);
    ui.scopeNames = ['Alice']; nodes['[data-set-scope]'].value = 'scope';
    assert.deepEqual(ui.settingsSourceIds(), ['10', '12']);
    nodes['[data-set-scope]'].value = 'all'; assert.equal(ui.settingsSourceIds().length, 4);
    nodes['[data-set-scope]'].value = 'checked';
    ui.collectSettingsPatch = () => ({ constant: { mode: 'set', value: true }, depth: { mode: 'set', value: 4 } });
    await withConfirm(false, async () => { await ui.applySettingsToMother(); assert.equal(ui.service.writes.length, 0); });
    await withConfirm(true, async () => {
        await ui.applySettingsToMother();
        assert.equal(ui.newBook.entries['11'].constant, true);
        assert.equal(ui.newBook.entries['11'].depth, 4);
        assert.equal(ui.newBook.entries['10'].constant, undefined);
        const mirror = ui.newBook.originalData.entries.find(item => item.id === 11);
        assert.equal(mirror.constant, true); assert.equal(mirror.extensions.depth, 4);
    });
});

test('sync settings only uses specified source IDs and updates target export mirror', async () => {
    const { ui, nodes } = setup();
    ui.oldBook.originalData = { entries: Object.values(ui.oldBook.entries).map(item => ({ id: item.uid, content: item.content, extensions: {} })) };
    ui.newBook.entries['11'].depth = 8;
    nodes['[data-set-scope]'].value = 'checked';
    ui.newSelection.set('10', false);
    ui.newSelection.set('11', true);
    ui.collectSettingsPatch = () => ({ depth: { mode: 'set', value: 0 } });
    await withConfirm(true, async () => {
        await ui.syncSettingsToTarget();
        assert.equal(ui.oldBook.entries['1'].depth, 8);
        assert.equal(ui.oldBook.originalData.entries.find(item => item.id === 1).extensions.depth, 8);
        assert.equal(ui.oldBook.entries['0'].depth, undefined);
    });
});

test('cycleSplitMode rotates height ratios and clears manual heights', () => {
    const { ui, nodes } = setup();
    const entryPanel = { style: { height: '500px', flex: '0 0 auto', removeProperty(k) { delete this[k]; } } };
    const bodyPanel = { style: { height: '400px', flex: '0 0 auto', removeProperty(k) { delete this[k]; } } };
    const origFind = ui.find;
    ui.find = sel => sel === '.stwu-entry-window' ? entryPanel : sel === '.stwu-body-window' ? bodyPanel : origFind(sel);
    ui.previewOpen = true;
    ui.cycleSplitMode();
    assert.equal(ui.splitMode, 'body');
    assert.equal(entryPanel.style.height, undefined);
    assert.equal(bodyPanel.style.height, undefined);
    assert.equal(nodes['.stwu-workspace'].dataset.split, 'body');
    assert.equal(nodes['[data-action="cycle-split"]'].textContent, '高度：正文大');
    ui.cycleSplitMode();
    assert.equal(ui.splitMode, 'list');
    assert.equal(nodes['[data-action="cycle-split"]'].textContent, '高度：列表大');
    ui.cycleSplitMode();
    assert.equal(ui.splitMode, 'balanced');
    assert.equal(nodes['[data-action="cycle-split"]'].textContent, '高度：均分');
});

test('renderPairControls reuses one button for pair and unpair based on selection', () => {
    const { ui, pairButtons } = setup();
    ui.renderPairControls();
    assert.equal(pairButtons.toggle.disabled, true);
    assert.equal(pairButtons.toggle.textContent, '配对所选');
    assert.equal(pairButtons['unpair-all'].disabled, false);
    assert.equal(pairButtons.auto.disabled, false);
    ui.selectedOld = '0'; ui.selectedNew = '10';
    ui.renderPairControls();
    assert.equal(pairButtons.toggle.disabled, false);
    assert.equal(pairButtons.toggle.textContent, '解除配对');
    assert.equal(pairButtons.toggle.dataset.pairBtn, 'unpair');
    ui.runPairAction('unpair');
    assert.equal(ui.pairs.some(pair => pair.newId === '10'), false);
    ui.renderPairControls();
    assert.equal(pairButtons.toggle.disabled, false);
    assert.equal(pairButtons.toggle.textContent, '配对所选');
    assert.equal(pairButtons.toggle.dataset.pairBtn, 'pair');
});

test('renderList pins scope matches, paginates cleanly, and keeps old unpaired rows disabled', () => {
    const { ui, nodes } = setup();
    const previousDocument = globalThis.document;
    const lists = { old: new FakeNode('ul'), new: new FakeNode('ul') };
    const counts = { old: {}, new: {} };
    const pageStatuses = { old: {}, new: {} };
    globalThis.document = { activeElement: null, createElement: tag => new FakeNode(tag), createDocumentFragment: () => new FakeNode('fragment') };
    const originalFind = ui.find;
    ui.find = selector => {
        for (const side of ['old', 'new']) {
            if (selector === `[data-list="${side}"]`) return lists[side];
            if (selector === `[data-side="${side}"] .stwu-count`) return counts[side];
            if (selector === `[data-page-status="${side}"]`) return pageStatuses[side];
        }
        return originalFind(selector);
    };
    try {
        ui.scopeNames = ['Alice'];
        ui.renderList('new'); ui.renderList('old');
        assert.equal(lists.new.children[0].dataset.id, '10');
        const otherOld = lists.old.children.find(row => row.dataset.id === '2');
        assert.equal(otherOld.children[0].children[0].disabled, true);
        const bobNew = lists.new.children.find(row => row.dataset.id === '11');
        assert.equal(bobNew.children[0].children[0].disabled, false);
        ui.pageSize.new = 2;
        ui.renderList('new');
        assert.equal(lists.new.children.length, 2);
        assert.equal(pageStatuses.new.textContent, '1 / 2');
    } finally { if (previousDocument === undefined) delete globalThis.document; else globalThis.document = previousDocument; }
});
