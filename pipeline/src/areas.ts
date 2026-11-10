import { CAMERA, llhToPixel, useRegion } from "./camera.ts";

/** A rendered patch of a region (see places.ts); all pipeline steps work per area. */
export interface Area {
  title: string;
  region: string;
  /** south, west, north, east (WGS84) */
  bbox: [number, number, number, number];
}

export const AREAS: Record<string, Area> = {
  /**
   * Roma centro storico ampio: Vaticano → Termini, Villa Borghese → Testaccio/Aventino.
   * ~3.5 km × 5 km — first painted body while wider rings render.
   */
  "roma-core": {
    title: "Roma · Centro",
    region: "roma-centro",
    bbox: [41.882, 12.452, 41.912, 12.512],
  },
  /**
   * Anello urbano intorno al centro: Prati/Trastevere → San Giovanni, Parioli → Ostiense.
   * Complements roma-core (export merges tiles; overlapping centres keep the painted core).
   */
  "roma-inner": {
    title: "Roma · Città",
    region: "roma-centro",
    bbox: [41.860, 12.420, 41.935, 12.545],
  },
  /** Small pilot patch (kept for quick tests). */
  pantheon: {
    title: "Pantheon · Piazza Navona",
    region: "roma-centro",
    bbox: [41.8955, 12.4700, 41.9020, 12.4815],
  },
};

/** Look up an area and switch the camera to its region: call before any projection. */
export function openArea(name: string): Area {
  const area = AREAS[name];
  if (!area) throw new Error(`unknown area ${name}`);
  useRegion(area.region);
  return area;
}

/** Ground ellipsoid height used for area outlines (geoid ≈ 45–50 m in Rome + low terrain). */
export const GROUND_H = 55;

type Pt = [number, number];

/** Area outline in global art pixels (the bbox projected at ground level: a slanted quad). */
export function areaPolygon(bbox: [number, number, number, number]): Pt[] {
  const [s, w, n, e] = bbox;
  return [[s, w], [s, e], [n, e], [n, w]].map(([lat, lon]) => llhToPixel(lat, lon, GROUND_H));
}

export function inside([x, y]: Pt, poly: Pt[]) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

/** Render tiles whose centre lies inside the area outline. */
export function areaTiles(bbox: [number, number, number, number]) {
  const poly = areaPolygon(bbox);
  const xs = poly.map((p) => p[0]), ys = poly.map((p) => p[1]);
  const out: Array<[number, number]> = [];
  for (let ty = Math.floor(Math.min(...ys) / CAMERA.tile); ty <= Math.floor(Math.max(...ys) / CAMERA.tile); ty++)
    for (let tx = Math.floor(Math.min(...xs) / CAMERA.tile); tx <= Math.floor(Math.max(...xs) / CAMERA.tile); tx++)
      if (inside([(tx + 0.5) * CAMERA.tile, (ty + 0.5) * CAMERA.tile], poly)) out.push([tx, ty]);
  return out;
}

/** Distance (art px) from a point inside a convex outline to its nearest edge; ≤ 0 outside. */
export function insideDistance([x, y]: Pt, poly: Pt[]) {
  if (!inside([x, y], poly)) return 0;
  let d = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [ax, ay] = poly[j], [bx, by] = poly[i], dx = bx - ax, dy = by - ay;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
    d = Math.min(d, Math.hypot(x - ax - t * dx, y - ay - t * dy));
  }
  return d;
}
