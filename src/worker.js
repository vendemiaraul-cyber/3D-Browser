// 3D-Browser on Cloudflare
//  • Static assets (public/) serve the three.js machine.
//  • /api/ws upgrades to a WebSocket handled by a BrowserSession Durable Object.
//    Each session id (stored per visitor in localStorage, or ?session=name to share one)
//    gets its own Durable Object, which holds one Browser Run session (Chromium).
//  • Set the ACCESS_KEY secret to require ?key=... so strangers can't spend your browser hours:
//      npx wrangler secret put ACCESS_KEY

import puppeteer from '@cloudflare/puppeteer';
import { DurableObject } from 'cloudflare:workers';
import { BrowserHub } from './core.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/ws') {
      if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected a WebSocket upgrade', { status: 426 });
      if (env.ACCESS_KEY && url.searchParams.get('key') !== env.ACCESS_KEY) return new Response('Forbidden', { status: 403 });
      const sid = (url.searchParams.get('s') || 'default').replace(/[^\w-]/g, '').slice(0, 64) || 'default';
      return env.SESSION.getByName(sid).fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
};

export class BrowserSession extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.clients = new Set();
    this.idleTimer = null;
    const keepAlive = Math.max(60, Math.min(1200, +env.KEEP_ALIVE_SECONDS || 300)) * 1000;
    this.hub = new BrowserHub({
      launch: () => puppeteer.launch(env.MYBROWSER, { keep_alive: keepAlive }),
      startUrl: env.START_URL,
      viewport: { width: +env.VIEWPORT_W || 1280, height: +env.VIEWPORT_H || 720 },
      jpegQuality: +env.JPEG_QUALITY || 65,
      emit: (ev, data) => {
        const msg = JSON.stringify({ ev, data });
        for (const ws of this.clients) { try { ws.send(msg); } catch {} }
      },
      emitFrame: (bytes) => {
        for (const ws of this.clients) { try { ws.send(bytes); } catch {} }
      },
    });
  }

  async fetch(request) {
    const { 0: client, 1: server } = new WebSocketPair();
    server.accept();
    this.clients.add(server);
    clearTimeout(this.idleTimer);

    this.hub.greet((s) => server.send(s), (b) => server.send(b));

    // Commands run one after another so mouse down/up and key presses stay in order.
    let chain = Promise.resolve();
    server.addEventListener('message', (ev) => {
      if (typeof ev.data !== 'string') return;
      let cmd;
      try { cmd = JSON.parse(ev.data); } catch { return; }
      chain = chain.then(async () => {
        let out;
        try { out = await this.hub.handle(cmd); } catch (e) { out = { error: String((e && e.message) || e).split('\n')[0] }; }
        try { server.send(JSON.stringify({ ev: 'reply', rid: cmd.rid, data: out })); } catch {}
      });
    });

    // When the last viewer leaves, close Chromium after IDLE_SECONDS to stop billing browser time.
    const drop = () => {
      if (!this.clients.delete(server)) return;
      if (this.clients.size) return;
      clearTimeout(this.idleTimer);
      this.idleTimer = setTimeout(() => { if (!this.clients.size) this.hub.close(); }, (+this.env.IDLE_SECONDS || 60) * 1000);
    };
    server.addEventListener('close', drop);
    server.addEventListener('error', drop);

    this.hub.ensure().catch(() => {});
    return new Response(null, { status: 101, webSocket: client });
  }
}
