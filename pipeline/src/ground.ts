/**
 * Build the ground an area stands on, from open data only:
 *   terrain  Copernicus GLO-30 (a surface model: buildings are removed with a morphological
 *            opening + blur, which is plenty for flat Gush Dan), sea/lakes flattened from OSM
 *   surface  OSM roads at real widths, pavements, landuse, parks, beach, water, rail
 *
 *   npm -w pipeline run ground -- pantheon
 *
 * Output: data/derived/<area>/ground/meta.json     grid origin/step/size (ENU meters)
 *         data/derived/<area>/ground/height.bin    Float32 ENU "up" of the ground per grid node
 *         data/derived/<area>/ground/features.json drawable features in ENU (see Feature)
 */
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { openArea } from "./areas.ts";
import { camera, ecefToEnu, llhToEcef } from "./camera.ts";
import { DERIVED, RAW, readJson } from "./paths.ts";
import { SEA_H } from "./heights.ts";
import { ROAD, belowSurface, isOneway, roadWidth, wayLength } from "./roadspec.ts";
import { existsSync } from "node:fs";
import type { CtrnUnit } from "./ctrn.ts";

type P2 = [number, number];
/** Geoid undulation: orthometric (MSL) + this = ellipsoid height (= sea level). */
const GEOID = SEA_H;
const STEP = 10;
const MARGIN = 0.02;
const R_EARTH = 6371000;

/**
 * k: kind (drawn by page/renderer.ts), r: polygon rings (even-odd) or l: polyline,
 * w: line width (m), o: one-way, n: lanes, y: layer (bridges above)
 */
export interface Feature { id?: number; bridge?: boolean; k: string; r?: P2[][]; l?: P2[]; w?: number; o?: 1; n?: number; y?: number; j?: number[][]; s?: 1; sw?: 0 }

const name = process.argv[2] ?? "roma-core";
const area = openArea(name);
const [S, W, N, E] = area.bbox;
const bb = [S - MARGIN, W - MARGIN, N + MARGIN, E + MARGIN];
const out = join(DERIVED, name, "ground");
mkdirSync(out, { recursive: true });

const toEnu = (lon: number, lat: number): P2 => { const p = ecefToEnu(llhToEcef(lat, lon, 0)); return [p[0], p[1]]; };
const r1 = (v: number) => Math.round(v * 10) / 10;

// ---- geometry helpers --------------------------------------------------------------------------
function simplifyLine(r: P2[], tol: number): P2[] {
  if (r.length <= 2) return r;
  const keep = new Uint8Array(r.length);
  keep[0] = keep[r.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, r.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let best = -1, bi = -1;
    const [ax, ay] = r[a], [bx, by] = r[b];
    const L = Math.hypot(bx - ax, by - ay) || 1e-9;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((bx - ax) * (ay - r[i][1]) - (ax - r[i][0]) * (by - ay)) / L;
      if (d > best) { best = d; bi = i; }
    }
    if (best > tol) { keep[bi] = 1; stack.push([a, bi], [bi, b]); }
  }
  return r.filter((_, i) => keep[i]).map(([x, y]) => [r1(x), r1(y)]);
}

/** Douglas-Peucker on a closed ring: split at the vertex farthest from the start (a zero chord keeps nothing). */
function simplifyRing(r: P2[], tol: number): P2[] {
  let far = 0;
  r.forEach((p, i) => { if (Math.hypot(p[0] - r[0][0], p[1] - r[0][1]) > Math.hypot(r[far][0] - r[0][0], r[far][1] - r[0][1])) far = i; });
  if (far === 0) return [];
  return [...simplifyLine(r.slice(0, far + 1), tol).slice(0, -1), ...simplifyLine([...r.slice(far), r[0]], tol)];
}

/** Join way pieces sharing endpoints into chains (closed rings where they close). */
function joinWays(pieces: P2[][]): P2[][] {
  const key = (p: P2) => `${p[0].toFixed(2)},${p[1].toFixed(2)}`;
  const left = pieces.filter((p) => p.length >= 2).map((p) => [...p]);
  const out: P2[][] = [];
  while (left.length) {
    let chain = left.pop()!;
    for (let grown = true; grown && key(chain[0]) !== key(chain.at(-1)!);) {
      grown = false;
      for (let i = 0; i < left.length; i++) {
        const p = left[i], a = key(p[0]), b = key(p.at(-1)!);
        if (a === key(chain.at(-1)!)) chain = [...chain, ...p.slice(1)];
        else if (b === key(chain.at(-1)!)) chain = [...chain, ...p.slice(0, -1).reverse()];
        else if (b === key(chain[0])) chain = [...p, ...chain.slice(1)];
        else if (a === key(chain[0])) chain = [...p.slice(1).reverse(), ...chain];
        else continue;
        left.splice(i, 1);
        grown = true;
        break;
      }
    }
    out.push(chain);
  }
  return out;
}
const closed = (c: P2[]) => c.length > 3 && c[0][0] === c.at(-1)![0] && c[0][1] === c.at(-1)![1];

/** Scanline fill of even-odd polygon rings over the grid: cb(ix, iy) for nodes inside. */
function fillGrid(rings: P2[][], g: Grid, cb: (i: number) => void) {
  let y0 = Infinity, y1 = -Infinity;
  for (const r of rings) for (const p of r) { y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); }
  const iy0 = Math.max(0, Math.ceil((y0 - g.y0) / STEP)), iy1 = Math.min(g.ny - 1, Math.floor((y1 - g.y0) / STEP));
  for (let iy = iy0; iy <= iy1; iy++) {
    const y = g.y0 + iy * STEP, xs: number[] = [];
    for (const r of rings)
      for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
        const [xi, yi] = r[i], [xj, yj] = r[j];
        if (yi > y !== yj > y) xs.push(xi + ((y - yi) * (xj - xi)) / (yj - yi));
      }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const a = Math.max(0, Math.ceil((xs[k] - g.x0) / STEP)), b = Math.min(g.nx - 1, Math.floor((xs[k + 1] - g.x0) / STEP));
      for (let ix = a; ix <= b; ix++) cb(iy * g.nx + ix);
    }
  }
}

// ---- OSM features --------------------------------------------------------------------------
const PATH: Record<string, number> = { pedestrian: 5, footway: 2.2, path: 1.6, cycleway: 2, steps: 2.5, bridleway: 2, corridor: 2 };

function areaKind(t: Record<string, string>): string | null {
  const lu = t.landuse, le = t.leisure, na = t.natural, am = t.amenity;
  if (na === "water" || t.water || t.waterway === "riverbank" || lu === "basin" || lu === "reservoir") return "water";
  if (le === "swimming_pool") return "pool";
  if (na === "beach" || na === "sand") return "sand";
  if (le === "pitch" || le === "stadium") return "pitch";
  if (le === "track") return "track";
  if (le === "playground") return "playground";
  if (na === "wood" || lu === "forest") return "wood";
  if (["scrub", "grassland", "heath", "wetland", "bare_rock"].includes(na)) return "scrub";
  if (lu === "cemetery" || am === "grave_yard") return "cemetery";
  if (["park", "garden", "dog_park", "golf_course", "recreation_ground", "nature_reserve"].includes(le)
    || ["grass", "meadow", "village_green", "recreation_ground", "flowerbed"].includes(lu)) return "park";
  if (["farmland", "orchard", "allotments", "plant_nursery", "greenhouse_horticulture", "vineyard"].includes(lu)) return "farm";
  if (["construction", "brownfield", "greenfield", "landfill"].includes(lu)) return "dirt";
  if (am === "parking") return "parking";
  if (t["area:highway"] || t.place === "square" || (t.highway === "pedestrian" && t.area === "yes")
    || ["pier", "breakwater", "groyne"].includes(t.man_made)) return "paving";
  if (["school", "university", "college", "hospital"].includes(am)) return "campus";
  if (["industrial", "railway", "port", "military", "depot", "garages"].includes(lu)) return "industrial";
  if (["commercial", "retail"].includes(lu)) return "commercial";
  if (lu === "residential") return "residential";
  return null;
}

const osm = readJson(join(RAW, name, "ground.json"));

// Rome: street widths from the surveyed building fronts (Regione Lazio CTRN volumes). OSM lanes count
// only moving lanes, so Via del Corso / Via Nazionale came out 12 m wide between façades 20–32 m apart
// and the rest read as empty ground. Where a street has buildings on BOTH sides, the carriageway grows
// to the façade gap minus the pavements (never narrower than OSM, never more than 2.2× OSM).
const facadeSegs = new Map<string, number[][]>(), FCELL = 30;
if (area.region === "roma-centro" && existsSync(join(RAW, "ctrn", "units.json"))) {
  const [S0, W0, N0, E0] = bb;
  for (const u of readJson<CtrnUnit[]>(join(RAW, "ctrn", "units.json"))) {
    if (!u.r.some(([lo, la]) => la > S0 && la < N0 && lo > W0 && lo < E0)) continue;
    const p = u.r.map(([lo, la]) => toEnu(lo, la));
    for (let k = 1; k < p.length; k++) {
      const sg = [p[k - 1][0], p[k - 1][1], p[k][0], p[k][1]];
      for (let gx = Math.floor(Math.min(sg[0], sg[2]) / FCELL); gx <= Math.floor(Math.max(sg[0], sg[2]) / FCELL); gx++)
        for (let gy = Math.floor(Math.min(sg[1], sg[3]) / FCELL); gy <= Math.floor(Math.max(sg[1], sg[3]) / FCELL); gy++)
          (facadeSegs.get(`${gx}_${gy}`) ?? facadeSegs.set(`${gx}_${gy}`, []).get(`${gx}_${gy}`)!).push(sg);
    }
  }
}
/** Distance along a ray to the nearest surveyed building edge (≤ 40 m), else Infinity. */
function facade(px: number, py: number, dx: number, dy: number) {
  let best = Infinity;
  for (let t = 0; t <= 40; t += FCELL / 2) for (const s of facadeSegs.get(`${Math.floor((px + dx * t) / FCELL)}_${Math.floor((py + dy * t) / FCELL)}`) ?? []) {
    const ex = s[2] - s[0], ey = s[3] - s[1], den = dx * ey - dy * ex;
    if (Math.abs(den) < 1e-9) continue;
    const tt = ((s[0] - px) * ey - (s[1] - py) * ex) / den, u = ((s[0] - px) * dy - (s[1] - py) * dx) / den;
    if (tt > 0 && tt <= 40 && u >= 0 && u <= 1) best = Math.min(best, tt);
  }
  return best;
}
/** Median façade-to-façade gap along a street (segments with buildings on both sides only). */
function facadeGap(g: P2[]): number | null {
  if (!facadeSegs.size) return null;
  const gaps: number[] = [];
  for (let k = 1; k < g.length; k++) {
    const L = Math.hypot(g[k][0] - g[k - 1][0], g[k][1] - g[k - 1][1]);
    for (let d = 4; d < L - 2; d += 12) {
      const f = d / L, cx = g[k - 1][0] + (g[k][0] - g[k - 1][0]) * f, cy = g[k - 1][1] + (g[k][1] - g[k - 1][1]) * f;
      const nx = -(g[k][1] - g[k - 1][1]) / L, ny = (g[k][0] - g[k - 1][0]) / L;
      const a = facade(cx, cy, nx, ny), b = facade(cx, cy, -nx, -ny);
      if (a + b < 45) gaps.push(a + b);
    }
  }
  return gaps.length >= 2 ? gaps.sort((x, y) => x - y)[Math.floor(gaps.length / 2)] : null;
}
let widened = 0;
const features: Feature[] = [];
const water: P2[][][] = [];
const coast: P2[][] = [];
/** road node id -> how many road ways use it (2+ = junction), widest road there */
const nodeUse = new Map<number, { n: number; w: number; foot: boolean; y: number; k: string; s?: boolean }>();
const footNodes = new Set<number>();
let crossings = 0;
const nodePos = new Map<number, [P2, P2, number]>(); // position, a neighbour along the road, road width
const geom = (g: Array<{ lat: number; lon: number }>) => g.map((q) => toEnu(q.lon, q.lat));
let hidden = 0;

for (const el of osm.elements) {
  const t: Record<string, string> = el.tags ?? {};
  if (t.natural === "coastline" && el.geometry) { coast.push(geom(el.geometry)); continue; }
  // metro, underpasses, station corridors, covered galleries: not on the open surface
  if ((t.highway || t.railway || t["area:highway"]) && belowSurface(t, el.geometry ? wayLength(el.geometry) : Infinity)) { hidden++; continue; }
  let rings: P2[][] | null = null;
  if (el.type === "way" && el.geometry) {
    const g = geom(el.geometry);
    if (closed(g) && !(t.highway && t.area !== "yes") && !t.railway) rings = [g];
    else if (t.highway || t.railway || ["breakwater", "groyne", "pier"].includes(t.man_made)) {
      if (t.railway && !/^(rail|light_rail|tram|narrow_gauge)$/.test(t.railway)) continue; // platforms, abandoned
      const l = simplifyLine(g, 0.3);
      const layer = Number(t.layer) || (t.bridge && t.bridge !== "no" ? 1 : 0);
      // rail bridges (Tiber, Ponte dell'Industria, viaducts) get a deck like road bridges; before, the
      // tracks were painted flat across the water
      if (t.railway) {
        const railBridge = !!t.bridge && t.bridge !== "no";
        features.push({ k: "rail", l: railBridge ? g : l, ...(layer > 0 ? { y: layer } : {}), ...(railBridge ? { id: el.id, bridge: true, w: 3.6 * Math.max(1, Number(t.tracks) || 1) + 1.2 } : {}) });
        continue;
      }
      if (t.man_made) { features.push({ k: "pier", l, w: Number(t.width) || 4 }); continue; }
      const road = ROAD[t.highway], path = PATH[t.highway];
      if (!road && !path) continue;
      // OSM marked crossings (footway=crossing): drawn as real zebra stripes over the asphalt
      if (t.footway === "crossing") {
        const marked = !["unmarked", "no", "informal"].includes(t.crossing ?? "") && t["crossing:markings"] !== "no";
        if (marked) { features.push({ k: "crossing", l: g }); crossings++; continue; }
      }
      // sampietrini / cobbles (OSM surface) and pavements (OSM sidewalk tags; separately mapped
      // footway=sidewalk ways are drawn as paths, so the street gets no second pavement)
      const sett = /^(sett|cobblestone|unhewn_cobblestone|paving_stones)$/.test(t.surface ?? "");
      const sidewalkTag = t.sidewalk ?? t["sidewalk:both"];
      const noSidewalk = /^(no|none|separate)$/.test(sidewalkTag ?? "")
        || (!sidewalkTag && sett && /^(residential|living_street|service|unclassified|pedestrian)$/.test(t.highway)); // Roman vicoli in sampietrini
      const oneway = isOneway(t);
      const lanes = Number(t.lanes) || 0;
      let w = road ? roadWidth(t) : Number(String(t.width).replace(",", ".")) || path;
      // explicit OSM width wins; otherwise fit the street between the surveyed façades
      if (road && !t.width && !(t.bridge && t.bridge !== "no") && ["primary", "secondary", "tertiary", "unclassified", "residential", "living_street"].includes(t.highway)) {
        const gap = facadeGap(g);
        if (gap) {
          const fit = Math.min(gap - (road[1] && !noSidewalk ? 5.4 : 1), w * 2.2);
          if (fit > w + 0.5) { w = fit; widened++; }
        }
      }
      const kind = road ? (road[1] ? "street" : t.highway.startsWith("motorway") || t.highway.startsWith("trunk") ? "highway" : t.highway === "track" ? "dirtroad" : "lane") : t.highway === "cycleway" ? "cycle" : t.highway === "pedestrian" ? "plaza" : "path";
      if (road && el.nodes) for (const id of el.nodes) {
        const nd = nodeUse.get(id) ?? { n: 0, w: 0, foot: false, y: 0, k: kind };
        nd.n++; nd.y = Math.max(nd.y, layer);
        if (w > nd.w) { nd.w = w; nd.k = kind; nd.s = sett; }
        nodeUse.set(id, nd);
      } else if (path && el.nodes && t.highway !== "steps") for (const id of el.nodes) footNodes.add(id);
      if (road && el.nodes) el.geometry.forEach((q: any, k: number) => nodePos.set(el.nodes[k], [toEnu(q.lon, q.lat), k > 0 ? toEnu(el.geometry[k - 1].lon, el.geometry[k - 1].lat) : toEnu(el.geometry[k + 1].lon, el.geometry[k + 1].lat), w]));
      const f: Feature = { id: el.id, bridge: !!t.bridge && t.bridge !== "no", k: kind, l: g, w: r1(w) };
      if (oneway) f.o = 1;
      if (lanes) f.n = lanes;
      if (layer > 0) f.y = layer;
      if (road && sett) f.s = 1;
      if (road && noSidewalk) f.sw = 0;
      features.push(f);
      continue;
    }
  } else if (el.type === "relation" && el.members) {
    const outer = joinWays(el.members.filter((m: any) => m.type === "way" && m.geometry && m.role !== "inner").map((m: any) => geom(m.geometry)));
    const inner = joinWays(el.members.filter((m: any) => m.type === "way" && m.geometry && m.role === "inner").map((m: any) => geom(m.geometry)));
    rings = [...outer, ...inner].filter(closed);
    if (!rings.length) rings = null;
  }
  if (!rings) continue;
  const k = areaKind(t);
  if (!k) continue;
  const r = rings.map((q) => simplifyRing(q, 0.3)).filter((q) => q.length >= 4);
  if (!r.length) continue;
  features.push({ k, r });
  if (k === "water") water.push(r);
}

/** junction entry: [x, y, radius (half width + 3 m), layer, kind of the widest road] */
const JUNCTION_KIND = ["dirtroad", "lane", "street", "highway"];
// Junctions (markings stop there) and zebra crossings (footpath meets a street mid-block).
const junctions: number[][] = [], zebras: number[][] = [];
for (const [id, u] of nodeUse) {
  const pos = nodePos.get(id);
  if (!pos) continue;
  const [[x, y], [nx, ny], w] = pos;
  if (u.n >= 2) junctions.push([r1(x), r1(y), r1(u.w / 2 + 3), u.y, JUNCTION_KIND.indexOf(u.k), u.s ? 1 : 0]);
  else if (footNodes.has(id) && w >= 5) {
    const L = Math.hypot(nx - x, ny - y) || 1;
    zebras.push([r1(x), r1(y), Math.round(((nx - x) / L) * 1000) / 1000, Math.round(((ny - y) / L) * 1000) / 1000, r1(w)]);
  }
}
// zebras guessed from footpaths meeting a street only where OSM has no mapped crossings at all
features.push({ k: "junctions", j: junctions } as Feature, { k: "zebras", j: crossings ? [] : zebras } as Feature);
console.log(`  ${hidden} ways below the surface left out (tunnels, covered, indoor, negative layer)`);
if (facadeSegs.size) console.log(`  ${widened} streets widened to the surveyed façade gap (CTRN)`);
console.log(`  ${junctions.length} junctions, ${crossings ? `${crossings} OSM marked crossings` : `${zebras.length} guessed zebra crossings`}`);

// Sea: the coastline has land on its left. Join it, close the open chain far offshore (west).
const chains = joinWays(coast);
const main = chains.filter((c) => !closed(c)).sort((a, b) => b.length - a.length)[0];
let sea: P2[][] = [];
if (main) {
  const off = 30000;
  const ring: P2[] = [...main, [main.at(-1)![0] - off, main.at(-1)![1]], [main[0][0] - off, main[0][1]]];
  sea = [simplifyLine(ring, 0.3), ...chains.filter(closed).map((c) => simplifyRing(c, 0.3))]; // closed = islands/breakwaters
  features.unshift({ k: "sea", r: sea });
  features.push({ k: "shore", l: simplifyLine(main, 0.3) });
}
console.log(`  features: ${features.length} (${chains.length} coastline chains)`);

// ---- terrain grid ------------------------------------------------------------------------------
interface Grid { x0: number; y0: number; nx: number; ny: number }
const corners = [[bb[0], bb[1]], [bb[0], bb[3]], [bb[2], bb[1]], [bb[2], bb[3]]].map(([la, lo]) => toEnu(lo, la));
const x0 = Math.floor(Math.min(...corners.map((c) => c[0])) / STEP) * STEP, x1 = Math.max(...corners.map((c) => c[0]));
const y0 = Math.floor(Math.min(...corners.map((c) => c[1])) / STEP) * STEP, y1 = Math.max(...corners.map((c) => c[1]));
const grid: Grid = { x0, y0, nx: Math.ceil((x1 - x0) / STEP) + 1, ny: Math.ceil((y1 - y0) / STEP) + 1 };

/** Copernicus tiles: 3600² float32, pixel centres at whole arc-seconds from the tile's SW-NW corner. */
async function loadDem() {
  const dir = join(RAW, "dem"), tiles = new Map<string, Float32Array>();
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".tif"))) {
    const m = f.match(/N(\d+)_00_E(\d+)_00/)!;
    const { data, info } = await sharp(join(dir, f)).extractChannel(0).raw({ depth: "float" }).toBuffer({ resolveWithObject: true });
    if (info.width !== 3600) throw new Error(`${f}: unexpected width ${info.width}`);
    tiles.set(`${Number(m[1])}_${Number(m[2])}`, new Float32Array(data.buffer, data.byteOffset, data.length / 4));
  }
  return (lat: number, lon: number) => {
    const t = tiles.get(`${Math.floor(lat)}_${Math.floor(lon)}`);
    if (!t) return 0;
    const fx = (lon - Math.floor(lon)) * 3600, fy = (Math.floor(lat) + 1 - lat) * 3600;
    const ix = Math.min(3598, Math.floor(fx)), iy = Math.min(3598, Math.floor(fy)), ax = fx - ix, ay = fy - iy;
    const v = (x: number, y: number) => t[y * 3600 + x];
    return (v(ix, iy) * (1 - ax) + v(ix + 1, iy) * ax) * (1 - ay) + (v(ix, iy + 1) * (1 - ax) + v(ix + 1, iy + 1) * ax) * ay;
  };
}

// ENU -> lat/lon by Newton-free local inversion (good to < 1 m over the area; DEM posting is 30 m)
const { lat: LAT0, lon: LON0 } = camera().origin;
const mLat = (Math.PI / 180) * 6367000, mLon = (Math.PI / 180) * 6386000 * Math.cos((LAT0 * Math.PI) / 180);
const dem = await loadDem();
const n = grid.nx * grid.ny;
let h = new Float32Array(n);
for (let iy = 0; iy < grid.ny; iy++) for (let ix = 0; ix < grid.nx; ix++) {
  const x = grid.x0 + ix * STEP, y = grid.y0 + iy * STEP;
  h[iy * grid.nx + ix] = dem(LAT0 + y / mLat, LON0 + x / mLon);
}
/** Separable min / max / box filter with radius r grid cells. */
function filter(a: Float32Array, r: number, op: "min" | "max" | "mean") {
  const pass = (src: Float32Array, horiz: boolean) => {
    const dst = new Float32Array(n);
    for (let iy = 0; iy < grid.ny; iy++) for (let ix = 0; ix < grid.nx; ix++) {
      let acc = op === "min" ? Infinity : op === "max" ? -Infinity : 0, cnt = 0;
      for (let d = -r; d <= r; d++) {
        const x = horiz ? ix + d : ix, y = horiz ? iy : iy + d;
        if (x < 0 || y < 0 || x >= grid.nx || y >= grid.ny) continue;
        const v = src[y * grid.nx + x];
        acc = op === "min" ? Math.min(acc, v) : op === "max" ? Math.max(acc, v) : acc + v;
        cnt++;
      }
      dst[iy * grid.nx + ix] = op === "mean" ? acc / cnt : acc;
    }
    return dst;
  };
  return pass(pass(a, true), false);
}
// bare earth: opening removes blocks up to ~200 m across, then smooth twice (≈ gaussian)
h = filter(filter(h, 10, "min"), 10, "max");
h = filter(filter(h, 4, "mean"), 4, "mean");

// water: sea at 0 m; lakes/rivers at their lowest surrounding ground; land kept above the sea
const isWater = new Uint8Array(n);
if (sea.length) fillGrid(sea, grid, (i) => { isWater[i] = 1; h[i] = -0.4; });
for (const w of water) {
  const idx: number[] = [];
  fillGrid(w, grid, (i) => idx.push(i));
  if (!idx.length) continue;
  const level = Math.max(0, Math.min(...idx.map((i) => h[i])) - 0.3);
  for (const i of idx) { if (!isWater[i]) h[i] = level; isWater[i] = 2; }
}
for (let i = 0; i < n; i++) if (!isWater[i]) h[i] = Math.max(h[i], 0.8);

// orthometric -> ellipsoid -> ENU up (Earth curvature drops the ellipsoid below the tangent plane)
for (let iy = 0; iy < grid.ny; iy++) for (let ix = 0; ix < grid.nx; ix++) {
  const x = grid.x0 + ix * STEP, y = grid.y0 + iy * STEP, i = iy * grid.nx + ix;
  h[i] = h[i] + GEOID - (x * x + y * y) / (2 * R_EARTH);
}

writeFileSync(join(out, "height.bin"), Buffer.from(h.buffer));
writeFileSync(join(out, "meta.json"), JSON.stringify({ ...grid, step: STEP }));
writeFileSync(join(out, "features.json"), JSON.stringify(features));
let lo = Infinity, hi = -Infinity;
for (const v of h) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
console.log(`  terrain ${grid.nx}×${grid.ny} @ ${STEP} m, up ${lo.toFixed(1)}…${hi.toFixed(1)} m -> ${out}`);
