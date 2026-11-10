/**
 * Build the 3D scene for an area from open data, in the camera's ENU frame.
 * Buildings and tree crowns; the ground comes from ground.ts.
 *
 *   npm -w pipeline run scene -- pantheon
 *
 * Output: data/derived/<area>/scene/<tx>_<ty>.json — objects visible in each render tile:
 *   b: buildings  [ring (ENU x,y pairs, CCW), height above ground, style, groundHint]
 *   t: tree crowns [x, y, radius, crown height above ground]
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openArea } from "./areas.ts";
import { CAMERA, ecefToEnu, enuToPixel, llhToEcef } from "./camera.ts";
import { SEA_H } from "./heights.ts";
import { DERIVED, RAW, readJson } from "./paths.ts";

type P2 = [number, number];
const T = CAMERA.tile;
/** Geoid undulation (MSL orthometric + this = ellipsoid height). */
const GEOID = SEA_H;
const FLOOR = 3.2;

const toEnu = (lon: number, lat: number, h = 0): [number, number, number] => ecefToEnu(llhToEcef(lat, lon, h));

function area2(r: P2[]) {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] - r[i][0]) * (r[j][1] + r[i][1]);
  return a / 2; // > 0 = CCW
}

/** Douglas-Peucker on a closed ring. */
function simplify(r: P2[], tol: number): P2[] {
  if (r.length <= 4) return r;
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
  return r.filter((_, i) => keep[i]);
}

function ringFromLonLat(coords: number[][]): P2[] | null {
  let r: P2[] = coords.map(([lon, lat]) => { const p = toEnu(lon, lat); return [p[0], p[1]] as P2; });
  if (r.length > 1 && r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1]) r = r.slice(0, -1);
  // closed ring: split at the vertex farthest from r[0] so both halves have a real chord
  let far = 0;
  r.forEach((p, i) => { if (Math.hypot(p[0] - r[0][0], p[1] - r[0][1]) > Math.hypot(r[far][0] - r[0][0], r[far][1] - r[0][1])) far = i; });
  if (far > 0) r = [...simplify(r.slice(0, far + 1), 0.35).slice(0, -1), ...simplify([...r.slice(far), r[0]], 0.35).slice(0, -1)];
  if (r.length < 3) return null;
  if (area2(r) < 0) r.reverse();
  // Drop stub footprints (< ~25 m²) — they paint as lone 2-window shards in plazas
  return Math.abs(area2(r)) >= 25 ? r : null;
}

function inside([x, y]: P2, poly: P2[]) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

const hash = (n: number) => { let x = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b); x ^= x >>> 13; return (Math.imul(x, 0xc2b2ae35) >>> 0) / 2 ** 32; };

/**
 * Visual style index used by the renderer (palette + facade pattern):
 * 0 Bauhaus/International (pre-1950, white, ribbon windows) · 1 1950–90s residential (cream, balcony bands)
 * 2 public (stone) · 3 tower (glass curtain wall) · 4 shed · 5 modern mid-rise (light grey, big windows)
 * Landmarks / public buildings stay stone (2) even when very tall — Vittoriano must not become glass.
 */
function style(height: number, kind: string, id: number, year?: number | null, landmark = false) {
  if (kind === "temporary") return 4;
  if (landmark || kind === "public") return 2;
  if (height >= 55) return 3;
  if (year && year < 1950 && height < 25) return 0;
  if (year && year >= 1995) return 5;
  if (!year) return hash(id) < 0.3 ? 0 : hash(id) < 0.8 ? 1 : 5;
  return hash(id) < 0.25 ? 0 : 1;
}

/** Known Rome monuments: OSM often lacks height / splits multipolygons into stub outers. */
const LANDMARK_H: Record<string, number> = {
  colosseo: 48.5,
  colosseum: 48.5,
  "altare della patria": 70,
  "monument to vittorio emanuele ii": 70,
  vittoriano: 70,
  pantheon: 43,
  "castel sant'angelo": 48,
  "castle of the holy angel": 48,
  "fontana di trevi": 26,
  "trevi fountain": 26,
  "basilica di san pietro": 136.6,
  "st. peter's basilica": 136.6,
  "arco di costantino": 21,
  "arco di tito": 15.4,
  "teatro di marcello": 32,
};

function landmarkHeight(t: Record<string, string>): number | null {
  const names = [t.name, t["name:en"], t["name:it"], t.alt_name, t.nat_name]
    .filter(Boolean).map((s) => s!.toLowerCase());
  for (const n of names) if (LANDMARK_H[n] != null) return LANDMARK_H[n];
  return null;
}

function osmKind(t: Record<string, string>): string {
  if (t.amenity || t.tourism === "attraction" || t.historic ||
    ["public", "cathedral", "church", "basilica", "temple", "chapel", "mosque", "synagogue",
      "amphitheatre", "ruins", "castle", "palace", "civic", "government", "university", "school",
      "hospital", "train_station", "stadium", "triumphal_arch", "obelisk"].includes(t.building))
    return "public";
  return "regular";
}

/** Rough lon/lat polygon area for ranking multipolygon outers (stubs often come first in OSM). */
function lonLatArea(coords: number[][]) {
  let a = 0;
  for (let i = 0, j = coords.length - 1; i < coords.length; j = i++)
    a += (coords[j][0] - coords[i][0]) * (coords[j][1] + coords[i][1]);
  return Math.abs(a / 2);
}

/** Match lon/lat endpoints when stitching multipolygon outer ways. */
function sameLL(a: number[], b: number[], eps = 1e-10) {
  return Math.abs(a[0] - b[0]) <= eps && Math.abs(a[1] - b[1]) <= eps;
}

/**
 * Every outer ring with a real footprint (OSM multipolygons often put stubs first).
 * Open outer ways (Fontana di Trevi, etc.) are chained into closed rings by endpoint.
 */
function outerRings(el: any): number[][][] {
  if (el.type === "way" && el.geometry?.length >= 4)
    return [el.geometry.map((q: any) => [q.lon, q.lat])];
  if (el.type !== "relation" || !el.members) return [];
  const segs: number[][][] = [];
  for (const m of el.members) {
    if (m.role !== "outer" || !m.geometry || m.geometry.length < 2) continue;
    segs.push(m.geometry.map((q: any) => [q.lon, q.lat]));
  }
  const out: number[][][] = [];
  const used = new Uint8Array(segs.length);
  for (let seed = 0; seed < segs.length; seed++) {
    if (used[seed]) continue;
    used[seed] = 1;
    let ring = segs[seed].map((p) => p.slice());
    // already closed way
    if (ring.length >= 4 && sameLL(ring[0], ring[ring.length - 1])) {
      out.push(ring);
      continue;
    }
    let guard = segs.length + 2;
    while (guard-- > 0 && !sameLL(ring[0], ring[ring.length - 1])) {
      const end = ring[ring.length - 1];
      let hit = -1, rev = false;
      for (let i = 0; i < segs.length; i++) {
        if (used[i]) continue;
        const s = segs[i];
        if (sameLL(s[0], end)) { hit = i; rev = false; break; }
        if (sameLL(s[s.length - 1], end)) { hit = i; rev = true; break; }
      }
      if (hit < 0) break;
      used[hit] = 1;
      const add = rev ? segs[hit].slice().reverse() : segs[hit];
      ring.push(...add.slice(1).map((p) => p.slice()));
    }
    if (ring.length >= 4 && sameLL(ring[0], ring[ring.length - 1])) out.push(ring);
  }
  out.sort((a, b) => lonLatArea(b) - lonLatArea(a));
  return out;
}

const name = process.argv[2] ?? "roma-core";
const bbox = openArea(name).bbox;
const raw = join(RAW, name);
const out = join(DERIVED, name, "scene");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

type Building = { ring: P2[]; h: number; s: number; g: number | null };
const buildings: Building[] = [];
const tlvCover: P2[][] = [];

// 1. Tel Aviv-Yafo municipal buildings (empty FeatureCollection for Rome / other cities).
const tlv = existsSync(join(raw, "tlv_buildings.geojson"))
  ? readJson(join(raw, "tlv_buildings.geojson"))
  : { features: [] };
for (const f of tlv.features) {
  const p = f.properties, g = f.geometry;
  if (!g) continue;
  const polys = g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : [];
  const kind = ({ "מבנה ציבור": "public", "מבנה ארעי": "temporary", "תחנת אוטובוס": "shelter" } as Record<string, string>)[p.t_sug_mivne] ?? "regular";
  let h = p.gova_simplex_2019 || (p.ms_komot ? p.ms_komot * FLOOR + 1 : 0) || 4;
  if (kind === "shelter") h = 3;
  for (const poly of polys) {
    const ring = ringFromLonLat(poly[0]);
    if (!ring) continue;
    buildings.push({ ring, h: Math.max(3, h), s: style(h, kind, p.id_binyan ?? buildings.length, p.year), g: p.min_height ? p.min_height + GEOID : null });
    tlvCover.push(ring);
  }
}
console.log(`  tlv buildings: ${buildings.length}`);

// 2. OSM buildings where the municipal layer has nothing (Ramat Gan, Givatayim, Bnei Brak…).
const coverGrid = new Map<string, P2[][]>(); // 50 m grid of municipal footprints for overlap tests
for (const r of tlvCover) {
  const k = `${Math.floor(r[0][0] / 50)}_${Math.floor(r[0][1] / 50)}`;
  if (!coverGrid.has(k)) coverGrid.set(k, []);
  coverGrid.get(k)!.push(r);
}
const covered = (pt: P2) => {
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++)
    if (coverGrid.get(`${Math.floor(pt[0] / 50) + dx}_${Math.floor(pt[1] / 50) + dy}`)?.some((r) => inside(pt, r))) return true;
  return false;
};
const osm = readJson(join(raw, "osm.json"));
let osmCount = 0;
const trees: Array<[number, number, number, number]> = [];
for (const el of osm.elements) {
  const t = el.tags ?? {};
  if (el.type === "node" && t.natural === "tree") { const p = toEnu(el.lon, el.lat); trees.push([p[0], p[1], 3, 6]); continue; }
  // buildings + named fountains/monuments that OSM maps without building=* (e.g. Fontana di Trevi)
  const isFountain = t.amenity === "fountain" || t.fountain === "yes";
  const isMonument = !t.building && (t.historic === "monument" || t.historic === "memorial" || t.tourism === "attraction")
    && (t.name || t["name:en"]);
  if (t.building === "roof" || t.location === "underground") continue;
  const levels = parseFloat(t["building:levels"]);
  const kind = osmKind(t);
  const lh = landmarkHeight(t);
  // Skip anonymous ruins / dig footprints — but keep named landmarks (Colosseum is
  // historic=archaeological_site + building=amphitheatre; dropping it left an empty park).
  const ruinLike = t.building === "ruins" || t.historic === "ruins" || t.historic === "archaeological_site";
  if (ruinLike && !lh && t.building !== "amphitheatre" && !isMonument) continue;
  if (!t.building && !isFountain && !isMonument) continue;
  const rings = outerRings(el);
  if (!rings.length) continue;
  // Materialise rings first; drop outers whose centroid sits inside a larger outer
  // (OSM Colosseum / Vittoriano put arena voids and stub fragments as extra outers).
  const solid: P2[][] = [];
  for (const coords of rings) {
    const ring = ringFromLonLat(coords);
    if (!ring) continue;
    solid.push(ring);
  }
  const kept = solid.filter((ring, idx) => {
    const c: P2 = [ring.reduce((a, p) => a + p[0], 0) / ring.length, ring.reduce((a, p) => a + p[1], 0) / ring.length];
    for (let k = 0; k < solid.length; k++) {
      if (k === idx) continue;
      if (Math.abs(area2(solid[k])) <= Math.abs(area2(ring))) continue;
      if (inside(c, solid[k])) return false;
    }
    return true;
  });
  let part = 0;
  for (const ring of kept) {
    const c: P2 = [ring.reduce((a, p) => a + p[0], 0) / ring.length, ring.reduce((a, p) => a + p[1], 0) / ring.length];
    if (covered(c)) continue;
    let h = lh || parseFloat(t.height) || (levels ? levels * FLOOR + 1 : 0);
    if (!h) {
      if (isFountain) h = 4;
      else if (["house", "garage", "shed", "kiosk"].includes(t.building)) h = 5;
      else h = Math.abs(area2(ring)) > 1500 ? 14 : 13;
    }
    // secondary outers of a multipolygon (arcade wings, annexes) stay a bit lower than the main mass
    if (lh && part > 0) h = Math.max(8, h * 0.55);
    buildings.push({ ring, h, s: style(h, kind, el.id + part, null, !!lh), g: null });
    osmCount++;
    part++;
  }
}
console.log(`  osm buildings (outside municipal layer): ${osmCount}`);

// Clear clutter from monument plazas. Piazza Venezia and the Colosseum valley must stay open:
// OSM stubs / kiosks / wrong outers otherwise extrude as apartment blocks and paint invents more.
{
  const plazas: Array<{ lat: number; lon: number; r: number; minH: number; label: string }> = [
    // keep only Vittoriano mass (~70 m); Assicurazioni / Palazzo Venezia sit ~120 m+ out
    { lat: 41.894687, lon: 12.483066, r: 115, minH: 55, label: "Altare/Piazza Venezia" },
    // keep Colosseum amphitheatre (~48 m); strip modern infill / stubs in the valley park
    { lat: 41.89021, lon: 12.492231, r: 130, minH: 40, label: "Colosseo park" },
    // keep Palazzo Poli; clear kiosk/stub clutter in Piazza di Trevi so paint doesn't invent a tiny fountain
    { lat: 41.900978, lon: 12.483285, r: 45, minH: 22, label: "Trevi piazza" },
  ];
  let dropped = 0;
  for (const P of plazas) {
    const c = toEnu(P.lon, P.lat);
    for (let i = buildings.length - 1; i >= 0; i--) {
      const b = buildings[i];
      const cx = b.ring.reduce((a, p) => a + p[0], 0) / b.ring.length;
      const cy = b.ring.reduce((a, p) => a + p[1], 0) / b.ring.length;
      if (Math.hypot(cx - c[0], cy - c[1]) < P.r && b.h < P.minH) {
        buildings.splice(i, 1);
        dropped++;
      }
    }
  }
  console.log(`  cleared ${dropped} clutter buildings from monument plazas`);
}

// Bridges and decks recorded as buildings (Arlozorov / Savidor over the Ayalon): any footprint a
// motorway, trunk road or railway runs through for 20 m+ is not a building. Drop it; the road is drawn.
{
  const lines: P2[] = [];
  for (const el of readJson(join(raw, "ground.json")).elements) {
    const t = el.tags ?? {};
    if (el.type !== "way" || !el.geometry || !(/^(motorway|trunk)(_link)?$/.test(t.highway) || /^(rail|light_rail)$/.test(t.railway))) continue;
    const g: P2[] = el.geometry.map((q: any) => { const p = toEnu(q.lon, q.lat); return [p[0], p[1]] as P2; });
    for (let i = 1; i < g.length; i++) {
      const n = Math.ceil(Math.hypot(g[i][0] - g[i - 1][0], g[i][1] - g[i - 1][1]) / 5);
      for (let k = 0; k < n; k++) lines.push([g[i - 1][0] + ((g[i][0] - g[i - 1][0]) * k) / n, g[i - 1][1] + ((g[i][1] - g[i - 1][1]) * k) / n]);
    }
  }
  const grid = new Map<string, P2[]>();
  for (const p of lines) { const k = `${Math.floor(p[0] / 50)}_${Math.floor(p[1] / 50)}`; (grid.get(k) ?? grid.set(k, []).get(k)!).push(p); }
  const before = buildings.length;
  for (let i = buildings.length - 1; i >= 0; i--) {
    const r = buildings[i].ring, xs = r.map((p) => p[0]), ys = r.map((p) => p[1]);
    let hits = 0;
    for (let gx = Math.floor(Math.min(...xs) / 50); gx <= Math.floor(Math.max(...xs) / 50); gx++)
      for (let gy = Math.floor(Math.min(...ys) / 50); gy <= Math.floor(Math.max(...ys) / 50); gy++)
        for (const p of grid.get(`${gx}_${gy}`) ?? []) if (inside(p, r)) hits++;
    if (hits >= 4) buildings.splice(i, 1);
  }
  console.log(`  dropped ${before - buildings.length} bridges/decks over motorways and rail`);
}

// 3. Tree crowns from municipal canopy (TLV) or skip when empty; OSM trees already added above.
const can = existsSync(join(raw, "tlv_canopy.geojson"))
  ? readJson(join(raw, "tlv_canopy.geojson"))
  : { features: [] };
for (const f of can.features) {
  const g = f.geometry;
  if (!g) continue;
  for (const poly of g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : []) {
    const ring = ringFromLonLat(poly[0]);
    if (!ring) continue;
    const A = Math.abs(area2(ring));
    if (A < 60) {
      const r = Math.sqrt(A / Math.PI);
      trees.push([ring.reduce((a, p) => a + p[0], 0) / ring.length, ring.reduce((a, p) => a + p[1], 0) / ring.length, r, 3 + r * 1.4]);
      continue;
    }
    const xs = ring.map((p) => p[0]), ys = ring.map((p) => p[1]), step = 6;
    for (let x = Math.min(...xs) + step / 2; x < Math.max(...xs); x += step)
      for (let y = Math.min(...ys) + step / 2; y < Math.max(...ys); y += step)
        if (inside([x, y], ring)) {
          const j = hash(Math.round(x * 7 + y * 13));
          trees.push([x + (j - 0.5) * 2, y + (hash(Math.round(x * 3 - y * 5)) - 0.5) * 2, 3.6 + j * 1.2, 6 + j * 3]);
        }
  }
}
console.log(`  tree crowns: ${trees.length}`);

// 4. Bin objects by the render tiles they can appear on (base … top, + margin).
const bins = new Map<string, { b: Array<[P2[], number, number, number | null]>; t: Array<[number, number, number, number]> }>();
const add = (minx: number, miny: number, maxx: number, maxy: number, fn: (bin: any) => void) => {
  for (let ty = Math.floor((miny - 8) / T); ty <= Math.floor((maxy + 8) / T); ty++)
    for (let tx = Math.floor((minx - 8) / T); tx <= Math.floor((maxx + 8) / T); tx++) {
      const k = `${tx}_${ty}`;
      if (!bins.has(k)) bins.set(k, { b: [], t: [] });
      fn(bins.get(k)!);
    }
};
const GROUND_GUESS = 70; // Rome centro ~20–50 m MSL + geoid; used only for tile binning
for (const b of buildings) {
  const pts = b.ring.flatMap(([x, y]) => [enuToPixel([x, y, GROUND_GUESS - 15]), enuToPixel([x, y, GROUND_GUESS + 25 + b.h])]);
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const ring = b.ring.map(([x, y]) => [Math.round(x * 100) / 100, Math.round(y * 100) / 100] as P2);
  add(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys), (bin) => bin.b.push([ring, Math.round(b.h * 10) / 10, b.s, b.g && Math.round(b.g * 10) / 10]));
}
for (const t of trees) {
  const a = enuToPixel([t[0], t[1], GROUND_GUESS - 15]), c = enuToPixel([t[0], t[1], GROUND_GUESS + 25 + t[3] + t[2]]);
  const r = t[2] / CAMERA.mpp;
  add(Math.min(a[0], c[0]) - r, Math.min(a[1], c[1]) - r, Math.max(a[0], c[0]) + r, Math.max(a[1], c[1]) + r,
    (bin) => bin.t.push(t.map((v) => Math.round(v * 10) / 10) as [number, number, number, number]));
}
for (const [k, v] of bins) writeFileSync(join(out, `${k}.json`), JSON.stringify(v));
console.log(`  ${bins.size} tile bins -> ${out}`);
if (!existsSync(join(DERIVED, name))) mkdirSync(join(DERIVED, name), { recursive: true });
