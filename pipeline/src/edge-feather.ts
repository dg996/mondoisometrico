import sharp from "sharp";

/**
 * Soft edge between the painted city and the blurred, unpainted context around it.
 *
 * Before this, a painted 1024 px tile ended in a straight line against the context tile next to it
 * (and against near-black render tiles from failed SwiftShader runs): the "netta nera" edge.
 * Painted tiles within FEATHER art px of an unpainted tile are now blended into the context
 * version of the same pixels, so the city dissolves into the blur instead of stopping.
 */
export const FEATHER = 640;            // art px (≈160 m at 0.25 m/px)
export const FEATHER_VERSION = `feather${FEATHER}-dark1`;

const parse = (k: string) => k.split("_").map(Number) as [number, number];

/** Distance (art px) from a point to the nearest pixel of a tile that is NOT painted; 0 inside one.
 *  Capped at `max` (anything farther is "fully inside"). */
export function paintedDistance(painted: Set<string>, x: number, y: number, tile: number, max = FEATHER): number {
  const tx = Math.floor(x / tile), ty = Math.floor(y / tile);
  if (!painted.has(`${tx}_${ty}`)) return 0;
  const r = Math.ceil(max / tile);
  let d = max;
  for (let j = ty - r; j <= ty + r; j++) for (let i = tx - r; i <= tx + r; i++) {
    if (painted.has(`${i}_${j}`)) continue;
    // distance from (x, y) to the rectangle of tile (i, j)
    const dx = Math.max(i * tile - x, 0, x - (i + 1) * tile);
    const dy = Math.max(j * tile - y, 0, y - (j + 1) * tile);
    d = Math.min(d, Math.hypot(dx, dy));
  }
  return d;
}

/** Alpha (0 = context, 255 = painted) for a web tile at global art px (x0, y0); null = fully painted. */
export function featherAlpha(painted: Set<string>, x0: number, y0: number, size: number, tile: number, feather = FEATHER): Buffer | null {
  const corners = [[x0, y0], [x0 + size, y0], [x0, y0 + size], [x0 + size, y0 + size]];
  // A web tile lies inside one render tile and unpainted tiles are axis-aligned boxes outside it, so
  // the distance is smallest at a corner: four far corners mean the whole tile is fully painted.
  if (Math.min(...corners.map(([x, y]) => paintedDistance(painted, x, y, tile, feather))) >= feather) return null;
  const step = 8, n = size / step + 1, grid = new Float32Array(n * n);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) grid[j * n + i] = paintedDistance(painted, x0 + i * step, y0 + j * step, tile, feather);
  const a = Buffer.alloc(size * size);
  let all = true;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const gx = x / step, gy = y / step, i = Math.min(n - 2, Math.floor(gx)), j = Math.min(n - 2, Math.floor(gy)), fx = gx - i, fy = gy - j;
    const d = (grid[j * n + i] * (1 - fx) + grid[j * n + i + 1] * fx) * (1 - fy) + (grid[(j + 1) * n + i] * (1 - fx) + grid[(j + 1) * n + i + 1] * fx) * fy;
    const t = Math.min(1, Math.max(0, d / feather));
    const v = Math.round(t * t * (3 - 2 * t) * 255);
    a[y * size + x] = v;
    if (v < 255) all = false;
  }
  return all ? null : a;
}

/** Signature of the painted state around a render tile (feathering depends on its neighbours). */
export function neighbourhoodStamp(painted: Set<string>, tx: number, ty: number, tile: number, feather = FEATHER) {
  const r = Math.ceil(feather / tile);
  let s = "";
  for (let j = ty - r; j <= ty + r; j++) for (let i = tx - r; i <= tx + r; i++) s += painted.has(`${i}_${j}`) ? "1" : "0";
  return s;
}

/** Render tiles that came out (almost) black: a failed GPU/SwiftShader frame, not the city.
 *  They must not be blurred into the context (that produced the dark band around the map). */
export async function isDarkTile(file: string, threshold = 22): Promise<boolean> {
  const { channels } = await sharp(file).removeAlpha().resize(64, 64).stats();
  const lum = 0.2126 * channels[0].mean + 0.7152 * channels[1].mean + 0.0722 * channels[2].mean;
  return lum < threshold;
}

/** Blend painted RGB over context RGB in place with an alpha mask. */
export function blendInto(painted: Buffer, context: Buffer, alpha: Buffer) {
  for (let p = 0; p < alpha.length; p++) {
    const a = alpha[p] / 255;
    for (let c = 0; c < 3; c++) painted[p * 3 + c] = Math.round(context[p * 3 + c] + (painted[p * 3 + c] - context[p * 3 + c]) * a);
  }
  return painted;
}

export { parse as parseTileKey };
