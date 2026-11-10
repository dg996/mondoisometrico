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
      frontBearing: 0, paintRadiusM: 65, name: "Pantheon", lat: 41.898616, lon: 12.476833, minPx: 0.08, groundMsl: 16,
      paintHint: "Pantheon (keep exact OSM footprint and scale): portico on the NORTH side toward Piazza della Rotonda (upper-left in this camera), rotunda behind it to the south/lower-right. Do NOT mirror it or turn the portico toward the viewer. The north facade may be partly hidden by the dome. A huge grey hemispherical concrete dome with a round oculus on top, cylindrical brick drum, triangular pediment portico with tall columns facing the square. Piazza della Rotonda fountain is in front — do NOT paint the Pantheon as a normal terracotta apartment block.",
    },
    { name: "Piazza Navona", lat: 41.898928, lon: 12.473118, minPx: 0.1, groundMsl: 8 },
    {
      // Nominatim Fontana di Trevi
      frontBearing: 165, paintRadiusM: 55, name: "Fontana di Trevi", lat: 41.900978, lon: 12.483285, minPx: 0.1, groundMsl: 8,
      paintHint: "Fontana di Trevi (keep exact OSM scale, do not shrink or relocate): fountain facade on the SOUTH/SOUTHEAST side of Palazzo Poli, facing the basin to lower-right on screen; the palace extends behind it north/upper-left. Palazzo Poli is a WIDE multi-storey palace facade filling the north side of the piazza — Corinthian columns, Oceanus niche with sculpted figures, cascading white water into a large basin that fills most of the square. Do NOT paint it as a tiny fountain model; the palace facade is as tall as neighbouring apartment blocks.",
    },
    {
      // Amphitheatre centroid (not the metro stop ~80 m NW)
      paintRadiusM: 125, name: "Colosseo", lat: 41.89021, lon: 12.492231, minPx: 0.06, groundMsl: 18,
      paintHint: "Colosseum / Colosseo (keep OSM footprint): long axis WNW–ESE (approximately 115/295 degrees geographic, mostly left–right in this camera), not a circular stadium; weathered elliptical travertine amphitheatre with 3–4 tiers of arches, hollow sandy arena, broken outer wall on the south side. Immediate surroundings are archaeological park / open paving and grass — NO modern terracotta apartment blocks glued to the amphitheatre walls. Match warm Rome palette (ochre, grass green) with neighbouring painted tiles — no grey washed band.",
    },
    { name: "Foro Romano", lat: 41.891641, lon: 12.486730, minPx: 0.1, groundMsl: 6 },
    {
      // Nominatim Vittoriano
      frontBearing: 344, paintRadiusM: 140, name: "Altare della Patria", lat: 41.894687, lon: 12.483066, minPx: 0.08, groundMsl: 20,
      paintHint: "Altare della Patria / Vittoriano (keep OSM footprint): principal stairway faces north/northwest toward Piazza Venezia (upper-left on screen); rear is toward the Capitoline hill, lower-right; never rotate it to show the front. dazzling WHITE marble monument only — grand staircase facing Piazza Venezia, Corinthian colonnade, bronze equestrian statue, quadrigae on the propylaea. Piazza Venezia in front must stay OPEN asphalt/plaza (no apartment blocks in front of the stairs). Do NOT glue tan residential buildings into the monument sides — the wings are white marble too, not ochre flats.",
    },
    {
      name: "Castel Sant'Angelo", lat: 41.903118, lon: 12.466343, minPx: 0.08, groundMsl: 18,
      paintHint: "Castel Sant'Angelo: cylindrical Hadrian mausoleum fortress in travertine/brick with ramparts and statue on top.",
    },
    {
      name: "San Pietro", lat: 41.901854, lon: 12.455760, minPx: 0.06, groundMsl: 28,
      paintHint: "St Peter's Basilica: huge dome, facade with columns, Maderno facade — Vatican landmark.",
    },
    { name: "Isola Tiberina", lat: 41.890470, lon: 12.477765, minPx: 0.12, groundMsl: 6 },
    { name: "Trastevere", lat: 41.891159, lon: 12.466846, minPx: 0.1, groundMsl: 6 },
    { name: "Termini", lat: 41.900582, lon: 12.502527, minPx: 0.08, groundMsl: 10 },
    { name: "Villa Borghese", lat: 41.914411, lon: 12.484844, minPx: 0.08, groundMsl: 6 },
    { name: "Piazza del Popolo", lat: 41.910748, lon: 12.476365, minPx: 0.1, groundMsl: 6 },
    { name: "Campo de' Fiori", lat: 41.895577, lon: 12.472159, minPx: 0.14, groundMsl: 6 },
  ],
};

/** Legacy-world fallback; geoid is added exactly once, shared with paint. */
export const landmarkPixel = (lm: Landmark): [number, number] => llhToPixel(lm.lat, lm.lon, SEA_H + (lm.groundMsl ?? 16));
