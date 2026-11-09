/** Sea level and the renderer's height pass (one 256² PNG per render tile). */
import sharp from "sharp";

/** Ellipsoid height of mean sea level off Tel Aviv (geoid undulation, EGM2008 ≈ 19 m). */
export const SEA_H = 19.1;

/** Decode a height PNG (ellipsoid height in cm + 10000, R<<8|G; alpha 0 = nothing rendered). */
export async function readHeights(file: string) {
  const buf = await sharp(file).ensureAlpha().raw().toBuffer();
  const n = buf.length / 4, h = new Float32Array(n);
  for (let i = 0; i < n; i++) h[i] = buf[i * 4 + 3] ? (buf[i * 4] * 256 + buf[i * 4 + 1]) / 100 - 100 : NaN;
  return h;
}
