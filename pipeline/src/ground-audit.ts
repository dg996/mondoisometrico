/**
 * QA of the drawn street network (data/derived/<area>/ground/features.json), every area:
 *   - streets / paths / rail that are NOT bridges but run over water (drawn as asphalt in the river)
 *   - bridges with no water, road or rail under them (a deck in the middle of a street)
 *   - implausible widths, raised decks (layer > 0) without bridge geometry
 *   - dead ends within 4 m of another street they do not join (broken streets at junctions)
 *
 *   node --import tsx pipeline/src/ground-audit.ts [area ...]
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AREAS, openArea } from "./areas.ts";
import { DERIVED, RAW } from "./paths.ts";
import { ecefToEnu, llhToEcef } from "./camera.ts";
import { belowSurface, wayLength } from "./roadspec.ts";

type P2 = [number, number];
interface Feature { id?: number; bridge?: boolean; k: string; r?: P2[][]; l?: P2[]; w?: number; y?: number }
const inRings = ([x, y]: P2, rings: P2[][]) => { let c = false; for (const r of rings) for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const [xi, yi] = r[i], [xj, yj] = r[j]; if (yi > y !== yj > y && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c; } return c; };
const samples = (l: P2[], step: number) => { const out: P2[] = []; for (let k = 1; k < l.length; k++) { const L = Math.hypot(l[k][0] - l[k - 1][0], l[k][1] - l[k - 1][1]); for (let d = 0; d < L; d += step) out.push([l[k - 1][0] + (l[k][0] - l[k - 1][0]) * d / L, l[k - 1][1] + (l[k][1] - l[k - 1][1]) * d / L]); } return out; };
const LINE = new Set(["highway", "street", "lane", "dirtroad", "path", "plaza", "cycle", "rail"]);

export function auditArea(area: string) {
  openArea(area);
  const file = join(DERIVED, area, "ground", "features.json");
  if (!existsSync(file)) return null;
  const features: Feature[] = JSON.parse(readFileSync(file, "utf8"));
  const water = features.filter((f) => (f.k === "water" || f.k === "sea") && f.r).map((f) => f.r!);
  const box = (r: P2[][]) => { const p = r.flat(); return [Math.min(...p.map((q) => q[0])), Math.min(...p.map((q) => q[1])), Math.max(...p.map((q) => q[0])), Math.max(...p.map((q) => q[1]))]; };
  const wbox = water.map(box);
  const wet = (p: P2) => water.some((r, i) => p[0] >= wbox[i][0] && p[0] <= wbox[i][2] && p[1] >= wbox[i][1] && p[1] <= wbox[i][3] && inRings(p, r));
  const lines = features.filter((f) => LINE.has(f.k) && f.l);
  // grid of every drawn line for "what is under this bridge" and near-miss dead ends
  const CELL = 25, grid = new Map<string, Array<{ f: Feature; p: P2 }>>();
  for (const f of lines) for (const p of samples(f.l!, 2)) { const k = `${Math.floor(p[0] / CELL)}_${Math.floor(p[1] / CELL)}`; (grid.get(k) ?? grid.set(k, []).get(k)!).push({ f, p }); }
  const near = (p: P2, r: number, keep: (f: Feature) => boolean) => {
    const out: Feature[] = [];
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++)
      for (const q of grid.get(`${Math.floor(p[0] / CELL) + dx}_${Math.floor(p[1] / CELL) + dy}`) ?? []) if (keep(q.f) && Math.hypot(q.p[0] - p[0], q.p[1] - p[1]) < r) out.push(q.f);
    return out;
  };
  const inWater: Array<{ id?: number; k: string; m: number }> = [], idleBridges: Array<{ id?: number; m: number }> = [], odd: string[] = [];
  for (const f of lines) {
    if (f.w !== undefined && (f.w > 40 || f.w < 0.8)) odd.push(`width ${f.w} m: ${f.k} way/${f.id}`);
    if ((f.y ?? 0) > 0 && !f.bridge && f.k !== "rail") odd.push(`raised (layer ${f.y}) without bridge: ${f.k} way/${f.id}`);
    const pts = samples(f.l!, 2);
    if (!f.bridge) {
      const m = pts.filter(wet).length * 2;
      if (m >= 6) inWater.push({ id: f.id, k: f.k, m });
    } else if (pts.length > 4) {
      const under = pts.filter((p) => wet(p) || near(p, 6, (g) => g !== f && !g.bridge).length).length;
      if (under === 0) idleBridges.push({ id: f.id, m: pts.length * 2 });
    }
  }
  // dead ends: a street end that touches no other street (< 0.3 m to its segments) but passes within
  // 4 m of one on the same layer: a drawn gap at what should be a junction
  const ends: Array<{ id?: number; gap: number; at: P2 }> = [];
  const segDist = (p: P2, l: P2[]) => { let d = Infinity; for (let k = 1; k < l.length; k++) { const [ax, ay] = l[k - 1], [bx, by] = l[k], dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy || 1e-9, t = Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / L)); d = Math.min(d, Math.hypot(p[0] - ax - t * dx, p[1] - ay - t * dy)); } return d; };
  const STREET = ["street", "highway", "lane"];
  for (const f of lines.filter((f) => STREET.includes(f.k))) for (const e of [f.l![0], f.l!.at(-1)!]) {
    const cands = [...new Set(near(e, 6, (g) => g !== f && STREET.includes(g.k) && (g.y ?? 0) === (f.y ?? 0)))];
    if (!cands.length) continue;
    const d = Math.min(...cands.map((g) => segDist(e, g.l!)));
    if (d > 0.3 && d < 4) ends.push({ id: f.id, gap: Math.round(d * 10) / 10, at: e });
  }
  return { area, lines: lines.length, inWater: inWater.sort((a, b) => b.m - a.m), idleBridges, odd, ends };
}

/** Rail lines that OSM marks below the surface but are drawn anyway (should be none after belowSurface). */
export function railCheck(area: string) {
  const raw = join(RAW, area, "ground.json");
  if (!existsSync(raw)) return null;
  const els = JSON.parse(readFileSync(raw, "utf8")).elements;
  const drawn = new Set((JSON.parse(readFileSync(join(DERIVED, area, "ground", "features.json"), "utf8")) as Feature[]).filter((f) => f.id).map((f) => f.id));
  return els.filter((e: any) => e.tags && (e.tags.highway || e.tags.railway) && belowSurface(e.tags, e.geometry ? wayLength(e.geometry) : Infinity) && drawn.has(e.id)).map((e: any) => `${e.type}/${e.id}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const areas = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(AREAS);
  for (const a of areas) {
    const r = auditArea(a);
    if (!r) { console.log(`${a}: no ground yet`); continue; }
    const leaked = railCheck(a) ?? [];
    console.log(`\n== ${a}: ${r.lines} drawn lines`);
    console.log(`  not-bridge lines over water: ${r.inWater.length} (${r.inWater.reduce((t, x) => t + x.m, 0)} m)`, r.inWater.slice(0, 8).map((x) => `${x.k} way/${x.id} ${x.m}m`).join(", "));
    console.log(`  bridges over nothing: ${r.idleBridges.length}`, r.idleBridges.slice(0, 8).map((x) => `way/${x.id} ${x.m}m`).join(", "));
    console.log(`  odd widths / raised without bridge: ${r.odd.length}`, r.odd.slice(0, 6).join("; "));
    console.log(`  street ends 0.6–4 m from an unjoined street: ${r.ends.length}`, r.ends.slice(0, 8).map((x) => `way/${x.id} (${x.gap} m)`).join(", "));
    console.log(`  below-surface ways still drawn: ${leaked.length}`);
  }
}
void ecefToEnu; void llhToEcef;
