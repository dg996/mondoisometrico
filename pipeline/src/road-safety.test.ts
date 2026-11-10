import assert from 'node:assert/strict';
import { test } from 'node:test';
import { groundAt, inWater, roadSurfaceSafe, flattenBridgeDecks, hideBelowBanks, type SafeWay } from './road-safety.ts';
const way = (s: number[], water: boolean[], bridge = false): SafeWay => ({s,water,bridge,y:bridge?1:0});
test('terrain uses ground rather than visible roofs; missing data is unknown', () => {
  const m={x0:0,y0:0,nx:2,ny:2,step:10};
  assert.equal(groundAt(m,new Float32Array([50,50,60,60]),5,5),55);
  assert.equal(groundAt(m,new Float32Array(4),20,5),null);
});
test('water polygons respect island holes', () => {
  const p: [number,number][][][]=[[[[0,0],[10,0],[10,10],[0,10]],[[4,4],[6,4],[6,6],[4,6]]]];
  assert.equal(inWater(2,2,p),true); assert.equal(inWater(5,5,p),false);
});
test('two submerged samples are hidden even without an endpoint height difference', () => {
  const w=way([0,0,50,1,2,0,50,1],[true,true]);
  hideBelowBanks([w]); assert.equal(w.s[3]+w.s[7],0);
});
test('untagged trough never becomes a bridge; valid downhill land stays visible', () => {
  const w=way([0,0,60,1,10,0,50,1,20,0,58,1],[false,true,false]);
  flattenBridgeDecks([w]); hideBelowBanks([w]);
  assert.equal(w.y,0); assert.equal(w.s[6],50); assert.equal(w.s[7],0);
  const slope=way([0,0,60,1,50,0,55,1,100,0,50,1],[false,false,false]);
  hideBelowBanks([slope]); assert.equal(slope.s[11],1);
});
test('three-sample bridge uses arc distance and never adds an arbitrary kerb lift', () => {
  const w=way([0,0,60,1,10,0,40,1,100,0,62,1],[false,true,false],true);
  flattenBridgeDecks([w]); assert.equal(w.s[6],60.2); assert.equal(w.s[10],62);
});
test('partial bridges and unsupported elevated ways stay hidden', () => {
  const w=way([0,0,50,1,10,0,60,1],[true,false],true);
  const e=way([0,0,50,1,10,0,50,1],[false,false]); e.y=1;
  flattenBridgeDecks([w,e]); assert.equal(w.s[3]+w.s[7]+e.s[3]+e.s[7],0);
});

test('height-pass support rejects roofs, floating roads, overhangs and missing samples', () => {
  assert.equal(roadSurfaceSafe(60,60,true),true);
  assert.equal(roadSurfaceSafe(75,60,true),false); // foreground roof covers road
  assert.equal(roadSurfaceSafe(54,60,true),false); // no support below an ordinary road
  assert.equal(roadSurfaceSafe(null,60,true),false);
  assert.equal(roadSurfaceSafe(54,60,false),true); // verified OSM bridge has its own deck
  assert.equal(roadSurfaceSafe(70,63.2,false),false); // overhang covers bus roof
});
