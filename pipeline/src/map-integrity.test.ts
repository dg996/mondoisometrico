import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { ActivityMask, activeRoads } from "../../web/src/scripts/activity.ts";
import { Traffic, type Road } from "../../web/src/scripts/traffic.ts";
import { bridgeProfile, deckHeight } from "./bridge-profile.ts";
import { overlapDelta, solvePalette } from "./palette.ts";
import { contextTile } from "./context-tiles.ts";
import { osmSolid, hasCompleteParts, roofRise, type Footprint } from "./building-shape.ts";
import { inside } from "./areas.ts";
import { LANDMARKS, landmarkPixel } from "./landmarks.ts";
import { SEA_H } from "./vertical-datum.ts";
import { llhToPixel, useRegion } from "./camera.ts";

const M=[[1,0,0],[0,1,0]];
const road:Road={a:1,b:2,c:1,l:1,o:0,w:6,s:Array.from({length:401},(_,i)=>[i*2-200,50,65,1]).flat()};
test("legacy world without a painted mask fails closed; a painted AABB cannot activate holes",()=>{
  assert.equal(activeRoads([road],M,new ActivityMask()).length,0);
  const mask=new ActivityMask({version:1,tileSize:100,tiles:["-1_0","0_0","2_0","3_0"],bounds:[-100,0,400,100]});
  const runs=activeRoads([road],M,mask);
  assert.equal(runs.length,2);
  assert.notEqual(runs[0].b,runs[1].a);
  assert.ok(runs.every(r=>r.s.every((v,i)=>i%4!==0 || mask.containsRect(v,50))));
  assert.equal(mask.containsRect(10,50,250,50),false);
  const traffic=new Traffic(runs,M,[0,1]) as any;
  let drawn=0;
  traffic.box=(_ctx:unknown,_proj:unknown,p:number[])=>{drawn++; assert.ok(mask.containsRect(p[0]-8,p[1]-8,p[0]+8,p[1]+8));};
  for(let i=0;i<3000;i++){traffic.step(0.1);traffic.draw({},(x:number,y:number)=>[x,y],1,[-500,-500,1000,1000]);}
  assert.ok(drawn>0);
});
test("bridge colour geometry and traffic sample the SAME full-way deck, never the river DEM",()=>{
  const water=(x:number)=>x>0 && x<100, ground=(x:number)=>water(x)?50:65;
  const profile=bridgeProfile([[-2,0],[50,0],[102,0]],ground,water)!;
  assert.ok(profile);
  for(let x=0;x<=100;x+=2) assert.ok(Math.abs(deckHeight(profile,x,0)!-65.08)<1e-8);
  assert.equal(bridgeProfile([[20,0],[80,0]],ground,water),null);
  assert.equal(bridgeProfile([[-20,0],[-10,0]],ground,water),null);
  assert.equal(deckHeight(profile,50,5),null);
});
test("palette correction uses coincident pixels and preserves average colour, not material histograms",()=>{
  const a=new Uint8Array(8*8*3).fill(120),b=new Uint8Array(8*8*3).fill(140);
  assert.deepEqual(overlapDelta(a,b,8,2,false),[-20,-20,-20]);
  const {offsets,residuals}=solvePalette(["a","b","park"],[{a:"a",b:"b",delta:[-20,-10,6]}]);
  assert.ok(residuals[0].error<0.02);
  assert.deepEqual(offsets.get("park"),[0,0,0]);
  for(let c=0;c<3;c++) assert.ok(Math.abs(offsets.get("a")![c]+offsets.get("b")![c])<0.02);
  assert.ok(solvePalette(["a","b"],[{a:"a",b:"b",delta:[100,100,100]}]).residuals[0].error>12);
});
test("context blur stays light and continuous at a tile seam",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"mondo-context-"));
  try {
    const size=128,files=new Map<string,string>();
    for(let x=-1;x<=2;x++) for(let y=-1;y<=1;y++) {
      const path=join(dir,`${x}_${y}.png`);
      await sharp({create:{width:size,height:size,channels:3,background:{r:x<1?100:170,g:130,b:100}}}).png().toFile(path);files.set(`${x}_${y}`,path);
    }
    const left=await sharp(await contextTile(files,0,0,size)).raw().toBuffer();
    const right=await sharp(await contextTile(files,1,0,size)).raw().toBuffer();
    for(let c=0;c<3;c++) assert.ok(Math.abs(left[(64*size+size-1)*3+c]-right[64*size*3+c])<4);
    assert.ok(left.every(v=>v>60),"unfinished context must not turn black");
  } finally {rmSync(dir,{recursive:true,force:true});}
});
test("archaeological site boundaries are not buildings; a single pillar cannot replace a palace",()=>{
  assert.equal(osmSolid({tourism:"attraction",historic:"archaeological_site",name:"Foro Romano"}),false);
  assert.equal(osmSolid({"building:part":"yes",height:"1"}),true);
  const square:Footprint=[[0,0],[100,0],[100,100],[0,100]],pillar:Footprint=[[5,5],[7,5],[7,7],[5,7]];
  assert.equal(hasCompleteParts(square,[pillar],inside),false);
  assert.equal(hasCompleteParts(square,[square],inside),true);
  assert.equal(roofRise(50,50,square,"dome",20),20);
  assert.equal(roofRise(0,50,square,"dome",20),0);
});
test("label fallback adds the geoid once and north-facing landmarks project upper-left",()=>{
  useRegion("roma-centro");
  for(const lm of LANDMARKS.roma) assert.deepEqual(landmarkPixel(lm),llhToPixel(lm.lat,lm.lon,SEA_H+(lm.groundMsl??16)));
  const p=LANDMARKS.roma[0],a=landmarkPixel(p),north=llhToPixel(p.lat+0.0001,p.lon,SEA_H+p.groundMsl!);
  assert.ok(north[0]<a[0] && north[1]<a[1]);
});
