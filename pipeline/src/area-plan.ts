/** Read-only estimates; no data/, API calls or changes to active areas.
 * node --import tsx pipeline/src/area-plan.ts
 */
import { AREAS, AREA_PROPOSALS, areaTiles } from "./areas.ts";
import { CAMERA, useRegion } from "./camera.ts";

const T = CAMERA.tile, WIN = 1024, STRIDE = 896;
const key = ([x, y]: number[]) => `${x}_${y}`;
function windowCount(tiles: number[][]) {
  const windows = new Set<string>();
  for (const [x, y] of tiles)
    for (let j = Math.floor((y*T-WIN)/STRIDE)+1; j*STRIDE < (y+1)*T; j++)
      for (let i = Math.floor((x*T-WIN)/STRIDE)+1; i*STRIDE < (x+1)*T; i++) windows.add(`${i}_${j}`);
  return windows.size;
}
useRegion("roma-centro");
const current = new Set(["roma-core", "roma-inner"].flatMap(a => areaTiles(AREAS[a].bbox).map(key)));
console.log(`Current planned render union: ${current.size} tiles (not a count of files on disk).`);
console.table(Object.entries(AREA_PROPOSALS).map(([name, area]) => {
  const tiles = areaTiles(area.bbox), added = tiles.filter(t => !current.has(key(t)));
  return { name, bbox: area.bbox.join(","), renderTiles: tiles.length, newTiles: added.length,
    paintWindows: windowCount(tiles), newTileWindows: windowCount(added) };
}));
