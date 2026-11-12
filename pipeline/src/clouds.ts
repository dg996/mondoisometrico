/**
 * Clouds round the map: the city does not stop at a line, it disappears into a bank of soft clouds.
 *
 * Everything is a function of GLOBAL art pixels, so clouds continue seamlessly across web tiles and the
 * zoomed-out pyramid (built from the native tiles) shows the same clouds.
 */

const hash2 = (x: number, y: number) => {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

/** Smooth value noise in [0, 1]. */
function noise(x: number, y: number) {
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy), b = hash2(ix + 1, iy), c = hash2(ix, iy + 1), d = hash2(ix + 1, iy + 1);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}

/** Fractal (billowy) noise in [0, 1]: big puffs with smaller puffs on their edges. */
export function fbm(x: number, y: number, octaves = 5) {
  let s = 0, amp = 0.5, norm = 0, f = 1;
  for (let o = 0; o < octaves; o++) { s += amp * noise(x * f + o * 17.3, y * f - o * 9.1); norm += amp; amp *= 0.5; f *= 2.03; }
  return s / norm;
}

const smooth = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/** Puff scale (art px ≈ 0.25 m): a cloud bank ~250 m across with ~30 m wisps. */
export const CLOUD_SCALE = 1000;
const LIGHT = [251, 250, 247], SHADOW = [214, 219, 228];

/** Signed offset (art px) that makes a straight edge billowy: the painted city dissolves along puffs. */
export const billow = (x: number, y: number, amplitude: number) => (fbm(x / (CLOUD_SCALE * 0.6), y / (CLOUD_SCALE * 0.6), 4) - 0.5) * 2 * amplitude;

/**
 * Cloud the map edge of one RGB web tile in place.
 * `t(x, y)` is 0 at the outer limit and 1 where the map is fully clear (from the outline distance);
 * `bg` is the page background the outermost clouds thin into.
 */
export function cloudEdge(rgb: Buffer, x0: number, y0: number, size: number, t: (px: number, py: number) => number, bg: readonly number[]) {
  const step = 8, n = size / step + 1, grid = new Float32Array(n * n);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) grid[j * n + i] = t(x0 + i * step, y0 + j * step);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const gx = x / step, gy = y / step, i = Math.min(n - 2, Math.floor(gx)), j = Math.min(n - 2, Math.floor(gy)), fx = gx - i, fy = gy - j;
    const tt = (grid[j * n + i] * (1 - fx) + grid[j * n + i + 1] * fx) * (1 - fy) + (grid[(j + 1) * n + i] * (1 - fx) + grid[(j + 1) * n + i + 1] * fx) * fy;
    if (tt >= 1) continue;
    const X = x0 + x, Y = y0 + y;
    // density grows toward the edge; the noise turns the iso-line into puffs and gaps
    const dens = smooth(0.42, 0.62, (1 - tt) * 1.15 + (fbm(X / CLOUD_SCALE, Y / CLOUD_SCALE) - 0.5) * 1.1);
    if (dens <= 0 && tt > 0.45) continue;
    // lit tops, cool shaded undersides
    const lit = smooth(0.38, 0.66, fbm(X / (CLOUD_SCALE * 0.35) + 31.7, Y / (CLOUD_SCALE * 0.35) - 12.9, 4));
    // the last stretch thins into the page background along puffs too, never along the outline
    const outer = smooth(0, 0.3, tt + (fbm(X / (CLOUD_SCALE * 0.8) - 5.1, Y / (CLOUD_SCALE * 0.8) + 3.7, 4) - 0.5) * 0.4);
    const p = (y * size + x) * 3;
    for (let c = 0; c < 3; c++) {
      const cloud = SHADOW[c] + (LIGHT[c] - SHADOW[c]) * lit;
      const v = rgb[p + c] + (cloud - rgb[p + c]) * dens;
      rgb[p + c] = Math.round(bg[c] + (v - bg[c]) * outer);
    }
  }
  return rgb;
}
