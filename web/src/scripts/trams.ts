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
export interface TramMeta { n: string; d: number; h: number }
interface Track { r: Road; n: number; cum: Float32Array; len: number; line: number }
interface Tram { t: number; s: number; v: number }

const SPEED = 6.5, CAR = 11.2, GAP_CARS = 0.35, CARS = 3, WIDTH = 2.4, HEIGHT = 3.4;
const BODY: [number, number, number] = [228, 226, 220];

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
      // cars[0] leads: windscreen only at the front of the first car and the back of the last
      const ends = it.cars.map((_, k) => (k === 0 ? 2 : 0) | (k === it.cars.length - 1 ? 1 : 0));
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

  /** one tram car as a lofted model (vehicle-mesh.ts): light body, window band, pillars and doors */
  private car(ctx: CanvasRenderingContext2D, proj: (p: Vec3) => [number, number], c: Vec3, d: [number, number], ends = 0) {
    const view: Vec3 = [this.camFwd[0] * Math.SQRT1_2, this.camFwd[1] * Math.SQRT1_2, -Math.SQRT1_2];
    const [ax, ay] = proj(c), [bx, by] = proj([c[0] + d[0], c[1] + d[1], c[2]]), pxPerM = Math.hypot(bx - ax, by - ay);
    // soft contact shadow
    const r: [number, number] = [d[1], -d[0]], hl = CAR / 2, hw = WIDTH / 2;
    const pt = (a: number, b: number): [number, number] => proj([c[0] + d[0] * a + r[0] * b + 0.4, c[1] + d[1] * a + r[1] * b + 0.3, c[2] + 0.05]);
    ctx.globalAlpha = 0.2; ctx.fillStyle = "#000"; ctx.beginPath();
    [pt(hl, hw), pt(-hl, hw), pt(-hl, -hw), pt(hl, -hw)].forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath(); ctx.fill(); ctx.globalAlpha = 1;
    drawCar(ctx, proj, c, d, "bus", CAR, WIDTH, HEIGHT, BODY, view, SUN, pxPerM, false, ends);
  }
}
