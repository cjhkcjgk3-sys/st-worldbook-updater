import test from 'node:test';
import assert from 'node:assert/strict';
import {
    applySettingsPatch, autoMatchScoped, buildRosterUpdate, buildSettingsPatch, buildUpdate,
    matchRosterEntries, parseNameList, pickSettings, scopedEntries, setBookEntrySettings,
} from '../core.js';

const makeBook = rows => ({ entries: Object.fromEntries(rows.map(row => [String(row.uid), row])), label: 'keep' });

test('匹配哥伦比娅的四字简称与译名异写，并识别菲谢尔合写条目的主名', () => {
    const mother = makeBook([
        { uid: 10, comment: '哥伦比娅·希珀塞莱妮娅', key: ['少女', '库塔尔', '月之少女', '空月归乡', '小鸽子'], content: '少女新正文' },
        { uid: 11, comment: '菲谢尔·冯·露弗施洛斯·那菲多特', key: ['菲谢尔·冯·露弗施洛斯·那菲多特', '断罪之皇女'], content: '菲谢尔新正文' },
    ]);
    const target = makeBook([
        { uid: 0, comment: '哥伦比亚', key: ['少女', '库塔尔', '月神', '哥伦比娅'], content: '少女旧正文' },
        { uid: 1, comment: '菲谢尔，奥兹', key: ['菲谢尔、奥兹'], content: '合写旧正文' },
    ]);
    for (const name of ['哥伦比娅', '哥伦比亚', '哥伦比亚·希珀塞莱妮娅']) {
        const groups = [[name], ['菲谢尔']];
        const plan = buildRosterUpdate(target, mother, groups, 'content');
        assert.deepEqual(plan.replace, [name, '菲谢尔 → 「菲谢尔，奥兹」（更新整条）']);
        assert.deepEqual(plan.copy, []);
        assert.equal(plan.result.data.entries[0].content, '少女新正文');
        assert.equal(plan.result.data.entries[1].content, '菲谢尔新正文');
        assert.equal(plan.result.data.entries[1].comment, '菲谢尔，奥兹');
        const again = buildRosterUpdate(plan.result.data, mother, groups, 'content');
        assert.equal(again.result.updated + again.result.added, 0);
    }
    const companionMother = makeBook([{ uid: 12, comment: '奥兹', key: ['菲谢尔'], content: '奥兹新正文' }]);
    const companion = buildRosterUpdate(target, companionMother, [['奥兹']], 'content');
    assert.equal(companion.review.length, 1);
    assert.equal(companion.result.updated + companion.result.added, 0);
});

test('丽莎的简称、全名、作品前缀可在母本、目标书和名单互换', () => {
    const names = ['丽莎', '丽莎·敏兹', '原神·丽莎'];
    for (const motherName of names) for (const targetName of names) for (const name of names) {
        const mother = makeBook([{ uid: 10, comment: motherName, key: ['蔷薇魔女'], content: '完整正文' }]);
        const target = makeBook([{ uid: 0, comment: targetName, key: ['蔷薇魔女'], content: '' }]);
        const plan = buildRosterUpdate(target, mother, [[name]], 'content');
        assert.deepEqual(plan.replace, [name], JSON.stringify({ motherName, targetName, name }));
        assert.equal(plan.result.added, 0);
        assert.equal(plan.result.data.entries[0].content, '完整正文');
    }
});

test('简称重名需要核对，并且不同全名不会因为首段相同而互相替换', () => {
    const row = (uid, comment) => ({ uid, comment, content: comment, key: [] });
    const mother = makeBook([row(10, '丽莎·敏兹')]);
    const other = row(1, '丽莎·琼斯（丽莎）');
    const target = makeBook([row(0, '丽莎·敏兹'), other]);
    const ambiguous = buildRosterUpdate(target, makeBook([row(11, '丽莎')]), [['丽莎']], 'content');
    assert.match(ambiguous.review[0], /目标书有多个匹配/);
    assert.equal(ambiguous.result.updated + ambiguous.result.added, 0);
    const sourceConflict = buildRosterUpdate(target, makeBook([row(10, '丽莎·敏兹'), row(11, '丽莎·琼斯')]), [['丽莎']], 'content');
    assert.match(sourceConflict.review[0], /母本有多个匹配/);
    const distinct = buildRosterUpdate(makeBook([other]), mother, [['丽莎']], 'content');
    assert.equal(distinct.result.updated, 0);
    assert.equal(distinct.result.added, 1);
    assert.deepEqual(distinct.result.data.entries[1], other);
    const fromShort = buildRosterUpdate(makeBook([other]), makeBook([row(11, '丽莎')]), [['丽莎·敏兹']], 'content');
    assert.equal(fromShort.result.updated, 0);
    assert.deepEqual(fromShort.result.data.entries[1], other);
});

test('琴与琴·古恩希尔德配对，单字简称遇到多条全名时待核对', () => {
    const target = makeBook([{ uid: 0, comment: '琴', key: ['琴', '琴团长', '琴團長', '代理团长'], content: '旧正文' }]);
    const jean = { uid: 10, comment: '琴·古恩希尔德', key: ['琴·古恩希尔德', '蒲公英骑士', '狮牙骑士', '代理团长'], content: '完整正文' };
    const mother = makeBook([jean]);
    for (const name of ['琴', '琴·古恩希尔德', '原神·琴']) {
        const plan = buildRosterUpdate(target, mother, [[name]], 'content');
        assert.deepEqual(plan.replace, [name]);
        assert.equal(plan.result.added, 0);
        assert.equal(plan.result.data.entries[0].content, '完整正文');
    }
    const resolved = buildRosterUpdate(target, makeBook([jean, { ...jean, uid: 11, comment: '琴·另一人', key: ['琴'] }]), [['琴']], 'content');
    assert.deepEqual(resolved.replace, ['琴']);
    const conflict = buildRosterUpdate(target, makeBook([jean, { ...jean, uid: 11, comment: '琴·另一人' }]), [['琴']], 'content');
    assert.match(conflict.review[0], /母本有多个匹配/);
    assert.equal(conflict.result.updated + conflict.result.added, 0);
});

test('定点名单单字证据不足不替换也不误复制，明确主关键词可从空目标添加', () => {
    const jean = { uid: 10, comment: '琴·古恩希尔德', key: ['蒲公英骑士'], content: '新正文' };
    const existing = makeBook([{ uid: 0, comment: '琴', key: ['弦乐器'], content: '旧正文' }]);
    for (const target of [existing, makeBook([])]) {
        const plan = buildRosterUpdate(target, makeBook([jean]), [['琴']], 'content');
        assert.match(plan.review[0], /主关键词佐证/);
        assert.equal(plan.result.updated + plan.result.added, 0);
    }
    const explicitlyNamed = { ...jean, key: ['琴', '蒲公英骑士'] };
    assert.equal(buildRosterUpdate(makeBook([]), makeBook([explicitlyNamed]), [['琴']], 'content').result.added, 1);
    assert.equal(buildRosterUpdate(existing, makeBook([explicitlyNamed]), [['琴·古恩希尔德']], 'content').result.updated, 0);
});

for (const count of [100, 50, 3, 0]) {
    test(`100 人名单更新已有 ${count} 人的目标书，重复执行不新增`, () => {
        const candidates = Array.from({ length: 1000 }, (_, i) => ({
            uid: i + 1000, comment: `角色 ${i}`, key: ['通用触发词'], content: `完整正文 ${i}`, order: 250,
        }));
        const mother = makeBook(candidates);
        const target = makeBook(candidates.slice(0, count).map((entry, uid) => ({
            uid, comment: entry.comment, key: [], content: uid % 2 ? '' : '不完整', order: 50,
        })));
        if (count) target.entries[500] = { uid: 500, comment: '名单外条目', content: '保留' };
        const { groups } = parseNameList(candidates.slice(0, 100).map(entry => entry.comment).join('\n'), { includeGroups: true });
        const plan = buildRosterUpdate(target, mother, groups, 'content');
        assert.equal(plan.replace.length, count);
        assert.equal(plan.copy.length, 100 - count);
        assert.deepEqual([plan.missing, plan.review, plan.unchanged], [[], [], []]);
        assert.equal(Object.keys(plan.result.data.entries).length, count ? 101 : 100);
        assert.equal(plan.result.data.label, 'keep');
        assert.deepEqual(plan.result.data.entries[500], target.entries[500]);
        const byName = new Map(Object.values(plan.result.data.entries).map(entry => [entry.comment, entry]));
        for (const [i, source] of candidates.slice(0, 100).entries()) {
            const entry = byName.get(source.comment);
            assert.equal(entry.content, source.content);
            assert.equal(entry.order, i < count ? 50 : 250);
            if (i < count) assert.equal(entry.uid, i);
        }
        assert.equal(byName.has(candidates[100].comment), false);
        const again = buildRosterUpdate(plan.result.data, mother, groups, 'content');
        assert.equal(again.result.updated + again.result.added, 0);
        assert.equal(again.unchanged.length, 100);
    });
}

test('名单识别两侧别名，缺失、重名和争抢目标的条目等待核对', () => {
    const row = (uid, comment, key = []) => ({ uid, comment, key, content: '正文', order: 1 });
    const mother = makeBook([
        row(10, '甲', ['甲的特征']), row(11, '乙', ['乙']), row(12, '乙', ['乙']),
        row(13, '丙', ['丙的特征']), row(14, '丁', ['丁的特征']), row(15, '戊', ['戊的特征']),
        row(16, '己', ['己', '己的特征']), row(17, '庚某', ['庚的特征']), row(18, '辛某', ['专属关键词']),
    ]);
    const target = makeBook([
        { ...row(0, 'Alpha', ['甲的特征']), order: 42 },
        row(1, '丙', ['丙的特征']), row(2, '丙', ['丙的特征']),
        row(3, '丁（戊）', ['丁的特征', '戊的特征']), row(4, '既有条目', ['庚某', '庚的特征']),
        row(5, '', ['专属关键词']),
    ]);
    const { groups } = parseNameList('甲=Alpha\n乙\n丙\n丁\n戊\n己\n庚某\n辛某\n缺失', { includeGroups: true });
    const { reviewRows } = matchRosterEntries(target, mother, groups);
    assert.deepEqual(reviewRows.new, new Set(['11', '12', '13', '14', '15', '17', '18']));
    assert.deepEqual(reviewRows.old, new Set(['1', '2', '3', '4', '5']));
    const plan = buildRosterUpdate(target, mother, groups, 'full');
    assert.deepEqual(plan.replace, ['甲 / Alpha']);
    assert.deepEqual(plan.copy, ['己']);
    assert.deepEqual(plan.missing, ['缺失']);
    assert.equal(plan.review.length, 6);
    assert.match(plan.review.find(name => name.startsWith('庚')), /标题不同/);
    assert.match(plan.review.find(name => name.startsWith('丁')), /同一目标/);
    assert.match(plan.review.find(name => name.startsWith('辛')), /主关键词完全相同/);
    assert.equal(plan.result.data.entries[0].comment, '甲');
    assert.equal(plan.result.data.entries[0].uid, 0);
    assert.equal(plan.result.data.entries[0].order, 1);
    assert.deepEqual(plan.result.data.entries[3], target.entries[3]);
    assert.deepEqual(plan.result.data.entries[4], target.entries[4]);
    assert.deepEqual(plan.result.data.entries[5], target.entries[5]);
    const again = buildRosterUpdate(plan.result.data, mother, groups, 'full');
    assert.deepEqual(again.unchanged, ['甲 / Alpha', '己']);
    assert.equal(again.result.updated + again.result.added, 0);
});

test('名单尊重手动配对和解除决定，并保护名单外的手动配对目标', () => {
    const row = (uid, comment, content) => ({ uid, comment, key: [`${comment}的关键词`], content });
    const mother = makeBook([row(10, '甲', '新'), row(11, '乙', '新'), row(12, '名单外', '新')]);
    const target = makeBook([row(0, '甲', '旧 0'), row(1, '甲', '旧 1'), row(2, '乙', '旧 2')]);
    const manualPairs = [{ oldId: '1', newId: '10' }, { oldId: '2', newId: '12' }];
    const plan = buildRosterUpdate(target, mother, [['甲'], ['乙']], 'content', { manualPairs });
    assert.deepEqual(plan.replace, ['甲']);
    assert.match(plan.review[0], /乙.*其他手动配对/);
    assert.equal(plan.result.data.entries[1].content, '新');
    assert.equal(plan.result.data.entries[0].content, '旧 0');
    const blocked = buildRosterUpdate(target, mother, [['乙']], 'content', { unpairedNew: new Set(['11']) });
    assert.match(blocked.review[0], /解除配对/);
    assert.equal(blocked.result.added + blocked.result.updated, 0);
});

test('名单待核对与替换、新增互斥，候选目标保留到手动确认', () => {
    const mother = makeBook([
        { uid: 10, comment: '丽莎·敏兹', key: ['蔷薇魔女', '图书馆员'], content: '新版' },
        { uid: 11, comment: '艾琳', key: ['图书馆员'], content: '另一个人' },
    ]);
    const target = makeBook([{ uid: 0, comment: '丽莎', key: ['蔷薇魔女', '图书馆员'], content: '原版' }]);
    const names = [['丽莎'], ['图书馆员']];
    for (const existing of [target, makeBook([])]) {
        const match = matchRosterEntries(existing, mother, names);
        assert.deepEqual(match.states, new Map([['10', 'review'], ['11', 'review']]));
        assert.deepEqual([match.pairs, match.additions], [[], []]);
        assert.deepEqual(match.reviewRows.old, new Set(Object.keys(existing.entries)));
        assert.match(match.reviewReasons.get('10'), /母本有多个/);
    }
    const confirmed = matchRosterEntries(target, mother, names, { manualPairs: [{ oldId: '0', newId: '10' }] });
    assert.deepEqual(confirmed.states, new Map([['10', 'paired']]));
    assert.deepEqual(confirmed.review, []);
});

test('名单区分明确的作品标签和合写边界，短名关键词不抢占真实姓名', () => {
    const row = (uid, comment, key) => ({ uid, comment, key, content: String(uid) });
    const mother = makeBook([
        row(10, '丽莎·敏兹', ['图书管理员']),
        row(11, '原神·同名', ['共用词']),
        row(12, '绝区零·同名', ['共用词']),
        row(13, '爱好', ['相同词']),
    ]);
    const target = makeBook([
        row(0, '丽莎', ['图书管理员']),
        row(1, '蒙德图书馆', ['丽莎', '图书管理员']),
        row(2, '绝区零·同名', ['共用词']),
        row(3, '爱，好', ['相同词']),
    ]);
    const match = matchRosterEntries(target, mother, [['丽莎'], ['原神·同名'], ['爱好']]);
    assert.deepEqual(match.pairs.map(({ oldId, newId }) => [oldId, newId]), [['0', '10']]);
    assert.deepEqual(match.additions, ['11', '13']);
    assert.deepEqual(match.review, []);
});

test('名单批量调整母本后一次更新五项并复制四十五项', () => {
    const target = makeBook(Array.from({ length: 5 }, (_, i) => ({
        uid: i, comment: `角色${i}`, key: [], content: `旧正文${i}`,
        displayIndex: 10 + i, constant: true,
    })));
    const mother = makeBook(Array.from({ length: 60 }, (_, i) => ({
        uid: 100 + i, comment: `角色${i}`, key: [`角色${i}`], content: `新正文${i}`,
        constant: false, vectorized: true, depth: 1, order: 10,
    })));
    const names = Array.from({ length: 50 }, (_, i) => `角色${i}`);
    const ids = scopedEntries(mother, names);
    const pairs = autoMatchScoped(target, mother, names);
    assert.equal(ids.length, 50);
    assert.equal(pairs.length, 5);
    const patch = buildSettingsPatch([
        { key: 'constant', mode: 'set', value: false },
        { key: 'depth', mode: 'set', value: 4 },
        { key: 'order', mode: 'set', value: 250 },
        { key: 'excludeRecursion', mode: 'set', value: true },
    ]);
    const adjusted = structuredClone(mother);
    for (const id of ids) {
        const changed = applySettingsPatch(adjusted.entries[id], patch);
        setBookEntrySettings(adjusted, id, pickSettings(changed, Object.keys(patch)));
    }
    assert.equal(adjusted.entries['150'].vectorized, true);
    const paired = new Set(pairs.map(pair => pair.newId));
    const additions = ids.filter(id => !paired.has(id));
    const result = buildUpdate(target, adjusted, pairs, 'full', { merge: true, additions });
    assert.equal(result.updated, 5);
    assert.equal(result.added, 45);
    assert.equal(Object.keys(result.data.entries).length, 50);
    assert.equal(result.data.label, 'keep');
    for (let i = 0; i < 5; i++) {
        assert.equal(result.data.entries[String(i)].content, `新正文${i}`);
        assert.equal(result.data.entries[String(i)].displayIndex, 10 + i);
    }
    for (const entry of Object.values(result.data.entries)) {
        assert.equal(entry.constant, false);
        assert.equal(entry.vectorized, false);
        assert.equal(entry.depth, 4);
        assert.equal(entry.order, 250);
        assert.equal(entry.excludeRecursion, true);
    }
    assert.equal(Object.values(result.data.entries).some(entry => entry.comment === '角色50'), false);
    assert.equal(target.entries['0'].content, '旧正文0');
    assert.equal(mother.entries['100'].vectorized, true);
});
