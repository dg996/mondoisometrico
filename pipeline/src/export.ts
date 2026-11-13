/**
 * Export rendered/painted areas to the web viewer.
 *
 *   npm run export -- tlv-core [more areas…] [--data-only]
 *
 * All areas must belong to one region. Only files that differ from what is published (R2) are
 * written, into the local cache data/web/regions/<region>/ (served by `npm run dev` over production;
 * `npm run publish -- <region>` uploads and empties it):
 *   tiles/map/{z}/{x}/{y}.avif         painted tiles where available; unpainted render is fogged
 *   tiles/photo/{z}/{x}/{y}.avif       3D render only (toggle)
 *   data/world.json                    camera, bounds, tile origin, ENU→pixel map, attributions, and
 *                                      the names of the files below (the only mutable file)
 *   data/tiles-<layer>.<hash>.json     every tile of a layer per zoom with its content hash (URL ?v=)
 *   data/borders.<hash>.json           OSM city borders in art-pixel space, on real terrain
 *   data/roads.<hash>.json             drivable roads for traffic (columnar, delta-coded: encodeRoads)
 *   preview/<city>-<land|port>.<hash>.avif  the city's opening view, shown until the tiles are in
 * Content-hashed names never change, so browsers keep them for a year; world.json says which are current.
 * The legacy data/tiles.json + .webp tiles stay on R2 untouched: the viewer's fallback without AVIF.
 * What is published (tile sources + hashes) is tracked in data/web-state/<region>.json; an export not
 * yet published keeps its state next to the cache (data/web/<region>.state.json) so exports stack.
 *
 * Tile (x, y) at zoom z covers global art pixels [x·512·2^(8-z), …); z = 8 is 1:1.
 */
import { belowSurface, isOneway, roadLanes, roadWidth } from "./roadspec.ts";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { AREAS, GROUND_H, areaPolygon, insideDistance, openArea } from "./areas.ts";
import { CAMERA, activeRegion, axes, camera, ecefToEnu, enuToPixel, llhToEcef, llhToPixel, enuHeight } from "./camera.ts";
import { HOSTING } from "./hosting.ts";
import { DERIVED, RAW, WEB_CACHE, WEB_STATE, readJson } from "./paths.ts";
import { CITIES, REGIONS } from "./places.ts";
import { groundAt, inWater, hideBelowBanks, roadSurfaceSafe, type TerrainMeta, type Point } from "./road-safety.ts";
import { readHeights } from "./heights.ts";
import { artCoverage, renderedCoverage, paintedBounds, parseArtBounds } from "./art-coverage.ts";
import { bridgeProfile, deckHeight } from "./bridge-profile.ts";
import { LANDMARKS } from "./landmarks.ts";
import { landmarkProjector } from "./landmark-anchors.ts";
import { railIndex, snapToRails } from "./transit-snap.ts";
import { crossingIndex, crossingsAlong } from "./crossings.ts";
import { contextTile, CONTEXT_BACKGROUND, CONTEXT_VERSION } from "./context-tiles.ts";
import { fetchGtfs, readTransit } from "./transit.ts";
import { cloudEdge } from "./clouds.ts";
import { FEATHER, FEATHER_VERSION, blendInto, featherAlpha, isDarkTile, neighbourhoodStamp, paintedDistance } from "./edge-feather.ts";
import { parseArgs } from "node:util";

const TS = 512;                  // web tile size
const SPLIT = CAMERA.tile / TS;  // web tiles per art tile edge
const NATIVE_Z = 8;
const MIN_Z = 2;
/** AVIF q50 ≈ the old WebP q72 in PSNR at ~40% fewer bytes (measured on painted tiles). */
const FORMAT = "avif", QUALITY = 50;
const MARGIN = 16; // neighbour pixels used when building each zoomed-out tile
/** Soft map edge: tiles fade out toward the areas' true outline instead of ending in tile steps.
 *  Fully transparent within EDGE0 of the outline (half a render tile's diagonal: the staircase
 *  never shows), fully opaque from EDGE1 in. */
// the outer band is a bank of clouds (clouds.ts): ~650 m on the whole map, narrower on a small area
// (a 1 km test patch would otherwise vanish under it); set from the outlines in main()
let EDGE0 = 760, EDGE1 = EDGE0 + 2600;
let outlines: Array<Array<[number, number]>> = [];
/** web/src/pages/index.astro #map background (#0e0f12): the edge fades into it */
const BG = CONTEXT_BACKGROUND;
/** Render tiles that exist: the clouds also close in on the tile staircase where rendering stops short
 *  of the outline (a small area showed hard beige rectangles at its corners). */
let rendered = new Set<string>();
const edgeDistance = (x: number, y: number) => Math.min(Math.max(0, ...outlines.map((o) => insideDistance([x, y], o))),
  rendered.size ? paintedDistance(rendered, x, y, CAMERA.tile, EDGE1 + 64) + EDGE0 * 0.5 : Infinity);

/** Exact painted keys also drive the client activity mask. */
let paintedArt = new Set<string>();
/** Work sites for the viewer's painter crews (workers.ts): street spots in the band where the painting
 *  fades into the not yet painted city. [e, n, u, dirE, dirN, width, depth 0..1 into the fade] */
let worksites: number[][] = [];

/** Native web tile at global art px (x0, y0): fade alpha near the map edge (null = fully inside). */
/** Any part of the web tile at (x0, y0) inside the cloud band (or beyond it)? */
function nearEdge(x0: number, y0: number) {
  const corners = [[x0, y0], [x0 + TS, y0], [x0, y0 + TS], [x0 + TS, y0 + TS]];
  return Math.min(...corners.map(([x, y]) => edgeDistance(x, y))) < EDGE1;
}

type Key = `${number}_${number}`;
const key = (x: number, y: number): Key => `${x}_${y}`;
const parse = (k: string) => k.split("_").map(Number) as [number, number];
/** Existing tiles per zoom with their content hash, written to tiles.json: the viewer never requests
 *  missing tiles, and ?v=<hash> makes every tile URL immutable (cached at the edge for a year). */
const index: Record<string, Record<number, Record<string, string>>> = {};

/** Published state of a region: per layer the source stamp of each native tile and the content hash
 *  of every tile ("z/x_y"), plus the hash of each data file. */
interface State { layers: Record<string, { sources: Record<string, string>; hashes: Record<string, string> }>; data: Record<string, string> }
let state: State = { layers: {}, data: {} };
const hash = (b: Buffer | string) => createHash("sha1").update(b).digest("hex").slice(0, 10);
const pendingFile = () => join(WEB_CACHE, `${activeRegion()}.state.json`);
const publishedFile = () => join(WEB_STATE, `${activeRegion()}.json`);

/** A content-addressed data file data/<name>.<hash>.json, written to the cache only when it differs
 *  from the published one (the old one stays on R2 for pages still pointing at it). */
function writeData(name: string, content: string) {
  const h = hash(content);
  if (state.data[name] === h) return;
  mkdirSync(join(OUT, "data"), { recursive: true });
  writeFileSync(join(OUT, "data", `${name}.${h}.json`), content);
  state.data[name] = h;
}
const dataFile = (name: string) => (state.data[name] ? `${name}.${state.data[name]}.json` : undefined);

/** A tile built earlier: from the cache if it is waiting to be published, else from production. */
const fetched = new Map<string, Buffer>();
async function readTile(layer: string, z: number, x: number, y: number): Promise<Buffer> {
  const rel = `tiles/${layer}/${z}/${x}/${y}.${FORMAT}`, local = join(OUT, rel);
  if (existsSync(local)) return readFileSync(local);
  if (fetched.has(rel)) return fetched.get(rel)!;
  const v = state.layers[layer]?.hashes[`${z}/${x}_${y}`];
  const r = await fetch(`${HOSTING.origin}/regions/${activeRegion()}/${rel}${v ? `?v=${v}` : ""}`);
  if (!r.ok) throw new Error(`${rel}: not in the cache and ${r.status} from ${HOSTING.origin} (delete ${publishedFile()} to rebuild everything)`);
  const b = Buffer.from(await r.arrayBuffer());
  fetched.set(rel, b);
  return b;
}

// Bridges are actual geometry in the source render / height pass. Never cover an AI bridge
// with a second SVG roadway: that produced displaced double decks and broken abutments.
/** Run tile jobs a few at a time (AVIF encoding is the slow part; sharp works off the main thread). */
const PARALLEL = 8;
async function pool(jobs: Array<() => Promise<void>>) {
  let next = 0;
  await Promise.all(Array.from({ length: PARALLEL }, async () => { while (next < jobs.length) await jobs[next++](); }));
}

async function exportLayer(layer: string, sources: Map<Key, string>) {
  index[layer] = {};
  const root = join(OUT, "tiles", layer);
  // which source (path + mtime) produced each native tile last time, and every tile's content hash
  const st = (state.layers[layer] ??= { sources: {}, hashes: {} });
  const prevSources = st.sources, nextSources: Record<string, string> = {}, hashes: Record<string, string> = {};
  const save = async (img: ReturnType<typeof sharp>, z: number, x: number, y: number) => {
    const buf = await img.avif({ quality: QUALITY, effort: 4 }).toBuffer();
    mkdirSync(join(root, `${z}`, `${x}`), { recursive: true });
    writeFileSync(join(root, `${z}`, `${x}`, `${y}.${FORMAT}`), buf);
    hashes[`${z}/${x}_${y}`] = hash(buf);
  };
  // native zoom: split each 1024 art tile into 512 web tiles (only when the source changed)
  let level = new Map<Key, number>(); // key -> source mtime
  let changed = new Set<Key>();
  const jobs: Array<() => Promise<void>> = [];
  const context = new Map<string, { image: Promise<Buffer>; remaining: number }>();
  // Context blur source: every tile of the layer except near-black render frames (failed GPU runs),
  // which would otherwise smear a dark band around the painted city.
  const contextSources = new Map(sources);
  if (layer === "map") {
    let dark = 0;
    for (const [k, file] of sources) if (!file.includes("/paint/") && await isDarkTile(file)) { contextSources.delete(k); dark++; }
    if (dark) console.log(`  ${layer}: ${dark} near-black render tiles left out of the context blur`);
  }
  const contextFor = (k: string, tx: number, ty: number) => {
    if (!context.has(k)) context.set(k, { image: contextTile(contextSources, tx, ty), remaining: SPLIT * SPLIT });
    while (context.size > 8) context.delete(context.keys().next().value!);
    return context.get(k)!;
  };
  for (const [k, file] of sources) {
    const [tx, ty] = parse(k);
    const painted = layer === "map" && file.includes("/paint/");
    const m = statSync(file).mtimeMs;
    // Neighbour changes invalidate blurred gutters (and painted feathering) as well as the tile itself.
    const neighbours = layer === "map" ? [-1,0,1].flatMap(dy=>[-1,0,1].map(dx=>{
      const f=sources.get(key(tx+dx,ty+dy)); return f ? `${f}@${statSync(f).mtimeMs}@${contextSources.has(key(tx+dx,ty+dy))?1:0}` : "";
    })).join("|") + `@${neighbourhoodStamp(paintedArt, tx, ty, CAMERA.tile)}` : "";
    const stamp = `${file}@${m}@${CONTEXT_VERSION}@${FEATHER_VERSION}@${neighbours}@no-svg-decks@clouds3-edge${EDGE0}-${EDGE1}@${FORMAT}${QUALITY}`;
    for (let j = 0; j < SPLIT; j++)
      for (let i = 0; i < SPLIT; i++) {
        const x = tx * SPLIT + i, y = ty * SPLIT + j, h = st.hashes[`${NATIVE_Z}/${x}_${y}`];
        level.set(key(x, y), m);
        nextSources[key(x, y)] = stamp;
        if (h && prevSources[key(x, y)] === stamp) { hashes[`${NATIVE_Z}/${x}_${y}`] = h; continue; }
        changed.add(key(x, y));
        jobs.push(async () => {
          let source: string | Buffer = file;
          const cut = { left: i * TS, top: j * TS, width: TS, height: TS };
          const soft = painted ? featherAlpha(paintedArt, x * TS, y * TS, TS, CAMERA.tile) : null;
          let blurred: Buffer | null = null;
          if (layer === "map" && (!painted || soft)) {
            const item = contextFor(k, tx, ty);
            blurred = await item.image;
            if (--item.remaining === 0) context.delete(k);
            if (!painted) source = blurred;
          }
          let rgb: Buffer = await sharp(source).extract(cut).removeAlpha().raw().toBuffer();
          // painted city dissolves into the context blur near unpainted tiles (no hard tile edge)
          if (soft && blurred) rgb = blendInto(rgb, await sharp(blurred).extract(cut).removeAlpha().raw().toBuffer(), soft);
          // map edge: the city disappears into clouds that thin into the page background (opaque tiles,
          // global-coordinate noise: no seams where tiles meet)
          if (nearEdge(x * TS, y * TS)) cloudEdge(rgb, x * TS, y * TS, TS, (px, py) => (edgeDistance(px, py) - EDGE0) / (EDGE1 - EDGE0), BG);
          await save(sharp(rgb, { raw: { width: TS, height: TS, channels: 3 } }), NATIVE_Z, x, y);
        });
      }
  }
  await pool(jobs);
  console.log(`  ${layer} z${NATIVE_Z}: ${level.size} (${changed.size} updated)`);
  const keep = (z: number) => Object.fromEntries([...level.keys()].map((k) => [k, hashes[`${z}/${k}`]]));
  index[layer][NATIVE_Z] = keep(NATIVE_Z);
  for (let z = NATIVE_Z - 1; z >= MIN_Z; z--) {
    const parents = new Map<Key, Array<[number, number]>>();
    for (const k of level.keys()) {
      const [x, y] = parse(k);
      const p = key(Math.floor(x / 2), Math.floor(y / 2));
      if (!parents.has(p)) parents.set(p, []);
      parents.get(p)!.push([x, y]);
    }
    const next = new Map<Key, number>(), nextChanged = new Set<Key>();
    jobs.length = 0;
    for (const [p, kids] of parents) {
      const [px, py] = parse(p);
      const h = st.hashes[`${z}/${p}`];
      next.set(p, Math.max(...kids.map(([x, y]) => level.get(key(x, y))!)));
      if (h && !kids.some(([x, y]) => changed.has(key(x, y)))) { hashes[`${z}/${p}`] = h; continue; }
      nextChanged.add(p);
      jobs.push(async () => {
        // the 2×2 children plus a MARGIN strip of their neighbours, so the downscale filter sees
        // across tile edges (otherwise faint lines appear along tile borders at low zoom)
        const composite = [];
        for (let y = py * 2 - 1; y <= py * 2 + 2; y++) for (let x = px * 2 - 1; x <= px * 2 + 2; x++) {
          if (!level.has(key(x, y))) continue;
          const left = (x - px * 2) * TS + MARGIN, top = (y - py * 2) * TS + MARGIN;
          const cut = { left: Math.max(0, -left), top: Math.max(0, -top) };
          const width = Math.min(TS - cut.left, TS * 2 + 2 * MARGIN - Math.max(0, left)), height = Math.min(TS - cut.top, TS * 2 + 2 * MARGIN - Math.max(0, top));
          if (width <= 0 || height <= 0) continue;
          const input = await sharp(await readTile(layer, z + 1, x, y)).extract({ ...cut, width, height }).toBuffer();
          composite.push({ input, left: Math.max(0, left), top: Math.max(0, top) });
        }
        const S = TS * 2 + 2 * MARGIN;
        const merged = await sharp({ create: { width: S, height: S, channels: 3, background: { r: BG[0], g: BG[1], b: BG[2] } } })
          .composite(composite).png().toBuffer();
        const half = await sharp(merged).resize(S / 2, S / 2, { kernel: "lanczos3" }).png().toBuffer();
        await save(sharp(half).extract({ left: MARGIN / 2, top: MARGIN / 2, width: TS, height: TS }), z, px, py);
      });
    }
    await pool(jobs);
    level = next;
    changed = nextChanged;
    index[layer][z] = keep(z);
  }
  console.log(`  ${layer} z${MIN_Z}–${NATIVE_Z - 1}: ${Object.keys(hashes).length - Object.keys(index[layer][NATIVE_Z]).length} tiles`);
  st.sources = nextSources;
  st.hashes = hashes; // tiles no longer produced drop out (they stay in R2, unreferenced)
}

/** Surface ellipsoid height sampler from the renderer's height pass (256² per 1024² tile). */
class Heights {
  private cache = new Map<string, Float32Array | null>();
  constructor(private dirs: string[]) {}
  async ensure(x: number, y: number, r = 32) {
    for (let ty = Math.floor((y - r) / CAMERA.tile); ty <= Math.floor((y + r) / CAMERA.tile); ty++)
      for (let tx = Math.floor((x - r) / CAMERA.tile); tx <= Math.floor((x + r) / CAMERA.tile); tx++) {
        const k = `${tx}_${ty}`;
        if (this.cache.has(k)) continue;
        const file = this.dirs.map((d) => join(d, `${k}.png`)).find(existsSync);
        this.cache.set(k, file ? await readHeights(file) : null);
      }
  }
  /** Surface height at an art pixel (call ensure() first). */
  at(x: number, y: number): number | null {
    const T = CAMERA.tile, k = T / 256;
    const tx = Math.floor(x / T), ty = Math.floor(y / T);
    const h = this.cache.get(`${tx}_${ty}`);
    if (!h) return null;
    const v = h[Math.floor((y - ty * T) / k) * 256 + Math.floor((x - tx * T) / k)];
    return Number.isNaN(v) ? null : v;
  }
  /** Lowest surface (≈ ground, not rooftops) within ~r art px of a pixel. */
  async ground(x: number, y: number, r = 24): Promise<number | null> {
    await this.ensure(x, y, r);
    let best: number | null = null;
    for (let dy = -r; dy <= r; dy += 4)
      for (let dx = -r; dx <= r; dx += 4) {
        const h = this.at(x + dx, y + dy);
        if (h !== null && (best === null || h < best)) best = h;
      }
    return best;
  }
}

/** lat/lon -> art pixel on the real terrain (iterate: project, read ground, re-project). */
async function onGround(heights: Heights, lat: number, lon: number) {
  let h = GROUND_H;
  let [x, y] = llhToPixel(lat, lon, h);
  for (let it = 0; it < 3; it++) {
    const g = await heights.ground(x, y);
    if (g === null) break;
    h = g;
    [x, y] = llhToPixel(lat, lon, h);
  }
  return { x, y, h };
}

async function exportBorders(heights: Heights) {
  const raw = readJson(join(RAW, "boundaries", `${activeRegion()}.json`));
  const feats = [];
  for (const el of raw.elements) {
    const ways: Array<Array<[number, number]>> = el.members
      .filter((m: any) => m.type === "way" && m.role === "outer" && m.geometry)
      .map((m: any) => m.geometry.map((p: any) => [p.lat, p.lon]));
    const out = [];
    for (const ring of stitch(ways)) {
      const pts: Array<[number, number]> = [];
      for (const [lat, lon] of ring) {
        const { x, y } = await onGround(heights, lat, lon);
        pts.push([Math.round(y * 10) / 10, Math.round(x * 10) / 10]);
      }
      out.push(pts);
    }
    feats.push({ id: el.id, name: el.tags.name, name_en: el.tags["name:en"], rings: out, label: labelPoint(out) });
  }
  writeData("borders", JSON.stringify(feats));
  console.log(`  borders: ${feats.length} cities`);
}

/** Drivable roads as ENU polylines sampled every 2 m, each sample flagged visible/occluded. */
async function exportRoads(areas: string[], heights: Heights) {
  const CLS: Record<string, number> = { motorway: 0, trunk: 0, primary: 1, secondary: 2, tertiary: 3, unclassified: 4, residential: 4, living_street: 5, service: 5 };
  const ways = [];
  const seen = new Set<number>(); // areas overlap (the pilot lies inside tlv-core): each OSM way once
  let occluded = 0, total = 0;
  for (const a of areas) {
    const f = join(RAW, a, "roads.json");
    if (!existsSync(f)) continue;
    const groundDir = join(DERIVED, a, "ground");
    const meta = readJson<TerrainMeta>(join(groundDir, "meta.json"));
    const bytes = readFileSync(join(groundDir, "height.bin"));
    const terrain = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    if (terrain.length !== meta.nx * meta.ny) throw new Error(`invalid terrain grid: ${a}`);
    const features = readJson<Array<{ id?:number; bridge?:boolean; l?: Point[]; k: string; r?: Point[][] }>>(join(groundDir, "features.json"));
    const profiles = new Map(features.filter(f=>f.bridge && f.l).map(f=>[f.id, f.l!]));
    const water = features.filter(f => ["water", "sea", "pool"].includes(f.k) && f.r).map(f => f.r!);
    const waterAt = (x: number, y: number) => inWater(x, y, water);
    const zebra = crossingIndex(features.filter((f) => f.k === "crossing" && f.l).map((f) => f.l!));
    const els = readJson(f).elements.filter((el: any) => {
      const t = el.tags ?? {};
      if (seen.has(el.id)) return false;
      seen.add(el.id);
      return el.geometry?.length >= 2 && (!t.tunnel || t.tunnel === "no") && (!t.covered || t.covered === "no") && !belowSurface(t) && roadWidth(t) > 0; // no cars through arches either
    });
    // split ways at every node another road shares, so junctions are always way ends
    const use = new Map<number, number>();
    for (const el of els) el.nodes.forEach((n: number, i: number) => use.set(n, (use.get(n) ?? 0) + (i === 0 || i === el.nodes.length - 1 ? 2 : 1)));
    for (const el of els) {
      const t = el.tags ?? {};
      const cls = CLS[String(t.highway).replace("_link", "")] ?? 5;
      const width = roadWidth(t);
      const isBridge = !!t.bridge && t.bridge !== "no";
      const bridgeLine = profiles.get(el.id);
      const deck = isBridge && bridgeLine ? bridgeProfile(bridgeLine,(x,y)=>groundAt(meta,terrain,x,y),waterAt) : null;
      let start = 0;
      for (let end = 1; end < el.nodes.length; end++) {
        if (end < el.nodes.length - 1 && (use.get(el.nodes[end]) ?? 0) < 2) continue;
        const pts = el.geometry.slice(start, end + 1).map((p: any) => ({ lat: p.lat, lon: p.lon, e: ecefToEnu(llhToEcef(p.lat, p.lon, 0)) }));
        const samples: number[] = [], waterSamples: boolean[] = [];
        for (let i = 0; i < pts.length - 1; i++) {
          const a0 = pts[i], b0 = pts[i + 1];
          const n = Math.max(1, Math.ceil(Math.hypot(b0.e[0] - a0.e[0], b0.e[1] - a0.e[1]) / 2));
          for (let k = 0; k < n + (i === pts.length - 2 ? 1 : 0); k++) {
            const f2 = k / n, lat = a0.lat + (b0.lat - a0.lat) * f2, lon = a0.lon + (b0.lon - a0.lon) * f2;
            const e = ecefToEnu(llhToEcef(lat, lon, 0));
            const up = isBridge ? (deck ? deckHeight(deck,e[0],e[1]) : null)
              : Number(t.layer)>0 ? null : groundAt(meta, terrain, e[0], e[1]);
            total++;
            samples.push(Math.round(e[0]*10)/10, Math.round(e[1]*10)/10, up === null ? 0 : Math.round(up*10)/10, up === null ? 0 : 1);
            waterSamples.push(waterAt(e[0], e[1]));
          }
        }
        ways.push({
          x: crossingsAlong(samples, zebra),
          bridge: !!t.bridge && t.bridge !== "no", water: waterSamples, waterAt,
          y: Number(t.layer) || (t.bridge && t.bridge !== "no" ? 1 : 0),
          c: cls, o: t.oneway === "-1" ? -1 : isOneway(t) ? 1 : 0,
          l: roadLanes(t), w: Math.round(width * 10) / 10, a: el.nodes[start], b: el.nodes[end], s: samples,
        });
        start = end;
      }
    }
  }
  // Resolve altitude before testing screen-space occlusion. A missing height pass is unsafe.
  hideBelowBanks(ways);
  hideUnderBridges(ways);
  for (const w of ways) for (let k = 0; k < w.s.length; k += 4) {
    if (!w.s[k+3]) continue;
    const a=Math.max(0,k-4), b=Math.min(w.s.length-4,k+4);
    const dx=w.s[b]-w.s[a], dy=w.s[b+1]-w.s[a+1], length=Math.hypot(dx,dy);
    if (!length) { w.s[k+3]=0; continue; }
    // Whole carriageway, not only its centre: lane offsets must not escape onto water/roofs.
    const steps=Math.max(1,Math.ceil(w.w));
    for(let j=0;j<=steps;j++) {
      const off=w.w*(j/steps-0.5);
      const p: [number,number,number]=[w.s[k]+dy/length*off,w.s[k+1]-dx/length*off,w.s[k+2]];
      if (!w.bridge && w.waterAt(p[0],p[1])) { w.s[k+3]=0; break; }
      // A roof/overhang can cover the bus silhouette even when the road centre is clear.
      for (const lift of [0, 1.6, 3.2]) {
        const q: [number,number,number] = [p[0],p[1],p[2]+lift];
        const [x,y]=enuToPixel(q);
        await heights.ensure(x,y);
        if (!roadSurfaceSafe(heights.at(x,y),enuHeight(q),lift===0)
          || !paintedArt.has(key(Math.floor(x/CAMERA.tile),Math.floor(y/CAMERA.tile)))
          || edgeDistance(x,y)<(EDGE0+EDGE1)/2
          // nothing drives in the feathered band where the painting dissolves into the blur
          || paintedDistance(paintedArt,x,y,CAMERA.tile)<FEATHER*0.75) { w.s[k+3]=0; break; }
      }
      if (!w.s[k+3]) break;
    }
  }
  worksites = await findWorksites(ways, heights);
  occluded = ways.reduce((n,w)=>n+w.s.filter((v,i)=>i%4===3 && !v).length,0);
  writeData("roads", JSON.stringify(encodeRoads(ways)));
  console.log(`  roads: ${ways.length} ways, ${total} samples, ${((occluded / Math.max(1, total)) * 100).toFixed(1)}% occluded`);
}

/**
 * Spots for the painter crews: ground-level streets (not bridges, not under anything, carriageway
 * visible on the height pass) inside the fade band where the painting meets the not yet painted city
 * (never next to the clouds at the map's outer edge). One per ~250 m of that boundary, the widest
 * street of each cell, so crews stand on asphalt or piazza, never on a roof.
 */
async function findWorksites(ways: Array<{ c: number; w: number; y: number; bridge: boolean; s: number[]; waterAt: (x: number, y: number) => boolean }>, heights: Heights) {
  const CELL = 1000, best = new Map<string, number[]>();
  for (const w of ways) {
    if (w.bridge || w.y > 0 || w.c > 4 || w.w < 5) continue;
    for (let k = 8; k + 8 < w.s.length; k += 16) { // every ~8 m
      const e = w.s[k], n = w.s[k + 1], u = w.s[k + 2];
      const [x, y] = enuToPixel([e, n, u]);
      if (!paintedArt.has(key(Math.floor(x / CAMERA.tile), Math.floor(y / CAMERA.tile)))) continue;
      const d = paintedDistance(paintedArt, x, y, CAMERA.tile);
      if (d < FEATHER * 0.18 || d > FEATHER * 0.6) continue;
      if (edgeDistance(x, y) < EDGE1) continue; // that edge is the clouds, not a work site (edgeDistance tops out near EDGE1 + EDGE0 / 2)
      const dx = w.s[k + 4] - w.s[k - 4], dy = w.s[k + 5] - w.s[k - 3], L = Math.hypot(dx, dy);
      if (!L) continue;
      let ok = true;
      for (const off of [-w.w / 2, 0, w.w / 2]) {
        const q: [number, number, number] = [e + (dy / L) * off, n - (dx / L) * off, u];
        if (w.waterAt(q[0], q[1])) { ok = false; break; }
        for (const lift of [0, 1.6, 3.2]) {
          const [qx, qy] = enuToPixel([q[0], q[1], q[2] + lift]);
          await heights.ensure(qx, qy);
          if (!roadSurfaceSafe(heights.at(qx, qy), enuHeight([q[0], q[1], q[2] + lift]), lift === 0)) { ok = false; break; }
        }
        if (!ok) break;
      }
      if (!ok) continue;
      const cell = `${Math.floor(x / CELL)}_${Math.floor(y / CELL)}`, score = w.w - Math.abs(d / FEATHER - 0.35) * 10;
      const prev = best.get(cell);
      if (!prev || score > prev[7]) best.set(cell, [Math.round(e * 10) / 10, Math.round(n * 10) / 10, Math.round(u * 10) / 10,
        Math.round((dx / L) * 1000) / 1000, Math.round((dy / L) * 1000) / 1000, w.w, Math.round((d / FEATHER) * 100) / 100, score]);
    }
  }
  const sites = [...best.values()].map((v) => v.slice(0, 7));
  console.log(`  worksites: ${sites.length} painter crews along the paint boundary`);
  return sites;
}

/**
 * Public transport (Rome GTFS, CC BY-SA; transit.ts): bus lines as ENU guide paths for the viewer's
 * road graph, tram lines as their own sampled tracks with terrain / bridge-deck height and the same
 * visibility rule as the roads (asphalt visible, painted, outside the cloud and feather bands).
 */
async function exportTransit(areas: string[], heights: Heights) {
  if (activeRegion() !== "roma-centro") return;
  const feed = await fetchGtfs(RAW);
  const grids = areas.map((a) => {
    const dir = join(DERIVED, a, "ground");
    const meta = readJson<TerrainMeta>(join(dir, "meta.json"));
    const b = readFileSync(join(dir, "height.bin"));
    const features = readJson<Array<{ id?: number; bridge?: boolean; l?: Point[]; k: string; r?: Point[][] }>>(join(dir, "features.json"));
    const water = features.filter((f) => ["water", "sea", "pool"].includes(f.k) && f.r).map((f) => f.r!);
    return { meta, terrain: new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)), water,
      bridges: features.filter((f) => f.bridge && f.l).map((f) => f.l!), rails: features.filter((f) => f.k === "rail" && f.l).map((f) => f.l!) };
  });
  const ground = (x: number, y: number) => { for (const g of grids) { const z = groundAt(g.meta, g.terrain, x, y); if (z !== null) return z; } return null; };
  const wet = (x: number, y: number) => grids.some((g) => inWater(x, y, g.water));
  const decks = grids.flatMap((g) => g.bridges).map((l) => bridgeProfile(l, ground, wet)).filter((d): d is NonNullable<typeof d> => !!d);
  const painted = (e: number, n: number) => { const z = ground(e, n) ?? 60, [x, y] = enuToPixel([e, n, z]); return paintedArt.has(key(Math.floor(x / CAMERA.tile), Math.floor(y / CAMERA.tile))); };
  const toEnu = (lon: number, lat: number): [number, number] => { const p = ecefToEnu(llhToEcef(lat, lon, 0)); return [p[0], p[1]]; };
  const lines = await readTransit(feed, toEnu, painted);
  const rails = railIndex(grids.flatMap((g) => g.rails));
  const snapStats = { on: 0, all: 0 };
  const trams: Array<{ c: number; o: number; l: number; w: number; a: number; b: number; s: number[] }> = [];
  const tramMeta: Array<{ n: string; d: number; h: number; st: number[] }> = [];
  let tramNode = -1;
  for (const line of lines.filter((l) => l.kind === "tram")) {
    const s: number[] = [];
    // one continuous 2 m sampling along the whole path (per-segment restarts left zero-length
    // steps at the joints, which the viewer's safety filter cut into 20–80 m scraps)
    const pts: Array<[number, number]> = [];
    let carry = 0;
    for (let i = 1; i < line.path.length; i++) {
      const [ax, ay] = line.path[i - 1], [bx, by] = line.path[i], L = Math.hypot(bx - ax, by - ay);
      if (L < 1e-3) continue;
      for (let d = carry; d < L; d += 2) pts.push([ax + (bx - ax) * d / L, ay + (by - ay) * d / L]);
      carry = (2 - ((L - carry) % 2)) % 2;
    }
    const snapped = snapToRails(pts, rails);
    snapStats.on += snapped.on; snapStats.all += pts.length;
    for (const [e, n] of snapped.pts) {
      {
        let z = ground(e, n), vis = z !== null ? 1 : 0;
        if (z !== null && wet(e, n)) { // on the water only on a mapped bridge deck
          const dz = decks.map((p) => deckHeight(p, e, n)).find((v) => v !== null);
          if (dz === undefined || dz === null) vis = 0; else z = dz;
        }
        if (vis) for (const lift of [0, 1.6, 3.4]) {
          const q: [number, number, number] = [e, n, z! + lift], [x, y] = enuToPixel(q);
          await heights.ensure(x, y);
          if (!roadSurfaceSafe(heights.at(x, y), enuHeight(q), lift === 0) || !paintedArt.has(key(Math.floor(x / CAMERA.tile), Math.floor(y / CAMERA.tile)))
            || edgeDistance(x, y) < (EDGE0 + EDGE1) / 2 || paintedDistance(paintedArt, x, y, CAMERA.tile) < FEATHER * 0.75) { vis = 0; break; }
        }
        s.push(Math.round(e * 10) / 10, Math.round(n * 10) / 10, Math.round((z ?? 0) * 10) / 10, vis);
      }
    }
    if (s.filter((v, i) => i % 4 === 3 && v).length < 50) continue; // under 100 m visible: skip
    trams.push({ c: 2, o: 1, l: 1, w: 3, a: tramNode--, b: tramNode--, s });
    tramMeta.push({ n: line.name, d: line.dir, h: line.headway, st: line.stops.flat() });
  }
  // bus guides: only the stretches within ~300 m of the painted area (the viewer's road graph is
  // limited to it anyway); a line leaving and re-entering gives several guides
  const buses: Array<{ n: string; d: number; h: number; p: number[] }> = [];
  for (const l of lines.filter((l) => l.kind === "bus")) {
    const near = l.path.map(([e, n]) => painted(e, n));
    const keepPt = near.map((_, i) => near.slice(Math.max(0, i - 30), i + 31).some(Boolean));
    for (let i = 0; i < l.path.length;) {
      if (!keepPt[i]) { i++; continue; }
      let j = i; while (j < l.path.length && keepPt[j]) j++;
      if (j - i >= 20) buses.push({ n: l.name, d: l.dir, h: l.headway, p: l.path.slice(i, j).flat() });
      i = j;
    }
  }
  writeData("transit", JSON.stringify({ licence: "CC BY-SA, Roma Servizi per la Mobilità (GTFS)", buses, trams: { meta: tramMeta, tracks: encodeRoads(trams) } }));
  console.log(`  transit: ${buses.length} bus line-directions, ${tramMeta.length} tram line-directions through the painted area, ${((snapStats.on / Math.max(1, snapStats.all)) * 100).toFixed(0)}% of tram samples on an OSM rail`);
}

/**
 * Roads for the viewer, columnar and delta-coded (~2.6× smaller than one object per way after
 * compression; decoded by web/src/scripts/roads.ts back into { c, o, l, w, a, b, s } per way):
 *   c, o, l, w   per way: class, oneway, lanes, width (m)
 *   a, b         per way: junction ids (OSM node ids renumbered 0…, only their identity matters)
 *   n            per way: number of samples
 *   s            per sample e, n, u in 0.1 m: a way's first sample absolute, then differences
 *   v            per way: number of runs, then run lengths of visible / hidden samples, visible first
 */
function encodeRoads(ways: Array<{ c: number; o: number; l: number; w: number; a: number; b: number; s: number[]; x?: number[] }>) {
  const ids = new Map<number, number>(), id = (n: number) => ids.get(n) ?? ids.set(n, ids.size).get(n)!;
  const out = { v: 2, c: [] as number[], o: [] as number[], l: [] as number[], w: [] as number[], a: [] as number[], b: [] as number[], n: [] as number[], s: [] as number[], vis: [] as number[], x: [] as number[] };
  for (const w of ways) {
    out.c.push(w.c); out.o.push(w.o); out.l.push(w.l); out.w.push(w.w); out.a.push(id(w.a)); out.b.push(id(w.b));
    const x = w.x ?? [];
    out.x.push(x.length / 2, ...x.map((v) => Math.round(v * 10))); // zebra bands: [distance from start, half length] (dm)
    out.n.push(w.s.length / 4);
    let pe = 0, pn = 0, pu = 0, cur = 1, run = 0;
    const runs: number[] = [];
    for (let k = 0; k < w.s.length; k += 4) {
      const e = Math.round(w.s[k] * 10), n = Math.round(w.s[k + 1] * 10), u = Math.round(w.s[k + 2] * 10);
      out.s.push(e - pe, n - pn, u - pu);
      pe = e; pn = n; pu = u;
      if (w.s[k + 3] === cur) run++; else { runs.push(run); cur = w.s[k + 3]; run = 1; }
    }
    runs.push(run);
    out.vis.push(runs.length, ...runs);
  }
  return out;
}

/**
 * Vehicles on a road passing under a bridge (a road on a higher layer) must disappear beneath its
 * deck: mark those samples hidden. Returns how many samples were hidden.
 */
function hideUnderBridges(ways: Array<{ y: number; w: number; a: number; b: number; s: number[] }>) {
  type Seg = [number, number, number, number, number, number, number, number]; // a, b, half width, layer, way ends
  const CELL = 20, grid = new Map<string, Seg[]>();
  for (const w of ways) {
    if (w.y <= 0) continue;
    for (let k = 0; k + 4 < w.s.length; k += 4) {
      const seg: Seg = [w.s[k], w.s[k + 1], w.s[k + 4], w.s[k + 5], w.w / 2 + 1.5, w.y, w.a, w.b];
      for (let gx = Math.floor(Math.min(seg[0], seg[2]) / CELL) - 1; gx <= Math.floor(Math.max(seg[0], seg[2]) / CELL) + 1; gx++)
        for (let gy = Math.floor(Math.min(seg[1], seg[3]) / CELL) - 1; gy <= Math.floor(Math.max(seg[1], seg[3]) / CELL) + 1; gy++)
          grid.set(`${gx},${gy}`, [...(grid.get(`${gx},${gy}`) ?? []), seg]);
    }
  }
  let hidden = 0;
  for (const w of ways)
    for (let k = 0; k < w.s.length; k += 4) {
      const x = w.s[k], y = w.s[k + 1];
      if (!w.s[k + 3]) continue;
      for (const [ax, ay, bx, by, r, layer, ea, eb] of grid.get(`${Math.floor(x / CELL)},${Math.floor(y / CELL)}`) ?? []) {
        if (layer <= w.y || [ea, eb].includes(w.a) || [ea, eb].includes(w.b)) continue; // not the bridge's own approach
        const dx = bx - ax, dy = by - ay, t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
        if (Math.hypot(x - ax - t * dx, y - ay - t * dy) < r) { w.s[k + 3] = 0; hidden++; break; }
      }
    }
  return hidden;
}

/** Interior point farthest from the boundary (coarse pole of inaccessibility), as [y, x]. */
function labelPoint(rings: Array<Array<[number, number]>>): [number, number] {
  const ring = rings.reduce((a, b) => (b.length > a.length ? b : a));
  const ys = ring.map((p) => p[0]), xs = ring.map((p) => p[1]);
  const [y0, y1, x0, x1] = [Math.min(...ys), Math.max(...ys), Math.min(...xs), Math.max(...xs)];
  const inside = (x: number, y: number) => {
    let c = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [yi, xi] = ring[i], [yj, xj] = ring[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
    }
    return c;
  };
  const distEdge = (x: number, y: number) => {
    let d = Infinity;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [ay, ax] = ring[j], [by, bx] = ring[i];
      const L2 = (bx - ax) ** 2 + (by - ay) ** 2 || 1;
      const t = Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / L2));
      d = Math.min(d, Math.hypot(x - ax - t * (bx - ax), y - ay - t * (by - ay)));
    }
    return d;
  };
  let best: [number, number] = [ys[0], xs[0]], bestD = -1;
  const N = 40;
  for (let i = 0; i <= N; i++) for (let j = 0; j <= N; j++) {
    const x = x0 + ((x1 - x0) * i) / N, y = y0 + ((y1 - y0) * j) / N;
    if (!inside(x, y)) continue;
    const d = distEdge(x, y);
    if (d > bestD) { bestD = d; best = [Math.round(y), Math.round(x)]; }
  }
  return best;
}

function stitch(ways: Array<Array<[number, number]>>) {
  const eq = (a: [number, number], b: [number, number]) => a[0] === b[0] && a[1] === b[1];
  const left = ways.map((w) => [...w]);
  const rings: Array<Array<[number, number]>> = [];
  while (left.length) {
    const ring = left.shift()!;
    let grown = true;
    while (!eq(ring[0], ring[ring.length - 1]) && grown) {
      grown = false;
      for (let i = 0; i < left.length; i++) {
        const w = left[i], end = ring[ring.length - 1];
        if (eq(w[0], end)) ring.push(...w.slice(1));
        else if (eq(w[w.length - 1], end)) ring.push(...w.reverse().slice(1));
        else continue;
        left.splice(i, 1);
        grown = true;
        break;
      }
    }
    rings.push(ring);
  }
  return rings;
}

/**
 * Each city's opening view as one small image (and a ~0.5 KB blurred version inlined in the page), so
 * the first frame shows the map at once and the tiles fade in over it. The viewer opens a city
 * centred on `center` with `widthM` across the screen; the image covers that width and a fixed
 * height: H = 0.8 W for landscape screens (aspect ≥ 5:4), 2.2 W for portrait. The page lays it out with CSS
 * only (full width, centred vertically), so it lines up with the map before any script runs.
 */
const PREVIEWS = { land: { aspect: 0.8, width: 768 }, port: { aspect: 2.2, width: 480 } };
async function exportPreviews() {
  const out: Record<string, Record<string, { file: string; lqip: string }>> = {};
  for (const [slug, city] of Object.entries(CITIES)) {
    if (city.region !== activeRegion()) continue;
    const [cx, cy] = llhToPixel(city.center[0], city.center[1], 25); // as the viewer's show()
    const W = city.widthM / CAMERA.mpp;
    out[slug] = {};
    for (const [kind, { aspect, width }] of Object.entries(PREVIEWS)) {
      const H = W * aspect, height = Math.round(width * aspect);
      // the finest zoom that still has at least `width` pixels across the view
      const z = Math.min(NATIVE_Z, NATIVE_Z - Math.floor(Math.log2(W / width)));
      const f = 2 ** (z - NATIVE_Z), span = TS / f;
      const x0 = cx - W / 2, y0 = cy - H / 2;
      const composite = [];
      for (let ty = Math.floor(y0 / span); ty <= Math.floor((y0 + H) / span); ty++)
        for (let tx = Math.floor(x0 / span); tx <= Math.floor((x0 + W) / span); tx++) {
          if (!index.map?.[z]?.[key(tx, ty)] && !state.layers.map?.hashes[`${z}/${tx}_${ty}`]) continue;
          composite.push({ input: await readTile("map", z, tx, ty), left: Math.round((tx * span - x0) * f), top: Math.round((ty * span - y0) * f) });
        }
      const cw = Math.round(W * f), ch = Math.round(H * f);
      const inside = composite.filter((c) => c.left < cw && c.top < ch && c.left > -TS && c.top > -TS);
      // sharp composites need inputs inside the canvas: pad by a tile on every side, then crop
      const canvas = await sharp({ create: { width: cw + 2 * TS, height: ch + 2 * TS, channels: 3, background: { r: BG[0], g: BG[1], b: BG[2] } } })
        .composite(inside.map((c) => ({ ...c, left: c.left + TS, top: c.top + TS }))).png().toBuffer();
      const view = await sharp(canvas).extract({ left: TS, top: TS, width: cw, height: ch }).resize(width, height, { kernel: "lanczos3" }).png().toBuffer();
      const img = await sharp(view).avif({ quality: 45, effort: 6 }).toBuffer();
      const name = `preview/${slug}-${kind}`, h = hash(img), file = `${name}.${h}.${FORMAT}`;
      if (state.data[name] !== h) {
        mkdirSync(join(OUT, "preview"), { recursive: true });
        writeFileSync(join(OUT, file), img);
        state.data[name] = h;
      }
      const tiny = await sharp(view).resize(24, Math.round(24 * aspect)).webp({ quality: 40 }).toBuffer();
      out[slug][kind] = { file, lqip: `data:image/webp;base64,${tiny.toString("base64")}` };
      console.log(`  preview ${slug} ${kind}: ${width}×${height} from z${z}, ${(img.length / 1024).toFixed(0)} KB`);
    }
  }
  return out;
}

let OUT = ""; // data/web/regions/<region>

async function main() {
  const { values: args, positionals: names } = parseArgs({ allowPositionals: true, options: {
    "data-only": { type: "boolean" },
    "art-bounds": { type: "string" },
    "check-coverage": { type: "boolean" },
    "require-painted": { type: "boolean" },
  } });
  const requestedBounds = args["art-bounds"] ? parseArtBounds(args["art-bounds"]) : null;
  const areas = names.length ? names : ["roma-core"];
  const regions = new Set(areas.map((a) => openArea(a).region));
  if (regions.size !== 1) throw new Error(`export one region at a time (got ${[...regions].join(", ")})`);
  OUT = join(WEB_CACHE, "regions", activeRegion());
  const from = [pendingFile(), publishedFile()].find(existsSync);
  if (from) state = readJson(from);
  console.log(`  ${activeRegion()}: ${from ? `changes since ${from === pendingFile() ? "the last (unpublished) export" : "the published state"}` : "no published state: building everything"}`);
  outlines = areas.map((a) => areaPolygon(AREAS[a].bbox));
  {
    // deepest point inside the union of outlines (coarse grid): the cloud band takes at most 35% of it
    const pts = outlines.flat(), xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    let deepest = 0;
    for (let x = Math.min(...xs); x <= Math.max(...xs); x += 256) for (let y = Math.min(...ys); y <= Math.max(...ys); y += 256) deepest = Math.max(deepest, edgeDistance(x, y));
    EDGE0 = Math.round(Math.min(760, deepest * 0.1));
    EDGE1 = EDGE0 + Math.round(Math.min(2600, deepest * 0.35));
    console.log(`  cloud band: ${EDGE0}–${EDGE1} art px from the outline (deepest point ${Math.round(deepest)} px)`);
  }
  const photo = new Map<Key, string>(), art = new Map<Key, string>();
  const attributions = new Set<string>();
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const a of areas) {
    const dir = join(DERIVED, a);
    const m = readJson(join(dir, "manifest.json"));
    (m.attributions as string[]).flatMap((s) => s.split(";")).map((s) => s.trim()).filter(Boolean).forEach((s) => attributions.add(s));
    for (const [layer, map] of [["render", photo], ["paint", art]] as const) {
      if (!existsSync(join(dir, layer))) continue;
      for (const f of readdirSync(join(dir, layer)).filter((f) => f.endsWith(".png"))) {
        const [tx, ty] = parse(f.replace(".png", ""));
        map.set(key(tx, ty), join(dir, layer, f));
        x0 = Math.min(x0, tx * CAMERA.tile); y0 = Math.min(y0, ty * CAMERA.tile);
        x1 = Math.max(x1, (tx + 1) * CAMERA.tile); y1 = Math.max(y1, (ty + 1) * CAMERA.tile);
      }
    }
  }
  rendered = new Set(photo.keys());
  const playable = requestedBounds ?? paintedBounds(art.keys(), CAMERA.tile);
  if (!playable) throw new Error("no painted tiles: playable area cannot be exported");
  const coverage = (requestedBounds ? artCoverage : renderedCoverage)(playable, new Set(art.keys()), new Set(photo.keys()), CAMERA.tile);
  console.log(`  paint coverage: ${JSON.stringify(coverage)}`);
  if (args["require-painted"] && (coverage.missingPaint.length || coverage.missingRender.length))
    throw new Error("incomplete playable coverage: finish render/paint/assemble before the final export");
  if (args["check-coverage"]) return; // read-only preflight, no roads/tiles/world/state writes
  const heights = new Heights(areas.map((a) => join(DERIVED, a, "height")));
  paintedArt = new Set(art.keys());
  await exportRoads(areas, heights);
  await exportTransit(areas, heights);
  if (!args["data-only"]) {
    paintedArt = new Set(art.keys());
    await exportLayer("map", new Map([...photo, ...art])); // painted wins; unpainted fogged
    await exportLayer("photo", photo);
    for (const layer of Object.keys(index)) writeData(`tiles-${layer}`, JSON.stringify(index[layer]));
  }
  await exportBorders(heights);
  const previews = await exportPreviews();
  // OpenSeadragon wants non-negative tile indices at every level: origin aligned to a min-zoom tile
  const block = TS * 2 ** (NATIVE_Z - MIN_Z);
  const ox = Math.floor(x0 / block) * block, oy = Math.floor(y0 / block) * block;
  const { right: r, up: u } = axes();
  const m = CAMERA.mpp;
  // Keep a release rectangle fixed while its gaps are painted; stray painted islands do not expand it.
  const [px0, py0, px1, py1] = playable;
  const projectLandmark = landmarkProjector(areas);
  const world = JSON.stringify({
    tile_size: TS, native_zoom: NATIVE_Z, min_zoom: MIN_Z, bounds: [[y0, x0], [y1, x1]],
    playable: [[py0, px0], [py1, px1]],
    activity: { version: 1, tileSize: CAMERA.tile, tiles: [...paintedArt].sort(), bounds: playable },
    worksites,
    landmarks: Object.fromEntries((LANDMARKS[Object.keys(CITIES).find(c => CITIES[c].region === activeRegion()) ?? ""] ?? [])
      .map(lm => [lm.name, projectLandmark(lm)])),
    origin: [ox, oy], size: [Math.ceil((x1 - ox) / block) * block, Math.ceil((y1 - oy) / block) * block],
    // ENU meters -> art pixels (linear; ENU origin = pixel origin)
    enu2px: [[r[0] / m, r[1] / m, r[2] / m], [-u[0] / m, -u[1] / m, -u[2] / m]],
    camera: camera(), title: REGIONS[activeRegion()].title, credits: REGIONS[activeRegion()].credits,
    airport: REGIONS[activeRegion()].airport ?? null, areas: areas.map((a) => ({ id: a, title: AREAS[a]?.title })),
    layers: { photo: photo.size, art: art.size }, attributions: [...attributions],
    format: FORMAT,
    files: { "tiles-map": dataFile("tiles-map"), "tiles-photo": dataFile("tiles-photo"), borders: dataFile("borders"), roads: dataFile("roads"), transit: dataFile("transit") },
    previews,
  }, null, 2);
  if (state.data["world.json"] !== hash(world)) {
    mkdirSync(join(OUT, "data"), { recursive: true });
    writeFileSync(join(OUT, "data", "world.json"), world);
    state.data["world.json"] = hash(world);
  }
  console.log(`  world.json: ${photo.size} rendered, ${art.size} painted tiles`);
  mkdirSync(WEB_CACHE, { recursive: true });
  writeFileSync(pendingFile(), JSON.stringify(state));
  const files = existsSync(OUT) ? readdirSync(OUT, { recursive: true }).filter((f) => String(f).match(/\.(avif|webp|json)$/)).length : 0;
  console.log(files ? `  ${files} files ready in ${OUT}\n  preview: npm run dev · publish: npm run publish -- ${activeRegion()}` : "  nothing changed");
}


main();
