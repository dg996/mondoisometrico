import { mkdirSync, writeFileSync, existsSync, statSync, renameSync } from 'node:fs';
import path from 'node:path';
import { PMTiles, FetchSource } from 'pmtiles';
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';

const ROOT = process.cwd();
const CACHE_DIR = path.join(ROOT, '.cache', 'pmtiles');
const OUT_DIR = path.join(ROOT, '.cache', 'rome-extract');
const BBOX = [12.43, 41.87, 12.53, 41.93]; // centro storico + Vaticano + Termini + Borghese
const PAD = 0.008;

const HDX = 'https://production-raw-data-api.s3.amazonaws.com/ISO3/ITA';
const OVERTURE = 'https://overturemaps-extras-us-west-2.s3.us-west-2.amazonaws.com/tiles/2026-10-21.0';

const ALL_SOURCES = [
  { key: 'buildings', url: `${HDX}/buildings/hotosm_ita_buildings_osm.pmtiles`, z: 13, layers: ['buildings'], kinds: ['Polygon', 'MultiPolygon'] },
  { key: 'buildings_vat', url: `https://production-raw-data-api.s3.amazonaws.com/ISO3/VAT/buildings/hotosm_vat_buildings_osm.pmtiles`, z: 13, layers: ['buildings'], kinds: ['Polygon', 'MultiPolygon'] },
  { key: 'roads', url: `${HDX}/roads/hotosm_ita_roads_osm.pmtiles`, z: 13, layers: ['roads'], kinds: ['LineString', 'MultiLineString'] },
  { key: 'roads_vat', url: `https://production-raw-data-api.s3.amazonaws.com/ISO3/VAT/roads/hotosm_vat_roads_osm.pmtiles`, z: 13, layers: ['roads'], kinds: ['LineString', 'MultiLineString'] },
  { key: 'railways', url: `${HDX}/railways/hotosm_ita_railways_osm.pmtiles`, z: 12, layers: ['railways'], kinds: ['LineString', 'MultiLineString'] },
  { key: 'waterways', url: `${HDX}/waterways/hotosm_ita_waterways_osm.pmtiles`, z: 12, layers: ['waterways'], kinds: ['LineString', 'MultiLineString', 'Polygon', 'MultiPolygon'] },
  { key: 'pois', url: `${HDX}/points_of_interest/hotosm_ita_points_of_interest_osm.pmtiles`, z: 13, layers: ['points_of_interest'], kinds: ['Point', 'MultiPoint'] },
  { key: 'pois_vat', url: `https://production-raw-data-api.s3.amazonaws.com/ISO3/VAT/points_of_interest/hotosm_vat_points_of_interest_osm.pmtiles`, z: 13, layers: ['points_of_interest'], kinds: ['Point', 'MultiPoint'] },
  { key: 'base', url: `${OVERTURE}/base.pmtiles`, z: 12, layers: ['land', 'land_use', 'land_cover', 'water'], kinds: ['Polygon', 'MultiPolygon', 'LineString', 'MultiLineString'] },
];

const requested = new Set(process.argv.slice(2));
const SOURCES = requested.size ? ALL_SOURCES.filter(source => requested.has(source.key)) : ALL_SOURCES;

function tileRanges(bbox, z) {
  const [west, south, east, north] = bbox;
  const n = 2 ** z;
  const xt = lon => Math.floor((lon + 180) / 360 * n);
  const yt = lat => Math.floor((1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * n);
  const x1 = xt(west), x2 = xt(east), y1 = yt(north), y2 = yt(south);
  const tiles = [];
  for (let x = x1; x <= x2; x++) for (let y = y1; y <= y2; y++) tiles.push([z, x, y]);
  return tiles;
}

function featureBounds(geometry) {
  const box = [Infinity, Infinity, -Infinity, -Infinity];
  const visit = point => {
    if (!point || typeof point[0] !== 'number') return;
    box[0] = Math.min(box[0], point[0]);
    box[1] = Math.min(box[1], point[1]);
    box[2] = Math.max(box[2], point[0]);
    box[3] = Math.max(box[3], point[1]);
  };
  const walk = value => Array.isArray(value?.[0]) ? value.forEach(walk) : visit(value);
  walk(geometry.coordinates);
  return box;
}

function intersects(a, b) {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function withRetry(label, fn, attempts = 5) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); }
    catch (error) {
      last = error;
      const wait = 800 * (i + 1) + Math.floor(Math.random() * 350);
      console.warn(`retry ${i + 1}/${attempts} ${label}: ${error.message || error}`);
      await sleep(wait);
    }
  }
  throw last;
}

async function main() {
  mkdirSync(CACHE_DIR, { recursive: true });
  mkdirSync(OUT_DIR, { recursive: true });
  const queryBox = [BBOX[0] - PAD, BBOX[1] - PAD, BBOX[2] + PAD, BBOX[3] + PAD];
  const summary = {};

  for (const source of SOURCES) {
    const file = path.join(OUT_DIR, `${source.key}.ndjson`);
    if (existsSync(file)) {
      console.log(`cached ${source.key}`);
      continue;
    }
    console.log(`extract ${source.key}`);
    const pmtiles = new PMTiles(new FetchSource(source.url));
    const header = await withRetry(`${source.key} header`, () => pmtiles.getHeader());
    const z = Math.min(source.z, header.maxZoom);
    const tiles = tileRanges(BBOX, z);
    const lines = [];
    let read = 0;
    for (const [tz, x, y] of tiles) {
      const tile = await withRetry(`${source.key} z${tz}/${x}/${y}`, async () => pmtiles.getZxy(tz, x, y));
      if (!tile?.data?.byteLength) continue;
      read += tile.data.byteLength;
      const vector = new VectorTile(new PbfReader(Buffer.from(tile.data)));
      for (const layerName of source.layers) {
        const layer = vector.layers[layerName];
        if (!layer) continue;
        for (let i = 0; i < layer.length; i++) {
          const feature = layer.feature(i);
          let geojson;
          try { geojson = feature.toGeoJSON(x, y, tz); } catch { continue; }
          if (!source.kinds.includes(geojson.geometry?.type)) continue;
          const bounds = featureBounds(geojson.geometry);
          if (!intersects(bounds, queryBox)) continue;
          const id = geojson.properties?.id ?? geojson.id ?? `${layerName}-${i}`;
          lines.push(JSON.stringify({
            source: source.key,
            layer: layerName,
            id: String(id),
            tile: [tz, x, y],
            properties: geojson.properties || {},
            geometry: geojson.geometry,
          }));
        }
      }
      console.log(`  ${source.key} tile ${x},${y}: ${read} bytes, ${lines.length} pieces`);
      await sleep(100);
    }
    const tempFile = `${file}.tmp`;
    writeFileSync(tempFile, lines.join('\n') + '\n');
    renameSync(tempFile, file);
    summary[source.key] = { tiles: tiles.length, bytes: read, pieces: lines.length, written: statSync(file).size };
    console.log(`done ${source.key}`, summary[source.key]);
  }
  writeFileSync(path.join(OUT_DIR, 'summary.json'), JSON.stringify({ bbox: BBOX, generatedAt: new Date().toISOString(), summary }, null, 2));
}

main().catch(error => { console.error(error); process.exit(1); });
