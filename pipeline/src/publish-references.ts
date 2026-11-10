/** References must be readable on R2 before world.json makes them live. */
export interface WorldReferences {
  files?: Record<string, string>;
  previews?: Record<string, Record<string, { file: string }>>;
}

export async function verifyWorldReferences(
  world: WorldReferences,
  regionBase: string,
  fetchReference: typeof fetch = fetch,
) {
  const needed = new Set<string>();
  for (const name of Object.values(world.files ?? {})) needed.add(`data/${name}`);
  for (const city of Object.values(world.previews ?? {}))
    for (const p of Object.values(city)) if (p?.file) needed.add(p.file);

  // Export writes only changed files. Unchanged indices / previews can be absent from
  // the local cache and still be valid dependencies of the new world.json.
  // Check ALL references remotely, including files uploaded during this publish.
  for (const file of needed) {
    const probe = await fetchReference(`${regionBase}/${file}?check=${Date.now()}`);
    await probe.body?.cancel();
    if (!probe.ok) throw new Error(`ref ${file} not reachable on R2 (${probe.status}) — aborting world.json upload`);
  }
}
