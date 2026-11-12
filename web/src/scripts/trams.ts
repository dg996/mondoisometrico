/**
 * Trams on Rome's real tracks (GTFS shapes of Roma Servizi per la Mobilità, CC BY-SA, exported by
 * pipeline/src/export.ts with terrain / bridge-deck height and the roads' visibility rule).
 * Each visible stretch of a line carries as many trams as its real headway allows; a tram is three
 * ~11 m cars that follow the curve of the track. Illustrative positions, real lines and frequencies.
 */
import type { Road } from "./traffic.ts";
import { drawCar } from "./vehicle-mesh.ts";

/** the render's sun (page/renderer.ts SUN), normalised, as for the cars */
const SUN: Vec3 = (() => { const v = [-0.55, -0.35, 0.76], L = Math.hypot(...v); return v.map((x) => x / L) as Vec3; })();

type Vec3 = [number, number, number];
export interface TramMeta { n: string; d: number; h: number; /** stops, flat [e, n, e, n …] */ st?: number[] }
interface Track { r: Road; n: number; cum: Float32Array; len: number; line: number }
interface Tram { id: number; t: number; s: number; v: number; dwell: number; lastStop: number }

const SPEED = 7, CAR = 11.2, GAP_CARS = 0.6, CARS = 3, WIDTH = 2.4, HEIGHT = 3.35;
const ACCEL = 1.1, BRAKE = 1.8;            // m/s² (low-floor tram)
const LENGTH = CARS * CAR + (CARS - 1) * GAP_CARS;
const SAFE = 12;                            // m kept free in front of a tram's nose
const DWELL = 18;                           // s at a stop
const BODY: [number, number, number] = [228, 226, 220];

export class Trams {
  private tracks: Track[] = [];
  private trams: Tram[] = [];
  clock: () => number = () => 12 * 60;
  drawn = 0;

  /** stop positions (distance along each track), from the GTFS stops of the line */
  private stops: number[][] = [];
  /** where two tracks cross or merge: per track the interval [from, to] occupied by the conflict, and
   *  the tram holding it (−1 free) */
  private zones: Array<{ on: Map<number, [number, number]>; holder: number }> = [];

  constructor(tracks: Road[], private meta: TramMeta[], private enu2px: number[][], private camFwd: [number, number], stops: Array<Array<[number, number]>> = []) {
    for (const r of tracks) {
      const n = r.s.length / 4;
      if (n < 2) continue;
      const cum = new Float32Array(n);
      for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + Math.hypot(r.s[i * 4] - r.s[i * 4 - 4], r.s[i * 4 + 1] - r.s[i * 4 - 3]);
      const line = (r as Road & { t?: number }).t ?? 0;
      if (cum[n - 1] < 120 || !meta[line]) continue;
      const t = this.tracks.push({ r, n, cum, len: cum[n - 1], line }) - 1;
      // stops of this line that lie on this stretch (within 8 m of the track), as distances along it
      const here: number[] = [];
      const own = stops[line] ?? (meta[line].st ? Array.from({ length: meta[line].st!.length / 2 }, (_, i) => [meta[line].st![i * 2], meta[line].st![i * 2 + 1]] as [number, number]) : []);
      for (const [e, no] of own) {
        let best = -1, bd = 8;
        for (let i = 0; i < n; i++) { const d = Math.hypot(r.s[i * 4] - e, r.s[i * 4 + 1] - no); if (d < bd) { bd = d; best = cum[i]; } }
        if (best > LENGTH) here.push(best);
      }
      this.stops[t] = here.sort((a, b) => a - b);
      const spacing = Math.max(260, meta[line].h * SPEED);
      const count = Math.max(1, Math.round(cum[n - 1] / spacing));
      for (let k = 0; k < count; k++) this.trams.push({ id: this.trams.length, t, s: (k / count) * cum[n - 1], v: SPEED * 0.6, dwell: 0, lastStop: -1 });
    }
    this.findZones();
  }

  get count() { return this.trams.length; }

  /** conflict zones between every pair of tracks: centre lines closer than 2.2 m (a crossing or a
   *  shared stretch; the two directions of a line run ~3.5 m apart and never conflict), grown 3 m */
  private findZones() {
    const CELL = 8, grid = new Map<string, Array<[number, number]>>(); // cell -> [track, distance along]
    this.tracks.forEach((tr, t) => { for (let i = 0; i < tr.n; i++) {
      const k = `${Math.floor(tr.r.s[i * 4] / CELL)}_${Math.floor(tr.r.s[i * 4 + 1] / CELL)}`;
      (grid.get(k) ?? grid.set(k, []).get(k)!).push([t, tr.cum[i]]);
    } });
    const hits = new Map<string, Array<[number, number]>>(); // "a|b" -> [sa, sb]
    this.tracks.forEach((tr, a) => { for (let i = 0; i < tr.n; i++) {
      const x = tr.r.s[i * 4], y = tr.r.s[i * 4 + 1], cx = Math.floor(x / CELL), cy = Math.floor(y / CELL);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (const [b, sb] of grid.get(`${cx + dx}_${cy + dy}`) ?? []) {
        if (b <= a) continue;
        const [bx, by] = this.pos(this.tracks[b], sb);
        if (Math.hypot(bx - x, by - y) < 2.2) (hits.get(`${a}|${b}`) ?? hits.set(`${a}|${b}`, []).get(`${a}|${b}`)!).push([tr.cum[i], sb]);
      }
    } });
    for (const [key, list] of hits) {
      const [a, b] = key.split("|").map(Number);
      list.sort((p, q) => p[0] - q[0]);
      let cur: Array<[number, number]> = [];
      const flush = () => {
        if (!cur.length) return;
        const sa = cur.map((p) => p[0]), sb = cur.map((p) => p[1]);
        this.zones.push({ holder: -1, on: new Map([[a, [Math.min(...sa) - 3, Math.max(...sa) + 3]], [b, [Math.min(...sb) - 3, Math.max(...sb) + 3]]]) });
        cur = [];
      };
      for (const p of list) { if (cur.length && p[0] - cur[cur.length - 1][0] > 6) flush(); cur.push(p); }
      flush();
    }
  }

  /** trams run 5:30–24:00 */
  private running() { const m = this.clock(); return m >= 330 && m < 1440; }

  /** raw position on a track (visibility ignored) — for spacing and crossings */
  private pos(track: Track, s: number): [number, number] {
    s = Math.max(0, Math.min(track.len, s));
    let i = 1;
    while (i < track.n - 1 && track.cum[i] < s) i++;
    const S = track.r.s, f = (s - track.cum[i - 1]) / Math.max(1e-3, track.cum[i] - track.cum[i - 1]);
    return [S[i * 4 - 4] + (S[i * 4] - S[i * 4 - 4]) * f, S[i * 4 - 3] + (S[i * 4 + 1] - S[i * 4 - 3]) * f];
  }

  /**
   * Movement with real spacing: a tram brakes for any other tram's body in the stretch ahead of its
   * nose (same line, other line, or crossing track); when two trams aim at each other's path the
   * lower id goes first. Trams stop DWELL s at the line's real stops and accelerate / brake gently.
   */
  step(dt: number) {
    dt = Math.min(dt, 0.1);
    // world positions of every tram's body (nose, car centres, tail)
    const bodies = this.trams.map((tr) => {
      const track = this.tracks[tr.t], pts: Array<[number, number]> = [];
      for (let o = 0; o <= LENGTH; o += 4) pts.push(this.pos(track, tr.s - o));
      return pts;
    });
    for (const tr of this.trams) {
      const track = this.tracks[tr.t];
      // free distance ahead: walk the track in 2 m steps until another tram's body is within 3 m
      let free = SAFE + 40;
      for (let o = 2; o <= SAFE + 40; o += 2) {
        if (tr.s + o > track.len) break;
        const [x, y] = this.pos(track, tr.s + o);
        let hit = false;
        for (let k = 0; k < this.trams.length && !hit; k++) {
          if (k === tr.id) continue;
          for (const [bx, by] of bodies[k]) if (Math.hypot(bx - x, by - y) < 2.4) { hit = true; break; } // oncoming trams pass at ~3.5 m
        }
        if (hit) { free = o; break; }
      }
      // conflict zones ahead: claim the zone early enough to stop before it; without the claim, stop short
      const brakeDist = (tr.v * tr.v) / (2 * BRAKE) + SAFE + 6;
      for (const z of this.zones) {
        const iv = z.on.get(tr.t);
        if (!iv) continue;
        const [z0, z1] = iv;
        if (z.holder === tr.id) { if (tr.s - LENGTH > z1) z.holder = -1; continue; }   // tail cleared: release
        if (tr.s > z1 || z0 - tr.s > brakeDist + 40) continue;                         // behind us / far ahead
        const occupied = this.trams.some((o) => o.id !== tr.id && [...z.on].some(([t, [a0, a1]]) => o.t === t && o.s > a0 && o.s - LENGTH < a1));
        if (z.holder < 0 && !occupied && tr.s < z0 && z0 - tr.s <= brakeDist + 40) z.holder = tr.id;
        else if (z.holder !== tr.id) free = Math.min(free, Math.max(0, z0 - tr.s));
      }
      // next stop ahead on this stretch
      const stop = (this.stops[tr.t] ?? []).find((p) => p > tr.s + 0.5 && p !== tr.lastStop);
      if (tr.dwell > 0) { tr.dwell -= dt; tr.v = 0; continue; }
      let target = SPEED;
      const brakeTo = (d: number) => Math.sqrt(Math.max(0, 2 * BRAKE * Math.max(0, d)));
      target = Math.min(target, brakeTo(free - SAFE));
      if (stop !== undefined) {
        target = Math.min(target, Math.max(0.6, brakeTo(stop - tr.s)));
        if (stop - tr.s < 0.6) { tr.s = stop; tr.v = 0; tr.dwell = DWELL; tr.lastStop = stop; continue; }
      }
      tr.v = target > tr.v ? Math.min(target, tr.v + ACCEL * dt) : Math.max(target, tr.v - BRAKE * 2 * dt);
      tr.s += tr.v * dt;
      if (tr.s > track.len) { // leaves the visible stretch: re-enters at its start once that is clear
        const [sx, sy] = this.pos(track, 0);
        // only trams on the same track can block the entry (oncoming ones run on their own track)
        const clear = bodies.every((b, k) => k === tr.id || this.trams[k].t !== tr.t || b.every(([bx, by]) => Math.hypot(bx - sx, by - sy) > LENGTH + SAFE));
        if (clear) { tr.s = 0; tr.lastStop = -1; } else { tr.s = track.len; tr.v = 0; }
      }
    }
  }

  /** point and direction on a track at distance s */
  private at(track: Track, s: number): { c: Vec3; d: [number, number] } | null {
    if (s < 0 || s > track.len) return null;
    const S = track.r.s;
    let i = 1;
    while (i < track.n - 1 && track.cum[i] < s) i++;
    if (!S[(i - 1) * 4 + 3] || !S[i * 4 + 3]) return null;
    const f = (s - track.cum[i - 1]) / Math.max(1e-3, track.cum[i] - track.cum[i - 1]);
    const dx = S[i * 4] - S[i * 4 - 4], dy = S[i * 4 + 1] - S[i * 4 - 3], L = Math.hypot(dx, dy) || 1;
    return { c: [S[i * 4 - 4] + dx * f, S[i * 4 - 3] + dy * f, S[i * 4 - 2] + (S[i * 4 + 2] - S[i * 4 - 2]) * f], d: [dx / L, dy / L] };
  }

  draw(ctx: CanvasRenderingContext2D, toScreen: (x: number, y: number) => [number, number], px: number, view: [number, number, number, number]) {
    this.drawn = 0;
    if (px < 0.28 || !this.running()) return;
    const M = this.enu2px;
    const proj = (p: Vec3): [number, number] => toScreen(M[0][0] * p[0] + M[0][1] * p[1] + M[0][2] * p[2], M[1][0] * p[0] + M[1][1] * p[1] + M[1][2] * p[2]);
    const items: Array<{ cars: Array<{ c: Vec3; d: [number, number] }>; depth: number; line: number }> = [];
    for (const tr of this.trams) {
      const track = this.tracks[tr.t], cars = [];
      for (let k = 0; k < CARS; k++) {
        const p = this.at(track, tr.s - k * (CAR + GAP_CARS) - CAR / 2);
        if (!p) { cars.length = 0; break; } // the whole tram must be on visible track
        cars.push(p);
      }
      if (!cars.length) continue;
      const [sx, sy] = proj(cars[1].c);
      if (sx < view[0] - 80 || sy < view[1] - 80 || sx > view[2] + 80 || sy > view[3] + 80) continue;
      items.push({ cars, depth: cars[1].c[0] * this.camFwd[0] + cars[1].c[1] * this.camFwd[1], line: track.line });
    }
    items.sort((a, b) => b.depth - a.depth);
    this.drawn = items.length;
    for (const it of items) {
      // cars[0] leads: windscreen only at the front of the first car and the back of the last
      const ends = it.cars.map((_, k) => (k === 0 ? 2 : 0) | (k === it.cars.length - 1 ? 1 : 0));
      for (let k = 0; k + 1 < it.cars.length; k++) { // bellows first, the cars cover their ends
        const a = it.cars[k], b = it.cars[k + 1];
        this.bellows(ctx, proj, [(a.c[0] + b.c[0]) / 2, (a.c[1] + b.c[1]) / 2, (a.c[2] + b.c[2]) / 2], a.d);
      }
      for (const k of it.cars.map((_, k) => k).sort((a, b) => (it.cars[b].c[0] * this.camFwd[0] + it.cars[b].c[1] * this.camFwd[1]) - (it.cars[a].c[0] * this.camFwd[0] + it.cars[a].c[1] * this.camFwd[1])))
        this.car(ctx, proj, it.cars[k].c, it.cars[k].d, ends[k]);
      if (px >= 1.1) {
        const [sx, sy] = proj([it.cars[0].c[0], it.cars[0].c[1], it.cars[0].c[2] + HEIGHT + 0.4]);
        const label = this.meta[it.line].n;
        ctx.font = `700 ${Math.round(Math.min(14, 6 + px * 3))}px ui-sans-serif, system-ui, sans-serif`;
        ctx.textAlign = "center"; ctx.textBaseline = "middle";
        const w = ctx.measureText(label).width + 6;
        ctx.globalAlpha = 0.9; ctx.fillStyle = "#1d1b19"; ctx.fillRect(sx - w / 2, sy - 8, w, 16);
        ctx.globalAlpha = 1; ctx.fillStyle = "#ffd84d"; ctx.fillText(label, sx, sy);
      }
    }
  }

  /** one tram car: the cab cars carry the raked nose (the rear cab is turned round), middle cars square */
  private car(ctx: CanvasRenderingContext2D, proj: (p: Vec3) => [number, number], c: Vec3, d: [number, number], ends = 0) {
    const view: Vec3 = [this.camFwd[0] * Math.SQRT1_2, this.camFwd[1] * Math.SQRT1_2, -Math.SQRT1_2];
    const [ax, ay] = proj(c), [bx, by] = proj([c[0] + d[0], c[1] + d[1], c[2]]), pxPerM = Math.hypot(bx - ax, by - ay);
    const r: [number, number] = [d[1], -d[0]], hl = CAR / 2, hw = WIDTH / 2;
    const pt = (a: number, b: number): [number, number] => proj([c[0] + d[0] * a + r[0] * b + 0.4, c[1] + d[1] * a + r[1] * b + 0.3, c[2] + 0.05]);
    ctx.globalAlpha = 0.2; ctx.fillStyle = "#000"; ctx.beginPath();
    [pt(hl, hw), pt(-hl, hw), pt(-hl, -hw), pt(hl, -hw)].forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath(); ctx.fill(); ctx.globalAlpha = 1;
    const cab = ends & 2 ? 1 : ends & 1 ? -1 : 0, dir: [number, number] = cab === -1 ? [-d[0], -d[1]] : d;
    drawCar(ctx, proj, c, dir, cab ? "tram-cab" : "tram", CAR, WIDTH, HEIGHT, BODY, view, SUN, pxPerM);
    if (pxPerM < 3) return;
    // roof equipment: an air-conditioning box on every car, the pantograph on the middle one
    const roofAt = (a: number): Vec3 => [c[0] + d[0] * a, c[1] + d[1] * a, c[2] + HEIGHT];
    drawCar(ctx, proj, roofAt(cab === 1 ? -1.2 : cab === -1 ? 1.2 : -2.2), d, "box", 2.4, WIDTH * 0.55, 0.38, [196, 198, 196], view, SUN, pxPerM);
    if (!cab) {
      const base = roofAt(1.2), top = HEIGHT + 1.3, q = (a: number, b: number, z: number): Vec3 => [base[0] + d[0] * a + r[0] * b, base[1] + d[1] * a + r[1] * b, c[2] + z];
      ctx.strokeStyle = "#2a2c30"; ctx.lineWidth = Math.max(0.7, pxPerM * 0.07); ctx.beginPath();
      for (const [a, b] of [[q(-0.9, 0, HEIGHT + 0.1), q(0.2, 0, HEIGHT + 0.75)], [q(0.2, 0, HEIGHT + 0.75), q(-0.3, 0, top)], [q(-0.3, -0.8, top), q(-0.3, 0.8, top)]] as Array<[Vec3, Vec3]>) {
        const [x1, y1] = proj(a), [x2, y2] = proj(b); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
      }
      ctx.stroke();
    }
  }

  /** dark rubber bellows between two cars */
  private bellows(ctx: CanvasRenderingContext2D, proj: (p: Vec3) => [number, number], c: Vec3, d: [number, number]) {
    const view: Vec3 = [this.camFwd[0] * Math.SQRT1_2, this.camFwd[1] * Math.SQRT1_2, -Math.SQRT1_2];
    drawCar(ctx, proj, c, d, "box", GAP_CARS + 0.5, WIDTH * 0.9, HEIGHT * 0.88, [44, 46, 50], view, SUN, 4);
  }
}
