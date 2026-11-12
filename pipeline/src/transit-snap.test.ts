import assert from "node:assert/strict";
import { test } from "node:test";
import { railIndex, snapToRails } from "./transit-snap.ts";

// a straight double track along +x: rails at y = +1.75 (left of eastbound) and y = -1.75 (right),
// with a crossover from one to the other between x = 100 and x = 124
const line = (y0: number, y1 = y0, x0 = 0, x1 = 300): Array<[number, number]> => [[x0, y0], [x1, y1]];
const rails = railIndex([line(1.75), line(-1.75), line(1.75, -1.75, 100, 124)]);
const shape = (dir: 1 | -1) => Array.from({ length: 151 }, (_, i) => [dir === 1 ? i * 2 : 300 - i * 2, 0] as [number, number]);

for (const dir of [1, -1] as const) test(`${dir === 1 ? "eastbound" : "westbound"} centre-line shape goes onto its own right-hand rail, crossover ignored`, () => {
  const { pts, on } = snapToRails(shape(dir), rails);
  assert.ok(on > 140);
  for (const [, y] of pts.slice(5, -5)) assert.ok(Math.abs(y - (dir === 1 ? -1.75 : 1.75)) < 0.05, `y=${y}`);
});

test("a shape lying on the left rail is still moved to the right one", () => {
  const { pts } = snapToRails(shape(1).map(([x]) => [x, 1.75] as [number, number]), rails);
  for (const [, y] of pts.slice(5, -5)) assert.ok(Math.abs(y + 1.75) < 0.05, `y=${y}`);
});

test("no rail mapped: 1.75 m right of the shape", () => {
  const { pts, on } = snapToRails(shape(1), railIndex([]));
  assert.equal(on, 0);
  for (const [, y] of pts) assert.ok(Math.abs(y + 1.75) < 1e-6);
});

test("a shape jogging 3 m toward a stop does not pull the tram off its rail", () => {
  const jog = shape(1).map(([x, y]) => [x, x > 140 && x < 170 ? -3.2 : y] as [number, number]);
  const { pts } = snapToRails(jog, rails);
  for (const [, y] of pts.slice(5, -5)) assert.ok(Math.abs(y + 1.75) < 0.05, `y=${y}`);
});

test("starting where only the wrong rail is mapped does not lock the tram onto it", () => {
  // first 40 m: only the left rail exists; then the double track
  const r = railIndex([[[0, 1.75], [300, 1.75]], [[40, -1.75], [300, -1.75]]]);
  const { pts } = snapToRails(shape(1), r);
  for (const [x, y] of pts) if (x > 80 && x < 290) assert.ok(Math.abs(y + 1.75) < 0.05, `x=${x} y=${y}`);
});
