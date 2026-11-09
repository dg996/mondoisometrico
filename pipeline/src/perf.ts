/**
 * Viewer performance test: load the built site, zoom out → in → out, and measure tile
 * requests, bytes and time-to-idle per step, plus frame times during zoom animation.
 *
 *   (cd web && npx astro build && npx astro preview) &   # prints http://localhost:<port>/
 *   npm -w pipeline exec tsx src/perf.ts http://localhost:<port>/
 */
import { chromium } from "playwright-core";
import { CHROME, CHROME_ARGS, siteUrl } from "./paths.ts";

const url = siteUrl(process.argv[2]);
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: CHROME_ARGS });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
let bytes = 0;
page.on("requestfinished", async (r) => {
  if (r.url().includes("/tiles/")) bytes += (await r.sizes().catch(() => ({ responseBodySize: 0 }))).responseBodySize;
});

await page.addInitScript("window.__name = (f) => f;");
await page.addInitScript(() => {
  const w = window as any;
  w.__long = [];
  new PerformanceObserver((l) => l.getEntries().forEach((e) => w.__long.push(e.duration))).observe({ type: "longtask", buffered: true });
});
await page.goto(url);
await page.waitForFunction(() => (window as any).__viewer?.world.getItemCount() > 0);
await page.evaluate(() => {
  const w = window as any;
  w.__tiles = 0; w.__frames = [];
  w.__viewer.addHandler("tile-loaded", () => w.__tiles++);
  let last = performance.now();
  const tick = (t: number) => { w.__frames.push(t - last); last = t; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
});

async function step(label: string, action: () => Promise<unknown>) {
  await page.evaluate(() => { const w = window as any; w.__tiles = 0; w.__long = []; w.__frames = []; });
  bytes = 0;
  const t0 = Date.now();
  await action();
  await page.waitForTimeout(250);
  await page.waitForFunction(() => {
    const v = (window as any).__viewer;
    return !v.world.needsDraw() && v.world.getItemAt(0).getFullyLoaded();
  }, null, { timeout: 30_000, polling: 50 }).catch(() => {});
  const r = await page.evaluate(() => { const w = window as any; return { tiles: w.__tiles, long: w.__long as number[], frames: w.__frames as number[] }; });
  const longMs = r.long.reduce((a, b) => a + b, 0);
  const f = [...r.frames].sort((a, b) => a - b);
  const p95 = f.length ? f[Math.floor(f.length * 0.95)].toFixed(0) : "-";
  console.log(`${label.padEnd(12)} ${String(Date.now() - t0).padStart(6)} ms to sharp  ${String(r.tiles).padStart(4)} tiles  ${(bytes / 1024).toFixed(0).padStart(6)} KB  long tasks ${longMs.toFixed(0).padStart(4)} ms  frame p95 ${p95} ms`);
}

const zoomBy = (f: number) => page.evaluate((ff) => { const v = (window as any).__viewer; v.viewport.zoomBy(ff); v.viewport.applyConstraints(); }, f);
await step("initial", async () => {});
for (const f of [2, 2, 2, 2, 2, 0.5, 0.25, 0.25, 0.5]) await step(`zoom ×${f}`, () => zoomBy(f));
await step("pan", () => page.evaluate(() => { const v = (window as any).__viewer; v.viewport.panBy(new (window as any).OpenSeadragon.Point(0.05, 0.02)); }));
await browser.close();
