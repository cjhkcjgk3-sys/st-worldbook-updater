import test from 'node:test';
import assert from 'node:assert/strict';
import {
    applySettingsPatch, autoMatchScoped, buildSettingsPatch, buildUpdate,
    pickSettings, scopedEntries, setBookEntrySettings,
} from '../core.js';

const makeBook = rows => ({ entries: Object.fromEntries(rows.map(row => [String(row.uid), row])), label: 'keep' });

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
