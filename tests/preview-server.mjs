// Local, in-memory SillyTavern fixture for visually checking the updater UI.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const makeBook = prefix => ({ entries: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [i, {
    uid: i, comment: `测试条目 ${String(i + 1).padStart(2, '0')}`, key: [`条目 ${i + 1}`],
    content: `${prefix}正文 ${i + 1}\n${'这是一段用于检查长正文滚动与区域拉伸的测试内容。\n'.repeat(150)}`,
}])) });
const books = new Map([['测试原书', makeBook('原书')], ['测试新版', makeBook('新版')]]);
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

const server = http.createServer(async (req, res) => {
    try {
        if (req.url.startsWith('/api/worldinfo/')) {
            let text = '';
            for await (const chunk of req) text += chunk;
            const body = JSON.parse(text || '{}');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            if (req.url.endsWith('/list')) return res.end(JSON.stringify([...books.keys()].map(name => ({ file_id: name, name }))));
            if (req.url.endsWith('/get')) return res.end(JSON.stringify(books.get(body.name) || { entries: {} }));
            if (req.url.endsWith('/edit')) { books.set(body.name, body.data); return res.end('{"ok":true}'); }
        }
        const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
        if (pathname === '/') { res.writeHead(302, { Location: '/tests/browser-harness.html' }); return res.end(); }
        if (pathname === '/scripts/world-info.js') {
            res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
            return res.end('export const worldInfoCache = window.__host.cache;');
        }
        const filename = path.resolve(root, '.' + (pathname === '/' ? '/tests/browser-harness.html' : pathname));
        if (!filename.startsWith(root + path.sep)) { res.statusCode = 403; return res.end(); }
        const data = await fs.readFile(filename);
        res.setHeader('Content-Type', `${types[path.extname(filename)] || 'application/octet-stream'}; charset=utf-8`);
        res.end(data);
    } catch { res.statusCode = 500; res.end('Local preview error'); }
});
server.listen(Number(process.env.STWU_PREVIEW_PORT || 4173), '127.0.0.1', () => {
    console.log(`Local preview (test data only): http://127.0.0.1:${server.address().port}/`);
});
