/**
 * Interactive smoke test of the viewer: wheel zoom in/out, drag pan, key toggles.
 * Fails on page errors / 404s; saves screenshots to /tmp/ui_*.png.
 *
 *   npx tsx src/uitest.ts [url]
 */
import { chromium } from "playwright-core";
import { CHROME, siteUrl } from "./paths.ts";

const url = siteUrl(process.argv[2]);
const b = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await b.newPage({ viewport: { width: 1400, height: 900 } });
await page.addInitScript("window.__name = (f) => f;");
const problems: string[] = [];
page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
page.on("response", (r) => { if (r.status() >= 400) problems.push(`${r.status()} ${r.url()}`); });
page.on("console", (m) => { if (m.type() === "error") problems.push(`console: ${m.text()}`); });

const settle = async () => {
  await page.waitForTimeout(300);
  await page.waitForFunction(() => (window as any).__viewer.world.getItemAt(0)?.getFullyLoaded(), null, { timeout: 20_000 }).catch(() => problems.push("tiles not fully loaded in 20 s"));
  await page.waitForTimeout(300);
};
const zoom = () => page.evaluate(() => (window as any).__viewer.viewport.getZoom(true).toFixed(2));

await page.goto(url);
await page.waitForFunction(() => (window as any).__viewer?.world.getItemCount() > 0, null, { timeout: 30_000 });
await settle();
await page.screenshot({ path: "/tmp/ui_0_initial.png" });
console.log("initial zoom", await zoom());

// wheel in toward the city centre (Rothschild area is around 45% x, 50% y of the overview)
await page.mouse.move(640, 430);
for (let i = 1; i <= 4; i++) {
  for (let k = 0; k < 3; k++) { await page.mouse.wheel(0, -300); await page.waitForTimeout(80); }
  await settle();
  await page.screenshot({ path: `/tmp/ui_${i}_in.png` });
  console.log(`wheel in ${i}: zoom ${await zoom()}`);
}
// drag pan
await page.mouse.move(700, 450); await page.mouse.down(); await page.mouse.move(400, 300, { steps: 12 }); await page.mouse.up();
await settle();
await page.screenshot({ path: "/tmp/ui_5_pan.png" });
// toggles
await page.keyboard.press("p"); await settle(); await page.screenshot({ path: "/tmp/ui_6_photo.png" }); await page.keyboard.press("p");
await page.keyboard.press("b"); await page.waitForTimeout(300); await page.screenshot({ path: "/tmp/ui_7_borders.png" }); await page.keyboard.press("b");
const drawn = await page.evaluate(() => (window as any).__traffic?.drawn);
console.log("vehicles drawn at this zoom:", drawn);
// wheel all the way out
for (let k = 0; k < 20; k++) { await page.mouse.wheel(0, 400); await page.waitForTimeout(60); }
await settle();
await page.screenshot({ path: "/tmp/ui_8_out.png" });
console.log("zoomed out:", await zoom());
console.log(problems.length ? `PROBLEMS:\n  ${[...new Set(problems)].join("\n  ")}` : "no errors");
await b.close();
