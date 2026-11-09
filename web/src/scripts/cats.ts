/**
 * Tel Aviv street cats: a few on the pavements, sitting for a while, then strolling a few metres
 * and sitting again. They live on the kerb-side strip next to streets (never in the lanes), hide
 * behind buildings like the cars do, and only appear when zoomed in close.
 */
import type { Road } from "./traffic.ts";

type Vec3 = [number, number, number];
interface Cat { r: Road; cum: Float32Array; s: number; dir: 1 | -1; side: 1 | -1; walk: number; timer: number; speed: number; coat: string[] }

/** fur: [body, darker shade] — ginger, black, white, grey tabby, calico, cream */
const COATS = [["#d9863f", "#a85f27"], ["#2b2b30", "#18181c"], ["#f2efe8", "#cfcac0"], ["#8d8a86", "#5f5c59"], ["#e9e3d6", "#c9762f"], ["#e6c79a", "#c09c6a"]];
const SCALE = 2.6; // drawn larger than life (still well under a car), or a cat would be ~2 px at full zoom
const PER_M = 1 / 900; // "not a lot": about one cat per 900 m of street

export class Cats {
  private cats: Cat[] = [];
  private seed = 11;

  constructor(roads: Road[], private enu2px: number[][]) {
    const streets = roads.filter((r) => r.c >= 1 && r.c <= 4 && r.s.length >= 8); // streets with pavements
    for (const r of streets) {
      const n = r.s.length / 4, cum = new Float32Array(n);
      for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + Math.hypot(r.s[i * 4] - r.s[i * 4 - 4], r.s[i * 4 + 1] - r.s[i * 4 - 3]);
      const len = cum[n - 1];
      const count = Math.floor(len * PER_M + this.rnd()); // fractional share kept on average
      for (let k = 0; k < count; k++)
        this.cats.push({
          r, cum, s: this.rnd() * len, dir: this.rnd() < 0.5 ? 1 : -1, side: this.rnd() < 0.5 ? 1 : -1,
          walk: 0, timer: this.rnd() * 20, speed: 0.4 + this.rnd() * 0.5, coat: COATS[Math.floor(this.rnd() * COATS.length)],
        });
    }
  }

  get count() { return this.cats.length; }

  private rnd() { this.seed = (this.seed * 16807) % 2147483647; return this.seed / 2147483647; }

  step(dt: number) {
    dt = Math.min(dt, 0.1);
    for (const c of this.cats) {
      c.timer -= dt;
      if (c.timer <= 0) { // sit 8–40 s, or stroll 3–10 s (sometimes the other way)
        c.walk = c.walk ? 0 : 1;
        c.timer = c.walk ? 3 + this.rnd() * 7 : 8 + this.rnd() * 32;
        if (c.walk && this.rnd() < 0.4) c.dir = -c.dir as 1 | -1;
      }
      if (!c.walk) continue;
      const len = c.cum[c.cum.length - 1];
      c.s += c.dir * c.speed * dt;
      if (c.s < 1 || c.s > len - 1) { c.dir = -c.dir as 1 | -1; c.s = Math.max(1, Math.min(len - 1, c.s)); }
    }
  }

  /** `px` = canvas px per art px (cats only show when zoomed in). */
  draw(ctx: CanvasRenderingContext2D, toScreen: (x: number, y: number) => [number, number], px: number, view: number[]) {
    if (px < 0.6) return;
    const M = this.enu2px;
    const proj = (p: Vec3) => toScreen(M[0][0] * p[0] + M[0][1] * p[1] + M[0][2] * p[2], M[1][0] * p[0] + M[1][1] * p[1] + M[1][2] * p[2]);
    for (const c of this.cats) {
      const S = c.r.s, n = c.cum.length;
      let i = 1;
      while (i < n - 1 && c.cum[i] < c.s) i++;
      if (!S[i * 4 + 3] || !S[(i - 1) * 4 + 3]) continue; // behind a building or under a bridge
      const f = (c.s - c.cum[i - 1]) / Math.max(1e-3, c.cum[i] - c.cum[i - 1]);
      const k0 = (i - 1) * 4, k1 = i * 4, L = c.cum[i] - c.cum[i - 1] || 1;
      const dx = ((S[k1] - S[k0]) / L) * c.dir, dy = ((S[k1 + 1] - S[k0 + 1]) / L) * c.dir;
      // on the pavement: just outside the carriageway on its side of the street
      const off = ((c.r.w ?? 6) / 2 + 1.4) * c.side * c.dir;
      const p: Vec3 = [S[k0] + (S[k1] - S[k0]) * f + dy * off, S[k0 + 1] + (S[k1 + 1] - S[k0 + 1]) * f - dx * off, S[k0 + 2] + (S[k1 + 2] - S[k0 + 2]) * f];
      const o = proj(p);
      if (o[0] < view[0] - 20 || o[1] < view[1] - 20 || o[0] > view[2] + 20 || o[1] > view[3] + 20) continue;
      // local frame: x forward, y to the side, z up (metres × SCALE) -> screen
      const fx = proj([p[0] + dx, p[1] + dy, p[2]]), sy = proj([p[0] + dy, p[1] - dx, p[2]]), up = proj([p[0], p[1], p[2] + 1]);
      const ex = [(fx[0] - o[0]) * SCALE, (fx[1] - o[1]) * SCALE], ey = [(sy[0] - o[0]) * SCALE, (sy[1] - o[1]) * SCALE];
      const ez = [(up[0] - o[0]) * SCALE, (up[1] - o[1]) * SCALE];
      const at = (h: number) => ctx.setTransform(ex[0], ex[1], ey[0], ey[1], o[0] + ez[0] * h, o[1] + ez[1] * h);
      const ell = (x: number, y: number, rx: number, ry: number, color: string) => {
        ctx.fillStyle = color; ctx.beginPath(); ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2); ctx.fill();
      };
      const [fur, shade] = c.coat;
      at(0); ctx.globalAlpha = 0.25; ell(0, 0.03, 0.28, 0.13, "#000"); ctx.globalAlpha = 1;
      if (c.walk) {
        at(0.2);
        ctx.strokeStyle = shade; ctx.lineWidth = 0.05; ctx.lineCap = "round";
        ctx.beginPath(); ctx.moveTo(-0.22, 0); ctx.quadraticCurveTo(-0.42, 0.02, -0.46, 0.12); ctx.stroke(); // tail
        ell(0, 0, 0.24, 0.09, fur);
        at(0.28); ell(0.27, 0, 0.08, 0.075, fur);
      } else {
        at(0.02);
        ctx.strokeStyle = shade; ctx.lineWidth = 0.05; ctx.lineCap = "round";
        ctx.beginPath(); ctx.moveTo(-0.12, 0); ctx.quadraticCurveTo(-0.05, 0.2, 0.12, 0.14); ctx.stroke(); // tail round the paws
        at(0.12); ell(-0.03, 0, 0.13, 0.11, shade);
        at(0.18); ell(0, 0, 0.11, 0.1, fur);
        at(0.36); ell(0.05, 0, 0.08, 0.075, fur);
      }
      // ears: two small triangles on top of the head
      const hx = c.walk ? 0.27 : 0.05, hz = c.walk ? 0.28 : 0.36;
      at(hz + 0.06); ctx.fillStyle = shade;
      for (const s of [-1, 1]) { ctx.beginPath(); ctx.moveTo(hx - 0.03, s * 0.07); ctx.lineTo(hx + 0.03, s * 0.05); ctx.lineTo(hx, s * 0.035); ctx.closePath(); ctx.fill(); }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }
  }
}
