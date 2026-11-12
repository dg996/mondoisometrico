/**
 * Cars as small lofted 3D models, drawn face by face on the 2D overlay (painter's order, Lambert + a
 * touch of specular from the render's sun). A car is a side profile (bumper, bonnet, windscreen,
 * roof, rear window, tail) swept through cross-sections that narrow above the beltline; faces above
 * the beltline in the cabin, and the steep windscreen / rear-window slopes, are glass.
 */
export type Vec3 = [number, number, number];
type Mat = "body" | "glass" | "dark" | "lamp" | "tail" | "roof" | "skirt" | "stripe";
interface Face { p: Vec3[]; n: Vec3; m: Mat }

/** [station along the length (−0.5 rear … +0.5 front), top height (× H), beltline (× H), width (× W, default 1)] */
type Profile = Array<[number, number, number, number?]>;
const PROFILES: Record<string, Profile> = {
  // five-door hatchback (Panda, Golf, Yaris…): short tail, long roof
  car: [[-0.5, 0.56, 0.5], [-0.47, 0.72, 0.56], [-0.40, 0.97, 0.58], [-0.28, 1.0, 0.58], [0.04, 1.0, 0.58], [0.21, 0.62, 0.58], [0.40, 0.56, 0.55], [0.5, 0.45, 0.45]],
  // city car (500, Smart): tall, almost no bonnet
  small: [[-0.5, 0.6, 0.52], [-0.46, 0.9, 0.56], [-0.30, 1.0, 0.57], [0.10, 1.0, 0.57], [0.30, 0.64, 0.57], [0.44, 0.56, 0.54], [0.5, 0.46, 0.46]],
  // saloon taxi (Toyota/Skoda style): boot, longer bonnet
  taxi: [[-0.5, 0.60, 0.56], [-0.40, 0.64, 0.58], [-0.27, 0.98, 0.58], [0.0, 1.0, 0.58], [0.17, 0.98, 0.58], [0.28, 0.62, 0.58], [0.43, 0.56, 0.55], [0.5, 0.46, 0.46]],
  // white van (Ducato): box with a short bonnet and a raked windscreen
  van: [[-0.5, 0.97, 0.5], [-0.45, 1.0, 0.5], [0.24, 1.0, 0.5], [0.36, 0.66, 0.5], [0.46, 0.45, 0.42], [0.5, 0.38, 0.38]],
  // ATAC city bus: a long box, windows from the waist to just under the roof, light roof
  bus: [[-0.5, 0.97, 0.36], [-0.495, 1.0, 0.36], [0.49, 1.0, 0.36], [0.5, 0.96, 0.36]],
  // low-floor tram car; the cab cars get a raked, tapering nose (tram-cab), middle cars square ends
  tram: [[-0.5, 0.96, 0.4], [-0.49, 1.0, 0.4], [0.49, 1.0, 0.4], [0.5, 0.96, 0.4]],
  "tram-cab": [[-0.5, 0.96, 0.4], [-0.49, 1.0, 0.4], [0.36, 1.0, 0.4], [0.44, 0.93, 0.4, 0.94], [0.49, 0.72, 0.38, 0.78], [0.5, 0.5, 0.36, 0.7]],
  // articulation bellows and roof equipment: plain boxes
  box: [[-0.5, 1.0, 0.0], [0.5, 1.0, 0.0]],
};

const meshes = new Map<string, Face[]>();

/** Model in local coordinates: x forward (a), y left (b), z up, origin at the centre on the ground. */
function mesh(kind: string, L: number, W: number, H: number, ends = 3): Face[] {
  const key = `${kind}:${L.toFixed(1)}:${W.toFixed(2)}:${H.toFixed(2)}:${ends}`;
  const hit = meshes.get(key);
  if (hit) return hit;
  const prof = PROFILES[kind] ?? PROFILES.car, zb = 0.2, faces: Face[] = [];
  // cross-section at a station: rounded hexagon, cabin narrower than the body
  const tramLike = kind === "tram" || kind === "tram-cab";
  const section = ([s, top, belt, wf = 1]: [number, number, number, number?]): Vec3[] => {
    const a = s * L, zt = top * H, zbelt = Math.min(belt * H, zt - 0.02), wb = (W / 2) * wf;
    const wt = kind === "bus" || kind === "van" || tramLike || kind === "box" ? W * 0.48 * wf : zt - zbelt > 0.25 ? W * 0.39 : W * 0.47;
    if (kind === "box") return [[a, -wb, 0], [a, -wb, zt], [a, wb, zt], [a, wb, 0]];
    if (tramLike) { // dark skirt to 30 %, coloured stripe to the beltline, windows to 86 %, light body, roof
      const zw = Math.min(zt - 0.05, H * 0.86), zs = Math.min(H * 0.3, zbelt - 0.05);
      return [[a, -wb * 0.96, zb], [a, -wb, zb + 0.18], [a, -wb, zs], [a, -wb, zbelt], [a, -wb, zw], [a, -wt, zt],
        [a, wt, zt], [a, wb, zw], [a, wb, zbelt], [a, wb, zs], [a, wb, zb + 0.18], [a, wb * 0.96, zb]];
    }
    if (kind === "bus") { // red skirt, window band to 86 %, red band and light roof above
      const zw = Math.min(zt - 0.05, H * 0.86);
      return [[a, -wb * 0.96, zb], [a, -wb, zb + 0.18], [a, -wb, zbelt], [a, -wb, zw], [a, -wt, zt], [a, wt, zt], [a, wb, zw], [a, wb, zbelt], [a, wb, zb + 0.18], [a, wb * 0.96, zb]];
    }
    return [[a, -wb * 0.94, zb], [a, -wb, zb + 0.18], [a, -wb, zbelt], [a, -wt, zt], [a, wt, zt], [a, wb, zbelt], [a, wb, zb + 0.18], [a, wb * 0.94, zb]];
  };
  const S = prof.map(section);
  const normal = (p: Vec3[]): Vec3 => {
    const u = [p[1][0] - p[0][0], p[1][1] - p[0][1], p[1][2] - p[0][2]], v = [p[2][0] - p[0][0], p[2][1] - p[0][1], p[2][2] - p[0][2]];
    const n: Vec3 = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]], l = Math.hypot(...n) || 1;
    return [n[0] / l, n[1] / l, n[2] / l];
  };
  for (let i = 0; i + 1 < S.length; i++) {
    const A = S[i], B = S[i + 1], cabin = prof[i][1] - prof[i][2] > 0.25 && prof[i + 1][1] - prof[i + 1][2] > 0.25;
    for (let j = 0; j + 1 < A.length; j++) {
      const p: Vec3[] = [A[j], A[j + 1], B[j + 1], B[j]];
      let n = normal(p);
      // outward: away from the car's core (the section's centre line at mid height)
      const cx = (p[0][0] + p[2][0]) / 2, cy = (p[0][1] + p[1][1] + p[2][1] + p[3][1]) / 4, cz = (p[0][2] + p[1][2] + p[2][2] + p[3][2]) / 4;
      if (n[1] * cy + n[2] * (cz - H * 0.45) + n[0] * cx * 0.15 < 0) n = [-n[0], -n[1], -n[2]];
      // material from the face's geometry: sills dark, glass between beltline and roof edge in the
      // cabin, steep windscreen / rear-window slopes glass, roof light on buses, the rest body
      const zMid = (p[0][2] + p[1][2] + p[2][2] + p[3][2]) / 4, zLo = Math.min(p[0][2], p[1][2]);
      const beltZ = Math.min(prof[i][2], prof[i + 1][2]) * H, topZ = Math.min(prof[i][1], prof[i + 1][1]) * H;
      let m: Mat = "body";
      if (kind === "box") m = "body";
      else if (tramLike) { // dark skirt, coloured stripe under the windows, window band, light body, roof
        if (n[2] > 0.85) m = "roof";
        else if (Math.abs(n[0]) > 0.4 && zMid > beltZ) m = "glass";      // raked windscreen of the cab
        else if (zMid < H * 0.3) m = "skirt";
        else if (zMid < beltZ) m = "stripe";
        else if (zMid < H * 0.86) m = "glass";
      }
      else if (zMid < zb + 0.16) m = "dark";
      else if (n[2] > 0.85) m = kind === "bus" ? "roof" : "body";
      else if (kind === "bus") m = zLo >= beltZ - 0.01 && zMid < H * 0.86 ? "glass" : "body";
      else if (cabin && zLo >= beltZ - 0.01 && zMid < topZ) m = "glass";
      else if (Math.abs(n[0]) > 0.45 && zMid > beltZ) m = "glass";
      faces.push({ p, n, m });
    }
    // underside
    const e = A.length - 1;
    faces.push({ p: [A[e], A[0], B[0], B[e]], n: [0, 0, -1], m: "dark" });
  }
  // end caps: tail at the back, nose at the front (with lamps)
  const cap = (sec: Vec3[], front: boolean) => {
    const p = front ? sec : [...sec].reverse();
    faces.push({ p, n: [front ? 1 : -1, 0, 0], m: kind === "tram" || kind === "tram-cab" ? "skirt" : "body" });
    if (kind === "box" || kind === "tram") return; // inner tram ends meet a bellows: no lamps
    if (kind === "tram-cab") {
      if (front) { const a = sec[0][0] + 0.01, w = (W / 2) * 0.7, z0 = H * 0.32, z1 = H * 0.42;
        for (const side of [1, -1]) faces.push({ p: [[a, side * w * 0.95, z0], [a, side * w * 0.55, z0], [a, side * w * 0.55, z1], [a, side * w * 0.95, z1]], n: [1, 0, 0], m: "lamp" }); }
      return;
    }
    const a = sec[0][0] + (front ? 0.01 : -0.01), z0 = sec[2][2] - 0.22, z1 = sec[2][2] - 0.05, w = W / 2;
    for (const side of [1, -1]) faces.push({ p: [[a, side * w * 0.85, z0], [a, side * w * 0.45, z0], [a, side * w * 0.45, z1], [a, side * w * 0.85, z1]], n: [front ? 1 : -1, 0, 0], m: front ? "lamp" : "tail" });
    if (kind === "bus" && (ends & (front ? 2 : 1))) { // windscreen at the front, rear window at the back (trams: only the outer ends)
      const g0 = sec[2][2] + (front ? -0.25 : 0.2), g1 = H * 0.86;
      faces.push({ p: [[a, -w * 0.9, g0], [a, w * 0.9, g0], [a, w * 0.9, g1], [a, -w * 0.9, g1]].map((q) => q as Vec3), n: [front ? 1 : -1, 0, 0], m: "glass" });
      if (front) faces.push({ p: [[a, -w * 0.7, H * 0.88], [a, w * 0.7, H * 0.88], [a, w * 0.7, H * 0.96], [a, -w * 0.7, H * 0.96]], n: [1, 0, 0], m: "lamp" }); // destination sign
    }
  };
  cap(S[0], false); cap(S[S.length - 1], true);
  meshes.set(key, faces);
  return faces;
}

const MAT: Record<Mat, [number, number, number]> = { body: [0, 0, 0], glass: [62, 82, 102], dark: [30, 31, 34], lamp: [250, 246, 226], tail: [196, 30, 30],
  roof: [232, 230, 224], skirt: [70, 72, 76], stripe: [214, 64, 40] };

/**
 * Draw one car. `toLocal`: ENU origin c, forward d; `proj` ENU -> screen; `view` the camera's view
 * direction in ENU (for back-face culling and painter's order); `sun` normalised light direction.
 */
export function drawCar(ctx: CanvasRenderingContext2D, proj: (p: Vec3) => [number, number], c: Vec3, d: [number, number],
  kind: string, L: number, W: number, H: number, color: [number, number, number], view: Vec3, sun: Vec3, pxPerM: number, taxi = false,
  ends = 3 /* bit 1 rear glass, bit 2 front glass (articulated cars: only at the train's ends) */) {
  const faces = mesh(kind, L, W, H, ends), r: [number, number] = [-d[1], d[0]]; // left of travel
  const world = (p: Vec3): Vec3 => [c[0] + d[0] * p[0] + r[0] * p[1], c[1] + d[1] * p[0] + r[1] * p[1], c[2] + p[2]];
  const rot = (n: Vec3): Vec3 => [d[0] * n[0] + r[0] * n[1], d[1] * n[0] + r[1] * n[1], n[2]];
  // wheels: dark discs at the four corners (drawn first, the body covers their upper half)
  const wheel = Math.max(0.28, H * 0.21), wa = L * 0.32;
  ctx.fillStyle = "#16171a";
  if (kind !== "box" && kind !== "tram" && kind !== "tram-cab") for (const a of [wa, -wa]) for (const b of [W / 2 - 0.05, -(W / 2 - 0.05)]) {
    const [x, y] = proj(world([a, b, wheel])), [x2, y2] = proj(world([a + wheel, b, wheel]));
    const rad = Math.max(0.8, Math.hypot(x2 - x, y2 - y));
    ctx.beginPath(); ctx.ellipse(x, y, rad, rad * 0.8, Math.atan2(y2 - y, x2 - x), 0, Math.PI * 2); ctx.fill();
  }
  const vis = faces.map((f) => ({ f, n: rot(f.n), w: f.p.map(world) }))
    .filter(({ n }) => n[0] * view[0] + n[1] * view[1] + n[2] * view[2] < 0.02)
    .map((o) => ({ ...o, depth: o.w.reduce((s, p) => s + p[0] * view[0] + p[1] * view[1] + p[2] * view[2], 0) / o.w.length }))
    .sort((a, b) => b.depth - a.depth);
  for (const { f, n, w } of vis) {
    const base = f.m === "body" ? color : MAT[f.m];
    const lam = Math.max(0, n[0] * sun[0] + n[1] * sun[1] + n[2] * sun[2]);
    let k = 0.58 + 0.5 * lam;
    if (f.m === "lamp" || f.m === "tail") k = 1;
    // specular: half vector between sun and the camera (−view)
    const hx = sun[0] - view[0], hy = sun[1] - view[1], hz = sun[2] - view[2], hl = Math.hypot(hx, hy, hz) || 1;
    const spec = f.m === "dark" ? 0 : Math.pow(Math.max(0, (n[0] * hx + n[1] * hy + n[2] * hz) / hl), f.m === "glass" ? 18 : 30) * (f.m === "glass" ? 120 : 70);
    const col = base.map((v) => Math.min(255, v * k + spec) | 0);
    ctx.fillStyle = `rgb(${col[0]},${col[1]},${col[2]})`;
    ctx.beginPath();
    w.forEach((p, i) => { const [x, y] = proj(p); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.closePath();
    ctx.fill();
    // hairline in the face colour closes antialiasing gaps between faces
    ctx.lineWidth = 0.5; ctx.strokeStyle = ctx.fillStyle; ctx.stroke();
  }
  const tram = kind === "tram" || kind === "tram-cab";
  if ((kind === "bus" || tram) && pxPerM > 3) { // window pillars every ~1.5 m and door leaves on the visible flank
    const side = (r[0] * view[0] + r[1] * view[1]) < 0 ? 1 : -1, y = side * (W / 2 + 0.01), z0 = H * (tram ? 0.4 : 0.36), z1 = H * 0.86;
    const line = (a: number, za: number, zb2: number, css: string, width: number) => {
      const [x1, y1] = proj(world([a, y, za])), [x2, y2] = proj(world([a, y, zb2]));
      ctx.strokeStyle = css; ctx.lineWidth = width; ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    };
    const pillar = tram ? "rgb(24,26,30)" : `rgb(${color.map((v) => Math.round(v * 0.62)).join(",")})`; // black frames on trams
    for (let a = -L / 2 + 1.2; a < L / 2 - (kind === "tram-cab" ? 2 : 1); a += 1.5) line(a, z0, z1, pillar, Math.max(0.6, pxPerM * (tram ? 0.08 : 0.12)));
    for (const a of tram ? [L * 0.22, -L * 0.28] : L > 15 ? [L * 0.38, L * 0.05, -L * 0.3] : [L * 0.38, -L * 0.05]) {
      ctx.fillStyle = "rgba(28,30,34,0.9)"; ctx.beginPath();
      [[a + 0.6, 0.25], [a - 0.6, 0.25], [a - 0.6, z1], [a + 0.6, z1]].forEach(([q, z], i) => { const [x, yy] = proj(world([q, y, z])); i ? ctx.lineTo(x, yy) : ctx.moveTo(x, yy); });
      ctx.closePath(); ctx.fill();
    }
  }
  if (taxi && pxPerM > 3) { // Rome taxi roof sign
    const z = H + 0.02, s: Vec3[] = [[0.25, 0.32, z], [-0.25, 0.32, z], [-0.25, -0.32, z], [0.25, -0.32, z]];
    ctx.fillStyle = "#f6f1df"; ctx.beginPath(); s.map(world).forEach((p, i) => { const [x, y] = proj(p); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.closePath(); ctx.fill();
  }
}
