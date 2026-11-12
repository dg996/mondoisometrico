import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Traffic, type Road } from '../../web/src/scripts/traffic.ts';
const road = (height = 60): Road => ({ c: 1, o: 0, l: 1, w: 7, a: 1, b: 2,
  s: Array.from({length: 51}, (_, i) => [i * 2, 0, height, 1]).flat() });
const traffic = (r = road()) => new Traffic([r], [[1,0,0],[0,0,-1]], [0,1]);

test('empty and zero-length networks do not spawn or crash', () => {
  assert.equal(new Traffic([], [], [0,1]).count, 0);
  const r = road(); r.s = [0,0,60,1,0,0,60,1];
  assert.equal(traffic(r).count, 0);
});
test('reverse travel validates the actual end of the road, including the full body', () => {
  const r = road(); r.s[49 * 4 + 3] = 0;
  const t = traffic(r) as any, w = t.ways[0];
  assert.equal(t.sampleVisible(w, 4, 1, 6), true);
  assert.equal(t.sampleVisible(w, 4, -1, 6), false);
  assert.equal(t.sampleVisible(w, 1, 1, 6), false);
});
test('sparse segments and steep height jumps fail closed', () => {
  const r = road(); r.s = [0,0,60,1,50,0,60,1];
  const t = traffic(r) as any;
  assert.equal(t.sampleVisible(t.ways[0], 25, 1, 6), false);
  const r2 = road(); r2.s[25 * 4 + 2] = 70;
  const t2 = traffic(r2) as any;
  assert.equal(t2.sampleVisible(t2.ways[0], 50, 1, 6), false);
});
for (const bus of [false, true]) test(`${bus ? 'bus' : 'car'} polygons all stay at road altitude`, () => {
  const t = traffic() as any;
  assert.ok(t.vehicles.length > 0);
  t.vehicles = [{...t.vehicles[0], off: false, w: 0, s: 50, dir: 1, len: bus ? 13.5 : 6, hei: bus ? 3.2 : 1.65, bus}];
  const ys: number[] = [];
  const ctx = new Proxy({}, {get: (_, k) => k === 'moveTo' || k === 'lineTo' ? (_x: number,y: number) => ys.push(y) : () => {}, set: () => true});
  t.draw(ctx, (x: number,y: number) => [x,y], 1, [-1000,-1000,1000,1000]);
  assert.equal(t.drawn, 1);
  assert.ok(ys.length > 0);
  assert.ok(ys.every(y => y <= -60 && y >= -64), `geometry escaped road: ${Math.min(...ys)}..${Math.max(...ys)}`);
  t.draw(ctx, (x: number,y: number) => [x,y], 0.1, [-1000,-1000,1000,1000]);
  assert.equal(t.drawn, 0);
});
test('five simulated minutes never draw a vehicle over an exported hidden interval', () => {
  const r = road(); for(let i=20;i<=24;i++) r.s[i*4+3]=0;
  const t = traffic(r) as any;
  let drawn = 0;
  // Intercept the real draw path, just before polygon painting, as traffictest inspects positions.
  t.box = (_ctx: unknown,_proj: unknown,c: number[]) => { drawn++; assert.ok(c[0] < 37 || c[0] > 51); };
  for(let i=0;i<3000;i++) {
    t.step(0.1); t.draw({}, (x:number,y:number)=>[x,y],1,[-1000,-1000,1000,1000]);
  }
  assert.ok(drawn > 0, 'test must actually render traffic');
});
