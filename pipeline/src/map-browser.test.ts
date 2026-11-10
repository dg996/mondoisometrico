/** Real OpenSeadragon + browser canvas, with a small deterministic world (no R2 or data/). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { build } from "esbuild";
import sharp from "sharp";
import { chromium } from "playwright-core";
import { CHROME, ROOT } from "./paths.ts";
import { join } from "node:path";

test("viewer draws activity only on completed tiles; legacy metadata starts no animations", {skip:process.env.MONDO_BROWSER_TESTS !== "1"}, async()=>{
  const bundle=await build({entryPoints:[join(ROOT,"web/src/scripts/map.ts")],bundle:true,write:false,format:"esm",target:"es2022",
    define:{"import.meta.env.DEV":"true",__TILES_ORIGIN__:'""'}});
  const png=await sharp({create:{width:512,height:512,channels:3,background:"#d4ccbc"}}).png().toBuffer();
  const index:Record<string,Record<string,string>>={7:{"0_0":"a","0_1":"a","1_0":"a","1_1":"a"},8:{}};
  for(let x=0;x<4;x++)for(let y=0;y<4;y++)index[8][`${x}_${y}`]="a";
  let legacy=false;
  const server=createServer((req,res)=>{
    const url=req.url??"/";
    if(url==="/app.js"){res.setHeader("content-type","text/javascript");res.end(bundle.outputFiles[0].text);return;}
    if(url.includes("/tiles/")){res.setHeader("content-type","image/png");res.end(png);return;}
    if(url.includes("/data/")) {
      const world={tile_size:512,native_zoom:8,min_zoom:7,bounds:[[0,0],[2048,2048]],playable:[[0,0],[2048,2048]],origin:[0,0],size:[2048,2048],
        activity:legacy?undefined:{version:1,tileSize:1024,tiles:["0_0"],bounds:[0,0,2048,2048]},landmarks:{Pantheon:[512,512]},
        enu2px:[[1,0,0],[0,1,0]],camera:{headingDeg:40,origin:{lat:41.8986,lon:12.4769}},airport:null,areas:[],layers:{photo:4,art:1},
        files:{"tiles-map":"tiles-map.test.json",roads:"roads.test.json",borders:"borders.test.json"}};
      const roads=[{a:1,b:2,c:1,l:1,o:0,w:7,s:Array.from({length:901},(_,i)=>[i*2,500,65,1]).flat()}];
      const body=url.includes("world.json")?world:url.includes("roads")?roads:url.includes("tiles-map")?index:url.includes("tiles.json")?{map:index}:[];
      res.setHeader("content-type","application/json");res.end(JSON.stringify(body));return;
    }
    res.setHeader("content-type","text/html");res.end('<body data-city="roma" data-region="roma-centro"><style>body{margin:0}#map{position:fixed;inset:0;background:#e8e4dc}#overlay{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}</style><div id="map"></div><div id="credits"></div><script type="module" src="/app.js"></script></body>');
  });
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  const browser=await chromium.launch({executablePath:CHROME,headless:true,args:["--no-sandbox","--disable-dev-shm-usage"]}).catch(async e=>{await new Promise<void>(r=>server.close(()=>r()));throw e;});
  try {
    const page=await browser.newPage({viewport:{width:1000,height:700}}),errors:string[]=[];
    page.on("pageerror",e=>errors.push(e.message));
    const url=`http://127.0.0.1:${(server.address() as any).port}/#@900,512,1.1`;
    await page.goto(url);
    await page.waitForFunction(()=>!!(window as any).__traffic?.count);
    const result=await page.evaluate(()=>{
      const w=window as any,T=w.__traffic;
      for(let i=0;i<300;i++)T.step(0.1);
      const canvas=document.getElementById("overlay") as HTMLCanvasElement, ctx=canvas.getContext("2d")!;
      const item=w.__viewer.world.getItemAt(0),vp=w.__viewer.viewport;
      const p=vp.viewportToViewerElementCoordinates(item.imageToViewportCoordinates(1080,20,true));
      const pixels=ctx.getImageData(Math.max(0,Math.ceil(p.x)),0,Math.max(1,canvas.width-Math.ceil(p.x)),canvas.height).data;
      return {cars:T.count,ways:T.ways.length,escape:T.ways.some((r:any)=>r.r.s.some((v:number,i:number)=>i%4===0&&v>=1024)),
        outside:pixels.some((v,i)=>i%4===3 && v>0),planes:w.__planes,parrots:w.__parrots};
    });
    assert.ok(result.cars>0);assert.equal(result.escape,false);assert.equal(result.outside,false);
    assert.equal(result.planes,null);assert.equal(result.parrots,null);assert.deepEqual(errors,[]);
    legacy=true;await page.goto(url);await page.waitForFunction(()=>!!(window as any).__world);
    // Run the actual delayed initializer without six seconds of wall-clock waiting.
    await page.evaluate(()=>{(window as any).__viewer.world.getItemAt(0).raiseEvent("fully-loaded-change");});
    assert.equal(await page.evaluate(()=>Boolean((window as any).__traffic)),false);
  } finally {await browser.close();await new Promise<void>((resolve,reject)=>server.close(err=>err?reject(err):resolve()));}
});
