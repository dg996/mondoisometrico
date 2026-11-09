/**
 * Visual QA tour: screenshots the live viewer at well-known places, at street and district zoom.
 *
 *   npx tsx src/tour.ts [url] [outDir] [place …]
 *
 * Output: <outDir>/<place>_<zoom>.png (scale = screen px per art px: 1 = native, 0.35 = district)
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { llhToPixel } from "./camera.ts";
import { CHROME, CHROME_ARGS, siteUrl } from "./paths.ts";

export const PLACES: Record<string, [number, number]> = {
  rothschild: [32.0636, 34.7745],
  dizengoff: [32.0778, 34.7740],
  beach: [32.0790, 34.7665],
  jaffa: [32.0540, 34.7520],
  port: [32.0985, 34.7735],
  yarkon: [32.0980, 34.8050],
  azrieli: [32.0745, 34.7920],
  arlozorov: [32.0838, 34.7978],
  ramatgan: [32.0835, 34.8035],
  florentin: [32.0560, 34.7700],
};

const [urlArg, outDir = "tour", ...only] = process.argv.slice(2), url = siteUrl(urlArg);
mkdirSync(outDir, { recursive: true });
const b = await chromium.launch({ executablePath: CHROME, headless: true, args: CHROME_ARGS });
const page = await b.newPage({ viewport: { width: 1400, height: 900 } });
await page.addInitScript("window.__name = (f) => f;");
const problems: string[] = [];
page.on("pageerror", (e) => problems.push(e.message));
page.on("console", (m) => { if (m.type() === "error") problems.push(m.text()); });
await page.goto(url);
await page.waitForFunction(() => (window as any).__viewer?.world.getItemCount() > 0);

for (const [name, [lat, lon]] of Object.entries(PLACES)) {
  if (only.length && !only.includes(name)) continue;
  const [x, y] = llhToPixel(lat, lon, 25);
  for (const scale of [1, 0.35]) {
    await page.evaluate(([gx, gy, s]) => {
      const v = (window as any).__viewer, world = (window as any).__world;
      const w = v.world.getItemAt(0).getContentSize().x;
      v.viewport.zoomTo((w / v.container.clientWidth) * s, undefined, true);
      v.viewport.panTo(v.world.getItemAt(0).imageToViewportCoordinates(gx - world.origin[0], gy - world.origin[1]), true);
    }, [x, y, scale]);
    await page.waitForTimeout(400);
    await page.waitForFunction(() => (window as any).__viewer.world.getItemAt(0).getFullyLoaded(), null, { timeout: 30_000 }).catch(() => problems.push(`${name}: tiles not loaded`));
    await page.waitForTimeout(1500); // let traffic move
    await page.screenshot({ path: join(outDir, `${name}_${scale === 1 ? "street" : "district"}.png`) });
  }
}
console.log(problems.length ? `PROBLEMS:\n  ${[...new Set(problems)].join("\n  ")}` : `ok -> ${outDir}`);
await b.close();
