import { test } from "node:test";
import assert from "node:assert/strict";
import { belowSurface } from "./roadspec.ts";
import { roofRise } from "./building-shape.ts";
import { romanFallbackHeight, romanLook } from "./roma-style.ts";

test("metro, underpasses and indoor corridors are not drawn on the surface", () => {
  assert.equal(belowSurface({ railway: "subway", tunnel: "yes" }), true);
  assert.equal(belowSurface({ railway: "rail", layer: "-1" }), true);
  assert.equal(belowSurface({ highway: "primary", tunnel: "yes", layer: "-1" }), true);
  assert.equal(belowSurface({ highway: "footway", tunnel: "yes", layer: "-1" }, 25), true); // pedestrian underpass
  assert.equal(belowSurface({ highway: "residential", tunnel: "yes", layer: "-1" }, 300), true); // road underpass
  assert.equal(belowSurface({ highway: "footway", indoor: "yes" }), true);
  assert.equal(belowSurface({ highway: "footway", level: "-1;-2" }), true);
});

test("streets through archways and ordinary streets stay drawn", () => {
  assert.equal(belowSurface({ highway: "residential", tunnel: "building_passage" }), false);
  assert.equal(belowSurface({ railway: "tram", tunnel: "building_passage", covered: "yes" }), false);
  assert.equal(belowSurface({ highway: "residential" }), false);
  assert.equal(belowSurface({ highway: "primary", bridge: "yes", layer: "1" }), false);
  assert.equal(belowSurface({ highway: "footway", covered: "no", tunnel: "no" }), false);
  // Rome maps many archways as covered=yes or as a few metres of tunnel=yes under a palazzo
  assert.equal(belowSurface({ highway: "service", covered: "yes" }), false);
  assert.equal(belowSurface({ highway: "service", tunnel: "yes" }, 18), false);
  assert.equal(belowSurface({ highway: "service", tunnel: "yes" }, 120), true);
  assert.equal(belowSurface({ highway: "primary", tunnel: "yes" }, 30), true);
  assert.equal(belowSurface({ railway: "rail", tunnel: "yes" }, 20), true);
  assert.equal(belowSurface({ highway: "footway", covered: "yes", indoor: "yes" }), true);
  assert.equal(belowSurface({ highway: "service", tunnel: "yes", layer: "-1" }, 8), false); // Vicolo de' Catinari arch
  assert.equal(belowSurface({ highway: "service", covered: "yes", layer: "-1" }, 17), false); // Arco de' Cenci
});

test("Roman hipped roof rises from every eave and caps at its height", () => {
  const sq: Array<[number, number]> = [[0, 0], [20, 0], [20, 20], [0, 20]];
  assert.equal(roofRise(0, 10, sq, "roman", 3), 0);
  assert.ok(Math.abs(roofRise(2, 10, sq, "roman", 3) - 1.06) < 0.01);
  assert.equal(roofRise(10, 10, sq, "roman", 3), 3);
  const court: Array<[number, number]> = [[8, 8], [12, 8], [12, 12], [8, 12]];
  assert.equal(roofRise(8, 10, sq, "roman", 3, undefined, false, [court]), 0); // courtyard eave
});

test("Roman looks: palazzi inside the walls, travertine churches, no glass towers", () => {
  assert.equal(romanLook({ building: "yes" }, true, false, 0.5, 0.5).style, 6);
  assert.equal(romanLook({ building: "yes" }, false, false, 0.5, 0.5).style, 7);
  assert.equal(romanLook({ building: "church" }, true, false, 0.5, 0.5).style, 8);
  const h = romanFallbackHeight(600, true, 0.5);
  assert.ok(h >= 18 && h <= 20.5);
});

test("clouds leave the clear map untouched and thin into the page background at the limit", async () => {
  const { cloudEdge } = await import("./clouds.ts");
  const clear = Buffer.alloc(16 * 16 * 3, 100);
  cloudEdge(clear, 0, 0, 16, () => 1.5, [232, 228, 220]);
  assert.ok(clear.every((v) => v === 100));
  const limit = Buffer.alloc(16 * 16 * 3, 100);
  cloudEdge(limit, 0, 0, 16, () => 0, [232, 228, 220]);
  assert.deepEqual([...limit.subarray(0, 3)], [232, 228, 220]);
});
