import test from 'node:test';
import assert from 'node:assert/strict';
import { WorldbookService, backupScope } from '../host.js';
import { clone, canonical } from '../core.js';

const initial = { entries: { 0: { uid: 0, comment: '人物', key: ['人物'], content: '旧正文' } }, custom: true };
const updated = () => { const b = clone(initial); b.entries[0].content = '新正文'; return b; };
function fixture() {
    const f = { disk: clone(initial), cache: clone(initial), writes: 0, reads: 0, stored: null, failBackup: false, failWrite: false, throwAfterWrite: false, disconnected: false, afterWriteReadFails: false, deleted: false };
    const store = {
        async get() { return clone(f.stored); },
        async put(_name, record) { if (f.failBackup) throw new Error('备份失败'); f.stored = clone(record); },
    };
    const context = {
        getRequestHeaders: () => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': 'test-only' }),
        loadWorldInfo: async () => clone(f.cache),
        saveWorldInfo: async (_name, data, immediate) => {
            assert.equal(immediate, true); f.writes++; f.cache = clone(data);
            if (!f.failWrite) f.disk = clone(data);
            if (f.throwAfterWrite) throw new Error('listener failed');
        }, reloadWorldInfoEditor: () => { f.refreshed = true; },
    };
    f.context = context;
    f.service = new WorldbookService(() => context, async (path, opts) => {
        assert.equal(opts.credentials, 'same-origin'); assert.equal(opts.cache, 'no-store');
        assert.equal(opts.headers['X-CSRF-Token'], 'test-only');
        if (path.endsWith('list')) return { ok: true, json: async () => f.deleted ? [] : [{ file_id: '目标', name: '不同显示名' }] };
        if (f.disconnected || (f.writes && f.afterWriteReadFails)) throw new Error('offline');
        f.reads++; return { ok: true, json: async () => clone(f.disk) };
    }, store);
    return f;
}

test('先持久备份再单次原生保存，服务器回读核验，原对象不被修改', async () => {
    const f = fixture(), next = updated();
    const result = await f.service.update('目标', initial, next);
    assert.equal(result.data.entries[0].content, '新正文'); assert.equal(f.writes, 1);
    assert.deepEqual(f.stored.before, initial); assert.deepEqual(f.stored.after, next);
    assert.equal(f.stored.status, 'applied'); assert.ok(f.refreshed); assert.ok(f.reads >= 3);
    assert.equal(initial.entries[0].content, '旧正文');
});
test('备份存储失败不发送写入', async () => {
    const f = fixture(); f.failBackup = true;
    await assert.rejects(f.service.update('目标', initial, updated()), /备份/);
    assert.equal(f.writes, 0);
});
test('服务器或酒馆编辑缓存变化时拒绝覆盖', async () => {
    for (const key of ['disk', 'cache']) {
        const f = fixture(); f[key].entries[0].content = '其他修改';
        await assert.rejects(f.service.update('目标', initial, updated()), /变化|同步/);
        assert.equal(f.writes, 0);
    }
});
test('世界书删除或改名后不重新创建', async () => {
    const f = fixture(); f.deleted = true;
    await assert.rejects(f.service.update('目标', initial, updated()), /删除或改名/);
    assert.equal(f.writes, 0);
});
test('原生保存未抛错但服务器拒绝时，也不得报告成功', async () => {
    const f = fixture(); f.failWrite = true;
    await assert.rejects(f.service.update('目标', initial, updated()), /未保存/);
    assert.equal(f.stored.status, 'not-applied'); assert.equal(f.service.requiresReload, true);
});
test('服务器已经写入，原生事件通知失败时仍以回读确认结果', async () => {
    const f = fixture(); f.throwAfterWrite = true;
    const result = await f.service.update('目标', initial, updated());
    assert.match(result.note, /保存已核验/); assert.equal(f.stored.status, 'applied');
});
test('写入后断网保留 pending 状态，重新打开可以核实已完成', async () => {
    const f = fixture(); f.afterWriteReadFails = true;
    await assert.rejects(f.service.update('目标', initial, updated()), /尚未确认/);
    assert.equal(f.stored.status, 'pending');
    f.afterWriteReadFails = false;
    const result = await f.service.inspectBackup('目标', f.disk);
    assert.equal(result.backup.status, 'applied'); assert.match(result.message, /已核验/);
});
test('中断后区分未写入和其他修改，不盲目重试', async () => {
    const f = fixture();
    f.stored = { before: clone(initial), after: updated(), status: 'pending' };
    assert.equal((await f.service.inspectBackup('目标', initial)).backup.status, 'not-applied');
    f.stored.status = 'pending'; const other = updated(); other.custom = '其他修改';
    assert.equal((await f.service.inspectBackup('目标', other)).backup.status, 'uncertain');
    assert.equal(f.writes, 0);
});
test('可恢复整本备份并保留原恢复来源', async () => {
    const f = fixture(); await f.service.update('目标', initial, updated());
    await f.service.restore('目标', f.disk, f.stored);
    assert.deepEqual(f.disk, initial); assert.equal(f.stored.status, 'restored');
    assert.deepEqual(f.stored.before, initial);
});
test('恢复过程中退出，下次按 restoring 的目标核验', async () => {
    const f = fixture(); f.stored = { before: clone(initial), after: updated(), restoreBefore: updated(), status: 'restoring' };
    const result = await f.service.inspectBackup('目标', initial);
    assert.equal(result.backup.status, 'restored'); assert.equal(f.writes, 0);
});
test('相同内容不写入、不覆盖最近备份', async () => {
    const f = fixture(); await f.service.update('目标', initial, clone(initial));
    assert.equal(f.writes, 0); assert.equal(f.stored, null);
});
test('操作中或扩展关闭后禁止新写入', async () => {
    const f = fixture(); f.service.busy = true;
    await assert.rejects(f.service.update('目标', initial, updated()), /尚未结束/);
    f.service.busy = false; f.service.close();
    await assert.rejects(f.service.update('目标', initial, updated()), /关闭/);
    assert.equal(f.writes, 0);
});
test('备份按酒馆账号隔离，重复打开使用同一作用域', () => {
    const account = () => { const m = new Map(); return { getItem: key => m.get(key), setItem: (k, v) => m.set(k, v) }; };
    const a = { accountStorage: account(), uuidv4: () => 'account-a' }, b = { accountStorage: account(), uuidv4: () => 'account-b' };
    assert.equal(backupScope(a), backupScope(a)); assert.notEqual(backupScope(a), backupScope(b));
});
test('缺少可选编辑器刷新函数时给出手动打开提示', async () => {
    const f = fixture(); delete f.context.reloadWorldInfoEditor;
    const result = await f.service.update('目标', initial, updated());
    assert.match(result.note, /手动重新打开/); assert.equal(f.stored.status, 'applied');
});
