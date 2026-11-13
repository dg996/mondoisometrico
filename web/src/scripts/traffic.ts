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
  x?: number[];     // OSM marked crossings: [distance from start, half length of the zebra band] …
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
  /** out of the drawn graph, waiting for a free entry (not drawn, not in any lane) */
  off?: boolean;
  /** lateral offset it had on the previous way: eased into the new lane over the first metres */
  lat0?: number;
  /** sim time it (re)appeared on the map: fades in instead of popping up */
  born?: number;
  /** drawn heading, eased toward the road's so the body turns smoothly through bends and junctions */
  hd?: [number, number];
  /** sim time of the last heading update */
  hdT?: number;
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
/** lane width (m): lanes are laid out from the centre line, so wide roads keep traffic off the kerb */
const LANE_W = 3.4;
const INFER_LANES = true;
/** fade-in after (re)appearing (s) and fade-out over the last metres before leaving the drawn graph */
const FADE_IN = 0.7, FADE_OUT_M = 5;

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
  /** node -> junction cluster id: nodes of one real crossing (Piazza Venezia has dozens) share one box */
  private grp = new Map<number, number>();
  /** clusters that contain a real junction (degree > 2): entering them needs a green */
  private ctl = new Set<number>();
  /** `${way}:${dir}:in|out` -> distance from the node where this carriageway stops overlapping the
   *  others meeting it at a narrow angle (merges / splits): the stop line and the box edge there */
  private mergeR = new Map<string, number>();
  /** "w:dir:in|out" -> distance from the node to beyond the zebra crossing next to that junction */
  private zebraR = new Map<string, number>();
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
    roads = withoutOverlaid(roads);
    for (const r of roads) {
      const n = r.s.length / 4;
      if (n < 2 || !Number.isInteger(n) || r.s.some((v) => !Number.isFinite(v))) continue;
      const cum = new Float32Array(n);
      for (let i = 1; i < n; i++)
        cum[i] = cum[i - 1] + Math.hypot(r.s[i * 4] - r.s[i * 4 - 4], r.s[i * 4 + 1] - r.s[i * 4 - 3]);
      const ww = r.w ?? Math.max(4, r.l * (r.o ? 3.2 : 6.4));
      // OSM often has no lanes tag on wide Roman avenues: one lane each way on a 20 m road sends
      // everything into one file along the kerb. Infer the lanes the drawn asphalt holds.
      if (INFER_LANES && r.c <= 3) r.l = Math.max(1, r.l, Math.min(2, Math.floor((r.o ? ww : ww / 2) / LANE_W)));
      const w = this.ways.push({ r, n, cum, len: cum[n - 1], w: ww }) - 1;
      const R = Math.min(16, (r.w ?? 6) / 2 + 1.5);
      for (const n of [r.a, r.b]) {
        this.nodeR.set(n, Math.max(this.nodeR.get(n) ?? 0, R));
        this.degree.set(n, (this.degree.get(n) ?? 0) + 1);
      }
      if (r.o >= 0) this.link(r.a, { w, dir: 1 });
      if (r.o <= 0) this.link(r.b, { w, dir: -1 });
    }
    for (const [n, d] of this.degree) if (d <= 2) this.nodeR.set(n, 0); // not a junction: no box, no stop line
    this.clusterJunctions();
    this.mergeLines();
    this.zebraLines();
    // "not too many": ~1 vehicle per 55 weighted metres (only on-screen ones are drawn)
    const weights = this.ways.map((w) => w.len * CLASS_WEIGHT[w.r.c]);
    const total = weights.reduce((a, b) => a + b, 0);
    if (!Number.isFinite(total) || total <= 0) return;
    const count = Math.round(Math.min(5000, Math.max(80, (total / 55) * density)));
    this.regroup();
    // centres of the vehicles placed so far (20 m cells): no spawn on top of one on another way
    const placed = new Map<string, Array<[number, number, number]>>();
    const near = (x: number, y: number, len: number) => {
      const cx = Math.floor(x / 20), cy = Math.floor(y / 20);
      for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++)
        for (const [px, py, pl] of placed.get(`${cx + a}_${cy + b}`) ?? []) if (Math.hypot(px - x, py - y) < (pl + len) / 2 + 2 * GAP) return true;
      return false;
    };
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
      // not inside the junction boxes / merge zones at either end
      const endNode = dir === 1 ? way.r.b : way.r.a, startNode = dir === 1 ? way.r.a : way.r.b;
      const lo = len / 2 + Math.max(this.nodeR.get(startNode) ?? 0, this.mergeR.get(`${w}:${dir}:out`) ?? 0, this.zebraR.get(`${w}:${dir}:out`) ?? 0);
      const hi = way.len - len / 2 - Math.max(this.nodeR.get(endNode) ?? 0, this.mergeR.get(`${w}:${dir}:in`) ?? 0, this.zebraR.get(`${w}:${dir}:in`) ?? 0) - 1;
      if (hi <= lo) continue;
      const s = lo + this.rand() * (hi - lo);
      if (this.onZebra(w, dir, s, len)) continue; // nobody parks on the stripes
      if (!this.sampleVisible(way, s, dir, len)) continue; // exact spawn point must be on visible asphalt
      const lane = bus ? 0 : Math.floor(this.rand() * way.r.l);
      // never spawn on top of another vehicle
      const group = this.lanes.get(`${w}:${dir}:${lane}`) ?? [];
      if (group.some((o) => Math.abs(o.s - s) < (o.len + len) / 2 + GAP)) continue;
      const [px, py] = this.pointAt(w, dir, s);
      if (near(px, py, len)) continue;
      { const k = `${Math.floor(px / 20)}_${Math.floor(py / 20)}`; (placed.get(k) ?? placed.set(k, []).get(k)!).push([px, py, len]); }
      const v: Vehicle = {
        id: i++, w, dir, s, lane, bus, len, stuck: 0, through: false, holding: -1, next: null, line: -1,
        cruise: 0.8 + this.rand() * 0.35, phase: this.rand() * Math.PI * 2, v: 0,
        wid: bus ? 2.55 : type.wid, hei: bus ? 3.1 : type.hei, kind: bus ? undefined : type.kind,
        color: bus ? ATAC_COLORS[Math.floor(this.rand() * ATAC_COLORS.length)]
          : type.kind === "taxi" || type.kind === "van" ? [238, 238, 236] : CAR_COLORS[Math.floor(this.rand() * CAR_COLORS.length)],
      };
      v.v = this.limit(v) * 0.8;
      v.born = -FADE_IN; // already there when the map opens
      this.vehicles.push(v);
      group.push(v);
      this.lanes.set(`${w}:${dir}:${lane}`, group);
    }
    if (lines.length) { this.spawnLines(lines); this.regroup(); }
    // settle for up to 40 simulated seconds: spawned vehicles sort out queues and junctions before the
    // first frame, so nobody sees the initial placement shuffle
    // (at most ~300 ms of main thread, however big the painted city gets)
    const t0 = Date.now();
    for (let i = 0; i < 400 && Date.now() - t0 < 300; i++) this.step(0.1);
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
  private placeOnLine(g: number, f: number, existing?: Vehicle, step = 0.137) {
    const guide = this.guides[g], n = guide.xy.length / 2;
    for (let tries = 0, max = step < 0.1 ? Math.ceil(1 / step) : 30; tries < max; tries++) {
      const at = Math.min(n - 2, Math.floor(((f + tries * step) % 1) * (n - 1)));
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
      if (!this.spotFree(pick.w, pick.dir, s, len, existing)) continue;
      if (existing) {
        this.release(existing);
        Object.assign(existing, { w: pick.w, dir: pick.dir, s, lane, v: 0, next: null, stuck: 0, through: false, off: false, lat0: undefined });
        this.insertLane(existing); // later moves in this same step must see it
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

  /** A line bus that left the drawn graph comes back where its route first enters it (the edge of
   *  the painted area, like the next bus of the line arriving), never popping up mid-route. */
  private reenterLine(v: Vehicle) {
    this.release(v);
    v.off = !this.placeOnLine(v.line, 0, v, 0.01) && !this.placeOnLine(v.line, this.rand(), v);
    v.born = this.t; v.hd = undefined; v.lat0 = undefined; // put back on its line: fades in there
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

  /** ENU point at distance `dist` along a way in travel direction `dir` (lane offset ignored). */
  private pointAt(w: number, dir: 1 | -1, dist: number): [number, number] {
    const way = this.ways[w], S = way.r.s, s = Math.max(0, Math.min(way.len, dir === 1 ? dist : way.len - dist));
    let i = 1;
    while (i < way.n - 1 && way.cum[i] < s) i++;
    const f = (s - way.cum[i - 1]) / Math.max(1e-3, way.cum[i] - way.cum[i - 1]);
    return [S[i * 4 - 4] + (S[i * 4] - S[i * 4 - 4]) * f, S[i * 4 - 3] + (S[i * 4 + 1] - S[i * 4 - 3]) * f];
  }

  /** No other vehicle, on any way, within reach of a body of length `len` centred there (placing
   *  a vehicle must not drop it onto one queued just across a node). */
  private spotFree(w: number, dir: 1 | -1, s: number, len: number, self?: Vehicle) {
    const [x, y] = this.pointAt(w, dir, s), u = this.ways[w].r.s[2];
    for (const o of this.vehicles) {
      if (o === self || o.off) continue;
      const [ox, oy] = this.pointAt(o.w, o.dir, o.s);
      if (Math.hypot(ox - x, oy - y) < (o.len + len) / 2 + 2 * GAP && Math.abs(this.ways[o.w].r.s[2] - u) < 6) return false;
    }
    return true;
  }

  /** Put a moved vehicle into its new lane list now (lists are rebuilt only once per step). */
  private insertLane(v: Vehicle) {
    const k = `${v.w}:${v.dir}:${v.lane}`, g = this.lanes.get(k) ?? this.lanes.set(k, []).get(k)!;
    if (!g.includes(v)) { g.push(v); g.sort((a, b) => a.s - b.s); }
  }

  private regroup() {
    this.lanes.clear();
    for (const v of this.vehicles) {
      if (v.off) continue;
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
        // the worst distance to the route over the first 80 m: a way that starts on the route and
        // then bends away from it is not the line's way
        const way = this.ways[o.w];
        let d = 0;
        for (let at = Math.min(10, way.len); at <= Math.min(80, way.len); at += 10) {
          const [x, y] = this.pointAt(o.w, o.dir, at);
          d = Math.max(d, this.nearest(g, x, y).d);
          if (d >= bd) break;
        }
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
    const clear = Math.max(this.nodeR.get(this.endNode(v)) ?? 4, this.zebraR.get(`${next.w}:${next.dir}:out`) ?? 0);
    return !g?.length || g[0].s - g[0].len / 2 > clear + v.len + GAP;
  }

  /**
   * Distance from the front to the next zebra band on this way that the vehicle must not enter yet
   * (the queue ahead leaves no room beyond it), or null. Bands the front already reached are ignored:
   * a vehicle that has started over the stripes drives on.
   */
  private zebraAhead(v: Vehicle, lead: Vehicle | undefined): number | null {
    const way = this.ways[v.w];
    if (!way.r.x?.length) return null;
    const front = v.s + v.len / 2;
    for (const [a, b] of this.zebras(v.w, v.dir)) {
      if (a < front - 0.05) continue;
      if (a - front > 40) return null;
      if (way.len - b < Math.max(this.nodeR.get(this.endNode(v)) ?? 0, this.zebraR.get(`${v.w}:${v.dir}:in`) ?? 0)) return null; // the stop line handles it
      let rear = Infinity, speed = 0;
      if (lead) { rear = lead.s - lead.len / 2; speed = lead.v; }
      else if (v.next) {
        // a short link into a junction: its stop line may be only metres past the stripes, and
        // without a green the vehicle would have to wait on them
        const nw = this.ways[v.next.w], nend = v.next.dir === 1 ? nw.r.b : nw.r.a;
        if (this.controlled(nend) && v.holding !== this.groupOf(nend)) {
          const zone = Math.max(this.nodeR.get(nend) ?? 4, this.mergeR.get(`${v.next.w}:${v.next.dir}:in`) ?? 0, this.zebraR.get(`${v.next.w}:${v.next.dir}:in`) ?? 0);
          rear = way.len + Math.max(0, nw.len - zone);
        }
        const nl = v.bus ? 0 : Math.min(v.lane, nw.r.l - 1), first = this.lanes.get(`${v.next.w}:${v.next.dir}:${nl}`)?.[0];
        if (first && way.len + first.s - first.len / 2 < rear) { rear = way.len + first.s - first.len / 2; speed = first.v; }
      }
      // room for the whole body past the stripes, counting a little on a leader that is moving away
      if (rear + Math.min(speed, 6) * 0.8 - b < v.len + GAP) return a - front;
      return null;
    }
    return null;
  }

  /** Distance from the vehicle's front to the stop line before the junction box ahead. */
  private toStop(v: Vehicle) {
    return this.ways[v.w].len - v.s - v.len / 2 - Math.max(this.nodeR.get(this.endNode(v)) ?? 4, this.mergeR.get(`${v.w}:${v.dir}:in`) ?? 0, this.zebraR.get(`${v.w}:${v.dir}:in`) ?? 0);
  }

  /** Zebra bands of way w in travel order for dir: [start, end] along the vehicle's s. */
  private zebras(w: number, dir: 1 | -1): Array<[number, number]> {
    const way = this.ways[w], x = way.r.x ?? [], out: Array<[number, number]> = [];
    for (let i = 0; i < x.length; i += 2) {
      const d = dir === 1 ? x[i] : way.len - x[i];
      out.push([d - x[i + 1], d + x[i + 1]]);
    }
    return dir === 1 ? out : out.reverse();
  }

  /** A body centred at s overlaps a zebra band of way w. */
  private onZebra(w: number, dir: 1 | -1, s: number, len: number) {
    return this.zebras(w, dir).some(([a, b]) => s + len / 2 > a - 0.3 && s - len / 2 < b + 0.3);
  }

  /**
   * Zebra crossings at a junction (within its box or just past it): the stop line moves back to
   * before the stripes, a vehicle only crosses the box when there is room beyond the stripes on the
   * other side, and it holds the junction until its rear has cleared them.
   */
  private zebraLines() {
    this.ways.forEach((way, w) => {
      for (const dir of [1, -1] as const) {
        if ((dir === 1 && way.r.o === -1) || (dir === -1 && way.r.o === 1)) continue;
        const end = dir === 1 ? way.r.b : way.r.a, start = dir === 1 ? way.r.a : way.r.b;
        const bands = this.zebras(w, dir);
        if (!bands.length) continue;
        const rIn = this.nodeR.get(end) ?? 0, rOut = this.nodeR.get(start) ?? 0;
        if (rIn > 0) {
          let d = 0; // from the node back to before the farthest band near it
          for (const [a] of bands) if (way.len - a > d && way.len - a <= Math.max(rIn, this.mergeR.get(`${w}:${dir}:in`) ?? 0) + 12) d = way.len - a;
          for (const [a, b] of bands) if (way.len - b < d && way.len - a > d) d = way.len - a; // bands overlapping the zone
          if (d > 0 && d < way.len - 4) this.zebraR.set(`${w}:${dir}:in`, d + 0.8);
        }
        if (rOut > 0) {
          let d = 0;
          for (const [, b] of bands) if (b > d && b <= Math.max(rOut, this.mergeR.get(`${w}:${dir}:out`) ?? 0) + 12) d = b;
          if (d > 0 && d < way.len - 4) this.zebraR.set(`${w}:${dir}:out`, d + 0.8);
        }
      }
    });
  }

  /**
   * Two carriageways meeting at a narrow angle overlap well before the node: their edges touch at
   * d = (w1 + w2) / 2 / (2 sin(θ / 2)) from it. Stop lines (and the end of the box for leaving
   * vehicles) move back to there, so a car waiting on one approach never stands inside another.
   */
  private mergeLines() {
    const ends = new Map<number, Array<{ k: string; d: [number, number]; w: number }>>();
    this.ways.forEach((way, w) => {
      if (way.len < 4) return;
      const L = Math.min(8, way.len);
      for (const dir of [1, -1] as const) {
        if ((dir === 1 && way.r.o === -1) || (dir === -1 && way.r.o === 1)) continue;
        const end = dir === 1 ? way.r.b : way.r.a, start = dir === 1 ? way.r.a : way.r.b;
        const [ax, ay] = this.pointAt(w, dir, way.len - L), [bx, by] = this.pointAt(w, dir, way.len);
        const [cx, cy] = this.pointAt(w, dir, 0), [ex, ey] = this.pointAt(w, dir, L);
        const n1 = Math.hypot(bx - ax, by - ay) || 1, n2 = Math.hypot(ex - cx, ey - cy) || 1;
        // arriving: direction into the node; leaving: direction out of it, reversed (also points at the node)
        (ends.get(end) ?? ends.set(end, []).get(end)!).push({ k: `${w}:${dir}:in`, d: [(bx - ax) / n1, (by - ay) / n1], w: way.w });
        (ends.get(start) ?? ends.set(start, []).get(start)!).push({ k: `${w}:${dir}:out`, d: [(cx - ex) / n2, (cy - ey) / n2], w: way.w });
      }
    });
    for (const list of ends.values()) for (const a of list) for (const b of list) {
      if (a === b || a.k.split(":")[0] === b.k.split(":")[0] || a.k.slice(-3) !== b.k.slice(-3)) continue;
      const cos = a.d[0] * b.d[0] + a.d[1] * b.d[1];
      if (cos < Math.cos((70 * Math.PI) / 180)) continue; // wide angle: the junction box covers it
      const half = Math.acos(Math.min(1, cos)) / 2, d = Math.min(30, (a.w + b.w) / 2 / (2 * Math.max(0.05, Math.sin(half))));
      this.mergeR.set(a.k, Math.max(this.mergeR.get(a.k) ?? 0, d));
    }
  }

  private isJunction(node: number) { return (this.degree.get(node) ?? 0) > 2; }
  private groupOf(node: number) { return this.grp.get(node) ?? node; }
  /** the end of the way lies in a controlled crossing (a junction or a node joined to one) */
  private controlled(node: number) { return this.ctl.has(this.groupOf(node)); }

  /**
   * Junction nodes whose boxes touch (closer than both radii + 8 m) form one crossing, and short
   * links' plain nodes near a junction join it: one green for the whole crossing, so vehicles from
   * two "different" junctions of the same square never meet inside it.
   */
  private clusterJunctions() {
    const pos = new Map<number, [number, number]>();
    for (const w of this.ways) {
      const S = w.r.s, k = (w.n - 1) * 4;
      pos.set(w.r.a, [S[0], S[1]]); pos.set(w.r.b, [S[k], S[k + 1]]);
    }
    const parent = new Map<number, number>();
    const find = (a: number): number => { let r = a; while (parent.has(r) && parent.get(r) !== r) r = parent.get(r)!; parent.set(a, r); return r; };
    const unite = (a: number, b: number) => { const x = find(a), y = find(b); if (x !== y) parent.set(Math.max(x, y), Math.min(x, y)); };
    const CELL = 40, grid = new Map<string, number[]>();
    for (const [n, [x, y]] of pos) { const c = `${Math.floor(x / CELL)}_${Math.floor(y / CELL)}`; (grid.get(c) ?? grid.set(c, []).get(c)!).push(n); }
    for (const [n, [x, y]] of pos) {
      if (!this.isJunction(n)) continue;
      const cx = Math.floor(x / CELL), cy = Math.floor(y / CELL);
      for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (const m of grid.get(`${cx + i}_${cy + j}`) ?? []) {
        if (m === n) continue;
        const [mx, my] = pos.get(m)!, d = Math.hypot(mx - x, my - y);
        if (d < Math.min(36, (this.nodeR.get(n) ?? 0) + (this.nodeR.get(m) ?? 0) + 8)) unite(n, m);
      }
    }
    for (const n of pos.keys()) {
      const g = find(n);
      if (g !== n) this.grp.set(n, g);
      if (this.isJunction(n)) this.ctl.add(g);
    }
  }

  /**
   * May the vehicle enter the junction ahead now? Vehicles from the same approach go together
   * (a green phase, at most 12 s while others wait); other approaches wait until the box is empty.
   */
  private grant(v: Vehicle) {
    if (!v.next || !this.entryClear(v, v.next)) return false;
    const node = this.groupOf(this.endNode(v));
    if (!this.ctl.has(node) || v.holding === node) { v.through = true; return true; } // plain node, or already inside this crossing
    let hold = this.nodeHold.get(node);
    if (hold && hold.inside <= 0 && this.t - hold.last > 0.8) { this.nodeHold.delete(node); hold = undefined; }
    if (hold && this.t - hold.last > 10) { this.nodeHold.delete(node); hold = undefined; } // lost vehicle: reset
    if (hold && (hold.way !== v.w || this.t - hold.start > 12)) return false;
    if (!hold) { hold = { way: v.w, inside: 0, start: this.t, last: this.t }; this.nodeHold.set(node, hold); }
    if (v.holding >= 0 && v.holding !== node) this.release(v); // straight from one crossing into the next
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

  /** Vehicles whose nose (1 m ahead of the front) would touch another body: a hairpin, two exits
   *  diverging, a crossing the lane logic does not see. Checked only near way ends (cheap). */
  private blockedAhead() {
    const CELL = 20, grid = new Map<string, Array<{ v: Vehicle; a: [number, number]; b: [number, number] }>>();
    for (const v of this.vehicles) {
      if (v.off) continue;
      // rear and front where the body is drawn: on its lane, not on the way's centre line
      const a0 = this.pointAt(v.w, v.dir, v.s - v.len / 2), b0 = this.pointAt(v.w, v.dir, v.s + v.len / 2);
      const L0 = Math.hypot(b0[0] - a0[0], b0[1] - a0[1]) || 1, off = this.offset(this.ways[v.w], v);
      const nx = ((b0[1] - a0[1]) / L0) * off, ny = (-(b0[0] - a0[0]) / L0) * off;
      const a: [number, number] = [a0[0] + nx, a0[1] + ny], b: [number, number] = [b0[0] + nx, b0[1] + ny];
      const k = `${Math.floor((a[0] + b[0]) / 2 / CELL)}_${Math.floor((a[1] + b[1]) / 2 / CELL)}`;
      (grid.get(k) ?? grid.set(k, []).get(k)!).push({ v, a, b });
    }
    const out = new Set<Vehicle>();
    for (const [k, list] of grid) {
      const [cx, cy] = k.split("_").map(Number);
      for (const me of list) {
        const v = me.v;
        if (this.ways[v.w].len - (v.s + v.len / 2) > 20 && v.s - v.len / 2 > 20) continue; // mid-way: lanes handle it
        const dx = me.b[0] - me.a[0], dy = me.b[1] - me.a[1], L = Math.hypot(dx, dy) || 1, ux = dx / L, uy = dy / L;
        // nose and both front corners, a little ahead: a merge brings bodies together corner first
        const hw = v.wid / 2 + 0.25, probes: Array<[number, number, number]> = [
          [me.b[0] + ux * 1.2, me.b[1] + uy * 1.2, v.wid / 2],
          [me.b[0] + ux * 0.6 + uy * hw, me.b[1] + uy * 0.6 - ux * hw, 0],
          [me.b[0] + ux * 0.6 - uy * hw, me.b[1] + uy * 0.6 + ux * hw, 0],
        ];
        for (let i = -1; i <= 1 && !out.has(v); i++) for (let j = -1; j <= 1; j++) for (const o of grid.get(`${cx + i}_${cy + j}`) ?? []) {
          if (o.v === v || Math.abs(this.ways[o.v.w].r.s[2] - this.ways[v.w].r.s[2]) > 6) continue;
          const ox = o.b[0] - o.a[0], oy = o.b[1] - o.a[1], OL = Math.hypot(ox, oy) || 1;
          if ((ox * dx + oy * dy) / (OL * L) < -0.5) continue; // oncoming: passes alongside
          // the other body must be ahead of me, and my nose within reach of it
          const mx = (o.a[0] + o.b[0]) / 2 - (me.a[0] + me.b[0]) / 2, my = (o.a[1] + o.b[1]) / 2 - (me.a[1] + me.b[1]) / 2;
          if (mx * dx + my * dy <= 0) continue;
          let hit = false;
          for (const [fx, fy, r] of probes) {
            const t = Math.max(0, Math.min(1, ((fx - o.a[0]) * ox + (fy - o.a[1]) * oy) / (OL * OL)));
            if (Math.hypot(fx - o.a[0] - ox * t, fy - o.a[1] - oy * t) < r + o.v.wid / 2 + 0.3) { hit = true; break; }
          }
          if (hit) { out.add(v); break; }
        }
      }
    }
    return out;
  }

  step(dt: number) {
    dt = Math.min(dt, 0.1);
    this.t += dt;
    this.regroup();
    const blocked = this.blockedAhead();
    for (const g of this.lanes.values()) {
      for (let k = 0; k < g.length; k++) {
        const v = g[k], way = this.ways[v.w];
        if (v.next === null) v.next = this.chooseNext(v);
        let target = this.limit(v);
        if (v.stuck > 55) { if (v.line >= 0) this.reenterLine(v); else this.respawn(v); continue; } // gridlock escape
        // car following: stay a safe gap behind the vehicle ahead in this lane
        const lead = g[k + 1];
        if (lead) {
          const gap = lead.s - lead.len / 2 - (v.s + v.len / 2) - GAP;
          target = Math.min(target, Math.max(0, gap / HEADWAY), lead.v + Math.max(0, gap) * 0.5);
        } else if (v.next) {
          // last in its lane: follow the last vehicle already on the next way (no lane change there)
          const nl = v.bus ? 0 : Math.min(v.lane, this.ways[v.next.w].r.l - 1), first = this.lanes.get(`${v.next.w}:${v.next.dir}:${nl}`)?.[0];
          if (first) {
            const path = way.len - (v.s + v.len / 2) + first.s - first.len / 2 - GAP - 0.25 * Math.max(v.len, first.len); // ways meet at an angle: straight bodies need room
            // and through a hairpin the two bodies end up side by side: keep a straight-line gap too
            const [fx, fy] = this.pointAt(v.w, v.dir, v.s + v.len / 2), [rx, ry] = this.pointAt(first.w, first.dir, first.s - first.len / 2);
            const gap = Math.min(path, Math.hypot(fx - rx, fy - ry) - GAP - (v.wid + first.wid) / 2);
            target = Math.min(target, Math.max(0, gap / HEADWAY), first.v + Math.max(0, gap) * 0.5);
            if (gap < 0.3) target = 0;
          }
          // a fork: the vehicle ahead may have just taken the other branch; until its rear is out of
          // the split (where the two carriageways still overlap) it is still in our way
          for (const o of this.out.get(this.endNode(v)) ?? []) {
            if (o.w === v.next.w || o.w === v.w) continue;
            const split = this.mergeR.get(`${o.w}:${o.dir}:out`);
            if (!split) continue;
            for (let ln = 0; ln < Math.max(1, this.ways[o.w].r.l); ln++) {
              const f = this.lanes.get(`${o.w}:${o.dir}:${ln}`)?.[0];
              if (!f || f.s - f.len / 2 > split) continue;
              const gap = way.len - (v.s + v.len / 2) + f.s - f.len / 2 - GAP;
              target = Math.min(target, Math.max(0, gap / HEADWAY), f.v + Math.max(0, gap) * 0.5);
            }
          }
        }
        // never stop on the stripes: enter a zebra crossing only when there is room past it
        const zebra = this.zebraAhead(v, g[k + 1]);
        if (zebra !== null) target = Math.min(target, Math.max(0, zebra - 0.3) / HEADWAY);
        // approaching the junction: slow for the turn; at the stop line wait until it's granted
        const toStop = this.toStop(v);
        if (!v.through && v.next && toStop < 30) {
          const ctl = this.controlled(this.endNode(v)) && v.holding !== this.groupOf(this.endNode(v));
          const go = (toStop < 2 || !ctl) && this.grant(v);
          if (!go) target = Math.min(target, Math.max(0, toStop - 0.3) / HEADWAY);
          if (!go && toStop < 2 && v.v < 0.5) v.stuck += dt; else if (go) v.stuck = 0;
          if (way.r.c >= 2 && this.isJunction(this.endNode(v))) target = Math.min(target, 5 + Math.max(0, toStop) * 0.3);
        } else if (v.through && way.r.c >= 2 && this.isJunction(this.endNode(v))) target = Math.min(target, 7);
        if (blocked.has(v)) { target = 0; if (v.v < 0.5) v.stuck += dt; } // two noses in each other's way: the escape below sorts it out
        // left the crossing behind (this way leads out of it and the rear has cleared the box): release it
        if (v.holding >= 0) {
          const start = v.dir === 1 ? way.r.a : way.r.b;
          const clear = Math.max(this.nodeR.get(start) ?? 0, this.mergeR.get(`${v.w}:${v.dir}:out`) ?? 0, this.zebraR.get(`${v.w}:${v.dir}:out`) ?? 0);
          if (this.groupOf(this.endNode(v)) !== v.holding && (this.groupOf(start) !== v.holding || v.s - v.len / 2 > clear)) this.release(v);
          else { const h = this.nodeHold.get(v.holding); if (h) h.last = this.t; } // still inside: keep the crossing held
        }
        // accelerate gently, brake firmly; never overrun the stop point
        v.v = target > v.v ? Math.min(target, v.v + ACCEL * dt) : Math.max(target, v.v - BRAKE * dt);
        if (lead) v.v = Math.min(v.v, Math.max(0, (lead.s - lead.len / 2 - (v.s + v.len / 2) - 0.5) / dt));
        const before = this.toStop(v);
        if (zebra !== null) v.v = Math.min(v.v, Math.max(0, zebra) / dt); // and never roll onto them
        v.v = Math.max(0, v.v);
        v.s += v.v * dt;
        // without a green, never roll past the stop line into a crossing (fast arrivals overshot it)
        if (!v.through && v.next && before >= -0.01 && this.toStop(v) < 0 && this.controlled(this.endNode(v)) && v.holding !== this.groupOf(this.endNode(v))) {
          v.s -= -this.toStop(v); v.v = 0;
        }
      }
    }
    // move vehicles that have driven past the end of their way onto the next one
    for (const v of this.vehicles) {
      if (v.off) { if (this.rand() < dt) { if (v.line >= 0) this.reenterLine(v); else this.respawn(v); } continue; } // about once a second
      let way = this.ways[v.w];
      if (v.s + v.len / 2 < way.len) continue;
      if (!v.next) { // dead end (or a line bus at the end of its drawn route)
        if (v.line >= 0) this.reenterLine(v);
        else this.respawn(v); // drove out of the drawn graph: comes back in at a free edge entry
        continue;
      }
      if (!v.through) { v.s = way.len - v.len / 2; v.v = 0; continue; } // not granted: hold at the end
      const over = v.s + v.len / 2 - way.len, nw = this.ways[v.next.w], lat = this.offset(way, v);
      const lane = v.bus ? 0 : Math.min(v.lane, nw.r.l - 1), ns = Math.min(nw.len - v.len / 2, v.len / 2 + over);
      // something was put at the start of that lane during this step: wait at the line instead
      if ((this.lanes.get(`${v.next.w}:${v.next.dir}:${lane}`) ?? []).some((o) => o !== v && Math.abs(o.s - ns) < (o.len + v.len) / 2 + 0.5)) {
        v.s = way.len - v.len / 2; v.v = 0; continue;
      }
      v.w = v.next.w; v.dir = v.next.dir; v.next = null; v.through = false; v.lat0 = lat;
      way = nw;
      v.lane = lane;
      v.s = ns;
      v.phase += 0.7;
      this.insertLane(v);
    }
  }

  /** Way starts at the edge of the drawn graph (painted-area cut, occlusion, dead end): where a
   *  vehicle can appear as if it had driven in from outside, never popping up mid-street. */
  private entries: Array<{ w: number; dir: 1 | -1 }> | null = null;

  /** Move a vehicle that drove out of the graph (dead end, cut) to a free entry at its edge. */
  private respawn(v: Vehicle) {
    this.release(v);
    if (!this.entries) {
      this.entries = [];
      this.ways.forEach((way, w) => {
        if (way.r.o >= 0 && (this.degree.get(way.r.a) ?? 0) === 1) this.entries!.push({ w, dir: 1 });
        if (way.r.o <= 0 && (this.degree.get(way.r.b) ?? 0) === 1) this.entries!.push({ w, dir: -1 });
      });
    }
    for (let tries = 0; tries < 60; tries++) {
      const edge = this.entries.length && tries < 40 ? this.entries[Math.floor(this.rand() * this.entries.length)] : null;
      const w = edge ? edge.w : Math.floor(this.rand() * this.ways.length), way = this.ways[w];
      const dir: 1 | -1 = edge ? edge.dir : way.r.o === -1 ? -1 : way.r.o === 1 ? 1 : this.rand() < 0.5 ? 1 : -1;
      const start = (this.nodeR.get(dir === 1 ? way.r.a : way.r.b) ?? 4) + v.len / 2;
      if (way.r.c > 3 || way.len < start + v.len + 30 || (v.bus && way.r.c > 2)) continue;
      if (this.wayVisible(way) < 0.55) continue; // no river / occluded respawns
      if (!this.sampleVisible(way, start, dir, v.len)) continue;
      const g = this.lanes.get(`${w}:${dir}:0`);
      if (g?.some((o) => Math.abs(o.s - start) < v.len + 2 * GAP + o.len)) continue;
      if (!this.spotFree(w, dir, start, v.len, v)) continue;
      Object.assign(v, { w, dir, lane: 0, s: start, v: 0, next: null, stuck: 0, through: false, off: false, lat0: undefined, born: this.t, hd: undefined });
      this.insertLane(v);
      return;
    }
    v.off = true; // no free entry now: wait out of sight and try again
  }

  /** Lateral offset (m, + = right of travel) of the lane centre, kept inside the drawn asphalt. */
  private offset(way: Way, v: Vehicle) {
    const r = way.r, half = way.w / 2;
    const lanes = Math.max(1, r.l);
    const lw = Math.min(LANE_W, r.o === 0 ? half / lanes : way.w / lanes);
    // lane 0 is the right-most (buses, slow traffic); lanes stack from the centre line outwards
    const o = r.o === 0 ? (lanes - 0.5 - v.lane) * lw : (lanes / 2 - 0.5 - v.lane) * lw;
    const lane = Math.max(-half + v.wid / 2 + 0.2, Math.min(half - v.wid / 2 - 0.2, o));
    // a new way's lane can sit 1–2 m aside from the last one: drift over, don't jump
    const into = v.s - v.len / 2;
    if (v.lat0 === undefined || into >= 10) return lane;
    const f = Math.max(0, into) / 10, e = f * f * (3 - 2 * f);
    return v.lat0 + (lane - v.lat0) * e;
  }

  /** Draw vehicles. `toScreen` maps global art px -> canvas px; `px` = canvas px per art px. */
  draw(ctx: CanvasRenderingContext2D, toScreen: (x: number, y: number) => [number, number], px: number, view: [number, number, number, number]) {
    this.drawn = 0;
    if (px < 0.28) return; // only when asphalt is clearly readable — no fleas on roofs at mid zoom
    const [vx0, vy0, vx1, vy1] = view;
    const M = this.enu2px;
    const proj = (p: Vec3): [number, number] =>
      toScreen(M[0][0] * p[0] + M[0][1] * p[1] + M[0][2] * p[2], M[1][0] * p[0] + M[1][1] * p[1] + M[1][2] * p[2]);
    const items: Array<{ v: Vehicle; c: Vec3; d: [number, number]; a: number; depth: number }> = [];
    for (const v of this.vehicles) {
      const way = this.ways[v.w], S = way.r.s;
      const at = (dist: number) => { // sample index at distance along the travel direction
        const s = Math.max(0, Math.min(way.len, v.dir === 1 ? dist : way.len - dist));
        let i = 1;
        while (i < way.n - 1 && way.cum[i] < s) i++;
        return { i, s };
      };
      if (v.off || (v.line >= 0 && !this.lineRuns(v.line))) continue; // night lines by night, day lines by day
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
      // Reject cars sitting in a river trough: well below the straight grade between the way's two
      // ends (a plain slope — most of Rome is on hills — is not a trough)
      const band = Math.max(1, Math.floor(way.n * 0.2));
      let z0 = -Infinity, z1 = -Infinity;
      for (let j = 0; j < band; j++) z0 = Math.max(z0, S[j * 4 + 2]);
      for (let j = way.n - band; j < way.n; j++) z1 = Math.max(z1, S[j * 4 + 2]);
      const grade = z0 + (z1 - z0) * (s / Math.max(1e-3, way.len));
      if (Number.isFinite(grade) && c[2] < grade - 2.2) continue;
      // fade in after appearing, fade out over the last metres before a dead end / painted-area cut
      const born = v.born === undefined ? 1 : (this.t - v.born) / FADE_IN;
      const leaving = v.next ? 1 : (way.len - (v.s + v.len / 2)) / FADE_OUT_M;
      const alpha = Math.max(0, Math.min(1, born, leaving));
      if (alpha < 0.02) continue;
      // the body turns smoothly: eased toward the road's direction (snaps only on a reversal)
      // time-based (≈0.15 s), so it behaves the same at any frame rate
      const k = 1 - Math.exp(-Math.max(0, this.t - (v.hdT ?? this.t)) / 0.15);
      v.hdT = this.t;
      if (v.hd && v.hd[0] * dx + v.hd[1] * dy > -0.2) {
        const hx = v.hd[0] + (dx - v.hd[0]) * k, hy = v.hd[1] + (dy - v.hd[1]) * k, hl = Math.hypot(hx, hy) || 1;
        v.hd = [hx / hl, hy / hl];
      } else v.hd = [dx, dy];
      const [sx, sy] = proj(c);
      if (sx < vx0 - 40 || sy < vy0 - 40 || sx > vx1 + 40 || sy > vy1 + 40) continue;
      items.push({ v, c, d: v.hd, a: alpha, depth: c[0] * this.camFwd[0] + c[1] * this.camFwd[1] });
    }
    items.sort((a, b) => b.depth - a.depth); // back to front
    this.drawn = items.length;
    for (const { v, c, d, a } of items) {
      this.fadeA = a;
      ctx.globalAlpha = a;
      this.box(ctx, proj, c, d, v);
      // line number on the roof once a bus is big enough to read
      if (v.line >= 0 && px >= 1.1) {
        const [sx, sy] = proj([c[0], c[1], c[2] + v.hei + 0.3]);
        const label = this.guides[v.line].line.n.toUpperCase();
        ctx.font = `700 ${Math.round(Math.min(14, 6 + px * 3))}px ui-sans-serif, system-ui, sans-serif`;
        ctx.textAlign = "center"; ctx.textBaseline = "middle";
        const w = ctx.measureText(label).width + 6;
        ctx.globalAlpha = 0.9 * a; ctx.fillStyle = "#1d1b19"; ctx.fillRect(sx - w / 2, sy - 8, w, 16);
        ctx.globalAlpha = a; ctx.fillStyle = "#ffd84d"; ctx.fillText(label, sx, sy);
      }
    }
    this.fadeA = 1;
    ctx.globalAlpha = 1;
  }

  /** opacity of the vehicle being drawn (fades); every fill multiplies by it */
  private fadeA = 1;

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
    const fa = this.fadeA;
    const fill = (pts: Vec3[], css: string, a = 1) => { ctx.globalAlpha = a * fa; ctx.fillStyle = css; path(pts); ctx.fill(); ctx.globalAlpha = fa; };
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
    ctx.globalAlpha = 0.35 * fa; ctx.strokeStyle = "#ffffff"; ctx.lineWidth = Math.max(0.6, px * 0.05);
    ctx.beginPath(); { const [x1, y1] = scr(pt(cabF, hw * 0.5, zBelt + 0.15)), [x2, y2] = scr(pt(cabF - 0.3, -hw * 0.2, zRoof - 0.1)); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); } ctx.stroke();
    ctx.globalAlpha = fa;
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
      ctx.globalAlpha = 0.95 * this.fadeA; ctx.fillStyle = "#18191c";
      ctx.beginPath(); ctx.ellipse(x, y, rad, rad * 0.75, Math.atan2(y2 - y, x2 - x), 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = this.fadeA;
    }
  }
}

/**
 * Minor roads (service, track) mapped inside a bigger road's drawn carriageway — a slip lane or a
 * parking aisle drawn alongside, as OSM often has — would run cars through the cars of the big
 * road. They are left out of the traffic (the ground drawing keeps them).
 */
export function withoutOverlaid(roads: Road[]): Road[] {
  const CELL = 25, grid = new Map<string, Array<{ r: Road; i: number }>>();
  const width = (r: Road) => r.w ?? Math.max(4, r.l * (r.o ? 3.2 : 6.4));
  for (const r of roads) {
    if (r.c > 3) continue;
    for (let i = 0; i + 1 < r.s.length / 4; i++) {
      const k = `${Math.floor(r.s[i * 4] / CELL)}_${Math.floor(r.s[i * 4 + 1] / CELL)}`;
      (grid.get(k) ?? grid.set(k, []).get(k)!).push({ r, i });
    }
  }
  return roads.filter((r) => {
    if (r.c <= 3) return true;
    const n = r.s.length / 4;
    let inside = 0, tot = 0;
    for (let j = 0; j < n; j += 2) {
      const x = r.s[j * 4], y = r.s[j * 4 + 1], cx = Math.floor(x / CELL), cy = Math.floor(y / CELL);
      tot++;
      let hit = false;
      for (let a = -1; a <= 1 && !hit; a++) for (let b = -1; b <= 1 && !hit; b++) for (const { r: o, i } of grid.get(`${cx + a}_${cy + b}`) ?? []) {
        const ax = o.s[i * 4], ay = o.s[i * 4 + 1], bx = o.s[i * 4 + 4], by = o.s[i * 4 + 5], sx = bx - ax, sy = by - ay, L2 = sx * sx + sy * sy;
        if (!L2) continue;
        const t = Math.max(0, Math.min(1, ((x - ax) * sx + (y - ay) * sy) / L2));
        if (Math.hypot(x - ax - sx * t, y - ay - sy * t) < width(o) / 2 + width(r) / 2 - 0.8) { hit = true; break; }
      }
      if (hit) inside++;
    }
    return !tot || inside / tot < 0.3; // mostly inside a bigger carriageway: not a road of its own
  });
}

function mulberry(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
