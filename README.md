# 3D-Browser
It turns pages from chromium into 3D!

**Chroma Voxelizer** is a 3D machine built in three.js. A real Chromium browses the web,
and the machine sweeps a laser over each live page looking for a target color. Every
matching pixel gets printed onto a wall of small cubes.

It runs on **Cloudflare Workers**, using Browser Run for Chromium and Durable Objects to keep
sessions alive. It also runs **locally** with Node.

## Deploy to Cloudflare

```bash
npm install
npx wrangler login
npx wrangler deploy
```

Or connect this repo in the dashboard: **Workers & Pages → Create → Import a repository**. The
default build settings work, and the deploy command is `npx wrangler deploy`.

**Protect your browser hours.** Anyone who opens the URL starts a Chromium session on your
account. Set an access key:

```bash
npx wrangler secret put ACCESS_KEY
```

Then open the site once as `https://<your-worker>.workers.dev/?key=YOUR_KEY`. The key is stored
in the browser after that.

**Plan limits** ([Browser Run limits](https://developers.cloudflare.com/browser-run/limits/)):
- Workers Free allows 10 browser-minutes per day and 3 concurrent browsers, which is enough to
  try it out.
- Workers Paid includes 10 browser-hours per month, then charges per extra browser hour.

Chromium closes `IDLE_SECONDS` (60 by default) after the last viewer leaves.

Settings are in the `vars` section of `wrangler.jsonc`: `START_URL`, `VIEWPORT_W` / `VIEWPORT_H`,
`JPEG_QUALITY`, `IDLE_SECONDS` and `KEEP_ALIVE_SECONDS`.

Local Workers dev: `npm run dev`. Wrangler uses a Chrome on your machine for the browser binding.

## Run locally with Node (no Cloudflare)

```bash
npm run local:setup   # installs puppeteer + ws (and puppeteer's Chrome for Testing)
npm run local         # → http://127.0.0.1:8080
```

Environment variables:
- `CHROMIUM_PATH=/usr/bin/chromium` uses your own Chromium.
- `HEADLESS=0` shows the browser window.
- `PORT`, `HOST`, `START_URL`, `VIEWPORT_W` / `VIEWPORT_H` and `JPEG_QUALITY` work as above.

## Use

The screen has three parts:
- **Chromium panel** (bottom left, opens first). This is the live website with its tabs, back/forward/reload and URL bar. Tap, swipe, pinch or drag on it to use the page; the mouse works as a finger. The text box types into the page. You can drag the panel by its title bar, resize it (⤢), minimize it (–) or hide it (✕), and bring it back with **▣ Chromium**.
- **3D machine** (background). Drag to orbit and scroll to zoom. You can also click, scroll and type on the 3D input screen. **Alt+click** it to pick a color, and press `Esc` to hand the keyboard back.
- **☰ Controls** (sidebar on the right). It closes with ✕ and remembers whether it was open. Its sections:
  - **Detector:** the color mode.
    - **One color** detects a single target color.
    - **Several** detects any color in a list of up to 8. Swatches, Alt+click and the eyedropper add colors to the list.
    - **All colors** turns every pixel into a cube in its own color. Relief comes from brightness, colorfulness or nothing (flat).
  - **Scan settings:** tolerance (CIE Lab ΔE), cubes across, speed, relief depth, loop or live mode, real-pixel or target-color cubes, and ghosts for unmatched pixels.
  - **Auto-browse:** Chromium follows links from page to page. You set the dwell time and the max number of pages, and can tell it to stay on the same site or scroll while it scans. You can also paste a list of URLs to queue them or open each one in a tab.
  - **Detections:** pages ranked by how much of the color they contain. Click a row to go back to that page, or export as CSV.
  - **View & help:** the Chromium viewport size (including a phone size).

The status chip at the top right shows the connection, the detection lamp and what the machine is doing.
Each browser gets its own Chromium session. Open `?session=name` on several devices to share one.

The Chromium panel loads and connects before three.js has finished downloading. If the CDN can't
be reached, browsing still works without the 3D machine.

## How it works

```
public/index.html   three.js machine + browser UI (static assets)
src/core.js         BrowserHub: tabs, input, auto-browse, frame stream (puppeteer API)
src/worker.js       Cloudflare: Worker → BrowserSession Durable Object → Browser Run
server.js           Local: Node http + ws → BrowserHub → puppeteer
```

1. The client opens a WebSocket to `/api/ws`. JSON text messages carry commands and events,
   and binary messages carry JPEG frames.
2. Touch input goes in through CDP `Input.dispatchTouchEvent`, with touch emulation turned on for the tab.
3. BrowserHub streams the active tab with CDP `Page.startScreencast`. When the screencast is
   silent, it falls back to `Page.captureScreenshot`.
4. The client draws each frame onto the screen texture and downsamples it to the cube grid.
5. It compares every pixel to the target colors in Lab space and updates one `InstancedMesh`
   holding up to 40,000 cubes.

three.js loads from the jsDelivr CDN.
