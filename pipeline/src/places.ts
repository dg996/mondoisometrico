/**
 * Regions and cities of Mondo Isometrico. Pure data, shared by the pipeline and the web viewer.
 *
 * A REGION is one flat map: one orthographic camera in a local East-North-Up frame at its origin,
 * one tile pyramid (web/public/regions/<id>/). A flat map is accurate to ~1° of building lean at
 * 100 km from its origin, so a region can hold all cities within ~150 km and you scroll between them.
 * Far-apart cities get their own region (joined later by a world overview).
 *
 * A CITY is a named view into a region: /<city-slug> opens the region centred on it.
 *
 * Research notes (Rome, 2026):
 * - Buildings/heights: start with OSM (`building` + `height` / `building:levels`). Planned upgrade:
 *   Regione Lazio DBT 2014 (CC BY 4.0) and/or Roma Capitale GeoRoma WFS
 *   (https://geoportale.comune.roma.it/geoserver/ows) — cite when wired in fetch.ts.
 * - Trees: OSM natural=tree / landuse=forest / leisure=park (Mediterranean: stone pine, umbrella pine,
 *   cypress, plane, olive; TLV tree sheet is a starting palette until a Rome sheet is painted).
 * - Municipal border: OSM admin_level=8 name "Roma", country name:en "Italy".
 * - Street grid: centro storico is irregular; heading 45° keeps two façades on roughly N–S / E–W
 *   blocks around the Pantheon and puts the Tiber toward the left of the frame.
 * - Airport: Fiumicino (FCO) runway 16L ~163°.
 * - Terrain: Copernicus GLO-30 (global).
 */

export interface Region {
  title: string;
  /** ENU origin. Fixed forever once tiles exist: changing it moves every tile of the region. */
  origin: { lat: number; lon: number; h: number };
  /** Compass bearing the camera looks toward (pick it diagonal to the main street grid). */
  headingDeg: number;
  /** OSM country (name:en of the admin_level=2 area) and municipality names (admin_level=8) for the border overlay. */
  country: string;
  municipalities: string[];
  /** Airliners on final approach drawn over the map (optional). */
  airport?: { lat: number; lon: number; runwayHeadingDeg: number };
  /** Credit lines (video mode and footer). */
  credits: string[];
}

export interface City {
  title: string;
  region: string;
  /** Opening view: centre and on-screen width in metres. */
  center: [number, number];
  widthM: number;
}

export const REGIONS: Record<string, Region> = {
  "roma-centro": {
    title: "Roma · Centro",
    origin: { lat: 41.8955, lon: 12.4823, h: 0 }, // Piazza Venezia
    headingDeg: 45, // NE: diagonal to centro blocks, Tiber toward the left
    country: "Italy",
    municipalities: [
      "Roma",
    ],
    airport: { lat: 41.8003, lon: 12.2389, runwayHeadingDeg: 163 }, // Fiumicino FCO, runway 16L
    credits: [
      "Map data © OpenStreetMap contributors",
      "Terrain: Copernicus DEM © DLR, Airbus DS · Painted with AI",
    ],
  },
};

export const CITIES: Record<string, City> = {
  // Pantheon / Piazza della Rotonda — opening view of the historic centre
  // Opening width matches the pantheon test patch (~800 m); widen when more areas are painted.
  roma: { title: "Roma", region: "roma-centro", center: [41.8986, 12.4769], widthM: 700 },
};

export const DEFAULT_CITY = "roma";
