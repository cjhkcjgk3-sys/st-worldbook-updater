import test from 'node:test';
import assert from 'node:assert/strict';
import { UpdaterWindow } from '../ui.js';
import { parseNameList } from '../core.js';

const entry = (uid, comment, content, extra = {}) => ({ uid, comment, key: [comment], content, ...extra });
const book = entries => ({ entries: Object.fromEntries(entries.map(item => [item.uid, item])) });

function setup() {
    const ui = Object.create(UpdaterWindow.prototype);
    Object.assign(ui, {
        oldBook: book([entry(0, 'Alice', 'old'), entry(1, 'Bob', 'old'), entry(2, 'Other', 'old')]),
        newBook: book([entry(10, 'Alice', 'new'), entry(11, 'Bob', 'new'), entry(12, 'Alice', 'different', { key: ['Alice extra'] }), entry(13, 'New', 'fresh')]),
        oldName: 'target', newName: 'mother', sourceKind: 'book', pairs: [], changeCache: new Map(), incomingCache: null,
        newSelection: new Map(), forcedNew: new Set(), pairChecks: new Map(), unpairedOld: new Set(), unpairedNew: new Set(),
        copySelection: new Set(), settingsSelection: new Set(), pickMode: 'operation', selectedOld: null, selectedNew: null,
        previewOpen: false, mode: 'content', fusion: false, scopeNames: [], scopeWorks: [], pinMatches: true, busy: false,
    });
    const nodes = {
        '[data-scope]': { value: '' }, '[data-mode]': { value: 'content' },
        '[data-search="new"]': { value: '' }, '[data-search="old"]': { value: '' },
        '[data-list="old"]': { scrollTop: 0 }, '[data-list="new"]': { scrollTop: 0 },
        '[data-set-scope]': { value: 'current', selectedOptions: [{ textContent: '测试范围' }] },
    };
    ui.find = selector => { assert.ok(nodes[selector], `unknown selector ${selector}`); return nodes[selector]; };
    ui.render = () => {};
    ui.message = message => { ui.lastMessage = message; };
    ui.service = { writes: [], requiresReload: false, async updateDirect(name, expected, next) { this.writes.push({ name, expected, next: structuredClone(next) }); return { data: structuredClone(next), note: '' }; } };
    ui.repair();
    return { ui, nodes };
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
        assert.match(calls[0], /更新/);
    });
    await withConfirm(true, async () => {
        await ui.apply();
        assert.equal(ui.oldBook.entries['1'].content, 'new');
        assert.equal(ui.service.writes.length, 1);
    });
});

test('saving changed pairs retains checked state of unchanged pairs', async () => {
    const { ui } = setup();
    ui.newBook.entries['13'] = entry(13, 'Other', 'old'); ui.repair();
    const unchanged = ui.pairs.find(pair => pair.newId === '13');
    assert.equal(unchanged.checked, true);
    assert.equal(ui.changed(unchanged), false);
    await withConfirm(true, async () => {
        await ui.apply();
        assert.equal(ui.pairs.find(pair => pair.newId === '13').checked, true);
        assert.equal(ui.pairs.find(pair => pair.newId === '10').checked, false);
    });
});

test('scope fusion replaces matched and approves unmatched review without affecting out-of-scope selections', async () => {
    const { ui, nodes } = setup();
    nodes['[data-scope]'].value = 'Alice';
    ui.applyScope();
    assert.equal(ui.fusion, true);
    assert.equal(nodes['[data-mode]'].value, 'merge-content');
    assert.ok(ui.selectedAdditions().includes('12'));
    const bob = ui.pairs.find(pair => pair.newId === '11');
    assert.equal(bob.checked, true);
    assert.equal(ui.selectedPairs().some(pair => pair.newId === '11'), false);
    await withConfirm(true, async calls => {
        await ui.apply();
        assert.equal(ui.oldBook.entries['1'].content, 'old');
        assert.equal(ui.oldBook.entries['0'].content, 'new');
        assert.ok(Object.values(ui.oldBook.entries).some(item => item.content === 'different'));
        assert.equal(ui.pairs.find(pair => pair.newId === '11').checked, true);
        assert.match(calls[0], /待核对/);
    });
});

test('rematching and changing scope preserve manual pairing, unpairing and explicit unchecked choices', () => {
    const { ui, nodes } = setup();
    const bob = ui.pairs.find(pair => pair.newId === '11');
    bob.checked = false; ui.pairChecks.set('11', false);
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

test('explicit addition choice survives matching changes and remains review-approved', async () => {
    const { ui } = setup();
    ui.fusion = true; ui.newSelection.set('13', true);
    ui.newBook.entries['13'].comment = 'Other'; ui.newBook.entries['13'].key = ['Other'];
    ui.repair();
    assert.equal(ui.pairs.some(pair => pair.newId === '13'), false);
    assert.ok(ui.selectedAdditions().includes('13'));
    await withConfirm(true, async calls => {
        await ui.apply();
        assert.equal(ui.oldBook.entries['2'].content, 'old');
        assert.ok(Object.values(ui.oldBook.entries).some(item => item.content === 'fresh'));
        assert.match(calls[0], /待核对/);
    });
});

test('manual copy bulk select only adds visible rows and clear removes hidden rows too', () => {
    const { ui, nodes } = setup();
    ui.pickMode = 'copy'; ui.copySelection.add('10');
    nodes['[data-search="new"]'].value = 'Bob';
    ui.setSelection('all');
    assert.deepEqual([...ui.copySelection].sort(), ['10', '11']);
    ui.setSelection('none');
    assert.equal(ui.copySelection.size, 0);
});

test('manual copy only uses visibly hand-selected IDs, overrides pairs, and leaves hidden selection intact', async () => {
    const { ui, nodes } = setup();
    ui.pickMode = 'copy'; ui.copySelection.add('11'); ui.copySelection.add('13');
    nodes['[data-search="new"]'].value = 'Bob';
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
        assert.deepEqual([...ui.copySelection], ['13']);
        assert.equal(ui.pairs.filter(pair => pair.newId === '11').length, 1);
        assert.equal(ui.pairs.find(pair => pair.newId === '11').reason, '本次新增');
        ui.repair();
        assert.equal(ui.pairs.filter(pair => pair.newId === '11').length, 1);
    });
});

test('manual copy accepts unmatched review and repeated identical source after explicit confirmation', async () => {
    const { ui } = setup();
    ui.copySelection.add('12');
    await withConfirm(true, async () => {
        await ui.copySelected();
        const count = Object.keys(ui.oldBook.entries).length;
        ui.copySelection.add('12');
        await ui.copySelected();
        assert.equal(Object.keys(ui.oldBook.entries).length, count + 1);
        assert.equal(ui.pairs.filter(pair => pair.newId === '12').length, 1);
    });
});

test('copy failure preserves original books, pairs and explicit selections', async () => {
    const { ui } = setup();
    ui.copySelection.add('11');
    const pairs = structuredClone(ui.pairs), target = structuredClone(ui.oldBook);
    ui.service.updateDirect = async () => { throw new Error('write failed'); };
    await withConfirm(true, async () => {
        await assert.rejects(ui.copySelected(), /write failed/);
        assert.deepEqual(ui.oldBook, target);
        assert.deepEqual(ui.pairs, pairs);
        assert.deepEqual([...ui.copySelection], ['11']);
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
    nodes['[data-set-scope]'].value = 'checked'; ui.settingsSelection.add('11'); ui.settingsSelection.add('13');
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
    nodes['[data-set-scope]'].value = 'checked'; ui.settingsSelection.add('11');
    ui.collectSettingsPatch = () => ({ depth: { mode: 'set', value: 0 } });
    await withConfirm(true, async () => {
        await ui.syncSettingsToTarget();
        assert.equal(ui.oldBook.entries['1'].depth, 8);
        assert.equal(ui.oldBook.originalData.entries.find(item => item.id === 1).extensions.depth, 8);
        assert.equal(ui.oldBook.entries['0'].depth, undefined);
    });
});

class FakeNode {
    constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.dataset = {}; this.scrollTop = 0; this.attributes = {}; this.classList = { toggle() {}, contains() { return false; } }; }
    append(...nodes) { this.children.push(...nodes); }
    setAttribute(key, value) { this.attributes[key] = value; }
    replaceChildren(fragment) { this.children = fragment.children; }
    contains() { return false; }
    querySelector() { return null; }
}

test('independent area heights use the opened window as a 50-fold limit', async () => {
    const ui = Object.create(UpdaterWindow.prototype);
    const nodes = {};
    for (const [area, initial] of [['list', 500], ['preview', 240]]) {
        const panel = { style: { height: `${initial}px` } };
        panel.getBoundingClientRect = () => ({ height: Number.parseFloat(panel.style.height) });
        nodes[`[data-resize-panel="${area}"]`] = panel;
        nodes[`[data-resize="${area}"]`] = new FakeNode('div');
        nodes[`[data-resize-input="${area}"]`] = {};
    }
    ui.find = selector => nodes[selector];
    Object.assign(ui, { books: [{}], previewOpen: true, resizeLimit: null, disposed: false });
    ui.dialog = { open: false, style: { removeProperty() {} }, showModal() { this.open = true; }, getBoundingClientRect: () => ({ height: 700 }) };
    const previousDocument = globalThis.document;
    globalThis.document = { activeElement: null };
    try {
        await ui.open();
        assert.equal(ui.resizeLimit, 35000);
        ui.setAreaHeight('list', 1400);
        assert.equal(nodes['[data-resize-panel="list"]'].style.height, '1400px');
        assert.equal(nodes['[data-resize-panel="preview"]'].style.height, '240px');
        ui.setAreaHeight('preview', 50000);
        assert.equal(nodes['[data-resize-panel="preview"]'].style.height, '35000px');
        assert.equal(nodes['[data-resize-panel="list"]'].style.height, '1400px');
        assert.equal(nodes['[data-resize="preview"]'].attributes['aria-valuemax'], '35000');
        assert.equal(nodes['[data-resize-input="preview"]'].value, '35000');
        ui.setAreaHeight('list', -1); ui.setAreaHeight('preview', 1);
        assert.equal(nodes['[data-resize-input="list"]'].value, '200');
        assert.equal(nodes['[data-resize-input="preview"]'].value, '120');
    } finally { if (previousDocument === undefined) delete globalThis.document; else globalThis.document = previousDocument; }
});

test('resize handles process touch, keyboard and numeric input independently', () => {
    const ui = Object.create(UpdaterWindow.prototype);
    const nodes = {}, callbacks = new Map();
    const frameCallbacks = new Map(), cancelledFrames = [];
    let nextFrame = 1;
    const oldRaf = globalThis.requestAnimationFrame, oldCancel = globalThis.cancelAnimationFrame, oldHeight = globalThis.innerHeight;
    globalThis.requestAnimationFrame = fn => { const id = nextFrame++; frameCallbacks.set(id, fn); return id; };
    globalThis.cancelAnimationFrame = id => { cancelledFrames.push(id); frameCallbacks.delete(id); };
    globalThis.innerHeight = 800;
    try {
        for (const [area, initial] of [['list', 500], ['preview', 240]]) {
            const panel = { style: { height: `${initial}px` } };
            panel.getBoundingClientRect = () => ({ height: Number.parseFloat(panel.style.height) });
            const handle = new FakeNode('div');
            handle.setPointerCapture = id => { handle.captured = id; };
            handle.hasPointerCapture = id => handle.captured === id;
            handle.releasePointerCapture = () => { handle.captured = null; };
            nodes[`[data-resize-panel="${area}"]`] = panel;
            nodes[`[data-resize="${area}"]`] = handle;
            nodes[`[data-resize-input="${area}"]`] = {};
        }
        nodes['.stwu-layout'] = { scrollTop: 0, getBoundingClientRect: () => ({ top: 0, bottom: 800 }) };
        ui.find = selector => nodes[selector];
        ui.on = (node, type, handler) => { if (!callbacks.has(node)) callbacks.set(node, {}); callbacks.get(node)[type] = handler; };
        ui.resizeLimit = 35000; ui.resizeDrag = null;
        ui.bindAreaResizer('list'); ui.bindAreaResizer('preview');
        const list = nodes['[data-resize="list"]'], preview = nodes['[data-resize="preview"]'];
        const event = props => ({ preventDefault() { this.prevented = true; }, ...props });
        callbacks.get(list).pointerdown(event({ pointerType: 'touch', pointerId: 1, clientY: 400 }));
        callbacks.get(list).pointermove(event({ pointerId: 1, clientY: 450 }));
        assert.equal(nodes['[data-resize-panel="list"]'].style.height, '550px');
        assert.equal(nodes['[data-resize-panel="preview"]'].style.height, '240px');
        callbacks.get(list).pointerup(event({ pointerId: 1 }));
        assert.equal(ui.resizeDrag, null); assert.equal(list.captured, null); assert.equal(cancelledFrames.length, 1);
        const key = event({ key: 'ArrowDown' }); callbacks.get(preview).keydown(key);
        assert.equal(key.prevented, true); assert.equal(nodes['[data-resize-panel="preview"]'].style.height, '260px');
        assert.equal(nodes['[data-resize-panel="list"]'].style.height, '550px');
        const input = nodes['[data-resize-input="preview"]'];
        input.value = '999999'; callbacks.get(input).change();
        assert.equal(nodes['[data-resize-panel="preview"]'].style.height, '35000px');
        input.value = ''; callbacks.get(input).change(); assert.equal(input.value, '35000');
        callbacks.get(list).pointerdown(event({ pointerType: 'touch', pointerId: 2, clientY: 790 }));
        const frame = ui.resizeDrag.frame; frameCallbacks.get(frame)();
        assert.ok(nodes['.stwu-layout'].scrollTop > 0);
        assert.ok(Number.parseFloat(nodes['[data-resize-panel="list"]'].style.height) > 550);
        callbacks.get(list).pointercancel(event({ pointerId: 2 })); assert.equal(ui.resizeDrag, null);
    } finally {
        if (oldRaf === undefined) delete globalThis.requestAnimationFrame; else globalThis.requestAnimationFrame = oldRaf;
        if (oldCancel === undefined) delete globalThis.cancelAnimationFrame; else globalThis.cancelAnimationFrame = oldCancel;
        if (oldHeight === undefined) delete globalThis.innerHeight; else globalThis.innerHeight = oldHeight;
    }
});

test('renderList pins scope matches and blocks out-of-scope pairs on both sides', () => {
    const { ui, nodes } = setup();
    const previousDocument = globalThis.document;
    const lists = { old: new FakeNode('ul'), new: new FakeNode('ul') };
    const counts = { old: {}, new: {} };
    globalThis.document = { activeElement: null, createElement: tag => new FakeNode(tag), createDocumentFragment: () => new FakeNode('fragment') };
    const originalFind = ui.find;
    ui.find = selector => {
        for (const side of ['old', 'new']) {
            if (selector === `[data-list="${side}"]`) return lists[side];
            if (selector === `[data-side="${side}"] .stwu-count`) return counts[side];
        }
        return originalFind(selector);
    };
    try {
        ui.scopeNames = ['Alice']; ui.fusion = true;
        ui.renderList('new'); ui.renderList('old');
        assert.equal(lists.new.children[0].dataset.id, '10');
        const bobNew = lists.new.children.find(row => row.dataset.id === '11');
        const bobOld = lists.old.children.find(row => row.dataset.id === '1');
        assert.equal(bobNew.children[0].children[0].disabled, true);
        assert.equal(bobOld.children[0].children[0].disabled, true);
        ui.pickMode = 'copy'; ui.renderList('new');
        const copyBob = lists.new.children.find(row => row.dataset.id === '11').children[0].children[0];
        assert.equal(copyBob.disabled, false); assert.equal(copyBob.checked, false);
    } finally { if (previousDocument === undefined) delete globalThis.document; else globalThis.document = previousDocument; }
});
