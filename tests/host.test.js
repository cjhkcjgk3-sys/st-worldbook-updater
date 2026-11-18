import test from 'node:test';
import assert from 'node:assert/strict';
import { WorldbookService } from '../host.js';
import { clone, canonical } from '../core.js';

const initial = { entries: { 0: { uid: 0, comment: '人物', key: ['人物'], content: '旧正文' } }, custom: true };
const updated = () => { const b = clone(initial); b.entries[0].content = '新正文'; return b; };
const otherEdit = () => { const b = clone(initial); b.entries[0].content = '别处改过'; return b; };

// Matches the host's clone-on-get, but not clone-on-set, cache behavior.
class HostCache extends Map {
    get(key) { const value = super.get(key); return value === undefined ? undefined : clone(value); }
}

function fixture() {
    const f = {
        disk: clone(initial), cache: new HostCache([['目标', clone(initial)]]), writes: 0, reads: 0,
        postWriteReads: 0, failWrite: false, lostResponse: false, failReadAt: 0, deleted: false,
        events: [], reloads: 0, hostSaves: 0, waits: [], pendingOther: true,
    };
    const context = {
        getRequestHeaders: () => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': 'test-only' }),
        saveWorldInfo: async () => { f.hostSaves++; f.pendingOther = false; },
        reloadWorldInfoEditor: () => { f.reloads++; },
        eventTypes: { WORLDINFO_UPDATED: 'worldinfo_updated' },
        eventSource: {
            emit: async (type, name, data) => {
                f.events.push({ type, name, data: clone(data) });
                if (f.onEvent) await f.onEvent(data);
                if (f.failNotification) throw new Error('listener failed');
            },
        },
    };
    f.context = context;
    f.flushOther = () => { if (f.pendingOther) { f.otherDisk = otherEdit(); f.pendingOther = false; } };
    const fetcher = async (path, opts) => {
        assert.equal(opts.credentials, 'same-origin');
        assert.equal(opts.cache, 'no-store');
        assert.equal(opts.headers['X-CSRF-Token'], 'test-only');
        const body = JSON.parse(opts.body);
        if (path.endsWith('/list')) return { ok: true, json: async () => [
            ...f.deleted ? [] : [{ file_id: '目标', name: '不同显示名' }],
            ...f.source ? [{ file_id: '母本' }] : [],
        ] };
        if (path.endsWith('/edit')) {
            f.writes++;
            assert.equal(body.name, '目标');
            if (!f.failWrite) f.disk = clone(body.data);
            if (f.onEdit) await f.onEdit();
            if (f.lostResponse) throw new TypeError('connection lost');
            return { ok: !f.failWrite, status: f.failWrite ? 500 : 200 };
        }
        assert.ok(path.endsWith('/get'));
        if (body.name === '母本') return { ok: true, json: async () => clone(f.source) };
        assert.equal(body.name, '目标');
        f.reads++;
        if (f.writes) {
            f.postWriteReads++;
            if (f.postWriteReads === f.failReadAt) throw new TypeError('offline');
        }
        if (f.onRead) await f.onRead();
        return { ok: true, json: async () => clone(f.disk) };
    };
    f.service = new WorldbookService(() => context, fetcher, async () => {
        if (f.failCacheLoader) throw new Error('module unavailable');
        return f.invalidCache ? {} : f.cache;
    }, {
        wait: async ms => { f.waits.push(ms); if (f.onWait) await f.onWait(); },
    });
    return f;
}

async function withDocument(document, run) {
    const hadDocument = Object.hasOwn(globalThis, 'document');
    const original = globalThis.document;
    globalThis.document = document;
    try { await run(); }
    finally {
        if (hadDocument) globalThis.document = original;
        else delete globalThis.document;
    }
}

function editorDocument(value, name) {
    return { querySelector: selector => {
        assert.equal(selector, '#world_editor_select');
        return { value, selectedOptions: [{ textContent: name }] };
    } };
}

test('使用独立请求保存并回读，更新缓存和通知，不重载原生编辑器', async () => {
    const f = fixture(), next = updated();
    const result = await f.service.updateDirect('目标', initial, next);
    assert.deepEqual(result.data, next);
    assert.deepEqual(f.cache.get('目标'), next);
    assert.deepEqual(f.events, [{ type: 'worldinfo_updated', name: '目标', data: next }]);
    assert.deepEqual(f.waits, [1100]);
    assert.equal(f.postWriteReads, 2);
    assert.equal(f.writes, 1);
    assert.equal(f.hostSaves, 0);
    assert.equal(f.reloads, 0);
    assert.equal(initial.entries[0].content, '旧正文');
    next.entries[0].content = '客户端后续更改';
    assert.deepEqual(f.cache.get('目标'), updated());
});

test('目标书尚未缓存时成功写入并建立缓存，通知数据不共享缓存引用', async () => {
    const f = fixture(); f.cache.delete('目标');
    f.onEvent = data => { data.entries[0].content = '监听器私自修改'; };
    await f.service.updateDirect('目标', initial, updated());
    assert.deepEqual(f.cache.get('目标'), updated());
    assert.deepEqual(f.disk, updated());
});

test('其他书的待保存防抖不会被插件取消', async () => {
    const f = fixture();
    await f.service.updateDirect('目标', initial, updated());
    assert.equal(f.pendingOther, true);
    assert.equal(f.hostSaves, 0);
    f.flushOther();
    assert.deepEqual(f.otherDisk, otherEdit());
});

test('内容相同不写入', async () => {
    const f = fixture();
    const result = await f.service.updateDirect('目标', initial, clone(initial));
    assert.equal(f.writes, 0);
    assert.equal(result.changed, false);
    assert.match(result.note, /相同/);
});

test('写入前再次核对母本，等待期间母本变化时零写入并允许重新预览', async () => {
    const f = fixture();
    f.source = clone(initial);
    const source = { name: '母本', data: clone(f.source) };
    f.onWait = () => { f.source = otherEdit(); };
    await assert.rejects(f.service.updateDirect('目标', initial, updated(), source), /「母本」.*发生了变化/);
    assert.equal(f.writes, 0);
    assert.equal(f.events.length, 0);
    assert.deepEqual(f.disk, initial);
    assert.equal(f.service.requiresReload, false);

    f.onWait = null;
    const result = await f.service.updateDirect('目标', initial, updated(), { name: '母本', data: f.source });
    assert.deepEqual(result.data, updated());
    assert.equal(f.writes, 1);
});

test('缓存模块无法导入或导出不可用时，明确报错且不写入', async () => {
    for (const field of ['failCacheLoader', 'invalidCache']) {
        const f = fixture(); f[field] = true;
        await assert.rejects(f.service.updateDirect('目标', initial, updated()), /无法获取.*缓存/);
        assert.equal(f.writes, 0);
    }
});

test('服务器写入失败时不更新缓存、不通知，也不允许盲目重试', async () => {
    const f = fixture(); f.failWrite = true;
    await assert.rejects(f.service.updateDirect('目标', initial, updated()), /未确认保存/);
    assert.deepEqual(f.cache.get('目标'), initial);
    assert.equal(f.events.length, 0);
    assert.equal(f.service.requiresReload, true);
    await assert.rejects(f.service.updateDirect('目标', initial, updated()), /刷新/);
    assert.equal(f.writes, 1);
});

test('响应丢失但回读成功时说明异常并要求核对', async () => {
    const f = fixture(); f.lostResponse = true;
    const result = await f.service.updateDirect('目标', initial, updated());
    assert.deepEqual(result.data, updated());
    assert.deepEqual(f.cache.get('目标'), updated());
    assert.match(result.note, /响应异常/);
    assert.equal(f.service.requiresReload, true);
});

test('保存成功但通知监听器抛错，仍以回读结果为准并提示', async () => {
    const f = fixture(); f.failNotification = true;
    const result = await f.service.updateDirect('目标', initial, updated());
    assert.deepEqual(result.data, updated());
    assert.match(result.note, /通知失败/);
    assert.equal(f.postWriteReads, 2);
});

test('写入后或通知后回读失败时要求先处理未保存内容，禁止继续写入', async () => {
    for (const read of [1, 2]) {
        const f = fixture(); f.failReadAt = read;
        await assert.rejects(f.service.updateDirect('目标', initial, updated()), /未确认.*未保存内容.*刷新/);
        assert.equal(f.service.requiresReload, true);
        assert.equal(f.reloads, 0);
        await assert.rejects(f.service.updateDirect('目标', initial, updated()), /刷新/);
    }
});

test('世界书被删除或改名后拒绝写入', async () => {
    const f = fixture(); f.deleted = true;
    await assert.rejects(f.service.updateDirect('目标', initial, updated()), /删除|改名/);
    assert.equal(f.writes, 0);
});

test('酒馆编辑器缓存与服务器不一致时拒绝覆盖', async () => {
    const f = fixture(); f.cache.set('目标', otherEdit());
    await assert.rejects(f.service.updateDirect('目标', initial, updated()), /尚未同步/);
    assert.equal(f.writes, 0);
});

test('原书在预览后或等待防抖期间被改动时拒绝覆盖', async () => {
    const f = fixture(); f.disk = otherEdit();
    await assert.rejects(f.service.updateDirect('目标', initial, updated()), /变化/);
    const g = fixture(); g.onWait = () => { g.disk = otherEdit(); };
    await assert.rejects(g.service.updateDirect('目标', initial, updated()), /变化/);
    assert.equal(g.writes, 0);
});

test('等待防抖期间缓存变化时拒绝写入', async () => {
    const f = fixture(); f.onWait = () => { f.cache.set('目标', otherEdit()); };
    await assert.rejects(f.service.updateDirect('目标', initial, updated()), /缓存发生变化.*未保存内容.*核对/);
    assert.equal(f.writes, 0);
    assert.deepEqual(f.cache.get('目标'), otherEdit());
});

test('写入期间缓存变化时不覆盖、不通知、不重载，并要求核对', async () => {
    const f = fixture(); f.onEdit = () => { f.cache.set('目标', otherEdit()); };
    await assert.rejects(f.service.updateDirect('目标', initial, updated()), /写入期间.*缓存发生变化.*未保存内容.*核对/);
    assert.deepEqual(f.disk, updated());
    assert.deepEqual(f.cache.get('目标'), otherEdit());
    assert.equal(f.events.length, 0);
    assert.equal(f.reloads, 0);
    assert.equal(f.service.requiresReload, true);
});

test('未缓存的目标书在写入期间新进入缓存时不覆盖', async () => {
    const f = fixture(); f.cache.delete('目标');
    f.onEdit = () => { f.cache.set('目标', clone(initial)); };
    await assert.rejects(f.service.updateDirect('目标', initial, updated()), /缓存发生变化/);
    assert.deepEqual(f.cache.get('目标'), initial);
    assert.equal(f.events.length, 0);
});

test('写后首次回读期间缓存变化也不会被覆盖或通知', async () => {
    const f = fixture();
    f.onRead = () => { if (f.postWriteReads === 1) f.cache.set('目标', otherEdit()); };
    await assert.rejects(f.service.updateDirect('目标', initial, updated()), /缓存发生变化/);
    assert.deepEqual(f.cache.get('目标'), otherEdit());
    assert.equal(f.events.length, 0);
});

test('通知期间缓存被其他代码修改时保留其内容并要求核对', async () => {
    const f = fixture(); f.onEvent = () => { f.cache.set('目标', otherEdit()); };
    await assert.rejects(f.service.updateDirect('目标', initial, updated()), /缓存发生变化/);
    assert.deepEqual(f.cache.get('目标'), otherEdit());
    assert.equal(f.service.requiresReload, true);
    assert.equal(f.reloads, 0);
});

test('原生编辑器选中目标书时拒绝写入，即使缓存与服务器相同', async () => {
    await withDocument(editorDocument('0', '目标'), async () => {
        const f = fixture();
        await assert.rejects(f.service.updateDirect('目标', initial, updated()), /切换到其他书或取消选择/);
        assert.equal(f.writes, 0);
        assert.equal(f.reloads, 0);
    });
});

test('原生编辑器选择其他书或空选项时允许写入', async () => {
    for (const [value, name] of [['1', '其他书'], ['', '目标']]) {
        await withDocument(editorDocument(value, name), async () => {
            const f = fixture();
            await f.service.updateDirect('目标', initial, updated());
            assert.equal(f.writes, 1);
            assert.equal(f.reloads, 0);
        });
    }
});

test('真实 DOM 找不到选择框时拒绝写入；无 DOM 的模拟宿主可写入', async () => {
    await withDocument({ querySelector: () => null }, async () => {
        const f = fixture();
        await assert.rejects(f.service.updateDirect('目标', initial, updated()), /无法确认原生世界书编辑器/);
        assert.equal(f.writes, 0);
    });
    const f = fixture();
    await f.service.updateDirect('目标', initial, updated());
    assert.equal(f.writes, 1);
});

test('等待防抖期间原生编辑器改选目标书时拒绝写入', async () => {
    await withDocument(editorDocument('1', '其他书'), async () => {
        const f = fixture();
        f.onWait = () => { globalThis.document = editorDocument('0', '目标'); };
        await assert.rejects(f.service.updateDirect('目标', initial, updated()), /切换到其他书或取消选择/);
        assert.equal(f.writes, 0);
    });
});

test('写入期间原生编辑器改选目标书时不覆盖缓存或通知', async () => {
    const doc = editorDocument('1', '其他书');
    await withDocument(doc, async () => {
        const f = fixture();
        f.onEdit = () => { globalThis.document = editorDocument('0', '目标'); };
        await assert.rejects(f.service.updateDirect('目标', initial, updated()), /编辑器的选择发生变化/);
        assert.deepEqual(f.cache.get('目标'), initial);
        assert.equal(f.events.length, 0);
        assert.equal(f.reloads, 0);
        assert.equal(f.service.requiresReload, true);
    });
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
