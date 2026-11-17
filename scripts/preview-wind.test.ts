import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { WindDataSource } from '@av/client/wind';
import { assertWindFrameLayout, parseWindFrame, windLayout, windOverviewLayout } from '@av/contracts/wind-data';
import { fixtureProfileBuild } from '../tests/client-point-fixture';
import { fixtureBuild } from '../tests/forecast-fixture';
import { configureGfsWindGrid, configureRrfsWindGrid, previewWindFixture } from './preview-wind';
import { measureWindCall } from './preview-observe';
import golden from './fixtures/gfs-wind-layout.json' with { type: 'json' };

it('serves all 48 AV-WRF frames with the pilot Lambert geometry and 41 vertical levels', async () => {
  const hours = Array.from({ length: 48 }, (_, index) => index < 36 ? index + 1 : 39 + (index - 36) * 3);
  const frames = fixtureProfileBuild({ frameHours: hours, mapFrameCount: 48 }).manifest.frames;
  const build = fixtureBuild({ model: 'av-wrf', frames, mapFrameCount: 48 });
  build.expiresAtMs = Date.now() + 60000; build.manifest.expiresAt = new Date(build.expiresAtMs).toISOString();
  const fixture = previewWindFixture(build.manifest, 'av-wrf');
  const native = build.manifest.surfaces.find(surface => surface.kind === 'native')!.grid;
  const fine = build.manifest.surfaces.find(surface => surface.kind === 'fine')!.grid;
  expect(native.kind).toBe('lambert-conformal');
  expect([native.width, native.height, fine.width, fine.height]).toEqual([204, 174, 407, 347]);
  expect(frames.at(-1)?.id).toBe('f072');
  for (const frame of frames) {
    const descriptor = parseWindFrame(new TextEncoder().encode(JSON.stringify(fixture.descriptor(frame.id))));
    expect(descriptor.levels).toBe(41);
    expect(descriptor.windMask).toBeUndefined();
    expect(() => assertWindFrameLayout(descriptor, { native, fine })).not.toThrow();
  }
  const fetchImpl: typeof fetch = async url => {
    const parts = new URL(String(url)).pathname.split('/'), data = parts.indexOf('data'), frame = parts[data + 1], kind = parts[data + 2];
    if (!kind) return Response.json(fixture.descriptor(frame));
    const [first, last = first] = parts[data + 3].split('-').map(Number);
    const chunks = Array.from({ length: last - first + 1 }, (_, index) => fixture.chunk(frame, kind, first + index));
    if (chunks.some(chunk => !chunk)) return new Response(null, { status: 404 });
    return new Response(Uint8Array.from(Buffer.concat(chunks as Uint8Array[])), { headers: { 'content-type': 'application/octet-stream' } });
  };
  const source = new WindDataSource('https://api.test', { fetchImpl });
  for (const frame of ['f001', 'f072']) {
    expect(await source.load({ build, frame, bounds: [45, 40.4, 45.2, 40.6] })).toBe('ready');
    const sample = source.sample(40.4895, 45.1123, 1500);
    expect(sample.status).toBe('valid');
    expect(sample.u).toBeCloseTo(fixture.expected(frame, 40.4895, 45.1123, 1500)!.u, 4);
    expect(await source.prepareAsync(1500)).not.toBeNull();
  }
  source.dispose();
});

it('serves valid frame-specific wind for native and overview sampling', async () => {
  const build = fixtureProfileBuild({ frameHours: [1, 2], mapFrameCount: 2 });
  build.expiresAtMs = Date.now() + 60_000;
  build.manifest.expiresAt = new Date(build.expiresAtMs).toISOString();
  const fixture = previewWindFixture(build.manifest);
  const native = build.manifest.surfaces.find(surface => surface.kind === 'native')!.grid;
  const fine = build.manifest.surfaces.find(surface => surface.kind === 'fine')!.grid;
  const frames = build.manifest.frames.map(frame => frame.id);
  const descriptor = parseWindFrame(new TextEncoder().encode(JSON.stringify(fixture.descriptor(frames[0]))));
  expect(() => assertWindFrameLayout(descriptor, { native, fine })).not.toThrow();
  expect(fixture.chunk('unknown', 'wind', 0)).toBeNull();
  expect(fixture.chunk(frames[0], 'wind', -1)).toBeNull();
  const requested: string[] = [];
  const fetchImpl: typeof fetch = async url => {
    const parts = new URL(String(url)).pathname.split('/'), data = parts.indexOf('data'), frame = parts[data + 1], kind = parts[data + 2];
    if (!kind) return Response.json(fixture.descriptor(frame));
    requested.push(kind);
    const [first, last = first] = parts[data + 3].split('-').map(Number);
    const chunks = Array.from({ length: last - first + 1 }, (_, index) => fixture.chunk(frame, kind, first + index));
    if (chunks.some(chunk => !chunk)) return new Response(null, { status: 404 });
    const body = Buffer.concat(chunks as Uint8Array[]);
    return new Response(Uint8Array.from(body), { headers: { 'content-type': 'application/octet-stream' } });
  };
  const source = new WindDataSource('https://api.test', { fetchImpl });
  const samples = [];
  for (const frame of frames) {
    expect(await source.load({ build, frame, bounds: [-101, 39, -99, 41] })).toBe('ready');
    samples.push(source.sample(40, -100, 1500));
  }
  expect(samples[0].status).toBe('valid');
  expect(samples[1].status).toBe('valid');
  expect(samples[1].u! - samples[0].u!).toBeCloseTo(0.2, 5);
  expect(samples[1].v! - samples[0].v!).toBeCloseTo(0.1, 5);
  const expected = fixture.expected(frames[0], 40, -100, 1500)!;
  expect(samples[0].u).toBeCloseTo(expected.u, 4);
  expect(samples[0].v).toBeCloseTo(expected.v, 4);
  expect(source.hasPrepared(1500)).toBe(false);
  expect(source.hasField(1500)).toBe(false);
  expect(source.prepare(1500)).not.toBeNull();
  expect(source.hasPrepared(1500)).toBe(true);
  expect(source.hasPrepared(2000)).toBe(false);
  source.field(1500);
  expect(source.hasField(1500)).toBe(true);
  expect(source.hasField(2000)).toBe(false);
  source.dispose();
  expect(source.hasPrepared(1500)).toBe(false);
  expect(source.hasField(1500)).toBe(false);
  expect(source.sample(40, -100, 1500).status).toBe('unavailable');
  const overview = new WindDataSource('https://api.test', { fetchImpl });
  expect(await overview.load({ build, frame: frames[0], bounds: [-180, -60, 180, 80] })).toBe('ready');
  expect(requested.some(kind => kind.startsWith('overview-'))).toBe(true);
  const coarse = overview.sample(40, -100, 1500);
  expect(coarse.status).toBe('valid');
  expect(coarse.u).toBeCloseTo(expected.u, 4);
  expect(coarse.v).toBeCloseTo(expected.v, 4);
  overview.dispose();
});

it('models the published RRFS layout and computes viewport tiles using the client planner', async () => {
  const frames = fixtureProfileBuild({ frameHours: Array.from({ length: 40 }, (_, i) => i + 1), mapFrameCount: 40 }).manifest.frames;
  const build = fixtureBuild({ model: 'rrfs', frames, mapFrameCount: 40 });
  build.expiresAtMs = Date.now() + 60000; build.manifest.expiresAt = new Date(build.expiresAtMs).toISOString();
  configureRrfsWindGrid(build.manifest);
  const fixture = previewWindFixture(build.manifest, 'rrfs');
  const native = build.manifest.surfaces.find(surface => surface.kind === 'native')!.grid;
  const fine = build.manifest.surfaces.find(surface => surface.kind === 'fine')!.grid;
  expect([native.width, native.height, fine.width, fine.height]).toEqual([1799, 1059, 3597, 2117]);
  expect(windLayout(native.width, native.height, 16, 26).chunkBytes).toBe(88844);
  expect(windLayout(fine.width, fine.height, 64).chunkBytes).toBe(40960);
  for (const frame of frames) {
    const json = JSON.stringify(fixture.descriptor(frame.id));
    expect(Buffer.byteLength(json)).toBe(5614);
    const descriptor = parseWindFrame(new TextEncoder().encode(json));
    expect(() => assertWindFrameLayout(descriptor, { native, fine })).not.toThrow();
    expect(descriptor.wind.reduce((total, shard) => total + shard.count, 0)).toBe(5624);
    expect(descriptor.fine.reduce((total, shard) => total + shard.count, 0)).toBe(1476);
    expect(descriptor.overview?.map(level => [level.stride, level.shards[0].count])).toEqual([[2, 493], [4, 135], [8, 40], [16, 12], [32, 4], [64, 1]]);
  }
  const lat = 40, lon = -100, world = 512 * 2 ** 8.17, y = (1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2;
  const latitude = (value: number) => Math.atan(Math.sinh(Math.PI * (1 - 2 * value))) * 180 / Math.PI;
  const bounds: [number, number, number, number] = [lon - 1394 / (2 * world) * 360, latitude(y + 1032 / (2 * world)), lon + 1394 / (2 * world) * 360, latitude(y - 1032 / (2 * world))];
  const requested: Record<string, number[]> = {};
  const fetchImpl: typeof fetch = async url => {
    const parts = new URL(String(url)).pathname.split('/'), data = parts.indexOf('data'), frame = parts[data + 1], kind = parts[data + 2];
    if (!kind) return Response.json(fixture.descriptor(frame));
    const [first, last = first] = parts[data + 3].split('-').map(Number);
    const indices = Array.from({ length: last - first + 1 }, (_, index) => first + index);
    (requested[kind] ??= []).push(...indices);
    const chunks = indices.map(index => fixture.chunk(frame, kind, index));
    return chunks.some(chunk => !chunk) ? new Response(null, { status: 404 }) : new Response(Uint8Array.from(Buffer.concat(chunks as Uint8Array[])), { headers: { 'content-type': 'application/octet-stream' } });
  };
  const source = new WindDataSource('https://api.test', { fetchImpl });
  expect(await source.load({ build, frame: 'f001', bounds })).toBe('ready');
  expect(Object.keys(requested)).toEqual(['overview-2']);
  expect(requested['overview-2'].length).toBe(4);
  expect(source.sample(lat, lon, 1500).status).toBe('valid');
  expect(source.sample(lat, lon, 1500).u).toBeCloseTo(fixture.expected('f001', lat, lon, 1500)!.u, 4);
  source.dispose();
});

it('matches the published GFS layout and plans the supplied viewport through the real client', async () => {
  const hours = Array.from({ length: 40 }, (_, i) => i < 24 ? i + 1 : 27 + (i - 24) * 3);
  const build = fixtureProfileBuild({ frameHours: hours, mapFrameCount: 40 });
  build.expiresAtMs = Date.now() + 60_000; build.manifest.expiresAt = new Date(build.expiresAtMs).toISOString();
  configureGfsWindGrid(build.manifest);
  const fixture = previewWindFixture(build.manifest, true);
  const first = fixture.descriptor('f001')!, second = fixture.descriptor('f002')!;
  const identity = first.wind[0].sha256;
  expect(identity).toMatch(/^[a-f0-9]{64}$/);
  expect(fixture.descriptor('f001')!.wind[0].sha256).toBe(identity);
  expect(second.wind[0].sha256).not.toBe(identity);
  expect(first.wind[1].sha256).not.toBe(identity);
  expect(first.fine[0].sha256).not.toBe(identity);
  expect(first.overview[0].shards[0].sha256).not.toBe(second.overview[0].shards[0].sha256);
  expect(first.overview[0].shards[0].sha256).not.toBe(identity);
  expect(first.wind[0].indexSha256).not.toBe(identity);
  expect(createHash('sha256').update(fixture.chunk('f001', 'wind', 0)!).digest('hex')).not.toBe(identity);
  expect(new URL('/v1/models/gfs/runs/test/data/f001/wind/0', 'https://api.test').pathname).not.toBe(new URL('/v1/models/gfs/runs/test/data/f002/wind/0', 'https://api.test').pathname);
  const native = build.manifest.surfaces.find(surface => surface.kind === 'native')!.grid;
  const fine = build.manifest.surfaces.find(surface => surface.kind === 'fine')!.grid;
  const sha = (value: string) => createHash('sha256').update(value).digest('hex');
  expect(sha(golden.windMask)).toBe('1d7dd866ed146a3168021393682575d76b9e4813c08e326b80d8add147940285');
  expect(sha(fixture.descriptor('f004')!.fineMask!)).toBe('df9425cfaeac03507836d909d3b0111d6aa8fe6c9bbda2dffd1f1cfa533e5b62');
  expect([native.width, native.height, fine.width, fine.height]).toEqual([1440, 721, 14400, 7201]);
  expect(windLayout(native.width, native.height, 16, 22).chunkBytes).toBe(75532);
  expect(windLayout(fine.width, fine.height, 64).chunkBytes).toBe(40960);
  for (const frame of build.manifest.frames) {
    const json = JSON.stringify(fixture.descriptor(frame.id));
    expect(Buffer.byteLength(json)).toBe(8576);
    const descriptor = parseWindFrame(new TextEncoder().encode(json));
    expect(() => assertWindFrameLayout(descriptor, { native, fine })).not.toThrow();
    expect(descriptor.wind.map(shard => shard.count)).toEqual([512, 503]);
    expect(descriptor.fine.map(shard => shard.count)).toEqual([...Array(9).fill(512), 59]);
    expect(descriptor.overview?.map(level => [level.stride, level.shards[0].count, windOverviewLayout(native, level.stride).chunkBytes])).toEqual([[2, 276, 110592], [4, 72, 110592], [8, 18, 110592], [16, 6, 110592], [32, 2, 110592], [64, 1, 110592]]);
  }
  const lat = 40.4895, lon = 45.1123, world = 512 * 2 ** 8.17, y = (1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2;
  const latitude = (value: number) => Math.atan(Math.sinh(Math.PI * (1 - 2 * value))) * 180 / Math.PI;
  const bounds: [number, number, number, number] = [lon - 1394 / (2 * world) * 360, latitude(y + 1032 / (2 * world)), lon + 1394 / (2 * world) * 360, latitude(y - 1032 / (2 * world))];
  const requests: Record<string, number[]> = {}, byFrame: Record<string, Record<string, number[]>> = {};
  const fetchImpl: typeof fetch = async url => {
    const parts = new URL(String(url)).pathname.split('/'), data = parts.indexOf('data'), frame = parts[data + 1], kind = parts[data + 2];
    if (!kind) return Response.json(fixture.descriptor(frame));
    const [first, last = first] = parts[data + 3].split('-').map(Number);
    const indices = Array.from({ length: last - first + 1 }, (_, index) => first + index);
    (requests[kind] ??= []).push(...indices);
    ((byFrame[frame] ??= {})[kind] ??= []).push(...indices);
    const chunks = indices.map(index => fixture.chunk(frame, kind, index));
    if (chunks.some(chunk => !chunk)) return new Response(null, { status: 404 });
    return new Response(Uint8Array.from(Buffer.concat(chunks as Uint8Array[])), { headers: { 'content-type': 'application/octet-stream' } });
  };
  const source = new WindDataSource('https://api.test', { fetchImpl });
  expect(await source.load({ build, frame: 'f004', bounds })).toBe('ready');
  expect(requests.wind).toHaveLength(2);
  expect(requests.fine).toHaveLength(6);
  expect(32768 + requests.wind.length * 75532 + requests.fine.length * 40960).toBe(429592);
  expect(source.sample(lat, lon, 1500).status).toBe('valid');
  const expected = fixture.expected('f004', lat, lon, 1500)!;
  expect(source.sample(lat, lon, 1500).u).toBeCloseTo(expected.u, 4);
  expect(source.sample(lat, lon, 450).status).toBe('valid');
  const outcomeMetrics: string[] = [], record = (name: string) => { outcomeMetrics.push(name); };
  expect(() => measureWindCall('grid', false, () => source.prepare(-1), () => false, record)).toThrow();
  for (const frame of build.manifest.frames) {
    if (frame.id === 'f004') continue;
    expect(await source.load({ build, frame: frame.id, bounds })).toBe('ready');
    expect(byFrame[frame.id].wind).toHaveLength(2);
    expect(byFrame[frame.id].fine).toHaveLength(6);
    expect(source.sample(lat, lon, 1500).status).toBe('valid');
    expect(source.sample(lat, lon, 1500).u).toBeCloseTo(fixture.expected(frame.id, lat, lon, 1500)!.u, 4);
  }
  source.dispose();
  expect(measureWindCall('grid', false, () => source.prepare(1500), () => source.hasPrepared(1500), record)).toBeNull();
  expect(outcomeMetrics).toEqual(['wind-grid-uncached-failed', 'wind-grid-uncached-null']);
  for (const cap of [2, 4, 8]) {
    const overviewTiles: number[] = [];
    const overviewFetch: typeof fetch = async url => {
      const parts = new URL(String(url)).pathname.split('/'), data = parts.indexOf('data'), frame = parts[data + 1], kind = parts[data + 2];
      if (!kind) { const descriptor = fixture.descriptor(frame)!; return Response.json({ ...descriptor, overview: descriptor.overview.filter(level => level.stride <= cap) }); }
      if (kind === 'wind') return new Response(null, { status: 404 });
      const [first, last = first] = parts[data + 3].split('-').map(Number);
      const indices = Array.from({ length: last - first + 1 }, (_, index) => first + index);
      if (kind === 'overview-2') overviewTiles.push(...indices);
      const chunks = indices.map(index => fixture.chunk(frame, kind, index));
      if (chunks.some(chunk => !chunk)) return new Response(null, { status: 404 });
      return new Response(Uint8Array.from(Buffer.concat(chunks as Uint8Array[])), { headers: { 'content-type': 'application/octet-stream' } });
    };
    const overview = new WindDataSource('https://api.test', { fetchImpl: overviewFetch });
    expect(await overview.load({ build, frame: 'f004', bounds })).toBe('ready');
    expect(overview.isOverview).toBe(true);
    expect(overview.overviewStride).toBe(2);
    expect(overviewTiles).toHaveLength(4);
    expect(overview.sample(lat, lon, 1500).status).toBe('valid');
    expect(overview.sample(lat, lon, 450).status).toBe('unavailable');
    overview.dispose();
  }
});
