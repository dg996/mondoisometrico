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
}

const CLASS_WEIGHT = [3, 2.6, 2, 1.4, 0.35, 0.05];
const CLASS_SPEED = [22, 13, 12, 11, 8, 5]; // m/s (≈ 80, 47, 43, 40, 29, 18 km/h)
const ACCEL = 2.2, BRAKE = 5.5;              // m/s²
const GAP = 2.2, HEADWAY = 1.1;              // standstill gap (m), time gap (s)
const CAR_COLORS: Array<[number, number, number]> = [
  [236, 236, 236], [236, 236, 236], [190, 194, 200], [60, 62, 68], [36, 38, 44], [170, 40, 38],
  [40, 80, 150], [235, 190, 40], [120, 130, 140], [210, 210, 214],
];
const BUS_COLORS: Array<[number, number, number]> = [[40, 110, 190], [30, 150, 90], [220, 220, 222]];
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
      const len = bus ? 13.5 : 5.6 + this.rand() * 0.7;
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
        wid: bus ? 2.7 : 2.15, hei: bus ? 3.2 : 1.65,
        color: bus ? BUS_COLORS[Math.floor(this.rand() * BUS_COLORS.length)] : CAR_COLORS[Math.floor(this.rand() * CAR_COLORS.length)],
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
      const len = 12, way = this.ways[pick.w];
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

  private box(ctx: CanvasRenderingContext2D, proj: (p: Vec3) => [number, number], c: Vec3, d: [number, number], v: Vehicle) {
    const r: [number, number] = [d[1], -d[0]];
    const hl = v.len / 2, hw = v.wid / 2;
    const pt = (a: number, b: number, z: number): Vec3 =>
      [c[0] + d[0] * a + r[0] * b, c[1] + d[1] * a + r[1] * b, c[2] + z];
    const [R, G, B] = v.color;
    const rgb = (k: number, a = 1) => {
      ctx.globalAlpha = a;
      ctx.fillStyle = `rgb(${Math.min(255, R * k) | 0},${Math.min(255, G * k) | 0},${Math.min(255, B * k) | 0})`;
    };
    const poly = (pts: Vec3[]) => {
      ctx.beginPath();
      pts.forEach((p, i) => { const [x, y] = proj(p); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
      ctx.closePath();
      ctx.fill();
    };
    const ground = 0.12;
    // soft oval contact shadow
    {
      const sh = [pt(hl * 0.85, 0, ground), pt(0, hw * 1.05, ground), pt(-hl * 0.85, 0, ground), pt(0, -hw * 1.05, ground)];
      ctx.globalAlpha = 0.22;
      ctx.fillStyle = "#000";
      poly(sh.map((p) => [p[0] + 0.35, p[1] - 0.35, p[2]] as Vec3));
      ctx.globalAlpha = 1;
    }
    if (v.bus) {
      this.drawBus(ctx, proj, pt, poly, rgb, hl, hw, v);
      return;
    }
    // sedan proportions: low nose → cabin → short deck
    const z0 = ground + 0.18;          // underbody
    const zBelt = ground + v.hei * 0.52;
    const zRoof = ground + v.hei;
    const nose = hl * 0.92, cabinF = hl * 0.28, cabinR = -hl * 0.42, tail = -hl * 0.88;
    const wBody = hw * 0.96, wCabin = hw * 0.78;
    // lower body (hood + doors + rear deck)
    const body = [
      pt(nose, wBody * 0.72, zBelt * 0.85), pt(nose, -wBody * 0.72, zBelt * 0.85),
      pt(cabinF, -wBody, zBelt), pt(cabinR, -wBody, zBelt),
      pt(tail, -wBody * 0.85, zBelt * 0.9), pt(tail, wBody * 0.85, zBelt * 0.9),
      pt(cabinR, wBody, zBelt), pt(cabinF, wBody, zBelt),
    ];
    // cabin greenhouse
    const cabin = [
      pt(cabinF * 0.85, wCabin, zBelt), pt(cabinF * 0.85, -wCabin, zBelt),
      pt(cabinR * 0.9, -wCabin, zBelt), pt(cabinR * 0.9, wCabin, zBelt),
    ];
    const roof = [
      pt(cabinF * 0.55, wCabin * 0.88, zRoof), pt(cabinF * 0.55, -wCabin * 0.88, zRoof),
      pt(cabinR * 0.75, -wCabin * 0.88, zRoof), pt(cabinR * 0.75, wCabin * 0.88, zRoof),
    ];
    // camera-facing body flanks (bottom corners share the same floor z — mixed za/zb stretched faces)
    const flank = (a: Vec3, b: Vec3, zBot: number, zTop: number, k: number) => {
      const nx = (b[1] - a[1]), ny = -(b[0] - a[0]);
      if (nx * this.camFwd[0] + ny * this.camFwd[1] >= 0) return;
      rgb(k);
      poly([
        [a[0], a[1], c[2] + zTop] as Vec3, [b[0], b[1], c[2] + zTop] as Vec3,
        [b[0], b[1], c[2] + zBot] as Vec3, [a[0], a[1], c[2] + zBot] as Vec3,
      ]);
    };
    for (let i = 0; i < body.length; i++) {
      const a = body[i], b = body[(i + 1) % body.length];
      flank(a, b, z0, zBelt, 0.68 + 0.08 * (i % 2));
    }
    rgb(0.88); poly(body.map((p) => [p[0], p[1], c[2] + zBelt] as Vec3)); // belt / hood plane
    // cabin sides + roof
    for (let i = 0; i < 4; i++) {
      const a = cabin[i], b = cabin[(i + 1) % 4];
      flank(a, b, zBelt, zRoof, 0.78);
    }
    rgb(1.02); poly(roof);
    // windshield (front) + rear glass
    const glass = (pts: Vec3[], a: number) => {
      ctx.globalAlpha = a;
      ctx.fillStyle = "#1a2430";
      poly(pts);
      ctx.globalAlpha = 1;
    };
    glass([
      pt(cabinF * 0.82, wCabin * 0.9, zBelt + 0.05), pt(cabinF * 0.82, -wCabin * 0.9, zBelt + 0.05),
      pt(cabinF * 0.52, -wCabin * 0.82, zRoof - 0.02), pt(cabinF * 0.52, wCabin * 0.82, zRoof - 0.02),
    ], 0.62);
    glass([
      pt(cabinR * 0.88, wCabin * 0.88, zBelt + 0.05), pt(cabinR * 0.88, -wCabin * 0.88, zBelt + 0.05),
      pt(cabinR * 0.72, -wCabin * 0.8, zRoof - 0.02), pt(cabinR * 0.72, wCabin * 0.8, zRoof - 0.02),
    ], 0.45);
    // side windows
    glass([
      pt(cabinF * 0.5, wCabin, zBelt + 0.08), pt(cabinR * 0.7, wCabin, zBelt + 0.08),
      pt(cabinR * 0.7, wCabin * 0.88, zRoof - 0.04), pt(cabinF * 0.5, wCabin * 0.88, zRoof - 0.04),
    ], 0.35);
    glass([
      pt(cabinF * 0.5, -wCabin, zBelt + 0.08), pt(cabinR * 0.7, -wCabin, zBelt + 0.08),
      pt(cabinR * 0.7, -wCabin * 0.88, zRoof - 0.04), pt(cabinF * 0.5, -wCabin * 0.88, zRoof - 0.04),
    ], 0.35);
    // headlights + taillights
    const lamp = (a: number, b: number, z: number, color: string, alpha: number) => {
      ctx.globalAlpha = alpha;
      ctx.fillStyle = color;
      poly([pt(a, b * 0.55, z), pt(a, b * 0.15, z), pt(a - Math.sign(a) * 0.12, b * 0.15, z + 0.08), pt(a - Math.sign(a) * 0.12, b * 0.55, z + 0.08)]);
      ctx.globalAlpha = 1;
    };
    lamp(nose, hw, zBelt * 0.7, "#f4f0d8", 0.85);
    lamp(nose, -hw, zBelt * 0.7, "#f4f0d8", 0.85);
    lamp(tail, hw, zBelt * 0.75, "#c62828", 0.8);
    lamp(tail, -hw, zBelt * 0.75, "#c62828", 0.8);
    // wheels (dark ellipses under the body)
    for (const [along, side] of [[hl * 0.55, hw], [hl * 0.55, -hw], [-hl * 0.55, hw], [-hl * 0.55, -hw]] as const) {
      const w0 = pt(along, side * 0.92, ground + 0.05);
      const [sx, sy] = proj(w0);
      const [sx2] = proj(pt(along + 0.35, side * 0.92, ground + 0.05));
      const rad = Math.max(1.2, Math.abs(sx2 - sx) * 0.9);
      ctx.globalAlpha = 0.9;
      ctx.fillStyle = "#1a1c20";
      ctx.beginPath();
      ctx.ellipse(sx, sy, rad, rad * 0.55, Math.atan2(d[1], d[0]), 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  }

  private drawBus(
    ctx: CanvasRenderingContext2D,
    proj: (p: Vec3) => [number, number],
    pt: (a: number, b: number, z: number) => Vec3,
    poly: (pts: Vec3[]) => void,
    rgb: (k: number, a?: number) => void,
    hl: number, hw: number, v: Vehicle,
  ) {
    const ground = 0.12, z0 = ground + 0.2, zBelt = ground + v.hei * 0.45, zRoof = ground + v.hei;
    const nose = hl * 0.95, tail = -hl * 0.95;
    const body = [pt(nose, hw, zBelt), pt(nose, -hw, zBelt), pt(tail, -hw, zBelt), pt(tail, hw, zBelt)];
    const roof = [pt(nose, hw, zRoof), pt(nose, -hw, zRoof), pt(tail, -hw, zRoof), pt(tail, hw, zRoof)];
    for (let i = 0; i < 4; i++) {
      const a = body[i], b = body[(i + 1) % 4];
      const nx = (b[1] - a[1]), ny = -(b[0] - a[0]);
      if (nx * this.camFwd[0] + ny * this.camFwd[1] >= 0) continue;
      rgb(0.7 + 0.08 * (i % 2));
      poly([a, b, roof[(i + 1) % 4], roof[i]]);
    }
    rgb(0.95); poly(roof);
    // window band
    ctx.globalAlpha = 0.4;
    ctx.fillStyle = "#1a2430";
    poly([
      pt(nose - 0.4, hw - 0.12, zBelt + 0.15), pt(nose - 0.4, -hw + 0.12, zBelt + 0.15),
      pt(tail + 0.5, -hw + 0.12, zRoof - 0.2), pt(tail + 0.5, hw - 0.12, zRoof - 0.2),
    ]);
    ctx.globalAlpha = 1;
    // front glass
    ctx.globalAlpha = 0.55;
    ctx.fillStyle = "#243040";
    poly([
      pt(nose, hw * 0.85, zBelt + 0.1), pt(nose, -hw * 0.85, zBelt + 0.1),
      pt(nose - 0.15, -hw * 0.75, zRoof - 0.15), pt(nose - 0.15, hw * 0.75, zRoof - 0.15),
    ]);
    ctx.globalAlpha = 1;
    void proj; void z0;
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
