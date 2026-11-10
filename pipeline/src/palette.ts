import sharp from "sharp";

export type RGB = [number,number,number];
export interface PaletteEdge { a: string; b: string; delta: RGB }
const median = (values: number[]) => values.sort((a,b)=>a-b)[Math.floor(values.length/2)] ?? 0;

/** Compare the SAME ground pixels in overlapping windows, not whole-image histograms (which
 * would make a green park beige just because its neighbour contains travertine buildings). */
export function overlapDelta(a: Uint8Array, b: Uint8Array, size: number, overlap: number, vertical: boolean): RGB {
  const differences: number[][] = [[],[],[]];
  for(let v=0;v<size;v++) for(let u=0;u<overlap;u++) {
    const ia=(vertical ? ((size-overlap+u)*size+v) : (v*size+size-overlap+u))*3;
    const ib=(vertical ? (u*size+v) : (v*size+u))*3;
    if ([0,1,2].some(c=>a[ia+c]<12 || b[ib+c]<12 || a[ia+c]>247 || b[ib+c]>247)) continue;
    for(let c=0;c<3;c++) differences[c].push(a[ia+c]-b[ib+c]);
  }
  return differences.map(median) as RGB;
}

/** Solve all neighbouring exposures together. Preserve each connected component's mean colour;
 * never propagate an arbitrary first window's cast across Rome. Large discrepancies fail QA. */
export function solvePalette(keys: string[], edges: PaletteEdge[], limit=24) {
  const offsets = new Map(keys.map(k=>[k,[0,0,0] as RGB]));
  const adj=new Map(keys.map(k=>[k,[] as Array<{key:string; delta:RGB}>]));
  for(const e of edges) {
    adj.get(e.a)!.push({key:e.b,delta:e.delta.map(v=>-v) as RGB});
    adj.get(e.b)!.push({key:e.a,delta:e.delta});
  }
  const components: string[][]=[], seen=new Set<string>();
  for(const key of keys) if(!seen.has(key)) {
    const group=[key]; seen.add(key);
    for(let i=0;i<group.length;i++) for(const n of adj.get(group[i])!) if(!seen.has(n.key)) {seen.add(n.key);group.push(n.key);}
    components.push(group);
  }
  for(let pass=0;pass<400;pass++) {
    let change=0;
    for(const key of keys) {
      const neighbours=adj.get(key)!; if(!neighbours.length) continue;
      const old=offsets.get(key)!, next=old.map((v,c)=>v*0.5+0.5*neighbours.reduce((s,n)=>s+offsets.get(n.key)![c]+n.delta[c],0)/neighbours.length) as RGB;
      change=Math.max(change,...next.map((v,c)=>Math.abs(v-old[c]))); offsets.set(key,next);
    }
    for(const group of components) {
      const mean=[0,1,2].map(c=>group.reduce((s,k)=>s+offsets.get(k)![c],0)/group.length);
      for(const key of group) offsets.set(key,offsets.get(key)!.map((v,c)=>Math.max(-limit,Math.min(limit,v-mean[c]))) as RGB);
    }
    if(change<0.005) break;
  }
  const residuals=edges.map(e=>({a:e.a,b:e.b,error:Math.max(...e.delta.map((v,c)=>Math.abs(v+offsets.get(e.a)![c]-offsets.get(e.b)![c])))}));
  return {offsets,residuals};
}

export async function windowPalette(files: Map<string,string>) {
  const samples=new Map<string,Buffer>();
  for(const [key,file] of files) samples.set(key,await sharp(file).removeAlpha().resize(256,256).blur(1).raw().toBuffer());
  const edges: PaletteEdge[]=[];
  for(const [key,a] of samples) {
    const [x,y]=key.split("_").map(Number);
    for(const [next,vertical] of [[`${x+1}_${y}`,false],[`${x}_${y+1}`,true]] as const) {
      const b=samples.get(next); if(b) edges.push({a:key,b:next,delta:overlapDelta(a,b,256,32,vertical)});
    }
  }
  return solvePalette([...files.keys()].sort(),edges);
}

export function applyPalette(pixels: Uint8Array, offset: RGB) {
  for(let i=0;i<pixels.length;i++) pixels[i]=Math.max(0,Math.min(255,Math.round(pixels[i]+offset[i%3])));
}
