import test from 'node:test';
import assert from 'node:assert/strict';
import { autoMatch, buildUpdate, canonical, clone, pairManually, parseBook, replacement, validateBook } from '../core.js';

const e = (uid, comment, key, content = '旧正文', extra = {}) => ({ uid, comment, key, content, ...extra });
const book = (...entries) => ({ entries: Object.fromEntries(entries.map(x => [String(x.uid), x])) });

test('不同编号仍可用标题和无序完整关键词一对一配对', () => {
    const a = book(e(0, '人物', ['A', 'B'])), b = book(e(900, '人物', ['B', 'A'], '新正文'));
    assert.deepEqual(autoMatch(a, b), [{ oldId: '0', newId: '900', checked: true, reason: '标题与关键词' }]);
});
test('标题与主关键词要相符，缺少标题时才单独使用完整主关键词', () => {
    const a = book(e(0, '名称', ['A', 'B']));
    assert.equal(autoMatch(a, book(e(5, '名称', ['C']))).length, 0);
    assert.equal(autoMatch(a, book(e(5, '名称', ['B', 'C']))).length, 1);
    assert.equal(autoMatch(a, book(e(5, '另一个名称', ['A', 'B']))).length, 0);
    assert.equal(autoMatch(a, book(e(5, '', ['A', 'B']))).length, 1);
    assert.equal(autoMatch(a, book(e(5, '另一个名称', ['A']))).length, 0);
});
test('整本配对可识别尼可的唯一简称，重名或仅部分主关键词重叠时保持待核对', () => {
    const mother = book(e(10, '尼可·莱恩', ['尼可·莱恩', '魔女「N」', '喧寂于心']));
    const nico = e(1, '尼可', ['尼可·莱恩', '魔女N', '尼可']);
    const target = book(nico);
    assert.deepEqual(autoMatch(target, mother), [{ oldId: '1', newId: '10', checked: true, reason: '名称与主关键词一致' }]);
    assert.deepEqual(autoMatch(book(nico, e(2, '尼可', ['另一个关键词'])), mother), []);
    assert.deepEqual(autoMatch(target, book(mother.entries['10'], e(11, '尼可·另一人', ['其他']))), []);
    assert.deepEqual(autoMatch(book(e(1, '尼可', ['尼可·另一人'])), mother), []);
    assert.deepEqual(autoMatch(book(e(2, '另一位魔女', ['魔女「N」', '另一别名'])), mother), []);
});
test('整本配对单字简称依靠独立主关键词，关键词冲突或打平时留待核对', () => {
    const mother = book(e(9, '琴·古恩希尔德', ['琴', '蒲公英骑士'], '相同正文', { keysecondary: ['只在次要关键词'] }));
    const unrelated = e(1, '琴', ['琴', '只在次要关键词'], '相同正文');
    const nico = e(2, '琴', ['琴', '蒲公英骑士']);
    assert.deepEqual(autoMatch(book(unrelated), mother), []);
    assert.deepEqual(autoMatch(book(e(2, '琴', [])), book(e(10, '琴', []))), []);
    assert.deepEqual(autoMatch(book(e(2, '琴', ['琴'])), book(e(10, '琴', ['琴']))), []);
    assert.deepEqual(autoMatch(book(e(2, '琴', ['原神·琴'])), book(e(10, '琴', ['原神·琴']))), []);
    assert.deepEqual(autoMatch(book(unrelated, nico), mother).map(pair => pair.oldId), ['2']);
    assert.deepEqual(autoMatch(book(nico, e(3, '琴', ['蒲公英骑士'])), mother), []);
});
test('空标题、空关键词和碰巧相同 uid 不建立配对', () => {
    assert.equal(autoMatch(book(e(0, '', [])), book(e(0, '', []))).length, 0);
});
test('共用关键词可由明确标题区分', () => {
    const a = book(e(0, '外貌', ['角色']), e(1, '性格', ['角色']));
    const b = book(e(7, '外貌', ['角色']), e(8, '性格', ['角色']));
    assert.equal(autoMatch(a, b).length, 2);
});
test('缺少区分信息时，共用关键词、重复标题和多对一都留待处理', () => {
    const a = book(e(0, '相同', ['角色']), e(1, '相同', ['角色']));
    assert.equal(autoMatch(a, book(e(9, '相同', ['角色']))).length, 0);
    const single = book(e(0, '唯一', ['角色']));
    assert.equal(autoMatch(single, book(e(8, '唯一', ['角色']), e(9, '唯一', ['角色']))).length, 0);
});
test('标题与关键词指向不同条目时不猜测', () => {
    assert.equal(autoMatch(book(e(0, 'A', ['a']), e(1, 'B', ['b'])), book(e(7, 'A', ['b']))).length, 0);
});
test('正则只作为字面文本；不忽略大小写或移除正则标志', () => {
    assert.equal(autoMatch(book(e(0, '', ['/a,b/i'])), book(e(8, '', ['/a,b/i']))).length, 1);
    assert.equal(autoMatch(book(e(0, '', ['/a/i'])), book(e(8, '', ['/a/']))).length, 0);
    assert.equal(autoMatch(book(e(0, '', ['A'])), book(e(8, '', ['a']))).length, 0);
});
test('手动配对允许纠正歧义，拒绝抢占其他已有配对', () => {
    const p = pairManually([], '0', '8');
    assert.equal(p[0].reason, '手动配对');
    assert.throws(() => pairManually(p, '1', '8'), /解除/);
    assert.equal(pairManually(p, '0', '8').length, 1);
});
test('正文模式保留 uid、关键词、设置和未知字段，不改原对象', () => {
    const old = e(0, '旧标题', ['旧'], '旧', { order: 55, position: 4, custom: { x: 1 } });
    const source = e(9, '新标题', ['新'], '新', { order: 99 });
    const result = replacement(old, source);
    assert.deepEqual(result, { ...old, content: '新' });
    assert.equal(old.content, '旧');
});
test('完整模式保留目标编号与缺失字段，递归保留未知扩展，数组整体更新', () => {
    const old = e(0, '旧', ['旧'], '旧', { disable: true, extensions: { keep: 1, nested: { a: 1, b: 2 } } });
    const source = e(9, '新', ['新'], '新', { extensions: { nested: { a: 3 }, fromSource: true } });
    const result = replacement(old, source, 'full');
    assert.equal(result.uid, 0); assert.equal(result.disable, true);
    assert.deepEqual(result.key, ['新']);
    assert.deepEqual(result.extensions, { keep: 1, nested: { a: 3, b: 2 }, fromSource: true });
});
test('只更新勾选条目，未匹配条目、顶层元数据和来源保持完整', () => {
    const a = book(e(0, 'A', ['a']), e(1, 'B', ['b']), e(2, 'C', ['c'])); a.custom = '保留';
    const b = book(e(8, 'A', ['a'], '新A'), e(9, 'B', ['b'], '新B'), e(10, '新增', ['d'], '不追加'));
    const pairs = autoMatch(a, b); pairs.find(p => p.oldId === '1').checked = false;
    const originalA = canonical(a), originalB = canonical(b);
    const result = buildUpdate(a, b, pairs);
    assert.equal(result.updated, 1); assert.equal(result.data.entries[0].content, '新A');
    assert.equal(result.data.entries[1].content, '旧正文'); assert.equal(result.data.custom, '保留');
    assert.equal(Object.keys(result.data.entries).length, 3);
    assert.equal(canonical(a), originalA); assert.equal(canonical(b), originalB);
});
test('重复执行相同更新跳过；只改设置时正文模式跳过，完整模式更新', () => {
    const a = book(e(0, 'A', ['a'], '相同', { order: 1 }));
    const b = book(e(8, 'A', ['a'], '相同', { order: 2 }));
    assert.equal(buildUpdate(a, b, autoMatch(a, b)).updated, 0);
    const first = buildUpdate(a, b, autoMatch(a, b), 'full');
    assert.equal(first.updated, 1);
    assert.equal(buildUpdate(first.data, b, autoMatch(first.data, b), 'full').updated, 0);
});
test('同步 originalData 的 id/uid、正文、关键词与设置，保留导出扩展', () => {
    const a = book(e(0, 'A', ['a']));
    a.originalData = { entries: [{ id: 0, content: '旧正文', extensions: { private: true } }] };
    const b = book(e(8, 'A', ['a'], '新版', { disable: true, position: 4, depth: 6, selectiveLogic: 2 }));
    const result = buildUpdate(a, b, autoMatch(a, b), 'full').data.originalData.entries[0];
    assert.equal(result.id, 0); assert.equal(result.content, '新版'); assert.equal(result.enabled, false);
    assert.deepEqual(result.keys, ['a']); assert.equal(result.extensions.depth, 6);
    assert.equal(result.extensions.selectiveLogic, 2); assert.equal(result.extensions.private, true);
});
test('正文模式仅同步 originalData 正文', () => {
    const a = book(e(0, 'A', ['a'])); a.originalData = { entries: [{ uid: 0, content: '旧正文', comment: '保留' }] };
    const b = book(e(8, 'A', ['a'], '新正文'));
    assert.equal(buildUpdate(a, b, autoMatch(a, b)).data.originalData.entries[0].comment, '保留');
});
test('拒绝不合法文件、错位 uid、危险属性、重复或失效配对', () => {
    assert.throws(() => parseBook('{'), /JSON/);
    assert.throws(() => validateBook({ entries: [] }), /原生/);
    assert.throws(() => validateBook({ entries: { 0: e(9, 'A', []) } }), /uid/);
    assert.throws(() => parseBook('{"entries":{},"__proto__":{}}'), /属性名/);
    const a = book(e(0, 'A', [])), b = book(e(8, 'A', []));
    assert.throws(() => buildUpdate(a, b, [{ oldId: '0', newId: '8' }, { oldId: '0', newId: '8' }]), /重复/);
    assert.throws(() => buildUpdate(a, b, [{ oldId: '1', newId: '8' }]), /不存在/);
    assert.equal(Object.getPrototypeOf({}), Object.prototype);
});
test('支持 BOM 与不含 uid 的原生条目，完整更新不引入来源 uid', () => {
    const a = parseBook('\uFEFF{"entries":{"0":{"content":"旧","key":["a"]}}}');
    const b = book(e(8, '', ['a'], '新'));
    const result = buildUpdate(a, b, autoMatch(a, b), 'full');
    assert.equal(result.updated, 1); assert.equal('uid' in result.data.entries[0], false);
});
test('目标缺少关键词时仍可按唯一名字自动配对', () => {
    const old = book(e(0, '角色A', []), e(1, '无关角色', ['常用词']));
    const source = book(e(9, '角色A', ['常用词'], '新正文'));
    assert.deepEqual(autoMatch(old, source), [{ oldId: '0', newId: '9', checked: true, reason: '标题相同' }]);
});

test('同名人物用主关键词择唯一最佳，正文和次要关键词不参与身份', () => {
    const old = book(e(0, '爱丽丝', ['角色', '甲'], '正文甲', { keysecondary: ['乙'] }), e(1, '爱丽丝', ['角色', '乙'], '正文乙', { keysecondary: ['甲'] }));
    const source = book(e(8, '爱丽丝', ['角色', '甲', '新别名'], '正文乙', { keysecondary: ['乙'] }), e(9, '爱丽丝', ['角色', '乙'], '正文甲', { keysecondary: ['甲'] }));
    assert.deepEqual(autoMatch(old, source).map(p => [p.oldId, p.newId]), [['0', '8'], ['1', '9']]);
    assert.equal(autoMatch(old, book(e(10, '爱丽丝', ['角色'], '正文甲', { keysecondary: ['甲'] }))).length, 0);
    assert.equal(autoMatch(old, book(e(10, '爱丽丝', [], '正文甲', { keysecondary: ['甲'] }))).length, 0);
});

test('多个来源争夺同一目标时更强的姓名加关键词优先，强证据相同仍歧义', () => {
    const old = book(e(0, '同名', ['角色', '甲']));
    const source = book(e(8, '同名', []), e(9, '同名', ['甲']), e(10, '同名', ['角色', '甲']));
    assert.deepEqual(autoMatch(old, source).map(p => p.newId), ['10']);
    const tied = book(e(8, '同名', ['角色', '甲'], '一'), e(9, '同名', ['甲', '角色'], '二'));
    assert.deepEqual(autoMatch(old, tied), []);
});

test('canonical 对对象键排序，不把数组重新排序', () => {
    assert.equal(canonical({ b: 1, a: 2 }), canonical({ a: 2, b: 1 }));
    assert.notEqual(canonical(['a', 'b']), canonical(['b', 'a']));
});
test('大量共享关键词不展开候选笛卡尔积，仍能利用明确标题区分', () => {
    const oldEntries = Array.from({length:10000}, (_, i) => e(i, '', ['共用词']));
    const newEntries = oldEntries.map((x, i) => ({...x, uid:i+20000}));
    assert.equal(autoMatch(book(...oldEntries), book(...newEntries)).length, 0);
    oldEntries.forEach((x, i) => { x.comment = '独立条目' + i; newEntries[i].comment = x.comment; });
    assert.equal(autoMatch(book(...oldEntries), book(...newEntries)).length, 10000);
});
