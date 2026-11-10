/** Traffic geometry uses the same ENU terrain and OSM water polygons as the renderer. */
export interface TerrainMeta { x0: number; y0: number; nx: number; ny: number; step: number }
export type Point = [number, number];
/** Height-pass value and query height are both ellipsoid metres. Bridges have their own deck;
 * ordinary roads also need a surface beneath them, not only the absence of an occluder. */
export function roadSurfaceSafe(surface: number | null, height: number, requireSupport: boolean): boolean {
  return surface !== null && Number.isFinite(surface) && Number.isFinite(height)
    && surface <= height + 1 && (!requireSupport || surface >= height - 1.5);
}
export function groundAt(m: TerrainMeta, h: Float32Array, x: number, y: number): number | null {
  const fx = (x-m.x0)/m.step, fy = (y-m.y0)/m.step;
  if (fx < 0 || fy < 0 || fx >= m.nx-1 || fy >= m.ny-1) return null;
  const ix = Math.floor(fx), iy = Math.floor(fy), ax = fx-ix, ay = fy-iy, i=iy*m.nx+ix;
  const z = (h[i]*(1-ax)+h[i+1]*ax)*(1-ay)+(h[i+m.nx]*(1-ax)+h[i+m.nx+1]*ax)*ay;
  return Number.isFinite(z) ? z : null;
}
export function inWater(x: number, y: number, polygons: Point[][][]): boolean {
  return polygons.some(rings => {
    let inside = false;
    for (const ring of rings) for(let i=0,j=ring.length-1;i<ring.length;j=i++) {
      const [ax,ay]=ring[i], [bx,by]=ring[j];
      if ((ay>y)!==(by>y) && x<(bx-ax)*(y-ay)/(by-ay)+ax) inside=!inside;
    }
    return inside;
  });
}
export interface SafeWay { y: number; bridge: boolean; s: number[]; water: boolean[] }
const hide = (w: SafeWay) => { for(let k=3;k<w.s.length;k+=4) w.s[k]=0; };
/** Never infer a bridge from a DEM trough. A deck needs an OSM bridge tag and two dry anchors.
 * Unknown/partial/elevated land spans are hidden, pending a reliable deck model.
 */
export function flattenBridgeDecks(ways: SafeWay[]) {
  for(const w of ways) {
    if (!w.bridge && w.y <= 0) continue;
    const n=w.s.length/4;
    if (!w.bridge || n<2 || !w.water.some(Boolean) || w.water[0] || w.water[n-1]) { hide(w); continue; }
    const cum=[0];
    for(let i=1;i<n;i++) cum.push(cum[i-1]+Math.hypot(w.s[i*4]-w.s[(i-1)*4],w.s[i*4+1]-w.s[(i-1)*4+1]));
    const h0=w.s[2], h1=w.s[(n-1)*4+2], len=cum[n-1];
    if (!Number.isFinite(h0+h1+len) || len<=0 || Math.abs(h1-h0)/len>0.15) { hide(w); continue; }
    for(let i=0;i<n;i++) w.s[i*4+2]=Math.round((h0+(h1-h0)*cum[i]/len)*10)/10;
  }
}
/** Water classification supersedes endpoint-height heuristics, which missed short submerged ways
 * and hid perfectly valid downhill streets. No tag means no driving on water, even at equal height.
 */
export function hideBelowBanks(ways: SafeWay[]) {
  for(const w of ways) if (!w.bridge) for(let i=0;i<w.water.length;i++) if(w.water[i]) w.s[i*4+3]=0;
}
