/**
 * City walls drawn as walls (issues #10, #11). OSM maps most of the Mura Aureliane as
 * barrier=city_wall LINES, which the scene never extruded (the stretch along Viale Castrense was
 * simply missing), and a few stretches as building=city_wall OUTLINES, which became rows of
 * palazzi with windows and roofs (Viale di Porta Ardeatina). Here both become one solid wall of
 * Roman brick, no windows, no roof, cut into short pieces so it follows the ground.
 *
 * Dimensions are only for walls whose size is documented in open sources (none of them is in the
 * CTRN 2002-2003 volumes: 3% of the wall length). Add a wall here only with a verified height.
 */
import polygonClipping from "polygon-clipping";

type P2 = [number, number];

export interface WallSpec {
  /** wall top above the ground at its foot (m) */
  height: number;
  /** thickness of the curtain (m); a line is thickened to this */
  thickness: number;
  wallColor: string;
  /** wall-walk */
  roofColor: string;
}

/**
 * it.wikipedia "Mura aureliane" (checked 2026-11-15): 6-8 m high and 3.3 m thick under Aurelian,
 * raised under Honorius (c. 403) "ad almeno 10,50-15" m, towers every 30 m. 13 m is the middle of
 * that range; an OSM `height` / `width` on the way wins.
 */
const WALLS: Array<{ name: RegExp; spec: WallSpec }> = [
  { name: /^(mura aureliane|aurelian walls?)$/i, spec: { height: 13, thickness: 3.5, wallColor: "#a8664a", roofColor: "#8f7a62" } },
];

/** Renderer style index of a city wall (page/renderer.ts): brick courses, merlons, no windows. */
export const WALL_STYLE = 9;

/** OSM tags of a city wall line or outline (any wall, named or not). */
export const isCityWall = (t: Record<string, string>) =>
  t.barrier === "city_wall" || t.historic === "citywalls" || /^city_?walls?$/.test(t.building ?? "");

const sized = (spec: WallSpec, t: Record<string, string>): WallSpec => {
  const h = parseFloat(t.height), th = parseFloat(t.width);
  return { ...spec, height: h > 2 && h < 40 ? h : spec.height, thickness: th > 0.5 && th < 15 ? th : spec.thickness };
};

/** The wall a NAMED OSM element belongs to (barrier=city_wall line or building=city_wall outline), or null. */
export function cityWall(t: Record<string, string>): WallSpec | null {
  if (!isCityWall(t)) return null;
  const names = [t.name, t["name:it"], t["name:en"]].filter((n): n is string => !!n);
  const w = WALLS.find((w) => names.some((n) => w.name.test(n.trim())));
  return w ? sized(w.spec, t) : null;
}

/**
 * Named walls plus the unnamed wall elements that run along them. OSM has unnamed building=city_wall
 * outlines on stretches it also maps as named Mura Aureliane lines (relation 14279973, Porta Ardeatina to
 * Porta San Sebastiano); left out they stood behind the new wall as a 20 m palazzo. An unnamed wall is
 * taken when most of its vertices lie near a named one; one that only touches it (Vatican, Gianicolo) is not.
 */
export class WallMatcher {
  private grid = new Map<string, Array<{ a: P2; b: P2; spec: WallSpec }>>();
  constructor(named: Array<{ line: P2[]; spec: WallSpec }>, private near = 25, private share = 0.8, private cell = 50) {
    for (const { line, spec } of named)
      for (let i = 1; i < line.length; i++) {
        const seg = { a: line[i - 1], b: line[i], spec };
        for (let gx = Math.floor((Math.min(seg.a[0], seg.b[0]) - near) / cell); gx <= Math.floor((Math.max(seg.a[0], seg.b[0]) + near) / cell); gx++)
          for (let gy = Math.floor((Math.min(seg.a[1], seg.b[1]) - near) / cell); gy <= Math.floor((Math.max(seg.a[1], seg.b[1]) + near) / cell); gy++)
            (this.grid.get(`${gx}_${gy}`) ?? this.grid.set(`${gx}_${gy}`, []).get(`${gx}_${gy}`)!).push(seg);
      }
  }
  /** spec of the named wall within `near` m of p, or null */
  private at([x, y]: P2): WallSpec | null {
    for (const { a, b, spec } of this.grid.get(`${Math.floor(x / this.cell)}_${Math.floor(y / this.cell)}`) ?? []) {
      const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy || 1e-9, u = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / L));
      if (Math.hypot(x - a[0] - u * dx, y - a[1] - u * dy) <= this.near) return spec;
    }
    return null;
  }
  /** The wall of an element with tags `t` and vertices `pts` (ENU m), or null. */
  match(t: Record<string, string>, pts: P2[]): WallSpec | null {
    const named = cityWall(t);
    if (named || !isCityWall(t) || !pts.length) return named;
    const hits = pts.map((p) => this.at(p)).filter((s): s is WallSpec => !!s);
    return hits.length >= this.share * pts.length ? sized(hits[0], t) : null;
  }
}

const close = (r: P2[]) => (r.length && (r[0][0] !== r[r.length - 1][0] || r[0][1] !== r[r.length - 1][1]) ? [...r, r[0]] : r);
const open = (r: P2[]) => (r.length > 1 && r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1] ? r.slice(0, -1) : r);
const area2 = (r: P2[]) => { let a = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] - r[i][0]) * (r[j][1] + r[i][1]); return a / 2; };

/** A line thickened to `thickness`: one rectangle per segment, with square caps so joints stay closed. */
export function thickLine(line: P2[], thickness: number): P2[][] {
  const half = thickness / 2, out: P2[][] = [];
  for (let i = 1; i < line.length; i++) {
    const [ax, ay] = line[i - 1], [bx, by] = line[i], L = Math.hypot(bx - ax, by - ay);
    if (L < 0.05) continue;
    const ux = (bx - ax) / L, uy = (by - ay) / L, nx = -uy * half, ny = ux * half, ex = ux * half, ey = uy * half;
    out.push([[ax - ex + nx, ay - ey + ny], [ax - ex - nx, ay - ey - ny], [bx + ex - nx, by + ey - ny], [bx + ex + nx, by + ey + ny]]);
  }
  return out;
}

/** Proper crossing point of segments ab and cd (both strictly inside, not at an end), or null. */
export function crossing(a: P2, b: P2, c: P2, d: P2, margin = 0.02): P2 | null {
  const rx = b[0] - a[0], ry = b[1] - a[1], sx = d[0] - c[0], sy = d[1] - c[1], den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((c[0] - a[0]) * sy - (c[1] - a[1]) * sx) / den, u = ((c[0] - a[0]) * ry - (c[1] - a[1]) * rx) / den;
  return t > margin && t < 1 - margin && u > margin && u < 1 - margin ? [a[0] + t * rx, a[1] + t * ry] : null;
}

/**
 * Wall solids as polygons ([outer, ...holes], CCW outer, open rings), cut on a `cell` metre grid:
 * the renderer seats a solid on the highest ground under it, so a 400 m wall in one piece would have
 * a level top and stand 25 m tall in the dips. `shapes` are thickened lines and OSM outlines;
 * `gaps` (road openings) are cut out.
 */
export function wallPieces(shapes: P2[][], gaps: P2[][] = [], cell = 10): P2[][][] {
  const byCell = new Map<string, P2[][]>(), gapCells = new Map<string, P2[][]>();
  const bin = (map: Map<string, P2[][]>, r: P2[]) => {
    const xs = r.map((p) => p[0]), ys = r.map((p) => p[1]);
    for (let gx = Math.floor(Math.min(...xs) / cell); gx <= Math.floor(Math.max(...xs) / cell); gx++)
      for (let gy = Math.floor(Math.min(...ys) / cell); gy <= Math.floor(Math.max(...ys) / cell); gy++)
        (map.get(`${gx}_${gy}`) ?? map.set(`${gx}_${gy}`, []).get(`${gx}_${gy}`)!).push(r);
  };
  for (const s of shapes) if (s.length >= 3) bin(byCell, open(s));
  for (const g of gaps) if (g.length >= 3) bin(gapCells, open(g));
  const out: P2[][][] = [];
  for (const [k, rings] of [...byCell].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const [gx, gy] = k.split("_").map(Number), x0 = gx * cell, y0 = gy * cell;
    const square: P2[] = [[x0, y0], [x0 + cell, y0], [x0 + cell, y0 + cell], [x0, y0 + cell], [x0, y0]];
    let pieces: P2[][][];
    try {
      pieces = polygonClipping.intersection([square], polygonClipping.union([close(rings[0])], ...rings.slice(1).map((r) => [close(r)])));
      const cut = gapCells.get(k);
      if (cut?.length && pieces.length) pieces = polygonClipping.difference(pieces, ...cut.map((r) => [close(r)]));
    } catch { continue; } // degenerate input in this cell: leave a gap rather than a wrong solid
    for (const poly of pieces) {
      const [outer, ...holes] = poly.map(open);
      if (outer.length < 3 || Math.abs(area2(outer)) - holes.reduce((t, h) => t + Math.abs(area2(h)), 0) < 0.5) continue;
      out.push([area2(outer) < 0 ? outer.reverse() : outer, ...holes]);
    }
  }
  return out;
}
