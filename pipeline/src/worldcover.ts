/**
 * ESA WorldCover 10 m 2021 v200 (CC BY 4.0, AWS Open Data): land-cover classes, used for where Rome's
 * tree canopy really is. The 3°×3° tile N39E012 is a palette GeoTIFF; it is decoded to class codes
 * (10 tree, 20 shrub, 30 grass, 40 crop, 50 built, 60 bare, 80 water, 90 wetland) and cropped to Rome.
 * Attribution: "© ESA WorldCover project 2021 / Contains modified Copernicus Sentinel data (2021)
 * processed by ESA WorldCover consortium".
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";

const URL = "https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/ESA_WorldCover_10m_2021_v200_N39E012_Map.tif";
const PALETTE: Record<string, number> = { "0,100,0": 10, "255,187,34": 20, "255,255,76": 30, "240,150,255": 40, "250,0,0": 50,
  "180,180,180": 60, "240,240,240": 70, "0,100,200": 80, "0,150,160": 90, "0,207,117": 95, "250,230,160": 100, "0,0,0": 0 };
/** Crop: lat 41.75–42.00, lon 12.30–12.70 (the whole Raccordo with margin). Tile origin: 42°N 12°E. */
const CROP = { lat0: 42.0, lon0: 12.3, pxPerDeg: 12000, width: 4800, height: 3000 };

export async function fetchWorldCover(raw: string) {
  const dir = join(raw, "worldcover"), png = join(dir, "roma.png"), tif = join(dir, "ESA_WorldCover_10m_2021_v200_N39E012_Map.tif");
  if (existsSync(png)) return png;
  mkdirSync(dir, { recursive: true });
  if (!existsSync(tif)) {
    const r = await fetch(URL);
    if (!r.ok) throw new Error(`WorldCover ${r.status}`);
    writeFileSync(tif, Buffer.from(await r.arrayBuffer()));
  }
  const left = Math.round((CROP.lon0 - 12) * CROP.pxPerDeg), top = Math.round((42 - CROP.lat0) * CROP.pxPerDeg);
  const { data } = await sharp(tif, { limitInputPixels: false }).extract({ left, top, width: CROP.width, height: CROP.height }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const out = Buffer.alloc(CROP.width * CROP.height);
  for (let i = 0; i < out.length; i++) {
    const c = PALETTE[`${data[i * 3]},${data[i * 3 + 1]},${data[i * 3 + 2]}`];
    if (c === undefined) throw new Error(`WorldCover: unknown palette colour at pixel ${i}`);
    out[i] = c;
  }
  await sharp(out, { raw: { width: CROP.width, height: CROP.height, channels: 1 } }).png().toFile(png);
  writeFileSync(join(dir, "roma.json"), JSON.stringify(CROP));
  console.log(`  worldcover: ${png}`);
  return png;
}
