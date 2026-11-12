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
import sharp from "sharp";
import { join } from "node:path";
import { openArea } from "./areas.ts";
import { CAMERA, ecefToEnu, enuToPixel, llhToEcef } from "./camera.ts";
import { osmSolid, hasCompleteParts, type BuildingDetail, type SceneBuilding } from "./building-shape.ts";
import { SEA_H } from "./heights.ts";
import { DERIVED, RAW, readJson } from "./paths.ts";
import { AURELIAN_WALLS, insideRing, romanFallbackHeight, romanLook } from "./roma-style.ts";
import type { CtrnUnit } from "./ctrn.ts";
import polygonClipping from "polygon-clipping";

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

function ringFromLonLat(coords: number[][], minArea = 25): P2[] | null {
  let r: P2[] = coords.map(([lon, lat]) => { const p = toEnu(lon, lat); return [p[0], p[1]] as P2; });
  if (r.length > 1 && r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1]) r = r.slice(0, -1);
  // closed ring: split at the vertex farthest from r[0] so both halves have a real chord
  let far = 0;
  r.forEach((p, i) => { if (Math.hypot(p[0] - r[0][0], p[1] - r[0][1]) > Math.hypot(r[far][0] - r[0][0], r[far][1] - r[0][1])) far = i; });
  if (far > 0) r = [...simplify(r.slice(0, far + 1), 0.35).slice(0, -1), ...simplify([...r.slice(far), r[0]], 0.35).slice(0, -1)];
  if (r.length < 3) return null;
  if (area2(r) < 0) r.reverse();
  // Drop stub footprints (< ~25 m²) — they paint as lone 2-window shards in plazas
  return Math.abs(area2(r)) >= minArea ? r : null;
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
  "palazzo poli": 26,
  "fontana di trevi": 1,
  "trevi fountain": 1,
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
  if (t.amenity || t.historic ||
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
function outerRings(el: any, role = "outer"): number[][][] {
  if (role === "outer" && el.type === "way" && el.geometry?.length >= 4
    && el.geometry[0].lat === el.geometry.at(-1).lat && el.geometry[0].lon === el.geometry.at(-1).lon)
    return [el.geometry.map((q: any) => [q.lon, q.lat])];
  if (el.type !== "relation" || !el.members) return [];
  const segs: number[][][] = [];
  for (const m of el.members) {
    if (m.role !== role || !m.geometry || m.geometry.length < 2) continue;
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
const area = openArea(name), bbox = area.bbox;
/** Rome: Roman palazzi / palazzine / travertine instead of Tel Aviv's Bauhaus, glass and solar heaters. */
const ROMA = area.region === "roma-centro";
const WALLS: P2[] = AURELIAN_WALLS.map(([lat, lon]) => { const p = toEnu(lon, lat); return [p[0], p[1]] as P2; });
const raw = join(RAW, name);
const out = join(DERIVED, name, "scene");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

type Building = { ring: P2[]; h: number; s: number; g: number | null; keepInPlaza?: boolean; detail?: BuildingDetail };
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
if (existsSync(join(raw,"building-parts.json"))) {
  const combined = new Map(osm.elements.map((el:any)=>[`${el.type}/${el.id}`,el]));
  for (const el of readJson(join(raw,"building-parts.json")).elements) combined.set(`${el.type}/${el.id}`,el);
  osm.elements=[...combined.values()];
}
const partElements = osm.elements.filter((el:any)=>el.tags?.["building:part"] && el.tags["building:part"] !== "no");
const coloredParents = osm.elements.filter((el:any)=>el.tags?.building && (el.tags["building:colour"] || el.tags["roof:colour"]))
  .flatMap((el:any)=>outerRings(el).map(coords=>({ring:ringFromLonLat(coords),tags:el.tags}))).filter((p:any)=>p.ring);
const partRings = partElements.flatMap((el:any)=>outerRings(el).map(coords=>ringFromLonLat(coords,0.1)).filter(Boolean)) as P2[][];
/** Parts with their vertical extent: an outline whose parts stand on its roof is only their base. */
const partMeta = partElements.flatMap((el:any)=>outerRings(el).map(coords=>ringFromLonLat(coords,0.1)).filter(Boolean).map((ring:any)=>({
  c: [ring.reduce((a:number,p:P2)=>a+p[0],0)/ring.length, ring.reduce((a:number,p:P2)=>a+p[1],0)/ring.length] as P2,
  minH: parseFloat(el.tags["min_height"]) || 0, h: parseFloat(el.tags.height) || 0 })));
// A relation owns its member outlines: drawing both fills courtyards and doubles landmark masses.
const memberWays = new Set<number>(osm.elements.filter((el:any)=>el.type === "relation" && osmSolid(el.tags??{}))
  .flatMap((el:any)=>(el.members??[]).filter((m:any)=>m.type === "way" && ["outer","inner"].includes(m.role)).map((m:any)=>m.ref)));
// Rome: parts inside a church / monument (Pantheon drum, portico, domes) take the monument's
// travertine/brick look, never a palazzo's plaster and shutters.
const monumentRings: P2[][] = ROMA ? osm.elements.filter((el:any)=>{
  const t = el.tags ?? {};
  return t.building && (landmarkHeight(t) || t.amenity === "place_of_worship" || ["church","cathedral","basilica","chapel","temple"].includes(t.building));
}).flatMap((el:any)=>outerRings(el).map(c=>ringFromLonLat(c)).filter(Boolean)) as P2[][] : [];
/** OSM materials -> colours (building:colour / roof:colour still win). */
const WALL_MATERIAL: Record<string,string> = { brick:"#a85f42", concrete:"#b3aea4", stone:"#d9cfba", marble:"#eeebe4", plaster:"", travertine:"#ddd3bc" };
const ROOF_MATERIAL: Record<string,string> = { concrete:"#a4a29c", lead:"#8f9190", metal:"#8c9094", copper:"#6f9a8a", roof_tiles:"#a8674c", tiles:"#a8674c", stone:"#cfc6b2", glass:"#9fb3bd" };
/** OSM colour names (building:colour=sand, roof:colour=lightcoral…) as muted hex; unknown -> undefined,
 * so the Roman look applies instead of the renderer's fallback (which painted the Colosseo terracotta). */
const NAMED: Record<string,string> = { white:"#f1eee6", lightyellow:"#f0e7c8", yellow:"#e0c060", cream:"#ece2c6", beige:"#e2d5b6",
  sand:"#d9c8a3", ochre:"#cc9a4c", orange:"#d58a4c", lightcoral:"#c48a74", coral:"#c4785e", pink:"#e0a99c", salmon:"#df9e84",
  red:"#a8503c", darkred:"#7f3a2c", brown:"#8a5a3c", terracotta:"#b5643f", grey:"#9a9a96", gray:"#9a9a96", lightgrey:"#c8c6c0",
  lightgray:"#c8c6c0", darkgrey:"#6e6e6c", darkgray:"#6e6e6c", silver:"#bdbdb8", black:"#3a3a3a", green:"#6f8f6a", tan:"#cdb490" };
const colour = (v?: string) => !v ? undefined : /^#[0-9a-f]{6}$/i.test(v) ? v : /^#[0-9a-f]{3}$/i.test(v) ? "#" + [...v.slice(1)].map((c) => c + c).join("") : NAMED[v.toLowerCase().replace(/[\s_-]/g, "")];
const DOME = "#9c9a93"; // Rome's domes are lead / concrete grey whatever the tag says
// Rome: surveyed volumes of the Regione Lazio CTRN 1:5000 (ctrn.ts), clipped to each OSM footprint.
// OSM decides WHERE a building is today; the CTRN says how tall every part of it is. Each piece keeps
// its measured height, so stepped palazzi, naves, bell towers and drums/domes stand at real heights.
type Unit = { ring: P2[]; h: number; id: number; a: number; box: number[] };
const ctrnUnits: Unit[] = [];
const UCELL = 40, ugrid = new Map<string, Unit[]>();
if (ROMA && existsSync(join(RAW, "ctrn", "units.json"))) {
  const [S0, W0, N0, E0] = bbox, m = 0.01;
  for (const u of readJson<CtrnUnit[]>(join(RAW, "ctrn", "units.json"))) {
    if (!u.r.some(([lo, la]) => la > S0 - m && la < N0 + m && lo > W0 - m && lo < E0 + m)) continue;
    const ring = ringFromLonLat(u.r, 4);
    if (!ring) continue;
    const xs = ring.map((p) => p[0]), ys = ring.map((p) => p[1]);
    const unit = { ring, h: u.h, id: u.id, a: Math.abs(area2(ring)), box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] };
    ctrnUnits.push(unit);
    for (let gx = Math.floor(unit.box[0] / UCELL); gx <= Math.floor(unit.box[2] / UCELL); gx++)
      for (let gy = Math.floor(unit.box[1] / UCELL); gy <= Math.floor(unit.box[3] / UCELL); gy++)
        (ugrid.get(`${gx}_${gy}`) ?? ugrid.set(`${gx}_${gy}`, []).get(`${gx}_${gy}`)!).push(unit);
  }
  console.log(`  ctrn volumetric units near the area: ${ctrnUnits.length}`);
}
const closeRing = (r: P2[]) => [...r, r[0]];
/** Pieces of CTRN volumes inside an OSM footprint (minus courtyards), the uncovered rest, and the cover. */
function unitsIn(ring: P2[], holes: P2[][]) {
  const xs = ring.map((p) => p[0]), ys = ring.map((p) => p[1]), seen = new Set<Unit>();
  const foot: any = [closeRing(ring), ...holes.map(closeRing)];
  const area = Math.abs(area2(ring)) - holes.reduce((t, h) => t + Math.abs(area2(h)), 0);
  const pieces: Array<{ ring: P2[]; holes: P2[][]; h: number; a: number }> = [];
  const hit: any[] = [];
  for (let gx = Math.floor(Math.min(...xs) / UCELL); gx <= Math.floor(Math.max(...xs) / UCELL); gx++)
    for (let gy = Math.floor(Math.min(...ys) / UCELL); gy <= Math.floor(Math.max(...ys) / UCELL); gy++)
      for (const u of ugrid.get(`${gx}_${gy}`) ?? []) {
        if (seen.has(u) || u.box[2] < Math.min(...xs) || u.box[0] > Math.max(...xs) || u.box[3] < Math.min(...ys) || u.box[1] > Math.max(...ys)) continue;
        seen.add(u);
        let cut: P2[][][] = [];
        try { cut = polygonClipping.intersection(foot, [closeRing(u.ring)]) as P2[][][]; } catch { continue; }
        for (const poly of cut) {
          const outer = poly[0].slice(0, -1), inner = poly.slice(1).map((r) => r.slice(0, -1));
          const a = Math.abs(area2(outer)) - inner.reduce((t, r) => t + Math.abs(area2(r)), 0);
          if (a < 4) continue;
          pieces.push({ ring: area2(outer) < 0 ? outer.reverse() : outer, holes: inner, h: u.h, a });
          hit.push([closeRing(u.ring)]);
        }
      }
  const covered = pieces.reduce((t, p) => t + p.a, 0);
  let rest: P2[][][] = [];
  if (pieces.length && covered < area * 0.92) {
    try { rest = (polygonClipping.difference(foot, ...hit) as P2[][][]).map((poly) => poly.map((r) => r.slice(0, -1))); } catch { rest = []; }
  }
  return { pieces, rest, cover: covered / Math.max(1, area) };
}
let ctrnBuildings = 0, ctrnVolumes = 0, ctrnHeights = 0;
let osmCount = 0;
const trees: Array<[number, number, number, number]> = [];
for (const el of osm.elements) {
  const t = el.tags ?? {};
  if (el.type === "node" && t.natural === "tree") { const p = toEnu(el.lon, el.lat); trees.push([p[0], p[1], 3, 6]); continue; }
  if (!osmSolid(t) || (el.type === "way" && memberWays.has(el.id))) continue;
  const isPart = !!t["building:part"] && t["building:part"] !== "no";
  // buildings + mapped fountain/monument footprints (never an entire tourism site)
  const isFountain = t.amenity === "fountain" || t.fountain === "yes";
  const isMonument = !t.building && !t.highway && (t.historic === "monument" || t.historic === "memorial")
    && (t.name || t["name:en"]);
  if (t.building === "roof" || t.location === "underground") continue;
  const levels = parseFloat(t["building:levels"]);
  const kind = osmKind(t);
  const lh = landmarkHeight(t);
  // Skip anonymous ruins / dig footprints — but keep named landmarks (Colosseum is
  // historic=archaeological_site + building=amphitheatre; dropping it left an empty park).
  const ruinLike = t.building === "ruins" || t.historic === "ruins" || t.historic === "archaeological_site";
  // mapped ruins (temple podiums, column bases: Area Sacra, Fori) are low travertine stubs, kept down to
  // single columns; only a whole archaeological site outline is not a building
  const ruinStub = !lh && t.building !== "amphitheatre" && (t.ruins === "yes" || t.building === "ruins" || t.historic === "ruins") && t.historic !== "archaeological_site";
  if (ruinLike && !ruinStub && !lh && t.building !== "amphitheatre" && !isMonument) continue;
  if (!t.building && !isPart && !isFountain && !isMonument) continue;
  const rings = outerRings(el);
  if (!rings.length) continue;
  // Materialise rings first; drop outers whose centroid sits inside a larger outer
  // (OSM Colosseum / Vittoriano put arena voids and stub fragments as extra outers).
  const solid: P2[][] = [];
  for (const coords of rings) {
    const ring = ringFromLonLat(coords, isPart ? 0.1 : ruinStub ? 0.5 : 25);
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
    if (!isPart && hasCompleteParts(ring,partRings,inside)) continue;
    const holes = outerRings(el,"inner").map(coords=>ringFromLonLat(coords,0.1)).filter((r):r is P2[]=>!!r && inside(r[0],ring));
    // OSM rings already encode geographic orientation: never rotate an entire footprint
    // to expose a facade to the camera. Real tagged heights precede fallback massing.
    if (ruinStub) {
      const a = Math.abs(area2(ring));
      const h = parseFloat(t.height) || (a < 6 ? 6 : a < 60 ? 3.5 : 2.5); // columns stand, podiums are low
      buildings.push({ ring, h, s: 8, g: null, keepInPlaza: true, detail: { part: false, minHeight: 0, roofHeight: 0, wallColor: "#d8cdb3", roofColor: "#cbbfa6" } });
      osmCount++; part++;
      continue;
    }
    const historic = ROMA && insideRing(c, WALLS);
    const inMonument = isPart && monumentRings.some((r) => insideRing(c, r));
    const look = ROMA ? romanLook(t, historic, !!lh || isFountain || isMonument || inMonument, hash(el.id * 7 + part), hash(el.id * 13 + part + 1)) : null;
    // CTRN: rebuild the footprint from surveyed volumes (not landmarks with their own OSM 3D parts)
    const ctrn = ctrnUnits.length && look && !isPart && !lh && !isFountain && !isMonument ? unitsIn(ring, holes) : null;
    if (ctrn && ctrn.cover >= 0.5) {
      const worship = look!.style === 8;
      const meanH = ctrn.pieces.reduce((t2, p) => t2 + p.h * p.a, 0) / ctrn.pieces.reduce((t2, p) => t2 + p.a, 0);
      const parts = [...ctrn.pieces, ...ctrn.rest.map(([o, ...inner]) => ({ ring: area2(o) < 0 ? o.reverse() : o, holes: inner, h: meanH, a: Math.abs(area2(o)) }))
        .filter((p) => p.a >= 10 && p.ring.length >= 3)];
      const tallest = ctrn.pieces.reduce((a, p) => (p.h > a.h ? p : a), ctrn.pieces[0]);
      for (const u of parts) {
        // a church's tallest compact piece, well above the nave, is its drum + dome
        const r = Math.sqrt(u.a / Math.PI), xs = u.ring.map((p) => p[0]), ys = u.ring.map((p) => p[1]);
        const compact = u.a / ((Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys)) || 1) > 0.7;
        const others = parts.filter((v) => v !== u).map((v) => v.h);
        const dome = worship && u === tallest && compact && r > 4 && u.h > Math.max(0, ...others) + 4;
        // palazzi: CTRN height is the eave line; the coppi roof sits on top. Churches keep their survey top.
        const roof = !worship && look!.roof > 0 && !t["roof:shape"] && u.h > 7 && u.a > 30 ? Math.min(look!.roof, u.h * 0.2) : 0;
        buildings.push({
          ring: u.ring, h: Math.round((u.h + roof) * 10) / 10, s: look!.style, g: null, keepInPlaza: true,
          detail: {
            part: false, minHeight: 0, holes: u.holes,
            roofShape: dome ? "dome" : roof ? "roman" : worship ? "hipped" : undefined,
            roofHeight: dome ? Math.min(r, u.h * 0.45) : roof || (worship && u.a > 150 ? Math.min(4, u.h * 0.15) : 0),
            wallColor: colour(t["building:colour"]) ?? (WALL_MATERIAL[t["building:material"]] || look!.wallColor),
            roofColor: dome ? DOME : colour(t["roof:colour"]) ?? (ROOF_MATERIAL[t["roof:material"]] || look!.roofColor),
          },
        });
        ctrnVolumes++;
      }
      ctrnBuildings++; osmCount++; part++;
      continue;
    }
    let h: number = parseFloat(t.height) || (levels ? levels * (look?.floor ?? FLOOR) + (look ? 1.5 : 1) : 0) || lh || 0;
    // partly surveyed footprint: area-weighted CTRN height beats any guess (and an unsourced OSM height)
    if (ctrn && ctrn.cover >= 0.2 && !levels) {
      h = ctrn.pieces.reduce((t2, p) => t2 + p.h * p.a, 0) / ctrn.pieces.reduce((t2, p) => t2 + p.a, 0) + (look!.roof > 0 ? look!.roof : 0);
      ctrnHeights++;
    }
    if (!h) {
      if (isFountain) h = 4;
      else if (["house", "garage", "shed", "kiosk"].includes(t.building)) h = 5;
      else if (look) h = romanFallbackHeight(Math.abs(area2(ring)), historic, hash(el.id * 3 + part));
      else h = Math.abs(area2(ring)) > 1500 ? 14 : 13;
    }
    // OSM Simple 3D Buildings: an outline whose tagged height is reached only by its parts (San Pietro:
    // 136.5 m is the lantern cross) is drawn as the base the elevated parts stand on, not a 136 m box.
    let baseOfParts = false;
    if (!isPart) {
      const inner = partMeta.filter((q:any) => inside(q.c, ring));
      if (inner.length >= 3 && inner.some((q:any) => q.h >= h * 0.7)) {
        const bases = inner.map((q:any) => q.minH).filter((v:number) => v > 5 && v < h * 0.6).sort((a:number, b:number) => a - b);
        if (bases.length) { h = bases[Math.floor(bases.length / 2)]; baseOfParts = true; }
      }
    }
    // secondary outers of a multipolygon (arcade wings, annexes) stay a bit lower than the main mass
    if (lh && !isFountain && !t.height && !levels && part > 0 && !baseOfParts) h = Math.max(8, h * 0.55);
    const parent = isPart ? coloredParents.find((p:any)=>inside(c,p.ring))?.tags : undefined;
    // Rome: untagged palazzi get the city's hipped coppi roof (~3 m), tagged pitched roofs a real height
    const romanRoof = !!look && look.roof > 0 && !isPart && !baseOfParts && !t["roof:shape"] && !t["roof:height"] && h > 7;
    const roofShape = t["roof:shape"] ?? (romanRoof ? "roman" : undefined);
    const tagged = parseFloat(t["roof:height"]) || 0;
    const roofHeight = el.type === "relation" && el.id === 3373289 ? 21.65 // Pantheon: drum + dome, not a 40 m roof on a 4 m wall
      : tagged || (romanRoof ? Math.min(look!.roof, h * 0.2) : look && ["hipped", "gabled", "pyramidal"].includes(roofShape ?? "") ? Math.min(3, h * 0.2) : 0);
    const detail: BuildingDetail = {holes, part:isPart, minHeight:parseFloat(t.min_height)||0,
      roofShape, roofHeight,
      roofDirection: t["roof:direction"] ? Number(t["roof:direction"]) : undefined,
      roofAcross:t["roof:orientation"] === "across",
      wallColor: look ? colour(t["building:colour"]) ?? colour(parent?.["building:colour"]) ?? (WALL_MATERIAL[t["building:material"]] || look.wallColor)
        : t["building:colour"] ?? parent?.["building:colour"],
      roofColor: look ? (roofShape === "dome" ? DOME : colour(t["roof:colour"]) ?? colour(parent?.["roof:colour"]) ?? (ROOF_MATERIAL[t["roof:material"]] || look.roofColor))
        : t["roof:colour"] ?? parent?.["roof:colour"]};
    const s = look ? look.style : style(h, kind, el.id + part, null, !!lh || isPart);
    buildings.push({ ring, h, s, g: null, detail, keepInPlaza: isPart || !!lh || !!t.name || !!t["name:en"] });
    osmCount++;
    part++;
  }
}
console.log(`  osm buildings (outside municipal layer): ${osmCount}`);
if (ROMA) console.log(`  ctrn: ${ctrnBuildings} buildings rebuilt from ${ctrnVolumes} surveyed volumes, ${ctrnHeights} more with surveyed height`);

// Clear clutter from monument plazas. Piazza Venezia and the Colosseum valley must stay open:
// OSM stubs / kiosks / wrong outers otherwise extrude as apartment blocks and paint invents more.
{
  const plazas: Array<{ lat: number; lon: number; r: number; label: string }> = [
    // Remove only small anonymous low stubs, never real palaces, porticoes or named arches.
    { lat: 41.894687, lon: 12.483066, r: 115, label: "Altare/Piazza Venezia" },
    // keep Colosseum amphitheatre (~48 m); strip modern infill / stubs in the valley park
    { lat: 41.89021, lon: 12.492231, r: 130, label: "Colosseo park" },
    // keep Palazzo Poli; clear kiosk/stub clutter in Piazza di Trevi so paint doesn't invent a tiny fountain
    { lat: 41.900978, lon: 12.483285, r: 45, label: "Trevi piazza" },
  ];
  let dropped = 0;
  for (const P of plazas) {
    const c = toEnu(P.lon, P.lat);
    for (let i = buildings.length - 1; i >= 0; i--) {
      const b = buildings[i];
      const cx = b.ring.reduce((a, p) => a + p[0], 0) / b.ring.length;
      const cy = b.ring.reduce((a, p) => a + p[1], 0) / b.ring.length;
      if (!b.keepInPlaza && Math.abs(area2(b.ring)) < 80 && b.h < 8
        && Math.hypot(cx - c[0], cy - c[1]) < P.r) {
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
// 3b. OSM tree rows (plane trees along the Tiber and the viali) and woodland/park canopy (Villa
// Borghese, Villa Pamphili, Gianicolo). Without these Rome's parks rendered as flat lawns.
/** Rome uses measured canopy (ESA WorldCover 2021, CC BY 4.0) instead of filling parks at random. */
const useCanopy = ROMA && existsSync(join(RAW, "worldcover", "roma.png")) && existsSync(join(DERIVED, name, "ground", "features.json"));
if (existsSync(join(raw, "trees.json"))) {
  const CELL = 30, bgrid = new Map<string, P2[][]>(), tgrid = new Map<string, P2[]>();
  const cellOf = (x: number, y: number) => `${Math.floor(x / CELL)}_${Math.floor(y / CELL)}`;
  for (const b of buildings) {
    const xs = b.ring.map((p) => p[0]), ys = b.ring.map((p) => p[1]);
    for (let gx = Math.floor(Math.min(...xs) / CELL); gx <= Math.floor(Math.max(...xs) / CELL); gx++)
      for (let gy = Math.floor(Math.min(...ys) / CELL); gy <= Math.floor(Math.max(...ys) / CELL); gy++)
        (bgrid.get(`${gx}_${gy}`) ?? bgrid.set(`${gx}_${gy}`, []).get(`${gx}_${gy}`)!).push(b.ring);
  }
  for (const t of trees) (tgrid.get(cellOf(t[0], t[1])) ?? tgrid.set(cellOf(t[0], t[1]), []).get(cellOf(t[0], t[1]))!).push([t[0], t[1]]);
  const free = (x: number, y: number, gap: number) => {
    if ((bgrid.get(cellOf(x, y)) ?? []).some((r) => inside([x, y], r))) return false;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++)
      for (const q of tgrid.get(`${Math.floor(x / CELL) + dx}_${Math.floor(y / CELL) + dy}`) ?? [])
        if (Math.hypot(q[0] - x, q[1] - y) < gap) return false;
    return true;
  };
  const plant = (x: number, y: number, r: number, ch: number, gap: number) => {
    if (!free(x, y, gap)) return 0;
    trees.push([x, y, r, ch]);
    (tgrid.get(cellOf(x, y)) ?? tgrid.set(cellOf(x, y), []).get(cellOf(x, y))!).push([x, y]);
    return 1;
  };
  let rows = 0, wood = 0;
  const data = readJson(join(raw, "trees.json"));
  for (const el of data.elements) {
    const t = el.tags ?? {};
    if (t.natural === "tree_row" && el.geometry) {
      const g: P2[] = el.geometry.map((q: any) => { const p = toEnu(q.lon, q.lat); return [p[0], p[1]] as P2; });
      for (let i = 1; i < g.length; i++) {
        const L = Math.hypot(g[i][0] - g[i - 1][0], g[i][1] - g[i - 1][1]), n = Math.max(1, Math.round(L / 9));
        for (let k = 0; k < n; k++) {
          const x = g[i - 1][0] + ((g[i][0] - g[i - 1][0]) * k) / n, y = g[i - 1][1] + ((g[i][1] - g[i - 1][1]) * k) / n;
          const j = hash(Math.round(x * 7 + y * 13));
          rows += plant(x, y, 4.2 + j * 1.2, 9 + j * 3, 5); // mature London planes
        }
      }
      continue;
    }
    if (useCanopy) continue; // Rome: parks and woods take real canopy from WorldCover (below), not a guessed fill
    const dense = t.natural === "wood" || t.landuse === "forest";
    if (!dense && !(t.leisure === "park" || t.leisure === "garden")) continue;
    for (const coords of outerRings(el)) {
      const ring = ringFromLonLat(coords, 400);
      if (!ring) continue;
      const holes = outerRings(el, "inner").map((c) => ringFromLonLat(c, 25)).filter((r): r is P2[] => !!r);
      const xs = ring.map((p) => p[0]), ys = ring.map((p) => p[1]), step = dense ? 7 : 11;
      for (let x = Math.min(...xs) + step / 2; x < Math.max(...xs); x += step)
        for (let y = Math.min(...ys) + step / 2; y < Math.max(...ys); y += step) {
          const j = hash(Math.round(x * 7 + y * 13)), k = hash(Math.round(x * 3 - y * 5));
          // parks keep open lawns: canopy in irregular clumps (a coarse noise), woods are closed
          const clump = hash(Math.round(x / 45) * 92821 + Math.round(y / 45) * 68917);
          if (!dense && (clump < 0.35 || j < 0.3)) continue;
          const px = x + (j - 0.5) * step * 0.6, py = y + (k - 0.5) * step * 0.6;
          if (!inside([px, py], ring) || holes.some((h) => inside([px, py], h))) continue;
          wood += plant(px, py, 3.8 + j * 1.6, 8 + j * 5, dense ? 5 : 6);
        }
    }
  }
  // 3c. Real canopy (Rome): ESA WorldCover 2021 10 m "tree cover" pixels, in compact groups only (a lone
  // pixel is noise), never on buildings, carriageways, paved squares, water or sports grounds.
  if (useCanopy) {
    const meta = readJson<{ lat0: number; lon0: number; pxPerDeg: number; width: number; height: number }>(join(RAW, "worldcover", "roma.json"));
    const mask = await sharp(join(RAW, "worldcover", "roma.png")).extractChannel(0).raw().toBuffer(); // one class byte per pixel
    const at = (c: number, r: number) => (c >= 0 && r >= 0 && c < meta.width && r < meta.height && mask[r * meta.width + c] === 10 ? 1 : 0);
    const feats = readJson<Array<{ k: string; r?: P2[][]; l?: P2[]; w?: number; bridge?: boolean }>>(join(DERIVED, name, "ground", "features.json"));
    const G = 40, blockPoly = new Map<string, P2[][][]>(), blockLine = new Map<string, Array<[number, number, number, number, number]>>();
    const cells = (x0: number, y0: number, x1: number, y1: number, fn: (k: string) => void) => {
      for (let gx = Math.floor(x0 / G); gx <= Math.floor(x1 / G); gx++) for (let gy = Math.floor(y0 / G); gy <= Math.floor(y1 / G); gy++) fn(`${gx}_${gy}`);
    };
    for (const f of feats) {
      if (f.r && ["paving", "water", "pool", "pitch", "track", "parking", "sea", "sand", "playground"].includes(f.k)) {
        const p = f.r.flat(), xs = p.map((q) => q[0]), ys = p.map((q) => q[1]);
        cells(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys), (k) => (blockPoly.get(k) ?? blockPoly.set(k, []).get(k)!).push(f.r!));
      } else if (f.l && ["street", "highway", "lane", "plaza", "rail", "crossing"].includes(f.k)) {
        const half = (f.w ?? 4) / 2 + 1.2;
        for (let i = 1; i < f.l.length; i++) {
          const [ax, ay] = f.l[i - 1], [bx, by] = f.l[i];
          cells(Math.min(ax, bx) - half, Math.min(ay, by) - half, Math.max(ax, bx) + half, Math.max(ay, by) + half, (k) => (blockLine.get(k) ?? blockLine.set(k, []).get(k)!).push([ax, ay, bx, by, half]));
        }
      }
    }
    const evenOdd = ([x, y]: P2, rings: P2[][]) => { let c = false; for (const r of rings) for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const [xi, yi] = r[i], [xj, yj] = r[j]; if (yi > y !== yj > y && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c; } return c; };
    const blocked = (x: number, y: number) => {
      const k = `${Math.floor(x / G)}_${Math.floor(y / G)}`;
      if ((blockPoly.get(k) ?? []).some((rings) => evenOdd([x, y], rings))) return true;
      for (const [ax, ay, bx, by, half] of blockLine.get(k) ?? []) {
        const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy || 1e-9, u = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L));
        if (Math.hypot(x - ax - u * dx, y - ay - u * dy) < half) return true;
      }
      return false;
    };
    const [S0, W0, N0, E0] = bbox, m = 0.004;
    const r0 = Math.max(1, Math.floor((meta.lat0 - (N0 + m)) * meta.pxPerDeg)), r1 = Math.min(meta.height - 2, Math.ceil((meta.lat0 - (S0 - m)) * meta.pxPerDeg));
    const c0 = Math.max(1, Math.floor((W0 - m - meta.lon0) * meta.pxPerDeg)), c1 = Math.min(meta.width - 2, Math.ceil((E0 + m - meta.lon0) * meta.pxPerDeg));
    let canopy = 0, noise = 0, refused = 0;
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
      if (!at(c, r)) continue;
      let n = 0;
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) n += at(c + dc, r + dr);
      if (n < 5) { noise++; continue; } // isolated tree pixels: WorldCover noise at 10 m
      const j = hash(r * 7919 + c * 104729), k2 = hash(r * 31 + c * 17 + 5);
      const lat = meta.lat0 - (r + 0.5 + (k2 - 0.5) * 0.6) / meta.pxPerDeg, lon = meta.lon0 + (c + 0.5 + (j - 0.5) * 0.6) / meta.pxPerDeg;
      const [x, y] = toEnu(lon, lat);
      if (blocked(x, y)) { refused++; continue; }
      canopy += plant(x, y, 3.2 + j * 1.8, 7 + j * 6, 5.5);
    }
    console.log(`  canopy (ESA WorldCover): ${canopy} crowns; ${noise} isolated pixels and ${refused} on streets/squares/water left out`);
  }
  console.log(`  osm tree rows: ${rows} crowns, woodland/parks: ${wood} crowns`);
}
console.log(`  tree crowns: ${trees.length}`);

// 4. Bin objects by the render tiles they can appear on (base … top, + margin).
const bins = new Map<string, { b: SceneBuilding[]; t: Array<[number, number, number, number]> }>();
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
  add(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys), (bin) => bin.b.push([ring, Math.round(b.h * 10) / 10, b.s, b.g && Math.round(b.g * 10) / 10, b.detail]));
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
