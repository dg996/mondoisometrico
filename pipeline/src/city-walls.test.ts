import assert from "node:assert/strict";
import { test } from "node:test";
import { cityWall, crossing, thickLine, WallMatcher, wallPieces } from "./city-walls.ts";

type P2 = [number, number];
const area = (r: P2[]) => { let a = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] - r[i][0]) * (r[j][1] + r[i][1]); return a / 2; };

test("Mura Aureliane lines and outlines are city walls with the documented size; other walls and gates are not", () => {
  const line = cityWall({ barrier: "city_wall", historic: "citywalls", name: "Mura Aureliane" });
  assert.deepEqual([line?.height, line?.thickness], [13, 3.5]);
  // building=city_wall outline on Viale di Porta Ardeatina (relation 15479564): a wall, not a palazzo
  assert.ok(cityWall({ building: "city_wall", "historic:civilization": "ancient_roman", name: "Mura Aureliane", type: "multipolygon" }));
  assert.ok(cityWall({ barrier: "city_wall", "name:en": "Aurelian Walls" }));
  assert.equal(cityWall({ barrier: "city_wall", height: "16" })?.height, undefined, "unnamed wall: no verified size");
  assert.equal(cityWall({ barrier: "city_wall", height: "16", name: "Mura Aureliane" })?.height, 16, "tagged height wins");
  assert.equal(cityWall({ barrier: "city_wall", name: "Mura gianicolensi" }), null);
  assert.equal(cityWall({ building: "city_gate", historic: "city_gate", name: "Porta San Giovanni" }), null);
  assert.equal(cityWall({ name: "Mura Aureliane" }), null, "a node/label named after the walls is not a wall");
});

test("an unnamed wall outline along a named stretch is the same wall; one that only touches it is not", () => {
  const spec = cityWall({ barrier: "city_wall", name: "Mura Aureliane" })!;
  const m = new WallMatcher([{ line: [[0, 0], [400, 0]], spec }]);
  // relation 14279973: building=city_wall, no name, drawn round the same 400 m of wall
  const outline: P2[] = [[0, -3], [400, -3], [400, 4], [0, 4], [0, -3]];
  assert.equal(m.match({ building: "city_wall", type: "multipolygon" }, outline)?.height, 13);
  // a wall that starts where the named one ends and goes elsewhere (Vatican, Gianicolo): not ours
  assert.equal(m.match({ barrier: "city_wall" }, [[400, 0], [600, 150], [800, 300], [1000, 450]]), null);
  assert.equal(m.match({ building: "yes" }, outline), null, "not a wall at all");
});

test("a wall line becomes pieces of its thickness, at most one grid cell each, without gaps at the bends", () => {
  const line: P2[] = [[0, 0], [100, 0], [100, 60]];
  const pieces = wallPieces(line.slice(1).flatMap((b, i) => thickLine([line[i], b], 3.5)));
  const total = pieces.reduce((t, [o, ...h]) => t + Math.abs(area(o)) - h.reduce((s, r) => s + Math.abs(area(r)), 0), 0);
  // 160 m of centre line x 3.5 m plus the square caps at both ends; at the bend the caps fill the corner
  assert.ok(Math.abs(total - (160 * 3.5 + 2 * 1.75 * 3.5)) < 0.01, `area ${total}`);
  for (const [outer] of pieces) {
    const xs = outer.map((p) => p[0]), ys = outer.map((p) => p[1]);
    assert.ok(Math.max(...xs) - Math.min(...xs) <= 10 + 1e-9 && Math.max(...ys) - Math.min(...ys) <= 10 + 1e-9, "a piece spans one 10 m cell");
    assert.ok(area(outer) > 0, "outer rings are CCW");
  }
  // no notch on the outside of the bend
  const insideRing = ([x, y]: P2, r: P2[]) => { let c = false; for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const [xi, yi] = r[i], [xj, yj] = r[j]; if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c; } return c; };
  assert.ok(pieces.some(([o]) => insideRing([101.5, -1.5], o)));
});

test("a road crossing a wall line at street level opens it; one ending at the wall does not", () => {
  assert.deepEqual(crossing([0, 0], [10, 0], [5, -5], [5, 5]), [5, 0]);
  assert.equal(crossing([0, 0], [10, 0], [5, 0], [5, 5]), null, "road ends on the wall line (its arch is the next way)");
  assert.equal(crossing([0, 0], [10, 0], [0, -5], [0, 5]), null, "at the wall's end node");
  const wall = thickLine([[0, 0], [40, 0]], 3.5);
  const gap: P2[] = [[16, -9], [24, -9], [24, 9], [16, 9]];
  const pieces = wallPieces(wall, [gap]);
  const hit = pieces.some(([o]) => o.some(([x]) => x > 16.01 && x < 23.99));
  assert.equal(hit, false, "nothing of the wall is left in the opening");
});
