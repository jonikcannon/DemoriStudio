---
name: run-demoriphotos
description: Build, launch, and drive the Demori Studio photography site (Angular 18 + Express API). Use when asked to run, start, serve, smoke-test, screenshot, or debug load errors in this app, or to verify gallery media, captions, and alt text render correctly.
---

# Run Demori Studio

Angular 18 SPA (`ng serve`, port 4200) plus an Express API (`server/server.js`,
port 3000). Gallery media is served from a Cloudflare R2 bucket; the app
discovers it through `storage/media/gallery-manifest.json`, which is regenerated
on every start.

Drive it with **`.claude/skills/run-demoriphotos/driver.mjs`** — a Chrome
DevTools Protocol client. It launches headless Chrome itself, clicks into the
catalog, opens the media viewer, and reports console errors plus failed
requests. Neither playwright nor puppeteer is installed, and `chromium-cli` is
absent; the driver needs no dependency beyond Node 22's built-in `WebSocket`.

All paths below are relative to the repo root.

## Prerequisites

- **Node 22** (verified on v22.14.0) — `node --version`
- **Chrome or Edge.** The driver auto-detects; on this machine Chrome is at
  `C:/Program Files/Google/Chrome/Application/chrome.exe`.
- **`.env` with R2 credentials.** Without `R2_*`, the manifest step falls back
  to listing local disk. `MEDIA_CDN_URL` decides whether media URLs point at
  the bucket or stay relative.

Verified on Windows 11 with Git Bash. Not tried on Linux/macOS.

## Setup

```bash
npm install
```

Native builds (`sharp`, `esbuild`, `lmdb`) are gated behind npm's script
approval; they were already built here. If a script-approval warning turns into
a runtime failure, run `npm approve-scripts <pkg>`.

## Run (agent path)

**1. Free the ports first.** See Gotchas — orphaned dev servers are the single
most common failure.

```bash
for p in 3000 4200; do
  pid=$(netstat -ano | grep LISTENING | grep -E ":$p\s" | awk '{print $NF}' | head -1)
  [ -n "$pid" ] && taskkill //PID "$pid" //F
done
```

**2. Start both servers in the background.**

```bash
npm start > /tmp/app.log 2>&1 &
```

**3. Wait on the ports, not on a timer.** First compile takes 1–2 minutes and
`prestart` regenerates the manifest from R2 before that.

```bash
until curl -s --max-time 3 -o /dev/null http://localhost:4200/ \
   && curl -s --max-time 3 -o /dev/null http://127.0.0.1:3000/assets/gallery/gallery-manifest.json
do sleep 3; done; echo "both servers ready"
```

**4. Drive it.**

```bash
node .claude/skills/run-demoriphotos/driver.mjs urls      # HEAD every manifest URL
node .claude/skills/run-demoriphotos/driver.mjs smoke     # load catalog, screenshot
node .claude/skills/run-demoriphotos/driver.mjs viewer    # open media viewer, screenshot
```

Screenshots land in `.claude/skills/run-demoriphotos/shots/`. **Look at them** —
a dark page with no cards means the manifest never loaded.

Each command prints JSON and **exits 1 if it found problems**, so it works in a
conditional. Expected baseline output for `urls`:

```json
{ "checked": 154, "described": 154, "failures": 0, "bad": [] }
```

`smoke` reports `cards`, `imgCount`, `brokenImgs`, `missingAlt`, and
`horizontalOverflow`. `viewer` is the one that proves the caption pipeline
(`descriptions.json` → manifest → `openProductMedia` → viewer) end to end:

```json
{ "viewer": { "open": true, "title": "...", "description": "...", "alt": "...", "imgBroken": false } }
```

`viewer` returning `"description": null` means a description stopped reaching
`selectedMedia` — check `openProductMedia` in `src/app/app.component.ts`.

**5. Stop cleanly** — repeat step 1. Killing the `npm start` job is not enough.

## Run (human path)

`npm start` then open <http://localhost:4200>. Useless headless; use the driver.

## Build

```bash
npx ng build
```

Use `npx ng build`, not `npm run build`: the `prebuild` hook runs `npm run media`,
which re-lists the R2 bucket and rewrites the manifest. Fine, but slow and it
needs network. Output goes to `dist/demori-photos`.

Regenerate the manifest on its own:

```bash
npm run manifest              # from the bucket when MEDIA_CDN_URL is set
npm run manifest -- --local   # force the local-disk listing
```

## Gotchas

- **Stopping the `npm start` job leaves orphans.** Killing the npm wrapper does
  not kill the child `node`/`ng` processes. They keep holding 3000 and 4200, and
  the next `npm start` dies with `EADDRINUSE 127.0.0.1:3000` — then
  `concurrently -k` kills `ng serve` too, so *both* servers vanish and the log
  blames the wrong thing. Always kill by port.
- **A stale server will happily answer your probes**, so the readiness loop
  passes and you think you're testing new code. If behaviour doesn't match your
  edits, kill by port and restart.
- **`ng serve` first compile is 1–2 minutes.** Probing too early returns
  `000` and looks like a crash. `npm start` also runs `prestart` → `npm run media`,
  which hits R2 first.
- **`npx playwright --version` hangs for minutes** trying to fetch. Don't reach
  for it. `chromium-cli` is not installed either. The driver's hand-rolled CDP
  client exists for exactly this reason.
- **The gallery is not the landing section, and there is no router.**
  `activeSection` is plain component state, so `/catalog` doesn't exist and you
  cannot deep-link. The driver clicks the `Catalog` nav link by text content.
  A `--dump-dom` of `/` shows zero `<img>` — that's the hero, not a failure.
- **`<app-gallery>` and `<app-work>` are dead code** — imported into
  `AppComponent`'s `imports:` array but rendered in no template. The catalog is
  `<app-products>`. Editing `gallery.component.html` changes nothing on screen.
- **`API_BASE_URL` in `.env` points at `api.demori.studio`, which is NXDOMAIN.**
  Every load logs `Product API request failed; falling back to gallery-derived
  products only.` The catalog still fills from the manifest, which is why this
  goes unnoticed. `media-url.ts` defaults `apiBaseUrl` to `/api`, which
  `proxy.conf.json` routes to :3000 in dev and nginx routes in prod — so
  commenting out `API_BASE_URL` is the fix. Until then, treat that one console
  error and that one failed request as expected baseline noise.
- **`favicon.ico` 404s.** Cosmetic, pre-existing.
- **`npm install` while the dev servers are running kills them** — it rewrites
  `node_modules` under `ng serve`. Install first, then start.
- **A Node script outside the repo can't resolve the repo's `node_modules`.**
  Run helper scripts from the repo root, or `require()` by absolute path.
- **`<video autoplay loop>` emits `net::ERR_ABORTED` range requests** when the
  page is torn down. Not failures — the driver filters them out. Don't
  re-introduce them as findings.
- **Renaming gallery media breaks hardcoded paths.** A handful of gallery URLs
  are hardcoded in `app.component.ts` (hero video, service tiles, poster) and
  `about.component.ts`. They are not manifest-driven and fail silently — the
  page renders, the media 404s. `scripts/apply-media-names.js` now greps `src/`
  and reports these; heed it.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `Error: listen EADDRINUSE 127.0.0.1:3000` then both servers exit | Orphaned server from a previous run. Kill by port (step 1). |
| Readiness loop never finishes | Check `/tmp/app.log`. `[api]`/`[web]` prefixed lines do appear — if the log stops at the `concurrently` line, compilation is still running. |
| `DRIVER FAILED: no Chrome/Edge found` | Add your browser path to `CHROME_CANDIDATES` in `driver.mjs`. |
| `DRIVER FAILED: Chrome did not open its debug port within 30s` | A stale Chrome holds the profile dir. `taskkill //IM chrome.exe //F`, or delete `.claude/skills/run-demoriphotos/.chrome-profile`. |
| `DRIVER FAILED: could not find the Catalog nav link` | The page didn't finish bootstrapping, or the nav label changed. Screenshot to confirm. |
| `manifest fetch failed: HTTP 404` from `urls` | Express (:3000) is down — `ng serve` proxies `/assets/gallery` to it. |
| `urls` reports failures | A manifest entry points at a missing object. Re-run `npm run manifest`; if it persists, the bucket and manifest disagree. |
| Catalog renders but every card is dark/empty | The R2 bucket is unreachable. Check `MEDIA_CDN_URL` and that the URLs in the manifest are absolute. |
