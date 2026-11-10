import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { ROOT } from "./paths.ts";

test("scene CLI preserves inner courtyards and small mapped parts, without tourist-site blocks",()=>{
  const dir=mkdtempSync(join(tmpdir(),"mondo-scene-")),raw=join(dir,"raw/roma-core");mkdirSync(raw,{recursive:true});
  const ring=(x:number,y:number,w:number,h:number)=>[[x,y],[x+w,y],[x+w,y+h],[x,y+h],[x,y]].map(([x,y])=>({lon:12.476+x*0.00001,lat:41.898+y*0.00001}));
  const elements=[
    {type:"relation",id:1,tags:{building:"yes",height:"12",name:"Courtyard house"},members:[
      {type:"way",ref:11,role:"outer",geometry:ring(0,0,60,60)},
      {type:"way",ref:12,role:"inner",geometry:ring(10,10,30,30)}]},
    {type:"way",id:2,tags:{tourism:"attraction",historic:"archaeological_site",name:"Foro"},geometry:ring(80,0,60,60)},
    {type:"way",id:3,tags:{"building:part":"yes",height:"1",name:"Mapped step"},geometry:ring(150,0,2,2)},
  ];
  writeFileSync(join(raw,"osm.json"),JSON.stringify({elements}));writeFileSync(join(raw,"ground.json"),JSON.stringify({elements:[]}));
  try {
    const r=spawnSync(process.execPath,["--import","tsx",join(ROOT,"pipeline/src/scene.ts"),"roma-core"],{env:{...process.env,MONDO_DATA_DIR:dir},encoding:"utf8"});
    assert.equal(r.status,0,r.stderr);
    const scene=join(dir,"derived/roma-core/scene");
    const unique=new Map(readdirSync(scene).flatMap(f=>JSON.parse(readFileSync(join(scene,f),"utf8")).b).map(b=>[JSON.stringify(b),b]));
    assert.equal(unique.size,2);
    const buildings=[...unique.values()];
    assert.ok(buildings.some(b=>b[4].holes.length===1));
    assert.ok(buildings.some(b=>b[4].part && b[1]===1));
  } finally {rmSync(dir,{recursive:true,force:true});}
});
