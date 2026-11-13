/**
 * Live traffic (button "Traffico in tempo reale"): TomTom's current speed / free-flow speed per road
 * stretch, served by /api/traffic (api/traffic.ts: the key stays server-side, one refresh every 10 min
 * for the whole site). Each TomTom stretch is matched onto the map's own OSM roads by position and
 * direction; only its congestion level is used:
 *  - the roads are coloured (green flowing … red queue, dark red closed) where they are in view,
 *  - the simulated cars on them slow down to the real relative speed.
 * TomTom geometry is never drawn. Attribution "© TomTom" is shown whenever the layer is on.
 */
import { ecefToEnu, llhToEcef } from "../../../pipeline/src/camera.ts";
import { SEA_H } from "../../../pipeline/src/vertical-datum.ts";
import type { Road } from "./traffic.ts";

interface Segment { l: number; c?: 1; p: number[] }
interface Payload { at: string; segments: Segment[] }

/** congestion classes: upper bound of relative speed, colour */
export const CLASSES = [
  { max: 0.25, css: "#c62828", label: "coda" },
  { max: 0.5, css: "#ef6c00", label: "rallentato" },
  { max: 0.75, css: "#f4b400", label: "a tratti lento" },
  { max: 2, css: "#3a9d48", label: "scorrevole" },
] as const;
const CLOSED = "#4a0f0f";
/** a TomTom point counts for a road sample within this distance (m), running the same way */
const MATCH_M = 9, CELL = 12;

export class LiveTraffic {
  /** relative speed per road (index = the roads passed in), NaN where TomTom has no data */
  levels: Float32Array | null = null;
  /** time of the TomTom data shown (ISO) */
  at = "";
  private paths: Array<{ css: string; path: Path2D; flowing: boolean }> = [];
  private ppm: number;

  constructor(private roads: Road[], private M: number[][]) {
    this.ppm = Math.hypot(M[0][0], M[1][0]);
  }

  async load(url = "/api/traffic"): Promise<boolean> {
    try {
      const r = await fetch(url);
      if (!r.ok) return false;
      const data = (await r.json()) as Payload;
      if (!Array.isArray(data.segments) || !data.segments.length) return false;
      this.apply(data);
      return true;
    } catch { return false; }
  }

  /** match TomTom stretches onto the roads; build the coloured paths (art px) */
  apply(data: Payload) {
    this.at = data.at;
    // TomTom points in ENU, densified every ~4 m, in a grid: [e, n, dirE, dirN, level]
    const grid = new Map<string, number[]>();
    const put = (e: number, n: number, de: number, dn: number, l: number) => {
      const k = `${Math.floor(e / CELL)}_${Math.floor(n / CELL)}`;
      (grid.get(k) ?? grid.set(k, []).get(k)!).push(e, n, de, dn, l);
    };
    const h = SEA_H + 20;
    for (const s of data.segments) {
      const l = s.c ? 0 : s.l;
      let pe = NaN, pn = NaN;
      for (let i = 0; i < s.p.length; i += 2) {
        const [e, n] = ecefToEnu(llhToEcef(s.p[i], s.p[i + 1], h));
        if (i) {
          const de = e - pe, dn = n - pn, L = Math.hypot(de, dn);
          if (L > 0.01) for (let t = 0; t < L; t += 4) put(pe + (de * t) / L, pn + (dn * t) / L, de / L, dn / L, l);
        }
        pe = e; pn = n;
      }
    }
    const near = (e: number, n: number, de: number, dn: number) => {
      let best = MATCH_M, lv = NaN;
      const cx = Math.floor(e / CELL), cy = Math.floor(n / CELL);
      for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
        const g = grid.get(`${cx + a}_${cy + b}`);
        if (!g) continue;
        for (let k = 0; k < g.length; k += 5) {
          if (Math.abs(g[k + 2] * de + g[k + 3] * dn) < 0.8) continue; // a crossing street, not this one
          const d = Math.hypot(g[k] - e, g[k + 1] - n);
          if (d < best) { best = d; lv = g[k + 4]; }
        }
      }
      return lv;
    };
    // per road: median level of the samples that found TomTom data (most of the road must match)
    const levels = new Float32Array(this.roads.length).fill(NaN);
    this.roads.forEach((r, i) => {
      const S = r.s, n = S.length / 4, got: number[] = [];
      let tried = 0, acc = 0;
      for (let k = 1; k < n; k++) {
        const de = S[k * 4] - S[(k - 1) * 4], dn = S[k * 4 + 1] - S[(k - 1) * 4 + 1], L = Math.hypot(de, dn);
        acc += L;
        if (acc < 6 && k < n - 1) continue;
        acc = 0; tried++;
        if (L < 0.01) continue;
        const lv = near(S[k * 4], S[k * 4 + 1], de / L, dn / L);
        if (Number.isFinite(lv)) got.push(lv);
      }
      if (got.length && got.length >= tried * 0.4) levels[i] = got.sort((a, b) => a - b)[Math.floor(got.length / 2)];
    });
    this.levels = levels;
    // coloured paths in art px, only along the stretches in view
    const M = this.M, paths = new Map<string, Path2D>();
    this.roads.forEach((r, i) => {
      const lv = levels[i];
      if (!Number.isFinite(lv)) return;
      const css = lv === 0 ? CLOSED : CLASSES.find((c) => lv < c.max)!.css; // 0 only for a reported closure
      const path = paths.get(css) ?? paths.set(css, new Path2D()).get(css)!;
      const S = r.s, n = S.length / 4;
      // drawn where the street is in view, and continuous across short covers (≤ 30 m: a row of tree
      // crowns over the kerb, a building corner), so a lungotevere under its plane trees is one line,
      // not dashes; behind a block (a longer cover) it stops a sample (≈2 m) short of it
      const ok = new Uint8Array(n);
      for (let k = 0; k < n; k++) ok[k] = S[k * 4 + 3] === 1 ? 1 : 0;
      for (let k = 0; k < n;) {
        if (ok[k]) { k++; continue; }
        let j = k, run = 0;
        while (j < n && !ok[j]) { if (j > 0) run += Math.hypot(S[j * 4] - S[(j - 1) * 4], S[j * 4 + 1] - S[(j - 1) * 4 + 1]); j++; }
        if (k > 0 && j < n && run <= 30) for (let q = k; q < j; q++) ok[q] = 2;
        k = j;
      }
      const seen = (k: number) => k < 0 || k >= n || ok[k] > 0;
      let open = false;
      for (let k = 0; k < n; k++) {
        if (!seen(k) || !seen(k - 1) || !seen(k + 1)) { open = false; continue; }
        const x = M[0][0] * S[k * 4] + M[0][1] * S[k * 4 + 1] + M[0][2] * S[k * 4 + 2];
        const y = M[1][0] * S[k * 4] + M[1][1] * S[k * 4 + 1] + M[1][2] * S[k * 4 + 2];
        if (open) path.lineTo(x, y); else { path.moveTo(x, y); open = true; }
      }
    });
    // draw order: flowing first, queues on top
    this.paths = [...CLASSES.map((c) => c.css).reverse(), CLOSED].filter((css) => paths.has(css))
      .map((css) => ({ css, path: paths.get(css)!, flowing: css === CLASSES[CLASSES.length - 1].css }));
  }

  /** coloured roads on the map overlay; k, tx, ty: canvas px = art px × k + t */
  draw(ctx: CanvasRenderingContext2D, k: number, tx: number, ty: number) {
    if (!this.paths.length) return;
    const dpr = window.devicePixelRatio || 1;
    // a band of light along the middle of the carriageway, in metres (thin from afar, never wider
    // than a lane): flowing streets barely tinted, slow ones and queues clearly marked
    const w = (m: number, minCss: number) => Math.max((minCss * dpr) / k, m * this.ppm);
    ctx.save();
    ctx.setTransform(k, 0, 0, k, tx, ty);
    ctx.lineCap = "butt"; ctx.lineJoin = "round";
    for (const { css, path, flowing } of this.paths) {
      const core = flowing ? w(1.1, 1.2) : w(2.0, 2);
      ctx.strokeStyle = css;
      ctx.globalAlpha = flowing ? 0.1 : 0.22; ctx.lineWidth = core * 2.4; ctx.stroke(path); // soft halo
      ctx.globalAlpha = flowing ? 0.5 : 0.92; ctx.lineWidth = core; ctx.stroke(path);
    }
    ctx.restore();
  }
}
