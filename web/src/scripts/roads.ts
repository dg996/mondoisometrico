import type { Road } from "./traffic.ts";

/** roads.<hash>.json as written by encodeRoads (pipeline/src/export.ts): columnar, delta-coded. */
interface Encoded { v: 2; c: number[]; o: number[]; l: number[]; w: number[]; a: number[]; b: number[]; n: number[]; s: number[]; vis: number[] }

/** Roads in the viewer's shape (one object per way, s = [e, n, u, visible] × samples); the old
 *  roads.json (already that shape) passes through. */
export function decodeRoads(data: Encoded | Road[]): Road[] {
  if (Array.isArray(data)) return data;
  const roads: Road[] = [];
  let p = 0, q = 0; // read positions in s and vis
  for (let i = 0; i < data.n.length; i++) {
    const n = data.n[i], s = new Array<number>(n * 4);
    let e = 0, no = 0, u = 0;
    for (let k = 0; k < n; k++, p += 3) {
      e += data.s[p]; no += data.s[p + 1]; u += data.s[p + 2];
      s[k * 4] = e / 10; s[k * 4 + 1] = no / 10; s[k * 4 + 2] = u / 10;
    }
    const runs = data.vis[q++];
    for (let r = 0, k = 0; r < runs; r++) {
      const len = data.vis[q++], vis = r % 2 === 0 ? 1 : 0;
      for (let j = 0; j < len; j++, k++) s[k * 4 + 3] = vis;
    }
    roads.push({ c: data.c[i], o: data.o[i], l: data.l[i], w: data.w[i], a: data.a[i], b: data.b[i], s });
  }
  return roads;
}
