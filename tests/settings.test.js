import test from 'node:test';
import assert from 'node:assert/strict';
import { SETTINGS_FIELDS, applySettingsPatch, buildSettingsPatch, isSettingsField, pickSettings, setBookEntrySettings } from '../core.js';

const entry = () => ({
    uid: '0', comment: '爱芮', key: ['爱芮'], keysecondary: [], content: '正文',
    position: 1, depth: 4, role: 0, order: 100, constant: false,
    excludeRecursion: false, preventRecursion: false, delayUntilRecursion: 0, ignoreBudget: false,
});

test('核心字段表包含约定的十项，不含分组与角色过滤', () => {
    assert.deepEqual(SETTINGS_FIELDS.map(f => f.key), [
        'position', 'depth', 'role', 'order', 'constant',
        'excludeRecursion', 'preventRecursion', 'delayUntilRecursion', 'ignoreBudget', 'disable',
    ]);
    for (const key of ['group', 'groupWeight', 'characterFilterNames', 'triggers', 'vectorized', 'outletName', 'sticky', 'cooldown']) {
        assert.equal(isSettingsField(key), false, key);
    }
});

test('只生成被改动字段的补丁；未知字段与布尔相对调整被忽略', () => {
    const patch = buildSettingsPatch([
        { key: 'order', mode: 'set', value: '50' },
        { key: 'depth', mode: 'add', value: '-2' },
        { key: 'constant', mode: 'add', value: '1' },
        { key: 'group', mode: 'set', value: 'x' },
        { key: 'position', mode: '', value: '0' },
    ]);
    assert.deepEqual(Object.keys(patch), ['order', 'depth']);
    assert.deepEqual(patch.order, { mode: 'set', value: 50 });
    assert.deepEqual(patch.depth, { mode: 'add', value: -2 });
});

test('设置表单拒绝空数字、非法整数和无效下拉值，允许明确填写零', () => {
    for (const value of ['', '  ', '错字', '2.5', Infinity, null]) {
        assert.throws(() => buildSettingsPatch([{ key: 'order', mode: 'set', value }]), /注入顺序.*整数/);
    }
    assert.throws(() => buildSettingsPatch([{ key: 'position', mode: 'set', value: '9' }]), /注入位置.*有效/);
    assert.throws(() => buildSettingsPatch([{ key: 'constant', mode: 'set', value: '' }]), /常驻.*开关值/);
    const patch = buildSettingsPatch([{ key: 'order', mode: 'set', value: '0' }, { key: 'depth', mode: '', value: '' }]);
    assert.deepEqual(patch, { order: { mode: 'set', value: 0 } });
});

test('应用补丁只改点到的字段，标题/关键词/正文不动', () => {
    const before = entry();
    const next = applySettingsPatch(before, { order: { mode: 'set', value: 10 }, constant: { mode: 'set', value: true } });
    assert.equal(next.order, 10);
    assert.equal(next.constant, true);
    assert.equal(next.comment, '爱芮');
    assert.deepEqual(next.key, ['爱芮']);
    assert.equal(next.content, '正文');
    assert.equal(before.order, 100);
});

test('数值夹紧到酒馆范围，相对调整按当前值计算', () => {
    assert.equal(applySettingsPatch(entry(), { order: { mode: 'set', value: 99999 } }).order, 9999);
    assert.equal(applySettingsPatch(entry(), { order: { mode: 'set', value: -5 } }).order, 0);
    assert.equal(applySettingsPatch(entry(), { depth: { mode: 'add', value: -10 } }).depth, 0);
    assert.equal(applySettingsPatch(entry(), { depth: { mode: 'add', value: 6 } }).depth, 10);
    assert.equal(applySettingsPatch(entry(), { delayUntilRecursion: { mode: 'set', value: 2 } }).delayUntilRecursion, 2);
});

test('位置与角色只能是合法枚举，非法值回到第一项', () => {
    assert.equal(applySettingsPatch(entry(), { position: { mode: 'set', value: 4 } }).position, 4);
    assert.equal(applySettingsPatch(entry(), { position: { mode: 'set', value: 9 } }).position, 0);
    assert.equal(applySettingsPatch(entry(), { role: { mode: 'set', value: 2 } }).role, 2);
    assert.equal(applySettingsPatch(entry(), { role: { mode: 'set', value: 7 } }).role, 0);
});

test('同步只带指定字段', () => {
    const source = { ...entry(), order: 7, depth: 9, constant: true, content: '母本正文' };
    const picked = pickSettings(source, ['order', 'constant', 'content', 'comment']);
    assert.deepEqual(picked, { order: 7, constant: true, vectorized: false });
});

test('蓝绿灯应用补丁会退出向量状态，其他设置与原对象不变', () => {
    const source = { ...entry(), constant: false, vectorized: true, order: 27 };
    for (const [value, constant] of [['true', true], ['false', false]]) {
        const patch = buildSettingsPatch([{ key: 'constant', mode: 'set', value }]);
        const changed = applySettingsPatch(source, patch);
        assert.equal(changed.constant, constant);
        assert.equal(changed.vectorized, false);
        assert.equal(changed.order, 27);
    }
    assert.equal(source.vectorized, true);
    assert.equal(applySettingsPatch(source, { order: { mode: 'add', value: 3 } }).vectorized, true);
});

test('同步灯态时始终成对复制，缺失字段按关闭处理', () => {
    assert.deepEqual(pickSettings({ constant: true }, ['constant']), { constant: true, vectorized: false });
    assert.deepEqual(pickSettings({ constant: false, vectorized: true }, ['constant']), { constant: false, vectorized: true });
    assert.deepEqual(pickSettings({ vectorized: true }, ['constant']), { constant: false, vectorized: true });
    assert.deepEqual(pickSettings({ constant: false }, ['constant']), { constant: false, vectorized: false });
    assert.deepEqual(pickSettings({}, ['constant']), {});
});

test('批量设置同步导出镜像的选定字段，不触碰正文、标题或其他扩展', () => {
    const native = { ...entry(), uid: 0, constant: false, vectorized: true, extensions: { nativeOnly: '不复制' } };
    const book = { entries: { 0: native }, originalData: { entries: [{ id: 0, comment: '镜像名', content: '镜像正文', keys: ['镜像词'], constant: false, insertion_order: 100, extensions: { vectorized: true, private: 42 } }] } };
    const patch = buildSettingsPatch([{ key: 'constant', mode: 'set', value: 'true' }, { key: 'order', mode: 'add', value: '5' }]);
    const changed = applySettingsPatch(native, patch);
    setBookEntrySettings(book, '0', pickSettings(changed, Object.keys(patch)));
    assert.equal(book.entries[0].constant, true);
    assert.equal(book.entries[0].vectorized, false);
    assert.equal(book.entries[0].order, 105);
    assert.deepEqual(book.originalData.entries[0], { id: 0, comment: '镜像名', content: '镜像正文', keys: ['镜像词'], constant: true, insertion_order: 105, extensions: { vectorized: false, private: 42 } });
    assert.equal(native.order, 100);
    assert.throws(() => setBookEntrySettings(book, '9', { order: 1 }), /不存在/);
});

test('设置同步镜像支持向量状态且不更改其他字段', () => {
    const book = { entries: { 4: { ...entry(), uid: 4, constant: true, vectorized: false } }, originalData: { entries: [{ uid: 4, content: '保留', extensions: { vectorized: false, keep: true } }] } };
    setBookEntrySettings(book, 4, pickSettings({ constant: false, vectorized: true, content: '忽略' }, ['constant', 'content']));
    assert.equal(book.entries[4].constant, false);
    assert.equal(book.entries[4].vectorized, true);
    assert.deepEqual(book.originalData.entries[0], { uid: 4, content: '保留', constant: false, extensions: { vectorized: true, keep: true } });
});
