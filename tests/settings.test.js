import test from 'node:test';
import assert from 'node:assert/strict';
import { SETTINGS_FIELDS, applySettingsPatch, buildSettingsPatch, isSettingsField, pickSettings } from '../core.js';

const entry = () => ({
    uid: '0', comment: '爱芮', key: ['爱芮'], keysecondary: [], content: '正文',
    position: 1, depth: 4, role: 0, order: 100, constant: false,
    excludeRecursion: false, preventRecursion: false, delayUntilRecursion: 0, ignoreBudget: false,
});

test('核心字段表包含约定的十项，不含分组与角色过滤', () => {
    assert.deepEqual(SETTINGS_FIELDS.map(f => f.key), [
        'position', 'depth', 'role', 'order', 'constant',
        'excludeRecursion', 'preventRecursion', 'delayUntilRecursion', 'ignoreBudget',
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
    assert.deepEqual(picked, { order: 7, constant: true });
});
