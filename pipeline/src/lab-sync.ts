/**
 * Cloudflare R2 is the base of the lab: every render, height pass, painted window and assembled
 * painting under data/derived/<area>/ is copied to the PRIVATE bucket `mondoisometrico-lab`.
 *
 * Changed files are packed into tar batches of ≤ 200 MB (one wrangler call each, not thousands),
 * uploaded, downloaded again and compared by sha256; only then are they recorded as safe.
 * R2 keeps `lab/index.json`: for every file, the batch that holds its latest version.
 *
 *   node --import tsx pipeline/src/lab-sync.ts            # one pass
 *   node --import tsx pipeline/src/lab-sync.ts --loop 30  # a pass every 30 minutes (while painting)
 *
 * Restore: see docs/lab-archive.md.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { DATA, DERIVED } from "./paths.ts";

const BUCKET = "mondoisometrico-lab";
const KINDS = ["windows", "render", "height", "paint"];
const EXTRA = ["manifest.json", "paint.json", "palette-qa.json", "paint-failed.json"];
const BATCH_BYTES = 200 * 1024 * 1024;
const STATE = join(DATA, "lab-sync.json");
const TMP = join(DATA, ".lab-sync-tmp");

interface State { files: Record<string, { size: number; mtime: number; batch: string }>; batches: string[] }
const state: State = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : { files: {}, batches: [] };

const env = { ...process.env, PATH: `/usr/local/bin:${process.env.PATH}` }; // wrangler wants Node ≥ 22.23.4
/** wrangler with retries: two wrangler processes refreshing the OAuth token at once can make one
 *  fail with 401 for a moment; a network hiccup should not lose a pass either */
function wrangler(...args: string[]): Buffer {
  for (let attempt = 1; ; attempt++) {
    try { return execFileSync("npx", ["wrangler", ...args, "--remote"], { env, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 30 }); }
    catch (e) {
      if (attempt >= 4) throw e;
      execFileSync("sleep", [String(20 * attempt)]);
    }
  }
}
const sha = (buf: Buffer) => createHash("sha256").update(buf).digest("hex");

function changedFiles() {
  const out: Array<{ rel: string; size: number; mtime: number }> = [];
  for (const area of readdirSync(DERIVED)) {
    const dir = join(DERIVED, area);
    if (!statSync(dir).isDirectory()) continue;
    const files = [...EXTRA.map((f) => join(dir, f)).filter(existsSync)];
    for (const k of KINDS) if (existsSync(join(dir, k))) for (const f of readdirSync(join(dir, k))) {
      if (/\.(png|webp|soft)$/.test(f)) files.push(join(dir, k, f));
    }
    for (const f of files) {
      const s = statSync(f), rel = relative(DATA, f), prev = state.files[rel];
      if (!prev || prev.size !== s.size || prev.mtime !== Math.round(s.mtimeMs)) out.push({ rel, size: s.size, mtime: Math.round(s.mtimeMs) });
    }
  }
  return out;
}

function pass() {
  const todo = changedFiles();
  if (!todo.length) { console.log(`${new Date().toLocaleTimeString()} lab-sync: nothing new`); return; }
  const groups: typeof todo[] = [[]];
  let bytes = 0;
  for (const f of todo) {
    if (bytes + f.size > BATCH_BYTES && groups.at(-1)!.length) { groups.push([]); bytes = 0; }
    groups.at(-1)!.push(f); bytes += f.size;
  }
  mkdirSync(TMP, { recursive: true });
  for (const g of groups) {
    const name = `batch-${new Date().toISOString().replace(/[:.]/g, "-")}.tar`, tar = join(TMP, name), list = join(TMP, "list.txt");
    writeFileSync(list, g.map((f) => f.rel).join("\n"));
    execFileSync("tar", ["-cf", tar, "-C", DATA, "-T", list]);
    const local = sha(readFileSync(tar));
    let remote = "";
    try {
      wrangler("r2", "object", "put", `${BUCKET}/lab/${name}`, "--file", tar);
      remote = sha(wrangler("r2", "object", "get", `${BUCKET}/lab/${name}`, "--pipe"));
    } finally { rmSync(tar, { force: true }); }
    if (remote !== local) throw new Error(`lab-sync: ${name} differs after upload (${local} vs ${remote}); nothing recorded`);
    for (const f of g) state.files[f.rel] = { size: f.size, mtime: f.mtime, batch: name };
    state.batches.push(name);
    writeFileSync(STATE, JSON.stringify(state));
    console.log(`${new Date().toLocaleTimeString()} lab-sync: ${name} ${g.length} files ${(g.reduce((t, f) => t + f.size, 0) / 1e6).toFixed(0)} MB verified`);
  }
  // index on R2: file -> batch with its latest version (restore = these batches, in order)
  const index = join(TMP, "index.json");
  writeFileSync(index, JSON.stringify({ updated: new Date().toISOString(), batches: state.batches, files: Object.fromEntries(Object.entries(state.files).map(([k, v]) => [k, v.batch])) }));
  wrangler("r2", "object", "put", `${BUCKET}/lab/index.json`, "--file", index);
  rmSync(index);
}

const loop = process.argv.indexOf("--loop");
if (loop < 0) pass();
else {
  const minutes = Number(process.argv[loop + 1] ?? 30);
  for (;;) {
    try { pass(); } catch (e) { console.error(`${new Date().toLocaleTimeString()} ${e instanceof Error ? e.message : e}`); }
    await new Promise((r) => setTimeout(r, minutes * 60_000));
  }
}
