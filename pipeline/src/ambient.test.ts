import { test } from "node:test";
import assert from "node:assert/strict";
import { grade, sunElevation, weatherLabel } from "../../web/src/scripts/ambient.ts";

test("sun over Rome: high at noon, below the horizon at midnight (13 Nov 2026)", () => {
  const noon = sunElevation(new Date("2026-11-13T11:00:00Z")); // 12:00 CET
  const midnight = sunElevation(new Date("2026-11-12T23:00:00Z"));
  assert.ok(noon > 25 && noon < 35, `noon ${noon}`);
  assert.ok(midnight < -40, `midnight ${midnight}`);
});

test("light grade: neutral by day, blue at night, warm at golden hour", () => {
  assert.deepEqual(grade(40, 0).mult, [255, 255, 255]);
  const night = grade(-20, 0).mult;
  assert.ok(night[2] > night[0] && night[0] < 140);
  const golden = grade(4, 0);
  assert.ok(golden.wash[0] > golden.wash[2] && golden.wash[3] > 0);
});

test("WMO codes read in Italian", () => {
  assert.equal(weatherLabel(0), "sereno");
  assert.equal(weatherLabel(63), "pioggia");
  assert.equal(weatherLabel(45), "nebbia");
  assert.equal(weatherLabel(95), "temporale");
});
