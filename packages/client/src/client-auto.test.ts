import { afterEach, expect, it, vi } from 'vitest';
import { DEFAULT_REQUEST_TIMEOUT_MS } from '@av/contracts/format';
import { ApiClient, isGlobeView, resolveAutoBuild, selectAutoFrame, selectBestCatalogModel } from './index.js';
import { REGION_A_BOUNDS, REGION_B_POINT, REGION_B_BOUNDS, REGION_A_POINT, autoBuild, autoCatalogRow, autoTime } from '../../../tests/auto-forecast-fixtures.js';
import { fixtureLatest } from '../../../tests/forecast-fixture.js';
import { fixturePointSample } from '../../../tests/client-point-fixture.js';

const global = autoBuild('gfs', [-180, -55, 180, 65], [1, 18, 36, 60, 72]);
const regional = autoBuild('icon-eu', [-23.5, 29.5, 62.5, 70.5], [1, 18, 36, 60, 72]);
const regionA = autoBuild('av-wrf', REGION_A_BOUNDS, [1, 18, 36]);
const fine = autoBuild('wrf-region-a-1km', REGION_A_BOUNDS, [1, 18, 36]);
const nz = autoBuild('wrf-nz-3km', REGION_B_BOUNDS, [1, 18, 36]);
const models = [autoCatalogRow(global.manifest, 27_800), autoCatalogRow(regional.manifest, 6500), autoCatalogRow(regionA.manifest, 3000),
  autoCatalogRow(fine.manifest, 1000), autoCatalogRow(nz.manifest, 3000)];

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it('ranks live coverage by spacing within both advertised time bounds', () => {
  const select = (point: typeof REGION_A_POINT, hour: number, rows = models) => selectBestCatalogModel({ ...point, models: rows,
    nowMs: Date.parse(autoTime(0)), validTimeMs: Date.parse(autoTime(hour)) });
  expect(select(REGION_A_POINT, 18)).toBe(fine.manifest.model);
  expect(select(REGION_A_POINT, 60)).toBe(regional.manifest.model);
  expect(select(REGION_A_POINT, 0)).toBeNull();
  expect(select(REGION_B_POINT, 18)).toBe(nz.manifest.model);
  expect(select(REGION_B_POINT, 18, [...models.slice(0, -1), { ...models.at(-1)!, expiresAt: autoTime(-1) }])).toBe('gfs');
});

it('treats zoom 2 and a half-world span as a globe', () => {
  expect(isGlobeView({ zoom: 2 })).toBe(true);
  expect(isGlobeView({ zoom: 2.01, west: 44, east: 45 })).toBe(false);
  expect(isGlobeView({ zoom: 6, west: -180, east: 0 })).toBe(true);
  expect(isGlobeView({ zoom: 6, west: -180, east: -0.1 })).toBe(false);
  expect(isGlobeView({ west: -200, east: 200 })).toBe(true);
  expect(isGlobeView({ west: 170, east: -170 })).toBe(false);
  expect(isGlobeView(null)).toBe(false);
});

it('sorts GFS first on a globe and keeps the finest model when zoomed in', () => {
  const nowMs = Date.parse(autoTime(0)), validTimeMs = Date.parse(autoTime(18));
  const select = (globe: boolean, rows = models) => selectBestCatalogModel({ ...REGION_A_POINT, models: rows, globe, nowMs, validTimeMs });
  expect(isGlobeView({ zoom: 6, west: 44, east: 45 })).toBe(false);
  expect(select(true)).toBe(global.manifest.model);
  expect(select(isGlobeView({ zoom: 6, west: 44, east: 45 }))).toBe(fine.manifest.model);
  expect(select(true, models.map(row => row.model === global.manifest.model ? { ...row, expiresAt: autoTime(-1) } : row))).toBe(fine.manifest.model);
});

it.each(['outside-domain', 'unavailable'] as const)('skips a rendered time hole and a point with %s status', async status => {
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse(autoTime(0)));
  const hole = autoBuild(fine.manifest.model, REGION_A_BOUNDS, [1, 12, 36], 2);
  const builds = new Map([hole, regionA, regional, global].map(build => [build.manifest.model, build]));
  const fetchImpl = vi.fn<typeof fetch>(async input => {
    const url = new URL(String(input)), model = url.pathname.split('/')[3];
    if (url.pathname.endsWith('/catalog')) return Response.json({ models });
    const build = builds.get(model)!;
    if (url.pathname.endsWith('/latest')) return Response.json(fixtureLatest(build.manifest));
    const payload = fixturePointSample(build, String(input));
    if (model === regionA.manifest.model) for (const frame of payload.frames) for (const layer of Object.values(frame.layers)) {
      layer.status = status; layer.value = null;
    }
    return Response.json(payload);
  });
  const api = new ApiClient({ baseUrl: 'https://api.test', fetchImpl });
  const selection = await resolveAutoBuild(api, { ...REGION_A_POINT, layers: ['usable-lift-agl'],
    validTimeMs: Date.parse(autoTime(18)), signal: new AbortController().signal });
  expect(selection?.build.manifest.model).toBe('icon-eu');
  expect(selection?.frame.id).toBe('f018');
  const paths = fetchImpl.mock.calls.map(([input]) => new URL(String(input)).pathname);
  expect(paths).toEqual(['/v1/catalog', `/v1/models/${hole.manifest.model}/latest`, `/v1/models/${regionA.manifest.model}/latest`,
    `/v1/models/${regionA.manifest.model}/runs/${regionA.manifest.buildId}/sample`, '/v1/models/icon-eu/latest',
    `/v1/models/icon-eu/runs/${regional.manifest.buildId}/sample`]);
});

it('skips a finer model whose layer grid misses the center and keeps the previous frame across a tail gap', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse(autoTime(0)));
  const missed = autoBuild(fine.manifest.model, REGION_A_BOUNDS, [1, 18, 36]);
  const grid = { kind: 'regular-latlon' as const, width: 2, height: 2, earthRadiusM: 6_371_229, lon0: 0, lat0: 0, dx: 1, dy: 1, wrapLongitude: false };
  for (const surface of missed.manifest.surfaces) surface.grid = grid;
  const fetchImpl = vi.fn<typeof fetch>(async input => {
    const url = new URL(String(input)), model = url.pathname.split('/')[3];
    if (url.pathname.endsWith('/catalog')) return Response.json({ models: [autoCatalogRow(missed.manifest, 1000), autoCatalogRow(regionA.manifest, 3000)] });
    const build = model === missed.manifest.model ? missed : regionA;
    if (url.pathname.endsWith('/latest')) return Response.json(fixtureLatest(build.manifest));
    return Response.json(fixturePointSample(build, String(input)));
  });
  const api = new ApiClient({ baseUrl: 'https://api.test', fetchImpl });
  const selection = await resolveAutoBuild(api, { ...REGION_A_POINT, layers: ['usable-lift-agl'],
    validTimeMs: Date.parse(autoTime(18)), signal: new AbortController().signal });
  expect(selection?.build.manifest.model).toBe(regionA.manifest.model);
  const paths = fetchImpl.mock.calls.map(([input]) => new URL(String(input)).pathname);
  expect(paths.some(path => path.includes(`/${missed.manifest.model}/`) && path.endsWith('/sample'))).toBe(false);
  const gap = autoBuild('gfs', [-180, -55, 180, 65], [24, 27]).manifest.frames;
  expect(selectAutoFrame(gap, Date.parse(autoTime(25)))?.id).toBe('f024');
  expect(selectAutoFrame(gap, Date.parse(autoTime(26)))?.id).toBe('f027');
  expect(selectAutoFrame(gap, Date.parse(autoTime(22)))).toBeNull();
  expect(selectAutoFrame(gap, Date.parse(autoTime(28)))).toBeNull();
});

it('accepts older catalog rows through generated bounds and checks the pinned build', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse(autoTime(0)));
  const fetchImpl = vi.fn<typeof fetch>(async input => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/catalog')) return Response.json({ models: [{ model: 'gfs', available: true }, { model: 'icon-eu', available: true }] });
    if (path.endsWith('/latest')) return Response.json(fixtureLatest(regional.manifest));
    return Response.json(fixturePointSample(regional, String(input)));
  });
  const api = new ApiClient({ baseUrl: 'https://api.test', fetchImpl });
  const selection = await resolveAutoBuild(api, { ...REGION_A_POINT, layers: ['usable-lift-msl'],
    validTimeMs: Date.parse(autoTime(18)), signal: new AbortController().signal });
  expect(selection?.build.manifest.model).toBe('icon-eu');
});


it.each(['latest', 'sample'] as const)('falls back to the coarser model after a finer %s deadline', async route => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(autoTime(0)));
  // Native signal deadlines otherwise use a separate clock from Vitest's request timers.
  vi.spyOn(AbortSignal, 'timeout').mockImplementation(milliseconds => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException('Request timed out', 'TimeoutError')), milliseconds);
    return controller.signal;
  });
  const fetchImpl = vi.fn<typeof fetch>(async input => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/catalog')) return Response.json({ models: [models[1]!, models[2]!] });
    const build = path.startsWith(`/v1/models/${regionA.manifest.model}/`) ? regionA : regional;
    if (build === regionA && path.endsWith(`/${route}`)) return new Promise(() => {});
    if (path.endsWith('/latest')) return Response.json(fixtureLatest(build.manifest));
    return Response.json(fixturePointSample(build, String(input)));
  });
  const api = new ApiClient({ baseUrl: 'https://api.test', fetchImpl });
  const selection = resolveAutoBuild(api, { ...REGION_A_POINT, layers: ['usable-lift-msl'],
    validTimeMs: Date.parse(autoTime(18)), signal: new AbortController().signal });
  const fallback = expect(selection).resolves.toMatchObject({ build: { manifest: { model: 'icon-eu' } }, frame: { id: 'f018' } });
  await vi.advanceTimersByTimeAsync(DEFAULT_REQUEST_TIMEOUT_MS);
  await fallback;
});

it('falls through a globe view when the pinned GFS build misses the center', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse(autoTime(0)));
  const uncovered = autoBuild(global.manifest.model, [0, 0, 1, 1], [1, 18, 36, 60, 72]);
  const fetchImpl = vi.fn<typeof fetch>(async input => {
    const url = new URL(String(input)), model = url.pathname.split('/')[3];
    if (url.pathname.endsWith('/catalog')) return Response.json({ models: [autoCatalogRow(global.manifest, 27_800), autoCatalogRow(fine.manifest, 1000)] });
    const build = model === uncovered.manifest.model ? uncovered : fine;
    if (url.pathname.endsWith('/latest')) return Response.json(fixtureLatest(build.manifest));
    return Response.json(fixturePointSample(build, String(input)));
  });
  const api = new ApiClient({ baseUrl: 'https://api.test', fetchImpl });
  const selection = await resolveAutoBuild(api, { ...REGION_A_POINT, globe: true, layers: ['usable-lift-agl'],
    validTimeMs: Date.parse(autoTime(18)), signal: new AbortController().signal });
  expect(selection?.build.manifest.model).toBe(fine.manifest.model);
  expect(selection?.frame.id).toBe('f018');
});

it('pins live GFS without a sample when the location is missing', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse(autoTime(0)));
  const fetchImpl = vi.fn<typeof fetch>(async input => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/catalog')) return Response.json({ models });
    if (path.endsWith('/latest')) return Response.json(fixtureLatest(global.manifest));
    return Response.json(fixturePointSample(global, String(input)));
  });
  const api = new ApiClient({ baseUrl: 'https://api.test', fetchImpl });
  const signal = new AbortController().signal;
  const layers = ['usable-lift-msl'] as const;
  const selection = await resolveAutoBuild(api, { layers, validTimeMs: Date.parse(autoTime(18)), signal });
  expect(selection?.build.manifest.model).toBe(global.manifest.model);
  expect(selection?.frame.id).toBe('f018');
  const paths = () => fetchImpl.mock.calls.map(([input]) => new URL(String(input)).pathname);
  expect(paths()).toEqual(['/v1/catalog', `/v1/models/${global.manifest.model}/latest`]);
  const missing = await resolveAutoBuild(api, { lat: Number.NaN, lon: REGION_A_POINT.lon, globe: true, layers, validTimeMs: Date.parse(autoTime(18)), signal });
  expect(missing?.build.manifest.model).toBe(global.manifest.model);
  expect(paths().some(path => path.endsWith('/sample'))).toBe(false);
  const outside = await resolveAutoBuild(api, { layers, validTimeMs: Date.parse(autoTime(0)), signal });
  expect(outside).toBeNull();
  expect(paths().filter(path => path.endsWith('/latest'))).toHaveLength(2);

  const unavailable = vi.fn<typeof fetch>(async input => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/catalog')) return Response.json({ models: models.map(row => row.model === global.manifest.model ? { ...row, available: false } : row) });
    return Response.json(fixtureLatest(global.manifest));
  });
  const empty = await resolveAutoBuild(new ApiClient({ baseUrl: 'https://api.test', fetchImpl: unavailable }), { layers, signal });
  expect(empty).toBeNull();
  expect(unavailable.mock.calls.map(([input]) => new URL(String(input)).pathname)).toEqual(['/v1/catalog']);
});

it('selects GFS on a globe view over unmasked coordinates and falls back to camera viewport bounds offshore', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse(autoTime(0)));
  const builds = new Map([fine, regionA, regional, global].map(build => [build.manifest.model, build]));
  const fetchImpl = vi.fn<typeof fetch>(async input => {
    const url = new URL(String(input)), model = url.pathname.split('/')[3];
    if (url.pathname.endsWith('/catalog')) return Response.json({ models });
    const build = builds.get(model)!;
    if (url.pathname.endsWith('/latest')) return Response.json(fixtureLatest(build.manifest));
    const payload = fixturePointSample(build, String(input));
    for (const frame of payload.frames) for (const layer of Object.values(frame.layers)) {
      layer.status = 'outside-domain'; layer.value = null;
    }
    return Response.json(payload);
  });
  const api = new ApiClient({ baseUrl: 'https://api.test', fetchImpl });
  const signal = new AbortController().signal;

  // Startup globe view centered at (20, 0) in the Sahara Desert selects GFS without calling /sample.
  const globeSelection = await resolveAutoBuild(api, {
    lat: 20, lon: 0, globe: true, bounds: [-180, -60, 180, 75],
    layers: ['usable-lift-agl'], validTimeMs: Date.parse(autoTime(18)), signal
  });
  expect(globeSelection?.build.manifest.model).toBe('gfs');
  expect(fetchImpl.mock.calls.some(([input]) => new URL(String(input)).pathname.endsWith('/sample'))).toBe(false);

  // Regional view where the center is over water (all /sample calls return outside-domain) selects the finest model covering the viewport.
  const offshoreSelection = await resolveAutoBuild(api, {
    ...REGION_A_POINT, globe: false, bounds: REGION_A_BOUNDS,
    layers: ['usable-lift-agl'], validTimeMs: Date.parse(autoTime(18)), signal
  });
  expect(offshoreSelection?.build.manifest.model).toBe(fine.manifest.model);

  // Stale requested time outside all model windows clamps to a valid frame when camera viewport bounds are present.
  const clampedSelection = await resolveAutoBuild(api, {
    ...REGION_A_POINT, globe: false, bounds: REGION_A_BOUNDS,
    layers: ['usable-lift-agl'], validTimeMs: Date.parse(autoTime(0)), signal
  });
  expect(clampedSelection?.build.manifest.model).toBe(fine.manifest.model);
  expect(clampedSelection?.frame.id).toBe('f001');
});

it('prefers an offshore fallback whose grid holds the center over a finer grid that only overlaps the view', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse(autoTime(0)));
  const offset = autoBuild('offset-1km', [44.6, 38, 50, 43], [1, 18, 36]);
  const builds = new Map([regionA, offset].map(build => [build.manifest.model, build]));
  const fetchImpl = vi.fn<typeof fetch>(async input => {
    const url = new URL(String(input)), model = url.pathname.split('/')[3];
    if (url.pathname.endsWith('/catalog')) return Response.json({ models: [autoCatalogRow(regionA.manifest, 3000), autoCatalogRow(offset.manifest, 1000)] });
    const build = builds.get(model)!;
    if (url.pathname.endsWith('/latest')) return Response.json(fixtureLatest(build.manifest));
    const payload = fixturePointSample(build, String(input));
    for (const frame of payload.frames) for (const layer of Object.values(frame.layers)) { layer.status = 'outside-domain'; layer.value = null; }
    return Response.json(payload);
  });
  const selection = await resolveAutoBuild(new ApiClient({ baseUrl: 'https://api.test', fetchImpl }), {
    ...REGION_A_POINT, bounds: REGION_A_BOUNDS, layers: ['usable-lift-agl'], validTimeMs: Date.parse(autoTime(18)), signal: new AbortController().signal
  });
  expect(selection?.build.manifest.model).toBe(regionA.manifest.model);
});
