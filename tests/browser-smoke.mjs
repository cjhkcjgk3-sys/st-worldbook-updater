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

const entry = (uid, comment, key, content, extra = {}) => ({uid,comment,key,content,...extra});
const book = entries => ({entries:Object.fromEntries(entries.map(x=>[x.uid,x])),customMetadata:'保留'});
const old = book([
    entry(0,'角色甲',['角色甲'],'旧正文：<img src=x onerror="window.__injected=true">', {order:100}),
    entry(1,'共同标题',['共同词'],'旧条目一'),entry(2,'共同标题',['共同词'],'旧条目二'),
    entry(3,'无变化',['无变化'],'同一段内容'),entry(4,'保留条目',['保留'],'保留内容'),
    entry(5,'仅设置变化',['设置'],'相同正文',{order:10}),
]);
const newer = book([
    entry(90,'角色甲',['角色甲'],'新正文。'.repeat(300),{order:200}),
    entry(91,'共同标题',['共同词'],'新共同正文'),entry(92,'无变化',['无变化'],'同一段内容'),
    entry(93,'仅设置变化',['设置'],'相同正文',{order:20}),entry(94,'新增条目',['新增'],'融合模式可选追加',{order:77,position:4,disable:true,displayIndex:0,extensions:{custom:true}}),
]);
const state = { books:null, writes:0, failWrite:false, failReadAfterWrite:false };
function reset() { state.books = new Map([['演示_旧版',structuredClone(old)],['演示_新版',structuredClone(newer)]]);state.writes=0;state.failWrite=false;state.failReadAfterWrite=false; }
reset();
const server = http.createServer(async (req,res) => {
    try {
        if(req.url.startsWith('/api/worldinfo/')) {
            assert.equal(req.headers['x-csrf-token'],'test-only');
            let text='';for await(const chunk of req)text+=chunk;
            const body=JSON.parse(text||'{}');res.setHeader('Content-Type','application/json');
            if(req.url.endsWith('/list'))return res.end(JSON.stringify([...state.books.keys()].map(name=>({file_id:name,name}))));
            if(req.url.endsWith('/get')) {
                if(state.failReadAfterWrite&&state.writes){res.statusCode=503;return res.end('{}');}
                return res.end(JSON.stringify(state.books.get(body.name)||{entries:{}}));
            }
            if(req.url.endsWith('/edit')) {
                state.writes++;if(state.failWrite){res.statusCode=500;return res.end('{}');}
                state.books.set(body.name,body.data);return res.end('{"ok":true}');
            }
        }
        const pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
        if(pathname==='/scripts/world-info.js') {
            res.setHeader('Content-Type','text/javascript; charset=utf-8');
            return res.end('export const worldInfoCache = window.__host.cache;');
        }
        if(pathname.startsWith('/__test-fonts/')&&process.env.TEST_FONT_DIR) {
            const fontRoot=path.resolve(process.env.TEST_FONT_DIR),fontFile=path.resolve(fontRoot,pathname.slice('/__test-fonts/'.length));
            if(!fontFile.startsWith(fontRoot+path.sep)){res.statusCode=403;return res.end();}
            res.setHeader('Content-Type',fontFile.endsWith('.css')?'text/css':'font/woff2');return res.end(await fs.readFile(fontFile));
        }
        const file=path.resolve(root,'.'+pathname);
        if(!file.startsWith(root+path.sep)){res.statusCode=403;return res.end();}
        let data=await fs.readFile(file);
        if(path.extname(file)==='.html'&&process.env.TEST_FONT_DIR) data=data.toString().replace('</title>','</title><link rel="stylesheet" href="/__test-fonts/index.css">');
        res.setHeader('Content-Type',({'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json'})[path.extname(file)]||'application/octet-stream');
        res.end(data);
    } catch {res.statusCode=500;res.end('test server error');}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const url='http://127.0.0.1:'+server.address().port+'/tests/browser-harness.html';
const browser=await chromium.launch(launch);
const results=[];
let currentContext;
async function prepare(width=390,height=844,context=null,allowNoUpdates=false) {
    const ctx=context||await browser.newContext({viewport:{width,height},hasTouch:true});
    currentContext=ctx;
    const page=await ctx.newPage();
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(url);await page.waitForFunction(()=>window.__ready);
    await page.getByRole('button',{name:'打开世界书更新器',exact:true}).click();
    await page.locator('[data-book="old"] option[value="book:演示_旧版"]').waitFor({state:'attached'});
    await page.locator('[data-book="old"]').selectOption('book:演示_旧版');
    await page.locator('[data-book="new"]').waitFor({state:'visible'});
    await page.waitForFunction(()=>!document.querySelector('[data-book="new"]').disabled);
    await page.locator('[data-book="new"]').selectOption('book:演示_新版');
    await page.waitForFunction(()=>!document.querySelector('[data-mode]').disabled);
    if(!allowNoUpdates) await page.waitForFunction(()=>!document.querySelector('[data-action="apply"]').disabled);
    await page.evaluate(()=>document.fonts.ready);
    return {page,ctx,errors};
}
const clickRow=(page,side,id)=>page.locator(`[data-list="${side}"] [data-id="${id}"] .stwu-entry-button`).click();
async function openPairTools(page) {
    const details=page.locator('.stwu-pairbar');
    if(await details.getAttribute('open')===null) await details.locator('summary').click();
}
async function openHeaderMenu(page) {
    const details=page.locator('.stwu-header-menu');
    if(await details.getAttribute('open')===null) await details.locator('summary').click();
}
async function assertLayout(page) {
    await page.locator('[data-action="apply"]').scrollIntoViewIfNeeded();
    const metrics=await page.evaluate(()=>{
        const d=document.querySelector('.stwu-dialog'), panels=[...document.querySelectorAll('.stwu-pane')].map(x=>x.getBoundingClientRect());
        const apply=document.querySelector('[data-action="apply"]').getBoundingClientRect();
        const scroller=document.querySelector('.stwu-layout'), bounds=scroller.getBoundingClientRect();
        return {viewport:innerWidth,width:d.getBoundingClientRect().width,overflow:d.scrollWidth>d.clientWidth+1,nativePopup:d.classList.contains('popup')&&!!d.querySelector('.popup-body .popup-content'),paneWidths:panels.map(x=>x.width),visiblePanes:panels.filter(x=>x.width>0).length,listHeight:document.querySelector('.stwu-list').clientHeight,applyBottom:apply.bottom,scrollBottom:bounds.bottom,scrollTop:bounds.top,applyTop:apply.top,overflowY:getComputedStyle(scroller).overflowY};
    });
    assert.ok(!metrics.overflow,JSON.stringify(metrics));assert.ok(metrics.width<=metrics.viewport+1,JSON.stringify(metrics));
    assert.equal(metrics.nativePopup,true,JSON.stringify(metrics));assert.equal(metrics.visiblePanes,2,JSON.stringify(metrics));
    assert.ok(Math.abs(metrics.paneWidths[0]-metrics.paneWidths[1])<=1,JSON.stringify(metrics));
    assert.ok(metrics.listHeight>30,JSON.stringify(metrics));assert.equal(metrics.overflowY,'auto',JSON.stringify(metrics));
    assert.ok(metrics.applyBottom<=metrics.scrollBottom+1&&metrics.applyTop>=metrics.scrollTop-1,JSON.stringify(metrics));
}

try {
    for(const [w,h] of [[320,568],[360,720],[390,844],[768,1024],[1280,900],[600,360],[640,360],[740,360]]) {
        reset();const {page,ctx,errors}=await prepare(w,h);
        await assertLayout(page);
        const defaultWidth=await page.locator('.stwu-dialog').evaluate(node=>node.getBoundingClientRect().width);
        await page.locator('[data-action="toggle-size"]').click();
        assert.equal(await page.locator('.stwu-dialog').evaluate(node=>node.classList.contains('stwu-expanded')),true);
        await assertLayout(page);
        const expandedWidth=await page.locator('.stwu-dialog').evaluate(node=>node.getBoundingClientRect().width);
        assert.ok(expandedWidth>defaultWidth,JSON.stringify({viewport:w,defaultWidth,expandedWidth}));
        await page.locator('[data-action="toggle-size"]').click();await assertLayout(page);
        if(h<=600) {
            assert.deepEqual(await page.locator('.stwu-pairbar, .stwu-scope').evaluateAll(nodes=>nodes.map(node=>getComputedStyle(node).display)),['none','none']);
            await page.locator('.stwu-header-menu summary').click();
            await page.waitForFunction(()=>document.querySelector('.stwu-dialog').classList.contains('stwu-tools-expanded'));
            assert.notDeepEqual(await page.locator('.stwu-pairbar, .stwu-scope').evaluateAll(nodes=>nodes.map(node=>getComputedStyle(node).display)),['none','none']);
            await page.locator('.stwu-header-menu summary').click();
            await page.waitForFunction(()=>!document.querySelector('.stwu-dialog').classList.contains('stwu-tools-expanded'));
        }
        if(process.env.SCREENSHOT_DIR) {
            await fs.mkdir(process.env.SCREENSHOT_DIR,{recursive:true});
            await page.screenshot({path:path.join(process.env.SCREENSHOT_DIR,`list-${w}x${h}.png`)});
        }
        assert.match(await page.locator('.stwu-selection').textContent(),/已选 1 条/);
        await page.locator('[data-mode]').selectOption('merge-content');
        await assertLayout(page);
        assert.match(await page.locator('.stwu-selection').textContent(),/更新 1 · 新增 1/);
        assert.equal(await page.locator('[data-action="apply"]').count(),1);
        assert.equal(await page.locator('.stwu-pairbar [data-pair-action]').count(),1);
        assert.equal(await page.locator('[data-list="new"] [data-id="91"] input').isDisabled(),true);
        if(process.env.SCREENSHOT_DIR) await page.screenshot({path:path.join(process.env.SCREENSHOT_DIR,`fusion-${w}x${h}.png`)});
        await page.locator('[data-mode]').selectOption('content');
        await clickRow(page,'old','0');
        await page.waitForFunction(()=>document.querySelector('.stwu-workspace').dataset.previewOpen==='true');
        const axes=await page.locator('.stwu-preview-pane').evaluateAll(nodes=>nodes.map(n=>({x:n.getBoundingClientRect().x,w:n.getBoundingClientRect().width})));
        assert.ok(axes[1].x>axes[0].x);assert.ok(Math.abs(axes[0].w-axes[1].w)<2);
        assert.match(await page.locator('[data-preview-content="old"]').textContent(),/onerror/);
        if(process.env.SCREENSHOT_DIR) await page.screenshot({path:path.join(process.env.SCREENSHOT_DIR,`preview-${w}x${h}.png`)});
        assert.equal(await page.locator('.stwu-preview img').count(),0);
        assert.equal(await page.evaluate(()=>window.__injected),undefined);
        assert.equal(await page.locator('[data-list="old"] [data-id="0"] [aria-pressed="true"]').count(),1);
        assert.deepEqual(errors,[]);
        results.push(`布局 ${w}×${h}、双窗口、正文对照与纯文本显示通过`);await ctx.close();
    }

    reset();{
        const manyBook=book(Array.from({length:150},(_,i)=>entry(i,`角色 ${String(i+1).padStart(3,'0')}`,[`角色 ${i+1}`],`正文 ${i+1}`)));
        const manyNew=book(Array.from({length:150},(_,i)=>entry(i+500,`角色 ${String(i+1).padStart(3,'0')}`,[`角色 ${i+1}`],`新版正文 ${i+1}`)));
        state.books=new Map([['演示_旧版',manyBook],['演示_新版',manyNew]]);
        const {page,ctx}=await prepare(390,844);
        assert.equal(await page.locator('[data-list="old"] .stwu-entry').count(),150);
        await clickRow(page,'old','80');
        await page.waitForFunction(()=>document.querySelector('.stwu-workspace').dataset.previewOpen==='true');
        const listPanel=page.locator('[data-resize-panel="list"]'), previewPanel=page.locator('[data-resize-panel="preview"]');
        const listHandle=page.locator('[data-resize="list"]'), previewHandle=page.locator('[data-resize="preview"]');
        const height=locator=>locator.evaluate(node=>node.getBoundingClientRect().height);
        const listBefore=await height(listPanel), previewBefore=await height(previewPanel);
        await listHandle.evaluate(node=>node.scrollIntoView({block:'center'}));
        const box=await listHandle.boundingBox();
        await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();
        await page.mouse.move(box.x+box.width/2,box.y+box.height/2+45,{steps:5});await page.mouse.up();
        const listAfter=await height(listPanel);
        assert.ok(listAfter>listBefore+25,JSON.stringify({listBefore,listAfter}));
        assert.equal(await height(previewPanel),previewBefore);
        await previewHandle.focus();await page.keyboard.press('ArrowDown');
        assert.ok(await height(previewPanel)>previewBefore);
        assert.equal(await height(listPanel),listAfter);
        const max=Number(await previewHandle.getAttribute('aria-valuemax'));
        const initialDialogHeight=await page.locator('.stwu-dialog').evaluate(node=>node.getBoundingClientRect().height);
        assert.ok(Math.abs(max-initialDialogHeight*50)<=1);
        const input=page.locator('[data-resize-input="preview"]');
        await input.fill(String(max+1000));await input.dispatchEvent('change');
        assert.equal(await height(previewPanel),max);assert.equal(await height(listPanel),listAfter);
        await input.fill('120');await input.dispatchEvent('change');
        assert.equal(await height(previewPanel),120);
        await assertLayout(page);
        assert.match(await page.locator('[data-preview-content="old"]').textContent(),/正文 81/);
        results.push('150 条目、独立鼠标/键盘/输入调整、50 倍上限及窗口滚动通过');await ctx.close();
    }

    reset();{
        const {page,ctx}=await prepare();
        await page.locator('[data-search="old"]').focus();
        await page.evaluate(()=>{
            Object.defineProperty(visualViewport,'height',{value:380,configurable:true});
            visualViewport.dispatchEvent(new Event('resize'));
        });
        await page.locator('[data-action="apply"]').scrollIntoViewIfNeeded();
        const metrics=await page.evaluate(()=>({compact:document.querySelector('.stwu-dialog').classList.contains('stwu-keyboard'),listHeight:document.querySelector('.stwu-list').clientHeight,bottom:document.querySelector('[data-action="apply"]').getBoundingClientRect().bottom,scrollBottom:document.querySelector('.stwu-layout').getBoundingClientRect().bottom}));
        assert.equal(metrics.compact,true);assert.ok(metrics.listHeight>30);assert.ok(metrics.bottom<=metrics.scrollBottom+1,JSON.stringify(metrics));
        results.push('模拟键盘引起的可视视口收缩后，列表与底部操作仍可滚动到达');await ctx.close();
    }

    reset();{
        const {page,ctx,errors}=await prepare();
        await clickRow(page,'old','1');await clickRow(page,'new','91');await openPairTools(page);await page.locator('[data-pair-action]').selectOption('pair');
        assert.match(await page.locator('.stwu-selection').textContent(),/已选 2 条/);
        page.once('dialog',d=>d.accept());await page.getByRole('button',{name:'替换所选',exact:true}).click();
        await page.waitForFunction(()=>document.querySelector('.stwu-notice').textContent.startsWith('已核验'));
        assert.equal(state.writes,1);const persisted=state.books.get('演示_旧版');
        assert.equal(persisted.entries[0].uid,0);assert.equal(persisted.entries[0].order,100);
        assert.equal(persisted.entries[1].content,'新共同正文');assert.equal(persisted.entries[2].content,'旧条目二');
        assert.equal(Object.keys(persisted.entries).length,6);assert.equal(persisted.customMetadata,'保留');
        await page.reload();await page.waitForFunction(()=>window.__ready);await page.getByRole('button',{name:'打开世界书更新器',exact:true}).click();
        await page.waitForFunction(()=>!document.querySelector('[data-book="old"]').disabled);
        await page.locator('[data-book="old"]').selectOption('book:演示_旧版');
        await page.locator('[data-list="old"] [data-id="1"]').waitFor();
        assert.equal(await page.locator('[data-action="restore"]').count(),0);
        assert.equal(state.books.get('演示_旧版').entries[1].content,'新共同正文');assert.equal(state.writes,1);assert.deepEqual(errors,[]);
        await page.evaluate(()=>window.__extension.onDisable());assert.equal(await page.locator('.stwu-dialog,#st-worldbook-updater-launcher').count(),0);
        assert.equal(await page.evaluate(()=>[...window.__host.events.values()].reduce((n,s)=>n+s.size,0)),0);
        await ctx.close();
    }

    reset();{
        const {page,ctx}=await prepare();await page.locator('[data-mode]').selectOption('full');
        assert.match(await page.locator('.stwu-selection').textContent(),/已选 2 条/);
        page.once('dialog',d=>d.accept());await page.getByRole('button',{name:'替换所选',exact:true}).click();
        await page.waitForFunction(()=>document.querySelector('.stwu-notice').textContent.startsWith('已核验'));
        assert.equal(state.books.get('演示_旧版').entries[5].order,20);assert.equal(state.books.get('演示_旧版').entries[5].uid,5);
        results.push('完整更新同步设置并保留目标编号通过');await ctx.close();
    }

    reset();{
        const {page,ctx}=await prepare();
        await page.locator('[data-file]').setInputFiles({name:'坏文件.json',mimeType:'application/json',buffer:Buffer.from('{')});
        await page.waitForFunction(()=>document.querySelector('.stwu-notice').textContent.includes('JSON 格式不正确'));
        assert.equal(state.writes,0);
        await page.locator('[data-file]').setInputFiles({name:'更新文件.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(newer))});
        await page.waitForFunction(()=>document.querySelector('[data-book="new"]').value==='file:');
        assert.match(await page.locator('.stwu-selection').textContent(),/已选 1 条/);
        results.push('手机文件选择路径、无效 JSON 拒绝、内存载入通过');await ctx.close();
    }

    reset();{
        const {page,ctx}=await prepare();state.books.get('演示_旧版').entries[0].content='外部编辑';
        page.once('dialog',d=>d.accept());await page.getByRole('button',{name:'替换所选',exact:true}).click();
        await page.waitForFunction(()=>document.querySelector('.stwu-notice').textContent.includes('预览后发生了变化'));
        assert.equal(state.writes,0);results.push('预览后外部修改拦截通过');await ctx.close();
    }

    reset();{
        const {page,ctx}=await prepare();state.failWrite=true;
        page.once('dialog',d=>d.accept());await page.getByRole('button',{name:'替换所选',exact:true}).click();
        await page.waitForFunction(()=>document.querySelector('.stwu-notice').textContent.includes('服务器未确认保存'));
        assert.equal(await page.locator('[data-action="apply"]').isDisabled(),true);
        assert.deepEqual(state.books.get('演示_旧版'),old);results.push('HTTP 保存失败不误报完成通过');await ctx.close();
    }

    reset();{
        const {page,ctx}=await prepare();state.failReadAfterWrite=true;
        page.once('dialog',d=>d.accept());await page.getByRole('button',{name:'替换所选',exact:true}).click();
        await page.waitForFunction(()=>document.querySelector('.stwu-notice').textContent.includes('保存结果尚未确认'));
        state.failReadAfterWrite=false;
        await page.reload();await page.waitForFunction(()=>window.__ready);await page.getByRole('button',{name:'打开世界书更新器',exact:true}).click();
        await page.waitForFunction(()=>!document.querySelector('[data-book="old"]').disabled);
        await page.locator('[data-book="old"]').selectOption('book:演示_旧版');
        await page.locator('[data-list="old"] [data-id="0"]').waitFor();
        assert.equal(state.books.get('演示_旧版').entries[0].content,newer.entries[90].content);
        assert.equal(state.writes,1);results.push('保存后断线，刷新后人工核对且不重复写入通过');await ctx.close();
    }
    reset();{
        const {page,ctx}=await prepare();
        await page.locator('[data-mode]').selectOption('merge-content');
        await page.locator('[data-list="new"] [data-id="90"] input').uncheck();
        assert.equal(await page.locator('[data-list="old"] [data-id="0"] input').isChecked(),false);
        assert.match(await page.locator('.stwu-selection').textContent(),/更新 0 · 新增 1/);
        await page.locator('[data-selection]').selectOption('none');
        assert.match(await page.locator('.stwu-selection').textContent(),/更新 0 · 新增 0/);
        assert.equal(await page.locator('[data-action="apply"]').isDisabled(),true);
        await page.locator('[data-mode]').selectOption('merge-full');
        assert.match(await page.locator('.stwu-selection').textContent(),/更新 0 · 新增 0/);
        await page.locator('[data-search="old"]').fill('没有显示结果');
        await page.locator('[data-search="new"]').fill('也没有显示结果');
        await page.locator('[data-selection]').selectOption('all');
        assert.match(await page.locator('.stwu-selection').textContent(),/更新 2 · 新增 1/);
        assert.match(await page.locator('.stwu-notice').textContent(),/包含搜索隐藏/);
        await page.locator('[data-selection]').selectOption('additions');
        assert.match(await page.locator('.stwu-selection').textContent(),/更新 0 · 新增 1/);
        await page.locator('[data-selection]').selectOption('updates');
        assert.match(await page.locator('.stwu-selection').textContent(),/更新 2 · 新增 0/);
        await page.locator('[data-selection]').selectOption('none');
        await page.locator('[data-mode]').selectOption('content');
        assert.match(await page.locator('.stwu-selection').textContent(),/已选 0 条/);
        assert.equal(state.writes,0);
        results.push('全部勾选、部分勾选后直接全部取消、左右同步、搜索隐藏项范围和模式切换通过');await ctx.close();
    }

    reset();{
        const {page,ctx}=await prepare();await page.locator('[data-mode]').selectOption('merge-content');
        await clickRow(page,'new','94');
        assert.match(await page.locator('[data-preview-content="old"]').textContent(),/尚未选择对应条目/);
        assert.match(await page.locator('[data-preview-content="new"]').textContent(),/融合模式可选追加/);
        await openPairTools(page);await clickRow(page,'new','91');await page.locator('[data-pair-action]').selectOption('new');
        assert.match(await page.locator('.stwu-selection').textContent(),/更新 1 · 新增 2/);
        await page.locator('[data-pair-action]').selectOption('new');
        assert.match(await page.locator('.stwu-selection').textContent(),/更新 1 · 新增 1/);
        await page.locator('[data-pair-action]').selectOption('unpair-all');
        assert.equal(await page.locator('.stwu-entry-status').filter({hasText:'配对 '}).count(),0);
        await page.locator('[data-pair-action]').selectOption('auto');
        assert.match(await page.locator('.stwu-selection').textContent(),/更新 0/);
        page.once('dialog',d=>d.accept());await page.locator('[data-pair-action]').selectOption('auto-reset');
        assert.match(await page.locator('.stwu-selection').textContent(),/更新 1 · 新增 1/);
        await clickRow(page,'old','0');await clickRow(page,'new','90');
        await page.locator('[data-pair-action]').selectOption('unpair');
        await page.locator('[data-pair-action]').selectOption('pair');
        assert.match(await page.locator('.stwu-notice').textContent(),/已手动配对/);
        assert.equal(state.writes,0);
        results.push('新条目单侧查看、冲突新增标记与取消、解除全部、重新匹配和手动恢复配对通过');await ctx.close();
    }

    reset();{
        const {page,ctx}=await prepare();await page.locator('[data-mode]').selectOption('merge-content');
        page.once('dialog',d=>d.dismiss());await page.getByRole('button',{name:'融合所选',exact:true}).click();
        await page.waitForFunction(()=>!document.querySelector('[data-action="apply"]').disabled);
        assert.equal(state.writes,0);assert.deepEqual(state.books.get('演示_旧版'),old);
        page.once('dialog',d=>{assert.match(d.message(),/更新 1 条，新增 1 条/);return d.accept();});
        await page.getByRole('button',{name:'融合所选',exact:true}).click();
        await page.waitForFunction(()=>document.querySelector('.stwu-notice').textContent.startsWith('已核验'));
        const merged=state.books.get('演示_旧版');assert.equal(state.writes,1);assert.equal(Object.keys(merged.entries).length,7);
        assert.equal(merged.entries[6].uid,6);assert.equal(merged.entries[6].order,77);assert.equal(merged.entries[6].disable,true);
        assert.equal(merged.entries[6].extensions.custom,true);assert.equal(merged.entries[6].displayIndex,6);
        assert.equal(merged.entries[0].order,100);assert.equal(merged.entries[4].content,'保留内容');
        assert.match(await page.locator('.stwu-selection').textContent(),/更新 0 · 新增 0/);
        await openHeaderMenu(page);await page.getByRole('button',{name:'重新载入',exact:true}).click();
        await page.waitForFunction(()=>!document.querySelector('[data-mode]').disabled);
        assert.match(await page.locator('.stwu-selection').textContent(),/更新 0 · 新增 0/);
        assert.equal(await page.locator('[data-action="apply"]').isDisabled(),true);assert.equal(state.writes,1);
        assert.deepEqual(state.books.get('演示_旧版'),merged);
        results.push('融合确认可取消、更新与新增单次保存、编号避让、重复载入不重复追加通过');await ctx.close();
    }

    reset();{
        const {page,ctx}=await prepare();await page.locator('[data-mode]').selectOption('merge-content');
        await page.locator('[data-selection]').selectOption('additions');
        page.once('dialog',d=>d.accept());await page.getByRole('button',{name:'融合所选',exact:true}).click();
        await page.waitForFunction(()=>document.querySelector('.stwu-notice').textContent.startsWith('已核验'));
        assert.equal(state.books.get('演示_旧版').entries[0].content,old.entries[0].content);
        assert.equal(Object.keys(state.books.get('演示_旧版').entries).length,7);
        results.push('仅勾选新增可批量追加，同时保留已配对的旧正文通过');await ctx.close();
    }


    reset();{
        const {page,ctx}=await prepare();await page.locator('[data-mode]').selectOption('merge-full');state.failWrite=true;
        page.once('dialog',d=>d.accept());await page.getByRole('button',{name:'融合所选',exact:true}).click();
        await page.waitForFunction(()=>document.querySelector('.stwu-notice').textContent.includes('服务器未确认保存'));
        assert.deepEqual(state.books.get('演示_旧版'),old);assert.equal(await page.locator('[data-action="apply"]').isDisabled(),true);
        results.push('完整融合保存失败不误报成功，也不留下半本融合数据通过');await ctx.close();
    }

    reset();{
        state.books.set('演示_旧版',{entries:{}});
        const {page,ctx}=await prepare(390,844,null,true);
        assert.equal(await page.locator('[data-action="apply"]').isDisabled(),true);
        await page.locator('[data-mode]').selectOption('merge-content');
        assert.match(await page.locator('.stwu-selection').textContent(),/更新 0 · 新增 5/);
        page.once('dialog',d=>d.accept());await page.getByRole('button',{name:'融合所选',exact:true}).click();
        await page.waitForFunction(()=>document.querySelector('.stwu-notice').textContent.startsWith('已核验'));
        assert.equal(Object.keys(state.books.get('演示_旧版').entries).length,5);
        results.push('没有配对的空原书也可批量融合新增，默认更新模式不误写入通过');await ctx.close();
    }

    reset();{
        state.books.set('演示_新版',{entries:{}});
        const {page,ctx}=await prepare(390,844,null,true);
        await page.locator('[data-mode]').selectOption('merge-content');
        assert.match(await page.locator('.stwu-selection').textContent(),/更新 0 · 新增 0/);
        assert.equal(await page.locator('[data-action="apply"]').isDisabled(),true);
        assert.equal(await page.locator('[data-list="new"]').textContent(),'这本世界书还没有条目');
        assert.equal(state.writes,0);results.push('空来源书显示明确空状态，并禁用无内容执行通过');await ctx.close();
    }

    const report={pass:true,browser:await browser.version(),results};
    if(process.env.REPORT_FILE) await fs.writeFile(process.env.REPORT_FILE,JSON.stringify(report,null,2)+'\n');
    console.log(JSON.stringify(report,null,2));
} finally {await currentContext?.close().catch(()=>{});await browser.close();await new Promise(resolve=>server.close(resolve));}
