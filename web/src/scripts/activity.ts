import type { Road } from "./traffic.ts";

/** Exported from actual painted tile keys, never inferred from a rectangular bounding box. */
export interface ActivityCoverage {
  version: 1;
  tileSize: number;
  tiles: string[];
  bounds: [number, number, number, number];
}

export class ActivityMask {
  readonly rects: Array<[number, number, number, number]> = [];
  private keys = new Set<string>();
  constructor(private coverage?: ActivityCoverage) {
    if (!coverage || coverage.version !== 1 || !(coverage.tileSize > 0)
      || !coverage.bounds.every(Number.isFinite)) return;
    const [x0, y0, x1, y1] = coverage.bounds, t = coverage.tileSize;
    for (const key of coverage.tiles) {
      if (!/^-?\d+_-?\d+$/.test(key)) continue;
      const [x, y] = key.split("_").map(Number);
      const r: [number, number, number, number] = [Math.max(x0, x*t), Math.max(y0, y*t), Math.min(x1, (x+1)*t), Math.min(y1, (y+1)*t)];
      if (r[2] > r[0] && r[3] > r[1]) { this.keys.add(key); this.rects.push(r); }
    }
  }
  containsRect(x0: number, y0: number, x1 = x0, y1 = y0) {
    if (!this.keys.size || ![x0,y0,x1,y1].every(Number.isFinite)) return false;
    const c = this.coverage!, b = c.bounds, t = c.tileSize;
    if (x0 < b[0] || y0 < b[1] || x1 >= b[2] || y1 >= b[3]) return false;
    for (let y = Math.floor(y0/t); y <= Math.floor(y1/t); y++)
      for (let x = Math.floor(x0/t); x <= Math.floor(x1/t); x++)
        if (!this.keys.has(`${x}_${y}`)) return false;
    return true;
  }
}

/** longest stretch hidden in the view (m) that vehicles still drive through, unseen */
export const MAX_HIDDEN = 45;
/** hidden runs shorter than this (m), between visible samples, are speckle of the occlusion test (a
 *  lamp post, a parapet statue, one noisy height pixel): they cannot hide a car, so they count as seen */
export const MIN_COVER = 6;

/** In place: clear hidden runs shorter than MIN_COVER that have visible samples on both sides. */
export function despeckle(S: number[]) {
  const n = S.length / 4;
  for (let i = 1; i < n; i++) {
    if (S[i * 4 + 3] || !S[(i - 1) * 4 + 3]) continue;
    let j = i;
    while (j < n && !S[j * 4 + 3]) j++;
    if (j >= n) break; // runs into the way's end: keep
    let len = 0;
    for (let k = i; k <= j; k++) len += Math.hypot(S[k * 4] - S[(k - 1) * 4], S[k * 4 + 1] - S[(k - 1) * 4 + 1]);
    if (len < MIN_COVER) for (let k = i; k < j; k++) S[k * 4 + 3] = 1;
    i = j;
  }
}

/** Split the graph at unsafe intervals, assigning private dead ends at every cut. Checking the
 * whole projected segment (including lane/body/pavement margin) catches holes between samples. */
export function activeRoads(roads: Road[], M: number[][], mask: ActivityMask): Road[] {
  const result: Road[] = [];
  let cut = Math.min(-1, ...roads.flatMap(r => [r.a - 1, r.b - 1]));
  for (const r of roads) {
    if (r.s.length < 8 || r.s.length % 4 || !r.s.every(Number.isFinite)) continue;
    const S = r.s.slice(), n = S.length/4;
    despeckle(S);
    const points = Array.from({length:n}, (_,i) => M.map(row => row.reduce((v,c,j) => v+c*S[i*4+j],0)));
    const radius = (r.w ?? 12)/2 + 5; // sidewalk cats, bus width/height, antialiasing
    const mx = Math.hypot(M[0][0],M[0][1])*radius + Math.abs(M[0][2])*4 + 2;
    const my = Math.hypot(M[1][0],M[1][1])*radius + Math.abs(M[1][2])*4 + 2;
    let start = -1;
    // distance along the way at each sample: zebra positions (r.x) are measured from the way's start
    const cum = new Float64Array(n);
    for (let i = 1; i < n; i++) cum[i] = cum[i-1] + Math.hypot(S[i*4]-S[(i-1)*4], S[i*4+1]-S[(i-1)*4+1]);
    const zebrasIn = (d0: number, d1: number) => {
      if (!r.x?.length) return undefined;
      const x: number[] = [];
      for (let k = 0; k < r.x.length; k += 2) if (r.x[k] + r.x[k+1] > d0 && r.x[k] - r.x[k+1] < d1) x.push(r.x[k] - d0, r.x[k+1]);
      return x.length ? x : undefined;
    };
    const flush = (end: number) => {
      if (start >= 0 && end > start) {
        const piece: Road = {...r, a:start === 0 ? r.a : cut--, b:end === n-1 ? r.b : cut--, s:S.slice(start*4,(end+1)*4)};
        const x = zebrasIn(cum[start], cum[end]);
        if (x) piece.x = x; else delete piece.x;
        result.push(piece);
      }
      start = -1;
    };
    // per segment: sound geometry inside the painted area (geo), and in view (vis)
    const geo = new Uint8Array(n), vis = new Uint8Array(n), seg = new Float64Array(n);
    for (let i=1;i<n;i++) {
      const a=points[i-1], b=points[i];
      const len=Math.hypot(S[i*4]-S[(i-1)*4], S[i*4+1]-S[(i-1)*4+1]);
      seg[i] = len;
      geo[i] = +(len>0 && len<=6.1
        && Math.abs(S[i*4+2]-S[(i-1)*4+2])<=Math.min(2.2,len*0.2)
        && mask.containsRect(Math.min(a[0],b[0])-mx, Math.min(a[1],b[1])-my,
          Math.max(a[0],b[0])+mx, Math.max(a[1],b[1])+my));
      vis[i] = +(S[(i-1)*4+3] === 1 && S[i*4+3] === 1);
    }
    // A short stretch hidden in the view (a tree crown over the kerb, a building corner, a parapet)
    // stays drivable: vehicles pass behind it unseen (traffic.ts / trams.ts fade them out and in by
    // their distance to it) and come out on the other side, instead of vanishing at the cover and
    // popping up somewhere else. Long hidden runs (whole lanes behind blocks) are still cut.
    const ok = new Uint8Array(n);
    for (let i=1;i<n;) {
      if (!geo[i]) { i++; continue; }
      if (vis[i]) { ok[i] = 1; i++; continue; }
      let j = i, run = 0;
      while (j < n && geo[j] && !vis[j]) run += seg[j++];
      if (run <= MAX_HIDDEN) for (let k = i; k < j; k++) ok[k] = 1;
      i = j;
    }
    for (let i=1;i<n;i++) { if (ok[i]) { if (start<0) start=i-1; } else flush(i-1); }
    flush(n-1);
  }
  return result;
}
