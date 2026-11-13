/**
 * Painter crews at work where the painting meets the not yet painted city: small animated workers
 * (hard hats, hi-vis vests) rolling paint onto the street, pushing a wheelbarrow, digging, a foreman
 * reading the plans, with cones, a red and white barrier, a "lavori in corso" sign and paint pots.
 * Sites come from the export (world.json worksites): ground-level streets in the fade band, checked
 * against the height pass like the traffic, so nobody stands on a roof. Shown only when zoomed in.
 */

type Vec3 = [number, number, number];
/** [e, n, u, dirE, dirN, width, depth] from pipeline/src/export.ts findWorksites */
export type Worksite = number[];

const SCALE = 2.5; // larger than life, like the cats: at 1:1 a person would be ~5 art px, too small to read
/** the site's layout spreads with the figures */
const SPREAD = SCALE / 1.7;
/** metres between two crews */
const MIN_GAP = 120;
const SKIN = ["#f0c4a0", "#d9a074", "#b47a52", "#8a5638"];
const PAINT = ["#c8553d", "#e0a33a", "#d8c9a8", "#7a9a5a", "#6f8fb5"];

interface Crew { p: Vec3; d: [number, number]; w: number; seed: number; skin: string[]; paint: string; phase: number }

export class Workers {
  private crews: Crew[] = [];
  private t = 0;

  constructor(sites: Worksite[], private enu2px: number[][]) {
    let seed = 7;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    for (const s of sites) {
      if (s.length < 6 || !s.every(Number.isFinite)) continue;
      // one crew per stretch of the boundary: neighbouring cells can pick spots a few metres apart
      if (this.crews.some((c) => Math.hypot(c.p[0] - s[0], c.p[1] - s[1]) < MIN_GAP)) continue;
      this.crews.push({
        p: [s[0], s[1], s[2]], d: [s[3], s[4]], w: s[5], seed: rnd(),
        skin: [0, 1, 2, 3].map(() => SKIN[Math.floor(rnd() * SKIN.length)]),
        paint: PAINT[Math.floor(rnd() * PAINT.length)], phase: rnd() * 100,
      });
    }
  }

  get count() { return this.crews.length; }

  step(dt: number) { this.t += Math.min(dt, 0.1); }

  /** `px` = canvas px per art px. */
  draw(ctx: CanvasRenderingContext2D, toScreen: (x: number, y: number) => [number, number], px: number, view: number[]) {
    if (px < 0.35 || !this.crews.length) return;
    const M = this.enu2px;
    const proj = (p: Vec3) => toScreen(M[0][0] * p[0] + M[0][1] * p[1] + M[0][2] * p[2], M[1][0] * p[0] + M[1][1] * p[1] + M[1][2] * p[2]);
    for (const c of this.crews) {
      const o = proj(c.p);
      if (o[0] < view[0] - 200 || o[1] < view[1] - 200 || o[0] > view[2] + 200 || o[1] > view[3] + 200) continue;
      const up = proj([c.p[0], c.p[1], c.p[2] + 1]);
      const m = Math.hypot(up[0] - o[0], up[1] - o[1]) * SCALE; // screen px per (scaled) metre, upright
      // a point of the site in metres: a along the street, b across it (positive = to the right)
      const [dx, dy] = c.d;
      const at = (a: number, b: number): [number, number] => { a *= SPREAD; return proj([c.p[0] + dx * a + dy * b, c.p[1] + dy * a - dx * b, c.p[2]]); };
      const T = this.t + c.phase;
      const items: Array<{ y: number; draw: () => void }> = [];
      const add = (pt: [number, number], fn: (x: number, y: number) => void) => items.push({ y: pt[1], draw: () => fn(pt[0], pt[1]) });
      const half = Math.min(c.w / 2 - 0.6, 3.2);

      // barrier across part of the street, cones along the work strip, the sign facing the traffic
      add(at(-3.1, half * 0.7), (x, y) => barrier(ctx, x, y, m, at(-1.2, half * 0.7)));
      for (const [a, b] of [[0.2, half * 0.85], [3.2, half * 0.85], [5.6, half * 0.3], [5.6, -half * 0.6]] as const)
        add(at(a, b), (x, y) => cone(ctx, x, y, m));
      add(at(-3.4, -half * 0.55), (x, y) => sign(ctx, x, y, m));
      add(at(1.6, -half * 0.55), (x, y) => { pot(ctx, x, y, m, c.paint); pot(ctx, x + 0.32 * m, y + 0.1 * m, m, PAINT[(PAINT.indexOf(c.paint) + 2) % PAINT.length]); });

      // fresh paint strip the roller has laid (grows and resets slowly)
      const roll = (Math.sin(T * 0.9) + 1) / 2; // 0..1 along the stroke
      {
        const a0 = -1.6, a1 = a0 + 0.4 + roll * 2.6, b = half * 0.2;
        const sw = 0.35 * SPREAD, p0 = at(a0, b - sw), p1 = at(a1, b - sw), p2 = at(a1, b + sw), p3 = at(a0, b + sw);
        items.push({ y: -Infinity, draw: () => {
          ctx.fillStyle = c.paint; ctx.globalAlpha = 0.75;
          ctx.beginPath(); ctx.moveTo(p0[0], p0[1]); ctx.lineTo(p1[0], p1[1]); ctx.lineTo(p2[0], p2[1]); ctx.lineTo(p3[0], p3[1]); ctx.closePath(); ctx.fill();
          ctx.globalAlpha = 1;
        } });
        // the roller worker walks behind the roller head
        const head = at(a1, b), feet = at(a1 - 1.5, b);
        const facing = head[0] >= feet[0] ? 1 : -1;
        add(feet, (x, y) => person(ctx, x, y, m, { skin: c.skin[0], hat: "#ffcf2e", walk: Math.abs(Math.cos(T * 0.9)) > 0.2 ? T * 3.6 : 0, facing,
          tool: (hx, hy) => { // pole from the hands to the roller on the ground
            ctx.strokeStyle = "#6b5a45"; ctx.lineWidth = Math.max(1, 0.05 * m); ctx.lineCap = "round";
            ctx.beginPath(); ctx.moveTo(hx, hy); ctx.lineTo(head[0], head[1] - 0.12 * m); ctx.stroke();
            ctx.fillStyle = "#f4f1ea"; ctx.strokeStyle = "rgba(0,0,0,0.35)"; ctx.lineWidth = Math.max(0.6, 0.02 * m);
            ctx.beginPath(); ctx.ellipse(head[0], head[1] - 0.12 * m, 0.22 * m, 0.1 * m, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
            ctx.fillStyle = c.paint; ctx.beginPath(); ctx.ellipse(head[0], head[1] - 0.08 * m, 0.2 * m, 0.06 * m, 0, 0, Math.PI); ctx.fill();
          }, handsY: 1.0 }));
      }

      // wheelbarrow runner: back and forth along the far side, turning at each end
      {
        const cyc = (T * 0.12) % 2, fwd = cyc < 1, f = fwd ? cyc : 2 - cyc, s = smooth(f);
        const a = -2.6 + s * 4.6, b = -half * 0.2;
        const feet = at(a, b), ahead = at(a + (fwd ? 1 : -1), b);
        const facing = ahead[0] >= feet[0] ? 1 : -1;
        const moving = f > 0.02 && f < 0.98;
        add(feet, (x, y) => {
          const wx = x + facing * 0.95 * m, wy = y + (ahead[1] - feet[1]) * 0.95;
          wheelbarrow(ctx, wx, wy, m, facing, fwd ? "#9a7b58" : null);
          person(ctx, x, y, m, { skin: c.skin[1], hat: "#ffcf2e", walk: moving ? T * 4.2 : 0, facing, handsY: 0.78, reach: 0.5 });
        });
      }

      // digger: shovel goes down and comes up with earth, a small pile next to him
      {
        const feet = at(4.3, half * 0.3), dig = Math.sin(T * 2.1);
        add(feet, (x, y) => {
          pile(ctx, x + 0.75 * m, y + 0.05 * m, m);
          person(ctx, x, y, m, { skin: c.skin[2], hat: "#ff8c1a", walk: 0, facing: 1, lean: 0.12 + Math.max(0, dig) * 0.1, handsY: 0.95 - Math.max(0, dig) * 0.25,
            tool: (hx, hy) => {
              const bx = hx + 0.45 * m, by = y - (0.05 + Math.max(0, -dig) * 0.25) * m;
              ctx.strokeStyle = "#7a5b3a"; ctx.lineWidth = Math.max(1, 0.05 * m); ctx.lineCap = "round";
              ctx.beginPath(); ctx.moveTo(hx - 0.25 * m, hy - 0.25 * m); ctx.lineTo(bx, by - 0.15 * m); ctx.stroke();
              ctx.fillStyle = "#8d949a"; ctx.beginPath();
              ctx.moveTo(bx - 0.1 * m, by - 0.18 * m); ctx.lineTo(bx + 0.1 * m, by - 0.12 * m); ctx.lineTo(bx + 0.06 * m, by + 0.06 * m); ctx.lineTo(bx - 0.12 * m, by); ctx.closePath(); ctx.fill();
              if (dig < -0.3) { ctx.fillStyle = "#8a6a4a"; ctx.beginPath(); ctx.ellipse(bx, by - 0.12 * m, 0.09 * m, 0.05 * m, 0, 0, Math.PI * 2); ctx.fill(); }
            } });
        });
      }

      // foreman with the plans, white helmet, turning now and then
      {
        const feet = at(-1.2, -half * 0.9), facing = Math.sin(T * 0.17) > 0 ? 1 : -1;
        add(feet, (x, y) => person(ctx, x, y, m, { skin: c.skin[3], hat: "#fbfbf7", walk: 0, facing, handsY: 1.1, reach: 0.28,
          tool: (hx, hy) => { // unrolled plan sheet
            ctx.fillStyle = "#e9eef5"; ctx.strokeStyle = "#5b7aa6"; ctx.lineWidth = Math.max(0.6, 0.02 * m);
            ctx.save(); ctx.translate(hx, hy - 0.08 * m); ctx.rotate(-0.15 * facing);
            ctx.fillRect(-0.24 * m, -0.16 * m, 0.48 * m, 0.3 * m); ctx.strokeRect(-0.24 * m, -0.16 * m, 0.48 * m, 0.3 * m);
            ctx.beginPath(); ctx.moveTo(-0.16 * m, -0.06 * m); ctx.lineTo(0.14 * m, -0.06 * m); ctx.moveTo(-0.16 * m, 0.04 * m); ctx.lineTo(0.06 * m, 0.04 * m); ctx.stroke();
            ctx.restore();
          } }));
      }

      items.sort((p, q) => p.y - q.y); // back to front
      for (const it of items) it.draw();
    }
  }
}

const smooth = (f: number) => f * f * (3 - 2 * f);

function shadow(ctx: CanvasRenderingContext2D, x: number, y: number, rx: number, ry: number) {
  ctx.fillStyle = "rgba(20,15,10,0.28)"; ctx.beginPath(); ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2); ctx.fill();
}

interface Pose { skin: string; hat: string; walk: number; facing: number; handsY: number; reach?: number; lean?: number; tool?: (hx: number, hy: number) => void }

/** An upright worker at feet (x, y); m = screen px per metre. */
function person(ctx: CanvasRenderingContext2D, x: number, y: number, m: number, o: Pose) {
  const f = o.facing, lean = (o.lean ?? 0) * f * m, swing = o.walk ? Math.sin(o.walk) : 0;
  const lw = Math.max(1.2, 0.14 * m);
  shadow(ctx, x, y, 0.32 * m, 0.12 * m);
  ctx.lineCap = "round";
  // legs (navy work trousers) and boots
  for (const s of [-1, 1]) {
    const kx = x + s * 0.07 * m + lean * 0.3, fx = x + s * 0.08 * m + swing * s * 0.18 * m * f;
    ctx.strokeStyle = "#2c3a57"; ctx.lineWidth = lw;
    ctx.beginPath(); ctx.moveTo(kx, y - 0.92 * m); ctx.lineTo(fx, y - 0.08 * m); ctx.stroke();
    ctx.fillStyle = "#3a2a1e"; ctx.beginPath(); ctx.ellipse(fx + f * 0.04 * m, y - 0.04 * m, 0.09 * m, 0.05 * m, 0, 0, Math.PI * 2); ctx.fill();
  }
  // torso: shirt, hi-vis vest with two reflective bands
  const sx = x + lean, top = y - 1.45 * m, hip = y - 0.9 * m;
  ctx.fillStyle = "#4f6f99"; roundRect(ctx, sx - 0.2 * m, top, 0.4 * m, hip - top, 0.08 * m); ctx.fill();
  ctx.fillStyle = "#ff7a1a"; roundRect(ctx, sx - 0.19 * m, top + 0.04 * m, 0.38 * m, hip - top - 0.02 * m, 0.07 * m); ctx.fill();
  ctx.fillStyle = "#eef3f6";
  ctx.fillRect(sx - 0.19 * m, top + 0.2 * m, 0.38 * m, 0.045 * m);
  ctx.fillRect(sx - 0.19 * m, top + 0.36 * m, 0.38 * m, 0.045 * m);
  // arms reaching to the hands
  const hx = sx + f * (o.reach ?? 0.38) * m, hy = y - o.handsY * m;
  ctx.strokeStyle = "#4f6f99"; ctx.lineWidth = Math.max(1, 0.11 * m);
  for (const s of [-1, 1]) {
    ctx.beginPath(); ctx.moveTo(sx + s * 0.15 * m, top + 0.1 * m); ctx.quadraticCurveTo(sx + s * 0.12 * m + f * 0.1 * m, (top + hy) / 2 + 0.1 * m, hx + s * 0.03 * m, hy); ctx.stroke();
  }
  ctx.fillStyle = o.skin; ctx.beginPath(); ctx.arc(hx, hy, 0.06 * m, 0, Math.PI * 2); ctx.fill();
  o.tool?.(hx, hy);
  // head and hard hat
  const hx0 = sx + f * 0.02 * m, hy0 = top - 0.16 * m;
  ctx.fillStyle = o.skin; ctx.beginPath(); ctx.arc(hx0, hy0, 0.13 * m, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "rgba(40,30,25,0.8)"; ctx.beginPath(); ctx.arc(hx0 + f * 0.06 * m, hy0 + 0.01 * m, 0.018 * m, 0, Math.PI * 2); ctx.fill(); // eye
  ctx.fillStyle = o.hat;
  ctx.beginPath(); ctx.ellipse(hx0, hy0 - 0.06 * m, 0.15 * m, 0.13 * m, 0, Math.PI, 0); ctx.fill();
  ctx.beginPath(); ctx.ellipse(hx0 + f * 0.04 * m, hy0 - 0.055 * m, 0.2 * m, 0.035 * m, 0, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = "rgba(0,0,0,0.18)"; ctx.lineWidth = Math.max(0.5, 0.015 * m);
  ctx.beginPath(); ctx.moveTo(hx0, hy0 - 0.19 * m); ctx.lineTo(hx0, hy0 - 0.07 * m); ctx.stroke();
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

function cone(ctx: CanvasRenderingContext2D, x: number, y: number, m: number) {
  shadow(ctx, x, y, 0.2 * m, 0.08 * m);
  ctx.fillStyle = "#3b3b3b"; ctx.fillRect(x - 0.17 * m, y - 0.04 * m, 0.34 * m, 0.05 * m);
  ctx.fillStyle = "#ff6a13"; ctx.beginPath(); ctx.moveTo(x - 0.13 * m, y - 0.03 * m); ctx.lineTo(x + 0.13 * m, y - 0.03 * m); ctx.lineTo(x + 0.03 * m, y - 0.62 * m); ctx.lineTo(x - 0.03 * m, y - 0.62 * m); ctx.closePath(); ctx.fill();
  ctx.fillStyle = "#f6f6f2"; ctx.beginPath(); ctx.moveTo(x - 0.085 * m, y - 0.26 * m); ctx.lineTo(x + 0.085 * m, y - 0.26 * m); ctx.lineTo(x + 0.06 * m, y - 0.38 * m); ctx.lineTo(x - 0.06 * m, y - 0.38 * m); ctx.closePath(); ctx.fill();
}

/** red and white barrier between two feet points */
function barrier(ctx: CanvasRenderingContext2D, x: number, y: number, m: number, to: [number, number]) {
  const [x2, y2] = to;
  for (const [px, py] of [[x, y], [x2, y2]]) {
    shadow(ctx, px, py, 0.25 * m, 0.08 * m);
    ctx.strokeStyle = "#5a5f66"; ctx.lineWidth = Math.max(1, 0.06 * m); ctx.lineCap = "round";
    ctx.beginPath(); ctx.moveTo(px - 0.18 * m, py); ctx.lineTo(px, py - 0.95 * m); ctx.lineTo(px + 0.18 * m, py); ctx.stroke();
  }
  const n = 6, h = 0.18 * m;
  for (let i = 0; i < n; i++) {
    const a = i / n, b = (i + 1) / n;
    ctx.fillStyle = i % 2 ? "#f7f5f0" : "#d8262f";
    ctx.beginPath();
    ctx.moveTo(x + (x2 - x) * a, y + (y2 - y) * a - 0.95 * m); ctx.lineTo(x + (x2 - x) * b, y + (y2 - y) * b - 0.95 * m);
    ctx.lineTo(x + (x2 - x) * b, y + (y2 - y) * b - 0.95 * m + h); ctx.lineTo(x + (x2 - x) * a, y + (y2 - y) * a - 0.95 * m + h);
    ctx.closePath(); ctx.fill();
  }
}

/** Italian road-works sign: red-rimmed triangle with a digging figure, on a stand */
function sign(ctx: CanvasRenderingContext2D, x: number, y: number, m: number) {
  shadow(ctx, x, y, 0.22 * m, 0.08 * m);
  ctx.strokeStyle = "#5a5f66"; ctx.lineWidth = Math.max(1, 0.05 * m); ctx.lineCap = "round";
  ctx.beginPath(); ctx.moveTo(x - 0.16 * m, y); ctx.lineTo(x, y - 0.9 * m); ctx.lineTo(x + 0.16 * m, y); ctx.stroke();
  const cy = y - 1.05 * m, r = 0.4 * m;
  const tri = (s: number) => { ctx.beginPath(); ctx.moveTo(x, cy - r * s); ctx.lineTo(x + r * 0.95 * s, cy + r * 0.62 * s); ctx.lineTo(x - r * 0.95 * s, cy + r * 0.62 * s); ctx.closePath(); };
  ctx.fillStyle = "#d8262f"; tri(1); ctx.fill();
  ctx.fillStyle = "#ffd23a"; tri(0.72); ctx.fill();
  // tiny worker with a shovel and a heap
  ctx.fillStyle = "#1d1d1d"; ctx.strokeStyle = "#1d1d1d"; ctx.lineWidth = Math.max(0.7, 0.03 * m);
  ctx.beginPath(); ctx.arc(x - 0.02 * m, cy - 0.06 * m, 0.035 * m, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.moveTo(x - 0.04 * m, cy - 0.02 * m); ctx.lineTo(x - 0.08 * m, cy + 0.1 * m); ctx.lineTo(x - 0.12 * m, cy + 0.17 * m);
  ctx.moveTo(x - 0.08 * m, cy + 0.1 * m); ctx.lineTo(x - 0.02 * m, cy + 0.17 * m); ctx.moveTo(x - 0.05 * m, cy + 0.01 * m); ctx.lineTo(x + 0.07 * m, cy + 0.08 * m); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(x + 0.06 * m, cy + 0.19 * m); ctx.quadraticCurveTo(x + 0.13 * m, cy + 0.06 * m, x + 0.2 * m, cy + 0.19 * m); ctx.fill();
}

function pot(ctx: CanvasRenderingContext2D, x: number, y: number, m: number, paint: string) {
  shadow(ctx, x, y, 0.16 * m, 0.06 * m);
  ctx.fillStyle = "#c9ccd0"; ctx.fillRect(x - 0.12 * m, y - 0.26 * m, 0.24 * m, 0.24 * m);
  ctx.fillStyle = "#a9adb2"; ctx.beginPath(); ctx.ellipse(x, y - 0.02 * m, 0.12 * m, 0.04 * m, 0, 0, Math.PI); ctx.fill();
  ctx.fillStyle = paint; ctx.beginPath(); ctx.ellipse(x, y - 0.26 * m, 0.12 * m, 0.045 * m, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillRect(x - 0.12 * m, y - 0.26 * m, 0.05 * m, 0.1 * m); // a drip
}

function pile(ctx: CanvasRenderingContext2D, x: number, y: number, m: number) {
  ctx.fillStyle = "#8a6a4a"; ctx.beginPath(); ctx.ellipse(x, y, 0.42 * m, 0.16 * m, 0, Math.PI, 0); ctx.fill();
  ctx.beginPath(); ctx.ellipse(x, y, 0.42 * m, 0.08 * m, 0, 0, Math.PI); ctx.fill();
  ctx.fillStyle = "#a07c56"; ctx.beginPath(); ctx.ellipse(x - 0.08 * m, y - 0.09 * m, 0.18 * m, 0.07 * m, 0, Math.PI, 0); ctx.fill();
}

/** wheelbarrow with its wheel at (x, y); load = null when empty */
function wheelbarrow(ctx: CanvasRenderingContext2D, x: number, y: number, m: number, f: number, load: string | null) {
  shadow(ctx, x - f * 0.3 * m, y, 0.5 * m, 0.12 * m);
  ctx.strokeStyle = "#3d3d3d"; ctx.lineWidth = Math.max(1, 0.05 * m); ctx.lineCap = "round";
  ctx.beginPath(); ctx.moveTo(x - f * 0.95 * m, y - 0.78 * m); ctx.lineTo(x, y - 0.18 * m); ctx.stroke(); // handles to the wheel
  ctx.beginPath(); ctx.moveTo(x - f * 0.55 * m, y - 0.42 * m); ctx.lineTo(x - f * 0.6 * m, y - 0.02 * m); ctx.stroke(); // leg
  ctx.fillStyle = "#2f7d4f"; ctx.beginPath();
  ctx.moveTo(x - f * 0.7 * m, y - 0.62 * m); ctx.lineTo(x + f * 0.08 * m, y - 0.6 * m); ctx.lineTo(x - f * 0.08 * m, y - 0.3 * m); ctx.lineTo(x - f * 0.55 * m, y - 0.32 * m); ctx.closePath(); ctx.fill();
  if (load) { ctx.fillStyle = load; ctx.beginPath(); ctx.ellipse(x - f * 0.3 * m, y - 0.63 * m, 0.36 * m, 0.08 * m, 0, Math.PI, 0); ctx.fill(); }
  ctx.fillStyle = "#222"; ctx.beginPath(); ctx.arc(x, y - 0.16 * m, 0.16 * m, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#8b8f94"; ctx.beginPath(); ctx.arc(x, y - 0.16 * m, 0.06 * m, 0, Math.PI * 2); ctx.fill();
}
