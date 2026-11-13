/**
 * OSM marked crossings (footway=crossing, the zebras drawn on the ground: page/ground.ts paints
 * 3 m bars along the crossing way) located along each drivable way, so the viewer's traffic stops
 * before them instead of on them.
 */
type P = [number, number] | number[];
type Seg = [number, number, number, number];

const CELL = 20;
/** Bars are 3 m long, centred on the crossing way: the band reaches 1.5 m either side of it. */
const HALF_BAND = 1.5;

/** OSM crossing ways often stop at the kerb or at a median short of the carriageway's centre line:
 *  both ends are extended this far so the way they cross still finds them. */
const REACH = 4;

export function crossingIndex(lines: P[][]) {
  const grid = new Map<string, Seg[]>();
  for (const l of lines) for (let i = 1; i < l.length; i++) {
    let [ax, ay] = l[i - 1], [bx, by] = l[i];
    const L = Math.hypot(bx - ax, by - ay);
    if (L < 1e-6) continue;
    const ux = (bx - ax) / L, uy = (by - ay) / L;
    if (i === 1) { ax -= ux * REACH; ay -= uy * REACH; }
    if (i === l.length - 1) { bx += ux * REACH; by += uy * REACH; }
    for (let gx = Math.floor(Math.min(ax, bx) / CELL); gx <= Math.floor(Math.max(ax, bx) / CELL); gx++)
      for (let gy = Math.floor(Math.min(ay, by) / CELL); gy <= Math.floor(Math.max(ay, by) / CELL); gy++)
        (grid.get(`${gx}_${gy}`) ?? grid.set(`${gx}_${gy}`, []).get(`${gx}_${gy}`)!).push([ax, ay, bx, by]);
  }
  return grid;
}

/**
 * Where crossings cut a way's centre line (samples [e, n, u, vis] × n): flat [d, h, …] with d the
 * distance from the way's start and h the half length of the zebra band along the way (longer when
 * the crossing is skewed). Sorted by d, one entry per crossing.
 */
export function crossingsAlong(s: number[], grid: Map<string, Seg[]>): number[] {
  const hits: Array<[number, number]> = [];
  let cum = 0;
  for (let k = 0; k + 4 < s.length; k += 4) {
    const ax = s[k], ay = s[k + 1], bx = s[k + 4], by = s[k + 5], dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy);
    if (L < 1e-6) continue;
    const seen = new Set<Seg>();
    for (let gx = Math.floor(Math.min(ax, bx) / CELL); gx <= Math.floor(Math.max(ax, bx) / CELL); gx++)
      for (let gy = Math.floor(Math.min(ay, by) / CELL); gy <= Math.floor(Math.max(ay, by) / CELL); gy++)
        for (const seg of grid.get(`${gx}_${gy}`) ?? []) {
          if (seen.has(seg)) continue;
          seen.add(seg);
          const [cx, cy, ex, ey] = seg, fx = ex - cx, fy = ey - cy;
          const den = dx * fy - dy * fx;
          if (Math.abs(den) < 1e-9) continue;
          const t = ((cx - ax) * fy - (cy - ay) * fx) / den, u = ((cx - ax) * dy - (cy - ay) * dx) / den;
          if (t < 0 || t > 1 || u < 0 || u > 1) continue;
          const sin = Math.abs(den) / (L * Math.hypot(fx, fy));
          hits.push([cum + t * L, Math.min(4, HALF_BAND / Math.max(0.35, sin))]);
        }
    cum += L;
  }
  hits.sort((a, b) => a[0] - b[0]);
  const out: number[] = [];
  for (const [d, h] of hits) {
    const n = out.length;
    if (n && d - out[n - 2] < 2) { out[n - 1] = Math.max(out[n - 1], h); continue; } // one crossing hit twice (segment joint)
    out.push(Math.round(d * 10) / 10, Math.round(h * 10) / 10);
  }
  return out;
}
