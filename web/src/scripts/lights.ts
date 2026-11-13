/**
 * The city at night. Two layers, both in the map's own isometric projection:
 *  - drawPosts(): the lamp posts themselves, on the map overlay (so the night tint darkens them like the
 *    painting): pole, arm, lantern housing, contact shadow. Only close enough to read them.
 *  - draw(): the light, on #lights (screen-blended over the night tint, so it adds light and never hides
 *    the painting): pools of light lying flat on the street (true ground ellipses, centred under each
 *    lantern), the lit glass, headlight beams on the asphalt ahead of each car, tail lights.
 *
 * Street lamps: no open dataset maps Rome's ~205,000 lighting points (Areti / ACEA). ACOS, the city's
 * regulator, reports ~3.6 points per 100 m of street, almost all LED since the 2016–17 LED plan (warm
 * 3000 K in the historic centre). They are placed along the OSM roads at that density, staggered kerb
 * to kerb: tall modern poles with an arm over the carriageway on primary / secondary roads, lower
 * lantern poles on the smaller streets. Lanes hidden behind roofs keep only the glow spilling up.
 */
import type { Road } from "./traffic.ts";

/** one lamp per this many metres of street (3.6 per 100 m) */
const SPACING = 100 / 3.6;
/** per lamp: e, n, u (pole base), ie, in (unit toward the carriageway), visible, tall (1/0) */
const STRIDE = 7;
/** tall modern pole: height, arm reach (m); lantern pole on smaller streets: height */
const TALL_H = 9, TALL_ARM = 1.8, LOW_H = 4.6;

type V2 = [number, number];

/** a radial glow sprite: `stops` = [offset, alpha] pairs */
function glow(rgb: [number, number, number], stops: Array<[number, number]>, w = 64, h = w, cx = w / 2, cy = h / 2, r = w / 2) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const g = c.getContext("2d")!, grad = g.createRadialGradient(cx, cy, 0, cx, cy, r);
  for (const [o, a] of stops) grad.addColorStop(o, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a})`);
  g.fillStyle = grad;
  g.fillRect(0, 0, w, h);
  return c;
}

/** headlight beam sprite (128×64): an ellipse anchored at the left edge (the bumper), soft on every side */
function beamSprite() {
  const c = document.createElement("canvas");
  c.width = 128; c.height = 64;
  const g = c.getContext("2d")!;
  g.setTransform(1, 0, 0, 0.3, 0, 32); // squash: the beam is long and narrow
  const grad = g.createRadialGradient(0, 0, 0, 0, 0, 128);
  for (const [o, a] of [[0, 0.85], [0.18, 0.5], [0.45, 0.18], [0.75, 0.04], [1, 0]] as const) grad.addColorStop(o, `rgba(255,240,214,${a})`);
  g.fillStyle = grad;
  g.fillRect(0, -110, 128, 220);
  return c;
}

/** headlights / tail lights of one drawn vehicle, in ENU metres (traffic.ts fills them) */
export interface CarLight { e: number; n: number; u: number; de: number; dn: number; len: number; wid: number; a: number; bus: boolean }

export class Lights {
  private lamps: Float32Array;
  /** 3000 K pool on the asphalt: a hot spot under the lantern, long soft falloff */
  private pool = glow([255, 186, 112], [[0, 0.95], [0.12, 0.8], [0.35, 0.42], [0.65, 0.13], [1, 0]], 128);
  /** halo round the lit glass */
  private halo = glow([255, 214, 160], [[0, 0.9], [0.2, 0.45], [0.55, 0.1], [1, 0]], 64);
  /** the glass itself: nearly white, warm edge */
  private core = glow([255, 244, 222], [[0, 1], [0.45, 0.9], [0.75, 0.3], [1, 0]], 32);
  /** headlight beam: bright at the bumper (left edge), fading ahead and to the sides */
  private beam = beamSprite();
  private tail = glow([255, 48, 32], [[0, 1], [0.4, 0.55], [1, 0]], 32);

  constructor(roads: Road[], private M: number[][], inside: (x: number, y: number) => boolean = () => true) {
    const out: number[] = [];
    let side = 1;
    for (const r of roads) {
      if (r.c === 0) continue; // motorways: no kerbside lamps in the centre
      const lanes = r.o ? r.l : r.l * 2; // l = lanes per direction (total when one-way)
      const S = r.s, n = S.length / 4, off = Math.max((r.w ?? 7) / 2, (lanes * 3.3) / 2) + 0.6, tall = r.c <= 2 ? 1 : 0;
      let total = 0;
      for (let i = 1; i < n; i++) total += Math.hypot(S[i * 4] - S[(i - 1) * 4], S[i * 4 + 1] - S[(i - 1) * 4 + 1]);
      // one-way ways are mostly one half of a divided road: lamps on the outer (right-hand) kerb only,
      // never in the other carriageway
      const fixed = r.o === 1 ? 1 : r.o === -1 ? -1 : 0;
      let next = SPACING * ((Math.abs(r.a) % 7) / 7 + 0.3), d = 0;
      for (let i = 1; i < n; i++) {
        const dx = S[i * 4] - S[(i - 1) * 4], dy = S[i * 4 + 1] - S[(i - 1) * 4 + 1], L = Math.hypot(dx, dy);
        if (L < 1e-3) continue;
        while (d + L >= next) {
          const f = (next - d) / L;
          next += SPACING;
          const at = next - SPACING;
          if (at < 6 || total - at < 6) continue; // inside a junction: the crossing roads light it
          const vis = S[(i - 1) * 4 + 3] && S[i * 4 + 3] ? 1 : 0; // behind a building: glow only
          side = fixed || -side; // staggered, kerb to kerb (two-way streets)
          const nx = (dy / L) * side, ny = (-dx / L) * side; // outward normal of this kerb
          const e = S[(i - 1) * 4] + dx * f + nx * off, no = S[(i - 1) * 4 + 1] + dy * f + ny * off;
          const u = S[(i - 1) * 4 + 2] + (S[i * 4 + 2] - S[(i - 1) * 4 + 2]) * f;
          if (!inside(M[0][0] * e + M[0][1] * no + M[0][2] * u, M[1][0] * e + M[1][1] * no + M[1][2] * u)) continue;
          out.push(e, no, u, -nx, -ny, vis, tall);
        }
        d += L;
      }
    }
    this.lamps = new Float32Array(out);
  }

  get count() { return this.lamps.length / STRIDE; }

  /** screen origin and screen vectors of one metre east / north / up (canvas px) */
  private basis(toScreen: (x: number, y: number) => V2) {
    const M = this.M, o = toScreen(0, 0);
    const v = (c: number): V2 => { const p = toScreen(M[0][c], M[1][c]); return [p[0] - o[0], p[1] - o[1]]; };
    return { o, E: v(0), N: v(1), U: v(2) };
  }

  /** lamp posts on the map overlay (under the night tint), back to front; only when they read */
  drawPosts(ctx: CanvasRenderingContext2D, toScreen: (x: number, y: number) => V2, w: number, h: number, night: number) {
    if (night < 0.02) return;
    const { o, E, N, U } = this.basis(toScreen), m = Math.hypot(E[0], E[1]);
    const dpr = window.devicePixelRatio || 1;
    if (m < 1.6 * dpr) return;
    const L = this.lamps, at = (e: number, n: number, u: number): V2 => [o[0] + E[0] * e + N[0] * n + U[0] * u, o[1] + E[1] * e + N[1] * n + U[1] * u];
    const lw = Math.max(1, 0.2 * m), pad = 12 * m;
    ctx.save();
    ctx.globalAlpha = night;
    ctx.lineCap = "round";
    for (let i = 0; i < L.length; i += STRIDE) {
      if (!L[i + 5]) continue;
      const [bx, by] = at(L[i], L[i + 1], L[i + 2]);
      if (bx < -pad || by < -pad || bx > w + pad || by > h + pad * 2) continue;
      const tall = L[i + 6] > 0, H = tall ? TALL_H : LOW_H, arm = tall ? TALL_ARM : 0;
      const [tx, ty] = at(L[i], L[i + 1], L[i + 2] + H);
      const [ax, ay] = at(L[i] + L[i + 3] * arm, L[i + 1] + L[i + 4] * arm, L[i + 2] + H);
      // contact shadow
      ctx.fillStyle = "rgba(10,12,20,0.35)";
      ctx.beginPath(); ctx.ellipse(bx, by, 0.5 * m, 0.28 * m, 0, 0, Math.PI * 2); ctx.fill();
      // pole: dark graphite with a thin lit edge
      ctx.strokeStyle = "#262a31"; ctx.lineWidth = lw * (tall ? 1.15 : 1);
      ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(tx, ty); ctx.stroke();
      ctx.strokeStyle = "rgba(150,160,175,0.55)"; ctx.lineWidth = Math.max(0.5, lw * 0.3);
      ctx.beginPath(); ctx.moveTo(bx - lw * 0.25, by); ctx.lineTo(tx - lw * 0.25, ty); ctx.stroke();
      if (tall) {
        // arm over the carriageway and the flat LED head
        ctx.strokeStyle = "#262a31"; ctx.lineWidth = lw * 0.8;
        ctx.beginPath(); ctx.moveTo(tx, ty); ctx.quadraticCurveTo(tx, ty - 0.5 * m, ax, ay); ctx.stroke();
        const [hx, hy] = at(L[i] + L[i + 3] * (arm + 0.5), L[i + 1] + L[i + 4] * (arm + 0.5), L[i + 2] + H - 0.15);
        ctx.lineWidth = Math.max(1.5, 0.42 * m);
        ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(hx, hy); ctx.stroke();
      } else {
        // lantern: a small dark cap over the glass (the glass glows on the light layer)
        ctx.fillStyle = "#262a31";
        const s = 0.32 * m;
        ctx.beginPath(); ctx.moveTo(tx - s, ty - 0.55 * m); ctx.lineTo(tx + s, ty - 0.55 * m); ctx.lineTo(tx, ty - 0.95 * m); ctx.closePath(); ctx.fill();
        ctx.fillRect(tx - s * 0.75, ty - 0.08 * m, s * 1.5, 0.16 * m);
      }
    }
    ctx.restore();
  }

  /** light on #lights: pools, lit glass, headlight beams, tail lights */
  draw(ctx: CanvasRenderingContext2D, toScreen: (x: number, y: number) => V2, w: number, h: number, night: number, cars: CarLight[]) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (night < 0.02) return;
    const dpr = window.devicePixelRatio || 1;
    const { o, E, N, U } = this.basis(toScreen), m = Math.hypot(E[0], E[1]);
    const at = (e: number, n: number, u: number): V2 => [o[0] + E[0] * e + N[0] * n + U[0] * u, o[1] + E[1] * e + N[1] * n + U[1] * u];
    const near = m >= 1.6 * dpr; // posts drawn: glass at the lantern
    const L = this.lamps;
    // lanes hidden by roofs: their glow only from afar (it lights the network); close up it would
    // stain the roofs, so it fades out as the streets themselves come into view
    const hidden = 0.34 * Math.min(1, Math.max(0, (1.4 - m / dpr) / 0.9));
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    // pools: a disc of light lying on the street (the projected ellipse), at least a few px wide far out
    for (let i = 0; i < L.length; i += STRIDE) {
      if (!L[i + 5] && hidden < 0.01) continue;
      const tall = L[i + 6] > 0, arm = tall ? TALL_ARM + 0.5 : 0;
      const ce = L[i] + L[i + 3] * arm, cn = L[i + 1] + L[i + 4] * arm, cu = L[i + 2];
      const R = Math.max(tall ? 13 : 8.5, (2.6 * dpr) / m);
      const [cx, cy] = at(ce, cn, cu), reach = R * m * 1.2;
      if (cx < -reach || cy < -reach || cx > w + reach || cy > h + reach) continue;
      ctx.globalAlpha = (L[i + 5] ? (tall ? 0.62 : 0.55) : hidden) * night;
      ctx.setTransform(E[0] * R, E[1] * R, N[0] * R, N[1] * R, cx, cy);
      ctx.drawImage(this.pool, -1, -1, 2, 2);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    // headlight beams on the asphalt ahead, before the bright points
    for (const c of cars) {
      const Lb = c.bus ? 17 : 14, Wb = 2.6, fe = c.e + c.de * c.len / 2, fn = c.n + c.dn * c.len / 2;
      const [fx, fy] = at(fe, fn, c.u);
      ctx.globalAlpha = 0.55 * night * c.a;
      // x axis along the travel direction (Lb m), y across (±Wb m)
      ctx.setTransform((E[0] * c.de + N[0] * c.dn) * Lb, (E[1] * c.de + N[1] * c.dn) * Lb,
        (E[0] * -c.dn + N[0] * c.de) * Wb, (E[1] * -c.dn + N[1] * c.de) * Wb, fx, fy);
      ctx.drawImage(this.beam, 0, -1, 1, 2);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    // lit glass of the lanterns
    if (near) for (let i = 0; i < L.length; i += STRIDE) {
      if (!L[i + 5]) continue;
      const tall = L[i + 6] > 0, arm = tall ? TALL_ARM + 0.5 : 0, H = tall ? TALL_H - 0.3 : LOW_H - 0.3;
      const [gx, gy] = at(L[i] + L[i + 3] * arm, L[i + 1] + L[i + 4] * arm, L[i + 2] + H);
      if (gx < -40 || gy < -40 || gx > w + 40 || gy > h + 40) continue;
      const hr = 1.7 * m, cr = Math.max(1.1 * dpr, (tall ? 0.42 : 0.3) * m);
      ctx.globalAlpha = 0.5 * night;
      ctx.drawImage(this.halo, gx - hr, gy - hr, 2 * hr, 2 * hr);
      ctx.globalAlpha = night;
      if (tall) ctx.drawImage(this.core, gx - cr * 1.4, gy - cr * 0.55, cr * 2.8, cr * 1.1); // flat LED panel
      else ctx.drawImage(this.core, gx - cr, gy - cr * 1.3, 2 * cr, 2.6 * cr); // lantern glass
    }
    // headlamps and tail lights: two of each, at the corners of the body
    for (const c of cars) {
      const hw = c.wid / 2 - 0.35, he = c.e + c.de * c.len / 2, hn = c.n + c.dn * c.len / 2, re = c.e - c.de * c.len / 2, rn = c.n - c.dn * c.len / 2;
      const z = c.bus ? 0.9 : 0.65, r = Math.max(0.9 * dpr, 0.24 * m);
      for (const s of [-1, 1]) {
        const [fx, fy] = at(he - c.dn * hw * s, hn + c.de * hw * s, c.u + z);
        ctx.globalAlpha = night * c.a;
        ctx.drawImage(this.core, fx - r, fy - r, 2 * r, 2 * r);
        const [bx, by] = at(re - c.dn * hw * s, rn + c.de * hw * s, c.u + z);
        ctx.globalAlpha = 0.85 * night * c.a;
        ctx.drawImage(this.tail, bx - r * 1.2, by - r * 1.2, 2.4 * r, 2.4 * r);
      }
    }
    ctx.restore();
  }
}
