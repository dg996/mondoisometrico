/**
 * Roman look of the 3D render (region roma-centro): what kind of building a footprint is, its plaster
 * and roof colours, its fallback height and roof. The render is only the paint step's guide, but the
 * paint keeps the render's colours and massing, so Tel Aviv's white Bauhaus and glass towers here
 * turned into Tel Aviv in Rome.
 *
 * Style indices (shared with page/renderer.ts):
 *   4 shed · 6 palazzo storico (inside the Aurelian walls: plaster, tall shuttered windows, cornice,
 *   terracotta hipped roof) · 7 palazzina novecento (outside the walls: lighter plaster, balcony bands)
 *   8 travertino (churches, basilicas, monuments)
 */

type P2 = [number, number];

/**
 * Mura Aureliane (plus the Gianicolo walls round Trastevere and the Leonine/Vatican walls round Borgo),
 * coarse outline through the gates, lat/lon. Prati, Flaminio, San Lorenzo and Testaccio-outside lie
 * beyond it. Good to ~50 m: it only switches a building's style, it is never drawn.
 */
export const AURELIAN_WALLS: Array<[number, number]> = [
  [41.9115, 12.4764], // Porta del Popolo
  [41.9118, 12.4800], // Muro Torto
  [41.9089, 12.4887], // Porta Pinciana
  [41.9104, 12.4985], // Porta Salaria
  [41.9095, 12.5013], // Porta Pia
  [41.9068, 12.5076], // Castro Pretorio
  [41.8990, 12.5098], // Porta Tiburtina
  [41.8915, 12.5155], // Porta Maggiore
  [41.8877, 12.5155], // Anfiteatro Castrense
  [41.8838, 12.5089], // Porta San Giovanni
  [41.8790, 12.5010], // Porta Metronia
  [41.8745, 12.5000], // Porta Latina
  [41.8734, 12.5017], // Porta San Sebastiano
  [41.8720, 12.4925], // Porta Ardeatina
  [41.8762, 12.4807], // Porta San Paolo
  [41.8786, 12.4718], // Tevere a Testaccio
  [41.8828, 12.4735], // Porta Portese
  [41.8846, 12.4627], // Porta San Pancrazio
  [41.8960, 12.4600], // Mura Gianicolensi
  [41.9005, 12.4590], // Porta Cavalleggeri
  [41.9065, 12.4535], // Mura Vaticane
  [41.9068, 12.4600], // Porta Angelica
  [41.9045, 12.4660], // Borgo / Castel Sant'Angelo
  [41.9040, 12.4680], // Tevere a Ponte Sant'Angelo
  [41.9105, 12.4728], // Tevere a Ponte Margherita
];

export const ROMA_STYLE = { shed: 4, palazzo: 6, palazzina: 7, travertino: 8 } as const;

/** [hex, weight]: ocra, giallo romano, rosso pompeiano, rosa, avorio, arancio, sabbia. */
const PALAZZO_WALLS: Array<[string, number]> = [
  ["#d6a056", 18], ["#e2b65e", 16], ["#b0503a", 10], ["#dea296", 11], ["#ebdfc3", 14],
  ["#cf8a4f", 10], ["#e5c693", 12], ["#c9774c", 6], ["#d9b27c", 8],
];
const PALAZZINA_WALLS: Array<[string, number]> = [
  ["#e8d7b5", 16], ["#d8c3a0", 14], ["#e6b98f", 12], ["#cfc6b8", 10], ["#ece3d1", 14],
  ["#d49c78", 8], ["#e1c9a3", 10], ["#c7b49a", 6],
];
// muted, weathered coppi (the paint palette QA wants "muted terracotta", not orange)
const COPPI: Array<[string, number]> = [["#a8674c", 26], ["#9a5d45", 22], ["#b27a5f", 20], ["#8e5a47", 12], ["#a9806a", 10], ["#b5704f", 10]];
const TRAVERTINO = "#ddd3bc", TRAVERTINO_ROOF = "#ad6544", TERRACE = "#c9bca8";

function pick(list: Array<[string, number]>, u: number) {
  let h = u * list.reduce((t, c) => t + c[1], 0);
  for (const [c, w] of list) if ((h -= w) < 0) return c;
  return list[0][0];
}

const WORSHIP = ["cathedral", "church", "basilica", "chapel", "temple", "mosque", "synagogue", "monastery", "convent"];
/** historic structures that are stone, never a plastered palazzo with a coppi roof */
const STONE = ["tomb", "mausoleum", "ruins", "archaeological_site", "monument", "memorial", "city_gate", "citywalls",
  "castle", "aqueduct", "temple", "tower", "pilar", "fort", "bridge"];
/** modern landmarks the 2002 survey / OSM tags don't date: by name (verified buildings) */
const MODERN_NAMES = /^(Museo dell'Ara Pacis|MAXXI|Auditorium Parco della Musica|Nuvola|Centro Congressi La Nuvola)/i;

export interface RomanLook {
  style: number;
  wallColor: string;
  roofColor: string;
  /** hipped tiled roof height (m) when OSM has no roof:shape; 0 = flat terrace */
  roof: number;
  /** storey height used for building:levels */
  floor: number;
}

/** Station buildings at least this large (m², one outer ring) are flat-roofed halls and wings. */
export const BIG_STATION_M2 = 5000;

/**
 * Roman look of an OSM building. `historic` = inside the Aurelian walls. `u` is a stable per-building
 * random number in [0, 1) so colours vary from building to building but never between renders.
 */
export function romanLook(t: Record<string, string>, historic: boolean, landmark: boolean, u: number, u2: number, footprintM2 = 0): RomanLook {
  if (["shed", "garage", "garages", "kiosk", "roof", "carport", "hut"].includes(t.building))
    return { style: ROMA_STYLE.shed, wallColor: "#c9c0b0", roofColor: "#a8a196", roof: 0, floor: 3 };
  const worship = WORSHIP.includes(t.building) || t.amenity === "place_of_worship";
  // modern buildings (built 1950+, tagged modern/contemporary, or a verified modern landmark): white
  // travertine and glass, flat roofs — not Roman plaster (Ara Pacis museum, MAXXI, Auditorium)
  const year = parseInt(t.start_date ?? t["building:start_date"] ?? "", 10);
  // large station buildings are flat-roofed halls and wings (Termini's 1950 front and Mazzoni wings, Ostiense,
  // Tiburtina), not palazzi under coppi; small stations keep the city look and a tagged roof:shape still wins
  const bigStation = t.building === "train_station" && footprintM2 >= BIG_STATION_M2;
  if (!worship && (bigStation || year >= 1950 || /modern|contemporary/i.test(t["building:architecture"] ?? "") || MODERN_NAMES.test(t.name ?? "")))
    return { style: ROMA_STYLE.palazzina, wallColor: "#ebe8e0", roofColor: "#d6d2c8", roof: 0, floor: 3.4 };
  // medieval towers and tower houses are brick (Torre delle Milizie, Torre dei Conti, Torre del Papito)
  if (t.historic === "tower" || t.historic === "tower_house" || t.man_made === "tower" && t.historic)
    return { style: ROMA_STYLE.travertino, wallColor: "#a96a45", roofColor: "#8e5a40", roof: 0, floor: 4 };
  // ancient Roman remains (Servian Wall at Termini: historic=yes) are stone, never a plastered palazzo
  if (landmark || worship || STONE.includes(t.historic) || t["historic:civilization"] === "ancient_roman")
    // churches: coppi over the nave; monuments (Colosseo, arches, mausolea): stone tops, not roof tiles
    return { style: ROMA_STYLE.travertino, wallColor: TRAVERTINO, roofColor: worship ? TRAVERTINO_ROOF : "#cbbfa6", roof: worship ? 3.5 : 0, floor: 4.5 };
  if (historic)
    return { style: ROMA_STYLE.palazzo, wallColor: pick(PALAZZO_WALLS, u), roofColor: pick(COPPI, u2), roof: 3, floor: 3.6 };
  // novecento: mostly flat terraces, a third with a low tiled roof
  const tiled = u2 < 0.35;
  return { style: ROMA_STYLE.palazzina, wallColor: pick(PALAZZINA_WALLS, u), roofColor: tiled ? pick(COPPI, u) : TERRACE, roof: tiled ? 2 : 0, floor: 3.2 };
}

/** Height (m, eaves + roof) of a Roman building without height or building:levels. */
export function romanFallbackHeight(area: number, historic: boolean, u: number) {
  if (historic) return area < 80 ? 10 + u * 3 : area < 160 ? 14 + u * 3 : 18 + u * 2.5; // palazzi 18–20.5 m
  return area < 120 ? 10 + u * 3 : 15 + u * 4; // palazzine 15–19 m
}

export function insideRing([x, y]: P2, poly: P2[]) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}
