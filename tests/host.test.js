import test from 'node:test';
import assert from 'node:assert/strict';
import { WorldbookService } from '../host.js';
import { clone, canonical } from '../core.js';

const initial = { entries: { 0: { uid: 0, comment: '人物', key: ['人物'], content: '旧正文' } }, custom: true };
const updated = () => { const b = clone(initial); b.entries[0].content = '新正文'; return b; };

function fixture() {
    const f = { disk: clone(initial), cache: clone(initial), writes: 0, reads: 0, failWrite: false, throwAfterWrite: false, disconnected: false, afterWriteReadFails: false, deleted: false };
    const context = {
        getRequestHeaders: () => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': 'test-only' }),
        loadWorldInfo: async () => clone(f.cache),
        saveWorldInfo: async (_name, data, immediate) => {
            assert.equal(immediate, true); f.writes++; f.cache = clone(data);
            if (!f.failWrite) f.disk = clone(data);
            if (f.throwAfterWrite) throw new Error('listener failed');
        },
        reloadWorldInfoEditor: () => { f.refreshed = true; },
    };
    f.context = context;
    f.service = new WorldbookService(() => context, async (path, opts) => {
        assert.equal(opts.credentials, 'same-origin');
        assert.equal(opts.cache, 'no-store');
        assert.equal(opts.headers['X-CSRF-Token'], 'test-only');
        if (path.endsWith('list')) return { ok: true, json: async () => f.deleted ? [] : [{ file_id: '目标', name: '不同显示名' }] };
        if (f.disconnected || (f.writes && f.afterWriteReadFails)) throw new Error('offline');
        f.reads++; return { ok: true, json: async () => clone(f.disk) };
    });
    return f;
}

test('保存后回读核验，原对象不被修改', async () => {
    const f = fixture(), next = updated();
    const result = await f.service.updateDirect('目标', initial, next);
    assert.equal(result.data.entries[0].content, '新正文');
    assert.equal(f.writes, 1);
    assert.ok(f.refreshed);
    assert.equal(initial.entries[0].content, '旧正文');
});

test('内容相同不写入', async () => {
    const f = fixture();
    const result = await f.service.updateDirect('目标', initial, clone(initial));
    assert.equal(f.writes, 0);
    assert.match(result.note, /相同/);
});

test('服务器没有真正写入时报错，不谎报成功', async () => {
    const f = fixture(); f.failWrite = true;
    await assert.rejects(f.service.updateDirect('目标', initial, updated()), /未保存|预期不同/);
});

test('保存成功但通知监听器抛错，仍以回读结果为准', async () => {
    const f = fixture(); f.throwAfterWrite = true;
    const result = await f.service.updateDirect('目标', initial, updated());
    assert.equal(result.data.entries[0].content, '新正文');
    assert.match(result.note, /刷新/);
});

test('写入后回读失败时要求刷新，不盲目重试', async () => {
    const f = fixture(); f.afterWriteReadFails = true;
    await assert.rejects(f.service.updateDirect('目标', initial, updated()), /刷新/);
    assert.equal(f.service.requiresReload, true);
});

test('世界书被删除或改名后拒绝写入', async () => {
    const f = fixture(); f.deleted = true;
    await assert.rejects(f.service.updateDirect('目标', initial, updated()), /删除|改名/);
    assert.equal(f.writes, 0);
});

test('酒馆编辑器缓存与服务器不一致时拒绝覆盖', async () => {
    const f = fixture(); f.cache.entries[0].content = '别处改过';
    await assert.rejects(f.service.updateDirect('目标', initial, updated()), /尚未同步|变化/);
    assert.equal(f.writes, 0);
});

test('原书在预览后被改动时拒绝覆盖', async () => {
    const f = fixture(); f.disk.entries[0].content = '别处改过';
    await assert.rejects(f.service.updateDirect('目标', initial, updated()), /变化/);
    assert.equal(f.writes, 0);
});

test('插件关闭后不再写入', async () => {
    const f = fixture(); f.service.disabled = true;
    await assert.rejects(f.service.updateDirect('目标', initial, updated()), /关闭/);
    assert.equal(f.writes, 0);
});

test('读取结果与预期一致时才返回，避免使用过期预览', async () => {
    const f = fixture();
    const book = await f.service.read('目标');
    assert.equal(canonical(book), canonical(initial));
    assert.equal(f.reads, 1);
});
