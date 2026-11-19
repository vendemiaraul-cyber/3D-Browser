# 3D-Browser
It turns pages from chromium into 3D!


**Chroma Voxelizer** — a 3D machine in three.js. A real Chromium browses the web, the machine sweeps a
laser over each live page looking for a target color, and every matching pixel
gets printed onto a wall of small cubes.

## Run

```bash
npm run setup      # installs Playwright + its Chromium (once)
npm start          # → http://127.0.0.1:8080, open it in Chromium
```

Options (environment variables):

| var | default | |
|---|---|---|
| `PORT` / `HOST` | `8080` / `127.0.0.1` | keep it on localhost: anyone who can reach it can drive the browser |
| `HEADLESS` | `1` | `0` also shows the real Chromium window (`npm run headed`) |
| `START_URL` | Wikipedia "Color" | first page |
| `VIEWPORT_W/H` | `1280×720` | page size (also switchable in the UI) |
| `CHROMIUM_PATH` | Playwright's | use your own Chromium/Chrome binary |
| `JPEG_QUALITY` | `75` | frame quality of the stream |

## Use

- **Browse.** Use the tab strip, back/forward/reload and the URL bar (a URL, or words to search). Click, scroll and type directly on the 3D input screen. `Esc` hands the keyboard back.
- **Pick a color.** Use the swatches or color input, **Alt+click** the input screen, or use **Eyedropper** to grab any color on your monitor.
- **Detector.** Tolerance is the CIE Lab ΔE distance. You can also set the resolution (cubes across), scan speed, relief (better matches stick out further), loop or live mode, real-pixel or target-color cubes, and ghosts for unmatched pixels.
- **Auto-browse.** Chromium follows links from page to page. You set the dwell time and the max number of pages, and can tell it to stay on the same site or scroll while it scans. You can also paste a list of URLs to queue them, or open each one in its own tab.
- **Detections.** Every page the machine scans is ranked by how much of the color it found. Click a row to go back to that page, or export the list as CSV.

## How it works

`server.js` uses Playwright to drive Chromium. It streams the active tab with
CDP `Page.startScreencast` as JPEG frames over Server-Sent Events, and takes
input over `POST /api/cmd`. `public/index.html` draws each frame onto the
screen texture, downsamples it to the cube grid, compares each pixel to the
target in Lab space, and updates one `InstancedMesh` with up to 40,000 cubes.
three.js loads from the jsDelivr CDN.
