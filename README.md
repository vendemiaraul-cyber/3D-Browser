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

- **Browse.** Use the tab strip, back/forward/reload and the URL bar (a URL, or words to search). Click, scroll and type directly on the 3D input screen. `Esc` hands the keyboard back.
- **Color modes.**
  - **One color** detects a single target color.
  - **Several** detects any color in a list of up to 8. Swatches, Alt+click and the eyedropper add colors to the list.
  - **All colors** turns every pixel into a cube in its own color, so the whole page becomes a live 3D cube picture. Relief comes from brightness, colorfulness or nothing (flat).
- **Pick a color.** Use the swatches or color input, **Alt+click** the input screen, or use **Eyedropper** to grab any color on your monitor.
- **✋ Touch screen.** A floating 2D copy of the live page that you can drag, resize and minimize. Fingers become real touch events in Chromium, so pages scroll with momentum, swipe, tap and pinch-zoom natively. A mouse drag works as a finger too. A text box types into the page, which also works with phone keyboards. While the window is open the cubes update live, so the 3D wall follows the page as it moves. The window opens automatically on touch devices.
- **Detector.** Tolerance is the CIE Lab ΔE distance. You can also set the resolution (cubes across), scan speed, relief (better matches stick out further), loop or live mode, real-pixel or target-color cubes, and ghosts for unmatched pixels.
- **Auto-browse.** Chromium follows links from page to page. You set the dwell time and the max number of pages, and can tell it to stay on the same site or scroll while it scans. You can also paste a list of URLs to queue them, or open each one in its own tab.
- **Detections.** Every page the machine scans is ranked by how much of the color it found. Click a row to go back to that page, or export the list as CSV.
- **Sessions.** Each browser gets its own Chromium session. Open `?session=name` on several devices to share one session.

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
