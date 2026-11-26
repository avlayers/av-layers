import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Map as MapLibreMap } from 'maplibre-gl';
import type { ApiClient, PinnedBuild } from '@av/client';
import type { SynopticField } from './synoptic-sampler';

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };
const deferred = <T,>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>(r => { resolve = r; }), resolve };
};

const sampler = {
  cache: new Map<string, SynopticField>(),
  loads: new Map<string, Deferred<SynopticField | null | undefined>>(),
  findCached: (build: PinnedBuild, frame: string) => sampler.cache.get(`${build.manifest.buildId}:${frame}`) ?? null,
  load(build: PinnedBuild, frame: string) {
    const d = deferred<SynopticField | null | undefined>();
    sampler.loads.set(`${build.manifest.buildId}:${frame}`, d);
    return d.promise;
  },
  current: null, pauseWarming() {}, warmHorizon() {}, resetActive() {}, dispose() {}
};
const clouds = { painted: [] as string[], visible: false, paint(field: SynopticField) { this.painted.push(field.frame); }, syncVisibilityAndStyle(_s: unknown, _o: number, visible: boolean) { this.visible = visible; }, clear() {} };
const isobars = { painted: [] as string[], visible: false, paint(field: SynopticField) { this.painted.push(field.frame); }, syncStyleAndVisibility(_s: unknown, visible: boolean) { this.visible = visible; }, clear() {} };
const rain = {
  cached: new Set<string>(), refreshes: [] as Deferred<boolean>[], visible: false,
  tryPaintCached: (build: PinnedBuild, frame: string) => rain.cached.has(`${build.manifest.buildId}:${frame}`),
  refresh() { const d = deferred<boolean>(); rain.refreshes.push(d); return d.promise; },
  findCachedField: () => null, syncStyleAndVisibility(_s: unknown, _o: number, visible: boolean) { rain.visible = visible; },
  repaintCurrent() {}, pauseWarming() {}, warmHorizon() {}, clear() {}, dispose() {}
};

vi.mock('../raster/tile-remap', () => ({ canRemapTiles: () => true }));
vi.mock('./synoptic-sampler', async importActual => ({ ...await importActual<object>(), SynopticSampler: class { constructor() { return sampler; } } }));
vi.mock('./cloud-layer', () => ({ CloudLayerController: class { constructor() { return clouds; } } }));
vi.mock('./isobar-layer', () => ({ IsobarLayerController: class { constructor() { return isobars; } } }));
vi.mock('./rain-layer', () => ({ RainLayerController: class { constructor() { return rain; } } }));

const { SkyComposite } = await import('./sky-composite');
const { DEFAULT_THEME } = await import('../../themes/registry');

const map = {
  addSource() {}, getStyle() {}, on() {}, off() {}, isMoving: () => false,
  getBounds: () => ({ getWest: () => 40, getEast: () => 50, getSouth: () => 35, getNorth: () => 45 })
} as unknown as MapLibreMap;
const build = (id: string) => ({ manifest: { buildId: id, layers: ['cloud-cover-total', 'mslp-hpa'] }, templates: { 'precip-rate': 't' }, expiresAtMs: Date.now() + 3_600_000 }) as unknown as PinnedBuild;
const field = (buildId: string, frame: string, extra: Partial<SynopticField> = {}) =>
  ({ id: `${buildId}:${frame}`, buildId, frame, hasClouds: true, hasMslp: true, cloudsEvaluated: true, mslpEvaluated: true, ...extra }) as SynopticField;
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

function create(options: { clouds?: boolean; rain?: boolean; isobars?: boolean } = {}) {
  const statuses: unknown[] = [];
  const sky = new SkyComposite(map, {} as ApiClient, 'https://api.test', {
    theme: DEFAULT_THEME, opacity: 1,
    cloudsVisible: options.clouds ?? true, rainVisible: options.rain ?? false, isobarsVisible: options.isobars ?? true,
    onStatus: status => statuses.push(status)
  });
  return { sky, statuses };
}

beforeEach(() => {
  sampler.cache.clear(); sampler.loads.clear(); rain.cached.clear(); rain.refreshes.length = 0;
  clouds.painted.length = 0; isobars.painted.length = 0;
});

describe('SkyComposite selection identity', () => {
  const b1 = build('b1');

  it('hides the previous hour while the next loads, and keeps it hidden when the load returns nothing', async () => {
    const { sky, statuses } = create();
    sampler.cache.set('b1:f0', field('b1', 'f0'));
    sky.select(b1, 'f0');
    expect(clouds.visible && isobars.visible).toBe(true);

    sky.select(b1, 'f1');
    expect(clouds.visible || isobars.visible).toBe(false);
    expect(statuses.at(-1)).toEqual({ clouds: 'loading', isobars: 'loading' });

    sampler.loads.get('b1:f1')!.resolve(null);
    await flush();
    expect(clouds.visible || isobars.visible).toBe(false);
    expect(statuses.at(-1)).toEqual({ clouds: 'unavailable', isobars: 'unavailable' });
  });

  it('leaves a channel empty when the replacement has no valid cells, and clears pressure lines and centres together', async () => {
    const { sky, statuses } = create();
    sampler.cache.set('b1:f0', field('b1', 'f0'));
    sky.select(b1, 'f0');
    sky.select(b1, 'f1');
    sampler.loads.get('b1:f1')!.resolve(field('b1', 'f1', { hasMslp: false }));
    await flush();
    expect(clouds.visible).toBe(true);
    expect(isobars.visible).toBe(false);
    expect(statuses.at(-1)).toEqual({ clouds: 'ready', isobars: 'unavailable' });
  });

  it('asks again when a prefetch evicts the selected hour, and stays loading', async () => {
    const { sky, statuses } = create();
    sky.select(b1, 'f1');
    sampler.loads.get('b1:f1')!.resolve(undefined);
    await flush();
    expect(statuses.at(-1)).toEqual({ clouds: 'loading', isobars: 'loading' });
    sampler.loads.get('b1:f1')!.resolve(field('b1', 'f1'));
    await flush();
    expect(clouds.visible).toBe(true);
    expect(statuses.at(-1)).toEqual({ clouds: 'ready', isobars: 'ready' });
  });

  it('ignores a late result for an hour no longer selected', async () => {
    const { sky } = create();
    sky.select(b1, 'f0');
    sampler.cache.set('b1:f1', field('b1', 'f1'));
    sky.select(b1, 'f1');
    sampler.loads.get('b1:f0')!.resolve(field('b1', 'f0'));
    await flush();
    expect(clouds.painted).toEqual(['f1']);
    expect(clouds.visible).toBe(true);
  });

  it('swaps straight to a cached hour from another build without a fetch', () => {
    const { sky } = create();
    sampler.cache.set('b1:f0', field('b1', 'f0'));
    sampler.cache.set('b2:f0', field('b2', 'f0'));
    sky.select(b1, 'f0');
    sky.select(build('b2'), 'f0');
    expect(sampler.loads.size).toBe(0);
    expect(clouds.painted).toEqual(['f0', 'f0']);
    expect(clouds.visible).toBe(true);
  });

  it('hides old rain when the new hour fails, and reports it unavailable', async () => {
    const { sky, statuses } = create({ clouds: false, isobars: false, rain: true });
    rain.cached.add('b1:f0');
    sky.select(b1, 'f0');
    expect(rain.visible).toBe(true);
    sky.select(b1, 'f1');
    expect(rain.visible).toBe(false);
    rain.refreshes[0]!.resolve(false);
    await flush();
    expect(rain.visible).toBe(false);
    expect(statuses.at(-1)).toEqual({ rain: 'unavailable' });
  });

  it('keeps the same hour drawn while a pan loads a wider field', async () => {
    const { sky, statuses } = create();
    sky.select(b1, 'f0');
    sampler.loads.get('b1:f0')!.resolve(field('b1', 'f0'));
    await flush();
    sky.select(b1, 'f0');
    expect(clouds.visible).toBe(true);
    expect(statuses.at(-1)).toEqual({ clouds: 'ready', isobars: 'ready' });
  });

  it('reuses a ready hour when a channel is hidden and shown again', () => {
    const { sky } = create();
    sampler.cache.set('b1:f0', field('b1', 'f0'));
    sky.select(b1, 'f0');
    sky.setVisibility({ cloudsVisible: false });
    expect(clouds.visible).toBe(false);
    sky.setVisibility({ cloudsVisible: true });
    expect(clouds.visible).toBe(true);
    expect(sampler.loads.size).toBe(0);
  });

  it('reports a layer the build does not publish as unavailable from the cache too', () => {
    const { sky, statuses } = create();
    const cloudsOnly = { ...build('n1'), manifest: { buildId: 'n1', layers: ['cloud-cover-total'] } } as unknown as PinnedBuild;
    sampler.cache.set('n1:f1', field('n1', 'f1', { hasMslp: false, mslpEvaluated: false }));
    sky.select(cloudsOnly, 'f1');
    expect(statuses.at(-1)).toEqual({ clouds: 'ready', isobars: 'unavailable' });
  });
});
