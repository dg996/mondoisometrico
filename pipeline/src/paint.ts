/**
 * Repaint the open-data 3D render into crisp, realistic isometric art with the local Codex CLI
 * (ChatGPT login, built-in image generation; no API key) or, with PAINT_BACKEND=agentgw,
 * the agent-gw image generation service (KIMI_API_KEY or ~/.kimi/agent-gw.json).
 *
 * Painting happens in overlapping 1024px windows on a global grid (stride 896). Each window gets
 * its already-painted neighbours (any side) pasted into the 128 px overlap, then windows are feather-blended
 * into 1024px art tiles aligned with the render tiles.
 *
 *   npm run paint -- tlv-core --plan
 *   npm run paint -- tlv-core --window=4,-3     # use = form so negatives aren't flags
 *   npm run paint -- tlv-core --near 32.064,34.775 --radius 2   # a patch of windows
 *   npm run paint -- tlv-core -j 3                              # everything, centre first (--center lat,lon)
 */
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, openSync, closeSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { windowPalette, applyPalette } from "./palette.ts";
import { parseArgs } from "node:util";
import sharp, { type OverlayOptions } from "sharp";
import { openArea } from "./areas.ts";
import { parseArtBounds, tileIntersects } from "./art-coverage.ts";
import { CAMERA, llhToPixel, enuToPixel } from "./camera.ts";
import { landmarkProjector } from "./landmark-anchors.ts";
import { LANDMARKS } from "./landmarks.ts";
import { DERIVED, PIPELINE, readJson, writeAtomic } from "./paths.ts";
import { SEA_H, readHeights } from "./heights.ts";
import { applyRegistration, register, type Registration } from "./register.ts";

const WIN = 1024, OVERLAP = 128, STRIDE = WIN - OVERLAP, T = CAMERA.tile;
/** Blend band in the middle of each overlap; outside it a window's own pixels win outright. */
const FEATHER = 64;
const STYLE = join(PIPELINE, "style", "reference.png");
// species sheet (painted once with Codex): Rome has its own (stone pine, plane, holm oak, cypress, olive, palm, oleander)
const treesSheet = (area: string) => join(PIPELINE, "style", openArea(area).region === "roma-centro" ? "trees-roma.png" : "trees.png");
const SEA = join(PIPELINE, "style", "sea.png");
/** Registration floor; landmarks do not get an exception to geometric alignment. */
const MIN_MATCH = 0.45;
/** Below MIN_MATCH but above this, the best attempt is kept and flagged .soft for later repaint. */
const SOFT_MATCH = 0.32;
/** Below this share of strong edges in the render (sea, sand, empty lots) the match check is skipped. */
const MIN_TEXTURE = 0.05;

/** Same structure/quality bar as upstream isometricworld paint prompt, adapted to Rome. */
const PROMPT = `Do these steps in order. Do not read skills docs, README, or any other files.

1) Call view_image on ./input.png
2) Call view_image on ./height.png
3) Call view_image on ./style.png
4) Call view_image on ./trees.png
5) Call image_gen to EDIT input.png (input.png is the BASE — do not invent a new layout).

Four images are attached:
1. input.png: an orthographic aerial render (camera tilted 45° down, no perspective) of a simple 3D model \
of {title}, Italy, built from map data. ~256 m across. The layout is exact; the colours are flat \
placeholders (grey = asphalt with lane markings, pale = pavement/plaza, green = grass/park, \
blue = water, brown dashes = rail) and the window patterns are schematic hints. \
Tree crowns are colour-coded by species (see image 4).
2. height.png: the height map from the SAME camera, pixel-aligned with image 1. Black = ground \
(streets, squares, river), grey→white = buildings and trees, brighter = taller. Use it to find exact \
building footprints, edges and heights; open black areas are streets/plazas, not trees.
3. style.png: the STYLE REFERENCE (same look as the upstream isometric world).
4. trees.png: what each tree species looks like, in the same style.

Redraw image 1 as detailed isometric pixel-art-style city illustration in EXACTLY the style of image 3: \
clean crisp 3D blocks with straight vertical walls, every facade drawn with regular window grids, \
Rome roofs in muted terracotta, weathered brick and warm grey (not uniformly flat concrete), restrained warm ochre and cream plaster, realistic varied trees \
drawn as the species of image 4 seen from above, smooth grey asphalt with lane markings, clean pavements, \
soft even daylight, light ambient occlusion, no long shadows, no haze, no photographic noise.

Geometry comes ONLY from images 1 and 2 — this is a tracing job:
- Same orthographic camera, framing and scale: the output overlays image 1 pixel-for-pixel.
- Every building keeps its exact footprint, position, height and roof outline. Draw believable Rome \
materials: ochre/cream/terracotta plaster blocks, brick and travertine public buildings, \
real window grids, shutters, cornices, rooftop terraces and AC units. \
CRITICAL building craft: each block is a solid orthographic prism — vertical walls meet roofs at crisp \
right angles; no melted/warped facades, no roofs sliding off walls, no two buildings fused into one mass, \
no floating grass patches. Neighbouring blocks stay separated by streets/courtyards exactly as in image 1. \
CRITICAL — famous monuments must look like the REAL building, not a modern office block: \
Colosseum = weathered travertine oval amphitheatre with stacked arches, hollow arena, broken south rim \
(open archaeological park around it — never invent terracotta apartment blocks against its walls); \
Vittoriano/Altare = bright white marble monument with grand stairs and quadriga \
(Piazza Venezia in front stays open asphalt — never invent flats in front of or glued into the monument); \
Pantheon = concrete dome with oculus and portico columns; \
Trevi = Baroque palace facade with fountain niches and cascading water — never a plain beige slab. \
Bridges stay LEVEL and straight across the Tiber: stone/travertine flat deck with parapets, \
piers in the water if present in image 1 — never a road dipping into the river, never blue asphalt \
over water, never a melted ribbon. Cars only on the deck, never floating above water or rooftops. \
Do not add, remove, merge or move buildings or trees; do not invent trees over open streets. \
Keep travertine warm ivory, Vittoriano white marble, sampietrini charcoal grey, river muted blue-green; avoid cyan pools and neon grass. Match saturation/hue of already-painted neighbour strips — no washed-out grey band across the tile.
- Streets, squares, parks and the Tiber stay exactly where they are; give them real texture \
(sampietrini / pale stone paving — not orange —, crosswalks at junctions, grass, water ripples, \
parked cars along kerbs only, no cars in the driving lanes or on water).
- Layering is exactly as in image 1: where a bridge crosses rail, river or another road, the \
bridge deck is continuous and on top — never draw rails, lane markings or water across a bridge deck.
- Image 3 is only for style. Do not copy its buildings, layout or architecture.
{continuation}Output: one square 1024x1024 image, no text, no labels, no border, no vignette.

6) Copy the generated PNG to {out} with a shell command. Reply only with that path.
`;
const CONTINUATION = `- The strip(s) along the {edges} edge(s) of image 1 are ALREADY-PAINTED neighbouring artwork. \
Reproduce them unchanged and continue the same palette and detail seamlessly into the rest.
`;

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    plan: { type: "boolean", default: false },
    window: { type: "string" },
    near: { type: "string" },
    context: { type: "string" }, // comma-separated adjacent areas; share global paint windows and palette
    "art-bounds": { type: "string" }, // x0,y0,x1,y1 global art px: paint only the release rectangle
    radius: { type: "string", default: "1" },
    force: { type: "boolean", default: false },
    // repaint windows painted before this time (e.g. after a style change); runs alongside a normal paint
    older: { type: "string" },
    assemble: { type: "boolean", default: false }, // only rebuild every art tile from the windows
    j: { type: "string", default: "3" },
    center: { type: "string", default: "41.8986,12.4769" }, // lat,lon painted first (Pantheon / centro)
  },
});
const areaName = positionals[0] ?? "roma-core";
const base = join(DERIVED, areaName);
const manifest = readJson(join(base, "manifest.json"));
const title = openArea(areaName).title;
const contextAreas=(args.context??"").split(",").filter(Boolean);
for(const other of contextAreas) if(openArea(other).region!==openArea(areaName).region) throw new Error("paint context must use the same region/camera");
openArea(areaName);
const projectLandmark = landmarkProjector([areaName]);
const OLDER = args.older ? new Date(args.older).getTime() : 0;
const mtime = (f: string) => (existsSync(f) ? statSync(f).mtimeMs : 0);
/** painted in the current style (with --older, windows painted before the cut-off don't count) */
const current = (i: number, j: number) => existsSync(winFile(i, j)) && mtime(winFile(i, j)) >= OLDER;
let tileSet = new Set<string>(manifest.tiles.map((t: any) => `${t.x}_${t.y}`));
if (args["art-bounds"]) {
  const b = parseArtBounds(args["art-bounds"]);
  tileSet = new Set([...tileSet].filter(k => tileIntersects(k, b, T)));
}
const winDir = join(base, "windows");
mkdirSync(winDir, { recursive: true });

const renderFile = (tx: number, ty: number) => join(base, "render", `${tx}_${ty}.png`);
/** Painted windows: lossless WebP; PNG from before the switch is still read (migrate-windows.ts converts). */
const localWinFile = (i:number,j:number) => join(winDir,`${i}_${j}.webp`);
const windowCandidates = (dir: string, i: number, j: number) => [join(dir, `${i}_${j}.webp`), join(dir, `${i}_${j}.png`)];
/** The window on disk here (either format), or the WebP path a new painting will be written to. */
const localExisting = (i:number,j:number) => windowCandidates(winDir,i,j).find(existsSync) ?? localWinFile(i,j);
const winFile = (i:number,j:number) => [...windowCandidates(winDir,i,j),...contextAreas.flatMap(a=>windowCandidates(join(DERIVED,a,"windows"),i,j))].find(existsSync) ?? localWinFile(i,j);
/** Remove a window here in every format (a repaint must not leave a stale PNG behind a new WebP). */
const removeLocalWindow = (i:number,j:number) => { for (const f of windowCandidates(winDir,i,j)) rmSync(f, { force: true }); };
/** After a new WebP is safely written: drop the superseded PNG of the same window (never before). */
const dropLegacyPng = (i:number,j:number) => rmSync(join(winDir, `${i}_${j}.png`), { force: true });
const paletteFiles = () => {
  const files = new Map<string,string>();
  for(const area of [...contextAreas,areaName].sort()) {
    const dir=join(DERIVED,area,"windows"); if(!existsSync(dir)) continue;
    for(const file of readdirSync(dir).filter(f=>/^-?\d+_-?\d+\.(png|webp)$/.test(f)).sort((a,b)=>Number(b.endsWith(".webp"))-Number(a.endsWith(".webp")))) {
      const key=file.replace(/\.(png|webp)$/,""), path=join(dir,file), prev=files.get(key);
      if(prev && prev.startsWith(dir)) continue; // same area: the WebP (sorted first) is the canonical copy
      if(prev && !readFileSync(prev).equals(readFileSync(path))) throw new Error(`conflicting paint window ${key}: ${prev} / ${path}; choose one canonical painting before assembly`);
      files.set(key,path);
    }
  }
  return files;
};

/** Crop a global-pixel box out of tiles produced by `load(tx, ty)` (1024² PNG buffers or null). */
async function cropGlobal(x: number, y: number, w: number, h: number,
  load: (tx: number, ty: number) => Promise<Buffer | null> = async (tx, ty) =>
    existsSync(renderFile(tx, ty)) ? sharp(renderFile(tx, ty)).png().toBuffer() : null) {
  const comps: OverlayOptions[] = [];
  for (let ty = Math.floor(y / T); ty <= Math.floor((y + h - 1) / T); ty++)
    for (let tx = Math.floor(x / T); tx <= Math.floor((x + w - 1) / T); tx++) {
      const buf = await load(tx, ty);
      if (!buf) continue;
      const left = tx * T - x, top = ty * T - y;
      const sx = Math.max(0, -left), sy = Math.max(0, -top);
      const width = Math.min(T - sx, w - Math.max(0, left)), height = Math.min(T - sy, h - Math.max(0, top));
      comps.push({ input: await sharp(buf).extract({ left: sx, top: sy, width, height }).toBuffer(), left: Math.max(0, left), top: Math.max(0, top) });
    }
  return sharp({ create: { width: w, height: h, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } } }).composite(comps);
}

/** Height pass as a grayscale structure image: black = ground, white = 60 m above `ground`. */
async function heightTile(tx: number, ty: number, ground: number): Promise<Buffer | null> {
  const f = join(base, "height", `${tx}_${ty}.png`);
  if (!existsSync(f)) return null;
  const h = await readHeights(f);
  const g = Buffer.alloc(h.length);
  for (let i = 0; i < h.length; i++) g[i] = Number.isNaN(h[i]) ? 0 : Math.max(0, Math.min(255, Math.sqrt(Math.max(0, h[i] - ground) / 60) * 255));
  return sharp(g, { raw: { width: 256, height: 256, channels: 1 } }).resize(T, T, { kernel: "cubic" }).png().toBuffer();
}

/** Local ground level of a window: low percentile of all surface heights it covers. */
async function windowGround(x: number, y: number) {
  const all: number[] = [];
  for (let ty = Math.floor(y / T); ty <= Math.floor((y + WIN - 1) / T); ty++)
    for (let tx = Math.floor(x / T); tx <= Math.floor((x + WIN - 1) / T); tx++) {
      const f = join(base, "height", `${tx}_${ty}.png`);
      if (existsSync(f)) for (const v of await readHeights(f)) if (!Number.isNaN(v) && v > SEA_H - 0.5) all.push(v);
    }
  all.sort((a, b) => a - b);
  return all[Math.floor(all.length * 0.05)] ?? SEA_H;
}

function windows(): Array<[number, number]> {
  const out = new Set<string>();
  for (const k of tileSet) {
    const [tx, ty] = k.split("_").map(Number);
    for (let j = Math.floor((ty * T - WIN) / STRIDE) + 1; j * STRIDE < (ty + 1) * T; j++)
      for (let i = Math.floor((tx * T - WIN) / STRIDE) + 1; i * STRIDE < (tx + 1) * T; i++)
        out.add(`${i}_${j}`);
  }
  return [...out].map((s) => s.split("_").map(Number) as [number, number]);
}

async function composeInput(i: number, j: number, file: string, heightFile: string) {
  const ground = await windowGround(i * STRIDE, j * STRIDE);
  await (await cropGlobal(i * STRIDE, j * STRIDE, WIN, WIN, (tx, ty) => heightTile(tx, ty, ground))).png().toFile(heightFile);
  // Keep one exposure and palette across all windows; per-window CLAHE changed local tones.
  const lifted = await sharp(await (await cropGlobal(i * STRIDE, j * STRIDE, WIN, WIN)).png().toBuffer())
    .removeAlpha().png().toBuffer();
  const img = sharp(lifted);
  const comps: OverlayOptions[] = [];
  const edges: string[] = [];
  // already-painted neighbours on any side: paste their overlap strip so this window continues them
  const sides: Array<[string, number, number, { left: number; top: number; width: number; height: number }, number, number]> = [
    ["left", i - 1, j, { left: STRIDE, top: 0, width: OVERLAP, height: WIN }, 0, 0],
    ["right", i + 1, j, { left: 0, top: 0, width: OVERLAP, height: WIN }, STRIDE, 0],
    ["top", i, j - 1, { left: 0, top: STRIDE, width: WIN, height: OVERLAP }, 0, 0],
    ["bottom", i, j + 1, { left: 0, top: 0, width: WIN, height: OVERLAP }, 0, STRIDE],
  ];
  for (const [side, ni, nj, box, left, top] of sides) {
    if (!current(ni, nj)) continue; // old-style neighbours are being repainted too: don't continue them
    comps.push({ input: await sharp(winFile(ni, nj)).resize(WIN, WIN).extract(box).toBuffer(), left, top });
    edges.push(side);
  }
  await sharp(await img.png().toBuffer()).composite(comps).png().toFile(file);
  return edges;
}

/** Codex/ChatGPT usage or rate limit: every worker pauses until `resumeAt`, then retries. */
let resumeAt = 0, backoff = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const LIMIT = /usage limit|rate.?limit|too many requests|too many concurrent|\b429\b|quota/i;

/** How long a limit message asks us to wait (ms); falls back to exponential backoff 5 → 60 min. */
function limitWait(log: string) {
  const at = log.match(/try again at ([0-9]{1,2}:[0-9]{2}\s*(?:[AP]M)?)/i);
  if (at) {
    const [, t] = at, [h, m] = t.match(/\d+/g)!.map(Number), pm = /pm/i.test(t), am = /am/i.test(t);
    const d = new Date();
    d.setHours(pm && h < 12 ? h + 12 : am && h === 12 ? 0 : h, m, 0, 0);
    if (d.getTime() < Date.now()) d.setDate(d.getDate() + 1);
    return d.getTime() - Date.now() + 60_000;
  }
  const inMin = log.match(/try again in (\d+)\s*(second|minute|hour)/i);
  if (inMin) return Number(inMin[1]) * ({ second: 1e3, minute: 6e4, hour: 36e5 } as Record<string, number>)[inMin[2].toLowerCase()] + 30_000;
  backoff = Math.min(60, backoff ? backoff * 2 : 5);
  return backoff * 60_000;
}

/**
 * Codex treats a git checkout as the workspace even when -C points at a subfolder, and then
 * wanders through README/ATTRIBUTION instead of calling image_gen. Run each window in an
 * isolated temp dir outside the repo so the only files it can see are the four inputs.
 */
function codex(cwd: string, prompt: string): Promise<void> {
  return new Promise((resolve) => {
    const log = openSync(join(cwd, "codex.log"), "w");
    const p = spawn("codex", [
      "exec", "--skip-git-repo-check",
      "-s", "workspace-write",
      "-C", cwd,
      "-i", "input.png", "-i", "height.png", "-i", "style.png", "-i", "trees.png",
      "-c", 'model_reasoning_effort="low"',
      "-",
    ], { stdio: ["pipe", log, log] }); // keep real ~/.codex so ChatGPT login / image_gen work
    const timer = setTimeout(() => p.kill("SIGTERM"), 900_000);
    p.on("close", () => { clearTimeout(timer); closeSync(log); resolve(); });
    p.stdin!.end(prompt);
  });
}

/**
 * Alternative paint backend: agent-gw image generation (PAINT_BACKEND=agentgw).
 * Same window contract as codex(): reads input/height/style/trees from `cwd`,
 * writes out.png there, appends its log to codex.log so rate-limit handling
 * and QA stay unchanged. Reference-image URLs for the static style/trees
 * sheets are uploaded once and cached under the area dir; input/height are
 * uploaded per window (they change every time).
 */
const GW_SCRIPT = join(PIPELINE, "scripts", "agentgw_paint.py");
const GW_REFS = () => join(base, "agentgw-refs.json");

function gwRefs(): Record<string, { size: number; mtimeMs: number; url: string }> {
  try { return JSON.parse(readFileSync(GW_REFS(), "utf8")); } catch { return {}; }
}

function gwRun(args: string[], logFile: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const log = openSync(logFile, "a");
    const p = spawn("python3", [GW_SCRIPT, ...args], { stdio: ["ignore", log, log] });
    const timer = setTimeout(() => p.kill("SIGTERM"), 900_000);
    p.on("error", (e) => { clearTimeout(timer); closeSync(log); reject(e); });
    p.on("close", (code) => { clearTimeout(timer); closeSync(log); resolve(code ?? 1); });
  });
}

async function gwUpload(file: string, logFile: string): Promise<string> {
  // small helper process: capture stdout (the signed_url) instead of the log
  const out = join("/tmp/mondoisometrico-paint", areaName, `upload-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  const code = await new Promise<number>((resolve, reject) => {
    const log = openSync(logFile, "a"), outFd = openSync(out, "w");
    const p = spawn("python3", [GW_SCRIPT, "upload", "--image-path", file], { stdio: ["ignore", outFd, log] });
    p.on("error", reject);
    p.on("close", (c) => { closeSync(log); closeSync(outFd); resolve(c ?? 1); });
  });
  if (code !== 0) throw new Error(`agent-gw upload failed for ${file} (see ${logFile})`);
  return readFileSync(out, "utf8").trim();
}

async function gwRef(file: string, logFile: string): Promise<string> {
  const st = statSync(file);
  const refs = gwRefs();
  const hit = refs[file];
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.url;
  const url = await gwUpload(file, logFile);
  refs[file] = { size: st.size, mtimeMs: st.mtimeMs, url };
  writeFileSync(GW_REFS(), JSON.stringify(refs, null, 2));
  return url;
}

/** Strip the Codex tool-calling scaffolding; the craft/landmark body is shared. */
/**
 * Compact single-reference prompt for the agent-gw painter. Measured on the Pantheon window:
 * the full Codex prompt (4 refs + monument paragraphs) makes the gateway model draw a "Rome
 * greatest hits" postcard (registration NCC ~0.1); a short tracing prompt with ONLY the base
 * render attached scores ~0.33-0.54 across generations. Landmark hints are cut to name + anchor.
 */
function agentgwPrompt(title: string, hints: string[]): string {
  const lm = hints.length
    ? "\nSpecial buildings in this window (keep each footprint EXACTLY; if the frame clips it, draw only the visible part, never recenter or duplicate it):\n" +
      hints
        .map((h) => {
          const cut = h.indexOf(" (");
          const name = (cut > 0 ? h.slice(0, cut) : h.slice(0, 40)).trim();
          const anchor = h.match(/ground anchor in this window: \((-?\d+), (-?\d+)\) px/);
          return `- The footprint near pixel ${anchor ? `(${anchor[1]}, ${anchor[2]})` : "centre"} is the ${name}. Paint it as the real monument, true to its actual architecture, at exactly that footprint.`;
        })
        .join("\n") +
      "\n"
    : "";
  return `Repaint the attached render as a detailed isometric illustration of ${title}. This is a TRACING job: the output must overlay the input pixel-for-pixel — same orthographic camera, framing and scale. Every building keeps its exact footprint, position, height and roof outline; every street, square, park and river stays exactly where it is. Do not add, remove, merge, move or resize anything; draw only what is in the input. Some edges may contain strips of already-painted neighbouring artwork: continue them seamlessly, matching their saturation and hue.

Materials and mood: warm Roman palazzi in ochre, cream and muted terracotta; brick and travertine public buildings; regular window grids, shutters, cornices, rooftop terraces; grey asphalt with subtle lane markings; pale stone pavements; realistic trees seen from above (stone pines, cypresses, plane trees); soft even daylight, gentle ambient occlusion, crisp clean edges. Flat placeholder colours in the input: grey = asphalt, pale = pavement/plaza, green = grass, blue = water. Replace them with realistic textures in exactly the same shapes. Water stays calm muted blue-green; bridges stay level and straight across it; cars only on roads and bridge decks, never on water or rooftops.
${lm}
Output: one square 1024x1024 image, no text, no labels, no border, no vignette.
`;
}

async function agentgw(cwd: string, prompt: string): Promise<void> {
  const logFile = join(cwd, "codex.log"); // same file the limit/QA plumbing already reads
  const refs = [await gwUpload(join(cwd, "input.png"), logFile)];
  writeFileSync(join(cwd, "prompt.txt"), prompt);
  const code = await gwRun([
    "paint", "--description-file", join(cwd, "prompt.txt"), "--output", join(cwd, "out.png"),
    ...refs.flatMap((u) => ["--ref", u]),
  ], logFile);
  if (code !== 0) return; // no out.png: caller treats as a failed attempt
}

/** Active painter: local Codex CLI by default, agent-gw when PAINT_BACKEND=agentgw. */
const runPainter: (cwd: string, prompt: string) => Promise<void> =
  process.env.PAINT_BACKEND === "agentgw" ? agentgw : codex;

/** Share of a window's surface at sea level (from the height pass). */
async function seaFraction(i: number, j: number) {
  let wet = 0, n = 0;
  for (let y = j * STRIDE; y < j * STRIDE + WIN; y += 32)
    for (let x = i * STRIDE; x < i * STRIDE + WIN; x += 32) {
      const tx = Math.floor(x / T), ty = Math.floor(y / T), f = join(base, "height", `${tx}_${ty}.png`);
      if (!existsSync(f)) continue;
      const h = (await readHeights(f))[Math.floor((y - ty * T) / 4) * 256 + Math.floor((x - tx * T) / 4)];
      n++;
      if (h <= SEA_H + 0.3) wet++;
    }
  return n ? wet / n : 0;
}

/** Mean brightness of each cell of an 8×8 grid (catches black bands or patches a mean over the image hides). */
async function cells(file: string | Buffer) {
  const d = await sharp(file).removeAlpha().resize(8, 8, { fit: "fill" }).raw().toBuffer();
  return Array.from({ length: 64 }, (_, k) => (d[k * 3] + d[k * 3 + 1] + d[k * 3 + 2]) / 3);
}

/** Codex sometimes returns black bands or near-black images: any cell much darker than the render. */
async function hasDarkPatch(out: string | Buffer, input: string | Buffer) {
  const [o, n] = [await cells(out), await cells(input)];
  return o.some((v, k) => v < 40 && v < 0.5 * n[k]);
}

/** Blue everywhere and not dark (checked per cell). */
async function looksLikeSea(file: string) {
  const d = await sharp(file).removeAlpha().resize(8, 8, { fit: "fill" }).raw().toBuffer();
  for (let k = 0; k < 64; k++) if (d[k * 3 + 2] < 80 || d[k * 3 + 2] < d[k * 3] + 25) return false;
  return true;
}

/** Delete finished windows with a black band or patch the render doesn't have, so they get repainted. */
async function dropDarkWindows(wins: Array<[number, number]>) {
  let n = 0;
  await pool(wins, 8, async ([i, j]) => {
    if (!existsSync(winFile(i, j))) return;
    const render = await (await cropGlobal(i * STRIDE, j * STRIDE, WIN, WIN)).png().toBuffer();
    if (existsSync(localExisting(i,j)) && await hasDarkPatch(localExisting(i,j), render)) { removeLocalWindow(i,j); n++; console.warn(`  ${i}_${j}: black patch, will repaint`); }
  });
  if (n) console.log(`  dropped ${n} windows with black patches`);
}

/** Landmarks whose pixel falls inside this paint window (for Rome monument hints). */
function landmarksInWindow(i: number, j: number): string[] {
  const city = openArea(areaName).region === "roma-centro" ? "roma" : "";
  const list = LANDMARKS[city] ?? [];
  const x0 = i * STRIDE, y0 = j * STRIDE;
  const hints: string[] = [];
  for (const L of list) {
    if (!L.paintHint) continue;
    const [px, py] = projectLandmark(L);
    const radius = (L.paintRadiusM ?? 40) / CAMERA.mpp;
    const a=(L.frontBearing??0)*Math.PI/180, [dx,dy]=enuToPixel([Math.sin(a)*25,Math.cos(a)*25,0]);
    const facing=L.frontBearing === undefined ? "" : ` Front/entrance direction: from this anchor toward (${Math.round(px-x0+dx)}, ${Math.round(py-y0+dy)}) px. Keep the real orientation even if the front is hidden from this camera.`;
    if (px + radius >= x0 && px - radius < x0 + WIN && py + radius >= y0 && py - radius < y0 + WIN)
      hints.push(`${L.paintHint} Approximate ground anchor in this window: (${Math.round(px-x0)}, ${Math.round(py-y0)}) px.${facing} Follow the rendered footprint; if it crosses an edge draw ONLY the clipped part, never recenter or duplicate it.`);
  }
  return hints;
}

async function paintWindow(i: number, j: number) {
  const skipFile = join(base, "paint-skip.json");
  if (existsSync(skipFile) && !args.force) {
    try {
      const skip = JSON.parse(readFileSync(skipFile, "utf8")) as string[];
      if (Array.isArray(skip) && skip.includes(`${i}_${j}`)) {
        console.warn(`  ${i}_${j}: skipped (paint-skip.json); will retry later`);
        throw new Error(`paint ${i}_${j} skipped for later retry; batch not ready`);
      }
    } catch (e) {
      if (e instanceof Error && e.message.includes("skipped for later")) throw e;
    }
  }
  // .soft windows were soft-accepted below MIN_MATCH: repaint them on later runs, but cap the
  // repaints — stubborn windows (score plateaus below MIN_MATCH) must not burn 3 generations per
  // pass forever. `--force` or deleting the .soft marker still forces a full repaint.
  if (existsSync(winFile(i, j)) && !args.force && !(OLDER && !current(i, j))) {
    const sf = `${localExisting(i, j)}.soft`;
    if (!existsSync(sf)) return;
    try {
      const tries = (JSON.parse(readFileSync(sf, "utf8")) as Registration & { _tries?: number })._tries ?? 0;
      if (tries >= 2) return; // gave this window its chances; keep the soft-accepted art
    } catch { /* unreadable marker: repaint */ }
  }
  // open sea: reuse the painted sea texture (mirrored per window so repeats don't line up)
  if (existsSync(SEA) && (await seaFraction(i, j)) >= 0.995) {
    let img = sharp(SEA).resize(WIN, WIN);
    if ((i + j) & 1) img = img.flop();
    if (j & 1) img = img.flip();
    await writeAtomic(img, localWinFile(i, j));
    dropLegacyPng(i, j);
    console.log(`  ${i}_${j}: sea texture`);
    return;
  }
  // durable debug copy under data/; the painter itself runs in /tmp outside the git root
  const work = join(base, "work", `${i}_${j}`);
  const sand = join("/tmp/mondoisometrico-paint", areaName, `${i}_${j}`);
  mkdirSync(work, { recursive: true });
  mkdirSync(sand, { recursive: true });
  const edges = await composeInput(i, j, join(sand, "input.png"), join(sand, "height.png"));
  copyFileSync(STYLE, join(sand, "style.png"));
  copyFileSync(treesSheet(areaName), join(sand, "trees.png"));
  // also keep inputs under data/ for local debugging
  for (const f of ["input.png", "height.png", "style.png", "trees.png"] as const)
    copyFileSync(join(sand, f), join(work, f));
  const outSand = join(sand, "out.png");
  const hints = landmarksInWindow(i, j);
  const landmarkBlock = hints.length
    ? `\nLANDMARKS IN THIS WINDOW (paint these as the REAL monuments — footprint stays exact):\n- ${hints.join("\n- ")}\n`
    : "";
  const prompt = process.env.PAINT_BACKEND === "agentgw"
    ? agentgwPrompt(title, hints)
    : PROMPT.replace("{title}", title).replace("{out}", outSand)
      .replace("{continuation}", (edges.length ? CONTINUATION.replace("{edges}", edges.join(" and ")) : "") + landmarkBlock);
  // Best-effort tracking: the agent-gw painter's fidelity varies per generation, so keep the
  // highest-scoring attempt; windows that never reach MIN_MATCH can still soft-accept at
  // SOFT_MATCH (flagged with a .soft marker for later targeted repaint) instead of blocking.
  let bestR: Registration | null = null;
  const bestFile = join(work, "out-best.png");
  for (let attempt = 1; attempt <= 3; attempt++) {
    while (Date.now() < resumeAt) await sleep(Math.min(60_000, resumeAt - Date.now()));
    rmSync(outSand, { force: true });
    rmSync(join(work, "out.png"), { force: true }); // no stale result from a previous attempt
    const t0 = Date.now();
    await runPainter(sand, prompt);
    // copy log + output back into the area work dir
    if (existsSync(join(sand, "codex.log"))) copyFileSync(join(sand, "codex.log"), join(work, "codex.log"));
    if (existsSync(outSand)) copyFileSync(outSand, join(work, "out.png"));
    if (!existsSync(join(work, "out.png"))) {
      const log = existsSync(join(work, "codex.log")) ? readFileSync(join(work, "codex.log"), "utf8").slice(-4000) : "";
      if (LIMIT.test(log)) {
        const wait = limitWait(log);
        resumeAt = Math.max(resumeAt, Date.now() + wait);
        console.warn(`  ${i}_${j}: painter limit reached, pausing all workers until ${new Date(resumeAt).toLocaleTimeString()}`);
        attempt--; // a limit is not the window's fault: retry without using up an attempt
        continue;
      }
    } else backoff = 0;
    if (existsSync(join(work, "out.png"))) {
      // geometric QA: undo any shift/scale drift; repaint if the output doesn't follow the render
      const r = await register(join(work, "input.png"), join(work, "out.png"));
      writeFileSync(join(work, "qa.json"), JSON.stringify(r));
      const structured = r.texture >= MIN_TEXTURE;
      // Failed last attempts used to slip through, and landmarks accepted scores as low as .32.
      // Preserve any previous window on disk; report failure instead of promoting bad artwork.
      const dark = await hasDarkPatch(join(work, "out.png"), join(work, "input.png"));
      if (dark || (structured && r.score < MIN_MATCH)) {
        if (!dark && structured && (bestR === null || r.score > bestR.score)) {
          copyFileSync(join(work, "out.png"), bestFile);
          bestR = r;
        }
        console.warn(`  ${i}_${j}: rejected attempt ${attempt}, match=${r.score.toFixed(2)}`);
        // Use all 3 attempts before soft-accept — early bail was a speed hack that hurt look.
        continue;
      }
      const warp = structured && r.score > r.identity + 0.01;
      for (const f of windowCandidates(winDir, i, j)) rmSync(`${f}.soft`, { force: true }); // passed: clear any soft-accept flag
      await applyRegistration(join(work, "out.png"), localWinFile(i, j), warp ? r : { ...r, scale: 1, dx: 0, dy: 0 });
      dropLegacyPng(i, j);
      console.log(`  ${i}_${j}: ${((Date.now() - t0) / 1000).toFixed(0)}s edges=${edges.join("+") || "-"} match=${r.score.toFixed(2)}`
        + (structured ? "" : " (low texture)") + (warp ? ` shift=(${r.dx},${r.dy}) scale=${r.scale.toFixed(2)}` : ""));
      // keep qa.json + codex.log for debugging; the images are ~6 MB per window
      for (const f of ["input.png", "height.png", "style.png", "trees.png", "out.png", "out-best.png"]) rmSync(join(work, f), { force: true });
      return;
    }
    console.error(`  ${i}_${j}: attempt ${attempt} failed, see ${join(work, "codex.log")}`);
  }
  // No attempt reached MIN_MATCH: promote the best one if it is at least recognisable, and mark
  // it .soft so a later --force run on that window repaints it instead of skipping it.
  if (bestR && bestR.score >= SOFT_MATCH) {
    const warp = bestR.score > bestR.identity + 0.01;
    await applyRegistration(bestFile, localWinFile(i, j), warp ? bestR : { ...bestR, scale: 1, dx: 0, dy: 0 });
    dropLegacyPng(i, j);
    const sf = `${localWinFile(i, j)}.soft`;
    let tries = 0;
    try { tries = (JSON.parse(readFileSync(sf, "utf8")) as Registration & { _tries?: number })._tries ?? 0; } catch {}
    writeFileSync(sf, JSON.stringify({ ...bestR, _tries: tries + 1 }));
    console.warn(`  ${i}_${j}: SOFT-ACCEPT match=${bestR.score.toFixed(2)} < ${MIN_MATCH}; flagged .soft for later repaint (try ${tries + 1}/2)`);
    return;
  }
  throw new Error(`paint ${i}_${j} failed QA after 3 attempts; previous painting retained, batch not ready`);
}

/** Feather-blend painted windows into 1024 art tiles; only tiles fully covered are written. */
// ---- sea colour harmonisation -------------------------------------------------------------------
// Codex paints open water in slightly different blues per window, which shows as window-sized
// rectangles. In each window, deep water (sea level, far from land) is shifted to the median
// deep-water colour of all windows, fading in from the shore so surf and harbours keep their colours.
const CELL = 8, PAD = 256, NEAR = 12, FULL = 28; // 8 px cells; fade from 12 to 28 cells (24 → 56 m) off the coast
const heightCache = new Map<string, Float32Array | null>();
async function heightAt(x: number, y: number) {
  const tx = Math.floor(x / T), ty = Math.floor(y / T), k = `${tx}_${ty}`;
  if (!heightCache.has(k)) {
    const f = join(base, "height", `${k}.png`);
    heightCache.set(k, existsSync(f) ? await readHeights(f) : null);
  }
  const h = heightCache.get(k);
  return h ? h[Math.floor((y - ty * T) / 4) * 256 + Math.floor((x - tx * T) / 4)] : NaN;
}

/** Per window cell (WIN/CELL)²: 0 on land or near the coast → 1 in open water. Null if no open water. */
async function deepWater(i: number, j: number) {
  const n = (WIN + 2 * PAD) / CELL, x0 = i * STRIDE - PAD, y0 = j * STRIDE - PAD;
  const d = new Float32Array(n * n);
  let any = false;
  for (let cy = 0; cy < n; cy++) for (let cx = 0; cx < n; cx++) {
    const h = await heightAt(x0 + cx * CELL + CELL / 2, y0 + cy * CELL + CELL / 2);
    const land = !Number.isNaN(h) && h > SEA_H + 0.3;
    d[cy * n + cx] = land ? 0 : 1e9;
    if (!land && !Number.isNaN(h)) any = true;
  }
  if (!any) return null;
  // chamfer distance to land, in cells
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    let v = d[y * n + x];
    if (x) v = Math.min(v, d[y * n + x - 1] + 1);
    if (y) v = Math.min(v, d[(y - 1) * n + x] + 1);
    if (x && y) v = Math.min(v, d[(y - 1) * n + x - 1] + 1.414);
    if (y && x < n - 1) v = Math.min(v, d[(y - 1) * n + x + 1] + 1.414);
    d[y * n + x] = v;
  }
  for (let y = n - 1; y >= 0; y--) for (let x = n - 1; x >= 0; x--) {
    let v = d[y * n + x];
    if (x < n - 1) v = Math.min(v, d[y * n + x + 1] + 1);
    if (y < n - 1) v = Math.min(v, d[(y + 1) * n + x] + 1);
    if (x < n - 1 && y < n - 1) v = Math.min(v, d[(y + 1) * n + x + 1] + 1.414);
    if (y < n - 1 && x) v = Math.min(v, d[(y + 1) * n + x - 1] + 1.414);
    d[y * n + x] = v;
  }
  const m = WIN / CELL, w = new Float32Array(m * m), p = PAD / CELL;
  let deep = 0;
  for (let y = 0; y < m; y++) for (let x = 0; x < m; x++) {
    const h = await heightAt(i * STRIDE + x * CELL + CELL / 2, j * STRIDE + y * CELL + CELL / 2);
    if (Number.isNaN(h)) continue;
    const v = Math.min(1, Math.max(0, (d[(y + p) * n + x + p] - NEAR) / (FULL - NEAR)));
    w[y * m + x] = v;
    if (v >= 1) deep++;
  }
  return deep >= 64 ? w : null;
}

/** window -> [cell weights, RGB offset to the reference deep-water colour] */
const seaFix = new Map<string, [Float32Array, number[]]>();
async function harmoniseSea() {
  const means: Array<[string, Float32Array, number[]]> = [];
  for (const [i, j] of windows()) {
    if (!existsSync(winFile(i, j))) continue;
    const w = await deepWater(i, j);
    if (!w) continue;
    const m = WIN / CELL, px = await sharp(winFile(i, j)).removeAlpha().resize(m, m, { kernel: "cubic" }).raw().toBuffer();
    const sum = [0, 0, 0];
    let n = 0;
    for (let k = 0; k < m * m; k++) if (w[k] >= 1) { for (let c = 0; c < 3; c++) sum[c] += px[k * 3 + c]; n++; }
    means.push([`${i}_${j}`, w, sum.map((v) => v / n)]);
  }
  const ref = [0, 1, 2].map((c) => means.map((m) => m[2][c]).sort((a, b) => a - b)[Math.floor(means.length / 2)]);
  for (const [k, w, mean] of means) seaFix.set(k, [w, mean.map((v, c) => ref[c] - v)]);
  console.log(`  sea: ${means.length} windows with open water, reference rgb(${ref.map(Math.round).join(",")})`);
}

async function assemble(all = false, strictPalette = true) {
  const windowFiles = paletteFiles();
  const palette = await windowPalette(windowFiles);
  const seams = palette.residuals.filter(r=>r.error>12);
  writeFileSync(join(base,"palette-qa.json"),JSON.stringify({offsets:Object.fromEntries(palette.offsets),residuals:palette.residuals},null,2));
  if(seams.length) {
    const msg = `palette QA: ${seams.length} incompatible overlaps; repaint windows listed in palette-qa.json before export`;
    // Mid-batch ring assembly must not abort hours of painting; only the final assemble fails closed.
    if (strictPalette) throw new Error(msg);
    console.warn(`  ${msg} (continuing; will recheck at the end)`);
  }
  // A new neighbour can change the component correction. Rebuild all complete tiles together.
  all = true;
  const ramp = new Float32Array(WIN);
  // 0 → 1 across a FEATHER-wide band centred in the overlap (complementary for neighbours)
  const edge = (k: number) => Math.min(1, Math.max(0, (k + 0.5 - (OVERLAP - FEATHER) / 2) / FEATHER));
  for (let k = 0; k < WIN; k++) ramp[k] = Math.min(edge(k), edge(WIN - 1 - k));
  mkdirSync(join(base, "paint"), { recursive: true });
  let written = 0;
  for (const k of tileSet) {
    const [tx, ty] = k.split("_").map(Number);
    const covering: Array<[number, number]> = [];
    for (let j = Math.floor((ty * T - WIN) / STRIDE) + 1; j * STRIDE < (ty + 1) * T; j++)
      for (let i = Math.floor((tx * T - WIN) / STRIDE) + 1; i * STRIDE < (tx + 1) * T; i++) covering.push([i, j]);
    if (!covering.every(([i, j]) => existsSync(winFile(i, j)))) continue;
    const tile = join(base, "paint", `${tx}_${ty}.png`);
    // rebuilt when any covering window was repainted since
    if (existsSync(tile) && !args.force && !all && covering.every(([i, j]) => mtime(winFile(i, j)) <= mtime(tile))) continue;
    const acc = new Float32Array(T * T * 3), wsum = new Float32Array(T * T);
    for (const [i, j] of covering) {
      const px = await sharp(winFile(i, j)).resize(WIN, WIN).removeAlpha().raw().toBuffer();
      applyPalette(px, palette.offsets.get(`${i}_${j}`) ?? [0,0,0]);
      const fix = seaFix.get(`${i}_${j}`);
      if (fix) { // bilinear cell weights × colour offset
        const [w, off] = fix, m = WIN / CELL;
        for (let y = 0; y < WIN; y++) {
          const fy = Math.min(m - 1, Math.max(0, (y + 0.5) / CELL - 0.5)), y0 = Math.floor(fy), y1 = Math.min(m - 1, y0 + 1), ay = fy - y0;
          for (let x = 0; x < WIN; x++) {
            const fx = Math.min(m - 1, Math.max(0, (x + 0.5) / CELL - 0.5)), x0 = Math.floor(fx), x1 = Math.min(m - 1, x0 + 1), ax = fx - x0;
            const a = (w[y0 * m + x0] * (1 - ax) + w[y0 * m + x1] * ax) * (1 - ay) + (w[y1 * m + x0] * (1 - ax) + w[y1 * m + x1] * ax) * ay;
            if (a <= 0) continue;
            const s = (y * WIN + x) * 3;
            for (let c = 0; c < 3; c++) px[s + c] = Math.max(0, Math.min(255, px[s + c] + off[c] * a));
          }
        }
      }
      const ox = i * STRIDE - tx * T, oy = j * STRIDE - ty * T;
      for (let y = Math.max(0, oy); y < Math.min(T, oy + WIN); y++)
        for (let x = Math.max(0, ox); x < Math.min(T, ox + WIN); x++) {
          const wx = x - ox, wy = y - oy, w = ramp[wx] * ramp[wy], s = (wy * WIN + wx) * 3, d = y * T + x;
          acc[d * 3] += px[s] * w; acc[d * 3 + 1] += px[s + 1] * w; acc[d * 3 + 2] += px[s + 2] * w;
          wsum[d] += w;
        }
    }
    const out = Buffer.alloc(T * T * 3);
    for (let d = 0; d < T * T; d++) for (let c = 0; c < 3; c++) out[d * 3 + c] = acc[d * 3 + c] / Math.max(wsum[d], 1e-6);
    await writeAtomic(sharp(out, { raw: { width: T, height: T, channels: 3 } }).png(), join(base, "paint", `${tx}_${ty}.png`));
    written++;
  }
  console.log(`  assembled ${written} art tiles`);
}

async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>) {
  const q = [...items];
  await Promise.all(Array.from({ length: n }, async () => { while (q.length) await fn(q.shift()!); }));
}

async function main() {
  let wins = windows();
  if (args.near) {
    const [lat, lon] = args.near.split(",").map(Number);
    const [x, y] = llhToPixel(lat, lon, 25);
    const ci = Math.floor(x / STRIDE), cj = Math.floor(y / STRIDE), r = Number(args.radius);
    wins = wins.filter(([i, j]) => Math.abs(i - ci) <= r && Math.abs(j - cj) <= r);
  }
  if (args.window) wins = [args.window.split(",").map(Number) as [number, number]];
  if (OLDER) { // only land windows (sea-texture windows have no trees) painted before the cut-off
    const old: Array<[number, number]> = [];
    for (const [i, j] of wins) if (existsSync(winFile(i, j)) && !current(i, j) && !(await looksLikeSea(winFile(i, j)))) old.push([i, j]);
    wins = old;
  }
  if (args.plan) return console.log(`${wins.length} windows`);
  // MONDO_SOFT_PALETTE=1: preview/partial batches may assemble despite seam residuals (not for final publish).
  if (args.assemble) { /* palette QA in assemble covers water and land together */ return assemble(true, process.env.MONDO_SOFT_PALETTE !== "1"); }
  // single-window mode: paint just that cell and assemble once (no 9000 empty rings)
  if (args.window) {
    const [wi, wj] = wins[0];
    console.log(`1 window ${wi}_${wj}`);
    await paintWindow(wi, wj);
    await assemble(true);
    return;
  }
  // centre first: square rings around the focus. --near also recentres rings (otherwise a Colosseum
  // patch still expands from the default Pantheon centre through empty rings).
  const [cx, cy] = (args.near ?? args.center).split(",").map(Number);
  const [px, py] = llhToPixel(cx, cy, 25);
  const ci = Math.floor(px / STRIDE), cj = Math.floor(py / STRIDE);
  const have = new Set(wins.map(([i, j]) => `${i}_${j}`));
  const maxR = Math.max(0, ...wins.map(([i, j]) => Math.max(Math.abs(i - ci), Math.abs(j - cj))));
  console.log(`${wins.length} windows in ${maxR + 1} rings around ${ci}_${cj}`);
  // first: paint one open-sea window and keep it as the reusable sea texture
  // (validated: a bad paint would otherwise be stamped over every open-sea window)
  // a bad sea texture (or windows painted with black bands) never survives a restart: drop and redo them
  if (existsSync(SEA) && !(await looksLikeSea(SEA))) { console.warn("  sea texture is bad, repainting it"); rmSync(SEA); }
  if (!OLDER) await dropDarkWindows(wins);
  // skip sea-texture hunt on small --near patches (Rome centro has no open sea anyway)
  if (!existsSync(SEA) && !OLDER && !args.near) {
    const open = [];
    for (const [i, j] of windows()) if ((await seaFraction(i, j)) >= 0.995) open.push([i, j]);
    for (const [i, j] of open.slice(0, 3)) {
      removeLocalWindow(i, j);
      await paintWindow(i, j);
      if (existsSync(winFile(i, j)) && (await looksLikeSea(winFile(i, j)))) {
        await sharp(winFile(i, j)).png().toFile(SEA); // the shared sea texture stays a PNG
        console.log(`  sea texture from ${i}_${j}`);
        break;
      }
      console.warn(`  ${i}_${j}: painted sea doesn't look like sea, trying another window`);
      removeLocalWindow(i, j);
    }
  }
  // One hard window must not abort siblings mid-ring: keep painting, then fail closed at the end.
  const failed: string[] = [];
  for (let r = 0; r <= maxR; r++) {
    const ring: Array<[number, number]> = [];
    if (r === 0) ring.push([ci, cj]);
    else {
      for (let k = 0; k < 2 * r; k++) ring.push([ci - r + k, cj - r]);  // top, left → right
      for (let k = 0; k < 2 * r; k++) ring.push([ci + r, cj - r + k]);  // right, top → bottom
      for (let k = 0; k < 2 * r; k++) ring.push([ci + r - k, cj + r]);  // bottom, right → left
      for (let k = 0; k < 2 * r; k++) ring.push([ci - r, cj + r - k]);  // left, bottom → top
    }
    let painted = 0;
    for (const pass of [0, 1]) {
      const todo = ring.filter(([i, j], k) => k % 2 === pass && have.has(`${i}_${j}`));
      if (!todo.length) continue;
      await pool(todo, Number(args.j), async ([i, j]) => {
        try { await paintWindow(i, j); }
        catch (err) {
          failed.push(`${i}_${j}`);
          console.error(`  ${i}_${j}: ${err instanceof Error ? err.message : err}`);
        }
      });
      painted += todo.length;
    }
    // Mid-batch assemble rebuilds EVERY covered tile (global palette correction): at ~3.5 s/tile
    // that is up to an hour per ring late in the batch on small runners. Disabled entirely:
    // the final strict assemble after the loop rebuilds everything before paint.json is written.
    void painted;
  }
  /* palette QA in assemble covers water and land together */ // then every tile with open water is rebuilt with the harmonised sea
  await assemble(!args.window, true);
  writeFileSync(join(base, "paint.json"), JSON.stringify({ updated: new Date().toISOString() }));
  if (failed.length) {
    const report = join(base, "paint-failed.json");
    writeFileSync(report, JSON.stringify({ failed, updated: new Date().toISOString() }, null, 2));
    throw new Error(`paint failed QA for ${failed.length} windows (${failed.slice(0, 12).join(", ")}${failed.length > 12 ? "…" : ""}); see ${report}; batch not ready`);
  }
}

main();
