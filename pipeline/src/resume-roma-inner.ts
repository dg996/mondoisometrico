/**
 * Safe resume entrypoint for the Roma inner batch. It never runs publish or deploy.
 *
 *   npm run resume:roma-inner -- --check      # preflight only (default)
 *   npm run resume:roma-inner -- --bootstrap  # fetch/ground/scene/render if data is absent
 *   npm run resume:roma-inner -- --paint      # resume paint; existing windows are skipped
 *   npm run resume:roma-inner -- --assemble   # strict assemble only (MONDO_SOFT_PALETTE is cleared)
 *   npm run resume:roma-inner -- --export     # coverage preflight + final export cache, still no publish
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DERIVED, RAW, WEB_CACHE, WEB_STATE } from "./paths.ts";

const AREA = "roma-inner";
const args = new Set(process.argv.slice(2));
if ([...args].some((a) => /publish|deploy|--yes/i.test(a)))
  throw new Error("resume-roma-inner never publishes or deploys; run those only manually after QA");

const base = join(DERIVED, AREA);
const count = (dir: string, re: RegExp) => (existsSync(dir) ? readdirSync(dir).filter((f) => re.test(f)).length : 0);

function preflight() {
  let ok = true;
  const need = (path: string, hint: string) => {
    if (existsSync(path)) return;
    ok = false;
    console.error(`missing ${path}\n  → ${hint}`);
  };
  need(join(base, "manifest.json"), "extract the handoff archive under data/ or run --bootstrap from open data");
  need(join(base, "render"), "render tiles are required before paint/export");
  need(join(base, "height"), "height passes are required for traffic, landmarks and paint QA");
  need(join(RAW, AREA, "roads.json"), "OSM roads are required for safe traffic export");
  const windows = count(join(base, "windows"), /^-?\d+_-?\d+\.(png|webp)$/);
  const painted = count(join(base, "paint"), /^-?\d+_-?\d+\.(png|webp)$/);
  const render = count(join(base, "render"), /^-?\d+_-?\d+\.(png|webp)$/);
  const height = count(join(base, "height"), /^-?\d+_-?\d+\.(png|webp)$/);
  console.log(`${AREA}: render=${render} height=${height} windows=${windows} assembledPaint=${painted}`);
  console.log(`cache=${existsSync(join(WEB_CACHE, "regions")) ? "present" : "empty"} state=${existsSync(WEB_STATE) ? "present" : "empty"}`);
  if (process.env.MONDO_SOFT_PALETTE === "1")
    console.warn("MONDO_SOFT_PALETTE=1 is set globally; this script clears it for strict child steps.");
  return ok;
}

function run(npmArgs: string[]) {
  const env = { ...process.env, MONDO_SOFT_PALETTE: "" };
  const r = spawnSync("npm", npmArgs, { stdio: "inherit", env });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

const wantsAction = args.has("--bootstrap") || args.has("--paint") || args.has("--assemble") || args.has("--export");
const ok = preflight();
if (!wantsAction || args.has("--check")) process.exit(ok ? 0 : 1);
if (!ok && !args.has("--bootstrap")) {
  console.error("preflight failed; extract data/ first or rerun with --bootstrap to rebuild inputs from open data");
  process.exit(1);
}

if (args.has("--bootstrap")) {
  run(["run", "fetch", "--", AREA]);
  run(["run", "ground", "--", AREA]);
  run(["run", "scene", "--", AREA]);
  run(["run", "render", "--", AREA, "--force", "-j", "3"]);
}
if (args.has("--paint")) run(["run", "paint", "--", AREA, "-j", "3"]);
if (args.has("--assemble")) run(["run", "paint", "--", AREA, "--assemble"]); // strict: soft preview env is cleared above
if (args.has("--export")) {
  run(["run", "export", "--", AREA, "--require-painted", "--check-coverage"]);
  run(["run", "export", "--", AREA, "--require-painted"]);
}
console.log("resume step finished; publish/deploy were not run");
