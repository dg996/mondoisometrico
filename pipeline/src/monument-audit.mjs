// Monument height audit: OSM height vs Regione Lazio CTRN volumes vs Wikidata P2048 (CC0).
// node pipeline/src/monument-audit.mjs <out.json>  (run from the repo root after fetch roma-inner + ctrn)
import fs from "node:fs";
const osm = JSON.parse(fs.readFileSync("data/raw/roma-inner/osm.json"));
const units = JSON.parse(fs.readFileSync("data/raw/ctrn/units.json"));
const inside=([x,y],p)=>{let c=false;for(let i=0,j=p.length-1;i<p.length;j=i++){const[xi,yi]=p[i],[xj,yj]=p[j];if(yi>y!==yj>y&&x<(xj-xi)*(y-yi)/(yj-yi)+xi)c=!c}return c};
const rings = el => el.type==="way" ? [el.geometry.map(q=>[q.lon,q.lat])] : (el.members||[]).filter(m=>m.role==="outer"&&m.geometry).map(m=>m.geometry.map(q=>[q.lon,q.lat]));
const items = osm.elements.filter(e => e.tags?.wikidata && e.tags.building && (e.tags.amenity==="place_of_worship" || e.tags.historic || e.tags.tourism==="attraction" || /^(church|basilica|cathedral|temple|castle|palace|amphitheatre)$/.test(e.tags.building)));
const ids = [...new Set(items.map(e=>e.tags.wikidata))];
const wd = {};
for (let i = 0; i < ids.length; i += 150) {
  const q = `SELECT ?i ?h ?u WHERE { VALUES ?i { ${ids.slice(i,i+150).map(x=>"wd:"+x).join(" ")} } ?i p:P2048/psv:P2048 [wikibase:quantityAmount ?h; wikibase:quantityUnit ?u]. }`;
  const r = await fetch("https://query.wikidata.org/sparql?format=json&query="+encodeURIComponent(q), {headers:{"User-Agent":"mondoisometrico/0.1 (open-data map pipeline)","Accept":"application/sparql-results+json"}});
  for (const b of (await r.json()).results.bindings) if (b.u.value.endsWith("Q11573")) wd[b.i.value.split("/").pop()] = Math.max(wd[b.i.value.split("/").pop()]??0, Number(b.h.value));
}
const rows=[];
for (const e of items) {
  const rs = rings(e).filter(r=>r.length>3); if(!rs.length) continue;
  const bx = rs.flat(); const [w,s,ea,n]=[Math.min(...bx.map(p=>p[0])),Math.min(...bx.map(p=>p[1])),Math.max(...bx.map(p=>p[0])),Math.max(...bx.map(p=>p[1]))];
  const hs = units.filter(u=>u.r.some(p=>p[0]>w&&p[0]<ea&&p[1]>s&&p[1]<n)).filter(u=>{const c=u.r.reduce((a,p)=>[a[0]+p[0]/u.r.length,a[1]+p[1]/u.r.length],[0,0]);return rs.some(r=>inside(c,r))}).map(u=>u.h);
  rows.push({ name:(e.tags.name||"").slice(0,38), wd:e.tags.wikidata, osmH:e.tags.height??"", ctrnMax:hs.length?Math.max(...hs):"", ctrnN:hs.length, wikidataH:wd[e.tags.wikidata]??"" });
}
rows.sort((a,b)=>(Number(b.wikidataH)||0)-(Number(a.wikidataH)||0));
fs.writeFileSync(process.argv[2], JSON.stringify(rows,null,1));
console.log(rows.length, "monuments;", rows.filter(r=>r.wikidataH).length, "with Wikidata height;", rows.filter(r=>r.ctrnN).length, "with CTRN volumes");
console.table(rows.filter(r=>r.wikidataH||r.osmH).slice(0,45));
