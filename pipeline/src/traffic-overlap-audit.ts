/**
 * Overlap audit on the exported Rome data: runs the real traffic simulation (roads + GTFS bus
 * lines, painted-area mask as in the viewer) and counts vehicle pairs whose footprints overlap at
 * the same height. Run: node --import tsx pipeline/src/traffic-overlap-audit.ts [minutes]
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Traffic } from "../../web/src/scripts/traffic.ts";
import { decodeRoads } from "../../web/src/scripts/roads.ts";
import { ActivityMask, activeRoads } from "../../web/src/scripts/activity.ts";
import { DATA, DERIVED } from "./paths.ts";

/** Zebra bands as drawn (page/ground.ts: 3 m bars along each OSM marked crossing), 20 m grid. */
function zebraBands(areas: string[]) {
  const grid = new Map<string, number[][]>();
  for (const a of areas) {
    const f = join(DERIVED, a, "ground", "features.json");
    if (!existsSync(f)) continue;
    for (const c of JSON.parse(readFileSync(f, "utf8")) as Array<{ k: string; l?: number[][] }>) {
      if (c.k !== "crossing" || !c.l) continue;
      for (let i = 1; i < c.l.length; i++) {
        const [ax, ay] = c.l[i - 1], [bx, by] = c.l[i], key = `${Math.floor((ax + bx) / 40)}_${Math.floor((ay + by) / 40)}`;
        (grid.get(key) ?? grid.set(key, []).get(key)!).push([ax, ay, bx, by]);
      }
    }
  }
  return grid;
}

export function auditTraffic(minutes = 10, sampleEvery = 5, noZebra = false) {
  const dir = join(DATA, "web/regions/roma-centro/data");
  const world = JSON.parse(readFileSync(join(dir, "world.json"), "utf8"));
  const roads = activeRoads(decodeRoads(JSON.parse(readFileSync(join(dir, world.files.roads), "utf8"))), world.enu2px, new ActivityMask(world.activity));
  if (noZebra) for (const r of roads) delete r.x;
  const bands = zebraBands(["roma-nord", "roma-sud", "roma-est", "roma-core", "roma-inner"]);
  /** a stopped body over the stripes: any of 5 points on its axis within 1.4 m of a crossing way */
  const onStripes = (p: { c: number[]; d: number[]; v: any }) => {
    const gx = Math.floor(p.c[0] / 20), gy = Math.floor(p.c[1] / 20);
    for (let k = -2; k <= 2; k++) {
      const x = p.c[0] + p.d[0] * (p.v.len / 2 - 0.4) * k / 2, y = p.c[1] + p.d[1] * (p.v.len / 2 - 0.4) * k / 2;
      for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (const [ax, ay, bx, by] of bands.get(`${gx + a}_${gy + b}`) ?? []) {
        const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy || 1e-9, u = ((x - ax) * dx + (y - ay) * dy) / L;
        if (u < 0 || u > 1) continue;
        if (Math.hypot(x - ax - u * dx, y - ay - u * dy) < 1.4) return true;
      }
    }
    return false;
  };
  let stopped = 0, stoppedOnZebra = 0;
  const zebraHot = new Map<string, number>();
  const transit = world.files.transit ? JSON.parse(readFileSync(join(dir, world.files.transit), "utf8")) : null;
  const h = (world.camera.headingDeg * Math.PI) / 180;
  const t = new Traffic(roads, world.enu2px, [Math.sin(h), Math.cos(h)], 1.3, transit?.buses ?? []) as any;
  let poses: Array<{ c: number[]; d: number[]; v: any }> = [];
  t.box = (_c: unknown, _p: unknown, c: number[], d: number[], v: any) => poses.push({ c, d, v });
  const overlaps = new Map<string, number>(); let samples = 0, worst = 0;
  const corners = (p: typeof poses[0]) => { const [dx, dy] = p.d, hl = p.v.len / 2 - 0.15, hw = p.v.wid / 2 - 0.1;
    return [[1, 1], [1, -1], [-1, -1], [-1, 1]].map(([a, b]) => [p.c[0] + dx * hl * a + dy * hw * b, p.c[1] + dy * hl * a - dx * hw * b]); };
  const sep = (A: number[][], B: number[][]) => { for (const P of [A, B]) for (let i = 0; i < 4; i++) {
    const [x0, y0] = P[i], [x1, y1] = P[(i + 1) % 4], nx = y1 - y0, ny = x0 - x1;
    const pa = A.map(([x, y]) => x * nx + y * ny), pb = B.map(([x, y]) => x * nx + y * ny);
    if (Math.max(...pa) < Math.min(...pb) || Math.max(...pb) < Math.min(...pa)) return true; } return false; };
  const steps = (minutes * 60) / 0.1;
  for (let i = 1; i <= steps; i++) {
    t.step(0.1);
    if (i % (sampleEvery * 10)) continue;
    poses = []; t.draw({}, (x: number, y: number) => [x, y], 1, [-1e9, -1e9, 1e9, 1e9]);
    samples++;
    for (const p of poses) if (p.v.v < 0.3 && !p.v.tram) {
      stopped++;
      if (onStripes(p)) { stoppedOnZebra++; const k = `${Math.round(p.c[0] / 20) * 20},${Math.round(p.c[1] / 20) * 20}`; zebraHot.set(k, (zebraHot.get(k) ?? 0) + 1); }
    }
    const cs = poses.map(corners), grid = new Map<string, number[]>();
    poses.forEach((p, k) => { const key = `${Math.floor(p.c[0] / 30)}_${Math.floor(p.c[1] / 30)}`; (grid.get(key) ?? grid.set(key, []).get(key)!).push(k); });
    let n = 0;
    poses.forEach((p, a) => { const gx = Math.floor(p.c[0] / 30), gy = Math.floor(p.c[1] / 30);
      for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) for (const b of grid.get(`${gx + x}_${gy + y}`) ?? []) {
        if (b <= a || Math.abs(poses[b].c[2] - p.c[2]) > 2.5 || Math.hypot(poses[b].c[0] - p.c[0], poses[b].c[1] - p.c[1]) > 12) continue;
        if (!sep(cs[a], cs[b])) { n++; const k = `${Math.round(p.c[0] / 20) * 20},${Math.round(p.c[1] / 20) * 20}`; overlaps.set(k, (overlaps.get(k) ?? 0) + 1); }
      } });
    worst = Math.max(worst, n);
  }
  const total = [...overlaps.values()].reduce((a, b) => a + b, 0);
  return { vehicles: t.count, samples, total, perSample: total / samples, worst, hot: [...overlaps].sort((a, b) => b[1] - a[1]).slice(0, 8),
    stoppedPerSample: stopped / samples, stoppedOnZebraPerSample: stoppedOnZebra / samples, zebraShare: stoppedOnZebra / Math.max(1, stopped),
    zebraHot: [...zebraHot].sort((a, b) => b[1] - a[1]).slice(0, 8) };
}

if (import.meta.url === `file://${process.argv[1]}`) console.log(JSON.stringify(auditTraffic(Number(process.argv[2] ?? 10), 5, process.argv.includes("--no-zebra")), null, 1));
