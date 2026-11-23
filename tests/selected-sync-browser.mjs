// Real browser + local test host. This is not a live SillyTavern acceptance test.
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const devRoot = path.resolve(root, '../.devtools/node_modules');
async function dependency(name) {
    try { return await import(name); } catch {
        const base = name === 'playwright' ? process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES : devRoot;
        const require = createRequire(path.join(base || devRoot, 'package.json'));
        return import(pathToFileURL(require.resolve(name)).href);
    }
}
const playwright = await dependency('playwright');
const chromium = playwright.chromium || playwright.default.chromium;
const launch = { headless: true };
if (process.env.CHROMIUM_EXECUTABLE_PATH) launch.executablePath = process.env.CHROMIUM_EXECUTABLE_PATH;
if (process.env.USE_SPARTICUZ_CHROMIUM === '1') {
    const chromiumRuntime = (await dependency('@sparticuz/chromium')).default;
    launch.executablePath ||= await chromiumRuntime.executablePath();
    launch.args = chromiumRuntime.args;
}

const entry = (uid, comment, key, content, extra = {}) => ({ uid, comment, key, content, ...extra });
const book = entries => ({ entries: Object.fromEntries(entries.map(x => [x.uid, x])), customMetadata: '保留' });
const old = book([
    entry(0, '角色甲', ['角色甲'], '旧正文：<img src=x onerror="window.__injected=true">', { order: 100 }),
    entry(1, '共同标题', ['共同词'], '旧条目一'),
    entry(2, '共同标题', ['共同词'], '旧条目二'),
    entry(3, '无变化', ['无变化'], '同一段内容'),
    entry(4, '保留条目', ['保留'], '保留内容'),
    entry(5, '仅设置变化', ['设置'], '相同正文', { order: 10 }),
]);
const newer = book([
    entry(90, '角色甲', ['角色甲'], '新正文。'.repeat(300), { order: 200 }),
    entry(91, '共同标题', ['共同词'], '新共同正文'),
    entry(92, '无变化', ['无变化'], '同一段内容'),
    entry(93, '仅设置变化', ['设置'], '相同正文', { order: 20 }),
    entry(94, '新增条目', ['新增'], '可复制追加', { order: 77, position: 4, disable: true, displayIndex: 0, extensions: { custom: true } }),
]);
const state = { books: null, writes: 0, failWrite: false, failReadAfterWrite: false };
function reset() {
    state.books = new Map([['演示_目标书', structuredClone(old)], ['演示_母本', structuredClone(newer)]]);
    state.writes = 0; state.failWrite = false; state.failReadAfterWrite = false;
}
reset();

const server = http.createServer(async (req, res) => {
    try {
        if (req.url.startsWith('/api/worldinfo/')) {
            assert.equal(req.headers['x-csrf-token'], 'test-only');
            let text = ''; for await (const chunk of req) text += chunk;
            const body = JSON.parse(text || '{}');
            res.setHeader('Content-Type', 'application/json');
            if (req.url.endsWith('/list')) return res.end(JSON.stringify([...state.books.keys()].map(name => ({ file_id: name, name }))));
            if (req.url.endsWith('/get')) {
                if (state.failReadAfterWrite && state.writes) { res.statusCode = 503; return res.end('{}'); }
                return res.end(JSON.stringify(state.books.get(body.name) || { entries: {} }));
            }
            if (req.url.endsWith('/edit')) {
                state.writes++;
                if (state.failWrite) { res.statusCode = 500; return res.end('{}'); }
                state.books.set(body.name, body.data);
                return res.end('{"ok":true}');
            }
        }
        const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
        if (pathname === '/scripts/world-info.js') {
            res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
            return res.end('export const worldInfoCache = window.__host.cache;');
        }
        if (pathname.startsWith('/__test-fonts/') && process.env.TEST_FONT_DIR) {
            const fontRoot = path.resolve(process.env.TEST_FONT_DIR), fontFile = path.resolve(fontRoot, pathname.slice('/__test-fonts/'.length));
            if (!fontFile.startsWith(fontRoot + path.sep)) { res.statusCode = 403; return res.end(); }
            res.setHeader('Content-Type', fontFile.endsWith('.css') ? 'text/css' : 'font/woff2');
            return res.end(await fs.readFile(fontFile));
        }
        const file = path.resolve(root, '.' + pathname);
        if (!file.startsWith(root + path.sep)) { res.statusCode = 403; return res.end(); }
        let data = await fs.readFile(file);
        if (path.extname(file) === '.html' && process.env.TEST_FONT_DIR) data = data.toString().replace('</title>', '</title><link rel="stylesheet" href="/__test-fonts/index.css">');
        res.setHeader('Content-Type', ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json' })[path.extname(file)] || 'application/octet-stream');
        res.end(data);
    } catch { res.statusCode = 500; res.end('test server error'); }
});

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = 'http://127.0.0.1:' + server.address().port + '/tests/browser-harness.html';
const browser = await chromium.launch(launch);
const results = [];
let currentContext;

async function prepare(width = 390, height = 844, context = null, allowNoUpdates = false) {
    const ctx = context || await browser.newContext({ viewport: { width, height }, hasTouch: true });
    currentContext = ctx;
    const page = await ctx.newPage();
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(url); await page.waitForFunction(() => window.__ready);
    await page.getByRole('button', { name: '打开世界书更新器', exact: true }).click();
    await page.locator('[data-book="old"] option[value="book:演示_目标书"]').waitFor({ state: 'attached' });
    await page.locator('[data-book="old"]').selectOption('book:演示_目标书');
    await page.locator('[data-book="new"]').waitFor({ state: 'visible' });
    await page.waitForFunction(() => !document.querySelector('[data-book="new"]').disabled);
    await page.locator('[data-book="new"]').selectOption('book:演示_母本');
    await page.waitForFunction(() => !document.querySelector('[data-mode]').disabled);
    if (!allowNoUpdates) await page.waitForFunction(() => !document.querySelector('[data-action="replace"]').disabled);
    await page.evaluate(() => document.fonts.ready);
    return { page, ctx, errors };
}

try {
    for (const [width, height] of [[320, 568], [390, 844], [740, 360], [1280, 900]]) {
        reset();
        const { page, ctx, errors } = await prepare(width, height);
        const footer = await page.evaluate(() => [...document.querySelectorAll('.stwu-bottom button:not([hidden])')].map(el => {
            const r = el.getBoundingClientRect(); return { text: el.textContent, left: r.left, right: r.right, top: r.top, bottom: r.bottom };
        }));
        for (const rect of footer) assert.ok(rect.left >= 0 && rect.right <= width && rect.top >= 0 && rect.bottom <= height, JSON.stringify(rect));
        const row = id => page.locator(`[data-list="new"] [data-id="${id}"]`);
        await row(91).locator('input').check();
        await row(94).locator('input').check();
        await page.locator('[data-action="sync-selected"]').click();
        const dialog = page.locator('[data-sync-dialog]');
        await dialog.waitFor({ state: 'visible' });
        assert.equal(await dialog.locator('[data-sync-id]').count(), 3);
        assert.equal(await dialog.locator('[data-action="save-sync"]').isDisabled(), true);
        assert.match(await dialog.locator('[data-sync-summary]').textContent(), /1 条请指定/);
        const review = dialog.locator('[data-sync-id="91"]');
        await review.locator('[data-sync-action]').selectOption('replace');
        await review.locator('[data-sync-target]').fill('1');
        await review.locator('[data-sync-target]').dispatchEvent('change');
        assert.match(await dialog.locator('[data-sync-summary]').textContent(), /替换 2 条，复制 1 条/);
        assert.match(await review.locator('.stwu-sync-target-name').textContent(), /共同标题/);
        assert.equal(await dialog.locator('[data-action="save-sync"]').isEnabled(), true);
        if (width === 390 && process.env.STWU_SCREENSHOT) await page.screenshot({ path: process.env.STWU_SCREENSHOT });
        const bounds = await dialog.evaluate(el => { const r=el.getBoundingClientRect(); return {left:r.left, right:r.right, top:r.top, bottom:r.bottom, sw:el.scrollWidth, cw:el.clientWidth}; });
        assert.ok(bounds.left >= 0 && bounds.right <= width && bounds.top >= 0 && bounds.bottom <= height && bounds.sw <= bounds.cw + 1, JSON.stringify(bounds));
        await dialog.locator('[data-action="close-sync"]').click();
        assert.equal(state.writes, 0);
        await page.locator('[data-action="sync-selected"]').click();
        await dialog.locator('[data-sync-id="91"] [data-sync-action]').selectOption('replace');
        await dialog.locator('[data-sync-id="91"] [data-sync-target]').fill('1');
        await dialog.locator('[data-sync-id="91"] [data-sync-target]').dispatchEvent('change');
        await dialog.locator('[data-action="save-sync"]').click();
        await page.waitForFunction(() => document.querySelector('.stwu-notice').textContent.startsWith('已核验：替换 2 条，复制 1 条'));
        assert.equal(state.writes, 1);
        const saved = state.books.get('演示_目标书');
        assert.equal(saved.entries[0].content, newer.entries[90].content);
        assert.equal(saved.entries[1].content, newer.entries[91].content);
        assert.equal(saved.entries[2].content, old.entries[2].content);
        assert.ok(Object.values(saved.entries).some(item => item.comment === '新增条目'));
        await row(90).locator('input').check();
        await page.locator('[data-action="copy"]').click();
        assert.equal(await dialog.locator('[data-sync-id="90"] [data-sync-action]').inputValue(), 'copy-again');
        assert.match(await dialog.locator('[data-sync-summary]').textContent(), /复制 1 条/);
        await dialog.locator('[data-action="save-sync"]').click();
        await page.waitForFunction(() => document.querySelector('.stwu-notice').textContent.startsWith('已核验：替换 0 条，复制 1 条'));
        assert.equal(state.writes, 2);
        assert.equal(Object.values(state.books.get('演示_目标书').entries).filter(item => item.comment === '角色甲').length, 2);
        assert.deepEqual(errors, []);
        await ctx.close();
        console.log(`同步、人工替换、复制已有配对、取消与布局 ${width}×${height} 通过`);
    }
    reset();
    {
        const { page, ctx, errors } = await prepare();
        state.failWrite = true;
        await page.locator('[data-action="sync-selected"]').click();
        const dialog = page.locator('[data-sync-dialog]');
        await dialog.locator('[data-action="save-sync"]').click();
        await page.waitForFunction(() => document.querySelector('.stwu-notice').textContent.includes('服务器未确认保存'));
        assert.equal(await dialog.locator('[data-action="save-sync"]').isDisabled(), true);
        assert.match(await dialog.locator('[data-sync-summary]').textContent(), /重新载入/);
        assert.deepEqual(state.books.get('演示_目标书'), old);
        assert.deepEqual(errors, []);
        await ctx.close();
        console.log('保存失败时保留原书并锁定后续写入通过');
    }
    for (const changedBook of ['演示_目标书', '演示_母本']) {
        reset();
        const { page, ctx, errors } = await prepare();
        await page.locator('[data-action="sync-selected"]').click();
        const changed = structuredClone(state.books.get(changedBook));
        const id = Object.keys(changed.entries)[0]; changed.entries[id].content = '其他地方修改';
        state.books.set(changedBook, changed);
        const dialog = page.locator('[data-sync-dialog]');
        await dialog.locator('[data-action="save-sync"]').click();
        await page.waitForFunction(() => document.querySelector('[data-sync-summary]').textContent.includes('重新载入'));
        assert.equal(await dialog.locator('[data-action="save-sync"]').isDisabled(), true);
        assert.equal(state.writes, 0); assert.deepEqual(errors, []);
        await ctx.close();
        console.log(`${changedBook} 在预览后变化，拒绝写入并在预览中提示通过`);
    }
    reset();
    {
        state.books.set('演示_目标书', book(Array.from({ length: 500 }, (_, i) => entry(i, `角色${i}`, [`角色${i}`], '旧'))));
        state.books.set('演示_母本', book(Array.from({ length: 1000 }, (_, i) => entry(i + 1000, `角色${i}`, [`角色${i}`], '新'))));
        const { page, ctx, errors } = await prepare(390, 844);
        await page.locator('[data-selection-category]').selectOption('new');
        await page.locator('[data-action="toggle-selection"]').click();
        await page.locator('[data-action="sync-selected"]').click();
        const dialog = page.locator('[data-sync-dialog]');
        assert.equal(await dialog.locator('[data-sync-id]').count(), 1000);
        assert.match(await dialog.locator('[data-sync-summary]').textContent(), /替换 500 条，复制 500 条/);
        await dialog.locator('[data-action="close-sync"]').click();
        assert.equal(state.writes, 0); assert.deepEqual(errors, []);
        await ctx.close();
        console.log('千条勾选预览 500 替换与 500 复制通过');
    }
} finally {
    if (currentContext) await currentContext.close().catch(() => {});
    await browser.close();
    await new Promise(resolve => server.close(resolve));
}
