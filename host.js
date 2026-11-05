import { canonical, clone, validateBook } from './core.js';
import { BackupStore } from './storage.js';

export function hostContext() {
    if (typeof globalThis.structuredClone !== 'function') throw new Error('当前浏览器缺少数据复制能力，请更新浏览器或 Android WebView。');
    const ctx = globalThis.SillyTavern?.getContext?.();
    const missing = ['getRequestHeaders', 'loadWorldInfo', 'saveWorldInfo'].filter(k => typeof ctx?.[k] !== 'function');
    if (missing.length) throw new Error('当前酒馆缺少世界书读写能力，请使用 SillyTavern 1.18.0 或更新版本。');
    return ctx;
}

export function backupScope(ctx) {
    const account = ctx.accountStorage;
    if (typeof account?.getItem !== 'function' || typeof account?.setItem !== 'function') throw new Error('当前酒馆不支持账号隔离的备份存储。');
    const key = 'st-worldbook-updater.backup-scope';
    let scope = account.getItem(key);
    if (!scope) {
        scope = typeof ctx.uuidv4 === 'function' ? ctx.uuidv4() : [...globalThis.crypto.getRandomValues(new Uint32Array(4))].join('-');
        account.setItem(key, scope);
    }
    return scope;
}

export class WorldbookService {
    constructor(context = hostContext, fetcher = globalThis.fetch.bind(globalThis), store = null) {
        this.context = context;
        this.fetcher = fetcher;
        this.store = store || new BackupStore(backupScope(context()));
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

    async inspectBackup(name, current) {
        let backup = await this.store.get(name);
        if (!backup) return { backup: null, message: '' };
        if (['pending', 'restoring'].includes(backup.status)) {
            const restoring = backup.status === 'restoring';
            const intended = restoring ? backup.before : backup.after;
            const before = restoring ? backup.restoreBefore : backup.before;
            backup = { ...backup, status: canonical(current) === canonical(intended) ? (restoring ? 'restored' : 'applied') : canonical(current) === canonical(before) ? 'not-applied' : 'uncertain' };
            await this.store.put(name, backup);
        }
        const message = backup.status === 'uncertain' ? '上次操作结果与当前内容不同，备份已保留；请先核对内容。'
            : backup.status === 'not-applied' ? '上次操作未写入当前世界书，备份已保留。'
                : backup.status === 'applied' ? '上次更新已核验，可恢复更新前的备份。'
                    : backup.status === 'restored' ? '世界书已恢复备份。' : '';
        return { backup, message };
    }

    async saveAndVerify(name, before, intended, backup, completedStatus) {
        if (this.disabled) throw new Error('插件已关闭，尚未写入。备份已保留。');
        let writeError;
        try { await this.context().saveWorldInfo(name, clone(intended), true); }
        catch (error) { writeError = error; }
        let persisted;
        try { persisted = await this.read(name); }
        catch {
            this.requiresReload = true;
            throw new Error('保存结果尚未确认，备份已保留。请刷新酒馆，重新选择这本书核验；不要连续重复替换。');
        }
        const equal = canonical(persisted) === canonical(intended);
        const status = equal ? completedStatus : canonical(persisted) === canonical(before) ? 'not-applied' : 'uncertain';
        let note = '';
        const settledBackup = { ...backup, status };
        if (equal) delete settledBackup.restoreBefore;
        try { await this.store.put(name, settledBackup); }
        catch { note = '备份副本仍保留，但操作状态未能更新。'; }
        if (!equal) {
            this.requiresReload = true;
            throw new Error(status === 'not-applied'
                ? '服务器未保存本次修改，备份已保留。请检查连接并刷新酒馆后重试。'
                : '保存后的内容与预期不同，已停止后续操作。备份已保留，请刷新酒馆核对。');
        }
        // A host event listener can reject after the server has already saved. Readback is authoritative.
        if (writeError) note = '文件保存已核验；酒馆刷新通知出错，请刷新页面同步显示。';
        try {
            const reload = this.context().reloadWorldInfoEditor;
            if (typeof reload === 'function') reload(name);
            else note = '文件保存已核验，请手动重新打开世界书编辑器。';
        } catch { note = '文件保存已核验，请手动重新打开世界书编辑器。'; }
        return { data: persisted, note };
    }

    async update(name, expected, next) {
        if (this.busy) throw new Error('当前操作尚未结束。');
        this.busy = true;
        try {
            validateBook(next);
            const before = await this.assertCurrent(name, expected);
            if (canonical(before) === canonical(next)) return { data: before, note: '内容相同，无需替换。' };
            const backup = { before: clone(before), after: clone(next), date: new Date().toISOString(), status: 'pending' };
            await this.store.put(name, backup);
            // Recheck after local persistence so a changed target never silently uses an obsolete preview.
            await this.assertCurrent(name, expected);
            return await this.saveAndVerify(name, before, next, backup, 'applied');
        } finally { this.busy = false; if (this.disabled) await this.store.close?.(); }
    }

    async restore(name, expectedCurrent, backup) {
        if (this.busy) throw new Error('当前操作尚未结束。');
        if (!backup?.before) throw new Error('没有可恢复的备份。');
        this.busy = true;
        try {
            const before = await this.assertCurrent(name, expectedCurrent);
            validateBook(backup.before);
            const attempt = { ...backup, status: 'restoring', restoreBefore: clone(before) };
            await this.store.put(name, attempt);
            await this.assertCurrent(name, expectedCurrent);
            return await this.saveAndVerify(name, before, backup.before, attempt, 'restored');
        } finally { this.busy = false; if (this.disabled) await this.store.close?.(); }
    }

    close() { this.disabled = true; if (!this.busy) return this.store.close?.(); }
}
