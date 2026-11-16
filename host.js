import { canonical, clone, validateBook } from './core.js';

export function hostContext() {
    if (typeof globalThis.structuredClone !== 'function') throw new Error('当前浏览器缺少数据复制能力，请更新浏览器或 Android WebView。');
    const ctx = globalThis.SillyTavern?.getContext?.();
    const missing = ['getRequestHeaders', 'loadWorldInfo', 'saveWorldInfo'].filter(k => typeof ctx?.[k] !== 'function');
    if (missing.length) throw new Error('当前酒馆缺少世界书读写能力，请使用 SillyTavern 1.18.0 或更新版本。');
    return ctx;
}

export class WorldbookService {
    constructor(context = hostContext, fetcher = globalThis.fetch.bind(globalThis)) {
        this.context = context;
        this.fetcher = fetcher;
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
            if (!response.ok) throw new Error(`酒馆读取失败（HTTP ${response.status}），请检查登录和网络连接。`);
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
        if (this.requiresReload) throw new Error('上次保存未完成核验，请先刷新酒馆同步状态，再继续操作。');
        if (!(await this.list()).some(x => x.name === name)) throw new Error('原世界书已被删除或改名，请重新选择。');
        const actual = await this.read(name);
        if (canonical(actual) !== canonical(expected)) throw new Error('原世界书在预览后发生了变化，请点击“重新载入”再配对。');
        const cached = await this.context().loadWorldInfo(name);
        if (cached && canonical(cached) !== canonical(actual)) throw new Error('酒馆编辑器与服务器内容尚未同步，请等待自动保存；仍有提示时刷新酒馆后重试。');
        return actual;
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
        let writeError;
        try { await this.context().saveWorldInfo(name, clone(intended), true); }
        catch (error) { writeError = error; }
        let persisted;
        try { persisted = await this.read(name); }
        catch {
            this.requiresReload = true;
            throw new Error('保存结果尚未确认。请刷新酒馆后重新选择这本书核验，不要连续重复写入。');
        }
        if (canonical(persisted) !== canonical(intended)) {
            this.requiresReload = true;
            throw new Error(canonical(persisted) === canonical(before)
                ? '服务器未保存本次修改，请检查连接并刷新酒馆后重试。'
                : '保存后的内容与预期不同，已停止后续操作，请刷新酒馆核对。');
        }
        let note = writeError ? '文件保存已核验；酒馆刷新通知出错，请刷新页面同步显示。' : '';
        try {
            const reload = this.context().reloadWorldInfoEditor;
            if (typeof reload === 'function') reload(name);
            else note = note || '文件保存已核验，请手动重新打开世界书编辑器。';
        } catch { note = note || '文件保存已核验，请手动重新打开世界书编辑器。'; }
        return { data: persisted, note };
    }

    close() { this.disabled = true; }
}
