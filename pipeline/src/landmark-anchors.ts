import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ecefToEnu, enuToPixel, llhToEcef } from "./camera.ts";
import { landmarkPixel, type Landmark } from "./landmarks.ts";
import { groundAt, type TerrainMeta } from "./road-safety.ts";
import { DERIVED, readJson } from "./paths.ts";

/** Both paint prompts and exported labels sample the ground, never the roof height pass. */
export function landmarkProjector(areas: string[]) {
  const grids = areas.map(area => {
    const dir = join(DERIVED, area, "ground");
    if (!existsSync(join(dir, "height.bin"))) return null;
    const meta = readJson<TerrainMeta>(join(dir, "meta.json"));
    const b = readFileSync(join(dir, "height.bin"));
    const values = new Float32Array(b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength));
    if (values.length !== meta.nx*meta.ny) throw new Error(`invalid terrain: ${area}`);
    return { meta, values };
  }).filter(g => g !== null);
  return (landmark: Landmark): [number,number] => {
    const [x,y] = ecefToEnu(llhToEcef(landmark.lat, landmark.lon, 0));
    for (const g of grids) {
      const z = groundAt(g.meta,g.values,x,y);
      if (z !== null) return enuToPixel([x,y,z]);
    }
    return landmarkPixel(landmark);
  };
}
