/**
 * Convert painted windows (data/derived/<area>/windows/*.png) to lossless WebP, ~30% smaller.
 * A PNG is removed ONLY after the WebP decodes to exactly the same pixels; .png.soft markers follow.
 * Never run while `paint` is running on the same area.
 *
 *   node --import tsx pipeline/src/migrate-windows.ts [area ...]
 */
import { existsSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { DERIVED } from "./paths.ts";

const areas = process.argv.slice(2).length ? process.argv.slice(2) : readdirSync(DERIVED).filter((a) => existsSync(join(DERIVED, a, "windows")));
let saved = 0, converted = 0, kept = 0;
for (const area of areas) {
  const dir = join(DERIVED, area, "windows");
  if (!existsSync(dir)) continue;
  for (const f of readdirSync(dir).filter((f) => /^-?\d+_-?\d+\.png$/.test(f))) {
    const png = join(dir, f), webp = png.replace(/\.png$/, ".webp"), tmp = `${webp}.tmp`;
    await sharp(png).webp({ lossless: true, effort: 4 }).toFile(tmp);
    const [a, b] = await Promise.all([sharp(png).raw().toBuffer({ resolveWithObject: true }), sharp(tmp).raw().toBuffer({ resolveWithObject: true })]);
    const same = a.info.width === b.info.width && a.info.height === b.info.height && a.info.channels === b.info.channels && a.data.equals(b.data);
    if (!same) { rmSync(tmp); kept++; console.warn(`  ${area}/${f}: WebP not identical, PNG kept`); continue; }
    renameSync(tmp, webp);
    if (existsSync(`${png}.soft`)) renameSync(`${png}.soft`, `${webp}.soft`);
    saved += statSync(png).size - statSync(webp).size;
    rmSync(png);
    converted++;
  }
  console.log(`  ${area}: done`);
}
console.log(`${converted} windows converted, ${kept} kept as PNG, ${(saved / 1e9).toFixed(2)} GB saved`);
