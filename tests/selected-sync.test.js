import test from 'node:test';
import assert from 'node:assert/strict';
import { autoMatch, buildSelectedSync, canonical, classifyIncoming } from '../core.js';

const entry = (uid, comment, key, content, extra = {}) => ({ uid, comment, key, content, ...extra });
const book = (...entries) => ({ entries: Object.fromEntries(entries.map(item => [String(item.uid), item])), extra: '保留' });

test('批量同步同时替换、复制和手动选择目标，保持两本原书不变', () => {
    const target = book(entry(1, '安比', ['安比'], '旧安比', { order: 77 }), entry(2, '某作品：露娜', ['露娜'], '旧露娜'));
    const mother = book(entry(11, '安比', ['安比'], '新安比'), entry(12, '小安比', ['小安比'], '小安比'), entry(13, '露娜', ['露娜'], '新露娜'));
    const before = canonical(target), source = canonical(mother);
    assert.equal(autoMatch(target, mother).find(pair => pair.newId === '11').oldId, '1');
    const plan = buildSelectedSync(target, mother, [
        { newId: '11', action: 'replace', oldId: '1' },
        { newId: '12', action: 'copy' },
        { newId: '13', action: 'replace', oldId: '2' },
    ]);
    assert.equal(plan.result.updated, 2); assert.equal(plan.result.added, 1);
    assert.equal(plan.result.data.entries['1'].content, '新安比');
    assert.equal(plan.result.data.entries['1'].order, 77);
    assert.equal(plan.result.data.entries['2'].content, '新露娜');
    assert.ok(Object.values(plan.result.data.entries).some(item => item.comment === '小安比'));
    assert.equal(canonical(target), before); assert.equal(canonical(mother), source);
});

test('待核对和已有配对可由用户明确指定为新条目或任意替换目标', () => {
    const target = book(entry(1, '安比', ['安比'], '旧'), entry(2, '安比', ['其他'], '另一位'));
    const mother = book(entry(10, '安比', ['不同'], '新'));
    assert.equal(classifyIncoming(target, mother).get('10'), 'review');
    const pending = buildSelectedSync(target, mother, [{ newId: '10', action: 'pending' }]);
    assert.equal(pending.result, null); assert.deepEqual(pending.pending, ['10']);
    const copy = buildSelectedSync(target, mother, [{ newId: '10', action: 'copy' }]);
    assert.equal(copy.result.added, 1); assert.equal(copy.result.data.entries['1'].content, '旧');
    const replace = buildSelectedSync(target, mother, [{ newId: '10', action: 'replace', oldId: '2' }]);
    assert.equal(replace.result.data.entries['2'].content, '新');
    assert.equal(replace.result.data.entries['1'].content, '旧');
});

test('相同内容默认去重，也可以明确创建相同副本', () => {
    const target = book(entry(1, '安比', ['安比'], '相同'));
    const mother = book(entry(10, '安比', ['安比'], '相同'));
    const normal = buildSelectedSync(target, mother, [{ newId: '10', action: 'copy' }]);
    assert.equal(normal.result.added, 0); assert.equal(normal.result.skipped, 1);
    const explicit = buildSelectedSync(target, mother, [{ newId: '10', action: 'copy-again' }]);
    assert.equal(explicit.result.added, 1); assert.equal(Object.keys(explicit.result.data.entries).length, 2);
});

test('多个母本不允许意外覆盖同一个目标，缺失目标或重复来源也会停止', () => {
    const target = book(entry(1, '甲', ['甲'], '旧'));
    const mother = book(entry(10, '甲', ['甲'], '新'), entry(11, '乙', ['乙'], '新'));
    assert.throws(() => buildSelectedSync(target, mother, [{ newId: '10', action: 'replace', oldId: '1' }, { newId: '11', action: 'replace', oldId: '1' }]), /同一个替换目标/);
    assert.throws(() => buildSelectedSync(target, mother, [{ newId: '10', action: 'replace', oldId: '99' }]), /存在的目标/);
    assert.throws(() => buildSelectedSync(target, mother, [{ newId: '10', action: 'copy' }, { newId: '10', action: 'copy' }]), /重复/);
});

test('千条批量同步更新已有条目并追加新条目，重复同步不重复新增', () => {
    const target = book(...Array.from({ length: 500 }, (_, i) => entry(i, `角色${i}`, [`角色${i}`], '旧')));
    const mother = book(...Array.from({ length: 1000 }, (_, i) => entry(i + 1000, `角色${i}`, [`角色${i}`], '新')));
    const decisions = Array.from({ length: 1000 }, (_, i) => i < 500
        ? { newId: String(i + 1000), action: 'replace', oldId: String(i) }
        : { newId: String(i + 1000), action: 'copy' });
    const first = buildSelectedSync(target, mother, decisions);
    assert.equal(first.result.updated, 500); assert.equal(first.result.added, 500);
    const nextPairs = new Map(first.result.addedPairs.map(pair => [pair.newId, pair.oldId]));
    const repeat = buildSelectedSync(first.result.data, mother, decisions.map(item => ({ ...item,
        action: 'replace', oldId: item.oldId ?? nextPairs.get(item.newId),
    })));
    assert.equal(repeat.result.updated + repeat.result.added, 0);
    assert.equal(Object.keys(repeat.result.data.entries).length, 1000);
});
