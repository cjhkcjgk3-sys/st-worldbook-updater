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

const clickRow = (page, side, id) => page.locator(`[data-list="${side}"] [data-id="${id}"] .stwu-entry-button`).click();
async function openTool(page, cls) {
    const details = page.locator(`.${cls}`);
    if (await details.getAttribute('open') === null) await page.locator(`.${cls} > summary`).click();
}

async function assertOneLineButton(button) {
    const label = await button.textContent();
    const metrics = await button.evaluate(node => {
        const range = document.createRange();
        range.selectNodeContents(node);
        return {
            lines: new Set([...range.getClientRects()].map(rect => rect.top)).size,
            overflow: node.scrollWidth > node.clientWidth + 1,
        };
    });
    assert.deepEqual(metrics, { lines: 1, overflow: false }, label);
}

async function assertLayout(page) {
    await page.locator('[data-action="replace"]').scrollIntoViewIfNeeded();
    const metrics = await page.evaluate(() => {
        const d = document.querySelector('.stwu-dialog'), panels = [...document.querySelectorAll('.stwu-pane')].map(x => x.getBoundingClientRect());
        const replaceBtn = document.querySelector('[data-action="replace"]').getBoundingClientRect();
        const scroller = document.querySelector('.stwu-layout'), dRect = d.getBoundingClientRect();
        const entryWin = document.querySelector('.stwu-entry-window').getBoundingClientRect();
        const bodyWin = document.querySelector('.stwu-body-window').getBoundingClientRect();
        const previewOpen = document.querySelector('.stwu-workspace').dataset.previewOpen === 'true';
        return {
            viewport: innerWidth,
            width: dRect.width,
            overflow: d.scrollWidth > d.clientWidth + 1,
            overflowY: getComputedStyle(scroller).overflowY,
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
    assert.equal(metrics.overflowY, 'auto', JSON.stringify(metrics));
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
        await assertOneLineButton(page.getByRole('button', { name: '复制母本条目名', exact: true }));
        // Click outside closes open drawer
        await page.locator('.stwu-header h2').click();
        assert.equal(await page.locator('.stwu-scope').getAttribute('open'), null);
        await openTool(page, 'stwu-settings');
        const settingOperation = page.locator('[data-set-operation]');
        const settingAction = page.locator('[data-action="apply-settings"]');
        for (const mode of ['new', 'old', 'sync']) {
            await settingOperation.selectOption(mode);
            await assertOneLineButton(settingAction);
        }
        await page.locator('.stwu-header h2').click();

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
        results.push(`布局 ${w}×${h}、抽屉防溢出、名单与设置按钮保持单行、双窗防叠层、高度循环切换与纯文本预览通过`);
        await ctx.close();
    }

    reset(); {
        const makeRow = (id, target, content) => entry(target ? id : 100 + id, `角色 ${id + 1}`, [`角色 ${id + 1}`], content, {
            displayIndex: target ? 11 - id : id,
        });
        const target = book(Array.from({ length: 12 }, (_, id) => makeRow(id, true, '旧正文')));
        const mother = book(Array.from({ length: 12 }, (_, id) => makeRow(id, false, [2, 9].includes(id) ? '新正文' : '旧正文')));
        state.books.set('演示_目标书', target);
        state.books.set('演示_母本', mother);
        const { page, ctx, errors } = await prepare();
        const firstIds = (side, n) => page.locator(`[data-list="${side}"] [data-id]`)
            .evaluateAll((rows, count) => rows.slice(0, count).map(row => row.dataset.id), n);
        assert.deepEqual(await firstIds('new', 2), ['102', '109']);
        assert.deepEqual(await firstIds('old', 2), ['2', '9']);
        await page.locator('[data-list="old"] [data-id="2"] input').uncheck();
        assert.deepEqual(await firstIds('new', 2), ['109', '100']);
        assert.deepEqual(await firstIds('old', 2), ['9', '0']);
        await page.locator('[data-list="new"] [data-id="107"] input').check();
        assert.deepEqual(await firstIds('new', 2), ['107', '109']);
        assert.deepEqual(await firstIds('old', 2), ['7', '9']);
        assert.equal(await page.locator('[data-list="old"] [data-id="7"] input').isChecked(), true);
        await openTool(page, 'stwu-scope');
        await page.locator('[data-scope-pin]').uncheck();
        assert.deepEqual(await firstIds('new', 2), ['100', '101']);
        assert.deepEqual(await firstIds('old', 2), ['11', '10']);
        await page.locator('[data-scope-pin]').check();
        assert.deepEqual(await firstIds('new', 2), ['107', '109']);
        assert.deepEqual(await firstIds('old', 2), ['7', '9']);
        assert.equal(state.writes, 0);
        assert.deepEqual(errors, []);
        results.push('配对 3、10 勾选后两栏相邻，改单项勾选和切换置顶即时重排且不写入');
        await ctx.close();
    }

    reset(); {
        const common = Array.from({ length: 30 }, (_, i) => entry(i, `角色 ${i}`, [], '旧正文'));
        const target = book([...common, entry(80, '尼可', ['尼可·莱恩', '魔女N', '尼可'], '旧正文'),
            entry(81, '露娜', [], '待核对甲'), entry(82, '露娜', [], '待核对乙'),
            entry(83, '爱好', ['爱', '角色'], '目标独有'), entry(84, '爱可菲', [], '目标独有'), entry(85, '爱诺', [], '目标独有')]);
        const mother = book([...common.map(row => ({ ...row, uid: row.uid + 100, content: '新正文' })),
            entry(180, '尼可·莱恩', ['尼可·莱恩', '魔女「N」', '喧寂于心'], '新正文'),
            entry(181, '露娜·费尔', [], '待核对正文'), entry(182, '爱情', ['爱', '角色'], '新条目')]);
        state.books.set('演示_目标书', target);
        state.books.set('演示_母本', mother);
        const { page, ctx, errors } = await prepare(320, 568);
        const status = (side, id) => page.locator(`[data-list="${side}"] [data-id="${id}"] .stwu-entry-status`);
        const sourceJump = page.locator('[data-review-jump="new"]');
        const targetJump = page.locator('[data-review-jump="old"]');
        assert.equal(await sourceJump.textContent(), '待核对 1');
        assert.equal(await targetJump.textContent(), '待核对 2');
        await sourceJump.click();
        assert.equal(await page.locator('[data-page-status="new"]').textContent(), '2 / 2');
        assert.match(await status('new', 180).textContent(), /置顶 · 配对 \d+ · 有变化/);
        assert.equal(await status('new', 181).textContent(), '置顶 · 待核对 · 目标书候选 2 条（露娜）');
        await targetJump.click();
        assert.equal(await page.locator('[data-page-status="old"]').textContent(), '2 / 2');
        assert.equal(await status('old', 80).textContent(), await status('new', 180).textContent());
        assert.equal(await status('old', 81).textContent(), '置顶 · 待核对');
        assert.equal(await status('old', 82).textContent(), '置顶 · 待核对');
        assert.equal(await status('new', 182).textContent(), '未配对 · 可复制');
        assert.equal(await status('old', 83).textContent(), '目标书独有 · 保留');
        const category = page.locator('[data-selection-category]');
        const bulk = page.locator('[data-action="toggle-selection"]');
        const sourceCheck = id => page.locator(`[data-list="new"] [data-id="${id}"] input`);
        await category.selectOption('review');
        assert.equal(await bulk.textContent(), '勾选 1 条');
        await bulk.click();
        assert.equal(await sourceCheck(181).isChecked(), true);
        assert.equal(await sourceCheck(182).isChecked(), false);
        await page.locator('[data-search="new"]').fill('尼可');
        assert.equal(await bulk.isDisabled(), true);
        await page.locator('[data-search="new"]').fill('');
        await category.selectOption('new');
        assert.equal(await bulk.textContent(), '勾选 1 条');
        await bulk.click();
        await category.selectOption('paired');
        assert.equal(await bulk.textContent(), '取消勾选 31 条');
        await bulk.click();
        assert.equal(await sourceCheck(181).isChecked(), true);
        await page.locator('[data-page-step="new:1"]').click();
        assert.equal(await sourceCheck(180).isChecked(), false);
        assert.equal(await sourceCheck(182).isChecked(), true);
        assert.equal(await page.locator('[data-list="old"] [data-id="80"] input').isChecked(), false);
        await category.selectOption('review');
        await bulk.click();
        assert.equal(await sourceCheck(182).isChecked(), true);
        await page.locator('[data-page-step="new:-1"]').click();
        assert.equal(await sourceCheck(181).isChecked(), false);
        const bulkLines = await bulk.evaluate(button => {
            const text = document.createRange();
            text.selectNodeContents(button);
            return text.getClientRects().length;
        });
        assert.equal(bulkLines, 1);
        await page.locator('[data-search="old"]').fill('爱');
        assert.deepEqual(await page.locator('[data-list="old"] [data-id]').evaluateAll(rows => rows.map(row => row.dataset.id)), ['83']);
        await page.locator('[data-search="old"]').fill('爱可');
        assert.deepEqual(await page.locator('[data-list="old"] [data-id]').evaluateAll(rows => rows.map(row => row.dataset.id)), ['84']);
        await page.locator('[data-search="old"]').fill('尼可');
        assert.equal(await targetJump.isVisible(), false);
        await page.locator('[data-search="old"]').fill('');
        await openTool(page, 'stwu-scope');
        await page.locator('[data-scope]').fill('尼可\n露娜');
        await page.locator('[data-scope]').press('Tab');
        await page.locator('.stwu-scope > summary').click();
        assert.equal(await targetJump.textContent(), '待核对 2');
        await targetJump.click();
        assert.equal(await status('old', 81).textContent(), '置顶 · 待核对');
        await page.getByRole('button', { name: '按名单更新', exact: true }).click();
        assert.match(await page.locator('[data-roster-summary]').textContent(), /替换 1 · 复制 0 · 无变化 0 · 待核对 1/);
        assert.equal(state.writes, 0);
        assert.deepEqual(errors, []);
        results.push('单字搜索完整项、通用关键词不制造候选、待核对原因与跨页分类勾选通过');
        await ctx.close();
    }

    reset(); {
        const target = book([
            entry(1, '琴', ['琴', '代理团长'], '旧琴', { order: 42 }),
            entry(2, '琴', ['琴', '弦乐器'], '乐器资料'),
            entry(3, '丽莎', ['图书管理员'], '旧丽莎'),
            entry(4, '蒙德图书馆', ['丽莎', '图书管理员'], '图书馆资料'),
            entry(5, '尼可', ['尼可·莱恩', '魔女N', '尼可'], '旧尼可'),
            entry(6, '哥伦比亚', ['少女', '库塔尔'], '旧少女'),
            entry(7, '菲谢尔，奥兹', ['菲谢尔、奥兹'], '旧菲谢尔'),
            entry(8, '爱好', ['爱'], '相同正文也不算身份'),
            entry(9, '诸国历史', ['凯撒'], '正文也提到凯撒·金'),
            entry(10, '露娜', ['银月祭司'], '待核对甲'),
            entry(11, '露娜', ['银月祭司'], '待核对乙'),
            entry(12, '双子', ['双子'], '母本有两个候选'),
        ]);
        const mother = book([
            entry(101, '琴·古恩希尔德', ['琴·古恩希尔德', '代理团长'], '新琴'),
            entry(103, '原神·丽莎·敏兹', ['图书管理员'], '新丽莎'),
            entry(105, '尼可·莱恩', ['尼可·莱恩', '魔女「N」'], '新尼可'),
            entry(106, '哥伦比娅·希珀塞莱妮娅', ['少女', '库塔尔', '小鸽子'], '新少女'),
            entry(107, '菲谢尔·冯·露弗施洛斯·那菲多特', ['菲谢尔'], '新菲谢尔'),
            entry(108, '爱情', ['爱'], '相同正文也不算身份'),
            entry(109, '凯撒·金 (Caesar King)', ['人格'], '正文也提到凯撒·金'),
            entry(110, '露娜·费尔', ['银月祭司'], '新露娜'),
            entry(111, '双子', ['双子'], '母本候选甲'),
            entry(112, '双子', ['双子'], '母本候选乙'),
        ]);
        state.books.set('演示_目标书', target);
        state.books.set('演示_母本', mother);
        const { page, ctx, errors } = await prepare(390, 844);
        const row = (side, id) => page.locator(`[data-list="${side}"] [data-id="${id}"]`);
        const status = (side, id) => row(side, id).locator('.stwu-entry-status').textContent();
        const pairIds = [[1, 101], [3, 103], [5, 105], [6, 106], [7, 107]];
        async function assertPairs(expected, changed = '有变化') {
            for (const [oldId, newId] of expected) {
                const targetStatus = await status('old', oldId);
                assert.match(targetStatus, new RegExp(`配对 \\d+ · ${changed}`));
                assert.equal(await status('new', newId), targetStatus);
            }
        }
        await assertPairs(pairIds);
        for (const id of [108, 109]) assert.equal(await status('new', id), '未配对 · 可复制');
        for (const id of [2, 4, 8, 9]) assert.equal(await status('old', id), '目标书独有 · 保留');
        for (const id of [110, 111, 112]) assert.match(await status('new', id), /置顶 · 待核对/);
        for (const id of [10, 11, 12]) {
            assert.match(await status('old', id), /置顶 · 待核对/);
            assert.equal(await row('old', id).getByRole('checkbox', { name: /^待核对目标候选/ }).isEnabled(), true);
        }

        const category = page.locator('[data-selection-category]');
        const bulk = page.locator('[data-action="toggle-selection"]');
        await category.selectOption('review');
        assert.match(await bulk.textContent(), /勾选 3 条/);
        await bulk.click();
        for (const id of [110, 111, 112]) assert.equal(await row('new', id).locator('input').isChecked(), true);
        for (const id of [108, 109]) assert.equal(await row('new', id).locator('input').isChecked(), false);
        const targetSearch = page.locator('[data-search="old"]');
        const targetBulk = page.locator('[data-action="toggle-target-selection"]');
        await targetSearch.fill('琴');
        await assertOneLineButton(targetBulk);
        assert.match(await targetBulk.textContent(), /取消勾选 1 条/);
        await targetBulk.click();
        assert.equal(await row('old', 1).locator('input').isChecked(), false);
        assert.equal(await row('new', 101).locator('input').isChecked(), false);
        assert.equal(await row('new', 103).locator('input').isChecked(), true);
        assert.equal(await row('new', 110).locator('input').isChecked(), true);
        await targetBulk.click();
        assert.equal(await row('old', 1).locator('input').isChecked(), true);
        await targetSearch.fill('爱');
        assert.deepEqual(await page.locator('[data-list="old"] [data-id]').evaluateAll(rows => rows.map(row => row.dataset.id)), ['8']);
        assert.equal(await targetBulk.isDisabled(), true);
        assert.match(await status('new', 110), /待核对/);
        await targetSearch.fill('');

        await openTool(page, 'stwu-scope');
        const roster = page.locator('[data-scope]');
        await roster.fill(['琴', '丽莎', '尼可', '哥伦比娅', '菲谢尔', '爱情', '凯撒·金', '露娜', '双子', '缺失角色'].join('\n'));
        await roster.press('Tab');
        await assertPairs(pairIds);
        const preview = page.getByRole('button', { name: '按名单更新', exact: true });
        const summary = page.locator('[data-roster-summary]');
        const report = page.locator('[data-roster-report]');
        await preview.click();
        assert.match(await summary.textContent(), /替换 5 · 复制 2 · 无变化 0 · 待核对 2 · 母本未找到 1/);
        const reviewReport = await report.textContent();
        assert.match(reviewReport, /露娜.*目标书/);
        assert.match(reviewReport, /双子.*母本/);
        assert.equal(state.writes, 0);
        await page.keyboard.press('Escape');

        await clickRow(page, 'old', '10');
        await clickRow(page, 'new', '110');
        await openTool(page, 'stwu-pairbar');
        await page.getByRole('button', { name: '配对所选', exact: true }).click();
        await assertPairs([...pairIds, [10, 110]]);
        for (const id of [111, 112]) assert.match(await status('new', id), /待核对/);
        assert.match(await status('old', 12), /待核对/);
        await openTool(page, 'stwu-scope');
        await preview.click();
        assert.match(await summary.textContent(), /替换 6 · 复制 2 · 无变化 0 · 待核对 1 · 母本未找到 1/);
        assert.equal(state.writes, 0);
        await page.getByRole('button', { name: '确认更新', exact: true }).click();
        await page.waitForFunction(() => document.querySelector('.stwu-notice').textContent.startsWith('已核验：替换 6 条，复制 2 条'));
        const saved = state.books.get('演示_目标书');
        assert.equal(state.writes, 1);
        for (const [oldId, newId] of [...pairIds, [10, 110]]) {
            assert.deepEqual(saved.entries[oldId], { ...target.entries[oldId], content: mother.entries[newId].content });
        }
        for (const id of [2, 4, 8, 9, 11, 12]) assert.deepEqual(saved.entries[id], target.entries[id]);
        const added = Object.entries(saved.entries).filter(([id]) => !Object.hasOwn(target.entries, id));
        assert.equal(added.length, 2);
        assert.deepEqual(new Set(added.map(([, { comment }]) => comment)), new Set(['爱情', '凯撒·金 (Caesar King)']));
        for (const [id, item] of added) assert.equal(String(item.uid), id);
        assert.equal(saved.customMetadata, target.customMetadata);
        assert.deepEqual(state.books.get('演示_母本'), mother);
        await page.locator('.stwu-header-actions [data-action="reload"]').click();
        await page.waitForFunction(() => !document.querySelector('[data-mode]').disabled);
        await openTool(page, 'stwu-scope');
        await preview.click();
        assert.match(await summary.textContent(), /替换 0 · 复制 0/);
        assert.equal(await page.getByRole('button', { name: '确认更新', exact: true }).isVisible(), false);
        assert.equal(state.writes, 1);
        assert.deepEqual(errors, []);
        results.push('混合世界书贯通自动配对、分类勾选、名单、人工核对、UID 写入与重载去重');
        await ctx.close();
    }

    // 150-entry pagination & page jump
    reset(); {
        const manyBook = book(Array.from({ length: 150 }, (_, i) => entry(i, `角色 ${String(i + 1).padStart(3, '0')}`, [`角色 ${i + 1}`], `正文 ${i + 1}`)));
        const manyNew = book(Array.from({ length: 150 }, (_, i) => entry(i + 500, `角色 ${String(i + 1).padStart(3, '0')}`, [`角色 ${i + 1}`], `母本正文 ${i + 1}`)));
        state.books = new Map([['演示_目标书', manyBook], ['演示_母本', manyNew]]);
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
        await page.locator('[data-action="replace"]').scrollIntoViewIfNeeded();
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
        const swap = page.getByRole('button', { name: '交换左右', exact: true });
        assert.equal(await page.locator('.stwu-pane').first().getAttribute('data-side'), 'new');
        assert.equal(await page.locator('.stwu-preview-pane').first().getAttribute('data-preview-side'), 'new');
        await page.locator('[data-search="new"]').fill('共同标题');
        await openTool(page, 'stwu-pairbar');
        await swap.click();
        assert.equal(await swap.isVisible(), false);
        assert.equal(await page.locator('.stwu-pane').last().getAttribute('data-side'), 'new');
        assert.equal(await page.locator('.stwu-preview-pane').last().getAttribute('data-preview-side'), 'new');
        assert.equal(await page.locator('[data-book="new"]').inputValue(), 'book:演示_母本');
        assert.equal(await page.locator('[data-book="old"]').inputValue(), 'book:演示_目标书');
        assert.equal(await page.locator('[data-search="new"]').inputValue(), '共同标题');
        assert.equal(await page.locator('[data-list="new"] [data-id="91"] input').isChecked(), true);
        assert.equal(await page.locator('[data-list="old"] [data-id="1"] input').isChecked(), true);
        assert.equal(await page.locator('[data-preview-content="new"]').textContent(), '新共同正文');
        assert.equal(state.writes, 0);
        let replaceConfirmation;
        page.once('dialog', d => { replaceConfirmation = d.message(); return d.accept(); });
        await page.locator('[data-action="replace"]').click();
        assert.match(replaceConfirmation, /母本「演示_母本」.*目标书「演示_目标书」/);
        await page.waitForFunction(() => document.querySelector('.stwu-notice').textContent.startsWith('已核验并替换'));
        assert.equal(state.writes, 1);
        const persisted = state.books.get('演示_目标书');
        assert.equal(persisted.entries[0].uid, 0);
        assert.equal(persisted.entries[1].content, '新共同正文');
        assert.equal(persisted.customMetadata, '保留');
        await page.locator('.stwu-header-actions [data-action="reload"]').click();
        await page.waitForFunction(() => !document.querySelector('[data-mode]').disabled);
        assert.deepEqual(errors, []);
        await page.evaluate(() => window.__extension.onDisable());
        assert.equal(await page.locator('.stwu-dialog,#st-worldbook-updater-launcher').count(), 0);
        assert.equal(await page.evaluate(() => [...window.__host.events.values()].reduce((n, s) => n + s.size, 0)), 0);
        assert.deepEqual(state.books.get('演示_母本'), newer);
        const reopened = await prepare(390, 844, ctx, true);
        assert.equal(await reopened.page.locator('.stwu-pane').last().getAttribute('data-side'), 'new');
        await openTool(reopened.page, 'stwu-pairbar');
        await reopened.page.getByRole('button', { name: '交换左右', exact: true }).click();
        assert.equal(await reopened.page.locator('.stwu-pane').first().getAttribute('data-side'), 'new');
        await assertLayout(reopened.page);
        assert.deepEqual(reopened.errors, []);
        results.push('配对后换边、勾选和搜索保留、替换写入目标书、换边记忆及禁用清理通过');
        await ctx.close();
    }

    for (const side of ['old', 'new']) {
        reset();
        const { page, ctx, errors } = await prepare();
        const role = side === 'old' ? '目标书' : '母本';
        const name = `演示_${role}`;
        const id = side === 'old' ? 1 : 91;
        const row = (rowSide, rowId) => page.locator(`[data-list="${rowSide}"] [data-id="${rowId}"]`);
        const status = (rowSide, rowId) => row(rowSide, rowId).locator('.stwu-entry-status').textContent();
        async function reload() {
            await page.locator('.stwu-header-actions [data-action="reload"]').click();
            await page.waitForFunction(() => document.querySelector('.stwu-notice').textContent.startsWith('已重新载入'));
        }

        await clickRow(page, 'old', '1');
        await clickRow(page, 'new', '91');
        await openTool(page, 'stwu-pairbar');
        await page.getByRole('button', { name: '配对所选', exact: true }).click();
        assert.match(await status('old', 1), /配对 \d+ · 有变化/);
        const edited = structuredClone(state.books.get(name));
        Object.assign(edited.entries[id], { content: '宿主更新的原条目正文', order: 61 });
        state.books.set(name, edited);
        await reload();
        assert.doesNotMatch(await page.locator('.stwu-notice').textContent(), /重新核对/);
        assert.match(await status('old', 1), /配对 \d+ · 有变化/);
        assert.equal(await status('new', 91), await status('old', 1));
        assert.equal(await row('old', 1).locator('input').isChecked(), true);
        assert.equal(await row('new', 91).locator('input').isChecked(), true);

        const replaced = structuredClone(edited);
        replaced.entries[id] = entry(id, '外部编辑后复用编号的另一身份', ['另一身份'], '不属于原配对的正文');
        state.books.set(name, replaced);
        await reload();
        assert.match(await page.locator('.stwu-notice').textContent(), /有 1 组旧配对因标题或主关键词变化已重新核对/);
        assert.equal(await row(side, id).locator('input').isChecked(), false);
        const expectedStatus = side === 'old' ? '目标书独有 · 保留' : '未配对 · 可复制';
        assert.equal(await status(side, id), expectedStatus);
        if (side === 'old') {
            assert.match(await status('old', 2), /配对 \d+ · 有变化/);
            assert.equal(await status('new', 91), await status('old', 2));
        }
        assert.equal(await page.locator('[data-action="copy"]').isDisabled(), true);
        assert.equal(state.writes, 0);
        const untouched = structuredClone(state.books.get('演示_目标书').entries[1]);
        page.once('dialog', dialog => dialog.accept());
        await page.locator('[data-action="replace"]').click();
        await page.waitForFunction(() => document.querySelector('.stwu-notice').textContent.startsWith('已核验并替换'));
        assert.equal(state.writes, 1);
        assert.deepEqual(state.books.get('演示_目标书').entries[1], untouched);
        assert.equal(state.books.get('演示_目标书').entries[0].content, newer.entries[90].content);
        assert.deepEqual(errors, []);
        results.push(`${role}重载时正文设置变化保留人工配对，复用 UID 的另一身份不继承勾选和替换关系`);
        await ctx.close();
    }

    reset(); {
        state.books.set('另一母本', book([entry(90, '其他母本条目', ['其他母本'], '其他正文')]));
        state.books.set('另一目标书', book([entry(2, '同编号的其他条目', ['另一身份'], '其他正文')]));
        const { page, ctx, errors } = await prepare(320, 568);
        const oldSearch = page.locator('[data-search="old"]');
        const row = (side, id) => page.locator(`[data-list="${side}"] [data-id="${id}"]`);
        await row('old', 2).getByRole('checkbox', { name: /^待核对目标候选/ }).check();
        await row('old', 4).getByRole('checkbox', { name: /^目标书独有条目/ }).check();
        assert.equal(await row('old', 0).locator('input').isChecked(), true);
        assert.equal(await row('new', 90).locator('input').isChecked(), true);
        assert.equal(await row('new', 91).locator('input').isChecked(), false);
        assert.equal(await row('new', 94).locator('input').isChecked(), false);
        assert.equal(await page.locator('[data-action="copy"]').isDisabled(), true);
        assert.equal(await page.locator('[data-action="replace"]').textContent(), '替换所选 (1)');
        await oldSearch.fill('角色甲');
        assert.equal(await row('old', 2).count(), 0);
        assert.equal(await row('old', 4).count(), 0);

        await openTool(page, 'stwu-settings');
        const operation = page.locator('[data-set-operation]');
        const scope = page.locator('[data-set-scope]');
        const count = page.locator('[data-set-count]');
        const order = page.locator('[data-field="order"]');
        const action = page.locator('[data-action="apply-settings"]');
        assert.equal(await operation.inputValue(), 'new');
        await scope.selectOption('checked');
        assert.equal(await count.textContent(), '母本 1 条');
        await operation.selectOption('sync');
        assert.equal(await count.textContent(), '母本 1 条 · 可同步 1 条');
        await operation.selectOption('old');
        await scope.selectOption('all');
        assert.equal(await count.textContent(), '目标书 6 条');
        await scope.selectOption('search');
        assert.equal(await count.textContent(), '目标书 1 条');
        await scope.selectOption('checked');
        assert.equal(await count.textContent(), '目标书 3 条');
        await order.locator('[data-set-mode]').selectOption('set');
        await order.locator('[data-set-value]').fill('57');
        let confirmation;
        page.once('dialog', dialog => { confirmation = dialog.message(); return dialog.accept(); });
        await action.click();
        await page.waitForFunction(() => document.querySelector('.stwu-notice').textContent.startsWith('目标书已保存：3 条设置已更新。'));
        assert.match(confirmation, /演示_目标书.*3 条/);
        assert.match(confirmation, /2 条被搜索隐藏/);
        assert.equal(state.writes, 1);
        const expected = structuredClone(old);
        for (const id of [0, 2, 4]) expected.entries[id].order = 57;
        assert.deepEqual(state.books.get('演示_目标书'), expected);
        assert.deepEqual(state.books.get('演示_母本'), newer);

        page.once('dialog', dialog => dialog.accept());
        await action.click();
        await page.waitForFunction(() => document.querySelector('.stwu-notice').textContent.includes('内容相同，无需写入'));
        assert.equal(state.writes, 1);

        const drawer = page.locator('.stwu-settings');
        if (await drawer.getAttribute('open') !== null) await drawer.locator(':scope > summary').click();
        await oldSearch.fill('');
        await clickRow(page, 'new', '90');
        await clickRow(page, 'old', '4');
        await oldSearch.fill('角色甲');
        await openTool(page, 'stwu-settings');
        await scope.selectOption('current');
        assert.equal(await count.textContent(), '目标书 1 条');
        await order.locator('[data-set-mode]').selectOption('set');
        await order.locator('[data-set-value]').fill('84');
        page.once('dialog', dialog => dialog.accept());
        await action.click();
        await page.waitForFunction(() => document.querySelector('.stwu-notice').textContent.startsWith('目标书已保存：1 条设置已更新。'));
        assert.equal(state.writes, 2);
        expected.entries[4].order = 84;
        assert.deepEqual(state.books.get('演示_目标书'), expected);
        assert.deepEqual(state.books.get('演示_母本'), newer);

        await order.locator('[data-set-value]').fill('');
        await action.click();
        await page.waitForFunction(() => document.querySelector('.stwu-notice').textContent.includes('「注入顺序」填写整数'));
        assert.equal(state.writes, 2);
        await operation.selectOption('sync');
        await scope.selectOption('checked');
        assert.equal(await order.locator('[data-set-value]').isDisabled(), true);
        page.once('dialog', dialog => dialog.accept());
        await action.click();
        await page.waitForFunction(() => document.querySelector('.stwu-notice').textContent.startsWith('已同步 1 条设置到目标书。'));
        expected.entries[0].order = newer.entries[90].order;
        assert.equal(state.writes, 3);
        assert.deepEqual(state.books.get('演示_目标书'), expected);
        assert.deepEqual(state.books.get('演示_母本'), newer);

        await openTool(page, 'stwu-scope');
        const roster = page.locator('[data-scope]');
        await roster.fill('角色甲\n共同标题');
        await roster.press('Tab');
        await openTool(page, 'stwu-settings');
        await operation.selectOption('old');
        await scope.selectOption('scope');
        assert.equal(await count.textContent(), '目标书 1 条');

        await oldSearch.fill('');
        await openTool(page, 'stwu-pairbar');
        await page.getByRole('button', { name: '交换左右', exact: true }).click();
        assert.equal(await page.locator('.stwu-pane').first().getAttribute('data-side'), 'old');
        assert.equal(await row('old', 2).locator('input').isChecked(), true);
        assert.equal(await row('old', 4).locator('input').isChecked(), true);
        const reload = async () => {
            await page.locator('.stwu-header-actions [data-action="reload"]').click();
            await page.waitForFunction(() => !document.querySelector('[data-mode]').disabled);
        };
        await reload();
        assert.equal(await row('old', 4).locator('input').isChecked(), true);
        const edited = structuredClone(expected);
        edited.entries[4] = entry(4, '重新使用编号的条目', ['另一人物'], '另一正文');
        state.books.set('演示_目标书', edited);
        await reload();
        assert.equal(await row('old', 4).locator('input').isChecked(), false);
        assert.equal(await row('old', 2).locator('input').isChecked(), true);

        const acceptSwitch = dialog => dialog.accept();
        page.on('dialog', acceptSwitch);
        await page.locator('[data-book="new"]').selectOption('book:另一母本');
        await page.waitForFunction(() => !document.querySelector('[data-mode]').disabled);
        assert.equal(await row('old', 2).locator('input').isChecked(), true);
        await page.locator('[data-book="old"]').selectOption('book:另一目标书');
        await page.waitForFunction(() => !document.querySelector('[data-mode]').disabled);
        assert.equal(await row('old', 2).locator('input').isChecked(), false);
        page.off('dialog', acceptSwitch);
        await openTool(page, 'stwu-settings');
        await scope.selectOption('search');
        assert.equal(await count.textContent(), '目标书 0 条');
        assert.equal(await action.isDisabled(), true);
        assert.equal(state.writes, 3);
        assert.deepEqual(errors, []);
        results.push('目标书设置按本栏勾选、搜索、当前查看及名单取值，空数字停止保存，同步用母本值，换书和重载不串选');
        await ctx.close();
    }

    // Roster preview and a single verified write.
    reset(); {
        Object.assign(state.books.get('演示_目标书').entries[0], {
            comment: '琴', key: ['琴', '琴团长', '琴團長', '代理团长'],
        });
        state.books.get('演示_目标书').entries[100] = entry(100, '琴', ['琴', '弦乐器'], '乐器条目');
        Object.assign(state.books.get('演示_母本').entries[90], {
            comment: '琴·古恩希尔德', key: ['琴·古恩希尔德', '蒲公英骑士', '狮牙骑士', '代理团长'],
        });
        const motherBefore = structuredClone(state.books.get('演示_母本'));
        const { page, ctx, errors } = await prepare(320, 568, null, true);
        await openTool(page, 'stwu-scope');
        const input = page.locator('[data-scope]');
        await input.fill('琴\n新增条目\n无变化\n共同标题\n找不到角色');
        await input.press('Tab');
        const sourceStatus = page.locator('[data-list="new"] [data-id="90"] .stwu-entry-status');
        const targetStatus = page.locator('[data-list="old"] [data-id="0"] .stwu-entry-status');
        assert.match(await sourceStatus.textContent(), /配对 \d+ · 有变化/);
        assert.equal(await targetStatus.textContent(), await sourceStatus.textContent());
        assert.equal(await page.locator('[data-list="old"] [data-id="100"] input').isEnabled(), true);
        const previewButton = page.getByRole('button', { name: '按名单更新', exact: true });
        const dialog = page.locator('[data-roster-dialog]');
        const confirm = page.getByRole('button', { name: '确认更新', exact: true });
        await page.locator('[data-search="new"]').fill('没有命中的搜索结果');
        await previewButton.click();
        assert.equal(await dialog.isVisible(), true);
        assert.match(await dialog.locator('[data-roster-summary]').textContent(), /替换 1 · 复制 1 · 无变化 1 · 待核对 1 · 母本未找到 1/);
        const details = await dialog.locator('[data-roster-report]').textContent();
        for (const name of ['琴', '新增条目', '无变化', '共同标题', '找不到角色']) assert.ok(details.includes(name));
        assert.equal(state.writes, 0);
        await page.keyboard.press('Escape');
        assert.equal(await dialog.isVisible(), false);
        assert.equal(await page.locator('.stwu-dialog').isVisible(), true);
        await previewButton.click();
        const externalTarget = structuredClone(state.books.get('演示_目标书'));
        externalTarget.entries[4].content = '名单预览后在宿主修改的正文';
        state.books.set('演示_目标书', externalTarget);
        await confirm.click();
        await page.waitForFunction(() => /预览后.*变化/.test(document.querySelector('.stwu-notice').textContent));
        assert.equal(state.writes, 0);
        assert.deepEqual(state.books.get('演示_目标书'), externalTarget);
        await page.locator('.stwu-header-actions [data-action="reload"]').click();
        await page.waitForFunction(() => document.querySelector('.stwu-notice').textContent.startsWith('已重新载入'));
        await previewButton.click();
        const externalMother = structuredClone(motherBefore);
        externalMother.entries[90].content = '名单预览后在宿主修改的母本正文';
        state.books.set('演示_母本', externalMother);
        await confirm.click();
        await page.waitForFunction(() => /演示_母本.*在预览后发生了变化/.test(document.querySelector('.stwu-notice').textContent));
        assert.equal(state.writes, 0);
        assert.deepEqual(state.books.get('演示_目标书'), externalTarget);
        await page.locator('.stwu-header-actions [data-action="reload"]').click();
        await page.waitForFunction(() => document.querySelector('.stwu-notice').textContent.startsWith('已重新载入'));
        await previewButton.click();
        await confirm.click();
        await page.waitForFunction(() => document.querySelector('.stwu-notice').textContent.startsWith('已核验：替换 1 条，复制 1 条'));
        assert.equal(state.writes, 1);
        const target = state.books.get('演示_目标书');
        assert.equal(target.entries[0].comment, '琴');
        assert.equal(target.entries[0].content, externalMother.entries[90].content);
        assert.equal(target.entries[0].order, 100);
        assert.equal(target.entries[100].content, '乐器条目');
        assert.equal(target.entries[1].content, old.entries[1].content);
        assert.equal(target.entries[4].content, externalTarget.entries[4].content);
        assert.equal(Object.values(target.entries).filter(row => row.comment === '新增条目').length, 1);
        assert.deepEqual(state.books.get('演示_母本'), externalMother);
        await previewButton.click();
        assert.match(await dialog.locator('[data-roster-summary]').textContent(), /替换 0 · 复制 0 · 无变化 3/);
        assert.equal(await confirm.isVisible(), false);
        assert.equal(state.writes, 1);
        assert.deepEqual(errors, []);
        results.push('320px 按主关键词区分同名琴，双方外部变化后拒绝旧名单预览，重载后按新母本写入且无副本');
        await ctx.close();
    }

    reset(); {
        const emptyTarget = book([]);
        state.books.set('演示_目标书', emptyTarget);
        const { page, ctx, errors } = await prepare(390, 844, null, true);
        await openTool(page, 'stwu-scope');
        await page.locator('[data-scope]').fill('角色甲\n新增条目');
        await page.locator('[data-scope]').press('Tab');
        await page.getByRole('button', { name: '按名单更新', exact: true }).click();
        assert.match(await page.locator('[data-roster-summary]').textContent(), /替换 0 · 复制 2 · 无变化 0/);
        await page.getByRole('button', { name: '确认更新', exact: true }).click();
        await page.waitForFunction(() => document.querySelector('.stwu-notice').textContent.startsWith('已核验：替换 0 条，复制 2 条'));
        const updated = state.books.get('演示_目标书');
        assert.equal(state.writes, 1);
        assert.equal(updated.customMetadata, emptyTarget.customMetadata);
        assert.deepEqual(Object.values(updated.entries).map(row => row.comment), ['角色甲', '新增条目']);
        assert.deepEqual(errors, []);
        results.push('已选空目标书可按名单复制，名单外条目不导入');
        await ctx.close();
    }

    reset(); {
        const mother = state.books.get('演示_母本'), target = state.books.get('演示_目标书');
        mother.entries[90] = entry(90, '哥伦比娅·希珀塞莱妮娅', ['少女', '库塔尔', '小鸽子'], '母本少女');
        mother.entries[91] = entry(91, '菲谢尔·冯·露弗施洛斯·那菲多特', ['菲谢尔·冯·露弗施洛斯·那菲多特', '断罪之皇女'], '母本菲谢尔');
        target.entries[0] = entry(0, '哥伦比亚', ['少女', '库塔尔'], '旧少女');
        target.entries[1] = entry(1, '菲谢尔，奥兹', ['菲谢尔、奥兹'], '旧菲谢尔');
        const { page, ctx, errors } = await prepare(390, 844, null, true);
        await openTool(page, 'stwu-scope');
        await page.locator('[data-scope]').fill('哥伦比亚\n菲谢尔');
        await page.locator('[data-scope]').press('Tab');
        for (const [oldId, newId] of [[0, 90], [1, 91]]) {
            const status = (side, id) => page.locator(`[data-list="${side}"] [data-id="${id}"] .stwu-entry-status`).textContent();
            assert.match(await status('old', oldId), /配对 \d+ · 有变化/);
            assert.equal(await status('old', oldId), await status('new', newId));
        }
        await page.getByRole('button', { name: '按名单更新', exact: true }).click();
        assert.match(await page.locator('[data-roster-summary]').textContent(), /替换 2 · 复制 0/);
        assert.match(await page.locator('[data-roster-report]').textContent(), /菲谢尔，奥兹.*更新整条/);
        await page.getByRole('button', { name: '确认更新', exact: true }).click();
        await page.waitForFunction(() => document.querySelector('.stwu-notice').textContent.startsWith('已核验：替换 2 条，复制 0 条'));
        assert.equal(state.writes, 1);
        const updated = state.books.get('演示_目标书');
        assert.equal(updated.entries[0].content, '母本少女');
        assert.equal(updated.entries[1].content, '母本菲谢尔');
        assert.equal(updated.entries[1].comment, '菲谢尔，奥兹');
        assert.equal(Object.keys(updated.entries).length, Object.keys(target.entries).length);
        assert.deepEqual(errors, []);
        results.push('哥伦比娅译名异写、菲谢尔奥兹合写标题可配对和替换');
        await ctx.close();
    }

    // Copy selected + file upload + error protections
    reset(); {
        const target = state.books.get('演示_目标书');
        for (const id of [1, 2]) target.entries[id].content = newer.entries[91].content;
        const { page, ctx, errors } = await prepare();
        const checkbox = (currentPage, id) => currentPage.locator(`[data-list="new"] [data-id="${id}"] input`);
        const copyButton = currentPage => currentPage.locator('[data-action="copy"]');
        const copy = copyButton(page);
        assert.equal(await checkbox(page, 90).isChecked(), true);
        assert.equal(await copy.isDisabled(), true);
        await checkbox(page, 91).check();
        await checkbox(page, 94).check();
        const search = page.locator('[data-search="new"]');
        await search.fill('角色甲');
        assert.equal(await copy.isDisabled(), true);
        assert.equal(state.writes, 0);
        await search.fill('');
        assert.equal(await copy.textContent(), '复制所选 (1)');
        let confirmation;
        page.once('dialog', dialog => { confirmation = dialog.message(); return dialog.accept(); });
        await copy.click();
        assert.match(confirmation, /复制以下 1 条缺失条目/);
        assert.match(confirmation, /^- 新增条目$/m);
        await page.waitForFunction(() => /^已核验.*复制 1 条缺失条目/.test(document.querySelector('.stwu-notice').textContent));
        const afterCopy = state.books.get('演示_目标书');
        const added = Object.entries(afterCopy.entries).filter(([id]) => !Object.hasOwn(target.entries, id));
        assert.equal(added.length, 1);
        const [[addedId, addedEntry]] = added;
        assert.equal(String(addedEntry.uid), addedId);
        assert.equal(addedEntry.comment, '新增条目');
        assert.equal(addedEntry.content, newer.entries[94].content);
        for (const [id, item] of Object.entries(target.entries)) assert.deepEqual(afterCopy.entries[id], item);
        assert.equal(await checkbox(page, 90).isChecked(), true);
        assert.equal(await checkbox(page, 91).isChecked(), true);
        assert.equal(await copy.textContent(), '复制所选');
        assert.equal(await copy.isDisabled(), true);
        await copy.evaluate(button => button.click());
        await checkbox(page, 94).check();
        assert.equal(await copy.isDisabled(), true);
        assert.equal(state.writes, 1);

        page.once('dialog', dialog => dialog.accept());
        await page.locator('[data-action="replace"]').click();
        await page.waitForFunction(() => document.querySelector('.stwu-notice').textContent.startsWith('已核验并替换 1 组'));
        const afterReplace = state.books.get('演示_目标书');
        assert.equal(state.writes, 2);
        assert.deepEqual(afterReplace.entries, { ...afterCopy.entries, 0: { ...target.entries[0], content: newer.entries[90].content } });
        await page.locator('.stwu-header-actions [data-action="reload"]').click();
        await page.waitForFunction(() => !document.querySelector('[data-mode]').disabled);
        await checkbox(page, 94).check();
        assert.equal(await copy.isDisabled(), true);
        await page.close();

        const reopened = await prepare(390, 844, ctx, true);
        for (const id of [90, 91, 94]) await checkbox(reopened.page, id).check();
        assert.match(await reopened.page.locator('[data-list="new"] [data-id="94"] .stwu-entry-status').textContent(), /配对 \d+ · 无变化/);
        assert.equal(await copyButton(reopened.page).isDisabled(), true);
        assert.equal(state.writes, 2);
        assert.deepEqual(state.books.get('演示_目标书'), afterReplace);
        assert.deepEqual([...errors, ...reopened.errors], []);
        results.push('混合勾选只复制缺少条目，原配对按 UID 替换，重复勾选、重新载入和重开窗口均不新增副本');
        await ctx.close();
    }

    reset(); {
        const target = state.books.get('演示_目标书');
        Object.assign(target.entries[2], { displayIndex: 67, order: 77, position: 4, disable: true, extensions: { custom: '保留设置' } });
        target.entries[6] = entry(6, '共同标题', ['共同词'], '旧条目三');
        target.entries[4] = entry(4, '保留条目', ['共同词'], newer.entries[91].content);
        target.entries[7] = entry(7, '无变化', ['不同触发词'], '这个同名条目应保留');
        const { page, ctx, errors } = await prepare(390, 844);
        await clickRow(page, 'new', '91');
        const dialog = page.locator('[data-consolidate-dialog]');
        const retain = dialog.locator('[data-consolidate-keep]');
        const remove = id => dialog.locator(`[data-consolidate-remove="${id}"]`);
        const candidateIds = () => dialog.locator('[data-consolidate-remove]')
            .evaluateAll(items => items.map(item => item.dataset.consolidateRemove).sort());
        const save = dialog.locator('[data-action="save-consolidation"]');
        async function openConsolidation() {
            await openTool(page, 'stwu-pairbar');
            await page.locator('[data-pair-btn="consolidate"]').click();
            assert.equal(await dialog.isVisible(), true);
        }

        await openConsolidation();
        assert.deepEqual(await candidateIds(), ['1', '2', '6']);
        assert.equal(await save.isDisabled(), true);
        await retain.selectOption('2');
        assert.equal(await remove(2).isDisabled(), true);
        await remove(1).check();
        assert.equal(await save.isEnabled(), true);
        await dialog.locator('[data-action="close-consolidation"]').click();
        assert.equal(await dialog.isVisible(), false);
        assert.equal(state.writes, 0);
        assert.deepEqual(state.books.get('演示_目标书'), target);

        await openConsolidation();
        await retain.selectOption('2');
        assert.equal(await remove(1).isChecked(), false);
        assert.equal(await save.isDisabled(), true);
        await remove(1).check();
        await remove(6).check();
        assert.match(await dialog.locator('[data-consolidate-summary]').textContent(), /保留 UID 2.*仅正文/);
        await save.click();
        await page.waitForFunction(() => !document.querySelector('[data-consolidate-dialog]').open);
        await page.waitForFunction(() => document.querySelector('.stwu-notice').textContent.startsWith('已核验并合并'));
        assert.equal(state.writes, 1);
        const expected = structuredClone(target);
        delete expected.entries[1];
        delete expected.entries[6];
        expected.entries[2].content = newer.entries[91].content;
        assert.deepEqual(state.books.get('演示_目标书'), expected);
        assert.deepEqual(state.books.get('演示_母本'), newer);

        await page.locator('.stwu-header-actions [data-action="reload"]').click();
        await page.waitForFunction(() => !document.querySelector('[data-mode]').disabled);
        const retained = page.locator('[data-list="old"] [data-id="2"]');
        assert.match(await retained.locator('.stwu-entry-status').textContent(), /配对 \d+ · 无变化/);
        assert.equal(await page.locator('[data-list="old"] [data-id="1"], [data-list="old"] [data-id="6"]').count(), 0);
        assert.equal(state.writes, 1);

        assert.match(await page.locator('[data-list="new"] [data-id="92"] .stwu-entry-status').textContent(), /配对 \d+ · 无变化/);
        await clickRow(page, 'new', '92');
        await openConsolidation();
        assert.deepEqual(await candidateIds(), ['3', '7']);
        const operation = dialog.locator('[data-target-operation]');
        assert.equal(await operation.inputValue(), 'consolidate');
        await operation.selectOption('delete');
        assert.equal(await save.textContent(), '确认删除');
        assert.equal(await save.isDisabled(), true);
        await remove(3).check();
        assert.equal(await save.isEnabled(), true);
        await operation.selectOption('consolidate');
        await operation.selectOption('delete');
        assert.equal(await remove(3).isChecked(), false);
        assert.equal(await save.isDisabled(), true);
        await remove(3).check();
        assert.match(await dialog.locator('[data-consolidate-summary]').textContent(), /删除 1 条（UID 3）/);
        await save.click();
        await page.waitForFunction(() => !document.querySelector('[data-consolidate-dialog]').open);
        await page.waitForFunction(() => document.querySelector('.stwu-notice').textContent.startsWith('已核验并删除'));
        assert.equal(state.writes, 2);
        delete expected.entries[3];
        assert.deepEqual(state.books.get('演示_目标书'), expected);
        assert.deepEqual(state.books.get('演示_母本'), newer);
        assert.deepEqual(errors, []);
        results.push('目标书合并可选保留 UID 并取消，切换删除模式清空选择，确认只写入选中变化');
        await ctx.close();
    }

    reset(); {
        const { page, ctx } = await prepare();
        await page.locator('[data-list="new"] [data-id="90"] input').uncheck();
        await page.locator('[data-list="new"] [data-id="94"] input').check();
        let copyConfirmation;
        page.once('dialog', d => { copyConfirmation = d.message(); return d.accept(); });
        await page.locator('[data-action="copy"]').click();
        assert.match(copyConfirmation, /母本「演示_母本」.*目标书「演示_目标书」/);
        await page.waitForFunction(() => /^已核验.*复制 1 条缺失条目/.test(document.querySelector('.stwu-notice').textContent));
        assert.equal(Object.keys(state.books.get('演示_目标书').entries).length, 7);
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
        assert.deepEqual(state.books.get('演示_目标书'), old);
        results.push('HTTP 保存失败锁保护且不损坏目标书通过');
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
