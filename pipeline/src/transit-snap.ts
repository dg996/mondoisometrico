/** Tram tracks on the painted rails: GTFS shapes snapped to OSM rails (see snapToRails). */
import type { Point } from "./road-safety.ts";

/** segment [ax, ay, bx, by, length of its OSM way, index of its OSM way] */
export type RailIndex = { cell: number; grid: Map<string, Array<[number, number, number, number, number, number]>> };
/** shorter rail ways are crossovers / switch pieces: used only where no through rail is mapped */
const CROSSOVER = 45;
/** OSM rail segments (railway=tram among them: the rails the painting shows) on a 20 m grid. */
export function railIndex(lines: Point[][]): RailIndex {
  const cell = 20, grid = new Map<string, Array<[number, number, number, number, number, number]>>();
  for (const [id, l] of lines.entries()) {
    let len = 0;
    for (let i = 1; i < l.length; i++) len += Math.hypot(l[i][0] - l[i - 1][0], l[i][1] - l[i - 1][1]);
    for (let i = 1; i < l.length; i++) {
      const [ax, ay] = l[i - 1], [bx, by] = l[i], steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / (cell / 2)));
      const seen = new Set<string>();
      for (let k = 0; k <= steps; k++) { // every cell the segment passes, however long it is
        const t = k / steps, c = `${Math.floor((ax + (bx - ax) * t) / cell)}_${Math.floor((ay + (by - ay) * t) / cell)}`;
        if (seen.has(c)) continue; seen.add(c);
        (grid.get(c) ?? grid.set(c, []).get(c)!).push([ax, ay, bx, by, len, id]);
      }
    }
  }
  return { cell, grid };
}

/**
 * GTFS tram shapes follow the street, not the rails, give both directions the same line and jog
 * toward each stop. Put every sample on the OSM rail of its own direction:
 *  - per sample, among the parallel rails within 7 m, the rightmost of the nearest pair (Rome runs
 *    on the right; double track centres ~3.5 m apart);
 *  - then a vote over ±30 m on which OSM rail that is, so a stop jog, a crossover (short rail ways
 *    are used only where no through rail is mapped) or one odd sample cannot pull the tram across;
 *  - the tram runs on the rail itself (lightly smoothed); gaps up to 30 m are bridged straight,
 *    longer stretches without a mapped rail keep 1.75 m right of the shape.
 */
export function snapToRails(pts: Array<[number, number]>, rails: RailIndex) {
  const n = pts.length;
  const dirAt = (i: number) => { const a = pts[Math.max(0, i - 3)], b = pts[Math.min(n - 1, i + 3)], dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1; return [dx / L, dy / L]; };
  const cands: Array<Map<number, [number, number]> | null> = new Array(n).fill(null); // rail id -> nearest point
  const rule: number[] = new Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    const [dx, dy] = dirAt(i), [px, py] = pts[i];
    const cx = Math.floor(px / rails.cell), cy = Math.floor(py / rails.cell);
    let cand: Array<{ lat: number; q: [number, number]; through: boolean; id: number; d: number }> = [];
    for (let u = -1; u <= 1; u++) for (let v = -1; v <= 1; v++) for (const [ax, ay, bx, by, wl, id] of rails.grid.get(`${cx + u}_${cy + v}`) ?? []) {
      const sx = bx - ax, sy = by - ay, SL = Math.hypot(sx, sy);
      if (SL < 0.1 || Math.abs((sx * dx + sy * dy) / SL) < 0.85) continue; // not parallel: a crossing track
      const t = Math.max(0, Math.min(1, ((px - ax) * sx + (py - ay) * sy) / (SL * SL)));
      const q: [number, number] = [ax + sx * t, ay + sy * t], d = Math.hypot(q[0] - px, q[1] - py);
      if (d > 7) continue;
      cand.push({ lat: dx * (q[1] - py) - dy * (q[0] - px), q, through: wl >= CROSSOVER, id, d }); // + left of travel, − right
    }
    if (!cand.length) continue;
    if (cand.some((c) => c.through)) cand = cand.filter((c) => c.through);
    const m = new Map<number, [number, number]>(), best = new Map<number, number>();
    for (const c of cand) if (!m.has(c.id) || c.d < best.get(c.id)!) { m.set(c.id, c.q); best.set(c.id, c.d); }
    cands[i] = m;
    const near = cand.reduce((a, c) => (Math.abs(c.lat) < Math.abs(a.lat) ? c : a));
    rule[i] = cand.filter((c) => c.lat >= near.lat - 4.5 && c.lat <= near.lat + 0.5).reduce((a, c) => (c.lat < a.lat ? c : a)).id;
  }
  const snap: Array<[number, number] | null> = cands.map((m, i) => {
    if (!m) return null;
    const votes = new Map<number, number>();
    for (let j = Math.max(0, i - 15); j <= Math.min(n - 1, i + 15); j++) if (rule[j] >= 0 && m.has(rule[j])) votes.set(rule[j], (votes.get(rule[j]) ?? 0) + 1);
    const win = [...votes].sort((a, b) => b[1] - a[1])[0]?.[0] ?? rule[i];
    return m.get(win) ?? m.get(rule[i])!;
  });
  const on = snap.filter((p) => p !== null).length;
  // fill: bridge short gaps straight between rail points, otherwise 1.75 m right of the shape
  const raw: Array<[number, number]> = pts.map(([px, py], i) => {
    if (snap[i]) return snap[i]!;
    let a = i - 1, b = i + 1;
    while (a >= 0 && !snap[a]) a--;
    while (b < n && !snap[b]) b++;
    if (a >= 0 && b < n && b - a <= 15) { const f = (i - a) / (b - a); return [snap[a]![0] + (snap[b]![0] - snap[a]![0]) * f, snap[a]![1] + (snap[b]![1] - snap[a]![1]) * f]; }
    const [dx, dy] = dirAt(i);
    return [px + dy * 1.75, py - dx * 1.75];
  });
  // light smoothing (±4 m) so the vertices of the OSM polyline do not kink the cars
  const out = raw.map((_, i) => {
    let x = 0, y = 0, k = 0;
    for (let j = Math.max(0, i - 2); j <= Math.min(n - 1, i + 2); j++) { x += raw[j][0]; y += raw[j][1]; k++; }
    return [x / k, y / k] as [number, number];
  });
  return { pts: out, on };
}
