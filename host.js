import { canonical, clone, validateBook } from './core.js';

export function hostContext() {
    if (typeof globalThis.structuredClone !== 'function') throw new Error('当前浏览器缺少数据复制能力，请更新浏览器或 Android WebView。');
    const ctx = globalThis.SillyTavern?.getContext?.();
    const missing = ['getRequestHeaders'].filter(k => typeof ctx?.[k] !== 'function');
    if (missing.length) throw new Error('当前酒馆缺少世界书读写能力，请使用 SillyTavern 1.18.0 或更新版本。');
    return ctx;
}

async function loadHostCache() {
    return (await import('/scripts/world-info.js')).worldInfoCache;
}

function checkNativeEditor(name) {
    if (typeof document === 'undefined') return;
    const select = document.querySelector('#world_editor_select');
    if (!select) throw new Error('无法确认原生世界书编辑器的选择，已停止写入。');
    if (select.value === '') return;
    const selected = select.selectedOptions?.[0] ?? select.options?.[select.selectedIndex];
    const selectedName = selected?.textContent;
    if (typeof selectedName !== 'string') throw new Error('无法确认原生世界书编辑器的选择，已停止写入。');
    if (selectedName === name) throw new Error(`「${name}」正在原生世界书编辑器中打开，可能有未保存条目。请先在原生世界书编辑器切换到其他书或取消选择，再重试。`);
}

export class WorldbookService {
    constructor(context = hostContext, fetcher = globalThis.fetch.bind(globalThis), cacheLoader = loadHostCache, options = {}) {
        this.context = context;
        this.fetcher = fetcher;
        this.cacheLoader = cacheLoader;
        this.checkEditor = options.checkEditor ?? checkNativeEditor;
        this.wait = options.wait ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
        this.busy = false;
        this.requiresReload = false;
        this.disabled = false;
    }

    async request(path, body) {
        const abort = new AbortController();
        const timer = setTimeout(() => abort.abort(), 20000);
        try {
            const response = await this.fetcher('/api/worldinfo/' + path, {
                method: 'POST', credentials: 'same-origin', cache: 'no-store',
                headers: this.context().getRequestHeaders(), body: JSON.stringify(body), signal: abort.signal,
            });
            if (!response.ok) throw new Error(`酒馆请求失败（HTTP ${response.status}），请检查登录和网络连接。`);
            if (path === 'edit') return;
            return await response.json();
        } catch (error) {
            if (error.name === 'AbortError') throw new Error('读取世界书超时，请检查网络后重试。');
            if (error.name === 'SyntaxError') throw new Error('酒馆返回的内容不是 JSON，请检查登录状态或反向代理配置。');
            if (error.name === 'TypeError') throw new Error('无法连接酒馆，请检查网络后重试。');
            throw error;
        } finally { clearTimeout(timer); }
    }

    async list() {
        const result = await this.request('list', {});
        if (!Array.isArray(result) || result.some(x => typeof x.file_id !== 'string')) throw new Error('酒馆返回的世界书列表格式不正确。');
        return result.map(x => ({ name: x.file_id, label: x.file_id })).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    }

    async read(name) {
        if (!name) throw new Error('请先选择世界书。');
        return clone(validateBook(await this.request('get', { name })));
    }

    async assertCurrent(name, expected) {
        if (this.disabled) throw new Error('插件已关闭，操作已停止。');
        if (this.requiresReload) throw new Error('上次操作的状态需要核对，请先保存或导出未保存内容，再刷新酒馆同步状态。');
        if (!(await this.list()).some(x => x.name === name)) throw new Error(`「${name}」已被删除或改名，请重新选择。`);
        const actual = await this.read(name);
        if (canonical(actual) !== canonical(expected)) throw new Error(`「${name}」在预览后发生了变化，请点击「重新载入」再配对。`);
        return actual;
    }

    cacheState(cache, name, afterWrite = false) {
        try {
            const present = cache.has(name);
            const value = present ? canonical(cache.get(name)) : null;
            if (present && typeof value !== 'string') throw new Error('invalid cache');
            return { present, value };
        } catch {
            if (afterWrite) this.requiresReload = true;
            throw new Error(afterWrite
                ? '写入后无法检查酒馆缓存，保存结果需要核对。请先保存或导出未保存内容，再刷新酒馆。'
                : '无法读取酒馆世界书缓存，已停止写入。');
        }
    }

    assertCacheUnchanged(cache, name, expected, afterWrite) {
        const current = this.cacheState(cache, name, afterWrite);
        if (current.present !== expected.present || current.value !== expected.value) {
            this.requiresReload = true;
            throw new Error(`${afterWrite ? '写入期间' : '等待期间'}「${name}」的酒馆缓存发生变化，未覆盖该缓存。请先保存或导出未保存内容，再核对服务器和缓存并刷新酒馆。`);
        }
    }

    /** 只改设置时使用：不写备份，直接保存并回读核验。 */
    async updateDirect(name, expected, next) {
        if (this.busy) throw new Error('当前操作尚未结束。');
        this.busy = true;
        try {
            validateBook(next);
            const before = await this.assertCurrent(name, expected);
            if (canonical(before) === canonical(next)) return { data: before, note: '内容相同，无需写入。' };
            return await this.saveVerified(name, before, next);
        } finally { this.busy = false; }
    }

    async saveVerified(name, before, intended) {
        if (this.disabled) throw new Error('插件已关闭，尚未写入。');
        this.checkEditor(name);
        let cache;
        try {
            cache = await this.cacheLoader();
            if (!cache || ['has', 'get', 'set'].some(key => typeof cache[key] !== 'function')) throw new Error('invalid cache');
        } catch {
            throw new Error('无法获取酒馆世界书缓存，已停止写入。请检查酒馆版本并刷新后重试。');
        }
        const cacheBefore = this.cacheState(cache, name);
        if (cacheBefore.present && cacheBefore.value !== canonical(before)) {
            throw new Error('酒馆编辑器与服务器内容尚未同步，请等待自动保存；请先保存或导出未保存内容，再核对并刷新酒馆。');
        }

        // The host uses a global one-second debounce; this reduces, but cannot eliminate, pending-save races.
        await this.wait(1100);
        if (this.disabled) throw new Error('插件已关闭，尚未写入。');
        this.checkEditor(name);
        this.assertCacheUnchanged(cache, name, cacheBefore, false);
        await this.assertCurrent(name, before);
        if (this.disabled) throw new Error('插件已关闭，尚未写入。');
        this.checkEditor(name);
        this.assertCacheUnchanged(cache, name, cacheBefore, false);

        let writeError;
        try { await this.request('edit', { name, data: clone(intended) }); }
        catch (error) { writeError = error; }
        let persisted;
        try { persisted = await this.read(name); }
        catch {
            this.requiresReload = true;
            throw new Error('保存结果尚未确认。请先保存或导出未保存内容，再刷新酒馆并核验，不要连续重复写入。');
        }
        this.assertCacheUnchanged(cache, name, cacheBefore, true);
        try { this.checkEditor(name); }
        catch {
            this.requiresReload = true;
            throw new Error('写入期间原生世界书编辑器的选择发生变化或无法确认，未覆盖缓存或重载编辑器。请先保存或导出未保存内容，再核对服务器并刷新酒馆。');
        }
        if (canonical(persisted) !== canonical(intended)) {
            this.requiresReload = true;
            throw new Error(canonical(persisted) === canonical(before)
                ? '服务器未确认保存本次修改，请先保存或导出未保存内容，再核对并刷新酒馆。'
                : '保存后的内容与预期不同，已停止后续操作，请先保存或导出未保存内容，再核对并刷新酒馆。');
        }
        try {
            cache.set(name, clone(persisted));
        } catch {
            this.requiresReload = true;
            throw new Error('服务器已回读，但无法同步酒馆缓存。请先保存或导出未保存内容，再核对并刷新酒馆。');
        }
        const synced = this.cacheState(cache, name, true);
        if (!synced.present || synced.value !== canonical(persisted)) {
            this.requiresReload = true;
            throw new Error('酒馆缓存同步未成功。请先保存或导出未保存内容，再核对并刷新酒馆。');
        }
        let note = '';
        try {
            const ctx = this.context();
            if (typeof ctx.eventSource?.emit !== 'function' || !ctx.eventTypes?.WORLDINFO_UPDATED) throw new Error('missing event');
            await ctx.eventSource.emit(ctx.eventTypes.WORLDINFO_UPDATED, name, clone(persisted));
        } catch { note = '文件已回读，但酒馆更新通知失败；请先保存或导出未保存内容，再刷新页面同步显示。'; }
        try { persisted = await this.read(name); }
        catch {
            this.requiresReload = true;
            throw new Error('通知后的保存结果尚未确认。请先保存或导出未保存内容，再刷新酒馆并核验，不要连续重复写入。');
        }
        this.assertCacheUnchanged(cache, name, synced, true);
        if (canonical(persisted) !== canonical(intended)) {
            this.requiresReload = true;
            throw new Error('通知后服务器内容与预期不同，已停止后续操作。请先保存或导出未保存内容，再核对并刷新酒馆。');
        }
        if (writeError) {
            this.requiresReload = true;
            note = '写入响应异常，但服务器回读与预期一致。请先保存或导出未保存内容，再核对并刷新酒馆。' + (note ? ' 更新通知也失败。' : '');
        }
        return { data: persisted, note };
    }

    close() { this.disabled = true; }
}
