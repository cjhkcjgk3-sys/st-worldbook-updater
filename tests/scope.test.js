import test from 'node:test';
import assert from 'node:assert/strict';
import { autoMatch, autoMatchScoped, buildUpdate, cleanEntryName, compactName, listEntries, parseNameList, reorderPinned, scopeMatch, scopedEntries, splitCategoryPrefix, unmatchedNames, workKeysOf } from '../core.js';

const e = (uid, comment, key, content = '旧正文', extra = {}) => ({ uid, comment, key, content, ...extra });
const book = (...entries) => ({ entries: Object.fromEntries(entries.map(x => [String(x.uid), x])) });
const hit = (comment, names, works = []) => scopeMatch(e(0, comment, []), names, workKeysOf(works)) !== '';

// ---- 真实条目形态：主角:全名，偶尔带元数据尾巴 ----

test('「主角:全名」前缀能剥掉，按全名精确命中', () => {
    assert.equal(splitCategoryPrefix('主角:爱芮'), '爱芮');
    assert.ok(hit('主角:维琳娜·艾嘉德', ['维琳娜·艾嘉德']));
    assert.ok(hit('主角:希格莉德·德拉叙尔', ['希格莉德·德拉叙尔']));
    assert.ok(hit('主角:克拉蕾·弗林特', ['克拉蕾·弗林特']));
    // 结尾的「〔2 楼 · 回复 211/247〕」是元数据，不参与比较
    assert.ok(hit('主角:爱芮〔2 楼 · 回复 211/247〕', ['爱芮']));
    assert.ok(hit('主角:仪玄〔2 楼 · 回复 198/247〕', ['仪玄']));
});

test('括号里的英文名/曾用名也能命中', () => {
    assert.ok(hit('主角:波可娜·费雷尼 (Pulchra Fellini)', ['波可娜·费雷尼']));
    assert.ok(hit('主角:波可娜·费雷尼 (Pulchra Fellini)', ['Pulchra Fellini']));
    assert.ok(hit('主角:零号·安比 (安比·德玛拉 / Anby Demara)', ['零号·安比']));
    assert.ok(hit('主角:零号·安比 (安比·德玛拉 / Anby Demara)', ['安比·德玛拉']));
    assert.ok(hit('主角:零号·安比 (安比·德玛拉 / Anby Demara)', ['Anby Demara']));
});

test('仍然不做包含匹配：安比 ≠ 零号·安比', () => {
    assert.equal(hit('主角:零号·安比 (安比·德玛拉 / Anby Demara)', ['安比']), false);
    assert.equal(hit('主角:安比', ['小安比']), false);
    assert.ok(hit('主角:安比', ['安比']));
});

test('形态/皮肤自动归到主名下', () => {
    assert.ok(hit('角色 - 拉菲（改造）', ['拉菲']));
    assert.ok(hit('主角:雷电芽衣（雷之律者）', ['雷电芽衣']));
    // 写全名也照样命中
    assert.ok(hit('主角:雷电芽衣（雷之律者）', ['雷电芽衣（雷之律者）']));
});

test('分类前缀的另外几种写法也认', () => {
    assert.equal(splitCategoryPrefix('角色 - 雷电将军'), '雷电将军');
    assert.equal(splitCategoryPrefix('地点-王城'), '王城');
    assert.ok(hit('地点 - 王城', ['王城']));
});

// ---- 名单格式 ----

test('名单支持「作品别名：」声明、别名等号与顿号', () => {
    const parsed = parseNameList('作品别名：原神=Genshin、崩坏三\n雷电将军=雷神、钟离\n维琳娜·艾嘉德');
    assert.deepEqual(parsed.names, ['雷电将军', '雷神', '钟离', '维琳娜·艾嘉德']);
    assert.deepEqual(parsed.works, ['原神', 'Genshin', '崩坏三']);
    assert.deepEqual(parseNameList('   '), { names: [], works: [] });
});

test('名称折叠全半角、括号样式、标点与间隔号', () => {
    assert.equal(compactName('维琳娜·艾嘉德'), compactName('维琳娜艾嘉德'));
    assert.equal(compactName('长门·META'), compactName('长门（META）'));
    assert.equal(compactName('ＡＢＣ'), compactName('abc'));
});

test('声明作品名后，带作品的写法会去掉前缀再比较', () => {
    assert.ok(hit('主角:雷电将军', ['原神·雷电将军'], ['原神']));
    assert.ok(hit('主角:雷电将军', ['原神雷电将军'], ['原神']));
    assert.equal(hit('主角:雷电将军', ['原神·雷电将军'], []), false);
});

// ---- 名单驱动替换与复制 ----

test('名单外的人物既不配对也不进入新增候选', () => {
    const old = book(e(0, '主角:唐三', ['唐三']));
    const source = book(e(0, '主角:唐三', ['唐三'], '新正文'), e(1, '主角:小舞', ['小舞'], '新条目'), e(2, '主角:萧炎', ['萧炎'], '别的人物'));
    const pairs = autoMatchScoped(old, source, ['唐三']);
    assert.deepEqual(pairs.map(p => p.newId), ['0']);
    assert.deepEqual(scopedEntries(source, ['唐三']), ['0']);
});

test('名单内重名时按证据强弱择优，而不是两条一起作废', () => {
    const old = book(e(0, '主角:王城', ['王城', '首都']));
    const source = book(
        e(0, '主角:王城', ['王城', '首都'], '母本：原神侧'),
        e(1, '主角:王城', ['王城'], '母本：另一个作品'),
    );
    assert.equal(autoMatch(old, source).length, 0);
    assert.deepEqual(autoMatchScoped(old, source, ['王城']), [{ oldId: '0', newId: '0', checked: true, reason: '标题与关键词' }]);
});

test('名单里写了母本没有的名字会被报出来', () => {
    const source = book(e(0, '主角:唐三', ['唐三']));
    assert.deepEqual(unmatchedNames(source, ['唐三', '霍雨浩', '贝贝']), ['霍雨浩', '贝贝']);
});

test('定点复制：书里有的替换正文，书里没有的整条追加，名单外不动', () => {
    const old = book(e(0, '主角:王城', ['王城', '首都'], '作品书旧正文'));
    const source = book(
        e(0, '主角:王城', ['王城', '首都'], '母本正文'),
        e(1, '主角:超能力少女', ['超能力'], '母本正文：她的能力是读取情绪。', { position: 1, depth: 4 }),
        e(2, '主角:路人甲', ['路人'], '其他作品，不应进入'),
    );
    const names = ['王城', '超能力少女'];
    const pairs = autoMatchScoped(old, source, names);
    const pairedIds = new Set(pairs.map(p => p.newId));
    const additions = scopedEntries(source, names).filter(id => !pairedIds.has(id));

    const result = buildUpdate(old, source, pairs, 'content', { merge: true, additions });
    assert.equal(result.updated, 1);
    assert.equal(result.added, 1);
    const values = Object.values(result.data.entries);
    assert.equal(values.length, 2);
    assert.equal(values.find(x => x.comment === '主角:王城').content, '母本正文');
    const copied = values.find(x => x.comment.includes('超能力少女'));
    assert.equal(copied.content, '母本正文：她的能力是读取情绪。');
    assert.equal(copied.depth, 4);
    assert.equal(values.some(x => x.comment.includes('路人甲')), false);
});

test('空名单退回整本匹配，行为与原来一致', () => {
    const old = book(e(0, '人物', ['A', 'B']));
    const source = book(e(5, '人物', ['B', 'A'], '新正文'));
    assert.deepEqual(autoMatchScoped(old, source, []), autoMatch(old, source));
});

test('复制出的条目名去掉前缀与元数据，保留别名', () => {
    assert.equal(cleanEntryName('主角:爱芮〔2 楼 · 回复 211/247〕'), '爱芮');
    assert.equal(cleanEntryName('主角:波可娜·费雷尼 (Pulchra Fellini)'), '波可娜·费雷尼 (Pulchra Fellini)');
    assert.equal(cleanEntryName('角色 - 雷电将军'), '雷电将军');
});

test('冒号前缀只在左侧是分类名时才剥；名字里的冒号保持完整', () => {
    assert.equal(splitCategoryPrefix('主角:爱芮'), '爱芮');
    assert.equal(splitCategoryPrefix('角色：仪玄'), '仪玄');
    assert.equal(splitCategoryPrefix('Re:从零开始'), '');
    assert.equal(cleanEntryName('Re:从零开始'), 'Re:从零开始');
    assert.ok(hit('爱芮', ['爱芮']));
});

test('置顶：命中块按母本顺序排到最前，其余保持相对顺序', () => {
    // 母本里四个原神角色原来排在第 1、3、6、7 位
    const mother = book(
        e(0, '爱芮', [], '1'), e(1, '别的作品甲', [], '2'), e(2, '南宫羽', [], '3'),
        e(3, '别的作品乙', [], '4'), e(4, '别的作品丙', [], '5'), e(5, '维琳娜·艾嘉德', [], '6'),
        e(6, '零号·安比', [], '7'),
    );
    const block = ['0', '2', '5', '6'];
    const next = reorderPinned(mother, block);
    const order = listEntries(next).map(({ entry }) => entry.comment);
    assert.deepEqual(order, ['爱芮', '南宫羽', '维琳娜·艾嘉德', '零号·安比', '别的作品甲', '别的作品乙', '别的作品丙']);
    assert.deepEqual([0, 1, 2, 3, 4, 5, 6], listEntries(next).map(({ entry }) => entry.displayIndex));
    // 只动 displayIndex，不动注入顺序
    assert.equal(next.entries['0'].displayIndex, 0);
    assert.equal(mother.entries['0'].displayIndex, undefined); // 原对象未被修改
    assert.deepEqual(Object.values(next.entries).map(x => x.content), Object.values(mother.entries).map(x => x.content));
});

test('置顶时未知 id 被忽略，重复 id 只算一次', () => {
    const b = book(e(0, '甲', []), e(1, '乙', []));
    const next = reorderPinned(b, ['1', '999', '1', '0']);
    assert.deepEqual(listEntries(next).map(({ id }) => id), ['1', '0']);
});

test('置顶与写入组合：两侧命中块按母本顺序排到最前', () => {
    const target = book(e(0, '甲', []), e(1, '爱芮', ['爱芮'], '旧'), e(2, '乙', []), e(3, '南宫羽', ['南宫羽'], '旧'));
    const mother = book(
        e(0, '丙', []), e(1, '丁', []),
        e(2, '爱芮', ['爱芮'], '新一'), e(3, '南宫羽', ['南宫羽'], '新二'), e(4, '新的角色', ['新的角色'], '新三'),
    );
    const names = ['爱芮', '南宫羽', '新的角色'];
    const pairs = autoMatchScoped(target, mother, names);
    const paired = new Set(pairs.map(p => p.newId));
    const additions = scopedEntries(mother, names).filter(id => !paired.has(id));
    const result = buildUpdate(target, mother, pairs, 'content', { merge: true, additions });

    const addedByNew = new Map(result.addedPairs.map(p => [String(p.newId), p.oldId]));
    const blockNew = listEntries(mother).map(x => x.id).filter(id => pairs.some(p => p.newId === id) || addedByNew.has(id));
    const targetBlock = blockNew.map(id => pairs.find(p => p.newId === id)?.oldId ?? addedByNew.get(id));

    const targetNext = reorderPinned(result.data, targetBlock);
    const motherNext = reorderPinned(mother, blockNew);

    assert.deepEqual(listEntries(targetNext).map(({ entry }) => entry.comment), ['爱芮', '南宫羽', '新的角色', '甲', '乙']);
    assert.deepEqual(listEntries(motherNext).map(({ entry }) => entry.comment), ['爱芮', '南宫羽', '新的角色', '丙', '丁']);
    // 内容变化仍然生效
    assert.equal(targetNext.entries[listEntries(targetNext)[0].id].content, '新一');
    // 注入顺序未被改动
    assert.equal(targetNext.entries['0'].order, undefined);
});

test('置顶没有数量上限：60 个命中散在 300 条里，全部连成一块', () => {
    const rows = [];
    for (let i = 0; i < 300; i++) {
        const hit = i % 5 === 0;
        rows.push(e(i, hit ? `角色${i}` : `杂项${i}`, hit ? [`角色${i}`] : [], `正文${i}`));
    }
    const mother = book(...rows);
    const names = rows.filter((_, i) => i % 5 === 0).map(x => x.comment);
    const block = listEntries(mother).map(({ id }) => id).filter(id => names.includes(mother.entries[id].comment));
    assert.equal(block.length, 60);

    const next = reorderPinned(mother, block);
    const order = listEntries(next);
    assert.equal(order.length, 300);
    assert.equal(order.slice(0, 60).every(({ entry }) => entry.comment.startsWith('角色')), true);
    assert.equal(order.slice(60).every(({ entry }) => entry.comment.startsWith('杂项')), true);
    // displayIndex 连续，其余条目相对顺序不变
    assert.deepEqual(order.map(({ entry }) => entry.displayIndex), [...Array(300).keys()]);
    assert.deepEqual(order.slice(60).map(({ entry }) => entry.comment), rows.filter((_, i) => i % 5 !== 0).map(x => x.comment));
    // 正文一个字都没改
    assert.deepEqual(Object.values(next.entries).map(x => x.content).sort(), rows.map(x => x.content).sort());
});
