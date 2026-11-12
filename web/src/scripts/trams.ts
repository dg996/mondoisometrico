/**
 * Trams on Rome's real tracks (GTFS shapes of Roma Servizi per la Mobilità, CC BY-SA, exported by
 * pipeline/src/export.ts with terrain / bridge-deck height and the roads' visibility rule).
 * Each visible stretch of a line carries as many trams as its real headway allows; a tram is three
 * ~11 m cars that follow the curve of the track. Illustrative positions, real lines and frequencies.
 */
import type { Road } from "./traffic.ts";

type Vec3 = [number, number, number];
export interface TramMeta { n: string; d: number; h: number }
interface Track { r: Road; n: number; cum: Float32Array; len: number; line: number }
interface Tram { t: number; s: number; v: number }

const SPEED = 6.5, CAR = 11.2, GAP_CARS = 0.35, CARS = 3, WIDTH = 2.4, HEIGHT = 3.4;
const BODY: [number, number, number] = [232, 230, 224], BAND: [number, number, number] = [196, 46, 40];

export class Trams {
  private tracks: Track[] = [];
  private trams: Tram[] = [];
  clock: () => number = () => 12 * 60;
  drawn = 0;

  constructor(tracks: Road[], private meta: TramMeta[], private enu2px: number[][], private camFwd: [number, number]) {
    for (const r of tracks) {
      const n = r.s.length / 4;
      if (n < 2) continue;
      const cum = new Float32Array(n);
      for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + Math.hypot(r.s[i * 4] - r.s[i * 4 - 4], r.s[i * 4 + 1] - r.s[i * 4 - 3]);
      const line = (r as Road & { t?: number }).t ?? 0;
      if (cum[n - 1] < 120 || !meta[line]) continue;
      const t = this.tracks.push({ r, n, cum, len: cum[n - 1], line }) - 1;
      const spacing = Math.max(220, meta[line].h * SPEED);
      const count = Math.max(1, Math.round(cum[n - 1] / spacing));
      for (let k = 0; k < count; k++) this.trams.push({ t, s: (k / count) * cum[n - 1], v: SPEED * (0.85 + 0.3 * ((k * 7919) % 13) / 13) });
    }
  }

  get count() { return this.trams.length; }

  /** trams run 5:30–24:00 */
  private running() { const m = this.clock(); return m >= 330 && m < 1440; }

  step(dt: number) {
    dt = Math.min(dt, 0.1);
    for (const tr of this.trams) {
      const track = this.tracks[tr.t];
      tr.s += tr.v * dt;
      if (tr.s > track.len) tr.s -= track.len; // leaves the visible stretch, a new tram enters at its start
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
      for (const car of [...it.cars].sort((a, b) => (b.c[0] * this.camFwd[0] + b.c[1] * this.camFwd[1]) - (a.c[0] * this.camFwd[0] + a.c[1] * this.camFwd[1])))
        this.car(ctx, proj, car.c, car.d);
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

  /** one tram car: shadow, camera-facing sides (red band low, windows high), light roof */
  private car(ctx: CanvasRenderingContext2D, proj: (p: Vec3) => [number, number], c: Vec3, d: [number, number]) {
    const r: [number, number] = [d[1], -d[0]], hl = CAR / 2, hw = WIDTH / 2;
    const pt = (a: number, b: number, z: number): Vec3 => [c[0] + d[0] * a + r[0] * b, c[1] + d[1] * a + r[1] * b, c[2] + z];
    const poly = (pts: Vec3[]) => { ctx.beginPath(); pts.forEach((p, i) => { const [x, y] = proj(p); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.closePath(); ctx.fill(); };
    const fill = (rgb: [number, number, number], k: number, a = 1) => { ctx.globalAlpha = a; ctx.fillStyle = `rgb(${Math.min(255, rgb[0] * k) | 0},${Math.min(255, rgb[1] * k) | 0},${Math.min(255, rgb[2] * k) | 0})`; };
    fill([0, 0, 0], 1, 0.22);
    poly([pt(hl, hw * 1.05, 0.1), pt(-hl, hw * 1.05, 0.1), pt(-hl, -hw * 1.05, 0.1), pt(hl, -hw * 1.05, 0.1)].map((p) => [p[0] + 0.4, p[1] - 0.4, p[2]] as Vec3));
    const z0 = 0.35, zBand = 1.1, zWin = 2.9, zTop = HEIGHT;
    const corners: Array<[number, number]> = [[hl, hw], [hl, -hw], [-hl, -hw], [-hl, hw]];
    for (let i = 0; i < 4; i++) {
      const [a1, b1] = corners[i], [a2, b2] = corners[(i + 1) % 4];
      const A = pt(a1, b1, 0), B = pt(a2, b2, 0), nx = B[1] - A[1], ny = -(B[0] - A[0]);
      if (nx * this.camFwd[0] + ny * this.camFwd[1] >= 0) continue;
      const k = 0.72 + 0.08 * (i % 2);
      fill(BAND, k); poly([pt(a1, b1, z0), pt(a2, b2, z0), pt(a2, b2, zBand), pt(a1, b1, zBand)]);
      fill(BODY, k); poly([pt(a1, b1, zBand), pt(a2, b2, zBand), pt(a2, b2, zTop), pt(a1, b1, zTop)]);
      fill([26, 36, 48], 1, 0.55); poly([pt(a1, b1, zBand + 0.45), pt(a2, b2, zBand + 0.45), pt(a2, b2, zWin), pt(a1, b1, zWin)]);
    }
    fill(BODY, 0.96, 1); poly([pt(hl, hw, zTop), pt(hl, -hw, zTop), pt(-hl, -hw, zTop), pt(-hl, hw, zTop)]);
    fill([120, 124, 130], 1, 0.9); poly([pt(hl * 0.4, hw * 0.4, zTop + 0.05), pt(hl * 0.4, -hw * 0.4, zTop + 0.05), pt(-hl * 0.2, -hw * 0.4, zTop + 0.05), pt(-hl * 0.2, hw * 0.4, zTop + 0.05)]);
    ctx.globalAlpha = 1;
  }
}
