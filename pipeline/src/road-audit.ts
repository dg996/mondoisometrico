/**
 * Street audit against the Regione Lazio CTRN surveyed buildings (centro, ±1.4 km from Piazza Venezia):
 * façade-to-façade gap vs the drawn width per street class, OSM centre-line offset from the corridor
 * centre, and OSM street samples that run INSIDE a surveyed building (misplaced streets; arches and
 * tunnels excluded).   node --import tsx pipeline/src/road-audit.ts   (after fetch roma-core)
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RAW } from "./paths.ts";
import { ROAD, belowSurface, roadWidth } from "./roadspec.ts";

const lat0 = 41.8955, lon0 = 12.4823, mx = 111320 * Math.cos(lat0 * Math.PI / 180), my = 110574, R = 1400;
const xy = ([lo, la]: number[]) => [(lo - lon0) * mx, (la - lat0) * my];
const CELL = 30, segs = new Map<string, number[][]>(), cells = new Map<string, number[][][]>();
const add = <T>(m: Map<string, T[]>, k: string, v: T) => (m.get(k) ?? m.set(k, []).get(k)!).push(v);
for (const u of JSON.parse(readFileSync(join(RAW, "ctrn", "units.json"), "utf8"))) {
  const p: number[][] = u.r.map(xy);
  if (!p.some(([x, y]) => Math.abs(x) < R + 60 && Math.abs(y) < R + 60)) continue;
  const xs = p.map((q) => q[0]), ys = p.map((q) => q[1]);
  for (let gx = Math.floor(Math.min(...xs) / CELL); gx <= Math.floor(Math.max(...xs) / CELL); gx++)
    for (let gy = Math.floor(Math.min(...ys) / CELL); gy <= Math.floor(Math.max(...ys) / CELL); gy++) add(cells, `${gx}_${gy}`, p);
  for (let k = 1; k < p.length; k++) {
    const s = [p[k - 1][0], p[k - 1][1], p[k][0], p[k][1]];
    for (let gx = Math.floor(Math.min(s[0], s[2]) / CELL); gx <= Math.floor(Math.max(s[0], s[2]) / CELL); gx++)
      for (let gy = Math.floor(Math.min(s[1], s[3]) / CELL); gy <= Math.floor(Math.max(s[1], s[3]) / CELL); gy++) add(segs, `${gx}_${gy}`, s);
  }
}
const inPoly = ([x, y]: number[], p: number[][]) => { let c = false; for (let i = 0, j = p.length - 1; i < p.length; j = i++) { const [xi, yi] = p[i], [xj, yj] = p[j]; if (yi > y !== yj > y && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c; } return c; };
const inBuilding = (x: number, y: number) => (cells.get(`${Math.floor(x / CELL)}_${Math.floor(y / CELL)}`) ?? []).some((p) => inPoly([x, y], p));
function hit(px: number, py: number, dx: number, dy: number) {
  let best = Infinity;
  for (let t = 0; t <= 40; t += CELL / 2) for (const s of segs.get(`${Math.floor((px + dx * t) / CELL)}_${Math.floor((py + dy * t) / CELL)}`) ?? []) {
    const ex = s[2] - s[0], ey = s[3] - s[1], den = dx * ey - dy * ex; if (Math.abs(den) < 1e-9) continue;
    const tt = ((s[0] - px) * ey - (s[1] - py) * ex) / den, u = ((s[0] - px) * dy - (s[1] - py) * dx) / den;
    if (tt > 0 && tt <= 40 && u >= 0 && u <= 1) best = Math.min(best, tt);
  }
  return best;
}
const els = JSON.parse(readFileSync(join(RAW, "roma-core", "ground.json"), "utf8")).elements
  .filter((e: any) => e.type === "way" && e.geometry && ROAD[e.tags?.highway] && e.tags.area !== "yes" && !belowSurface(e.tags) && !(e.tags.bridge && e.tags.bridge !== "no") && !e.tags.tunnel && !e.tags.covered);
const med = (v: number[]) => v.slice().sort((a, b) => a - b)[Math.floor(v.length / 2)] ?? NaN;
const by: Record<string, { gap: number[]; drawn: number[]; off: number[]; inside: number; n: number }> = {};
const misplaced = new Map<string, number>();
for (const r of els) {
  const p = r.geometry.map((q: any) => xy([q.lon, q.lat]));
  if (!p.every(([x, y]: number[]) => Math.abs(x) < R && Math.abs(y) < R)) continue;
  const o = by[r.tags.highway] ??= { gap: [], drawn: [], off: [], inside: 0, n: 0 };
  for (let k = 1; k < p.length; k++) {
    const L = Math.hypot(p[k][0] - p[k - 1][0], p[k][1] - p[k - 1][1]);
    for (let d = 2; d < L; d += 4) {
      const f = d / L, cx = p[k - 1][0] + (p[k][0] - p[k - 1][0]) * f, cy = p[k - 1][1] + (p[k][1] - p[k - 1][1]) * f;
      o.n++;
      if (inBuilding(cx, cy)) { o.inside++; const nm = `${r.tags.name ?? "(senza nome)"} way/${r.id}`; misplaced.set(nm, (misplaced.get(nm) ?? 0) + 4); }
      if (d % 12 !== 2 || L < 10) continue;
      const nx = -(p[k][1] - p[k - 1][1]) / L, ny = (p[k][0] - p[k - 1][0]) / L, a = hit(cx, cy, nx, ny), b = hit(cx, cy, -nx, -ny);
      if (a + b < 45) { o.gap.push(a + b); o.drawn.push(roadWidth(r.tags) + (ROAD[r.tags.highway][1] ? 5.4 : 0)); o.off.push(Math.abs(a - b) / 2); }
    }
  }
}
console.table(Object.entries(by).filter(([, o]) => o.n > 100).map(([hw, o]) => ({ highway: hw, facadeGapM: med(o.gap).toFixed(1), osmDrawnM: med(o.drawn).toFixed(1), centreOffsetM: med(o.off).toFixed(1), insideBuildings: (100 * o.inside / o.n).toFixed(1) + "%" })));
console.log("streets running longest inside surveyed buildings (m):");
console.table([...misplaced].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([way, m]) => ({ way, m })));
