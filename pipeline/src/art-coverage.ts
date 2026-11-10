/** Global art pixels, with an exclusive right/bottom edge. */
export type ArtBounds = [number, number, number, number];

export function parseArtBounds(value: string): ArtBounds {
  const b = value.split(",").map(Number);
  if (b.length !== 4 || !b.every(Number.isFinite) || b[2] <= b[0] || b[3] <= b[1])
    throw new Error("invalid --art-bounds=x0,y0,x1,y1");
  return b as ArtBounds;
}

export function tileIntersects(key: string, b: ArtBounds, tile: number): boolean {
  const [x, y] = key.split("_").map(Number);
  return x * tile < b[2] && (x + 1) * tile > b[0] && y * tile < b[3] && (y + 1) * tile > b[1];
}

export function paintedBounds(keys: Iterable<string>, tile: number): ArtBounds | null {
  const b: ArtBounds = [Infinity, Infinity, -Infinity, -Infinity];
  for (const key of keys) {
    const [x, y] = key.split("_").map(Number);
    b[0] = Math.min(b[0], x * tile); b[1] = Math.min(b[1], y * tile);
    b[2] = Math.max(b[2], (x + 1) * tile); b[3] = Math.max(b[3], (y + 1) * tile);
  }
  return Number.isFinite(b[0]) ? b : null;
}

/** An AABB around painted islands does not imply a fully painted playable area. */
export function artCoverage(bounds: ArtBounds, painted: Set<string>, rendered: Set<string>, tile: number) {
  const missingPaint: string[] = [], missingRender: string[] = [];
  let expected = 0;
  for (let y = Math.floor(bounds[1] / tile); y < Math.ceil(bounds[3] / tile); y++)
    for (let x = Math.floor(bounds[0] / tile); x < Math.ceil(bounds[2] / tile); x++) {
      const k = `${x}_${y}`;
      expected++;
      if (!painted.has(k)) missingPaint.push(k);
      if (!rendered.has(k)) missingRender.push(k);
    }
  return { bounds, expected, painted: expected - missingPaint.length, missingPaint, missingRender };
}
