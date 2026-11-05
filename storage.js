const DB_NAME = 'st-worldbook-updater';

export class BackupStore {
    constructor(scope, indexedDB = globalThis.indexedDB) {
        this.scope = scope;
        this.indexedDB = indexedDB;
        this.opening = null;
    }

    open() {
        if (!this.indexedDB) return Promise.reject(new Error('浏览器未提供本地备份存储，请退出无痕模式后重试。'));
        if (!this.opening) this.opening = new Promise((resolve, reject) => {
            let blocked = false;
            const request = this.indexedDB.open(DB_NAME, 1);
            request.onupgradeneeded = () => request.result.createObjectStore('backups', { keyPath: 'key' });
            request.onerror = () => { this.opening = null; reject(new Error('本地备份存储无法打开。')); };
            request.onblocked = () => { blocked = true; this.opening = null; reject(new Error('备份存储被其他页面占用，请关闭旧页面后重试。')); };
            request.onsuccess = () => {
                const db = request.result;
                if (blocked) { db.close(); return; }
                db.onversionchange = () => { db.close(); this.opening = null; };
                resolve(db);
            };
        });
        return this.opening;
    }

    async transact(mode, operation) {
        const db = await this.open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction('backups', mode);
            let result;
            tx.oncomplete = () => resolve(result);
            tx.onabort = tx.onerror = () => reject(new Error('备份未能保存，请检查浏览器存储空间。'));
            try {
                const req = operation(tx.objectStore('backups'));
                req.onsuccess = () => { result = req.result; };
            } catch { tx.abort(); reject(new Error('备份未能保存，请检查浏览器存储空间。')); }
        });
    }

    key(name) { return JSON.stringify([this.scope, name]); }
    get(name) { return this.transact('readonly', store => store.get(this.key(name))); }
    put(name, value) { return this.transact('readwrite', store => store.put({ ...value, key: this.key(name), name })); }
    async close() {
        if (this.opening) { const db = await this.opening.catch(() => null); db?.close(); this.opening = null; }
    }
}
