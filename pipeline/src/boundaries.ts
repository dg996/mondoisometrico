/**
 * Fetch a region's municipal boundaries (OSM admin_level=8) from Overpass.
 *
 *   npm -w pipeline run boundaries -- israel-center      -> data/raw/boundaries/<region>.json
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REGIONS } from "./places.ts";
import { RAW } from "./paths.ts";

const OVERPASS = "https://overpass-api.de/api/interpreter";

async function overpass(query: string) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    const r = await fetch(OVERPASS, {
      method: "POST",
      headers: { "User-Agent": "isometric-world/0.3", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ data: query }),
    });
    if (r.ok) return r.json();
    console.warn(`  overpass ${r.status}, retrying…`);
    await new Promise((res) => setTimeout(res, 10_000 * attempt));
  }
  throw new Error("overpass failed");
}

const id = process.argv[2] ?? "israel-center", region = REGIONS[id];
if (!region) throw new Error(`unknown region ${id}`);
const names = region.municipalities.map((c) => c.replace(/[-]/g, "\\-")).join("|");
const data = await overpass(`[out:json][timeout:240];
area["name:en"="${region.country}"]["admin_level"="2"]->.il;
relation["boundary"="administrative"]["admin_level"="8"]["name"~"^(${names})$"](area.il);
out body geom;`);
mkdirSync(join(RAW, "boundaries"), { recursive: true });
writeFileSync(join(RAW, "boundaries", `${id}.json`), JSON.stringify(data));
console.log("  boundaries:", data.elements.map((e: any) => e.tags["name:en"] ?? e.tags.name).join(", "));
