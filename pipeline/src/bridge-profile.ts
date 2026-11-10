import type { Point } from "./road-safety.ts";
export type DeckPoint = [number,number,number];

/** A bridge is a separate surface, not a road texture draped into the river DEM.
 * Use the full OSM way before junction splitting. Short bank extensions allow bank polygons
 * to meet a bridge endpoint without treating that endpoint as the river bed. */
export function bridgeProfile(line: Point[], ground: (x:number,y:number)=>number|null,
  water: (x:number,y:number)=>boolean): DeckPoint[] | null {
  if(line.length<2) return null;
  const anchor=(reverse:boolean):Point|null=>{
    const p=line[reverse?line.length-1:0], q=line[reverse?line.length-2:1];
    const length=Math.hypot(p[0]-q[0],p[1]-q[1]); if(!length) return null;
    for(let d=0;d<=12;d+=2) {
      const a:Point=[p[0]+(p[0]-q[0])/length*d,p[1]+(p[1]-q[1])/length*d];
      if(!water(...a) && ground(...a)!==null) return a;
    }
    return null;
  };
  const first=anchor(false), last=anchor(true); if(!first||!last) return null;
  const points=[first,...line,last].filter((p,i,a)=>i===0||Math.hypot(p[0]-a[i-1][0],p[1]-a[i-1][1])>0.01);
  const samples: Point[]=[];
  for(let i=1;i<points.length;i++) {
    const a=points[i-1], b=points[i], n=Math.ceil(Math.hypot(b[0]-a[0],b[1]-a[1])/2);
    for(let j=0;j<n;j++) samples.push([a[0]+(b[0]-a[0])*j/n,a[1]+(b[1]-a[1])*j/n]);
  }
  samples.push(last);
  if(!samples.some(p=>water(...p))) return null; // land flyovers require surveyed clearance
  const h0=ground(...first)!, h1=ground(...last)!, cum=[0];
  for(let i=1;i<samples.length;i++) cum.push(cum[i-1]+Math.hypot(samples[i][0]-samples[i-1][0],samples[i][1]-samples[i-1][1]));
  const length=cum.at(-1)!;
  if(!Number.isFinite(h0+h1+length)||length<=0||Math.abs(h1-h0)/length>0.15) return null;
  return samples.map((p,i)=>[...p,h0+(h1-h0)*cum[i]/length+0.08]);
}

export function deckHeight(profile: DeckPoint[], x:number,y:number): number|null {
  let closest=Infinity, height:number|null=null;
  for(let i=1;i<profile.length;i++) {
    const a=profile[i-1],b=profile[i],dx=b[0]-a[0],dy=b[1]-a[1],len=dx*dx+dy*dy;
    const t=Math.max(0,Math.min(1,((x-a[0])*dx+(y-a[1])*dy)/len));
    const distance=Math.hypot(x-a[0]-t*dx,y-a[1]-t*dy);
    if(distance<closest && distance<1) {closest=distance;height=a[2]+t*(b[2]-a[2]);}
  }
  return height;
}
