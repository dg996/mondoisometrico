/**
 * The city at night, drawn on #lights (screen-blended over the night tint, so it adds light and never
 * hides the painting): street lamps along the drawn roads, headlights and tail lights of the traffic.
 *
 * Street lamps: no open dataset maps Rome's ~205,000 lighting points (Areti / ACEA; the city's
 * regulator ACOS reports ~3.6 points per 100 m of street, almost all LED since the 2016–17 LED plan,
 * 3000 K warm white in the historic centre). They are placed along the OSM roads at that density,
 * staggered kerb to kerb on wide streets. In lanes hidden behind roofs only the glow spilling up
 * between the buildings shows (no lantern).
 */
import type { Road } from "./traffic.ts";

/** one lamp per this many metres of street (3.6 per 100 m) */
const SPACING = 100 / 3.6;
/** lantern height (m) above the kerb */
const POLE = 7.5;

/** a soft round glow sprite (premultiplied radial falloff), tinted once per colour */
function sprite(rgb: [number, number, number], size = 64, flat = false) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d")!, r = size / 2;
  const grad = g.createRadialGradient(r, r, 0, r, r, r);
  const [R, G, B] = rgb;
  // flat: an even wash (floodlit facades), else a bright point fading out (lamps)
  grad.addColorStop(0, `rgba(${R},${G},${B},${flat ? 0.75 : 1})`);
  grad.addColorStop(0.25, `rgba(${R},${G},${B},${flat ? 0.68 : 0.55})`);
  grad.addColorStop(0.6, `rgba(${R},${G},${B},${flat ? 0.4 : 0.16})`);
  grad.addColorStop(1, `rgba(${R},${G},${B},0)`);
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  return c;
}

export interface CarLight { fx: number; fy: number; rx: number; ry: number; ux: number; uy: number; a: number; bus: boolean; mpp: number }

export class Lights {
  /** lamps: art px [ground x, ground y, lantern x, lantern y, visible 1/0] × n */
  private lamps: Float32Array;
  private pool = sprite([255, 178, 96]);   // 3000 K pool of light on the asphalt
  private head = sprite([255, 236, 200], 32); // the lantern itself
  private beam = sprite([255, 240, 215], 32);
  private tail = sprite([255, 60, 40], 32);
  /** art px per metre on the ground (iso scale) */
  private ppm: number;

  constructor(roads: Road[], M: number[][], inside: (x: number, y: number) => boolean = () => true) {
    const P = (e: number, n: number, u: number): [number, number] => [M[0][0] * e + M[0][1] * n + M[0][2] * u, M[1][0] * e + M[1][1] * n + M[1][2] * u];
    this.ppm = Math.hypot(M[0][0], M[1][0]);
    const out: number[] = [];
    let side = 1;
    for (const r of roads) {
      if (r.c === 0) continue; // motorways: no kerbside lamps in the centre
      const S = r.s, n = S.length / 4, off = (r.w ?? 7) / 2 + 0.8;
      let next = SPACING * 0.5 * ((r.a * 7919) % 2 ? 1 : 0.5), d = 0;
      for (let i = 1; i < n; i++) {
        const dx = S[i * 4] - S[(i - 1) * 4], dy = S[i * 4 + 1] - S[(i - 1) * 4 + 1], L = Math.hypot(dx, dy);
        if (L < 1e-3) continue;
        while (d + L >= next) {
          const f = (next - d) / L;
          next += SPACING;
          const vis = S[(i - 1) * 4 + 3] && S[i * 4 + 3] ? 1 : 0; // behind a building: glow only
          side = -side; // staggered, kerb to kerb
          const e = S[(i - 1) * 4] + dx * f + (dy / L) * off * side, no = S[(i - 1) * 4 + 1] + dy * f - (dx / L) * off * side;
          const u = S[(i - 1) * 4 + 2] + (S[i * 4 + 2] - S[(i - 1) * 4 + 2]) * f;
          const g = P(e, no, u), h = P(e, no, u + POLE);
          if (!inside(g[0], g[1])) continue;
          out.push(g[0], g[1], h[0], h[1], vis);
        }
        d += L;
      }
    }
    this.lamps = new Float32Array(out);
  }

  get count() { return this.lamps.length / 5; }

  /**
   * `night` 0..1, `px` canvas px per art px, cars = headlight / tail-light positions already in canvas px.
   */
  draw(ctx: CanvasRenderingContext2D, toScreen: (x: number, y: number) => [number, number], px: number, w: number, h: number, night: number,
       cars: CarLight[]) {
    ctx.clearRect(0, 0, w, h);
    if (night < 0.02) return;
    const dpr = window.devicePixelRatio || 1;
    const m = this.ppm * px * dpr; // canvas (device) px per metre: the same look on retina screens
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    // street lamps: pool on the asphalt (iso ellipse) + the lantern, sized in metres so they sit
    // in the painting at every zoom; zoomed far out they merge into the lit street network
    const L = this.lamps, poolR = Math.max(2.4 * dpr, 15 * m), headR = Math.max(1 * dpr, Math.min(8 * dpr, 2.2 * m));
    const poolA = Math.min(0.85, 0.62 + 0.03 / Math.max(0.05, px)) * night;
    const near = m > 1.2 * dpr; // lanterns read as separate lights
    for (let i = 0; i < L.length; i += 5) {
      const [gx, gy] = toScreen(L[i], L[i + 1]);
      if (gx < -poolR || gy < -poolR || gx > w + poolR || gy > h + poolR) continue;
      const vis = L[i + 4] > 0;
      ctx.globalAlpha = vis ? poolA : poolA * 0.4;
      ctx.drawImage(this.pool, gx - poolR, gy - poolR * 0.62, 2 * poolR, 1.24 * poolR);
      if (near && vis) {
        const [hx, hy] = toScreen(L[i + 2], L[i + 3]);
        ctx.globalAlpha = 0.85 * night;
        ctx.drawImage(this.head, hx - headR, hy - headR, 2 * headR, 2 * headR);
      }
    }
    // traffic: two soft beams ahead, red tail lights
    for (const c of cars) {
      const mm = c.mpp, beam = Math.max(2 * dpr, 7 * mm), lamp = Math.max(1.2 * dpr, 0.9 * mm);
      ctx.globalAlpha = 0.5 * night * c.a;
      ctx.drawImage(this.beam, c.fx + c.ux * beam * 0.6 - beam, c.fy + c.uy * beam * 0.6 - beam * 0.6, 2 * beam, 1.2 * beam);
      ctx.globalAlpha = 0.95 * night * c.a;
      ctx.drawImage(this.head, c.fx - lamp, c.fy - lamp, 2 * lamp, 2 * lamp);
      ctx.globalAlpha = 0.8 * night * c.a;
      ctx.drawImage(this.tail, c.rx - lamp, c.ry - lamp, 2 * lamp, 2 * lamp);
    }
    ctx.restore();
  }
}
