// Chroma Voxelizer — Chromium backend
// Drives a real Chromium (via Playwright): tabs, navigation, mouse/keyboard input,
// auto-crawl across many pages, and a live JPEG screencast streamed to the 3D client.
//
//   npm install && npx playwright install chromium && npm start
//   open http://localhost:8080 in Chromium
//
// Env: PORT=8080  HOST=127.0.0.1  HEADLESS=1|0  VIEWPORT_W=1280  VIEWPORT_H=720
//      START_URL=...  CHROMIUM_PATH=/path/to/chrome  JPEG_QUALITY=75

const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const PORT = +process.env.PORT || 8080;
const HOST = process.env.HOST || '127.0.0.1';
const HEADLESS = process.env.HEADLESS !== '0';
const START_URL = process.env.START_URL || 'https://en.wikipedia.org/wiki/Color';
const JPEG_QUALITY = +process.env.JPEG_QUALITY || 75;
let viewport = { width: +process.env.VIEWPORT_W || 1280, height: +process.env.VIEWPORT_H || 720 };

let browser, context;
const tabs = new Map();          // id -> tab
const byPage = new WeakMap();    // page -> tab
let activeId = null, nextId = 1, lastFrame = null;
const clients = new Set();

// ---------------------------------------------------------------- events (SSE)
function broadcast(ev, data) {
  const msg = `event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    if (ev === 'frame' && res.writableLength > 4e6) continue; // slow client: drop frames, not state
    res.write(msg);
  }
}
const toast = (text) => broadcast('toast', { text });
function tabList() {
  return {
    active: activeId,
    tabs: [...tabs.values()].map(t => ({ id: t.id, title: t.title || t.page.url(), url: t.page.url(), loading: t.loading })),
  };
}
const pushTabs = () => broadcast('tabs', tabList());

// ---------------------------------------------------------------- tabs
function tabFor(page) {
  let t = byPage.get(page);
  if (t) return t;
  t = { id: nextId++, page, cdp: null, title: '', loading: false, lastMouse: null };
  tabs.set(t.id, t);
  byPage.set(page, t);
  const refreshTitle = async () => { t.title = await page.title().catch(() => t.title); };
  page.on('framenavigated', f => { if (f === page.mainFrame()) { t.loading = true; pushTabs(); } });
  page.on('domcontentloaded', async () => { await refreshTitle(); t.loading = false; pushTabs(); });
  page.on('load', async () => {
    await refreshTitle(); t.loading = false; pushTabs();
    if (activeId === t.id) { await startCast(t); snapshot(t); }
  });
  page.on('close', () => {
    tabs.delete(t.id);
    if (activeId === t.id) {
      activeId = null;
      const rest = [...tabs.keys()];
      if (rest.length) activate(rest[rest.length - 1]); else newTab(START_URL);
    }
    pushTabs();
  });
  page.setViewportSize(viewport).catch(() => {});
  pushTabs();
  return t;
}

async function startCast(t) {
  try {
    if (!t.cdp) {
      t.cdp = await context.newCDPSession(t.page);
      t.cdp.on('Page.screencastFrame', f => {
        t.cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
        if (activeId !== t.id) return;
        lastFrame = { tab: t.id, data: f.data };
        broadcast('frame', lastFrame);
      });
    }
    await t.cdp.send('Page.startScreencast', {
      format: 'jpeg', quality: JPEG_QUALITY,
      maxWidth: viewport.width, maxHeight: viewport.height, everyNthFrame: 1,
    });
  } catch { /* page may be mid-navigation; 'load' retries */ }
}
async function stopCast(t) { if (t && t.cdp) await t.cdp.send('Page.stopScreencast').catch(() => {}); }
async function snapshot(t) {
  try {
    const buf = await t.page.screenshot({ type: 'jpeg', quality: JPEG_QUALITY });
    if (activeId !== t.id) return;
    lastFrame = { tab: t.id, data: buf.toString('base64') };
    broadcast('frame', lastFrame);
  } catch {}
}
async function activate(id) {
  const t = tabs.get(id);
  if (!t) return;
  if (activeId !== null && activeId !== id) await stopCast(tabs.get(activeId));
  activeId = id;
  await t.page.bringToFront().catch(() => {});
  await startCast(t);
  pushTabs();
  snapshot(t);
}
async function newTab(url) {
  const page = await context.newPage();
  const t = tabFor(page);
  await activate(t.id);
  const u = normalize(url);
  if (u) go(t, u);
  return t;
}

// ---------------------------------------------------------------- navigation
function normalize(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return s;                       // has a scheme
  if (/^(localhost|127\.|\[::1\])/i.test(s)) return 'http://' + s;
  if (/^[^\s/]+\.[^\s/]{2,}(\/\S*)?$/.test(s)) return 'https://' + s; // looks like a host
  return 'https://duckduckgo.com/?q=' + encodeURIComponent(s);        // otherwise search
}
async function go(t, url) {
  t.loading = true; pushTabs();
  try { await t.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 }); }
  catch (e) { toast(`Couldn't load ${url}: ${String(e.message).split('\n')[0]}`); }
  t.loading = false; pushTabs();
}

// ---------------------------------------------------------------- auto-crawl ("a lot of pages")
const crawl = { on: false, dwell: 6, sameOrigin: false, max: 200, scroll: true, queue: [], visited: new Set(), count: 0, timer: null, scrollTimer: null, current: '' };
const crawlState = () => ({ on: crawl.on, visited: crawl.count, queued: crawl.queue.length, current: crawl.current, max: crawl.max, dwell: crawl.dwell, sameOrigin: crawl.sameOrigin, scroll: crawl.scroll });
const pushCrawl = () => broadcast('crawl', crawlState());
const canon = (h) => { try { const u = new URL(h); if (!/^https?:$/.test(u.protocol)) return null; u.hash = ''; return u.href; } catch { return null; } };

function enqueue(urls, front = false) {
  let n = 0;
  const add = [];
  for (const raw of urls) {
    const s = canon(normalize(raw));
    if (s && !crawl.visited.has(s) && !crawl.queue.includes(s) && !add.includes(s)) { add.push(s); n++; }
  }
  if (front) crawl.queue.unshift(...add); else crawl.queue.push(...add);
  if (crawl.queue.length > 5000) crawl.queue.length = 5000;
  pushCrawl();
  return n;
}
async function harvest(t) {
  try {
    const here = new URL(t.page.url());
    let links = await t.page.$$eval('a[href]', as => as.map(a => a.href));
    links = links.map(canon).filter(Boolean).filter(h => !crawl.sameOrigin || new URL(h).origin === here.origin);
    for (let i = links.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [links[i], links[j]] = [links[j], links[i]]; }
    enqueue(links.slice(0, 300));
  } catch {}
}
function stopCrawl() {
  crawl.on = false;
  clearTimeout(crawl.timer); clearInterval(crawl.scrollTimer);
  pushCrawl();
}
async function crawlStep() {
  if (!crawl.on) return;
  clearInterval(crawl.scrollTimer);
  const t = tabs.get(activeId);
  if (!t) return stopCrawl();
  const here = canon(t.page.url());
  if (here) crawl.visited.add(here);
  await harvest(t);
  let next;
  while ((next = crawl.queue.shift()) && crawl.visited.has(next)) {}
  if (!next || crawl.count >= crawl.max) { toast(next ? `Auto-browse finished: ${crawl.count} pages` : 'Auto-browse: no more links'); return stopCrawl(); }
  crawl.visited.add(next); crawl.count++; crawl.current = next;
  pushCrawl();
  await go(t, next);
  if (!crawl.on) return;
  if (crawl.scroll) {
    crawl.scrollTimer = setInterval(() => {
      t.page.evaluate(() => window.scrollBy({ top: innerHeight * 0.6, behavior: 'smooth' })).catch(() => {});
    }, Math.max(1200, crawl.dwell * 1000 / 4));
  }
  crawl.timer = setTimeout(crawlStep, crawl.dwell * 1000);
}

// ---------------------------------------------------------------- commands
const BUTTONS = ['left', 'middle', 'right'];
async function handle(cmd) {
  const t = tabs.get(cmd.tab) || tabs.get(activeId);
  switch (cmd.type) {
    case 'navigate': { const u = normalize(cmd.url); if (u && t) go(t, u); return { ok: true, url: u }; }
    case 'newTab': { const nt = await newTab(cmd.url || 'about:blank'); return { ok: true, id: nt.id }; }
    case 'closeTab': { const x = tabs.get(cmd.id); if (x) await x.page.close().catch(() => {}); return { ok: true }; }
    case 'switch': await activate(cmd.id); return { ok: true };
    case 'back': t && t.page.goBack({ timeout: 15000 }).catch(() => {}); return { ok: true };
    case 'forward': t && t.page.goForward({ timeout: 15000 }).catch(() => {}); return { ok: true };
    case 'reload': t && t.page.reload({ timeout: 25000 }).catch(() => {}); return { ok: true };
    case 'mouse': {
      if (!t) return { ok: false };
      const x = Math.max(0, Math.min(1, +cmd.x)) * viewport.width, y = Math.max(0, Math.min(1, +cmd.y)) * viewport.height;
      t.lastMouse = { x, y };
      const button = BUTTONS[cmd.button] || 'left';
      await t.page.mouse.move(x, y);
      if (cmd.action === 'down') await t.page.mouse.down({ button });
      else if (cmd.action === 'up') await t.page.mouse.up({ button });
      return { ok: true };
    }
    case 'wheel': {
      if (!t) return { ok: false };
      const m = t.lastMouse || { x: viewport.width / 2, y: viewport.height / 2 };
      await t.page.mouse.move(m.x, m.y);
      await t.page.mouse.wheel(+cmd.dx || 0, +cmd.dy || 0);
      return { ok: true };
    }
    case 'type': if (t) await t.page.keyboard.type(String(cmd.text || '').slice(0, 500)); return { ok: true };
    case 'press': if (t) await t.page.keyboard.press(String(cmd.key)); return { ok: true };
    case 'viewport': {
      viewport = { width: Math.max(320, Math.min(1920, cmd.width | 0)), height: Math.max(320, Math.min(1920, cmd.height | 0)) };
      for (const x of tabs.values()) await x.page.setViewportSize(viewport).catch(() => {});
      const a = tabs.get(activeId);
      if (a) { await stopCast(a); await startCast(a); snapshot(a); }
      return { ok: true, viewport };
    }
    case 'crawl': {
      if ('dwell' in cmd) crawl.dwell = Math.max(1, Math.min(120, +cmd.dwell || 6));
      if ('sameOrigin' in cmd) crawl.sameOrigin = !!cmd.sameOrigin;
      if ('scroll' in cmd) crawl.scroll = !!cmd.scroll;
      if ('max' in cmd) crawl.max = Math.max(1, Math.min(100000, cmd.max | 0));
      if (cmd.reset) { crawl.visited.clear(); crawl.queue.length = 0; crawl.count = 0; crawl.current = ''; }
      if (cmd.on === true && !crawl.on) { crawl.on = true; crawl.count = 0; pushCrawl(); crawl.timer = setTimeout(crawlStep, 300); }
      else if (cmd.on === false) stopCrawl();
      else pushCrawl();
      return { ok: true, crawl: crawlState() };
    }
    case 'enqueue': return { ok: true, added: enqueue(Array.isArray(cmd.urls) ? cmd.urls : [], !!cmd.front) };
    default: return { error: 'unknown command ' + cmd.type };
  }
}

// ---------------------------------------------------------------- http
const PUB = path.join(__dirname, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(`event: hello\ndata: ${JSON.stringify({ viewport })}\n\n`);
    res.write(`event: tabs\ndata: ${JSON.stringify(tabList())}\n\n`);
    res.write(`event: crawl\ndata: ${JSON.stringify(crawlState())}\n\n`);
    if (lastFrame) res.write(`event: frame\ndata: ${JSON.stringify(lastFrame)}\n\n`);
    clients.add(res);
    const hb = setInterval(() => res.write(': hb\n\n'), 15000);
    req.on('close', () => { clearInterval(hb); clients.delete(res); });
    return;
  }
  if (url.pathname === '/api/cmd' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', async () => {
      let out;
      try { out = await handle(JSON.parse(body || '{}')); } catch (e) { out = { error: String(e.message || e).split('\n')[0] }; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out));
    });
    return;
  }
  const file = path.join(PUB, url.pathname === '/' ? 'index.html' : path.normalize(url.pathname));
  if (!file.startsWith(PUB)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

(async () => {
  browser = await chromium.launch({
    headless: HEADLESS,
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: ['--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required'],
  });
  context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  context.on('page', async (page) => {          // popups / target=_blank
    const known = byPage.has(page);
    const t = tabFor(page);
    if (!known && await page.opener().catch(() => null)) activate(t.id);
  });
  await newTab(START_URL);
  server.listen(PORT, HOST, () => console.log(`Chroma Voxelizer → http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}  (Chromium ${browser.version()}, ${HEADLESS ? 'headless' : 'headed'})`));
})().catch(e => { console.error(e); process.exit(1); });

const quit = async () => { try { await browser?.close(); } catch {} process.exit(0); };
process.on('SIGINT', quit); process.on('SIGTERM', quit);
