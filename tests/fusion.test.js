import test from 'node:test';
import assert from 'node:assert/strict';
import { autoMatch, buildRosterUpdate, buildUpdate, canonical, classifyIncoming, clone, scopeMatch } from '../core.js';

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

test('共享普通关键词各自独立，重名、目标主关键词明确写有全名和缺身份信息仍待核对', () => {
    const old = book(e(0, 'A', ['共同', 'a']), e(1, '另外的名称', ['已知全名']));
    const source = book(e(8, '新名称', ['共同']), e(9, 'A', ['不同']), e(10, '', []), e(11, '独立', ['独立']), e(12, '已知全名', []));
    const targets = new Set(), reasons = new Map();
    const states = classifyIncoming(old, source, [], targets, reasons);
    assert.equal(states.get('8'), 'new'); assert.equal(states.get('9'), 'review');
    assert.equal(states.get('10'), 'review'); assert.equal(states.get('11'), 'new');
    assert.equal(states.get('12'), 'review');
    assert.deepEqual(targets, new Set(['0', '1']));
    assert.match(reasons.get('10'), /母本缺少/);
    assert.match(reasons.get('12'), /另外的名称/);
});

test('不同标题只重合一个字时，不自动配对，也不进入待核对', () => {
    for (const [sourceTitle, targetTitle] of [['爱情', '爱好'], ['爱情（爱）', '爱好（爱）'], ['爱·长情', '爱好（爱）']]) {
        const source = book(e(8, sourceTitle, ['爱'], '一样的正文'));
        const target = book(e(0, targetTitle, ['爱'], '一样的正文'));
        const reviewTargets = new Set();
        assert.deepEqual(autoMatch(target, source), []);
        assert.equal(classifyIncoming(target, source, [], reviewTargets).get('8'), 'new');
        assert.equal(reviewTargets.size, 0);
        assert.equal(scopeMatch(target.entries[0], [sourceTitle]), '');
        const plan = buildRosterUpdate(target, source, [[sourceTitle]], 'content');
        assert.deepEqual(plan.review, []);
        assert.equal(plan.result.updated, 0);
        assert.equal(plan.result.added, 1);
    }
});

test('目标书无对应标题时，通用词甚至整组主关键词相同也不制造候选', () => {
    const keywords = ['角色', '五星角色', '剧情'];
    const target = book(e(0, '其他角色', keywords), e(1, '剧情', ['故事']));
    const mother = book(e(8, '刻律德菈', keywords), e(9, '凯撒·金 (Caesar King)', keywords));
    const reviewTargets = new Set(), reasons = new Map();
    assert.deepEqual([...classifyIncoming(target, mother, [], reviewTargets, reasons)], [['8', 'new'], ['9', 'new']]);
    assert.equal(reviewTargets.size + reasons.size, 0);
    const plan = buildRosterUpdate(target, mother, [['刻律德菈'], ['凯撒·金']], 'content');
    assert.deepEqual(plan.review, []);
    assert.equal(plan.result.updated, 0);
    assert.equal(plan.result.added, 2);
});

test('待处理条目须明确标记新增，不能被普通全选偷偷追加', () => {
    const old = book(e(0, 'A', ['新段落'])), source = book(e(8, '新段落', ['相同关键词'], '不同内容'));
    assert.throws(() => buildUpdate(old, source, [], 'content', { merge: true, additions: ['8'] }), /待处理/);
    const result = buildUpdate(old, source, [], 'content', { merge: true, additions: ['8'], approvedNew: ['8'] });
    assert.equal(result.added, 1); assert.equal(result.data.entries[0].comment, 'A');
});

test('来源中相同身份均待处理，批准后普通追加仍去重', () => {
    const old = book(), source = book(e(8, 'A', ['a']), e(9, 'A', ['a']));
    const states = classifyIncoming(old, source);
    assert.equal(states.get('8'), 'review'); assert.equal(states.get('9'), 'review');
    const result = buildUpdate(old, source, [], 'content', { merge: true, additions: ['8', '9'], approvedNew: ['8', '9'] });
    assert.equal(result.added, 1); assert.equal(result.skipped, 1);
});

test('来源同名同关键词但正文不同，不自动把冲突双方都当作新增', () => {
    const states = classifyIncoming(book(), book(e(8, 'A', ['a'], '内容一'), e(9, 'A', ['a'], '内容二')));
    assert.equal(states.get('8'), 'review'); assert.equal(states.get('9'), 'review');
});

test('相同已有条目不受 uid 和列表位置影响，不重复追加', () => {
    const old = book(e(0, '', [], '一样', { displayIndex: 4 }));
    const source = book(e(8, '', [], '一样', { displayIndex: 80 }));
    assert.equal(classifyIncoming(old, source).get('8'), 'review');
    const result = buildUpdate(old, source, [], 'full', { merge: true, additions: ['8'], approvedNew: ['8'] });
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

test('分类只依据标题与主要关键词，正文与次要关键词的变化不改变结果', () => {
    const old = book(e(0, '旧', ['甲'], '原文', { keysecondary: ['乙'] }));
    const source = book(e(8, '新', ['乙'], '原文', { keysecondary: ['甲'] }), e(9, '旧', ['丙'], '相同', { keysecondary: [] }));
    const initial = classifyIncoming(old, source);
    assert.deepEqual([...initial], [['8', 'new'], ['9', 'review']]);
    source.entries[8].content = '完全不同'; source.entries[8].keysecondary = [];
    source.entries[9].content = '其他正文'; source.entries[9].keysecondary = ['乙'];
    assert.deepEqual([...classifyIncoming(old, source)], [...initial]);
});

test('显式强制复制支持批量复制已配对、待处理和完全相同条目', () => {
    const old = book(e(0, 'A', ['a'], '相同'), e(3, 'B', ['b'], '旧'));
    old.originalData = { entries: [{ id: 0, content: '相同' }, { id: 1, content: '保留的镜像条目' }, { id: 3, content: '旧' }] };
    const source = book(e(8, 'A', ['a'], '相同'), e(9, 'B', ['b'], '新'), e(10, '', [], '无身份'));
    const pairs = autoMatch(old, source).map(pair => ({ ...pair, checked: false }));
    const opts = { merge: true, additions: ['8', '9', '10'], forceAdditions: ['8', '9', '10'] };
    const result = buildUpdate(old, source, pairs, 'content', opts);
    assert.equal(result.updated, 0); assert.equal(result.added, 3);
    assert.deepEqual(result.addedPairs.map(pair => pair.oldId), ['2', '4', '5']);
    assert.deepEqual(result.addedPairs.map(pair => result.data.entries[pair.oldId].uid), [2, 4, 5]);
    assert.equal(result.data.entries[0].content, '相同'); assert.equal(result.data.entries[3].content, '旧');
    assert.equal(buildUpdate(result.data, source, pairs, 'content', opts).added, 3);
});

test('强制复制必须明确列入新增且不能同时更新同一来源', () => {
    const old = book(e(0, 'A', ['a'], '旧')), source = book(e(8, 'A', ['a'], '新'));
    const pairs = autoMatch(old, source);
    assert.throws(() => buildUpdate(old, source, pairs, 'content', { merge: true, additions: ['8'], forceAdditions: ['8'] }), /同时更新和强制复制/);
    assert.throws(() => buildUpdate(old, source, [], 'content', { merge: true, additions: [], forceAdditions: ['8'] }), /必须同时列入/);
    assert.throws(() => buildUpdate(old, source, [], 'content', { forceAdditions: ['8'] }), /融合模式/);
});

test('显式批准的不同正文同身份条目可以批量新增，重复普通追加不重复', () => {
    const source = book(e(8, 'A', ['a'], '甲'), e(9, 'A', ['a'], '乙'));
    const options = { merge: true, additions: ['8', '9'], approvedNew: ['8', '9'] };
    const first = buildUpdate(book(), source, [], 'content', options);
    assert.equal(first.added, 2);
    const again = buildUpdate(first.data, source, [], 'content', options);
    assert.equal(again.added, 0); assert.equal(again.skipped, 2);
});

test('融合容量超限时拒绝，输入原书保持原样', () => {
    const old = book(...Array.from({ length: 10000 }, (_, i) => e(i, '条目' + i, ['词' + i])));
    const source = book(e(20000, '新增', ['新增']));
    assert.throws(() => buildUpdate(old, source, [], 'content', { merge: true, additions: ['20000'] }), /超过 10000/);
    assert.equal(Object.keys(old.entries).length, 10000);
});
