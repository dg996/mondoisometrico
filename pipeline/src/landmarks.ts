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
    {
      // OSM way 134400816 (area:highway=steps) centroid
      frontBearing: 225, paintRadiusM: 70, name: "Scalinata di Trinità dei Monti", lat: 41.905992, lon: 12.482784, minPx: 0.12, groundMsl: 30,
      paintHint: "Spanish Steps / Scalinata di Trinità dei Monti (follow the exact outline and slope in image 1): a wide Baroque travertine staircase of 135 steps climbing from Piazza di Spagna (south-west, with the Barcaccia boat-shaped fountain at its foot) up to the twin-belltower church of Trinità dei Monti and its obelisk at the top (north-east); balustrades, landings and azaleas on the flights. Never a flat square.",
    },
    {
      // OSM relation 2709954 centroid
      paintRadiusM: 55, name: "Mausoleo di Augusto", lat: 41.906015, lon: 12.476425, minPx: 0.14, groundMsl: 18,
      paintHint: "Mausoleum of Augustus (follow the exact circular OSM footprint): a huge round ruined drum of brick and travertine, concentric ring walls stepping inwards, grass and cypresses on the upper rings, set in the sunken restored Piazza Augusto Imperatore. It is NOT a round apartment block and has NO tiled roof.",
    },
    {
      // OSM way 201293294 centroid
      frontBearing: 250, paintRadiusM: 45, name: "Museo dell'Ara Pacis", lat: 41.906144, lon: 12.475459, minPx: 0.16, groundMsl: 18,
      paintHint: "Museo dell'Ara Pacis (Richard Meier, 2006): a modern white travertine and glass pavilion with a flat roof and a long glass hall facing the Lungotevere (west), enclosing the marble altar. NOT a Roman palazzo, NO tiled roof.",
    },
    {
      // OSM way 23055100 (place=square) centroid
      frontBearing: 315, paintRadiusM: 60, name: "Campidoglio", lat: 41.893287, lon: 12.482975, minPx: 0.12, groundMsl: 40,
      paintHint: "Piazza del Campidoglio (Michelangelo): trapezoidal piazza on the Capitoline hill with the oval star-pattern pavement and the equestrian statue of Marcus Aurelius at its centre, Palazzo Senatorio with its bell tower at the back, the twin Palazzi dei Conservatori and Nuovo on the sides; the Cordonata ramp-stairs descend north-west to Piazza d'Aracoeli. Follow the exact footprints.",
    },
    {
      // OSM relation 3376015 centroid
      paintRadiusM: 25, name: "Colonna Traiana", lat: 41.895792, lon: 12.484268, minPx: 0.16, groundMsl: 18,
      paintHint: "Trajan's Column: a single tall slender marble column (about 35 m) with a spiral relief band, a bronze statue on top, standing in the excavated Forum of Trajan next to two domed churches. Draw it as a thin tall column, not a tower or a building.",
    },
    {
      // OSM relation 13353039 centroid
      paintRadiusM: 70, name: "Mercati di Traiano", lat: 41.895427, lon: 12.486011, minPx: 0.12, groundMsl: 25,
      paintHint: "Trajan's Markets: a large semicircular brick complex of ancient shops in tiers, cut into the hill above the excavated Forum of Trajan (columns, fragments, grass), with the medieval brick Torre delle Milizie behind. Exposed Roman brick, not plastered palazzi.",
    },
    {
      // OSM relation 11384819 centroid
      paintRadiusM: 260, name: "Circo Massimo", lat: 41.886080, lon: 12.485579, minPx: 0.06, groundMsl: 15,
      paintHint: "Circus Maximus: the long grassy valley of the ancient chariot-racing stadium, an elongated oval track of grass and paths with a raised central spina line, between the Palatine ruins and the Aventine; NO buildings inside the oval.",
    },
    {
      // OSM way 86217821 centroid
      paintRadiusM: 50, name: "Teatro di Marcello", lat: 41.891957, lon: 12.479704, minPx: 0.14, groundMsl: 15,
      paintHint: "Theatre of Marcellus: an ancient Roman theatre with a curved two-storey facade of travertine arches (Doric and Ionic orders) topped by a Renaissance palazzo, standing beside three columns of the Temple of Apollo Sosianus in an open archaeological lawn.",
    },
    {
      // OSM way 120854225 centroid
      frontBearing: 280, paintRadiusM: 35, name: "Bocca della Verità", lat: 41.888118, lon: 12.481702, minPx: 0.16, groundMsl: 15,
      paintHint: "Santa Maria in Cosmedin: a small brick Romanesque church with a tall slender brick bell tower and a porch on its west front (the Bocca della Verità is under the porch), facing the open Piazza Bocca della Verità with the round Temple of Hercules and the Temple of Portunus.",
    },
    {
      // OSM way 131564482 centroid
      frontBearing: 135, paintRadiusM: 90, name: "Santa Maria Maggiore", lat: 41.897595, lon: 12.498457, minPx: 0.1, groundMsl: 55,
      paintHint: "Basilica di Santa Maria Maggiore: a huge basilica with a Baroque loggia facade facing south-east onto its piazza (with a tall column), the tallest Romanesque bell tower in Rome, two domes at the sides, the curved rear facade and an obelisk to the north-west. Travertine and plaster, terracotta roofs.",
    },
    {
      // OSM relation 36444 centroid
      frontBearing: 100, paintRadiusM: 110, name: "San Giovanni in Laterano", lat: 41.885761, lon: 12.505622, minPx: 0.08, groundMsl: 45,
      paintHint: "Archbasilica of San Giovanni in Laterano: a vast basilica whose giant white travertine facade with 15 colossal statues on the top faces east onto Piazza di Porta San Giovanni; the Lateran palace and the tallest obelisk of Rome on the north side, the Baptistery octagon behind.",
    },
    {
      // OSM relation 13476232 centroid
      paintRadiusM: 160, name: "Terme di Caracalla", lat: 41.878885, lon: 12.492404, minPx: 0.08, groundMsl: 20,
      paintHint: "Baths of Caracalla: enormous ruined brick halls without roofs, tall broken walls and arches, mosaic floor fragments, set in a large green park with umbrella pines. Exposed Roman brick ruins, NOT roofed buildings.",
    },
    {
      // OSM way 432946457 centroid
      paintRadiusM: 25, name: "Piramide Cestia", lat: 41.876456, lon: 12.480856, minPx: 0.14, groundMsl: 18,
      paintHint: "Pyramid of Cestius: a steep white marble pyramid (about 36 m) built into the Aurelian walls next to Porta San Paolo. Clean pointed pyramid, white stone.",
    },
    { name: "Piazza del Popolo", lat: 41.910748, lon: 12.476365, minPx: 0.1, groundMsl: 18 },
    { name: "Campo de' Fiori", lat: 41.895577, lon: 12.472159, minPx: 0.14, groundMsl: 23 },
  ],
};

/** Legacy-world fallback; geoid is added exactly once, shared with paint. */
export const landmarkPixel = (lm: Landmark): [number, number] => llhToPixel(lm.lat, lm.lon, SEA_H + (lm.groundMsl ?? 16));
