import * as THREE from "three";
import type { DeckPoint } from "../src/bridge-profile.ts";

/** Geometry is visible in BOTH colour and height passes, providing real support for traffic.
 * No fabricated arches/piers: their historic shape must come from surveyed OSM geometry. */
export function bridgeMesh(points: DeckPoint[], width:number, pedestrian:boolean) {
  const group=new THREE.Group();
  const strip=(lo:number,hi:number,lift:number,color:number,markings=false)=>{
    const positions:number[]=[];
    let distance=0;
    for(let i=1;i<points.length;i++) {
      const a=points[i-1],b=points[i],length=Math.hypot(b[0]-a[0],b[1]-a[1]);
      if(!length) continue;
      const nx=-(b[1]-a[1])/length,ny=(b[0]-a[0])/length;
      if(!markings || Math.floor(distance/3)%2===0) {
        const q=[[a[0]+nx*lo,a[1]+ny*lo,a[2]+lift],[b[0]+nx*lo,b[1]+ny*lo,b[2]+lift],
          [b[0]+nx*hi,b[1]+ny*hi,b[2]+lift],[a[0]+nx*hi,a[1]+ny*hi,a[2]+lift]];
        for(const v of [0,1,2,0,2,3]) positions.push(...q[v]);
      }
      distance+=length;
    }
    const geometry=new THREE.BufferGeometry(); geometry.setAttribute("position",new THREE.Float32BufferAttribute(positions,3));
    group.add(new THREE.Mesh(geometry,new THREE.MeshBasicMaterial({color,side:THREE.DoubleSide})));
  };
  strip(-width/2-0.6,width/2+0.6,0,0xd9d2c3);
  strip(-width/2,width/2,0.01,pedestrian?0xc8c1b2:0x777a80);
  // parapet top and outer faces; no new mid-span supports invented by the renderer
  for(const side of [-1,1]) {
    strip(side*width/2-0.2,side*width/2+0.2,0.85,0xd9d2c3);
    const vertices:number[]=[];
    for(let i=1;i<points.length;i++) {
      const a=points[i-1],b=points[i],L=Math.hypot(b[0]-a[0],b[1]-a[1]); if(!L)continue;
      const nx=-(b[1]-a[1])/L*side*width/2, ny=(b[0]-a[0])/L*side*width/2;
      const q=[[a[0]+nx,a[1]+ny,a[2]-0.4],[b[0]+nx,b[1]+ny,b[2]-0.4],[b[0]+nx,b[1]+ny,b[2]+0.85],[a[0]+nx,a[1]+ny,a[2]+0.85]];
      for(const v of [0,1,2,0,2,3]) vertices.push(...q[v]);
    }
    const g=new THREE.BufferGeometry();g.setAttribute("position",new THREE.Float32BufferAttribute(vertices,3));
    group.add(new THREE.Mesh(g,new THREE.MeshBasicMaterial({color:0xc7bfae,side:THREE.DoubleSide})));
  }
  if(!pedestrian && width>=7) strip(-0.07,0.07,0.03,0xf2efe6,true);
  return group;
}
