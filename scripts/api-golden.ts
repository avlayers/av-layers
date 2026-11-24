/**
 * Byte-for-byte API parity between two checkouts on the synthetic offline fixture.
 *
 *   node --import tsx scripts/api-golden.ts --baseline ../avl-baseline
 *
 * Serves the same seeded fixture from both checkouts, requests every route in
 * docs/reference/openapi.json with concrete parameters taken from the fixture build,
 * and compares status, body SHA-256 and the caching headers clients rely on.
 */
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { prepareFixtureData, startFixtureStack } from './fixture-stack.js';

const HEADERS = ['content-type', 'cache-control', 'etag', 'access-control-allow-origin'] as const;

interface Observation { status: number; sha256: string; headers: Record<string, string | null> }

async function observe(apiUrl: string, path: string): Promise<Observation> {
  const response = await fetch(`${apiUrl}${path}`);
  const body = stable(new Uint8Array(await response.arrayBuffer()), response.headers.get('content-type'), apiUrl);
  return {
    status: response.status,
    sha256: createHash('sha256').update(body).digest('hex'),
    // Sample/profile ETags digest the request URL, origin included; the body hash covers content.
    headers: Object.fromEntries(HEADERS.map(name => [name, name === 'etag' ? response.headers.get(name)?.replace(/[0-9a-f]{64}/g, 'DIGEST') ?? null : response.headers.get(name)]))
  };
}

/** Concrete request paths for every documented route, derived from the fixture build. */
async function routePaths(apiUrl: string, model: string): Promise<string[]> {
  const latest = await (await fetch(`${apiUrl}/v1/models/${model}/latest`)).json() as { pointer: { latestBuildId: string } };
  const buildId = latest.pointer.latestBuildId;
  const run = `/v1/models/${model}/runs/${buildId}`;
  const manifest = await (await fetch(`${apiUrl}${run}`)).json() as { frames: { id: string }[]; layers: string[] };
  const frame = manifest.frames[0]!.id, lastFrame = manifest.frames.at(-1)!.id;
  const point = 'lat=40&lon=-100';
  const paths = [
    '/healthz', '/openapi.json', '/v1/catalog',
    `/v1/models/${model}/latest`, `/v1/models/${model}/latest?expand=manifest`, `/v1/models/${model}/runs`,
    run, `${run}/provenance`, `${run}/provenance?frame=${frame}`,
    `${run}/sample?${point}&frame=${frame}`, `${run}/sample?${point}`, `${run}/sample?${point}&frame=${lastFrame}`,
    `${run}/samples?points=40,-100;41,-99&frame=${frame}`, `${run}/samples?points=40,-100|41,-99&frame=${frame}`,
    `${run}/profile?${point}&frame=${frame}`, `${run}/profile?${point}`,
    `${run}/data/${frame}`,
    '/v1/palettes/lift.json', '/v1/palettes/lift.svg', '/v1/palettes/rain.json', '/v1/palettes/rain.svg',
    `/v1/models/not-a-model/latest`, `${run}/sample?lat=999&lon=0`, `/v1/models/${model}/runs/nope`
  ];
  for (const layer of manifest.layers) {
    paths.push(`${run}/layers/${layer}/${frame}/tilejson.json`);
    for (const [z, x, y] of [[0, 0, 0], [1, 0, 0], [2, 0, 1], [2, 1, 1]]) paths.push(`/tiles/${model}/${buildId}/${layer}/${frame}/${z}/${x}/${y}.webp`);
  }
  return paths;
}

/** Wall-clock fields that legitimately differ between two runs seconds apart. */
const CLOCK_FIELDS = new Set(['ageSeconds', 'cycleAgeSeconds', 'horizonRemainingSeconds']);
function stable(body: Uint8Array, type: string | null, origin: string): Uint8Array {
  if (!type?.includes('json')) return body;
  try {
    const text = new TextDecoder().decode(body).replaceAll(origin, 'ORIGIN');
    return new TextEncoder().encode(JSON.stringify(JSON.parse(text), (key, value) => CLOCK_FIELDS.has(key) ? 0 : value));
  } catch { return body; }
}

async function main(): Promise<void> {
  const { values } = parseArgs({ strict: true, allowPositionals: false, options: { baseline: { type: 'string' } } });
  if (!values.baseline) throw new Error('--baseline <checkout> is required');
  const data = await prepareFixtureData();
  try {
    const collect = async (root?: string) => {
      const stack = await startFixtureStack(data, root);
      try {
        const paths = await routePaths(stack.apiUrl, data.model);
        const seen = new Map<string, Observation>();
        for (const path of paths) seen.set(path, await observe(stack.apiUrl, path));
        return seen;
      } finally { await stack.close(); }
    };
    const baseline = await collect(resolve(values.baseline));
    const candidate = await collect();
    let failures = 0;
    for (const [path, expected] of baseline) {
      const actual = candidate.get(path);
      const same = actual && JSON.stringify(actual) === JSON.stringify(expected);
      if (!same) { failures++; console.log(`DIFF ${path}\n  baseline  ${JSON.stringify(expected)}\n  candidate ${JSON.stringify(actual)}`); }
    }
    const statuses = [...baseline.values()].map(o => o.status).join(',');
    console.log(`${baseline.size - failures}/${baseline.size} routes identical (baseline statuses ${statuses})`);
    process.exitCode = failures ? 1 : 0;
  } finally {
    await data.dispose();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(`api-golden: ${error instanceof Error ? error.stack ?? error.message : String(error)}`); process.exitCode = 1; });
}
