// 3D-Browser — local Node server (same protocol and browser logic as the Cloudflare Worker)
//
//   npm run local:setup   # installs puppeteer + ws (not needed for Cloudflare)
//   npm run local         # → http://127.0.0.1:8080
//
// Env: PORT=8080  HOST=127.0.0.1  HEADLESS=1|0  VIEWPORT_W=1280  VIEWPORT_H=720
//      START_URL=...  CHROMIUM_PATH=/path/to/chromium  JPEG_QUALITY=70

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserHub } from './src/core.js';

let puppeteer, WebSocketServer;
try {
  puppeteer = (await import('puppeteer')).default;
  ({ WebSocketServer } = await import('ws'));
} catch {
  console.error('Missing local dependencies. Run:  npm run local:setup');
  process.exit(1);
}

const PORT = +process.env.PORT || 8080;
const HOST = process.env.HOST || '127.0.0.1';
const HEADLESS = process.env.HEADLESS !== '0';
const clients = new Set();

const hub = new BrowserHub({
  launch: () => puppeteer.launch({
    headless: HEADLESS,
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: ['--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required'],
  }),
  startUrl: process.env.START_URL,
  viewport: { width: +process.env.VIEWPORT_W || 1280, height: +process.env.VIEWPORT_H || 720 },
  jpegQuality: +process.env.JPEG_QUALITY || 70,
  emit: (ev, data) => {
    const msg = JSON.stringify({ ev, data });
    for (const ws of clients) if (ws.readyState === 1) ws.send(msg);
  },
  emitFrame: (bytes) => {
    for (const ws of clients) if (ws.readyState === 1 && ws.bufferedAmount < 4e6) ws.send(bytes);
  },
});

const PUB = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => {
  const { pathname } = new URL(req.url, 'http://x');
  const file = path.join(PUB, pathname === '/' ? 'index.html' : path.normalize(pathname));
  if (!file.startsWith(PUB)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server, path: '/api/ws' });
wss.on('connection', (ws) => {
  clients.add(ws);
  hub.greet((s) => ws.send(s), (b) => ws.send(b));
  let chain = Promise.resolve();
  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    let cmd;
    try { cmd = JSON.parse(data.toString()); } catch { return; }
    chain = chain.then(async () => {
      let out;
      try { out = await hub.handle(cmd); } catch (e) { out = { error: String(e.message || e).split('\n')[0] }; }
      if (ws.readyState === 1) ws.send(JSON.stringify({ ev: 'reply', rid: cmd.rid, data: out }));
    });
  });
  ws.on('close', () => clients.delete(ws));
});

await hub.ensure();
const version = await hub.browser.version();
server.listen(PORT, HOST, () => console.log(`3D-Browser → http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}  (${version}, ${HEADLESS ? 'headless' : 'headed'})`));

const quit = async () => { await hub.close(); process.exit(0); };
process.on('SIGINT', quit);
process.on('SIGTERM', quit);
