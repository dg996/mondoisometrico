/**
 * Render the open-data scene (terrain + OSM ground + extruded buildings + trees) through the
 * global orthographic camera. Run `fetch`, `ground` and `scene` for the area first.
 *
 *   npm run render -- tlv-core            # all tiles of an area
 *   npm run render -- tlv-core --only 0,5 # a single tile
 *   npm run render -- tlv-core -j 4       # parallel browser pages
 *
 * Output: data/derived/<area>/render/<tx>_<ty>.png  (1024² colour)
 *         data/derived/<area>/height/<tx>_<ty>.png  (256², ellipsoid height cm+10000 in R<<8|G)
 *         data/derived/<area>/manifest.json
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import * as esbuild from "esbuild";
import { chromium, type Page } from "playwright-core";
import sharp from "sharp";
import { areaTiles, openArea } from "./areas.ts";
import { CAMERA, camera, llhToPixel } from "./camera.ts";
import { CHROME, CHROME_ARGS, DERIVED, PIPELINE, writeAtomic } from "./paths.ts";

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    j: { type: "string", default: "3" },
    only: { type: "string" },
    force: { type: "boolean", default: false },
    ss: { type: "string", default: "2" },
    markers: { type: "string", default: "" },
  },
});
const areaName = positionals[0] ?? "rothschild";
const area = openArea(areaName);

export const ATTRIBUTIONS = [
  "© OpenStreetMap contributors (ODbL)",
  "OpenStreetMap contributors",
  "Copernicus DEM GLO-30 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018, provided under COPERNICUS by the European Union and ESA",
];

const T = CAMERA.tile;




async function buildPage() {
  const dist = join(PIPELINE, "page", "dist");
  mkdirSync(dist, { recursive: true });
  await esbuild.build({
    entryPoints: [join(PIPELINE, "page", "renderer.ts")],
    bundle: true, format: "esm", target: "es2022", outfile: join(dist, "renderer.js"), logLevel: "warning",
  });
  writeFileSync(join(dist, "index.html"),
    `<!doctype html><html><body style="margin:0;background:#000"><script type="module" src="/renderer.js"></script></body></html>`);
  return dist;
}

async function openPage(browser: Awaited<ReturnType<typeof chromium.launch>>, dist: string) {
  const ctx = await browser.newContext({ viewport: { width: 800, height: 600 } });
  const page = await ctx.newPage();
  const groundDir = join(DERIVED, areaName, "ground");
  await page.route("http://iso.local/**", (route) => {
    const p = new URL(route.request().url()).pathname;
    const file = p.startsWith("/ground/") ? join(groundDir, p.slice(8)) : join(dist, p === "/" ? "index.html" : p.slice(1));
    const type = file.endsWith(".js") ? "text/javascript" : file.endsWith(".json") ? "application/json" : file.endsWith(".bin") ? "application/octet-stream" : "text/html";
    if (!existsSync(file)) return route.fulfill({ status: 404 });
    return route.fulfill({ body: readFileSync(file), contentType: type });
  });
  page.on("pageerror", (e) => console.error("  [page]", e.message));
  // "commit": module-level ground fetches can take a while; window.ready below is the real gate.
  await page.goto(`http://iso.local/?region=${area.region}&ss=${args.ss}&markers=${encodeURIComponent(args.markers!)}`, { timeout: 180_000, waitUntil: "commit" });
  // Parallel SwiftShader pages contend for the CPU during scene init; 30s is not enough
  // when several workers boot at once.
  await page.waitForFunction(() => window.ready === true, null, { timeout: 180_000 });
  return page;
}

async function renderOne(page: Page, tx: number, ty: number, outDir: string) {
  const t0 = Date.now();
  const binFile = join(outDir, "scene", `${tx}_${ty}.json`);
  const objects = existsSync(binFile) ? JSON.parse(readFileSync(binFile, "utf8")) : undefined;
  const r = await page.evaluate(([x, y, o]) => window.renderTile(x, y, o), [tx, ty, objects] as const);
  const color = Buffer.from(r.color.split(",")[1], "base64");
  // Over-subscribed SwiftShader pages can silently render black without raising; a real tile
  // always contains terrain, so fail the tile instead of writing a corrupt "successful" PNG.
  const out = await sharp(color).resize(T, T, { kernel: "lanczos3" }).png({ compressionLevel: 6 }).toBuffer();
  const stats = await sharp(out).stats();
  if (stats.channels.every((c) => c.max === 0)) throw new Error("blank render (GPU context lost?)");
  await writeAtomic(sharp(out), join(outDir, "render", `${tx}_${ty}.png`));
  // GL rows are bottom-up; flip so row 0 is the top of the tile.
  await writeAtomic(sharp(Buffer.from(r.height, "base64"), { raw: { width: 256, height: 256, channels: 4 } }).flip().png(), join(outDir, "height", `${tx}_${ty}.png`));
  console.log(`  ${tx}_${ty}: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

async function main() {
  const outDir = join(DERIVED, areaName);
  for (const d of ["render", "height"]) mkdirSync(join(outDir, d), { recursive: true });
  let tiles = areaTiles(area.bbox);
  const all = tiles;
  if (args.only) tiles = [args.only.split(",").map(Number) as [number, number]];
  const todo = tiles.filter(([x, y]) => args.force || !existsSync(join(outDir, "render", `${x}_${y}.png`)));
  console.log(`${areaName}: ${all.length} tiles, ${todo.length} to render`);

  const manifestPath = join(outDir, "manifest.json");
  if (!existsSync(join(outDir, "ground", "meta.json"))) throw new Error(`run: npm run ground -- ${areaName}`);

  if (todo.length) {
    const dist = await buildPage();
    const jobs = Math.min(Number(args.j), todo.length);
    const failed: string[] = [];
    // contiguous row-major chunks keep each page's tile cache warm
    const chunk = Math.ceil(todo.length / jobs);
    // SwiftShader's GPU process silently degrades after a few dozen heavy tiles (renders turn
    // black without raising), so recycle the whole browser every SUB tiles per worker.
    const SUB = 40;
    const launch = () =>
      chromium.launch({
        // MONDO_HEADFUL=1 + DISPLAY (e.g. Xvfb) for hosts where headless ANGLE/SwiftShader
        // cannot create a WebGL context (xcb_connect fails without an X server).
        executablePath: CHROME, headless: process.env.MONDO_HEADFUL !== "1",
        args: [...CHROME_ARGS, "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader"],
      });
    await Promise.all(Array.from({ length: jobs }, async (_, w) => {
      const mine = todo.slice(w * chunk, (w + 1) * chunk);
      for (let s = 0; s < mine.length; s += SUB) {
        const batch = mine.slice(s, s + SUB);
        const browser = await launch();
        try {
          const page = await openPage(browser, dist);
          for (let b = 0; b < batch.length; b++) {
            const [x, y] = batch[b];
            try {
              await renderOne(page, x, y, outDir);
            } catch (e) {
              failed.push(`${x}_${y}`);
              console.error(`  ${x}_${y}: FAILED ${(e as Error).message}`);
              if (/blank render/.test((e as Error).message)) {
                // wedged context: the rest of this batch needs a fresh browser (next pass)
                for (let r = b + 1; r < batch.length; r++) failed.push(`${batch[r][0]}_${batch[r][1]}`);
                break;
              }
            }
          }
        } finally {
          await browser.close().catch(() => {});
        }
      }
    }));
    if (failed.length) throw new Error(`render incomplete (${failed.length} tiles): ${failed.join(", ")}; do not export/publish`);
  }

  writeFileSync(manifestPath, JSON.stringify({
    area: areaName, title: area.title, bbox: area.bbox, camera: camera(),
    tiles: all.map(([x, y]) => ({ x, y })), attributions: ATTRIBUTIONS,
  }, null, 2));
}

main();
