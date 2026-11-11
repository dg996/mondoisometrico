/**
 * Fail closed before `npm run publish`: no network, no upload, no state changes.
 *
 * The historical Rome failure mode is a publish that is technically successful but points the
 * viewer at an incomplete world: missing activity mask, missing landmark anchors, orphaned data
 * file names, or a cache assembled with soft palette QA. This guard runs as pipeline `prepublish`
 * and refuses to let publish.ts start unless the local export cache is internally consistent.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { WEB_CACHE } from "./paths.ts";
import { REGIONS } from "./places.ts";

interface WorldFile {
  camera?: { region?: string };
  playable?: unknown;
  activity?: { version?: number; tileSize?: number; tiles?: unknown; bounds?: unknown };
  landmarks?: Record<string, unknown>;
  layers?: { photo?: number; art?: number };
  files?: Record<string, unknown>;
  attributions?: unknown;
  credits?: unknown;
}

const argv = [process.env.npm_config_argv ?? "", ...process.argv.slice(2)].join(" ");
const explicit = argv.match(/(?:^|\s)([a-z0-9-]+)(?:\s|$)/i)?.[1];
const regions = explicit && REGIONS[explicit]
  ? [explicit]
  : existsSync(join(WEB_CACHE, "regions"))
    ? readdirSync(join(WEB_CACHE, "regions"), { withFileTypes: true })
        .filter((d) => d.isDirectory() && REGIONS[d.name])
        .map((d) => d.name)
    : [];

if (!regions.length) {
  console.log("publish guard: no region export cache found; publish will report nothing to publish");
  process.exit(0);
}

const text = (v: unknown) => (Array.isArray(v) ? v.join(" ") : String(v ?? ""));

for (const region of regions) {
  const root = join(WEB_CACHE, "regions", region);
  const worldFile = join(root, "data", "world.json");
  const fail = (msg: string): never => {
    throw new Error(`publish guard (${region}): ${msg}. Fix the export first; publish/deploy stay blocked.`);
  };
  if (!existsSync(worldFile)) fail(`missing ${worldFile}`);
  const world = JSON.parse(readFileSync(worldFile, "utf8")) as WorldFile;

  if (process.env.MONDO_SOFT_PALETTE === "1") fail("MONDO_SOFT_PALETTE=1 is preview-only; rerun a strict assemble/export before publish");
  if (world.camera?.region !== region) fail(`world camera region is ${world.camera?.region ?? "missing"}, expected ${region}`);
  if (!Array.isArray(world.playable) || world.playable.length !== 2) fail("world.playable is missing or invalid");
  if (!world.activity || world.activity.version !== 1 || !Array.isArray(world.activity.tiles) || world.activity.tiles.length === 0)
    fail("world.activity is missing: traffic/labels would either stay off or fall back to unsafe legacy data");
  if (!(Number(world.activity.tileSize) > 0) || !Array.isArray(world.activity.bounds)) fail("world.activity is incomplete");
  if (!world.layers || !(world.layers.art! > 0) || !(world.layers.photo! > 0)) fail("world.layers must count rendered and painted source tiles");
  if (world.activity.tiles.length !== world.layers.art)
    fail(`activity tiles (${world.activity.tiles.length}) != painted art tiles (${world.layers.art}); re-export after assemble`);
  if (!world.landmarks || Object.keys(world.landmarks).length < 4) fail("world.landmarks is missing; do not move pins later to hide bad paint");

  for (const name of ["tiles-map", "tiles-photo", "borders", "roads"] as const) {
    const file = world.files?.[name];
    if (typeof file !== "string" || !file.endsWith(".json")) fail(`world.files.${name} is missing`);
    if (!existsSync(join(root, "data", file))) fail(`world.files.${name} names ${file}, absent from the local cache`);
  }
  const credits = `${text(world.credits)} ${text(world.attributions)}`;
  if (!credits.includes("OpenStreetMap")) fail("OpenStreetMap credit is missing from world credits/attributions");
  if (!credits.includes("Copernicus")) fail("Copernicus DEM credit is missing from world credits/attributions");

  console.log(`publish guard OK: ${region} · art=${world.layers.art} photo=${world.layers.photo} activity=${world.activity.tiles.length} landmarks=${Object.keys(world.landmarks).length}`);
}
