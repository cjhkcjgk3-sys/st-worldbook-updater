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
    state.books = new Map([['演示_旧版', structuredClone(old)], ['演示_新版', structuredClone(newer)]]);
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
    await page.locator('[data-book="old"] option[value="book:演示_旧版"]').waitFor({ state: 'attached' });
    await page.locator('[data-book="old"]').selectOption('book:演示_旧版');
    await page.locator('[data-book="new"]').waitFor({ state: 'visible' });
    await page.waitForFunction(() => !document.querySelector('[data-book="new"]').disabled);
    await page.locator('[data-book="new"]').selectOption('book:演示_新版');
    await page.waitForFunction(() => !document.querySelector('[data-mode]').disabled);
    if (!allowNoUpdates) await page.waitForFunction(() => !document.querySelector('[data-action="replace"]').disabled);
    await page.evaluate(() => document.fonts.ready);
    return { page, ctx, errors };
}

const clickRow = (page, side, id) => page.locator(`[data-list="${side}"] [data-id="${id}"] .stwu-entry-button`).click();
async function openTool(page, cls) {
    const details = page.locator(`.${cls}`);
    if (await details.getAttribute('open') === null) await page.locator(`.${cls} > summary`).click();
}

async function assertLayout(page) {
    const metrics = await page.evaluate(() => {
        const d = document.querySelector('.stwu-dialog'), panels = [...document.querySelectorAll('.stwu-pane')].map(x => x.getBoundingClientRect());
        const replaceBtn = document.querySelector('[data-action="replace"]').getBoundingClientRect();
        const dRect = d.getBoundingClientRect();
        const entryWin = document.querySelector('.stwu-entry-window').getBoundingClientRect();
        const bodyWin = document.querySelector('.stwu-body-window').getBoundingClientRect();
        const previewOpen = document.querySelector('.stwu-workspace').dataset.previewOpen === 'true';
        return {
            viewport: innerWidth,
            width: dRect.width,
            overflow: d.scrollWidth > d.clientWidth + 1,
            nativePopup: d.classList.contains('popup') && !!d.querySelector('.popup-body .popup-content'),
            paneWidths: panels.map(x => x.width),
            visiblePanes: panels.filter(x => x.width > 0).length,
            listHeight: document.querySelector('.stwu-list').clientHeight,
            replaceBottom: replaceBtn.bottom,
            dialogBottom: dRect.bottom,
            previewOpen,
            noOverlap: !previewOpen || entryWin.bottom <= bodyWin.top + 1,
        };
    });
    assert.ok(!metrics.overflow, JSON.stringify(metrics));
    assert.ok(metrics.width <= metrics.viewport + 1, JSON.stringify(metrics));
    assert.equal(metrics.nativePopup, true, JSON.stringify(metrics));
    assert.equal(metrics.visiblePanes, 2, JSON.stringify(metrics));
    assert.ok(Math.abs(metrics.paneWidths[0] - metrics.paneWidths[1]) <= 2, JSON.stringify(metrics));
    assert.ok(metrics.listHeight > 30, JSON.stringify(metrics));
    assert.ok(metrics.replaceBottom <= metrics.dialogBottom + 2, JSON.stringify(metrics));
    assert.equal(metrics.noOverlap, true, JSON.stringify(metrics));
}

try {
    for (const [w, h] of [[320, 568], [360, 720], [390, 844], [768, 1024], [1280, 900], [600, 360], [640, 360], [740, 360]]) {
        reset(); const { page, ctx, errors } = await prepare(w, h);
        await assertLayout(page);
        // Header buttons directly visible (reload, toggle-size, close)
        for (const act of ['reload', 'toggle-size', 'close']) {
            assert.equal(await page.locator(`.stwu-header-actions [data-action="${act}"]`).isVisible(), true);
        }
        const defaultWidth = await page.locator('.stwu-dialog').evaluate(node => node.getBoundingClientRect().width);
        await page.locator('[data-action="toggle-size"]').click();
        assert.equal(await page.locator('.stwu-dialog').evaluate(node => node.classList.contains('stwu-expanded')), true);
        await assertLayout(page);
        const expandedWidth = await page.locator('.stwu-dialog').evaluate(node => node.getBoundingClientRect().width);
        assert.ok(expandedWidth > defaultWidth, JSON.stringify({ viewport: w, defaultWidth, expandedWidth }));
        await page.locator('[data-action="toggle-size"]').click();
        await assertLayout(page);

        // Verify scope drawer stays strictly inside dialog bounds (no mobile right overflow!)
        await openTool(page, 'stwu-scope');
        const drawerBounds = await page.evaluate(() => {
            const d = document.querySelector('.stwu-dialog').getBoundingClientRect();
            const c = document.querySelector('.stwu-scope .stwu-tool-content').getBoundingClientRect();
            return { dLeft: d.left, dRight: d.right, cLeft: c.left, cRight: c.right, viewportW: innerWidth };
        });
        assert.ok(drawerBounds.cLeft >= drawerBounds.dLeft - 1 && drawerBounds.cRight <= drawerBounds.dRight + 1 && drawerBounds.cRight <= drawerBounds.viewportW + 1, JSON.stringify(drawerBounds));
        // Click outside closes open drawer
        await page.locator('.stwu-header h2').click();
        assert.equal(await page.locator('.stwu-scope').getAttribute('open'), null);

        // Preview & single reused cycle-split button + close-preview button
        await clickRow(page, 'old', '0');
        await page.waitForFunction(() => document.querySelector('.stwu-workspace').dataset.previewOpen === 'true');
        await assertLayout(page);
        await page.locator('[data-action="cycle-split"]').click();
        assert.equal(await page.locator('.stwu-workspace').getAttribute('data-split'), 'body');
        await assertLayout(page);
        await page.locator('[data-action="cycle-split"]').click();
        assert.equal(await page.locator('.stwu-workspace').getAttribute('data-split'), 'list');
        await assertLayout(page);
        await page.locator('[data-action="cycle-split"]').click();
        assert.equal(await page.locator('.stwu-workspace').getAttribute('data-split'), 'balanced');
        assert.match(await page.locator('[data-preview-content="old"]').textContent(), /onerror/);
        assert.equal(await page.locator('.stwu-preview img').count(), 0);
        assert.equal(await page.evaluate(() => window.__injected), undefined);
        assert.equal(await page.locator('[data-list="old"] [data-id="0"] [aria-pressed="true"]').count(), 1);
        await page.locator('[data-action="close-preview"]').click();
        assert.equal(await page.locator('.stwu-workspace').getAttribute('data-preview-open'), 'false');

        assert.deepEqual(errors, []);
        results.push(`布局 ${w}×${h}、抽屉防溢出、双窗防叠层、高度循环切换与纯文本预览通过`);
        await ctx.close();
    }

    // 150-entry pagination & page jump
    reset(); {
        const manyBook = book(Array.from({ length: 150 }, (_, i) => entry(i, `角色 ${String(i + 1).padStart(3, '0')}`, [`角色 ${i + 1}`], `正文 ${i + 1}`)));
        const manyNew = book(Array.from({ length: 150 }, (_, i) => entry(i + 500, `角色 ${String(i + 1).padStart(3, '0')}`, [`角色 ${i + 1}`], `新版正文 ${i + 1}`)));
        state.books = new Map([['演示_旧版', manyBook], ['演示_新版', manyNew]]);
        const { page, ctx } = await prepare(390, 844);
        assert.equal(await page.locator('[data-list="old"] .stwu-entry').count(), 25);
        assert.equal(await page.locator('[data-page-status="old"]').textContent(), '1 / 6');
        await page.locator('[data-page-step="old:1"]').click();
        assert.equal(await page.locator('[data-page-status="old"]').textContent(), '2 / 6');
        await clickRow(page, 'old', '30');
        assert.equal(await page.locator('[data-page-status="new"]').textContent(), '2 / 6');
        assert.match(await page.locator('[data-preview-content="old"]').textContent(), /正文 31/);
        await page.locator('[data-page-size="old"]').selectOption('50');
        assert.equal(await page.locator('[data-list="old"] .stwu-entry').count(), 50);
        assert.equal(await page.locator('[data-page-status="old"]').textContent(), '1 / 3');

        // Independent drag-resizing of entry window and body window
        const entryWin = page.locator('.stwu-entry-window'), bodyWin = page.locator('.stwu-body-window');
        const entryHandle = page.locator('[data-resize-handle="entry"]'), bodyHandle = page.locator('[data-resize-handle="body"]');
        const hOf = loc => loc.evaluate(el => el.getBoundingClientRect().height);
        const entryBefore = await hOf(entryWin), bodyBefore = await hOf(bodyWin);
        const eBox = await entryHandle.boundingBox();
        await page.mouse.move(eBox.x + eBox.width / 2, eBox.y + eBox.height / 2);
        await page.mouse.down();
        await page.mouse.move(eBox.x + eBox.width / 2, eBox.y + eBox.height / 2 + 120, { steps: 5 });
        await page.mouse.up();
        const entryAfter = await hOf(entryWin);
        assert.ok(entryAfter > entryBefore + 90, JSON.stringify({ entryBefore, entryAfter }));
        const bodyAfterE = await hOf(bodyWin);
        assert.ok(bodyAfterE >= 150, JSON.stringify({ entryBefore, entryAfter, bodyBefore, bodyAfterE }));

        await bodyHandle.scrollIntoViewIfNeeded();
        const bBox = await bodyHandle.boundingBox();
        await page.mouse.move(bBox.x + bBox.width / 2, bBox.y + bBox.height / 2);
        await page.mouse.down();
        await page.mouse.move(bBox.x + bBox.width / 2, bBox.y + bBox.height / 2 + 100, { steps: 5 });
        await page.mouse.up();
        const bodyAfter = await hOf(bodyWin);
        assert.ok(bodyAfter > bodyAfterE + 80, JSON.stringify({ bodyAfterE, bodyAfter }));
        assert.ok(Math.abs(await hOf(entryWin) - entryAfter) <= 2);
        await assertLayout(page);

        // Preset cycle button resets manual inline heights cleanly
        await page.locator('[data-action="cycle-split"]').click();
        assert.equal(await entryWin.evaluate(el => el.style.height), '');
        assert.equal(await bodyWin.evaluate(el => el.style.height), '');

        results.push('150 条目分页、跨侧自动翻页与双窗独立拉伸/复位通过');
        await ctx.close();
    }

    // VisualViewport keyboard shrink
    reset(); {
        const { page, ctx } = await prepare();
        await page.locator('[data-search="old"]').focus();
        await page.evaluate(() => {
            Object.defineProperty(visualViewport, 'height', { value: 380, configurable: true });
            visualViewport.dispatchEvent(new Event('resize'));
        });
        const metrics = await page.evaluate(() => ({
            compact: document.querySelector('.stwu-dialog').classList.contains('stwu-keyboard'),
            listHeight: document.querySelector('.stwu-list').clientHeight,
            bottom: document.querySelector('[data-action="replace"]').getBoundingClientRect().bottom,
            dialogBottom: document.querySelector('.stwu-dialog').getBoundingClientRect().bottom,
        }));
        assert.equal(metrics.compact, true);
        assert.ok(metrics.listHeight > 30);
        assert.ok(metrics.bottom <= metrics.dialogBottom + 2, JSON.stringify(metrics));
        results.push('模拟输入法弹出视口收缩后，列表与底栏仍可见通过');
        await ctx.close();
    }

    // Manual pair + replace + reload + onDisable cleanup
    reset(); {
        const { page, ctx, errors } = await prepare();
        await clickRow(page, 'old', '1');
        await clickRow(page, 'new', '91');
        await openTool(page, 'stwu-pairbar');
        assert.equal(await page.locator('[data-pair-toggle]').textContent(), '配对所选');
        await page.locator('[data-pair-toggle]').click();
        assert.equal(await page.locator('[data-pair-toggle]').textContent(), '解除配对');
        assert.match(await page.locator('.stwu-selection:not(.stwu-selection-compact)').textContent(), /可替换 2 组/);
        page.once('dialog', d => d.accept());
        await page.locator('[data-action="replace"]').click();
        await page.waitForFunction(() => document.querySelector('.stwu-notice').textContent.startsWith('已核验并替换'));
        assert.equal(state.writes, 1);
        const persisted = state.books.get('演示_旧版');
        assert.equal(persisted.entries[0].uid, 0);
        assert.equal(persisted.entries[1].content, '新共同正文');
        assert.equal(persisted.customMetadata, '保留');
        await page.locator('.stwu-header-actions [data-action="reload"]').click();
        await page.waitForFunction(() => !document.querySelector('[data-mode]').disabled);
        assert.deepEqual(errors, []);
        await page.evaluate(() => window.__extension.onDisable());
        assert.equal(await page.locator('.stwu-dialog,#st-worldbook-updater-launcher').count(), 0);
        assert.equal(await page.evaluate(() => [...window.__host.events.values()].reduce((n, s) => n + s.size, 0)), 0);
        results.push('二合一配对/解除、替换核验、刷新与禁用清理通过');
        await ctx.close();
    }

    // Copy selected + file upload + error protections
    reset(); {
        const { page, ctx } = await prepare();
        await page.locator('[data-list="new"] [data-id="90"] input').uncheck();
        await page.locator('[data-list="new"] [data-id="94"] input').check();
        page.once('dialog', d => d.accept());
        await page.locator('[data-action="copy"]').click();
        await page.waitForFunction(() => document.querySelector('.stwu-notice').textContent.startsWith('已核验：复制 1 条'));
        assert.equal(Object.keys(state.books.get('演示_旧版').entries).length, 7);
        await page.locator('[data-file]').setInputFiles({ name: '坏文件.json', mimeType: 'application/json', buffer: Buffer.from('{') });
        await page.waitForFunction(() => document.querySelector('.stwu-notice').textContent.includes('JSON 格式不正确'));
        page.once('dialog', d => d.accept());
        await page.locator('[data-file]').setInputFiles({ name: '更新文件.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(newer)) });
        await page.waitForFunction(() => document.querySelector('[data-book="new"]').value === 'file:');
        results.push('复制所选条目、坏 JSON 拒绝与本地文件载入通过');
        await ctx.close();
    }

    reset(); {
        const { page, ctx } = await prepare();
        state.failWrite = true;
        page.once('dialog', d => d.accept());
        await page.locator('[data-action="replace"]').click();
        await page.waitForFunction(() => document.querySelector('.stwu-notice').textContent.includes('服务器未确认保存'));
        assert.equal(await page.locator('[data-action="replace"]').isDisabled(), true);
        assert.deepEqual(state.books.get('演示_旧版'), old);
        results.push('HTTP 保存失败锁保护且不损坏原书通过');
        await ctx.close();
    }

    const report = { pass: true, browser: await browser.version(), results };
    if (process.env.REPORT_FILE) await fs.writeFile(process.env.REPORT_FILE, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report, null, 2));
} finally {
    await currentContext?.close().catch(() => {});
    await browser.close();
    await new Promise(resolve => server.close(resolve));
}
