/**
 * Simulated traffic on real OSM roads: cars and buses wander the road graph (random walk,
 * one-way aware, right-hand lanes), drawn as small 3D boxes through the map camera.
 * Not real trips, but they behave: each vehicle keeps a safe gap to the one ahead in its lane,
 * takes turns at junctions (approaches alternate like lights), slows for turns, and its cruising
 * speed drifts so traffic flows unevenly. Lanes come from the same widths the ground was drawn
 * with, so vehicles stay on the asphalt. Hidden where the road is behind buildings or trees.
 */

export interface Road {
  c: number;        // class 0 motorway … 5 service
  o: number;        // 1 oneway forward, -1 oneway backward, 0 both
  l: number;        // lanes per direction (total if one-way)
  w?: number;       // carriageway width (m), as drawn on the map
  a: number; b: number; // OSM start / end node ids
  s: number[];      // [e, n, u, visible] × samples (2 m in new exports; legacy ≤ 6 m)
}

type Vec3 = [number, number, number];
import { drawCar } from "./vehicle-mesh.ts";

/** A real bus line stretch (GTFS, CC BY-SA): ENU guide path every ~10 m and headway in seconds. */
export interface BusLine { n: string; d: number; h: number; p: number[] }

/** Line guide with a 25 m grid of its points for "how far is this from the route" queries. */
interface Guide { line: BusLine; xy: Float32Array; grid: Map<string, number[]>; night: boolean }

interface Way { r: Road; n: number; cum: Float32Array; len: number; w: number }
interface Vehicle {
  id: number;
  w: number; dir: 1 | -1; s: number; lane: number;
  v: number;          // current speed (m/s)
  cruise: number;     // personal cruising factor
  phase: number;      // speed drift phase
  stuck: number;      // seconds spent waiting at a stop line (gridlock escape)
  through: boolean;   // granted the junction ahead: may cross the stop line
  holding: number;    // junction node this vehicle is inside (-1 none)
  next: { w: number; dir: 1 | -1 } | null; // way chosen for after this one
  len: number; wid: number; hei: number; color: [number, number, number]; bus: boolean;
  /** index into Traffic.guides when this bus runs a real line, else -1 */
  line: number;
  kind?: "car" | "small" | "taxi" | "van";
}

const CLASS_WEIGHT = [3, 2.6, 2, 1.4, 0.35, 0.05];
const CLASS_SPEED = [22, 13, 12, 11, 8, 5]; // m/s (≈ 80, 47, 43, 40, 29, 18 km/h)
const ACCEL = 2.2, BRAKE = 5.5;              // m/s²
const GAP = 2.2, HEADWAY = 1.1;              // standstill gap (m), time gap (s)
/** Rome's car park, roughly: white, silver/grey and black dominate, a few blues, reds, greens */
const CAR_COLORS: Array<[number, number, number]> = [
  [238, 238, 236], [238, 238, 236], [238, 238, 236], [196, 199, 204], [196, 199, 204], [128, 132, 138],
  [44, 46, 50], [44, 46, 50], [38, 62, 112], [164, 34, 36], [92, 104, 74], [214, 206, 188],
];
/** the render's sun (page/renderer.ts SUN), normalised: vehicles lit like the buildings */
const SUN: Vec3 = (() => { const v = [-0.55, -0.35, 0.76], L = Math.hypot(...v); return v.map((x) => x / L) as Vec3; })();
/** pick a vehicle type: [kind, length, width, height] (city cars, family cars, taxis, white vans) */
function carType(r: () => number): { kind: "car" | "small" | "taxi" | "van"; len: number; wid: number; hei: number } {
  const u = r();
  if (u < 0.16) return { kind: "small", len: 3.0 + r() * 0.7, wid: 1.62, hei: 1.5 };
  if (u < 0.24) return { kind: "taxi", len: 4.4 + r() * 0.3, wid: 1.8, hei: 1.55 };
  if (u < 0.32) return { kind: "van", len: 5.1 + r() * 0.8, wid: 2.0, hei: 2.3 };
  return { kind: "car", len: 3.7 + r() * 0.9, wid: 1.74, hei: 1.48 };
}
/** ATAC fleet: mostly red, some white/grey (illustrative livery, not per vehicle) */
const ATAC_COLORS: Array<[number, number, number]> = [[178, 34, 42], [178, 34, 42], [178, 34, 42], [222, 222, 220]];
const GUIDE_CELL = 25, OFF_ROUTE = 16, BUS_SPEED = 6; // m, m, m/s average incl. stops

export class Traffic {
  private ways: Way[] = [];
  private out = new Map<number, Array<{ w: number; dir: 1 | -1 }>>();
  private vehicles: Vehicle[] = [];
  /** junction node -> approach (way) that has green, vehicles inside, when the green started */
  private nodeHold = new Map<number, { way: number; inside: number; start: number; last: number }>();
  /** ways meeting at a node: 2 = plain split of one road (no junction) */
  private degree = new Map<number, number>();
  private lanes = new Map<string, Vehicle[]>(); // `${way}:${dir}:${lane}` -> sorted by s
  /** junction box radius per node: half the widest road meeting there + margin */
  private nodeR = new Map<number, number>();
  private t = 0;
  private rand = mulberry(7);
  /** vehicles drawn in the last frame (debug / tests) */
  drawn = 0;
  private guides: Guide[] = [];
  /** 25 m grid of way samples [way, sample] (built on demand for placing line buses) */
  private sampleGrid: Map<string, number[]> | null = null;
  /** minutes since midnight of the simulated clock (ambient.ts): day lines by day, night lines by night */
  clock: () => number = () => 12 * 60;

  constructor(roads: Road[], private enu2px: number[][], private camFwd: [number, number], density = 1, lines: BusLine[] = []) {
    for (const r of roads) {
      const n = r.s.length / 4;
      if (n < 2 || !Number.isInteger(n) || r.s.some((v) => !Number.isFinite(v))) continue;
      const cum = new Float32Array(n);
      for (let i = 1; i < n; i++)
        cum[i] = cum[i - 1] + Math.hypot(r.s[i * 4] - r.s[i * 4 - 4], r.s[i * 4 + 1] - r.s[i * 4 - 3]);
      const w = this.ways.push({ r, n, cum, len: cum[n - 1], w: r.w ?? Math.max(4, r.l * (r.o ? 3.2 : 6.4)) }) - 1;
      const R = Math.min(16, (r.w ?? 6) / 2 + 1.5);
      for (const n of [r.a, r.b]) {
        this.nodeR.set(n, Math.max(this.nodeR.get(n) ?? 0, R));
        this.degree.set(n, (this.degree.get(n) ?? 0) + 1);
      }
      if (r.o >= 0) this.link(r.a, { w, dir: 1 });
      if (r.o <= 0) this.link(r.b, { w, dir: -1 });
    }
    for (const [n, d] of this.degree) if (d <= 2) this.nodeR.set(n, 0); // not a junction: no box, no stop line
    // "not too many": ~1 vehicle per 55 weighted metres (only on-screen ones are drawn)
    const weights = this.ways.map((w) => w.len * CLASS_WEIGHT[w.r.c]);
    const total = weights.reduce((a, b) => a + b, 0);
    if (!Number.isFinite(total) || total <= 0) return;
    const count = Math.round(Math.min(5000, Math.max(80, (total / 55) * density)));
    this.regroup();
    for (let i = 0, tries = 0; this.vehicles.length < count && tries < count * 4; tries++) {
      let pick = this.rand() * total, w = 0;
      while (pick > weights[w] && w < weights.length - 1) pick -= weights[w++];
      const way = this.ways[w];
      const dir: 1 | -1 = way.r.o === 1 ? 1 : way.r.o === -1 ? -1 : this.rand() < 0.5 ? 1 : -1;
      const bus = !lines.length && way.r.c <= 2 && this.rand() < 0.08; // real lines replace random buses
      const type = carType(this.rand);
      const len = bus ? 12 : type.len;
      if (way.len < len + 4) continue;
      // skip ways that are mostly occluded / water-hidden (cars must not spawn in the river)
      if (this.wayVisible(way) < 0.55) continue;
      const s = len / 2 + this.rand() * (way.len - len);
      if (!this.sampleVisible(way, s, dir, len)) continue; // exact spawn point must be on visible asphalt
      const lane = bus ? 0 : Math.floor(this.rand() * way.r.l);
      // never spawn on top of another vehicle
      const group = this.lanes.get(`${w}:${dir}:${lane}`) ?? [];
      if (group.some((o) => Math.abs(o.s - s) < (o.len + len) / 2 + GAP)) continue;
      const v: Vehicle = {
        id: i++, w, dir, s, lane, bus, len, stuck: 0, through: false, holding: -1, next: null, line: -1,
        cruise: 0.8 + this.rand() * 0.35, phase: this.rand() * Math.PI * 2, v: 0,
        wid: bus ? 2.55 : type.wid, hei: bus ? 3.1 : type.hei, kind: bus ? undefined : type.kind,
        color: bus ? ATAC_COLORS[Math.floor(this.rand() * ATAC_COLORS.length)]
          : type.kind === "taxi" || type.kind === "van" ? [238, 238, 236] : CAR_COLORS[Math.floor(this.rand() * CAR_COLORS.length)],
      };
      v.v = this.limit(v) * 0.8;
      this.vehicles.push(v);
      group.push(v);
      this.lanes.set(`${w}:${dir}:${lane}`, group);
    }
    if (lines.length) { this.spawnLines(lines); this.regroup(); }
  }

  get count() { return this.vehicles.length; }

  /** Buses on the real lines: as many per line stretch as its headway allows (≥ 1 when it runs). */
  private spawnLines(lines: BusLine[]) {
    for (const line of lines) {
      const xy = Float32Array.from(line.p), grid = new Map<string, number[]>();
      for (let i = 0; i < xy.length / 2; i++) {
        const k = `${Math.floor(xy[i * 2] / GUIDE_CELL)}_${Math.floor(xy[i * 2 + 1] / GUIDE_CELL)}`;
        (grid.get(k) ?? grid.set(k, []).get(k)!).push(i);
      }
      const g = this.guides.push({ line, xy, grid, night: /^n/i.test(line.n) }) - 1;
      const length = (xy.length / 2) * 10;
      const want = Math.max(1, Math.min(6, Math.round(length / (line.h * BUS_SPEED))));
      for (let k = 0; k < want; k++) this.placeOnLine(g, k / want);
    }
  }

  /** Nearest guide point (index, distance) to an ENU point, searching the 3×3 cells around it. */
  private nearest(g: Guide, x: number, y: number) {
    let best = -1, d = Infinity;
    const cx = Math.floor(x / GUIDE_CELL), cy = Math.floor(y / GUIDE_CELL);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++)
      for (const p of g.grid.get(`${cx + i}_${cy + j}`) ?? []) {
        const e = Math.hypot(g.xy[p * 2] - x, g.xy[p * 2 + 1] - y);
        if (e < d) { d = e; best = p; }
      }
    return { i: best, d };
  }

  /** A way + direction lying on the guide around fraction `f` of its length (or anywhere on it). */
  private placeOnLine(g: number, f: number, existing?: Vehicle) {
    const guide = this.guides[g], n = guide.xy.length / 2;
    for (let tries = 0; tries < 30; tries++) {
      const at = Math.min(n - 2, Math.floor(((f + tries * 0.137) % 1) * (n - 1)));
      const x = guide.xy[at * 2], y = guide.xy[at * 2 + 1], fx = guide.xy[at * 2 + 2] - x, fy = guide.xy[at * 2 + 3] - y;
      // the drawn way closest to this guide point, travelled in the line's direction
      let pick: { w: number; dir: 1 | -1; s: number } | null = null, pd = 8;
      if (!this.sampleGrid) {
        this.sampleGrid = new Map();
        this.ways.forEach((way, w) => { for (let k = 0; k < way.n - 1; k++) {
          const c = `${Math.floor(way.r.s[k * 4] / GUIDE_CELL)}_${Math.floor(way.r.s[k * 4 + 1] / GUIDE_CELL)}`;
          (this.sampleGrid!.get(c) ?? this.sampleGrid!.set(c, []).get(c)!).push(w, k);
        } });
      }
      const cx = Math.floor(x / GUIDE_CELL), cy = Math.floor(y / GUIDE_CELL), cand: number[] = [];
      for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) cand.push(...(this.sampleGrid.get(`${cx + i}_${cy + j}`) ?? []));
      for (let c = 0; c < cand.length; c += 2) {
        const w = cand[c], way = this.ways[w], S = way.r.s;
        if (way.r.c > 4 || this.wayVisible(way) < 0.55) continue;
        { const k = cand[c + 1];
          const d = Math.hypot(S[k * 4] - x, S[k * 4 + 1] - y);
          if (d >= pd) continue;
          const dx = S[k * 4 + 4] - S[k * 4], dy = S[k * 4 + 5] - S[k * 4 + 1];
          const dir: 1 | -1 = dx * fx + dy * fy >= 0 ? 1 : -1;
          if ((way.r.o === 1 && dir === -1) || (way.r.o === -1 && dir === 1)) continue;
          pd = d; pick = { w, dir, s: dir === 1 ? way.cum[k] : way.len - way.cum[k] };
        }
      }
      if (!pick) continue;
      const len = this.guides[g].line.h <= 480 && (g + Math.floor(f * 10)) % 3 === 0 ? 18 : 12, way = this.ways[pick.w]; // busiest lines: some articulated
      const s = Math.max(len / 2 + 1, Math.min(way.len - len / 2 - 1, pick.s));
      if (way.len < len + 4 || !this.sampleVisible(way, s, pick.dir, len)) continue;
      const lane = 0, group = this.lanes.get(`${pick.w}:${pick.dir}:${lane}`) ?? [];
      if (group.some((o) => o !== existing && Math.abs(o.s - s) < (o.len + len) / 2 + GAP)) continue;
      if (existing) {
        this.release(existing);
        Object.assign(existing, { w: pick.w, dir: pick.dir, s, v: 0, next: null, stuck: 0, through: false });
        return true;
      }
      const v: Vehicle = {
        id: this.vehicles.length, w: pick.w, dir: pick.dir, s, lane, bus: true, len, line: g,
        stuck: 0, through: false, holding: -1, next: null, cruise: 0.85 + this.rand() * 0.2, phase: this.rand() * Math.PI * 2, v: 0,
        wid: 2.55, hei: 3.1, color: ATAC_COLORS[Math.floor(this.rand() * ATAC_COLORS.length)],
      };
      this.vehicles.push(v);
      group.push(v);
      this.lanes.set(`${pick.w}:${pick.dir}:${lane}`, group);
      return true;
    }
    return false;
  }

  /** Does this line run at the simulated hour? Night lines (n…) 0:30–5:30, the others 5:30–24:30. */
  private lineRuns(g: number) {
    const m = this.clock(), night = m >= 30 && m < 330;
    return this.guides[g].night ? night : !night;
  }

  private link(node: number, e: { w: number; dir: 1 | -1 }) {
    if (!this.out.has(node)) this.out.set(node, []);
    this.out.get(node)!.push(e);
  }

  private regroup() {
    this.lanes.clear();
    for (const v of this.vehicles) {
      const k = `${v.w}:${v.dir}:${v.lane}`;
      const g = this.lanes.get(k);
      if (g) g.push(v); else this.lanes.set(k, [v]);
    }
    for (const g of this.lanes.values()) g.sort((a, b) => a.s - b.s);
  }

  /** Cruising speed right now: class limit × personality × slow drift (traffic waves). */
  private limit(v: Vehicle) {
    const base = CLASS_SPEED[this.ways[v.w].r.c] * v.cruise * (v.bus ? 0.8 : 1);
    return base * (0.72 + 0.28 * (0.5 + 0.5 * Math.sin(this.t * 0.11 + v.phase)));
  }

  private endNode(v: Vehicle) { const r = this.ways[v.w].r; return v.dir === 1 ? r.b : r.a; }

  /** Fraction of samples still marked visible (0 = fully occluded / in the river). */
  private wayVisible(way: Way) {
    const S = way.r.s;
    let vis = 0, tot = 0;
    for (let k = 3; k < S.length; k += 4) { tot++; vis += S[k]; }
    return tot ? vis / tot : 0;
  }

  /** Require the entire body interval, in travel coordinates, to have safe samples.
   * Check every covered segment (also for sparse/short ways), not just the centre.
   */
  private sampleVisible(way: Way, dist: number, dir: 1 | -1, length: number) {
    const center = dir === 1 ? dist : way.len - dist;
    const lo = center - length / 2, hi = center + length / 2;
    if (lo < 0 || hi > way.len) return false;
    const S = way.r.s;
    for (let i = 1; i < way.n; i++) {
      if (way.cum[i] < lo || way.cum[i - 1] > hi) continue;
      const span = way.cum[i] - way.cum[i - 1];
      if (span <= 0 || span > 6.1 || S[(i - 1) * 4 + 3] !== 1 || S[i * 4 + 3] !== 1) return false;
      if (Math.abs(S[i * 4 + 2] - S[(i - 1) * 4 + 2]) > Math.min(2.2, span * 0.2)) return false;
    }
    return true;
  }

  private chooseNext(v: Vehicle) {
    const options = (this.out.get(this.endNode(v)) ?? []).filter((o) => o.w !== v.w);
    // Never route onto mostly-hidden / river-dipped ways (cars would sit in water or float).
    const drivable = options.filter((o) => this.wayVisible(this.ways[o.w]) >= 0.55
      && this.sampleVisible(this.ways[o.w], v.len / 2, o.dir, v.len));
    if (v.line >= 0) { // real line: the option that stays closest to the route 20 m in
      const g = this.guides[v.line];
      let best: { w: number; dir: 1 | -1 } | null = null, bd = OFF_ROUTE;
      for (const o of drivable) {
        const way = this.ways[o.w], S = way.r.s, at = Math.min(20, way.len);
        let i = 1; const sAt = o.dir === 1 ? at : way.len - at;
        while (i < way.n - 1 && way.cum[i] < sAt) i++;
        const d = this.nearest(g, S[i * 4], S[i * 4 + 1]).d;
        if (d < bd) { bd = d; best = o; }
      }
      return best; // null: the line leaves the drawn graph here -> the bus is put back on its line
    }
    const pool = (v.bus ? drivable.filter((o) => this.ways[o.w].r.c <= 3) : drivable);
    const from = pool.length ? pool : drivable;
    if (!from.length) return null;
    const weights = from.map((o) => CLASS_WEIGHT[this.ways[o.w].r.c] + 0.05);
    let pick = this.rand() * weights.reduce((a, b) => a + b, 0), k = 0;
    while (pick > weights[k] && k < weights.length - 1) pick -= weights[k++];
    return from[k];
  }

  /** Free space beyond the junction box at the start of `next`, in the lane we would enter. */
  private entryClear(v: Vehicle, next: { w: number; dir: 1 | -1 }) {
    const lane = v.bus ? 0 : Math.min(v.lane, this.ways[next.w].r.l - 1);
    const g = this.lanes.get(`${next.w}:${next.dir}:${lane}`);
    return !g?.length || g[0].s - g[0].len / 2 > (this.nodeR.get(this.endNode(v)) ?? 4) + v.len + GAP;
  }

  /** Distance from the vehicle's front to the stop line before the junction box ahead. */
  private toStop(v: Vehicle) {
    return this.ways[v.w].len - v.s - v.len / 2 - (this.nodeR.get(this.endNode(v)) ?? 4);
  }

  private isJunction(node: number) { return (this.degree.get(node) ?? 0) > 2; }

  /**
   * May the vehicle enter the junction ahead now? Vehicles from the same approach go together
   * (a green phase, at most 12 s while others wait); other approaches wait until the box is empty.
   */
  private grant(v: Vehicle) {
    if (!v.next || !this.entryClear(v, v.next)) return false;
    const node = this.endNode(v);
    if (!this.isJunction(node)) { v.through = true; return true; }
    let hold = this.nodeHold.get(node);
    if (hold && hold.inside <= 0 && this.t - hold.last > 0.8) { this.nodeHold.delete(node); hold = undefined; }
    if (hold && this.t - hold.last > 10) { this.nodeHold.delete(node); hold = undefined; } // lost vehicle: reset
    if (hold && (hold.way !== v.w || this.t - hold.start > 12)) return false;
    if (!hold) { hold = { way: v.w, inside: 0, start: this.t, last: this.t }; this.nodeHold.set(node, hold); }
    hold.inside++; hold.last = this.t;
    v.through = true; v.holding = node;
    return true;
  }

  private release(v: Vehicle) {
    if (v.holding < 0) return;
    const h = this.nodeHold.get(v.holding);
    if (h) { h.inside--; h.last = this.t; }
    v.holding = -1;
  }

  step(dt: number) {
    dt = Math.min(dt, 0.1);
    this.t += dt;
    this.regroup();
    for (const g of this.lanes.values()) {
      for (let k = 0; k < g.length; k++) {
        const v = g[k], way = this.ways[v.w];
        if (v.next === null) v.next = this.chooseNext(v);
        let target = this.limit(v);
        if (v.stuck > 55) { if (v.line >= 0) this.placeOnLine(v.line, this.rand(), v); else this.respawn(v); continue; } // gridlock escape
        // car following: stay a safe gap behind the vehicle ahead in this lane
        const lead = g[k + 1];
        if (lead) {
          const gap = lead.s - lead.len / 2 - (v.s + v.len / 2) - GAP;
          target = Math.min(target, Math.max(0, gap / HEADWAY), lead.v + Math.max(0, gap) * 0.5);
        }
        // approaching the junction: slow for the turn; at the stop line wait until it's granted
        const toStop = this.toStop(v);
        if (!v.through && v.next && toStop < 30) {
          const go = (toStop < 2 || !this.isJunction(this.endNode(v))) && this.grant(v);
          if (!go) target = Math.min(target, Math.max(0, toStop - 0.3) / HEADWAY);
          if (!go && toStop < 2 && v.v < 0.5) v.stuck += dt; else if (go) v.stuck = 0;
          if (way.r.c >= 2 && this.isJunction(this.endNode(v))) target = Math.min(target, 5 + Math.max(0, toStop) * 0.3);
        } else if (v.through && way.r.c >= 2 && this.isJunction(this.endNode(v))) target = Math.min(target, 7);
        // left the junction box behind: release it
        if (v.holding >= 0 && v.holding !== this.endNode(v) && v.s - v.len / 2 > (this.nodeR.get(v.holding) ?? 0)) this.release(v);
        // accelerate gently, brake firmly; never overrun the stop point
        v.v = target > v.v ? Math.min(target, v.v + ACCEL * dt) : Math.max(target, v.v - BRAKE * dt);
        if (lead) v.v = Math.min(v.v, Math.max(0, (lead.s - lead.len / 2 - (v.s + v.len / 2) - 0.5) / dt));
        v.s += v.v * dt;
      }
    }
    // move vehicles that have driven past the end of their way onto the next one
    for (const v of this.vehicles) {
      let way = this.ways[v.w];
      if (v.s + v.len / 2 < way.len) continue;
      if (!v.next) { // dead end (or a line bus at the end of its drawn route)
        if (v.line >= 0) this.placeOnLine(v.line, this.rand(), v);
        else if (way.r.o === 0) { v.dir = v.dir === 1 ? -1 : 1; v.s = v.len / 2; v.through = false; }
        else this.respawn(v);
        continue;
      }
      if (!v.through) { v.s = way.len - v.len / 2; v.v = 0; continue; } // not granted: hold at the end
      const over = v.s + v.len / 2 - way.len;
      v.w = v.next.w; v.dir = v.next.dir; v.next = null; v.through = false;
      way = this.ways[v.w];
      v.lane = v.bus ? 0 : Math.min(v.lane, way.r.l - 1);
      v.s = Math.min(way.len - v.len / 2, v.len / 2 + over);
      v.phase += 0.7;
    }
  }

  /** Move a vehicle stranded at a one-way dead end (data gap) to a random free road start. */
  private respawn(v: Vehicle) {
    this.release(v);
    for (let tries = 0; tries < 40; tries++) {
      const w = Math.floor(this.rand() * this.ways.length), way = this.ways[w];
      const dir: 1 | -1 = way.r.o === -1 ? -1 : way.r.o === 1 ? 1 : this.rand() < 0.5 ? 1 : -1;
      const start = (this.nodeR.get(dir === 1 ? way.r.a : way.r.b) ?? 4) + v.len / 2;
      if (way.r.c > 3 || way.len < start + v.len + 30 || (v.bus && way.r.c > 2)) continue;
      if (this.wayVisible(way) < 0.55) continue; // no river / occluded respawns
      if (!this.sampleVisible(way, start, dir, v.len)) continue;
      const g = this.lanes.get(`${w}:${dir}:0`);
      if (g?.some((o) => Math.abs(o.s - start) < v.len + 2 * GAP + o.len)) continue;
      Object.assign(v, { w, dir, lane: 0, s: start, v: 0, next: null, stuck: 0, through: false });
      return;
    }
  }

  /** Lateral offset (m, + = right of travel) of the lane centre, kept inside the drawn asphalt. */
  private offset(way: Way, v: Vehicle) {
    const r = way.r, half = way.w / 2;
    const lanes = Math.max(1, r.l);
    const lw = r.o === 0 ? half / lanes : way.w / lanes;
    const o = half - (v.lane + 0.5) * lw;
    return Math.max(-half + v.wid / 2 + 0.2, Math.min(half - v.wid / 2 - 0.2, o));
  }

  /** Draw vehicles. `toScreen` maps global art px -> canvas px; `px` = canvas px per art px. */
  draw(ctx: CanvasRenderingContext2D, toScreen: (x: number, y: number) => [number, number], px: number, view: [number, number, number, number]) {
    this.drawn = 0;
    if (px < 0.28) return; // only when asphalt is clearly readable — no fleas on roofs at mid zoom
    const [vx0, vy0, vx1, vy1] = view;
    const M = this.enu2px;
    const proj = (p: Vec3): [number, number] =>
      toScreen(M[0][0] * p[0] + M[0][1] * p[1] + M[0][2] * p[2], M[1][0] * p[0] + M[1][1] * p[1] + M[1][2] * p[2]);
    const items: Array<{ v: Vehicle; c: Vec3; d: [number, number]; depth: number }> = [];
    for (const v of this.vehicles) {
      const way = this.ways[v.w], S = way.r.s;
      const at = (dist: number) => { // sample index at distance along the travel direction
        const s = Math.max(0, Math.min(way.len, v.dir === 1 ? dist : way.len - dist));
        let i = 1;
        while (i < way.n - 1 && way.cum[i] < s) i++;
        return { i, s };
      };
      if (v.line >= 0 && !this.lineRuns(v.line)) continue; // night lines by night, day lines by day
      if (!this.sampleVisible(way, v.s, v.dir, v.len)) continue;
      const { i, s } = at(v.s), k0 = (i - 1) * 4, k1 = i * 4;
      const f = (s - way.cum[i - 1]) / Math.max(1e-3, way.cum[i] - way.cum[i - 1]);
      let dx = S[k1] - S[k0], dy = S[k1 + 1] - S[k0 + 1];
      const L = Math.hypot(dx, dy) || 1;
      dx = (dx / L) * v.dir; dy = (dy / L) * v.dir;
      // Reject wild vertical jumps (broken DEM / tunnel mouths) that float cars above the street
      const du = Math.abs(S[k1 + 2] - S[k0 + 2]);
      if (du > 2.2) continue;
      const off = this.offset(way, v);
      const c: Vec3 = [S[k0] + (S[k1] - S[k0]) * f + dy * off, S[k0 + 1] + (S[k1 + 1] - S[k0 + 1]) * f - dx * off, S[k0 + 2] + (S[k1 + 2] - S[k0 + 2]) * f];
      // Reject cars sitting in a river trough vs this way's bank approaches
      const band = Math.max(1, Math.floor(way.n * 0.2));
      let bank = -Infinity;
      for (let j = 0; j < band; j++) bank = Math.max(bank, S[j * 4 + 2]);
      for (let j = way.n - band; j < way.n; j++) bank = Math.max(bank, S[j * 4 + 2]);
      if (Number.isFinite(bank) && c[2] < bank - 2.2) continue;
      const [sx, sy] = proj(c);
      if (sx < vx0 - 40 || sy < vy0 - 40 || sx > vx1 + 40 || sy > vy1 + 40) continue;
      items.push({ v, c, d: [dx, dy], depth: c[0] * this.camFwd[0] + c[1] * this.camFwd[1] });
    }
    items.sort((a, b) => b.depth - a.depth); // back to front
    this.drawn = items.length;
    for (const { v, c, d } of items) {
      this.box(ctx, proj, c, d, v);
      // line number on the roof once a bus is big enough to read
      if (v.line >= 0 && px >= 1.1) {
        const [sx, sy] = proj([c[0], c[1], c[2] + v.hei + 0.3]);
        const label = this.guides[v.line].line.n.toUpperCase();
        ctx.font = `700 ${Math.round(Math.min(14, 6 + px * 3))}px ui-sans-serif, system-ui, sans-serif`;
        ctx.textAlign = "center"; ctx.textBaseline = "middle";
        const w = ctx.measureText(label).width + 6;
        ctx.globalAlpha = 0.9; ctx.fillStyle = "#1d1b19"; ctx.fillRect(sx - w / 2, sy - 8, w, 16);
        ctx.globalAlpha = 1; ctx.fillStyle = "#ffd84d"; ctx.fillText(label, sx, sy);
      }
    }
  }

  /**
   * One vehicle as a small isometric illustration: contact shadow, dark outline round the whole
   * silhouette, faces lit by the render's sun, glass with a highlight, wheels on the visible sides.
   * Far away (px < 0.6) only the body block, so distant traffic stays clean.
   */
  private box(ctx: CanvasRenderingContext2D, proj: (p: Vec3) => [number, number], c: Vec3, d: [number, number], v: Vehicle) {
    const r: [number, number] = [d[1], -d[0]];
    const pt = (a: number, b: number, z: number): Vec3 => [c[0] + d[0] * a + r[0] * b, c[1] + d[1] * a + r[1] * b, c[2] + z];
    const scr = (p: Vec3) => proj(p);
    const px = Math.abs(scr(pt(1, 0, 0))[0] - scr(pt(0, 0, 0))[0]) + Math.abs(scr(pt(1, 0, 0))[1] - scr(pt(0, 0, 0))[1]); // screen px per metre
    const kind = v.bus ? "bus" : v.kind;
    const hl = v.len / 2, hw = v.wid / 2, G = 0.08;
    const path = (pts: Vec3[]) => { ctx.beginPath(); pts.forEach((p, i) => { const [x, y] = scr(p); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.closePath(); };
    const fill = (pts: Vec3[], css: string, a = 1) => { ctx.globalAlpha = a; ctx.fillStyle = css; path(pts); ctx.fill(); ctx.globalAlpha = 1; };
    const shade = (rgb: [number, number, number], n: Vec3) => {
      const k = 0.62 + 0.42 * Math.max(0, n[0] * SUN[0] + n[1] * SUN[1] + n[2] * SUN[2]);
      return `rgb(${Math.min(255, rgb[0] * k) | 0},${Math.min(255, rgb[1] * k) | 0},${Math.min(255, rgb[2] * k) | 0})`;
    };
    const facing = (a: Vec3, b: Vec3) => { const nx = b[1] - a[1], ny = -(b[0] - a[0]); return nx * this.camFwd[0] + ny * this.camFwd[1] < 0; };
    // footprint with chamfered corners (rounded look), CCW
    const ch = Math.min(0.45, hw * 0.35);
    const foot = (scale: number, zz: number, front = hl, rear = -hl): Vec3[] => [
      pt(front, (hw - ch) * scale, zz), pt(front - ch, hw * scale, zz), pt(rear + ch, hw * scale, zz), pt(rear, (hw - ch) * scale, zz),
      pt(rear, -(hw - ch) * scale, zz), pt(rear + ch, -hw * scale, zz), pt(front - ch, -hw * scale, zz), pt(front, -(hw - ch) * scale, zz),
    ];
    // contact shadow (soft, slightly toward the shadow side of the render's sun)
    fill(foot(1.08, G).map((p) => [p[0] + 0.45, p[1] + 0.3, p[2]] as Vec3), "#000", 0.2);
    // tyres first (the body covers their top half), and only on the side facing the camera
    const visibleSide = facing(pt(-hl, hw, 0), pt(hl, hw, 0)) ? 1 : -1;
    if (px < 2.2) this.wheels(ctx, scr, pt, v, px, (kind === "bus" ? hl * 0.72 : hl * 0.62), hw * visibleSide); // car models draw their own

    const prism = (bottom: Vec3[], top: Vec3[], rgb: [number, number, number]) => {
      for (let i = 0; i < bottom.length; i++) {
        const a = bottom[i], b = bottom[(i + 1) % bottom.length];
        if (!facing(a, b)) continue;
        const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
        fill([a, b, top[(i + 1) % top.length], top[i]], shade(rgb, [(b[1] - a[1]) / L, -(b[0] - a[0]) / L, 0]));
      }
      fill(top, shade(rgb, [0, 0, 1]));
    };
    const outline = (pts: Vec3[]) => {
      // convex hull of the projected silhouette, stroked dark: crisp edge against the painted street
      const P = pts.map(scr).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      const cross = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
      const lo: number[][] = [], hi: number[][] = [];
      for (const p of P) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
      for (const p of [...P].reverse()) { while (hi.length >= 2 && cross(hi[hi.length - 2], hi[hi.length - 1], p) <= 0) hi.pop(); hi.push(p); }
      const H = [...lo.slice(0, -1), ...hi.slice(0, -1)];
      ctx.beginPath(); H.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath();
      ctx.lineJoin = "round"; ctx.lineWidth = Math.max(0.8, Math.min(1.6, px * 0.09)); ctx.strokeStyle = "rgba(28,24,22,0.7)"; ctx.stroke();
    };
    const glass = "rgb(38,52,66)";

    if (kind === "bus" && px >= 2.2) {
      const view: Vec3 = [this.camFwd[0] * Math.SQRT1_2, this.camFwd[1] * Math.SQRT1_2, -Math.SQRT1_2];
      drawCar(ctx, scr, c, d, "bus", v.len, v.wid, v.hei, v.color, view, SUN, px);
      return;
    }
    if (kind === "bus") {
      // far away: simple ATAC block (red body, window band, light roof), continuous black window band, light roof with AC pod, big windscreen
      const z0 = G + 0.32, zWin0 = G + 1.15, zWin1 = v.hei - 0.35, zTop = v.hei;
      const bot = foot(1, z0), top = foot(1, zTop);
      outline([...foot(1, G), ...top]);
      prism(foot(1, G + 0.02), foot(1, zWin0), v.color);
      prism(foot(1, zWin0), foot(1, zWin1), [30, 34, 40]);
      prism(foot(1, zWin1), top, v.color);
      fill(foot(0.94, zTop + 0.01), shade([226, 224, 218], [0, 0, 1]));
      if (px > 4) {
        prism(foot(0.55, zTop, hl * 0.25, -hl * 0.35), foot(0.55, zTop + 0.32, hl * 0.25, -hl * 0.35), [200, 200, 196]); // AC pod
        // windscreen + destination band at the front, doors as dark slots on the camera side
        fill([pt(hl, hw * 0.88, zWin0 - 0.25), pt(hl, -hw * 0.88, zWin0 - 0.25), pt(hl, -hw * 0.88, zTop - 0.12), pt(hl, hw * 0.88, zTop - 0.12)], glass, 0.9);
        fill([pt(hl + 0.01, hw * 0.7, zTop - 0.32), pt(hl + 0.01, -hw * 0.7, zTop - 0.32), pt(hl + 0.01, -hw * 0.7, zTop - 0.12), pt(hl + 0.01, hw * 0.7, zTop - 0.12)], "rgb(255,176,48)", 0.95);
        for (const side of [1, -1]) {
          const a = pt(hl, side * hw, 0), b = pt(-hl, side * hw, 0);
          if (side === 1 ? !facing(pt(-hl, hw, 0), pt(hl, hw, 0)) : !facing(pt(hl, -hw, 0), pt(-hl, -hw, 0))) continue;
          void a; void b;
          for (const at of v.len > 15 ? [hl * 0.78, hl * 0.25, -hl * 0.3, -hl * 0.78] : [hl * 0.78, -hl * 0.05, -hl * 0.72])
            fill([pt(at + 0.6, side * (hw + 0.01), z0), pt(at - 0.6, side * (hw + 0.01), z0), pt(at - 0.6, side * (hw + 0.01), zWin1), pt(at + 0.6, side * (hw + 0.01), zWin1)], "rgb(24,26,30)", 0.85);
        }
        if (v.len > 15) fill([pt(0.4, hw + 0.02, G), pt(-0.4, hw + 0.02, G), pt(-0.4, hw + 0.02, zTop), pt(0.4, hw + 0.02, zTop)], "rgb(20,20,22)", 0.8); // articulation
      }
      void bot;
      return;
    }

    // cars, taxis, vans: lofted 3D models (vehicle-mesh.ts)
    if (px >= 2.2) {
      const view: Vec3 = [this.camFwd[0] * Math.SQRT1_2, this.camFwd[1] * Math.SQRT1_2, -Math.SQRT1_2];
      drawCar(ctx, scr, c, d, kind ?? "car", v.len, v.wid, v.hei, v.color, view, SUN, px, kind === "taxi");
      return;
    }
    // far away: one lit block with a darker cabin
    const van = kind === "van";
    const zSill = G + 0.28, zBelt = G + v.hei * (van ? 0.45 : 0.55), zRoof = G + v.hei;
    const nose = hl, tail = -hl;
    const cabF = van ? hl * 0.55 : hl * 0.32, cabR = van ? tail + 0.15 : -hl * 0.55;
    const lower = foot(1, zSill), belt = foot(1, zBelt);
    const roofP = foot(0.84, zRoof, cabF - (van ? 0.15 : 0.45), cabR + (van ? 0.05 : 0.35));
    const glassBot = foot(0.92, zBelt, cabF, cabR);
    outline([...foot(1, G), ...belt, ...roofP]);
    if (px < 3) { // far: one lit block, cabin as a darker top
      prism(foot(1, G + 0.05), belt, v.color);
      prism(glassBot, roofP, [52, 62, 72]);
      fill(roofP, shade(v.color, [0, 0, 1]));
      return;
    }
    prism(foot(1, G + 0.05), lower, [34, 34, 36]);           // sills / bumpers
    prism(lower, belt, v.color);                              // body
    // glasshouse: tinted glass sides, then roof in body colour
    for (let i = 0; i < glassBot.length; i++) {
      const a = glassBot[i], b = glassBot[(i + 1) % glassBot.length];
      if (!facing(a, b)) continue;
      fill([a, b, roofP[(i + 1) % roofP.length], roofP[i]], glass, 0.95);
    }
    fill(roofP, shade(v.color, [0, 0, 1]));
    // highlight streak on the windscreen + bonnet line
    ctx.globalAlpha = 0.35; ctx.strokeStyle = "#ffffff"; ctx.lineWidth = Math.max(0.6, px * 0.05);
    ctx.beginPath(); { const [x1, y1] = scr(pt(cabF, hw * 0.5, zBelt + 0.15)), [x2, y2] = scr(pt(cabF - 0.3, -hw * 0.2, zRoof - 0.1)); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); } ctx.stroke();
    ctx.globalAlpha = 1;
    // lamps
    fill([pt(nose + 0.01, hw * 0.75, zBelt - 0.25), pt(nose + 0.01, hw * 0.35, zBelt - 0.25), pt(nose + 0.01, hw * 0.35, zBelt - 0.08), pt(nose + 0.01, hw * 0.75, zBelt - 0.08)], "rgb(250,246,226)", 0.95);
    fill([pt(nose + 0.01, -hw * 0.75, zBelt - 0.25), pt(nose + 0.01, -hw * 0.35, zBelt - 0.25), pt(nose + 0.01, -hw * 0.35, zBelt - 0.08), pt(nose + 0.01, -hw * 0.75, zBelt - 0.08)], "rgb(250,246,226)", 0.95);
    fill([pt(tail - 0.01, hw * 0.8, zBelt - 0.22), pt(tail - 0.01, hw * 0.45, zBelt - 0.22), pt(tail - 0.01, hw * 0.45, zBelt - 0.06), pt(tail - 0.01, hw * 0.8, zBelt - 0.06)], "rgb(200,30,30)", 0.9);
    fill([pt(tail - 0.01, -hw * 0.8, zBelt - 0.22), pt(tail - 0.01, -hw * 0.45, zBelt - 0.22), pt(tail - 0.01, -hw * 0.45, zBelt - 0.06), pt(tail - 0.01, -hw * 0.8, zBelt - 0.06)], "rgb(200,30,30)", 0.9);
    if (kind === "taxi") { // Rome taxi: white with the roof sign
      prism(foot(0.25, zRoof, 0.35, -0.35), foot(0.25, zRoof + 0.22, 0.35, -0.35), [250, 246, 230]);
    }
  }

  /** dark tyres peeking out under the body on the camera side */
  private wheels(ctx: CanvasRenderingContext2D, scr: (p: Vec3) => [number, number], pt: (a: number, b: number, z: number) => Vec3, v: Vehicle, px: number, along: number, hw: number) {
    if (px < 3) return;
    const radius = v.bus ? 0.5 : 0.32;
    for (const a of v.len > 15 ? [along, 0, -along] : [along, -along]) {
      const side = hw; // signed: the camera-facing side
      const c = pt(a, side * 1.01, radius), [x, y] = scr(c), [x2, y2] = scr(pt(a + radius, side * 1.01, radius));
      const rad = Math.max(1, Math.hypot(x2 - x, y2 - y));
      ctx.globalAlpha = 0.95; ctx.fillStyle = "#18191c";
      ctx.beginPath(); ctx.ellipse(x, y, rad, rad * 0.75, Math.atan2(y2 - y, x2 - x), 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 1;
    }
  }
}

function mulberry(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
