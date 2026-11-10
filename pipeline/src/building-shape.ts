export type Footprint = Array<[number,number]>;
export interface BuildingDetail {
  holes?: Footprint[];
  minHeight?: number;
  roofShape?: string;
  roofHeight?: number;
  roofDirection?: number;
  roofAcross?: boolean;
  wallColor?: string;
  roofColor?: string;
  part?: boolean;
}
export type SceneBuilding = [Footprint, number, number, number|null, BuildingDetail?];

export function hasCompleteParts(ring:Footprint, parts:Footprint[], inside:(p:[number,number],r:Footprint)=>boolean) {
  const xs=ring.map(p=>p[0]),ys=ring.map(p=>p[1]),x0=Math.min(...xs),x1=Math.max(...xs),y0=Math.min(...ys),y1=Math.max(...ys);
  const candidates=parts.filter(p=>p.some(v=>v[0]>=x0 && v[0]<=x1 && v[1]>=y0 && v[1]<=y1));
  if(!candidates.length) return false;
  let total=0,covered=0;
  for(let y=0;y<12;y++) for(let x=0;x<12;x++) {
    const p:[number,number]=[x0+(x+0.5)/12*(x1-x0),y0+(y+0.5)/12*(y1-y0)];
    if(!inside(p,ring)) continue;
    total++; if(candidates.some(r=>inside(p,r))) covered++;
  }
  return total>0 && covered/total>=0.7;
}

/** A tourist site boundary is not a solid building. Ruins without surveyed heights stay low. */
export function osmSolid(t: Record<string,string>) {
  if (t.location === "underground" || t.building === "no" || t.building === "roof") return false;
  return !!(t.building || (t["building:part"] && t["building:part"] !== "no")
    || t.amenity === "fountain" || t.historic === "monument" || t.historic === "memorial");
}

/** Surface height above the eaves; geographic footprint remains unrotated. */
export function roofRise(x:number,y:number,ring:Footprint,shape:string,height:number,direction?:number,across=false) {
  if (!['dome','gabled','skillion','hipped','pyramidal'].includes(shape)) return height;
  const cx=ring.reduce((s,p)=>s+p[0],0)/ring.length, cy=ring.reduce((s,p)=>s+p[1],0)/ring.length;
  if(shape === "dome") {
    const rx=(Math.max(...ring.map(p=>p[0]))-Math.min(...ring.map(p=>p[0])))/2;
    const ry=(Math.max(...ring.map(p=>p[1]))-Math.min(...ring.map(p=>p[1])))/2;
    return height*Math.sqrt(Math.max(0,1-((x-cx)/rx)**2-((y-cy)/ry)**2));
  }
  let angle=direction === undefined ? 0 : direction*Math.PI/180;
  if(direction === undefined) {
    let longest=0;
    for(let i=0;i<ring.length;i++) {const a=ring[i],b=ring[(i+1)%ring.length],L=Math.hypot(b[0]-a[0],b[1]-a[1]);
      if(L>longest){longest=L; angle=Math.atan2(b[0]-a[0],b[1]-a[1])+(across?Math.PI/2:0);}}
  }
  const projected=ring.map(p=>(p[0]-cx)*Math.cos(angle)-(p[1]-cy)*Math.sin(angle));
  const lo=Math.min(...projected),hi=Math.max(...projected),v=(x-cx)*Math.cos(angle)-(y-cy)*Math.sin(angle);
  const f=(v-lo)/(hi-lo||1);
  return height*Math.max(0,shape === "skillion" ? f : 1-Math.abs(2*f-1));
}
