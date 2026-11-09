/**
 * Geometric QA for painted windows: GPT image edits can drift (small shift / scale).
 * Register the painted image to the render by maximising normalised cross-correlation of
 * edge maps over scale × shift, warp it back into place, and report the match score.
 */
import sharp from "sharp";
import { writeAtomic } from "./paths.ts";

const S = 256; // analysis resolution

async function edges(file: string | Buffer) {
  const g = await sharp(file).resize(S, S, { fit: "fill" }).greyscale().blur(0.8).raw().toBuffer();
  const e = new Float32Array(S * S);
  for (let y = 1; y < S - 1; y++)
    for (let x = 1; x < S - 1; x++) {
      const i = y * S + x;
      const gx = g[i + 1 - S] + 2 * g[i + 1] + g[i + 1 + S] - g[i - 1 - S] - 2 * g[i - 1] - g[i - 1 + S];
      const gy = g[i + S - 1] + 2 * g[i + S] + g[i + S + 1] - g[i - S - 1] - 2 * g[i - S] - g[i - S + 1];
      e[i] = Math.hypot(gx, gy);
    }
  return e;
}

function ncc(a: Float32Array, b: Float32Array, s: number, dx: number, dy: number, m = 12) {
  // b is sampled at the location the painted pixel came from: p_b = (p - c - d) / s + c
  let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0, n = 0;
  const c = S / 2;
  for (let y = m; y < S - m; y += 2)
    for (let x = m; x < S - m; x += 2) {
      const bx = Math.round((x - c - dx) / s + c), by = Math.round((y - c - dy) / s + c);
      if (bx < 0 || by < 0 || bx >= S || by >= S) continue;
      const va = a[y * S + x], vb = b[by * S + bx];
      sa += va; sb += vb; saa += va * va; sbb += vb * vb; sab += va * vb; n++;
    }
  const cov = sab / n - (sa / n) * (sb / n);
  return cov / Math.sqrt((saa / n - (sa / n) ** 2) * (sbb / n - (sb / n) ** 2) + 1e-9);
}

export interface Registration { scale: number; dx: number; dy: number; score: number; identity: number; texture: number }

/** Find scale/shift (in full-res pixels) that best maps `painted` onto `reference`. */
export async function register(reference: string, painted: string, size = 1024): Promise<Registration> {
  const a = await edges(reference), b = await edges(painted);
  const identity = ncc(a, b, 1, 0, 0);
  // share of the reference with real structure (strong edges); ~0 for open sea
  let strong = 0;
  for (const v of a) if (v > 60) strong++;
  const texture = strong / a.length;
  let best = { scale: 1, dx: 0, dy: 0, score: identity };
  for (let s = 0.96; s <= 1.0401; s += 0.01)
    for (let dy = -10; dy <= 10; dy++)
      for (let dx = -10; dx <= 10; dx++) {
        const v = ncc(a, b, s, dx, dy);
        if (v > best.score) best = { scale: s, dx, dy, score: v };
      }
  const k = size / S;
  return { scale: best.scale, dx: best.dx * k, dy: best.dy * k, score: best.score, identity, texture };
}

/** Warp the painted image by the registration so it overlays the reference. */
export async function applyRegistration(painted: string, out: string, r: Registration, size = 1024) {
  if (r.scale === 1 && r.dx === 0 && r.dy === 0) return writeAtomic(sharp(painted).resize(size, size).png(), out);
  const src = await sharp(painted).resize(size, size).removeAlpha().raw().toBuffer();
  const dst = Buffer.alloc(size * size * 3);
  const c = size / 2;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      // output pixel p shows painted pixel at (p - c - d) / s + c (inverse of the found mapping)
      const sx = (x - c - r.dx) / r.scale + c, sy = (y - c - r.dy) / r.scale + c;
      const x0 = Math.max(0, Math.min(size - 2, Math.floor(sx))), y0 = Math.max(0, Math.min(size - 2, Math.floor(sy)));
      const fx = Math.min(1, Math.max(0, sx - x0)), fy = Math.min(1, Math.max(0, sy - y0));
      for (let ch = 0; ch < 3; ch++) {
        const i = (yy: number, xx: number) => src[(yy * size + xx) * 3 + ch];
        dst[(y * size + x) * 3 + ch] = (i(y0, x0) * (1 - fx) + i(y0, x0 + 1) * fx) * (1 - fy) + (i(y0 + 1, x0) * (1 - fx) + i(y0 + 1, x0 + 1) * fx) * fy;
      }
    }
  return writeAtomic(sharp(dst, { raw: { width: size, height: size, channels: 3 } }).png(), out);
}
