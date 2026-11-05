import test from 'node:test';
import assert from 'node:assert/strict';
import { autoMatch, buildUpdate, canonical, classifyIncoming, clone } from '../core.js';

const e = (uid, comment, key, content = '正文', extra = {}) => ({ uid, comment, key, content, ...extra });
const book = (...entries) => ({ entries: Object.fromEntries(entries.map(entry => [String(entry.uid), entry])) });

test('融合同时更新配对和追加独有条目，保留旧书独有条目与元数据', () => {
    const old = book(e(0, '更新', ['更新'], '旧'), e(4, '保留', ['保留'], '不改'));
    old.extensions = { keep: true };
    const source = book(e(9, '更新', ['更新'], '新'), e(0, '新增', ['新增'], '新增正文', { order: 25, disable: true }));
    const oldSnapshot = canonical(old), sourceSnapshot = canonical(source);
    const result = buildUpdate(old, source, autoMatch(old, source), 'content', { merge: true, additions: ['0'] });
    assert.equal(result.updated, 1); assert.equal(result.added, 1);
    assert.equal(result.data.entries[0].content, '新'); assert.equal(result.data.entries[4].content, '不改');
    assert.equal(result.data.entries[1].comment, '新增'); assert.equal(result.data.entries[1].uid, 1);
    assert.equal(result.data.entries[1].order, 25); assert.equal(result.data.entries[1].disable, true);
    assert.deepEqual(result.data.extensions, { keep: true });
    assert.equal(canonical(old), oldSnapshot); assert.equal(canonical(source), sourceSnapshot);
});

test('只选新增时不更新配对；选择的新增子集准确执行', () => {
    const old = book(e(0, 'A', ['a'], '旧'));
    const source = book(e(8, 'A', ['a'], '新'), e(9, 'B', ['b']), e(10, 'C', ['c']));
    const pairs = autoMatch(old, source).map(p => ({ ...p, checked: false }));
    const result = buildUpdate(old, source, pairs, 'content', { merge: true, additions: ['10'] });
    assert.equal(result.updated, 0); assert.equal(result.added, 1);
    assert.equal(result.data.entries[0].content, '旧'); assert.equal(result.data.entries[1].comment, 'C');
    assert.equal(Object.values(result.data.entries).some(entry => entry.comment === 'B'), false);
});

test('普通更新模式拒绝隐式新增；全部取消时完全不改变原书', () => {
    const old = book(e(0, 'A', ['a'])), source = book(e(8, 'B', ['b']));
    assert.throws(() => buildUpdate(old, source, [], 'content', { additions: ['8'] }), /融合模式/);
    const result = buildUpdate(old, source, [], 'content', { merge: true, additions: [] });
    assert.deepEqual(result.data, old); assert.equal(result.added, 0);
});

test('共享或部分重叠关键词、重名和无身份信息均留待处理', () => {
    const old = book(e(0, 'A', ['共同', 'a']));
    const source = book(e(8, '新名称', ['共同']), e(9, 'A', ['不同']), e(10, '', []), e(11, '独立', ['独立']));
    const states = classifyIncoming(old, source, []);
    assert.equal(states.get('8'), 'review'); assert.equal(states.get('9'), 'review');
    assert.equal(states.get('10'), 'review'); assert.equal(states.get('11'), 'new');
});

test('待处理条目须明确标记新增，不能被普通全选偷偷追加', () => {
    const old = book(e(0, 'A', ['相同关键词'])), source = book(e(8, '新段落', ['相同关键词'], '不同内容'));
    assert.throws(() => buildUpdate(old, source, [], 'content', { merge: true, additions: ['8'] }), /待处理/);
    const result = buildUpdate(old, source, [], 'content', { merge: true, additions: ['8'], approvedNew: ['8'] });
    assert.equal(result.added, 1); assert.equal(result.data.entries[0].comment, 'A');
});

test('来源中的完全重复条目只提供一个新增候选', () => {
    const old = book(), source = book(e(8, 'A', ['a']), e(9, 'A', ['a']));
    const states = classifyIncoming(old, source);
    assert.equal(states.get('8'), 'new'); assert.equal(states.get('9'), 'duplicate');
    const result = buildUpdate(old, source, [], 'content', { merge: true, additions: ['8', '9'] });
    assert.equal(result.added, 1); assert.equal(result.skipped, 1);
});

test('来源同名同关键词但正文不同，不自动把冲突双方都当作新增', () => {
    const states = classifyIncoming(book(), book(e(8, 'A', ['a'], '内容一'), e(9, 'A', ['a'], '内容二')));
    assert.equal(states.get('8'), 'review'); assert.equal(states.get('9'), 'review');
});

test('相同已有条目不受 uid 和列表位置影响，不重复追加', () => {
    const old = book(e(0, '', [], '一样', { displayIndex: 4 }));
    const source = book(e(8, '', [], '一样', { displayIndex: 80 }));
    assert.equal(classifyIncoming(old, source).get('8'), 'duplicate');
    const result = buildUpdate(old, source, [], 'full', { merge: true, additions: ['8'] });
    assert.equal(result.added, 0); assert.equal(result.skipped, 1); assert.deepEqual(result.data, old);
});

test('空原书可融合；新条目完整保留未知字段并得到原生编号', () => {
    const source = book(e(90, '新', ['新'], '<script>只作为文本</script>', { custom: { x: [1, 2] }, extensions: { custom: true } }));
    const result = buildUpdate(book(), source, [], 'content', { merge: true, additions: ['90'] });
    assert.equal(result.data.entries[0].uid, 0); assert.equal(result.data.entries[0].displayIndex, 0);
    assert.deepEqual(result.data.entries[0].custom, { x: [1, 2] }); assert.equal(result.data.entries[0].extensions.custom, true);
});

test('融合后再次读取相同来源，在两档替换范围都不会重复新增或移动条目', () => {
    const old = book(e(0, '保留', ['保留'], '不变', { displayIndex: 7 }));
    const source = book(e(9, '新增', ['新增'], '新', { displayIndex: 0, order: 60 }));
    const first = buildUpdate(old, source, [], 'full', { merge: true, additions: ['9'] });
    assert.equal(first.data.entries[1].displayIndex, 8);
    for (const mode of ['content', 'full']) {
        const pairs = autoMatch(first.data, source);
        const again = buildUpdate(first.data, source, pairs, mode, { merge: true });
        assert.equal(again.added, 0); assert.equal(again.updated, 0); assert.deepEqual(again.data, first.data);
    }
});

test('完整更新保留原书列表位置，同时更新真正的插入顺序设置', () => {
    const old = book(e(0, 'A', ['a'], '旧', { displayIndex: 6, order: 100 }));
    const source = book(e(8, 'A', ['a'], '新', { displayIndex: 0, order: 200 }));
    const result = buildUpdate(old, source, autoMatch(old, source), 'full');
    assert.equal(result.data.entries[0].displayIndex, 6); assert.equal(result.data.entries[0].order, 200);
});

test('新增同步角色书导出数据，重分配 id/uid 并保留未知导出字段', () => {
    const old = book(e(0, '旧', ['旧'])); old.originalData = { name: '原导出名称', entries: [{ id: 0, content: '正文' }] };
    const source = book(e(9, '新', ['新'], '新正文', { depth: 6, position: 4, displayIndex: 50, disable: true }));
    source.originalData = { entries: [{ id: 9, uid: 9, content: '过期正文', private: '保留', extensions: { custom: true } }] };
    const result = buildUpdate(old, source, [], 'content', { merge: true, additions: ['9'] });
    const native = result.data.entries[1], portable = result.data.originalData.entries[1];
    assert.equal(portable.id, 1); assert.equal(portable.uid, 1); assert.equal(portable.content, '新正文');
    assert.equal(portable.extensions.depth, 6); assert.equal(portable.extensions.display_index, native.displayIndex);
    assert.equal(portable.enabled, false); assert.equal(portable.private, '保留'); assert.equal(portable.extensions.custom, true);
    assert.equal(result.data.originalData.name, '原导出名称');
});

test('配对与新增互斥，重复选择、失效编号和非法范围均拒绝', () => {
    const old = book(e(0, 'A', ['a'])), source = book(e(8, 'A', ['a']), e(9, 'B', ['b']));
    assert.throws(() => buildUpdate(old, source, autoMatch(old, source), 'full', { merge: true, additions: ['8'] }), /同时作为新条目/);
    assert.throws(() => buildUpdate(old, source, [], 'full', { merge: true, additions: ['9', '9'] }), /重复选择/);
    assert.throws(() => buildUpdate(old, source, [], 'full', { merge: true, additions: ['999'] }), /不存在/);
    assert.throws(() => buildUpdate(old, source, [], 'other', { merge: true }), /替换范围/);
});

test('融合容量超限时拒绝，输入原书保持原样', () => {
    const old = book(...Array.from({ length: 10000 }, (_, i) => e(i, '条目' + i, ['词' + i])));
    const source = book(e(20000, '新增', ['新增']));
    assert.throws(() => buildUpdate(old, source, [], 'content', { merge: true, additions: ['20000'] }), /超过 10000/);
    assert.equal(Object.keys(old.entries).length, 10000);
});
