/**
 * Regione Lazio, Carta Tecnica Regionale Numerica 2002-2003 1:5000 (CC BY 4.0, dati.lazio.it):
 * layer 06V "unità volumetriche", every surveyed building volume with its height (ALTEZZA, m above
 * the ground) and building id (IDEDIF). OSM has footprints but few heights in Rome; the CTRN has a
 * measured height for every volume of every building, including the stepped masses of monuments.
 *
 * Coordinates are Gauss-Boaga Roma40 fuso Est (EPSG:3004, Monte Mario / Italy zone 2) and are
 * converted to WGS84 with the EPSG Helmert parameters (accurate to a few metres); a residual shift
 * measured against OSM footprints (ctrnShift) aligns them to the map.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

export const CTRN_BASE = "https://geoportale.regione.lazio.it/cartografia";
export const CTRN_DIR = "2002_2003_CTRN_5K_SHP/Roma/Municipi";
export const CTRN_CREDIT = "Edifici: Regione Lazio, CTRN 2002-2003 1:5000 (CC BY 4.0)";

/** One surveyed volume: outer ring (lon, lat), height above ground (m), building id. */
export interface CtrnUnit { r: Array<[number, number]>; h: number; id: number }

// ---- Gauss-Boaga (Monte Mario, International 1924) -> WGS84 -----------------------------------
const INTL = { a: 6378388, f: 1 / 297 }, WGS = { a: 6378137, f: 1 / 298.257223563 };
const D2R = Math.PI / 180, AS = Math.PI / 648000;
/** EPSG:3004 towgs84 (position vector): -104.1,-49.1,-9.9 m, 0.971,-2.917,0.714 arcsec, -11.68 ppm */
const H = { tx: -104.1, ty: -49.1, tz: -9.9, rx: 0.971 * AS, ry: -2.917 * AS, rz: 0.714 * AS, s: -11.68e-6 };

function tmInverse(E: number, N: number) {
  const { a, f } = INTL, k0 = 0.9996, lon0 = 15 * D2R, e2 = f * (2 - f), ep2 = e2 / (1 - e2);
  const M = N / k0, mu = M / (a * (1 - e2 / 4 - 3 * e2 ** 2 / 64 - 5 * e2 ** 3 / 256));
  const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
  const p1 = mu + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * Math.sin(2 * mu) + (21 * e1 ** 2 / 16 - 55 * e1 ** 4 / 32) * Math.sin(4 * mu)
    + (151 * e1 ** 3 / 96) * Math.sin(6 * mu) + (1097 * e1 ** 4 / 512) * Math.sin(8 * mu);
  const C1 = ep2 * Math.cos(p1) ** 2, T1 = Math.tan(p1) ** 2, N1 = a / Math.sqrt(1 - e2 * Math.sin(p1) ** 2);
  const R1 = a * (1 - e2) / (1 - e2 * Math.sin(p1) ** 2) ** 1.5, D = (E - 2520000) / (N1 * k0);
  const lat = p1 - (N1 * Math.tan(p1) / R1) * (D ** 2 / 2 - (5 + 3 * T1 + 10 * C1 - 4 * C1 ** 2 - 9 * ep2) * D ** 4 / 24
    + (61 + 90 * T1 + 298 * C1 + 45 * T1 ** 2 - 252 * ep2 - 3 * C1 ** 2) * D ** 6 / 720);
  const lon = lon0 + (D - (1 + 2 * T1 + C1) * D ** 3 / 6 + (5 - 2 * C1 + 28 * T1 - 3 * C1 ** 2 + 8 * ep2 + 24 * T1 ** 2) * D ** 5 / 120) / Math.cos(p1);
  return [lat, lon];
}

function toEcef(lat: number, lon: number, h: number, { a, f }: typeof INTL) {
  const e2 = f * (2 - f), N = a / Math.sqrt(1 - e2 * Math.sin(lat) ** 2);
  return [(N + h) * Math.cos(lat) * Math.cos(lon), (N + h) * Math.cos(lat) * Math.sin(lon), (N * (1 - e2) + h) * Math.sin(lat)];
}

function fromEcef([x, y, z]: number[], { a, f }: typeof WGS) {
  const e2 = f * (2 - f), p = Math.hypot(x, y), lon = Math.atan2(y, x);
  let lat = Math.atan2(z, p * (1 - e2));
  for (let i = 0; i < 6; i++) { const N = a / Math.sqrt(1 - e2 * Math.sin(lat) ** 2); lat = Math.atan2(z + e2 * N * Math.sin(lat), p); }
  return [lat, lon];
}

/** Gauss-Boaga fuso Est (EPSG:3004) -> WGS84 [lon, lat] in degrees. */
export function gaussBoagaToWgs84(E: number, N: number): [number, number] {
  const [la, lo] = tmInverse(E, N);
  const [x, y, z] = toEcef(la, lo, 0, INTL), k = 1 + H.s;
  const X = H.tx + k * (x - H.rz * y + H.ry * z), Y = H.ty + k * (H.rz * x + y - H.rx * z), Z = H.tz + k * (-H.ry * x + H.rx * y + z);
  const [lat, lon] = fromEcef([X, Y, Z], WGS);
  return [lon / D2R, lat / D2R];
}

// ---- shapefile (PolygonZ) + dBase reader ----------------------------------------------------------
export function readDbf(file: string) {
  const f = readFileSync(file), n = f.readUInt32LE(4), hl = f.readUInt16LE(8), rl = f.readUInt16LE(10);
  const fields: Array<[string, number]> = [];
  for (let o = 32; f[o] !== 0x0d; o += 32) fields.push([f.toString("latin1", o, o + 11).replace(/\0.*$/, ""), f[o + 16]]);
  const rows: Record<string, string>[] = [];
  for (let r = 0; r < n; r++) {
    let p = hl + r * rl + 1; const row: Record<string, string> = {};
    for (const [name, len] of fields) { row[name] = f.toString("latin1", p, p + len).trim(); p += len; }
    rows.push(row);
  }
  return rows;
}

/** Polygon / PolygonZ / PolyLine(Z) records: the parts of each record, [x, y] pairs. */
export function readShpPolygons(file: string): Array<Array<Array<[number, number]>>> {
  const s = readFileSync(file), out: Array<Array<Array<[number, number]>>> = [];
  for (let o = 100; o + 8 <= s.length;) {
    const len = s.readInt32BE(o + 4) * 2, c = o + 8, type = s.readInt32LE(c);
    if ([3, 5, 13, 15, 23, 25].includes(type)) {
      const np = s.readInt32LE(c + 36), nPts = s.readInt32LE(c + 40), parts: number[] = [];
      for (let i = 0; i < np; i++) parts.push(s.readInt32LE(c + 44 + 4 * i));
      const pts = c + 44 + 4 * np, rings: Array<Array<[number, number]>> = [];
      for (let i = 0; i < np; i++) {
        const ring: Array<[number, number]> = [];
        for (let k = parts[i]; k < (i + 1 < np ? parts[i + 1] : nPts); k++) ring.push([s.readDoubleLE(pts + 16 * k), s.readDoubleLE(pts + 16 * k + 8)]);
        rings.push(ring);
      }
      out.push(rings);
    } else out.push([]);
    o = c + len;
  }
  return out;
}

/** Download (cached) the 06V volumetric units of every municipio and write units.json (WGS84). */
export async function fetchCtrnUnits(rawDir: string): Promise<string> {
  const outFile = join(rawDir, "ctrn", "units.json");
  if (existsSync(outFile)) return outFile;
  const token = await (await fetch(`${CTRN_BASE}/api/login`, { method: "POST", body: "{}" })).text();
  const list = async (path: string) => (await (await fetch(`${CTRN_BASE}/api/resources/${path}/`, { headers: { "X-Auth": token } })).json()).items as Array<{ name: string; isDir: boolean }>;
  const units: CtrnUnit[] = [];
  for (const mun of (await list(CTRN_DIR)).filter((i) => i.isDir)) {
    const dir = join(rawDir, "ctrn", mun.name.replace(/\s+/g, "-"));
    mkdirSync(dir, { recursive: true });
    const zip = (await list(`${CTRN_DIR}/${encodeURIComponent(mun.name)}`)).find((i) => i.name.startsWith("06V"));
    if (!zip) continue;
    const zipFile = join(dir, "06V.zip");
    if (!existsSync(zipFile)) {
      const r = await fetch(`${CTRN_BASE}/api/raw/${CTRN_DIR}/${encodeURIComponent(mun.name)}/${encodeURIComponent(zip.name)}`, { headers: { "X-Auth": token } });
      if (!r.ok) throw new Error(`CTRN ${mun.name}: ${r.status}`);
      writeFileSync(zipFile, Buffer.from(await r.arrayBuffer()));
      execFileSync("unzip", ["-o", "-q", zipFile, "-d", join(dir, "06V")]);
    }
    const find = (d: string, ext: string): string | undefined => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) { const q = find(p, ext); if (q) return q; } else if (e.name.toLowerCase().endsWith(ext)) return p;
      }
    };
    const shp = find(join(dir, "06V"), ".shp"), dbf = find(join(dir, "06V"), ".dbf");
    if (!shp || !dbf) continue;
    const rows = readDbf(dbf), polys = readShpPolygons(shp);
    let n = 0;
    polys.forEach((rings, i) => {
      const h = Number(rows[i]?.ALTEZZA);
      if (!rings.length || !(h > 0.5) || h > 200) return;
      units.push({ r: rings[0].map(([E, N]) => gaussBoagaToWgs84(E, N)).map(([lo, la]) => [Math.round(lo * 1e7) / 1e7, Math.round(la * 1e7) / 1e7]), h: Math.round(h * 10) / 10, id: Number(rows[i].IDEDIF) || 0 });
      n++;
    });
    console.log(`  ctrn ${mun.name}: ${n} volumetric units`);
  }
  writeFileSync(outFile, JSON.stringify(units));
  return outFile;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { RAW } = await import("./paths.ts");
  console.log(await fetchCtrnUnits(RAW));
}
