import { test } from "node:test";
import assert from "node:assert/strict";
import { Trams } from "../../web/src/scripts/trams.ts";

/** a straight visible track along x, 2 m samples */
function track(len: number, y = 0, t = 0) {
  const s: number[] = [];
  for (let x = 0; x <= len; x += 2) s.push(x, y, 50, 1);
  return Object.assign({ c: 2, o: 1, l: 1, w: 3, a: -1, b: -2, s }, { t });
}
const M = [[1, 0, 0], [0, 1, 0]];

test("trams on one track never overlap, even with a stop and a short headway", () => {
  const T = new Trams([track(1200)], [{ n: "8", d: 0, h: 60, st: [600, 0] }], M, [0, 1]);
  const trams = (T as unknown as { trams: Array<{ s: number }> }).trams;
  assert.ok(trams.length >= 2);
  for (let i = 0; i < 20 * 60 * 10; i++) { // 20 minutes at 10 Hz
    T.step(0.1);
    const s = trams.map((t) => t.s).sort((a, b) => a - b);
    for (let k = 1; k < s.length; k++) assert.ok(s[k] - s[k - 1] >= 34 - 0.01 || s[k] === 1200, `gap ${s[k] - s[k - 1]} at step ${i}`);
  }
});

test("trams on crossing tracks do not drive through each other", () => {
  const a = track(600, 0, 0);
  const b = { ...track(600, 0, 1), s: [] as number[] };
  for (let y = -300; y <= 300; y += 2) b.s.push(300, y, 50, 1); // crosses track a at x = 300
  const T = new Trams([a, b], [{ n: "2", d: 0, h: 900 }, { n: "3", d: 0, h: 900 }], M, [0, 1]);
  const trams = (T as unknown as { trams: Array<{ t: number; s: number }> }).trams;
  const pos = (tr: { t: number; s: number }, o: number) => (tr.t === 0 ? [tr.s - o, 0] : [300, -300 + tr.s - o]);
  for (let i = 0; i < 10 * 60 * 10; i++) {
    T.step(0.1);
    const [p, q] = trams;
    for (let o = 0; o <= 34; o += 4) for (let u = 0; u <= 34; u += 4) {
      const [x1, y1] = pos(p, o), [x2, y2] = pos(q, u);
      assert.ok(Math.hypot(x1 - x2, y1 - y2) > 2.5, `bodies overlap at step ${i}`);
    }
  }
});

test("oncoming trams on the parallel track (3.5 m apart) never make each other stop", () => {
  const a = track(800, 0, 0);
  const b = { ...track(800, 3.5, 1), s: [] as number[] };
  for (let x = 800; x >= 0; x -= 2) b.s.push(x, 3.5, 50, 1); // the other direction
  const T = new Trams([a, b], [{ n: "8", d: 0, h: 600 }, { n: "8", d: 1, h: 600 }], M, [0, 1]);
  const trams = (T as unknown as { trams: Array<{ v: number }> }).trams;
  let slowest = Infinity;
  for (let i = 0; i < 3 * 60 * 10; i++) { T.step(0.1); if (i > 100) slowest = Math.min(slowest, ...trams.map((t) => t.v)); }
  assert.ok(slowest > 5, `a tram slowed to ${slowest} m/s for an oncoming one`);
});
