import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { verifyWorldReferences } from "./publish-references.ts";

const base = "https://tiles.example/regions/roma-centro";
const world = {
  files: {
    "tiles-map": "tiles-map.new.json",
    borders: "borders.unchanged.json",
    roads: "roads.new.json",
  },
  previews: { roma: {
    land: { file: "preview/roma-land.unchanged.avif" },
    port: { file: "preview/roma-port.new.avif" },
  } },
};

test("incremental publish accepts unchanged references already on R2 without a local copy", async () => {
  const seen: string[] = [];
  const probe: typeof fetch = async (input) => {
    const url = new URL(String(input));
    assert.ok(url.searchParams.has("check"));
    seen.push(url.pathname);
    return new Response("available");
  };
  await verifyWorldReferences(world, base, probe);
  assert.deepEqual(seen, [
    "/regions/roma-centro/data/tiles-map.new.json",
    "/regions/roma-centro/data/borders.unchanged.json",
    "/regions/roma-centro/data/roads.new.json",
    "/regions/roma-centro/preview/roma-land.unchanged.avif",
    "/regions/roma-centro/preview/roma-port.new.avif",
  ]);
});

for (const missing of ["tiles-map.new.json", "borders.unchanged.json", "roma-port.new.avif"]) {
  test(`rejects missing R2 dependency ${missing}`, async () => {
    const probe: typeof fetch = async (input) => new Response(null, {
      status: new URL(String(input)).pathname.endsWith(missing) ? 404 : 200,
    });
    await assert.rejects(verifyWorldReferences(world, base, probe), /not reachable on R2 \(404\)/);
  });
}

test("network failure aborts verification", async () => {
  const probe: typeof fetch = async () => { throw new Error("network unavailable"); };
  await assert.rejects(verifyWorldReferences(world, base, probe), /network unavailable/);
});

test("duplicate preview references are checked once", async () => {
  let calls = 0;
  const probe: typeof fetch = async () => { calls++; return new Response(null); };
  const preview = { file: "preview/shared.avif" };
  await verifyWorldReferences({ previews: { roma: { land: preview, port: preview } } }, base, probe);
  assert.equal(calls, 1);
});

// Exercise the actual publisher with an isolated export cache and a fully mocked network.
// No production paths, credentials or HTTP requests are used by these fixtures.
for (const missing of [false, true]) {
  test(`publisher ${missing ? "keeps cache and state when an R2 reference is missing" : "uploads world last and accepts R2-only dependencies"}`, () => {
    const root = mkdtempSync(join(tmpdir(), "mondo-publish-test-"));
    try {
      const source = join(root, "pipeline/src");
      const data = join(root, "data/web/regions/roma-centro/data");
      mkdirSync(source, { recursive: true });
      mkdirSync(data, { recursive: true });
      writeFileSync(join(root, "package.json"), '{"type":"module"}');
      for (const file of ["publish.ts", "publish-references.ts", "hosting.ts", "paths.ts", "places.ts"])
        cpSync(new URL(file, import.meta.url), join(source, file));
      writeFileSync(join(data, "roads.new.json"), "{}");
      writeFileSync(join(data, "world.json"), JSON.stringify(world));
      writeFileSync(join(root, "data/web/roma-centro.state.json"), "{}");
      const script = `
        import assert from 'node:assert/strict';
        import { existsSync } from 'node:fs';
        const events = [];
        globalThis.fetch = async (input, init) => {
          const url = new URL(String(input));
          if (init?.method === 'PUT') {
            events.push('PUT ' + url.pathname.split('/').pop());
            return Response.json({ success: true, result: { size: init.body.length } });
          }
          events.push('GET ' + url.pathname.split('/').pop());
          return new Response(null, { status: ${missing} && url.pathname.endsWith('tiles-map.new.json') ? 404 : 200 });
        };
        process.argv = ['node', 'publish.ts', 'roma-centro', '--yes'];
        let error;
        try { await import('./pipeline/src/publish.ts'); } catch (e) { error = e; }
        if (${missing}) {
          assert.match(error?.message ?? '', /not reachable on R2/);
          assert.ok(!events.includes('PUT world.json'));
          assert.ok(existsSync('data/web/regions/roma-centro/data/world.json'));
          assert.ok(existsSync('data/web/roma-centro.state.json'));
          assert.ok(!existsSync('data/web-state/roma-centro.json'));
        } else {
          assert.equal(error, undefined);
          assert.deepEqual(events.filter(e => e.startsWith('PUT ')), ['PUT roads.new.json', 'PUT world.json']);
          for (const file of ['tiles-map.new.json', 'borders.unchanged.json', 'roads.new.json', 'roma-land.unchanged.avif', 'roma-port.new.avif'])
            assert.ok(events.indexOf('GET ' + file) < events.indexOf('PUT world.json'));
          assert.ok(existsSync('data/web-state/roma-centro.json'));
          assert.ok(!existsSync('data/web/regions/roma-centro'));
        }
      `;
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
        cwd: root, encoding: "utf8", timeout: 15_000,
        env: { ...process.env, TILES_ORIGIN: "https://tiles.example", CLOUDFLARE_ACCOUNT_ID: "fixture", CLOUDFLARE_API_TOKEN: "fixture" },
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
