import { test } from "node:test";
import { strict as assert } from "node:assert";
import { artCoverage, paintedBounds, parseArtBounds, tileIntersects } from "./art-coverage.ts";

test("painted islands cannot qualify their empty AABB as release-ready", () => {
  const paint = new Set(["-1_-1", "1_0"]);
  const bounds = paintedBounds(paint, 1024)!;
  const report = artCoverage(bounds, paint, paint, 1024);
  assert.equal(report.expected, 6);
  assert.equal(report.painted, 2);
  assert.deepEqual(report.missingPaint, ["0_-1", "1_-1", "-1_0", "0_0"]);
  assert.equal(paintedBounds([], 1024), null);
});

test("explicit bounds do not expand when unrelated paint exists outside them", () => {
  const bounds = parseArtBounds("-1024,-1024,1024,0");
  const report = artCoverage(bounds, new Set(["-1_-1", "0_-1", "100_100"]), new Set(["-1_-1"]), 1024);
  assert.equal(report.expected, 2);
  assert.deepEqual(report.missingPaint, []);
  assert.deepEqual(report.missingRender, ["0_-1"]);
  assert.equal(tileIntersects("1_-1", bounds, 1024), false);
  assert.equal(tileIntersects("-1_-1", bounds, 1024), true);
});

test("invalid release rectangles fail before writing export files", () => {
  for (const b of ["0,0,0,1024", "0,0,1024,-1", "0,0,NaN,1024", "0,0,1"])
    assert.throws(() => parseArtBounds(b));
});
