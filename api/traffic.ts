/**
 * Vercel Function /api/traffic: Rome's live traffic flow from TomTom (Traffic API, vector flow tiles,
 * "relative" = current speed / free-flow speed per road stretch), decoded server-side into a small
 * JSON of polylines with their congestion level. The map matches them onto its own OSM roads
 * (web/src/scripts/live-traffic.ts): TomTom geometry is never drawn, only its congestion level.
 *
 * Env: TOMTOM_API_KEY (developer.tomtom.com, set in the Vercel project; never in the repository).
 *
 * Quota: TomTom's free tier is monthly (200,000 tile requests). One refresh = the TILES below (≈12)
 * and happens at most every REFRESH_S, cached here in memory and at Vercel's CDN, so the whole
 * site costs ≲ 1,800 tile requests a day however many visitors there are. A hard cap (DAILY_CAP)
 * stops calling TomTom for the rest of the UTC day; the last data keeps being served meanwhile.
 */
declare const process: { env: Record<string, string | undefined> };

/** painted Rome (pipeline/src/areas.ts roma-inner bbox: south, west, north, east) */
const BBOX = [41.86, 12.42, 41.935, 12.545] as const;
const ZOOM = 13;
const REFRESH_S = 600;
/** hard daily ceiling of TomTom tile requests (31 × 5,000 = 155,000 < 200,000 free a month) */
const DAILY_CAP = 5000;

const tileX = (lon: number) => Math.floor(((lon + 180) / 360) * 2 ** ZOOM);
const tileY = (lat: number) => Math.floor(((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * 2 ** ZOOM);
const TILES: Array<[number, number]> = [];
for (let x = tileX(BBOX[1]); x <= tileX(BBOX[3]); x++) for (let y = tileY(BBOX[2]); y <= tileY(BBOX[0]); y++) TILES.push([x, y]);

let cache: { at: number; body: string } | null = null;
let inflight: Promise<string | null> | null = null;
/** last failed refresh: no new attempt for RETRY_S (a bad key or an outage never burns the quota) */
let failedAt = 0;
const RETRY_S = 300;
const spent = { day: "", tiles: 0 };

export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method !== "GET") return new Response(null, { status: 405 });
    // pasted keys often carry a space, a newline or quotes
    const key = (process.env.TOMTOM_API_KEY ?? "").trim().replace(/^["']|["']$/g, "");
    if (!key) return json({ error: "not-configured" }, 503, 60);
    const now = Date.now();
    if ((!cache || now - cache.at > REFRESH_S * 1000) && now - failedAt > RETRY_S * 1000) {
      inflight ??= refresh(key).finally(() => { inflight = null; });
      const body = await inflight;
      if (body) cache = { at: Date.now(), body }; else failedAt = Date.now();
    }
    if (!cache) return json({ error: "unavailable" }, 503, 60);
    const age = Math.round((Date.now() - cache.at) / 1000);
    return new Response(cache.body, {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        // one refresh per REFRESH_S at the CDN as well: visitors never reach TomTom directly
        "Cache-Control": `public, max-age=60, s-maxage=${Math.max(30, REFRESH_S - age)}, stale-while-revalidate=300`,
        "X-Traffic-Age": String(age),
      },
    });
  },
};

function json(o: unknown, status: number, maxAge: number) {
  return new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json", "Cache-Control": `public, s-maxage=${maxAge}` } });
}

/** fetch every tile, decode, return the compact JSON (null when nothing could be fetched) */
async function refresh(key: string): Promise<string | null> {
  const day = new Date().toISOString().slice(0, 10);
  if (spent.day !== day) { spent.day = day; spent.tiles = 0; }
  if (spent.tiles + TILES.length > DAILY_CAP) return null; // over today's budget: keep serving the last data
  spent.tiles += TILES.length;
  const segments: Array<{ l: number; c?: 1; p: number[] }> = [];
  let ok = 0;
  await Promise.all(TILES.map(async ([x, y], i) => {
    const host = "abcd"[i % 4];
    const url = `https://${host}.api.tomtom.com/traffic/map/4/tile/flow/relative/${ZOOM}/${x}/${y}.pbf?key=${encodeURIComponent(key)}`;
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) { console.warn(`traffic tile ${x}/${y}: HTTP ${r.status}`); return; }
      for (const f of decodeTile(new Uint8Array(await r.arrayBuffer()), x, y)) segments.push(f);
      ok++;
    } catch (e) { console.warn(`traffic tile ${x}/${y}: ${(e as Error).name} ${(e as Error).message.slice(0, 80)}`); } // one tile missing: the others still count
  }));
  if (!ok) return null;
  return JSON.stringify({ at: new Date().toISOString(), source: "© TomTom", tiles: ok, segments });
}

// ---- minimal Mapbox-Vector-Tile (protobuf) reader: layers > features > tags + line geometry ----

class Pbf {
  pos = 0;
  constructor(public buf: Uint8Array) {}
  varint(): number {
    let v = 0, shift = 0, b: number;
    do { b = this.buf[this.pos++]; v += (b & 0x7f) * 2 ** shift; shift += 7; } while (b & 0x80);
    return v;
  }
  bytes(): Uint8Array { const n = this.varint(), s = this.buf.subarray(this.pos, this.pos + n); this.pos += n; return s; }
  skip(wire: number) {
    if (wire === 0) this.varint(); else if (wire === 1) this.pos += 8; else if (wire === 2) { const n = this.varint(); this.pos += n; } else if (wire === 5) this.pos += 4;
    else throw new Error(`wire type ${wire}`);
  }
}
const text = new TextDecoder();

function decodeTile(buf: Uint8Array, tx: number, ty: number) {
  const out: Array<{ l: number; c?: 1; p: number[] }> = [];
  const pb = new Pbf(buf);
  while (pb.pos < buf.length) {
    const tag = pb.varint();
    if (tag >> 3 === 3 && (tag & 7) === 2) out.push(...decodeLayer(pb.bytes(), tx, ty)); else pb.skip(tag & 7);
  }
  return out;
}

function decodeLayer(buf: Uint8Array, tx: number, ty: number) {
  const pb = new Pbf(buf), keys: string[] = [], values: unknown[] = [], feats: Uint8Array[] = [];
  let extent = 4096;
  while (pb.pos < buf.length) {
    const tag = pb.varint(), f = tag >> 3, w = tag & 7;
    if (f === 2 && w === 2) feats.push(pb.bytes());
    else if (f === 3 && w === 2) keys.push(text.decode(pb.bytes()));
    else if (f === 4 && w === 2) values.push(decodeValue(pb.bytes()));
    else if (f === 5 && w === 0) extent = pb.varint();
    else pb.skip(w);
  }
  const out: Array<{ l: number; c?: 1; p: number[] }> = [];
  const n = 2 ** ZOOM;
  const lon = (px: number) => ((tx + px / extent) / n) * 360 - 180;
  const lat = (py: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * (ty + py / extent)) / n))) * 180) / Math.PI;
  for (const fb of feats) {
    const fp = new Pbf(fb);
    let tags: number[] = [], geom: number[] = [], type = 0;
    while (fp.pos < fb.length) {
      const tag = fp.varint(), f = tag >> 3, w = tag & 7;
      if (f === 2 && w === 2) tags = packed(fp.bytes());
      else if (f === 3 && w === 0) type = fp.varint();
      else if (f === 4 && w === 2) geom = packed(fp.bytes());
      else fp.skip(w);
    }
    if (type !== 2) continue; // lines only
    const props: Record<string, unknown> = {};
    for (let i = 0; i + 1 < tags.length; i += 2) props[keys[tags[i]]] = values[tags[i + 1]];
    const level = Number(props.traffic_level);
    if (!Number.isFinite(level)) continue;
    // geometry: MoveTo / LineTo commands with zigzag deltas, one or more parts
    let x = 0, y = 0, part: number[] = [];
    const flush = () => { if (part.length >= 4) out.push({ l: Math.round(level * 100) / 100, ...(props.road_closure ? { c: 1 as const } : {}), p: part }); part = []; };
    for (let i = 0; i < geom.length;) {
      const cmd = geom[i] & 7, count = geom[i] >> 3; i++;
      if (cmd === 1) flush();
      if (cmd === 1 || cmd === 2) for (let k = 0; k < count; k++, i += 2) {
        x += (geom[i] >>> 1) ^ -(geom[i] & 1); y += (geom[i + 1] >>> 1) ^ -(geom[i + 1] & 1);
        if (x < -64 || y < -64 || x > extent + 64 || y > extent + 64) continue;
        part.push(Math.round(lat(y) * 1e5) / 1e5, Math.round(lon(x) * 1e5) / 1e5);
      }
    }
    flush();
  }
  return out;
}

function packed(b: Uint8Array) { const p = new Pbf(b), out: number[] = []; while (p.pos < b.length) out.push(p.varint()); return out; }

function decodeValue(b: Uint8Array): unknown {
  const p = new Pbf(b);
  let v: unknown = null;
  while (p.pos < b.length) {
    const tag = p.varint(), f = tag >> 3, w = tag & 7;
    if (f === 1 && w === 2) v = text.decode(p.bytes());
    else if (f === 2 && w === 5) { v = new DataView(b.buffer, b.byteOffset + p.pos, 4).getFloat32(0, true); p.pos += 4; }
    else if (f === 3 && w === 1) { v = new DataView(b.buffer, b.byteOffset + p.pos, 8).getFloat64(0, true); p.pos += 8; }
    else if ((f === 4 || f === 5) && w === 0) v = p.varint();
    else if (f === 6 && w === 0) { const z = p.varint(); v = z % 2 ? -(z + 1) / 2 : z / 2; }
    else if (f === 7 && w === 0) v = Boolean(p.varint());
    else p.skip(w);
  }
  return v;
}
