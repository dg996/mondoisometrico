/**
 * Public transport for the viewer, from the official GTFS of Roma Servizi per la Mobilità
 * (dati.comune.roma.it, dataset c_h501-d-9000, licence CC BY-SA): routes, their real shapes and how
 * often they run. The derived data/transit.<hash>.json is therefore also CC BY-SA.
 *
 * Buses: the shape (ENU, every ~10 m) guides buses along the same road graph the cars use (web
 * traffic.ts), so they stay on drawn asphalt, obey one-ways and hide under bridges and roofs.
 * Trams: their own movers on the real track shape, with terrain / bridge-deck height and the same
 * visibility test as the roads (export.ts passes `surface`).
 * Frequency: trips of the route/direction on a reference service day, over 17 service hours.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const GTFS_URL = "https://dati.comune.roma.it/catalog/dataset/a7dadb4a-66ae-4eff-8ded-a102064702ba/resource/266d82e1-ba53-4510-8a81-370880c4678f/download/rome_static_gtfs.zip";
export const TRANSIT_CREDIT = "Mezzi: Roma Servizi per la Mobilità (GTFS, CC BY-SA)";

/** Download (refreshed when older than 7 days) and unzip the Rome GTFS. */
export async function fetchGtfs(raw: string) {
  const dir = join(raw, "gtfs"), zip = join(dir, "rome_static_gtfs.zip");
  mkdirSync(dir, { recursive: true });
  if (!existsSync(zip) || Date.now() - statSync(zip).mtimeMs > 7 * 86400_000) {
    const r = await fetch(GTFS_URL);
    if (!r.ok) throw new Error(`GTFS ${r.status}`);
    writeFileSync(zip, Buffer.from(await r.arrayBuffer()));
    execFileSync("unzip", ["-o", "-q", zip, "-d", join(dir, "feed")]);
  }
  return join(dir, "feed");
}

/** Minimal CSV reader for GTFS (quoted fields, no embedded newlines). */
function csv(file: string): Array<Record<string, string>> {
  const lines = readFileSync(file, "utf8").replace(/^﻿/, "").split(/\r?\n/).filter(Boolean);
  const split = (line: string) => {
    const out: string[] = []; let cur = "", q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
      else if (ch === '"') q = true; else if (ch === ",") { out.push(cur); cur = ""; } else cur += ch;
    }
    out.push(cur);
    return out;
  };
  const head = split(lines[0]);
  return lines.slice(1).map((l) => { const v = split(l), o: Record<string, string> = {}; head.forEach((h, i) => (o[h] = v[i] ?? "")); return o; });
}

export interface TransitLine {
  name: string;        // "8", "64", "H"
  kind: "bus" | "tram";
  dir: number;         // GTFS direction_id
  headway: number;     // seconds between vehicles
  /** ENU polyline [e, n] every ~10 m (bus guide) */
  path: Array<[number, number]>;
}

/**
 * Main shape per route & direction (the one most trips use), with its headway on `serviceDate`
 * (YYYYMMDD; default: next Tuesday — a plain weekday). `keep` says whether an ENU point matters
 * (inside the painted area), so only lines that pass there are kept.
 */
export function readTransit(feed: string, toEnu: (lon: number, lat: number) => [number, number],
  keep: (e: number, n: number) => boolean, serviceDate?: string): TransitLine[] {
  const date = serviceDate ?? (() => { const d = new Date(); d.setDate(d.getDate() + ((9 - d.getDay()) % 7 || 7)); return d.toISOString().slice(0, 10).replace(/-/g, ""); })();
  const services = new Set(csv(join(feed, "calendar_dates.txt")).filter((r) => r.date === date && r.exception_type === "1").map((r) => r.service_id));
  const routes = new Map(csv(join(feed, "routes.txt")).filter((r) => r.route_type === "0" || r.route_type === "3").map((r) => [r.route_id, r]));
  // trips per (route, direction): count, and the most used shape
  const groups = new Map<string, { route: string; dir: number; trips: number; shapes: Map<string, number> }>();
  for (const t of csv(join(feed, "trips.txt"))) {
    if (!routes.has(t.route_id) || !services.has(t.service_id) || !t.shape_id) continue;
    const k = `${t.route_id}|${t.direction_id}`;
    const g = groups.get(k) ?? groups.set(k, { route: t.route_id, dir: Number(t.direction_id) || 0, trips: 0, shapes: new Map() }).get(k)!;
    g.trips++;
    g.shapes.set(t.shape_id, (g.shapes.get(t.shape_id) ?? 0) + 1);
  }
  const wanted = new Map<string, string>(); // shape_id -> group key
  for (const [k, g] of groups) wanted.set([...g.shapes].sort((a, b) => b[1] - a[1])[0][0], k);
  // shapes: only the wanted ones, in sequence order
  const pts = new Map<string, Array<[number, number, number]>>();
  for (const s of csv(join(feed, "shapes.txt"))) {
    if (!wanted.has(s.shape_id)) continue;
    (pts.get(s.shape_id) ?? pts.set(s.shape_id, []).get(s.shape_id)!).push([Number(s.shape_pt_sequence), Number(s.shape_pt_lon), Number(s.shape_pt_lat)]);
  }
  const out: TransitLine[] = [];
  for (const [shape, k] of wanted) {
    const g = groups.get(k)!, route = routes.get(g.route)!, p = pts.get(shape);
    if (!p || p.length < 2) continue;
    p.sort((a, b) => a[0] - b[0]);
    // resample to ~10 m in ENU
    const enu = p.map(([, lon, lat]) => toEnu(lon, lat));
    const path: Array<[number, number]> = [enu[0]];
    let carry = 0;
    for (let i = 1; i < enu.length; i++) {
      const [ax, ay] = enu[i - 1], [bx, by] = enu[i], L = Math.hypot(bx - ax, by - ay);
      for (let d = 10 - carry; d < L; d += 10) path.push([ax + (bx - ax) * d / L, ay + (by - ay) * d / L]);
      carry = (carry + L) % 10;
    }
    path.push(enu.at(-1)!);
    const inside = path.filter(([e, n]) => keep(e, n)).length * 10;
    if (inside < 300) continue; // passes the painted area for less than 300 m
    const kind = route.route_type === "0" ? "tram" : "bus";
    out.push({ name: route.route_short_name || route.route_id, kind, dir: g.dir, headway: Math.round(Math.max(120, (17 * 3600) / Math.max(1, g.trips))), path: path.map(([e, n]) => [Math.round(e * 10) / 10, Math.round(n * 10) / 10]) });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, "it", { numeric: true }) || a.dir - b.dir);
}
