/**
 * Life above the roofs: airliners on approach to the region's airport (when the corridor
 * crosses the map) plus scenic overflights across the painted city so centro always sees
 * planes; and flocks of green parakeets over the streets.
 * Drawn on the overlay canvas in a local frame projected like the cars (x forward, y side, z up).
 */
type Vec3 = [number, number, number];
type ToScreen = (x: number, y: number) => [number, number];

import { ecefToEnu, llhToEcef } from "../../../pipeline/src/camera.ts";

/** The region's airport: runway threshold and heading (places.ts, passed on in world.json). */
export interface Airport { lat: number; lon: number; runwayHeadingDeg: number }
const START = 22000, END = 7000;        // metres before the threshold on final approach
const FADE = 2500, SPEED = 75, EVERY = 110, GLIDE = Math.tan((3 * Math.PI) / 180);
/** Scenic overflights: varied headings/offsets across the city centre. */
const FLY_LEN = 16000, FLY_EVERY = 55;
/** Hide planes when zoomed out this far (canvas px per art px) — avoids sky-whales. */
const MIN_PX = 0.055;

interface Flyover {
  s: number;              // distance flown (m)
  origin: [number, number];
  dir: [number, number];
  alt: number;
  len: number;
  speed: number;
}

/** projector + local frame (forward d, z up), scaled, as a canvas transform setter */
function frame(ctx: CanvasRenderingContext2D, M: number[][], toScreen: ToScreen, p: Vec3, d: [number, number], scale: number) {
  const proj = (q: Vec3) => toScreen(M[0][0] * q[0] + M[0][1] * q[1] + M[0][2] * q[2], M[1][0] * q[0] + M[1][1] * q[1] + M[1][2] * q[2]);
  // Normalise heading — a near-zero dir collapses the basis and stretches nav-lights into
  // infinite vertical red streaks across the map.
  const L = Math.hypot(d[0], d[1]) || 1;
  const dx = d[0] / L, dy = d[1] / L;
  const o = proj(p), f = proj([p[0] + dx, p[1] + dy, p[2]]), s = proj([p[0] + dy, p[1] - dx, p[2]]);
  let ex: [number, number] = [(f[0] - o[0]) * scale, (f[1] - o[1]) * scale];
  let ey: [number, number] = [(s[0] - o[0]) * scale, (s[1] - o[1]) * scale];
  const lx = Math.hypot(ex[0], ex[1]), ly = Math.hypot(ey[0], ey[1]);
  // Reject / repair degenerate frames (parallel screen axes or near-zero) that paint streaks.
  if (lx < 1e-3 || ly < 1e-3 || !Number.isFinite(lx + ly)) {
    return { o, set: null as (() => void) | null, meter: lx, bad: true as const };
  }
  // Cap axis length so a bad scale never draws kilometre-long wing chords
  const CAP = 80;
  if (lx > CAP) { ex = [ex[0] * CAP / lx, ex[1] * CAP / lx]; }
  if (ly > CAP) { ey = [ey[0] * CAP / ly, ey[1] * CAP / ly]; }
  return { o, set: () => ctx.setTransform(ex[0], ex[1], ey[0], ey[1], o[0], o[1]), meter: lx, bad: false as const };
}

const inView = (o: [number, number], view: number[], m: number) => o[0] > view[0] - m && o[1] > view[1] - m && o[0] < view[2] + m && o[1] < view[3] + m;

export class Planes {
  private t = EVERY - 6; // first approach shortly after load
  private flyT = FLY_EVERY - 8;
  private flights: number[] = []; // distance flown (m) on final approach
  private flyovers: Flyover[] = [];
  private threshold: [number, number]; // runway threshold in the region's ENU metres
  private dir: [number, number];
  private center: [number, number];
  private seed = 17;
  constructor(private M: number[][], airport: Airport, overflightCenter?: [number, number]) {
    const p = ecefToEnu(llhToEcef(airport.lat, airport.lon, 0)), a = (airport.runwayHeadingDeg * Math.PI) / 180;
    this.threshold = [p[0], p[1]];
    this.dir = [Math.sin(a), Math.cos(a)];
    this.center = overflightCenter ?? [0, 0];
  }

  private rnd() { this.seed = (this.seed * 16807) % 2147483647; return this.seed / 2147483647; }

  /** Spawn a scenic overflight on a fresh heading/offset so paths don't repeat. */
  private spawnFlyover() {
    // Prefer routes that cross the city: NE–SW and NW–SE diagonals, plus slight jitter
    const base = [Math.PI / 4, -Math.PI / 4, Math.PI / 2, 0, Math.PI / 6, -Math.PI / 3][Math.floor(this.rnd() * 6)];
    const h = base + (this.rnd() - 0.5) * 0.35;
    const dir: [number, number] = [Math.sin(h), Math.cos(h)];
    const side: [number, number] = [dir[1], -dir[0]];
    const lateral = (this.rnd() - 0.5) * 3500; // up to ±1.75 km off the city centre
    const len = FLY_LEN * (0.85 + this.rnd() * 0.3);
    const origin: [number, number] = [
      this.center[0] - dir[0] * (len / 2) + side[0] * lateral,
      this.center[1] - dir[1] * (len / 2) + side[1] * lateral,
    ];
    this.flyovers.push({
      s: 0, origin, dir, len,
      alt: 650 + this.rnd() * 700,          // 650–1350 m
      speed: SPEED * (0.85 + this.rnd() * 0.35),
    });
  }

  step(dt: number) {
    dt = Math.min(dt, 0.1);
    this.t += dt;
    if (this.t >= EVERY) { this.t = 0; this.flights.push(0); }
    this.flights = this.flights.map((s) => s + SPEED * dt).filter((s) => s < START - END);
    this.flyT += dt;
    if (this.flyT >= FLY_EVERY) { this.flyT = 0; this.spawnFlyover(); }
    this.flyovers = this.flyovers
      .map((f) => ({ ...f, s: f.s + f.speed * dt }))
      .filter((f) => f.s < f.len);
  }

  draw(ctx: CanvasRenderingContext2D, toScreen: ToScreen, px: number, view: number[]) {
    if (px < MIN_PX) return; // zoomed out too far: hide rather than inflate
    for (const s of this.flights) {
      const left = START - s;
      const B = this.threshold, DIR = this.dir;
      const p: Vec3 = [B[0] - DIR[0] * left, B[1] - DIR[1] * left, 30 + left * GLIDE];
      this.drawOne(ctx, toScreen, px, view, p, DIR, Math.min(1, s / FADE, (START - END - s) / FADE));
    }
    for (const f of this.flyovers) {
      const O = f.origin, DIR = f.dir;
      const p: Vec3 = [O[0] + DIR[0] * f.s, O[1] + DIR[1] * f.s, f.alt];
      this.drawOne(ctx, toScreen, px, view, p, DIR, Math.min(1, f.s / FADE, (f.len - f.s) / FADE));
    }
  }

  private drawOne(ctx: CanvasRenderingContext2D, toScreen: ToScreen, px: number, view: number[],
    p: Vec3, DIR: [number, number], alpha: number) {
    if (alpha <= 0.02) return;
    // True world scale (shape units ≈ metres). Cap on-screen wingspan so zoom-out never
    // makes a giant; slight floor when very zoomed in so it stays readable.
    const probe = frame(ctx, this.M, toScreen, p, DIR, 1);
    if (probe.bad) return;
    const meterPx = Math.max(1e-6, probe.meter); // canvas px per ENU metre
    const wingM = 36; // drawn wingspan in shape units
    const natural = wingM * meterPx;
    const MAX_SPAN = 52, MIN_SPAN = 14;
    let scale = 1;
    if (natural > MAX_SPAN) scale = MAX_SPAN / natural;
    else if (natural < MIN_SPAN) scale = MIN_SPAN / natural;
    scale = Math.min(1.25, scale); // never enlarge more than 25% — zoom-out stays small

    const sh = frame(ctx, this.M, toScreen, [p[0] + p[2] * 0.25, p[1] + p[2] * 0.35, 0], DIR, scale);
    const pl = frame(ctx, this.M, toScreen, p, DIR, scale);
    if (pl.bad || sh.bad || (!inView(pl.o, view, 400) && !inView(sh.o, view, 400))) return;
    ctx.globalAlpha = alpha * 0.18; sh.set!(); this.shape(ctx, "#000", "#000", "#000");
    ctx.globalAlpha = alpha; pl.set!(); this.shape(ctx, "#f4f5f7", "#c9ced6", "#8a93a0");
    const blink = (performance.now() % 1200) < 120;
    // Nav lights as arcs (fillRect under a skew transform drew infinite red streaks)
    ctx.fillStyle = "#ff3b30"; ctx.beginPath(); ctx.arc(-2, -17.6, 0.9, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#34c759"; ctx.beginPath(); ctx.arc(-2, 16.4, 0.9, 0, Math.PI * 2); ctx.fill();
    if (blink) { ctx.fillStyle = "#fff"; ctx.beginPath(); ctx.arc(-19, 0, 1.6, 0, Math.PI * 2); ctx.fill(); }
    ctx.globalAlpha = 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  /** narrow-body airliner from above, ~38 m long and 36 m across, nose at +x */
  private shape(ctx: CanvasRenderingContext2D, body: string, wing: string, edge: string) {
    const poly = (pts: number[], color: string) => {
      ctx.fillStyle = color; ctx.beginPath(); ctx.moveTo(pts[0], pts[1]);
      for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]);
      ctx.closePath(); ctx.fill();
    };
    for (const s of [-1, 1]) {
      poly([3, s * 1.8, -3, s * 18, -6, s * 18, -5, s * 1.8], wing);           // swept wing
      poly([-14, s * 1, -18.5, s * 6.5, -20, s * 6.5, -19, s * 1], wing);      // tailplane
      poly([0.5, s * 7, -3, s * 7, -3, s * 8.6, 0.5, s * 8.6], edge);           // engine
    }
    ctx.fillStyle = body; ctx.beginPath(); ctx.ellipse(0, 0, 19, 2, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = edge; ctx.beginPath(); ctx.ellipse(-17.5, 0, 2.5, 0.5, 0, 0, Math.PI * 2); ctx.fill(); // fin
  }
}

interface Flock { p: Vec3; h: number; turn: number; timer: number; birds: Array<[number, number, number, number]> }

export class Parrots {
  private flocks: Flock[] = [];
  private seed = 7;
  private box: number[];

  /** `area` = [e0, n0, e1, n1]: the flocks wander over this, turning back at the edges */
  constructor(private M: number[][], area: number[], count = 6) {
    const pad = 300;
    this.box = [area[0] + pad, area[1] + pad, area[2] - pad, area[3] - pad];
    const b = this.box;
    for (let k = 0; k < count; k++) {
      const n = 3 + Math.floor(this.rnd() * 5), birds: Flock["birds"] = [];
      for (let i = 0; i < n; i++) birds.push([(this.rnd() - 0.5) * 14, (this.rnd() - 0.5) * 14, (this.rnd() - 0.5) * 3, this.rnd() * 6]);
      this.flocks.push({
        p: [b[0] + this.rnd() * (b[2] - b[0]), b[1] + this.rnd() * (b[3] - b[1]), 25 + this.rnd() * 20],
        h: this.rnd() * Math.PI * 2, turn: 0, timer: 0, birds,
      });
    }
  }

  get count() { return this.flocks.reduce((a, f) => a + f.birds.length, 0); }

  private rnd() { this.seed = (this.seed * 16807) % 2147483647; return this.seed / 2147483647; }

  step(dt: number) {
    dt = Math.min(dt, 0.1);
    const b = this.box;
    for (const f of this.flocks) {
      f.timer -= dt;
      if (f.timer <= 0) { f.timer = 1 + this.rnd() * 3; f.turn = (this.rnd() - 0.5) * 1.6; } // swooping, chattering turns
      const out = f.p[0] < b[0] || f.p[0] > b[2] || f.p[1] < b[1] || f.p[1] > b[3];
      if (out) { // steer back towards the middle
        const want = Math.atan2((b[0] + b[2]) / 2 - f.p[0], (b[1] + b[3]) / 2 - f.p[1]);
        f.turn = Math.sign(Math.sin(want - f.h)) * 0.9;
      }
      f.h += f.turn * dt;
      f.p[0] += Math.sin(f.h) * 14 * dt; f.p[1] += Math.cos(f.h) * 14 * dt;
      f.p[2] = 30 + 10 * Math.sin(performance.now() / 4000 + f.birds.length);
    }
  }

  draw(ctx: CanvasRenderingContext2D, toScreen: ToScreen, px: number, view: number[]) {
    if (px < 0.5) return;
    const now = performance.now() / 1000;
    for (const f of this.flocks) {
      const d: [number, number] = [Math.sin(f.h), Math.cos(f.h)];
      for (const [bx, by, bz, ph] of f.birds) {
        const wob = Math.sin(now * 1.3 + ph) * 1.5;
        const p: Vec3 = [f.p[0] + d[0] * bx + d[1] * (by + wob), f.p[1] + d[1] * bx - d[0] * (by + wob), f.p[2] + bz];
        // Cap bird size on zoom-out the same way as planes (old 8/px exploded when zoomed out)
        const boost = Math.min(8, 8 / Math.max(px, 0.5));
        const bird = frame(ctx, this.M, toScreen, p, d, boost);
        if (bird.bad || !bird.set || !inView(bird.o, view, 30)) continue;
        bird.set();
        const flap = Math.sin(now * 22 + ph * 5); // fast parakeet wingbeats
        ctx.fillStyle = "#3fae3a";
        for (const s of [-1, 1]) {
          ctx.beginPath(); ctx.moveTo(0.05, s * 0.03); ctx.lineTo(-0.08, s * (0.12 + 0.2 * Math.abs(flap))); ctx.lineTo(-0.14, s * 0.03); ctx.closePath(); ctx.fill();
        }
        ctx.beginPath(); ctx.moveTo(-0.08, 0); ctx.lineTo(-0.36, 0.02); ctx.lineTo(-0.36, -0.02); ctx.closePath(); ctx.fill(); // long tail
        ctx.fillStyle = "#57c94d"; ctx.beginPath(); ctx.ellipse(0, 0, 0.11, 0.04, 0, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = "#d8333a"; ctx.beginPath(); ctx.arc(0.12, 0, 0.018, 0, Math.PI * 2); ctx.fill(); // red beak
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }
  }
}
