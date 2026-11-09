/** Screenshot the viewer at a global art-pixel location and scale (art px → screen px).
 *   npx tsx src/shot.ts <x> <y> <scale> <out.png> [url] */
import { chromium } from "playwright-core";
import { CHROME, CHROME_ARGS, siteUrl } from "./paths.ts";
const [x, y, scale, out, urlArg] = process.argv.slice(2), url = siteUrl(urlArg);
const b = await chromium.launch({ executablePath: CHROME, headless: true, args: CHROME_ARGS });
const page = await b.newPage({ viewport: { width: 1600, height: 1000 } });
await page.addInitScript("window.__name = (f) => f;");
await page.goto(url);
await page.waitForFunction(() => (window as any).__viewer?.world.getItemCount() > 0);
await page.evaluate(([gx, gy, s]) => {
  const v = (window as any).__viewer, OSD = (window as any).OpenSeadragon;
  const w = v.world.getItemAt(0).getContentSize().x;
  const origin = v.viewport.viewportToImageCoordinates(new OSD.Point(0, 0));
  void origin;
  const world = (window as any).__world;
  v.viewport.zoomTo((w / v.container.clientWidth) * Number(s), undefined, true);
  v.viewport.panTo(v.viewport.imageToViewportCoordinates(Number(gx) - world.origin[0], Number(gy) - world.origin[1]), true);
}, [x, y, scale]);
await page.waitForTimeout(500);
await page.waitForFunction(() => { const v = (window as any).__viewer; return v.world.getItemAt(0).getFullyLoaded(); }, null, { timeout: 30_000 }).catch(() => {});
await page.waitForTimeout(2500);
await page.screenshot({ path: out });
await b.close();
