/**
 * Fetch the open data an area is built from (no Google: everything is openly licensed).
 *
 *   npm -w pipeline run fetch -- pantheon
 *
 * data/raw/<area>/tlv_buildings.geojson  Tel Aviv-Yafo GIS only (empty FeatureCollection elsewhere)
 * data/raw/<area>/tlv_canopy.geojson     Tel Aviv-Yafo canopy only (empty elsewhere)
 * data/raw/<area>/osm.json               OSM buildings + trees (primary source for Rome)
 * data/raw/<area>/roads.json             OSM drivable roads (for the traffic animation)
 * data/raw/<area>/ground.json            OSM ground surface: roads/paths, landuse, parks, water,
 *                                        coastline, rail (bbox + margin, drawn onto the terrain)
 * data/raw/dem/*.tif                     Copernicus GLO-30 elevation (1°×1° tiles, AWS open data)
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openArea } from "./areas.ts";
import { RAW } from "./paths.ts";

const EMPTY_FC = { type: "FeatureCollection", features: [] };
const TLV = "https://gisn.tel-aviv.gov.il/arcgis/rest/services/IView2/MapServer/{layer}/query";
const UA = { "User-Agent": "mondoisometrico/0.1 (open-data isometric map; fork of isometricworld)" };

async function arcgisCell(layer: number, [s, w, n, e]: [number, number, number, number], fields: string) {
  const feats: any[] = [];
  for (let offset = 0, page = 1000; ; offset += page) {
    const q = new URLSearchParams({
      f: "geojson", where: "1=1", geometry: `${w},${s},${e},${n}`, geometryType: "esriGeometryEnvelope",
      inSR: "4326", outSR: "4326", spatialRel: "esriSpatialRelIntersects", outFields: fields,
      resultOffset: String(offset), resultRecordCount: String(page),
    });
    let batch: any[] | null = null;
    for (let attempt = 1; attempt <= 5 && !batch; attempt++) {
      try {
        const r = await fetch(`${TLV.replace("{layer}", String(layer))}?${q}`, { headers: UA, signal: AbortSignal.timeout(120_000) });
        const j = await r.json();
        if (j.error) throw new Error(JSON.stringify(j.error));
        batch = j.features ?? [];
      } catch (err) {
        if (attempt === 5) throw err;
        await new Promise((res) => setTimeout(res, 3000 * attempt));
      }
    }
    feats.push(...batch!);
    if (batch!.length < page) return feats;
  }
}

/** Query an ArcGIS layer over a grid of small cells (big envelopes time out), deduped by `idField`. */
async function arcgis(layer: number, bbox: [number, number, number, number], fields: string, idField: string) {
  const [s, w, n, e] = bbox, step = 0.01;
  const seen = new Map<unknown, unknown>();
  const cells: Array<[number, number, number, number]> = [];
  for (let la = s; la < n; la += step) for (let lo = w; lo < e; lo += step) cells.push([la, lo, Math.min(n, la + step), Math.min(e, lo + step)]);
  for (const [i, c] of cells.entries()) {
    for (const f of await arcgisCell(layer, c, fields)) seen.set(f.properties?.[idField] ?? f.id ?? Math.random(), f);
    process.stdout.write(`\r  layer ${layer}: cell ${i + 1}/${cells.length}, ${seen.size} features`);
  }
  process.stdout.write("\n");
  return { type: "FeatureCollection", features: [...seen.values()] };
}

async function overpass(query: string) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    const r = await fetch("https://overpass-api.de/api/interpreter", {
      method: "POST", headers: { ...UA, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ data: query }),
    });
    if (r.ok) return r.json();
    console.warn(`  overpass ${r.status}, retrying…`);
    await new Promise((res) => setTimeout(res, 15_000 * attempt));
  }
  throw new Error("overpass failed");
}

const name = process.argv[2] ?? "pantheon";
const area = openArea(name);
const dir = join(RAW, name);
mkdirSync(dir, { recursive: true });

// Tel Aviv municipal layers only for israel-center areas; Rome uses OSM (+ planned GeoRoma/DBT).
const useTlvGis = area.region === "israel-center";
if (!existsSync(join(dir, "tlv_buildings.geojson"))) {
  writeFileSync(join(dir, "tlv_buildings.geojson"), JSON.stringify(
    useTlvGis
      ? await arcgis(513, area.bbox, "id_binyan,t_sug_mivne,ms_komot,gova_simplex_2019,min_height,max_height,year", "id_binyan")
      : EMPTY_FC,
  ));
}
if (!existsSync(join(dir, "tlv_canopy.geojson"))) {
  writeFileSync(join(dir, "tlv_canopy.geojson"), JSON.stringify(
    useTlvGis ? await arcgis(574, area.bbox, "OBJECTID", "OBJECTID") : EMPTY_FC,
  ));
}
if (!existsSync(join(dir, "osm.json"))) {
  const [s, w, n, e] = area.bbox;
  const b = `(${s},${w},${n},${e})`;
  const data = await overpass(`[out:json][timeout:300];
(way["building"]${b}; relation["building"]${b}; node["natural"="tree"]${b};);
out body geom;`);
  writeFileSync(join(dir, "osm.json"), JSON.stringify(data));
  console.log(`  osm: ${data.elements.length} elements`);
}
if (!existsSync(join(dir, "roads.json"))) {
  const [s, w, n, e] = area.bbox;
  const data = await overpass(`[out:json][timeout:300];
way["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link|living_street|service)$"]["area"!="yes"](${s},${w},${n},${e});
out body geom;`);
  writeFileSync(join(dir, "roads.json"), JSON.stringify(data));
  console.log(`  roads: ${data.elements.length} ways`);
}
if (!existsSync(join(dir, "ground.json"))) {
  const [s, w, n, e] = area.bbox, m = 0.02;
  const b = `(${s - m},${w - m},${n + m},${e + m})`;
  const data = await overpass(`[out:json][timeout:600][maxsize:1073741824];
(
  way["highway"]["tunnel"!~"yes|building_passage"]${b};
  way["area:highway"]${b};
  way["railway"~"^(rail|light_rail|tram)$"]["tunnel"!="yes"]${b};
  nwr["landuse"]${b};
  nwr["leisure"~"^(park|garden|pitch|playground|stadium|track|golf_course|swimming_pool|dog_park|nature_reserve|recreation_ground|marina|sports_centre)$"]${b};
  nwr["natural"~"^(water|beach|sand|scrub|grassland|wood|wetland|coastline|bare_rock|heath)$"]${b};
  nwr["water"]${b};
  nwr["waterway"="riverbank"]${b};
  nwr["amenity"~"^(parking|school|university|college|hospital|grave_yard)$"]${b};
  nwr["man_made"~"^(pier|breakwater|groyne|bridge)$"]${b};
  nwr["place"="square"]${b};
);
out body geom;`);
  writeFileSync(join(dir, "ground.json"), JSON.stringify(data));
  console.log(`  ground: ${data.elements.length} elements`);
}
mkdirSync(join(RAW, "dem"), { recursive: true });
{
  const [s, w, n, e] = area.bbox;
  for (let lat = Math.floor(s - 0.03); lat <= Math.floor(n + 0.03); lat++)
    for (let lon = Math.floor(w - 0.03); lon <= Math.floor(e + 0.03); lon++) {
      const id = `Copernicus_DSM_COG_10_N${String(lat).padStart(2, "0")}_00_E${String(lon).padStart(3, "0")}_00_DEM`;
      const file = join(RAW, "dem", `${id}.tif`);
      if (existsSync(file)) continue;
      const r = await fetch(`https://copernicus-dem-30m.s3.amazonaws.com/${id}/${id}.tif`, { headers: UA });
      if (!r.ok) throw new Error(`DEM ${id}: ${r.status}`);
      writeFileSync(file, Buffer.from(await r.arrayBuffer()));
      console.log(`  dem: ${id}`);
    }
}
