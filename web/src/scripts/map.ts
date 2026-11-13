import OpenSeadragon from "openseadragon";
// traffic, cats and sky are loaded after the first view (loadAnimations): not in the first script
import type { Traffic } from "./traffic.ts";
import type { Cats } from "./cats.ts";
import type { Airport } from "./sky.ts";
import { CAMERA, llhToPixel, useRegion } from "../../../pipeline/src/camera.ts";
import { CITIES } from "../../../pipeline/src/places.ts";
import { LANDMARKS, landmarkPixel } from "../../../pipeline/src/landmarks.ts";
import { ActivityMask, activeRoads, type ActivityCoverage } from "./activity.ts";
import { startAmbient } from "./ambient.ts";
declare const __TILES_ORIGIN__: string; // TILES_ORIGIN from .env, injected by astro.config.mjs

interface World {
  activity?: ActivityCoverage;
  /** painter crews' spots along the paint boundary (export.ts findWorksites) */
  worksites?: number[][];
  landmarks?: Record<string, [number, number]>;
  tile_size: number;
  native_zoom: number;
  min_zoom: number;
  bounds: [[number, number], [number, number]]; // [[y0, x0], [y1, x1]] global art px
  /** Painted (ready) AABB — clamp pan/zoom here. Falls back to city opening view. */
  playable?: [[number, number], [number, number]];
  origin: [number, number];                     // global px of image (0, 0)
  size: [number, number];
  enu2px: number[][];
  camera: { headingDeg: number; origin: { lat: number; lon: number } };
  airport: Airport | null;
  areas: Array<{ id: string; title?: string }>;
  layers: { photo: number; art: number };
  attributions: string[];
  /** content-hashed data files (absent in data exported before them: then the legacy names) */
  files?: { "tiles-map"?: string; "tiles-photo"?: string; borders?: string; roads?: string; transit?: string };
  format?: string;
}
type Index = Record<number, Record<string, string>>; // zoom → "x_y" → content hash
interface Border { id: number; name: string; name_en?: string; rings: Array<Array<[number, number]>>; label?: [number, number] }

// the page says which city it is; the city's region is one flat map under /regions/<region>/
const city = CITIES[document.body.dataset.city!], REGION = document.body.dataset.region!;
// map data lives on R2; the dev server serves /regions from the export cache, falling back to R2
const BASE = `${import.meta.env.DEV ? "" : __TILES_ORIGIN__}/regions/${REGION}`;
useRegion(REGION);
const json = <T>(file: string) => fetch(`${BASE}/data/${file}`).then((r) => r.json() as Promise<T>);
// the page preloads the data files named in world.json at build time (MapPage.astro); world.json is
// the truth (a publish after the build renames them; those preloads then go unused)
const worldReady = json<World>("world.json");
// AVIF tiles (40% smaller); browsers without AVIF get the last WebP pyramid (data/tiles.json)
const avifReady = new Promise<boolean>((done) => {
  const img = new Image();
  img.onload = () => done(img.width === 1);
  img.onerror = () => done(false);
  img.src = "data:image/avif;base64,AAAAHGZ0eXBhdmlmAAAAAG1pZjFhdmlmbWlhZgAAANZtZXRhAAAAAAAAACFoZGxyAAAAAAAAAABwaWN0AAAAAAAAAAAAAAAAAAAAACJpbG9jAAAAAERAAAEAAQAAAAAA+gABAAAAAAAAAB0AAAAjaWluZgAAAAAAAQAAABVpbmZlAgAAAAABAABhdjAxAAAAAA5waXRtAAAAAAABAAAAVmlwcnAAAAA4aXBjbwAAAAxhdjFDgSACAAAAABRpc3BlAAAAAAAAAAEAAAABAAAAEHBpeGkAAAAAAwgICAAAABZpcG1hAAAAAAAAAAEAAQOBAgMAAAAlbWRhdBIACgc4AAaQENBpMhAdgmLE4AAWAACQNY48fpPA";
});
const [world, avif] = await Promise.all([worldReady, avifReady]);
const files = world.files ?? {}, modern = Boolean(avif && files["tiles-map"]);
const EXT = modern ? world.format ?? "avif" : "webp";
const legacy = modern ? null : json<Record<string, Index>>("tiles.json");
/** a layer's tile index; the photo layer's only when it is first shown */
const layerIndex = (layer: "map" | "photo") => (legacy ? legacy.then((all) => all[layer] ?? {}) : json<Index>(files[`tiles-${layer}`]!));
const [borders, mapIndex] = await Promise.all([json<Border[]>(files.borders ?? "borders.json"), layerIndex("map")]);
const activity = new ActivityMask(world.activity);
const [ox, oy] = world.origin;
const TS = world.tile_size, NZ = world.native_zoom;

/** Sparse pyramid in global tile indices, exposed to OpenSeadragon with a non-negative origin. */
function tileSource(layer: string, have: Index) {
  const global = (level: number, x: number, y: number) => {
    const span = TS * 2 ** (NZ - level);
    return [x + Math.round(ox / span), y + Math.round(oy / span)];
  };
  return {
    width: world.size[0], height: world.size[1], tileSize: TS, tileOverlap: 0,
    minLevel: world.min_zoom, maxLevel: NZ,
    getTileUrl: (level: number, x: number, y: number) => {
      const [tx, ty] = global(level, x, y);
      return `${BASE}/tiles/${layer}/${level}/${tx}/${ty}.${EXT}?v=${have[level][`${tx}_${ty}`]}`; // immutable URL per content
    },
    tileExists: (level: number, x: number, y: number) => {
      const [tx, ty] = global(level, x, y);
      return have[level]?.[`${tx}_${ty}`] !== undefined;
    },
  };
}

const viewer = OpenSeadragon({
  element: document.getElementById("map")!,
  tileSources: tileSource("map", mapIndex) as unknown as OpenSeadragon.TileSourceOptions,
  showNavigationControl: false,
  drawer: "canvas",       // WebGL drawer leaves coloured fringes at transparent tile edges
  subPixelRoundingForTransparency: { "*": OpenSeadragon.SUBPIXEL_ROUNDING_OCCURRENCES.ALWAYS }, // no hairline seams between tiles
  // smooth deep zoom: blend levels while loading, spring animation, modest overzoom
  blendTime: 0.15,
  animationTime: 0.9,
  springStiffness: 9,
  immediateRender: false,
  imageLoaderLimit: 8,
  minPixelRatio: 0.8,     // fetch the finer level only once it is really needed (~40% fewer bytes)
  maxImageCacheCount: 600,
  minZoomImageRatio: 0.2, // raised further on open to the ready/playable map
  maxZoomPixelRatio: 2.5,
  visibilityRatio: 1,       // keep the ready map filling the viewport — no black void
  constrainDuringPan: true,
  zoomPerScroll: 1.35,
  smoothTileEdgesMinZoom: Infinity,
  gestureSettingsMouse: { clickToZoom: false, dblClickToZoom: true, flickEnabled: true },
  preserveImageSizeOnResize: true,
});
Object.assign(window as object, { __viewer: viewer, OpenSeadragon, __world: world, __toScreen: (x: number, y: number) => toScreen(x, y) });

// ---- coordinate helpers (global art px <-> canvas px) -----------------------------------------
const canvas = document.createElement("canvas");
canvas.id = "overlay";
document.getElementById("map")!.appendChild(canvas);
const ctx = canvas.getContext("2d")!;
let k = 1, tx = 0, ty = 0; // canvas = global * k + t (no rotation)
const base = () => viewer.world.getItemAt(0);
function updateTransform() {
  const vp = viewer.viewport, item = base();
  if (!item) return;
  const a = vp.viewportToViewerElementCoordinates(item.imageToViewportCoordinates(0, 0, true));
  const b = vp.viewportToViewerElementCoordinates(item.imageToViewportCoordinates(1000, 0, true));
  const dpr = window.devicePixelRatio || 1;
  k = ((b.x - a.x) / 1000) * dpr;
  tx = a.x * dpr - ox * k;
  ty = a.y * dpr - oy * k;
}
const toScreen = (x: number, y: number): [number, number] => [x * k + tx, y * k + ty];
const globalToViewport = (x: number, y: number) => base().imageToViewportCoordinates(x - ox, y - oy);

// ---- overlay: borders, labels, traffic ------------------------------------------------------
let showBorders = false, showTraffic = true;
const heading = (world.camera.headingDeg * Math.PI) / 180;
let traffic: Traffic | null = null, cats: Cats | null = null, trams: import("./trams.ts").Trams | null = null;
let workers: import("./workers.ts").Workers | null = null;
let lights: import("./lights.ts").Lights | null = null;
// ---- live traffic (TomTom via /api/traffic), on the visitor's demand ----------------------------
let live: import("./live-traffic.ts").LiveTraffic | null = null, liveOn = false, liveTimer = 0;
const liveBtn = document.getElementById("live-toggle"), liveLegend = document.getElementById("live-legend"), liveStatus = document.getElementById("live-status");
async function refreshLive() {
  if (!liveOn || !liveStatus) return;
  if (!traffic) { liveStatus.textContent = "strade in caricamento…"; setTimeout(refreshLive, 1500); return; }
  if (!live) { const { LiveTraffic } = await import("./live-traffic.ts"); live = new LiveTraffic(traffic.wayRoads, world.enu2px); }
  if (!live.levels) liveStatus.textContent = "carico il traffico reale…";
  const ok = await live.load();
  if (!liveOn) return;
  if (ok) {
    traffic.setCongestion(live.levels);
    const t = new Date(live.at).toLocaleTimeString("it-IT", { timeZone: "Europe/Rome", hour: "2-digit", minute: "2-digit" });
    liveStatus.textContent = `dati delle ${t} · © TomTom · si aggiorna ogni 10 minuti`;
  } else liveStatus.textContent = live.levels ? "aggiornamento non riuscito: restano i dati precedenti · © TomTom" : "traffico reale non disponibile al momento";
}
liveBtn?.addEventListener("click", () => {
  liveOn = !liveOn;
  liveBtn.setAttribute("aria-pressed", String(liveOn));
  if (liveLegend) liveLegend.hidden = !liveOn;
  clearInterval(liveTimer);
  if (liveOn) { refreshLive(); liveTimer = window.setInterval(refreshLive, 5 * 60_000); }
  else traffic?.setCongestion(null);
});
const lightsCanvas = document.getElementById("lights") as HTMLCanvasElement | null;
const lctx = lightsCanvas?.getContext("2d") ?? null;
// the animations (their code and the roads, ~0.7 MB) wait until the first view's tiles are in
let animationsRequested = false;
function loadAnimations() {
  if (animationsRequested || !activity.rects.length) return;
  animationsRequested = true;
  Promise.all([
    import("./traffic.ts"), import("./cats.ts"), import("./roads.ts"), import("./trams.ts"), import("./workers.ts"), import("./lights.ts"),
    fetch(`${BASE}/data/${files.roads ?? "roads.json"}`).then((r) => (r.ok ? r.json() : [])),
    // real bus and tram lines (Roma Servizi per la Mobilità GTFS, CC BY-SA), when exported
    files.transit ? fetch(`${BASE}/data/${files.transit}`).then((r) => (r.ok ? r.json() : null)) : Promise.resolve(null),
  ]).then(([{ Traffic }, { Cats }, { decodeRoads }, { Trams }, { Workers }, { Lights }, data, transit]) => {
    if (world.worksites?.length) workers = new Workers(world.worksites, world.enu2px);
    const allRoads = decodeRoads(data);
    const roads = activeRoads(allRoads, world.enu2px, activity);
    if (roads.length) {
      traffic = new Traffic(roads, world.enu2px, [Math.sin(heading), Math.cos(heading)], 1.3, transit?.buses ?? []);
      traffic.clock = () => ambient.minutes();
    }
    if (transit?.trams?.meta?.length) {
      // tag each track with its line before activeRoads splits it into visible stretches
      const tracks = decodeRoads(transit.trams.tracks).map((r, t) => Object.assign(r, { t }));
      trams = new Trams(activeRoads(tracks, world.enu2px, activity), transit.trams.meta, world.enu2px, [Math.sin(heading), Math.cos(heading)]);
      trams.clock = () => ambient.minutes();
    }
    // cars and trams see each other: neither drives into the other
    if (traffic && trams) { const tf = traffic, tm = trams; tf.obstacles = () => tm.footprints(); tm.obstacles = () => tf.feet; }
    if (roads.length) cats = new Cats(roads, world.enu2px);
    // lamps on every street of the painted area, also the lanes hidden behind roofs (their glow shows)
    if (roads.length) lights = new Lights(allRoads, world.enu2px, (x, y) => !world.activity || activity.containsRect(x, y));
    // Unbounded scenic flight routes escape the ready area. Keep them inactive until routes
    // can be certified against the same coverage mask as the road graph.
    Object.assign(window as object, { __traffic: traffic, __cats: cats, __trams: trams, __workers: workers, __lights: lights, __ambient: ambient, __live: () => live, __parrots: null, __planes: null });
  });
}
setTimeout(loadAnimations, 6000); // slow connection: don't wait for every tile forever

// biggest cities get their label first when labels would collide
const ringArea = (r: Array<[number, number]>) => Math.abs(r.reduce((a, [y, x], i) => { const [y2, x2] = r[(i + 1) % r.length]; return a + x * y2 - x2 * y; }, 0) / 2);
const labelOrder = [...borders].sort((a, b) => ringArea(b.rings[0]) - ringArea(a.rings[0]));

function drawBorders(dpr: number) {
  ctx.lineWidth = 2 * dpr;
  ctx.setLineDash([6 * dpr, 4 * dpr]);
  ctx.strokeStyle = "#ffd84d";
  for (const c of borders) for (const ring of c.rings) {
    ctx.beginPath();
    let last: [number, number] | null = null;
    for (const [y, x] of ring) {
      const p = toScreen(x, y);
      if (last && Math.abs(p[0] - last[0]) + Math.abs(p[1] - last[1]) < 2) continue; // decimate
      if (last) ctx.lineTo(p[0], p[1]); else ctx.moveTo(p[0], p[1]);
      last = p;
    }
    ctx.closePath();
    ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.font = `600 ${13 * dpr}px ui-sans-serif, system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.lineWidth = 3 * dpr;
  ctx.strokeStyle = "rgba(0,0,0,0.75)";
  ctx.fillStyle = "#fff";
  const placed: Array<[number, number, number, number]> = [];
  for (const c of labelOrder) {
    if (!c.label) continue;
    const [px, py] = toScreen(c.label[1], c.label[0]);
    const label = c.name_en === "Tel-Aviv" ? "Tel Aviv-Yafo" : c.name_en ?? c.name;
    const w = ctx.measureText(label).width + 8 * dpr, hh = 16 * dpr;
    const box: [number, number, number, number] = [px - w / 2, py - hh, px + w / 2, py + 4 * dpr];
    if (placed.some((q) => box[0] < q[2] && box[2] > q[0] && box[1] < q[3] && box[3] > q[1])) continue;
    placed.push(box);
    ctx.strokeText(label, px, py);
    ctx.fillText(label, px, py);
  }
}

/** Monument / piazza labels for the current city (always on at street-level zoom). */
function drawLandmarks(dpr: number, pxPerArt: number) {
  const list = LANDMARKS[document.body.dataset.city!] ?? [];
  if (!list.length) return;
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";
  const placed: Array<[number, number, number, number]> = [];
  for (const lm of list) {
    if (pxPerArt < (lm.minPx ?? 0.08)) continue;
    // Exported ground anchor is shared with the paint prompt.
    const [gx, gy] = world.landmarks?.[lm.name] ?? landmarkPixel(lm);
    if (world.activity && !activity.containsRect(gx, gy)) continue;
    const [sx, sy] = toScreen(gx, gy);
    const size = Math.max(11, Math.min(15, 12 * dpr)) ;
    ctx.font = `600 ${size}px ui-sans-serif, system-ui, sans-serif`;
    const tw = ctx.measureText(lm.name).width + 10 * dpr, th = size + 6 * dpr;
    const box: [number, number, number, number] = [sx - tw / 2, sy - th - 10 * dpr, sx + tw / 2, sy - 2 * dpr];
    if (placed.some((q) => box[0] < q[2] && box[2] > q[0] && box[1] < q[3] && box[3] > q[1])) continue;
    placed.push(box);
    // pin
    ctx.beginPath();
    ctx.fillStyle = "rgba(20, 22, 28, 0.85)";
    ctx.arc(sx, sy - 2 * dpr, 3.2 * dpr, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#fff8e7";
    ctx.beginPath();
    ctx.arc(sx, sy - 2 * dpr, 1.6 * dpr, 0, Math.PI * 2);
    ctx.fill();
    // label chip
    const lx = sx, ly = sy - 8 * dpr;
    ctx.lineWidth = 3 * dpr;
    ctx.strokeStyle = "rgba(0,0,0,0.7)";
    ctx.fillStyle = "#fff";
    ctx.strokeText(lm.name, lx, ly);
    ctx.fillText(lm.name, lx, ly);
  }
}

const ambient = startAmbient(); // light of the hour + live weather (#ambient panel)
let lastT = performance.now();
function frame(t: number) {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(canvas.clientWidth * dpr), hgt = Math.round(canvas.clientHeight * dpr);
  if (canvas.width !== w || canvas.height !== hgt) { canvas.width = w; canvas.height = hgt; }
  updateTransform();
  ctx.clearRect(0, 0, w, hgt);
  // film mode (pipeline/src/film.ts): the recorder hands out exactly one frame of sim time per capture
  const film = (window as { __film?: { dt: number } }).__film;
  const dt = film ? film.dt : (t - lastT) / 1000;
  if (film) film.dt = 0;
  // zoomed out too far to see them (their draw() thresholds), cars and cats pause instead of
  // simulating thousands of invisible movers every frame
  const px = k / dpr;
  ctx.save();
  ctx.beginPath();
  for (const [x0,y0,x1,y1] of activity.rects) ctx.rect(x0*k+tx,y0*k+ty,(x1-x0)*k,(y1-y0)*k);
  ctx.clip(); // final guard for antialiasing / full silhouettes at tile boundaries
  if (liveOn && live) live.draw(ctx, k, tx, ty); // live traffic colours on the roads, under the vehicles
  if (trams && showTraffic && px >= 0.28) {
    trams.step(dt);
    trams.draw(ctx, toScreen, px, [0, 0, w, hgt]);
  }
  if (lights) lights.drawPosts(ctx, toScreen, w, hgt, ambient.night()); // lamp posts, under the night tint
  if (traffic && showTraffic && px >= 0.28) {
    traffic.step(dt);
    traffic.draw(ctx, toScreen, px, [0, 0, w, hgt]);
  }
  if (cats && showTraffic && px >= 0.6) {
    cats.step(dt);
    cats.draw(ctx, toScreen, px, [0, 0, w, hgt]);
  }
  if (workers && showTraffic && px >= 0.35) { // painter crews where the painting is still being laid
    workers.step(dt);
    workers.draw(ctx, toScreen, px, [0, 0, w, hgt]);
  }
  ctx.restore();
  ambient.draw(ctx, w, hgt, dt); // rain / fog of the live weather (screen space, over the map)
  if (lights && lctx && lightsCanvas) { // the city lit at night, over the night tint
    if (lightsCanvas.width !== w || lightsCanvas.height !== hgt) { lightsCanvas.width = w; lightsCanvas.height = hgt; }
    const night = ambient.night();
    lctx.save();
    lctx.beginPath();
    for (const [x0, y0, x1, y1] of activity.rects) lctx.rect(x0 * k + tx, y0 * k + ty, (x1 - x0) * k, (y1 - y0) * k);
    lctx.clip();
    lights.draw(lctx, toScreen, w, hgt, night, showTraffic ? [...(traffic?.lit ?? []), ...(trams?.lit ?? [])] : []);
    lctx.restore();
  }
  if (showBorders) drawBorders(dpr); // borders only on demand (B) — never force a metro overview
  if (px >= 0.06) drawLandmarks(dpr, px); // monumenti principali when zoomed in enough
  lastT = t;
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ---- controls ----------------------------------------------------------------------------------
let photo: OpenSeadragon.TiledImage | null = null, photoRequested = false;
function togglePhoto() {
  if (!photo) {
    if (photoRequested) return; // still loading its index
    photoRequested = true;
    layerIndex("photo").then((have) => viewer.addTiledImage({
      tileSource: tileSource("photo", have) as unknown as OpenSeadragon.TileSourceOptions,
      success: (e) => { photo = (e as unknown as { item: OpenSeadragon.TiledImage }).item; },
    }));
  } else photo.setOpacity(photo.getOpacity() > 0 ? 0 : 1);
}

const helpToggle = document.getElementById("help-toggle"), help = document.getElementById("help");
helpToggle?.addEventListener("click", () => { if (!help) return; help.hidden = !help.hidden; helpToggle.setAttribute("aria-expanded", String(!help.hidden)); });
window.addEventListener("keydown", (e) => {
  if (e.target instanceof HTMLInputElement) return; // typing / sliding must not toggle layers
  const key = e.key.toLowerCase();
  if (key === "b") showBorders = !showBorders;
  if (key === "t") showTraffic = !showTraffic;
  if (key === "p") togglePhoto();
  if (key === "v") document.body.classList.toggle("video");
  if (key === "h") document.body.classList.toggle("hide-ui"); // hide every control, keep the credits
});
if (new URLSearchParams(location.search).has("video")) document.body.classList.add("video");

// ---- opening preview (MapPage.astro): the city's view as one small image until the tiles are in ----
const preview = document.getElementById("preview");
function hidePreview(fast: boolean) {
  if (!preview?.isConnected) return;
  preview.style.transition = `opacity ${fast ? 0.15 : 0.45}s ease-out`;
  preview.style.opacity = "0";
  setTimeout(() => preview.remove(), fast ? 200 : 500);
}
if (preview) {
  // the image is laid out for the plain city view only; any gesture moves the map away from it
  for (const ev of ["canvas-press", "canvas-scroll", "canvas-pinch", "canvas-key"] as const) viewer.addOnceHandler(ev, () => hidePreview(true));
  setTimeout(() => hidePreview(false), 15000);
}

// Opening view, first match wins:
//   #@x,y,zoom          deep link (global art px, viewer zoom), kept up to date while you pan
//   ?at=lat,lon[,km]    a place, with the screen width in km (default 1.5)
//   #metro              the whole region with borders
//   otherwise           the page's city (centre + width from places.ts)
/** Ready-map rectangle in global art px (painted tiles, else city opening frame). */
let playableRect: [[number, number], [number, number]] | null = null;

viewer.addOnceHandler("open", () => {
  base().addOnceHandler("fully-loaded-change", () => { loadAnimations(); hidePreview(false); }); // first view's tiles are drawn
  const [[by0, bx0], [by1, bx1]] = world.bounds;
  // Prefer painted AABB; otherwise a box around the city opening view (never the whole metro).
  if (world.playable) {
    playableRect = world.playable;
  } else {
    const [cx, cy] = llhToPixel(city.center[0], city.center[1], 25);
    const half = (city.widthM / CAMERA.mpp) / 2;
    playableRect = [[cy - half, cx - half], [cy + half, cx + half]];
  }
  // Clamp inside ready map (no soft edge pad — vignette / sfocato was removed).
  const pad = 24;
  let [[py0, px0], [py1, px1]] = playableRect;
  px0 = Math.max(bx0, px0 - pad); py0 = Math.max(by0, py0 - pad);
  px1 = Math.min(bx1, px1 + pad); py1 = Math.min(by1, py1 + pad);
  playableRect = [[py0, px0], [py1, px1]];

  // OSD zoom = imageWidth / visibleArtPx. Never let visible width exceed the ready map
  // (and never more than ~city opening width) — that was the "tiny diamond in black void".
  const playW = Math.max(1, px1 - px0), playH = Math.max(1, py1 - py0);
  const maxViewPx = Math.min(playW, playH, city.widthM / CAMERA.mpp) * 0.98;
  const imgW = base().getContentSize().x;
  const fitZoom = imgW / maxViewPx;
  Object.assign(viewer.viewport, { minZoomLevel: fitZoom });

  const zoomForWidthM = (widthM: number) => Math.max(fitZoom, imgW / (widthM / CAMERA.mpp));

  const at = location.hash.match(/^#@(-?[\d.]+),(-?[\d.]+),([\d.]+)$/);
  const ll = new URLSearchParams(location.search).get("at")?.split(",").map(Number);
  /** centre on lat/lon with `widthM` metres across the screen */
  const show = (lat: number, lon: number, widthM: number) => {
    const [x, y] = llhToPixel(lat, lon, 25), vp = viewer.viewport;
    vp.zoomTo(zoomForWidthM(widthM), undefined, true);
    vp.panTo(globalToViewport(x, y), true);
  };
  // Ignore stale deep-link zooms that would open past the ready-map min
  if (at && Number(at[3]) >= fitZoom * 0.95) {
    viewer.viewport.panTo(globalToViewport(Number(at[1]), Number(at[2])), true);
    viewer.viewport.zoomTo(Math.max(fitZoom, Number(at[3])), undefined, true);
  } else if (ll && ll.length >= 2 && ll.slice(0, 3).every(Number.isFinite)) {
    show(ll[0], ll[1], (ll[2] ?? 1.5) * 1000);
  } else {
    show(city.center[0], city.center[1], Math.min(city.widthM, 2200));
  }

  // Keep the centre inside the ready map while panning / zooming out
  const clampCenter = () => {
    const vp = viewer.viewport;
    if (vp.getZoom(true) < fitZoom * 0.999) vp.zoomTo(fitZoom, undefined, true);
    const c = base().viewportToImageCoordinates(vp.getCenter(true));
    const gx = Math.min(px1, Math.max(px0, c.x + ox));
    const gy = Math.min(py1, Math.max(py0, c.y + oy));
    if (Math.abs(gx - (c.x + ox)) > 1 || Math.abs(gy - (c.y + oy)) > 1) {
      vp.panTo(globalToViewport(gx, gy), true);
    }
  };
  viewer.addHandler("animation", clampCenter);
  // + / − buttons: same steps as the scroll wheel; never past the zoom-out limit (fitZoom) or the
  // deepest useful zoom, and "−" greys out at the limit so the map never shrinks into a small island
  const zoomIn = document.getElementById("zoom-in") as HTMLButtonElement | null;
  const zoomOut = document.getElementById("zoom-out") as HTMLButtonElement | null;
  const syncZoomButtons = () => {
    const z = viewer.viewport.getZoom();
    if (zoomOut) zoomOut.disabled = z <= fitZoom * 1.01;
    if (zoomIn) zoomIn.disabled = z >= viewer.viewport.getMaxZoom() * 0.99;
  };
  const step = (factor: number) => {
    const vp = viewer.viewport;
    vp.zoomTo(Math.min(vp.getMaxZoom(), Math.max(fitZoom, vp.getZoom() * factor)));
    vp.applyConstraints();
  };
  zoomIn?.addEventListener("click", () => step(1.6));
  zoomOut?.addEventListener("click", () => step(1 / 1.6));
  viewer.addHandler("zoom", syncZoomButtons);
  syncZoomButtons();
  viewer.addHandler("animation-finish", () => {
    clampCenter();
    const c = base().viewportToImageCoordinates(viewer.viewport.getCenter(true));
    history.replaceState(null, "", `#@${Math.round(c.x + ox)},${Math.round(c.y + oy)},${viewer.viewport.getZoom(true).toFixed(2)}`);
  });
});

document.getElementById("credits")!.innerHTML = [
  `© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>`,
  `Edifici: <a href="https://dati.lazio.it/en/dataset/carta-tecnica-regionale-2002-2003-5k-roma">Regione Lazio CTRN</a> (CC BY 4.0)`,
  `Alberi: <a href="https://esa-worldcover.org/">© ESA WorldCover 2021</a> (CC BY 4.0)`,
  `Meteo: <a href="https://open-meteo.com/">Open-Meteo.com</a> (CC BY 4.0)`,
  `Mezzi: <a href="https://dati.comune.roma.it/catalog/dataset/c_h501-d-9000">Roma Servizi per la Mobilità</a> (CC BY-SA)`,
  `<span title="© DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA">Copernicus DEM</span>`,
  `<a href="https://github.com/dg996/mondoisometrico">Source</a>`,
  `Made by <a href="https://domenicogagliardi.com">Domenico Gagliardi</a>`,
// each credit stays on one line; the separator rides at the end of the previous one so no line starts with "·"
].map((c, i, all) => `<span class="credit">${c}${i < all.length - 1 ? " ·" : ""}</span>`).join(" ")
  // phones: the OpenStreetMap credit always shows (ODbL); the other sources fold behind "Fonti"
  + ` <button type="button" id="credits-toggle" aria-expanded="false">Fonti ▴</button>`;
document.getElementById("credits-toggle")!.addEventListener("click", (e) => {
  const open = document.body.classList.toggle("credits-open");
  (e.currentTarget as HTMLButtonElement).setAttribute("aria-expanded", String(open));
  (e.currentTarget as HTMLButtonElement).textContent = open ? "Chiudi ▾" : "Fonti ▴";
});
// the panels sit just above the credit line, whatever its height (on a phone it wraps to several lines)
{
  const credits = document.getElementById("credits")!;
  const fit = () => document.documentElement.style.setProperty("--credits-h", `${Math.ceil(credits.getBoundingClientRect().height)}px`);
  fit();
  new ResizeObserver(fit).observe(credits);
}
