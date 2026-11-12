import { llhToPixel } from "./camera.ts";
import { SEA_H } from "./vertical-datum.ts";
/**
 * Named places drawn as labels on the map overlay (monumenti / piazze principali).
 * Coordinates are WGS84; the viewer projects them with the region's camera.
 */
export interface Landmark {
  name: string;
  lat: number;
  lon: number;
  /** Show from this on-screen px-per-art-px and closer (higher = more zoomed in). */
  minPx?: number;
  /** Approximate terrain elevation above mean sea level, used only before a terrain export. */
  groundMsl?: number;
  /** Extra paint-prompt hint so Codex paints the real monument, not a generic block. */
  paintHint?: string;
  /** Approximate footprint radius: hints also reach windows clipping the monument. */
  paintRadiusM?: number;
  /** Geographic bearing of the main entrance/fountain facade (clockwise from north). */
  frontBearing?: number;
}

/** Landmark lists keyed by city slug (places.ts CITIES). WGS84 from OSM centroids. */
export const LANDMARKS: Record<string, Landmark[]> = {
  roma: [
    {
      // Nominatim Pantheon centroid
      // verified 2026-11-12: OSM relation 3373289 (rotunda) centroid
      frontBearing: 0, paintRadiusM: 65, name: "Pantheon", lat: 41.898547, lon: 12.476833, minPx: 0.08, groundMsl: 26,
      paintHint: "Pantheon (keep exact OSM footprint and scale): portico on the NORTH side toward Piazza della Rotonda (upper-left in this camera), rotunda behind it to the south/lower-right. Do NOT mirror it or turn the portico toward the viewer. The north facade may be partly hidden by the dome. A huge grey hemispherical concrete dome with a round oculus on top, cylindrical brick drum, triangular pediment portico with tall columns facing the square. Piazza della Rotonda fountain is in front — do NOT paint the Pantheon as a normal terracotta apartment block.",
    },
    { name: "Piazza Navona", lat: 41.898928, lon: 12.473118, minPx: 0.1, groundMsl: 22 },
    {
      // OSM way 23955329 (historic=archaeological_site) centroid
      paintRadiusM: 45, name: "Area Sacra di Largo Argentina", lat: 41.895402, lon: 12.476869, minPx: 0.18, groundMsl: 22,
      paintHint: "Area Sacra di Largo Argentina (keep the exact OSM outline): a SUNKEN archaeological excavation about 5 m below the surrounding streets, walled and railed all round, with the travertine and tufa podiums of four Republican temples, standing column stumps, a round temple, grass patches and stone paths between them. It is NOT a paved square with trees and NOT level with the street; the medieval Torre del Papito stands at its corner.",
    },
    {
      // OSM way 52333460 centroid; the church closes the WEST side of the piazza
      frontBearing: 90, paintRadiusM: 40, name: "Sant'Agnese in Agone", lat: 41.898751, lon: 12.472661, minPx: 0.16, groundMsl: 25,
      paintHint: "Sant'Agnese in Agone (Borromini, keep exact OSM footprint): Baroque church on the WEST side of Piazza Navona with a concave travertine facade facing EAST onto the piazza (toward upper-right in this camera), two bell towers at the ends of the facade, and a tall drum with a lead-grey ribbed dome and lantern behind the facade. Not a flat roofed block.",
    },
    {
      // OSM way 25610962 centroid; facade on Piazza del Gesù to the west
      frontBearing: 270, paintRadiusM: 45, name: "Chiesa del Gesù", lat: 41.895896, lon: 12.479706, minPx: 0.16, groundMsl: 25,
      paintHint: "Chiesa del Gesù (keep exact OSM footprint): travertine Counter-Reformation facade facing WEST onto Piazza del Gesù (toward lower-left in this camera), Latin-cross nave with terracotta tiled roof, grey ribbed dome with lantern over the crossing toward the east end. Not a plain apartment block.",
    },
    {
      // Nominatim Fontana di Trevi
      // verified 2026-11-12: OSM relation 13448560 centroid
      frontBearing: 165, paintRadiusM: 55, name: "Fontana di Trevi", lat: 41.900879, lon: 12.483256, minPx: 0.1, groundMsl: 27,
      paintHint: "Fontana di Trevi (keep exact OSM scale, do not shrink or relocate): fountain facade on the SOUTH/SOUTHEAST side of Palazzo Poli, facing the basin to lower-right on screen; the palace extends behind it north/upper-left. Palazzo Poli is a WIDE multi-storey palace facade filling the north side of the piazza — Corinthian columns, Oceanus niche with sculpted figures, cascading white water into a large basin that fills most of the square. Do NOT paint it as a tiny fountain model; the palace facade is as tall as neighbouring apartment blocks.",
    },
    {
      // Amphitheatre centroid (not the metro stop ~80 m NW)
      // verified 2026-11-12: OSM relation 1834818 centroid
      paintRadiusM: 125, name: "Colosseo", lat: 41.890259, lon: 12.492361, minPx: 0.06, groundMsl: 23,
      paintHint: "Colosseum / Colosseo (keep OSM footprint): long axis WNW–ESE (approximately 115/295 degrees geographic, mostly left–right in this camera), not a circular stadium; weathered elliptical travertine amphitheatre with 3–4 tiers of arches, hollow sandy arena, broken outer wall on the south side. Immediate surroundings are archaeological park / open paving and grass — NO modern terracotta apartment blocks glued to the amphitheatre walls. Match warm Rome palette (ochre, grass green) with neighbouring painted tiles — no grey washed band.",
    },
    // verified 2026-11-12: Wikidata Q180212 P625
    { name: "Foro Romano", lat: 41.8922, lon: 12.4852, minPx: 0.1, groundMsl: 18 },
    {
      // Nominatim Vittoriano
      // verified 2026-11-12: OSM relation 1849830 centroid
      frontBearing: 344, paintRadiusM: 140, name: "Altare della Patria", lat: 41.894425, lon: 12.482765, minPx: 0.08, groundMsl: 24,
      paintHint: "Altare della Patria / Vittoriano (keep OSM footprint): principal stairway faces north/northwest toward Piazza Venezia (upper-left on screen); rear is toward the Capitoline hill, lower-right; never rotate it to show the front. dazzling WHITE marble monument only — grand staircase facing Piazza Venezia, Corinthian colonnade, bronze equestrian statue, quadrigae on the propylaea. Piazza Venezia in front must stay OPEN asphalt/plaza (no apartment blocks in front of the stairs). Do NOT glue tan residential buildings into the monument sides — the wings are white marble too, not ochre flats.",
    },
    {
      // verified 2026-11-12: OSM way 8035487 centroid
      name: "Castel Sant'Angelo", lat: 41.903073, lon: 12.466347, minPx: 0.08, groundMsl: 12,
      paintHint: "Castel Sant'Angelo: cylindrical Hadrian mausoleum fortress in travertine/brick with ramparts and statue on top.",
    },
    {
      // verified 2026-11-12: OSM way 117968816 (Cupola) centroid
      name: "San Pietro", lat: 41.902161, lon: 12.453373, minPx: 0.06, groundMsl: 26,
      paintHint: "St Peter's Basilica: huge dome, facade with columns, Maderno facade — Vatican landmark.",
    },
    // verified 2026-11-12: Wikidata Q545404 P625
    { name: "Isola Tiberina", lat: 41.890833, lon: 12.477222, minPx: 0.12, groundMsl: 6 },
    { name: "Trastevere", lat: 41.891159, lon: 12.466846, minPx: 0.1, groundMsl: 20 },
    // verified 2026-11-12: OSM way 23276946 (station building) centroid
    { name: "Termini", lat: 41.901184, lon: 12.501666, minPx: 0.08, groundMsl: 55 },
    { name: "Villa Borghese", lat: 41.914411, lon: 12.484844, minPx: 0.08, groundMsl: 49 },
    { name: "Piazza del Popolo", lat: 41.910748, lon: 12.476365, minPx: 0.1, groundMsl: 18 },
    { name: "Campo de' Fiori", lat: 41.895577, lon: 12.472159, minPx: 0.14, groundMsl: 23 },
  ],
};

/** Legacy-world fallback; geoid is added exactly once, shared with paint. */
export const landmarkPixel = (lm: Landmark): [number, number] => llhToPixel(lm.lat, lm.lon, SEA_H + (lm.groundMsl ?? 16));
