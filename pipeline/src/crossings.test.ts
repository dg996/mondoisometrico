import { test } from "node:test";
import assert from "node:assert/strict";
import { crossingIndex, crossingsAlong } from "./crossings.ts";

const road = (pts: number[][]) => pts.flatMap(([x, y]) => [x, y, 0, 1]);

test("a perpendicular crossing cuts the way where it is drawn, with a 1.5 m half band", () => {
  const s = road(Array.from({ length: 21 }, (_, i) => [i * 2, 0]));
  const x = crossingsAlong(s, crossingIndex([[[13, -6], [13, 6]]]));
  assert.deepEqual(x, [13, 1.5]);
});

test("a skewed crossing has a longer band; crossings off the way are ignored", () => {
  const s = road(Array.from({ length: 21 }, (_, i) => [i * 2, 0]));
  const x = crossingsAlong(s, crossingIndex([[[20, -5], [25, 5]], [[30, 5], [30, 9]]]));
  assert.equal(x.length, 2);
  assert.ok(Math.abs(x[0] - 22.5) < 0.05);
  assert.ok(x[1] > 1.6 && x[1] < 1.8);
});

test("a crossing hit at a sample joint counts once", () => {
  const s = road(Array.from({ length: 6 }, (_, i) => [i * 2, 0]));
  assert.deepEqual(crossingsAlong(s, crossingIndex([[[4, -3], [4, 3]]])), [4, 1.5]);
});

test("a crossing that stops at the kerb still counts for the carriageway it serves", () => {
  const s = road(Array.from({ length: 21 }, (_, i) => [i * 2, 0]));
  assert.deepEqual(crossingsAlong(s, crossingIndex([[[10, 2.5], [10, 8]]])), [10, 1.5]);
  assert.deepEqual(crossingsAlong(s, crossingIndex([[[10, 5], [10, 8]]])), []);
});
