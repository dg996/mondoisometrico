/**
 * Deploy the built site (web/dist + the api/ functions) to Vercel production. Outward-facing: run only
 * when you mean to update the live site. `npm run deploy` builds first. Map tiles and region data are
 * not part of it: they live on R2 (`npm run publish`, pipeline/src/hosting.ts), publish them first.
 * Vercel also deploys production by itself on every push to main (vercel.json git.deploymentEnabled).
 */
import { spawnSync } from "node:child_process";
import { ROOT } from "./paths.ts";

const r = spawnSync("vercel", ["deploy", "--prod", "--yes"], { cwd: ROOT, stdio: "inherit" });
process.exit(r.status ?? 1);
