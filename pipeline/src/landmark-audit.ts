/**
 * Landmark position audit: every label / paint anchor in landmarks.ts against the OSM feature of the
 * same name (area centroid of its outline) and its Wikidata coordinate (P625, CC0), plus the label's
 * assumed ground elevation against the terrain (a wrong elevation shifts the label on screen).
 *
 *   node --import tsx pipeline/src/landmark-audit.ts [area]     (after fetch/ground of that area)
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LANDMARKS } from "./landmarks.ts";
import { openArea } from "./areas.ts";
import { ecefToEnu, llhToEcef } from "./camera.ts";
import { DERIVED, RAW } from "./paths.ts";
import { SEA_H } from "./heights.ts";

const area = process.argv[2] ?? "roma-inner";
openArea(area);
const els = ["osm.json", "ground.json"].flatMap((f) => JSON.parse(readFileSync(join(RAW, area, f), "utf8")).elements);
const meta = JSON.parse(readFileSync(join(DERIVED, area, "ground", "meta.json"), "utf8"));
const hb = readFileSync(join(DERIVED, area, "ground", "height.bin"));
const terr = new Float32Array(hb.buffer.slice(hb.byteOffset, hb.byteOffset + hb.byteLength));
const groundMsl = (lat: number, lon: number) => {
  const [x, y] = ecefToEnu(llhToEcef(lat, lon, 0));
  const i = Math.round((x - meta.x0) / meta.step), j = Math.round((y - meta.y0) / meta.step);
  return terr[j * meta.nx + i] - SEA_H + (x * x + y * y) / (2 * 6371000);
};
const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[’']/g, "'");
const outer = (el: any): number[][][] => el.type === "way" && el.geometry ? [el.geometry.map((q: any) => [q.lon, q.lat])]
  : (el.members ?? []).filter((m: any) => m.role === "outer" && m.geometry).map((m: any) => m.geometry.map((q: any) => [q.lon, q.lat]));
function centroid(rings: number[][][]) {
  let A = 0, X = 0, Y = 0;
  for (const r of rings) for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const f = r[j][0] * r[i][1] - r[i][0] * r[j][1]; A += f; X += (r[j][0] + r[i][0]) * f; Y += (r[j][1] + r[i][1]) * f;
  }
  if (Math.abs(A) < 1e-14) { const p = rings.flat(); return [p.reduce((a, q) => a + q[0], 0) / p.length, p.reduce((a, q) => a + q[1], 0) / p.length]; }
  return [X / (3 * A), Y / (3 * A)];
}
const dist = (la1: number, lo1: number, la2: number, lo2: number) => Math.hypot((lo2 - lo1) * 111320 * Math.cos(la1 * Math.PI / 180), (la2 - la1) * 110574);
const rows: any[] = [];
const qids: string[] = [];
for (const L of LANDMARKS.roma) {
  const key = norm(L.name);
  const cands = els.filter((e: any) => { const t = e.tags ?? {}; return [t.name, t["name:it"], t.alt_name, t.official_name].some((n) => n && (norm(n) === key || norm(n).includes(key))); })
    .map((e: any) => ({ e, rs: outer(e).filter((r) => r.length > 2) })).filter((c: any) => c.rs.length)
    .map((c: any) => ({ ...c, c: centroid(c.rs) })).sort((a: any, b: any) => dist(L.lat, L.lon, a.c[1], a.c[0]) - dist(L.lat, L.lon, b.c[1], b.c[0]));
  const best = cands[0];
  if (best?.e.tags?.wikidata) qids.push(best.e.tags.wikidata);
  rows.push({ name: L.name, osm: best ? `${best.e.type}/${best.e.id}` : "-", dOsm: best ? Math.round(dist(L.lat, L.lon, best.c[1], best.c[0])) : null,
    wd: best?.e.tags?.wikidata ?? "", groundMsl: L.groundMsl ?? null, terrainMsl: Math.round(groundMsl(L.lat, L.lon) * 10) / 10, osmLat: best?.c[1], osmLon: best?.c[0] });
}
const wd: Record<string, [number, number]> = {};
if (qids.length) {
  const q = `SELECT ?i ?c WHERE { VALUES ?i { ${qids.map((x) => "wd:" + x).join(" ")} } ?i wdt:P625 ?c }`;
  const r = await fetch("https://query.wikidata.org/sparql?format=json&query=" + encodeURIComponent(q), { headers: { "User-Agent": "mondoisometrico/0.1 (open-data map pipeline)" } });
  for (const b of (await r.json()).results.bindings) { const m = b.c.value.match(/Point\(([-\d.]+) ([-\d.]+)\)/); if (m) wd[b.i.value.split("/").pop()] = [Number(m[2]), Number(m[1])]; }
}
for (const r of rows) { const w = wd[r.wd]; r.dWikidata = w ? Math.round(dist(r.osmLat ?? 0, r.osmLon ?? 0, w[0], w[1])) : null; }
console.table(rows.map(({ osmLat, osmLon, ...r }) => ({ ...r, osm: r.osm, osmCentroid: osmLat ? `${osmLat.toFixed(6)},${osmLon.toFixed(6)}` : "" })));
