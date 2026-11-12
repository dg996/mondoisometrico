/**
 * Road widths from OSM tags, shared by the ground drawing (ground.ts) and the traffic export
 * (export.ts) so simulated cars drive exactly on the asphalt that was drawn.
 */

/** default carriageway width (m), has pavements */
export const ROAD: Record<string, [number, boolean]> = {
  motorway: [11, false], trunk: [10, false], primary: [13, true], secondary: [10, true], tertiary: [8, true],
  motorway_link: [5, false], trunk_link: [5, false], primary_link: [5, true], secondary_link: [5, true], tertiary_link: [5, true],
  unclassified: [6.5, true], residential: [6.5, true], living_street: [5, true], service: [4, false], road: [6, true],
  busway: [7, true], track: [3, false], raceway: [8, false],
};

export const isOneway = (t: Record<string, string>) =>
  t.oneway === "yes" || t.oneway === "-1" || t.junction === "roundabout" || t.highway === "motorway";

/** Carriageway width (m) of a drivable OSM way, or 0 if it isn't one. */
export function roadWidth(t: Record<string, string>): number {
  const road = ROAD[t.highway];
  if (!road) return 0;
  const lanes = Number(t.lanes) || 0;
  const w = Number(String(t.width).replace(",", "."));
  return w > 1 && w < 60 ? w : lanes ? lanes * 3.3 : road[0] * (isOneway(t) && road[0] > 7 ? 0.6 : 1);
}

/** Lanes in the way's direction(s): total for one-way, per direction otherwise. */
export function roadLanes(t: Record<string, string>): number {
  const w = roadWidth(t), n = Number(t.lanes) || Math.max(1, Math.round(w / 3.3));
  return isOneway(t) ? Math.max(1, n) : Math.max(1, Math.floor(n / 2));
}

/**
 * A way that is not on the open surface: metro and rail tunnels, road tunnels and underpasses,
 * negative layer/level, indoor corridors, location=underground. Drawing them on the ground painted
 * metro lines and station corridors across the city as streets.
 *
 * Archways stay drawn: the street runs on at ground level and the building above hides it. Rome maps
 * them as tunnel=building_passage, but also as covered=yes, or as a few metres of tunnel=yes /
 * covered=yes with layer=-1 under a palazzo; hiding those broke streets at every arch. So covered alone
 * is surface, and a short (< 40 m) tunnel/covered stretch of an ordinary street is an archway.
 */
export function belowSurface(t: Record<string, string>, lengthM = Infinity): boolean {
  const neg = (v: string | undefined) => !!v && String(v).split(";").every((s) => Number(s) < 0);
  // Rome also maps archways as layer=-1 + tunnel/covered on a few metres of street under a palazzo
  // (Vicolo dei Granari, Via dell'Arco de' Cenci). Pedestrian underpasses (footway/steps) and real
  // road underpasses (long, or major roads) stay below.
  const ARCH_STREETS = /^(service|residential|living_street|pedestrian|unclassified|tertiary|track)$/;
  if (t.highway && ARCH_STREETS.test(t.highway) && !t.railway && lengthM < 40 && (t.tunnel || t.covered)
    && (t.layer === "-1" || !t.layer) && !neg(t.level) && !(t.indoor && t.indoor !== "no") && t.location !== "underground") return false;
  if (neg(t.layer) || neg(t.level)) return true;
  if (t.indoor && t.indoor !== "no") return true;
  if (t.location === "underground" || t.location === "indoor") return true;
  if (t.railway === "subway" || t.station === "subway") return true;
  if (t.tunnel && !["no", "building_passage"].includes(t.tunnel)) {
    const archway = t.tunnel === "yes" && !!t.highway && !t.railway && lengthM < 40
      && !/^(motorway|trunk|primary)(_link)?$/.test(t.highway);
    return !archway;
  }
  return false;
}

/** Length (m) of an OSM way's lat/lon geometry. */
export function wayLength(g: Array<{ lat: number; lon: number }>): number {
  let L = 0;
  for (let i = 1; i < g.length; i++)
    L += Math.hypot((g[i].lon - g[i - 1].lon) * 111320 * Math.cos(g[i].lat * Math.PI / 180), (g[i].lat - g[i - 1].lat) * 110574);
  return L;
}
