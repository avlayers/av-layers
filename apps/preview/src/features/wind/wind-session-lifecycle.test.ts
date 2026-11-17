import { afterEach, expect, it, vi } from 'vitest';
import { createPreparationBudget, type PreparationBudget, type PreparationLease } from '@av/client';
import { WindCapacityError, type WindPreparedGrid } from '@av/client/wind';
import { fixtureBuild } from '../../../../../tests/forecast-fixture';
import type { WindHeight } from './wind-model';

interface Request { frame: string; bounds: [number, number, number, number]; signal: AbortSignal; finerThan?: number }
interface Source {
  frame: string; request?: Request; disposed: number; settled: boolean;
  resolve?: (status: 'ready' | 'unavailable') => void; reject?: (error: Error) => void;
}
const wind = vi.hoisted(() => ({
  overview: false, deferredLoads: false, deferredHeights: new Set<WindHeight>(), sources: [] as Source[],
  preparations: [] as Array<{ source: Source; height: WindHeight; signal: AbortSignal; resolve(): void }>
}));

vi.mock('@av/client/wind', () => {
  class WindCapacityError extends Error {
    readonly code = 'capacity';
    constructor(_message?: string, readonly resource: 'numeric' | 'preparation' = 'preparation') { super('Wind cache exceeds byte budget'); }
  }
  return { WindCapacityError, WindDataSource: class implements Source {
    frame = ''; disposed = 0; settled = false; request?: Request;
    readonly isOverview = wind.overview;
    overviewStride = wind.overview ? 4 : null;
    admitted?: Request['bounds'];
    resolve?: Source['resolve']; reject?: Source['reject'];
    private readonly grids = new Map<WindHeight, { grid: WindPreparedGrid; lease?: PreparationLease }>();
    private readonly fields = new Map<WindHeight, PreparationLease | undefined>();
    constructor(_url: string, private readonly options: { budget?: PreparationBudget }) { wind.sources.push(this); }
    load(request: Request): Promise<'ready' | 'unavailable'> {
      this.request = request; this.frame = request.frame; this.admitted = request.bounds;
      if (request.finerThan) this.overviewStride = request.finerThan / 2;
      if (wind.deferredLoads || request.finerThan) return new Promise((resolve, reject) => {
        this.resolve = status => { this.settled = true; resolve(status); };
        this.reject = error => { this.settled = true; reject(error); };
      });
      this.settled = true; return Promise.resolve('ready');
    }
    promote() {} setPriority() {}
    hasPrepared(height: WindHeight) { return this.grids.has(height); }
    hasField(height: WindHeight) { return this.fields.has(height); }
    prepare(height: WindHeight): WindPreparedGrid {
      const cached = this.grids.get(height); if (cached) return cached.grid;
      const lease = this.options.budget?.reserve('wind-prepared', 80);
      if (this.options.budget && !lease) throw new WindCapacityError();
      const grid: WindPreparedGrid = { bounds: this.admitted!, data: new Uint8Array(4), size: 1, height, key: `${this.frame}:${height}` };
      this.grids.set(height, { grid, lease: lease ?? undefined }); return grid;
    }
    prepareAsync(height: WindHeight, { signal }: { signal: AbortSignal }): Promise<WindPreparedGrid> {
      if (!wind.deferredHeights.has(height)) return Promise.resolve().then(() => this.prepare(height));
      return new Promise(resolve => wind.preparations.push({ source: this, height, signal, resolve: () => {
        // A deliberately late producer verifies session ownership even after cancellation.
        resolve({ bounds: this.admitted!, data: new Uint8Array(4), size: 1, height, key: `${this.frame}:${height}` });
        if (!this.disposed) this.prepare(height);
      } }));
    }
    field(height: WindHeight) {
      if (!this.fields.has(height)) {
        const lease = this.options.budget?.reserve('wind-sampler', 120);
        if (this.options.budget && !lease) throw new WindCapacityError();
        this.fields.set(height, lease ?? undefined);
      }
      return { sample: () => ({ u: 1, v: 2, status: 0 }) };
    }
    trimHeights(height: WindHeight) {
      for (const [key, value] of this.grids) if (key !== height) { value.lease?.release(); this.grids.delete(key); }
      for (const [key, value] of this.fields) if (key !== height) { value?.release(); this.fields.delete(key); }
    }
    dispose() {
      if (this.disposed++) return;
      for (const value of this.grids.values()) value.lease?.release();
      for (const value of this.fields.values()) value?.release();
      this.grids.clear(); this.fields.clear();
    }
  } };
});

import { createWindSession, type WindSession } from './wind-session';

const opened: WindSession[] = [];
afterEach(() => {
  for (const session of opened.splice(0)) session.destroy();
  vi.useRealTimers(); wind.sources.length = 0; wind.preparations.length = 0;
  wind.overview = wind.deferredLoads = false; wind.deferredHeights.clear();
});

function harness(budget?: PreparationBudget) {
  const build = fixtureBuild();
  build.expiresAtMs = Date.now() + 86400000;
  build.manifest.mapData = { sha256: 'a'.repeat(64), bytes: 1 };
  const first = build.manifest.frames[0]!;
  build.manifest.frames = Array.from({ length: 40 }, (_, i) => ({ ...first, id: `f${i}`, validTime: new Date(Date.now() + i * 3600000).toISOString() }));
  build.manifest.mapFrameCount = 40;
  const state = { build, selectedFrame: 'f0', height: 'surface' as WindHeight, visible: true, mapReady: true, expired: false, mapFailed: false, aborted: false };
  let bounds = [44, 40, 45, 41];
  const field = { install: vi.fn(), setField: vi.fn(), setPrepared: vi.fn(), clear: vi.fn() };
  const publish = { status: vi.fn(), quality: vi.fn(), displayed: vi.fn(), reservation: vi.fn(), pointWind: vi.fn() };
  const cache = { allocatedBytes: 1024, isBuildUnavailable: () => false, clear: vi.fn(), evictUnreferenced: vi.fn(() => 0), onRelease: null as null | (() => void) };
  const session = createWindSession({ apiBaseUrl: 'https://api.test', lowMemory: true, budget, cache, field,
    map: { getZoom: () => 8, getBounds: () => ({ getWest: () => bounds[0]!, getSouth: () => bounds[1]!, getEast: () => bounds[2]!, getNorth: () => bounds[3]! }) },
    scheduler: { fetch }, overlay: { setWindActive: vi.fn() }, state: () => state,
    displayedRaster: () => ({ build: state.build, frame: state.selectedFrame }), replacementFailed: () => false,
    publish
  });
  opened.push(session);
  return { session, state, field, cache, publish, setBounds(value: number[]) { bounds = value; } };
}

async function resolveHorizon() {
  for (let wave = 0; wave < 12; wave++) {
    for (const source of wind.sources) if (!source.request?.finerThan && !source.settled) source.resolve?.('ready');
    await vi.advanceTimersByTimeAsync(10);
  }
}

it.each(['numeric', 'preparation'] as const)('continues the coarse horizon after an optional %s upgrade fails', async resource => {
  vi.useFakeTimers(); wind.overview = wind.deferredLoads = true;
  const budget = createPreparationBudget(20000), held = budget.reserve('other', 10000)!;
  const f = harness(budget); f.session.update(); wind.sources[0]!.resolve!('ready');
  await vi.advanceTimersByTimeAsync(150);
  const upgrade = wind.sources.find(source => source.request?.finerThan)!;
  expect(upgrade).toBeDefined();
  upgrade.reject!(new WindCapacityError(undefined, resource));
  await resolveHorizon();
  expect(f.session.preparation).toMatchObject({ promised: 40, ready: 40, limited: false });
  expect(wind.sources.filter(source => source.request?.finerThan)).toHaveLength(1);
  if (resource === 'numeric') { f.cache.allocatedBytes--; f.cache.onRelease?.(); }
  else held.release();
  await vi.advanceTimersByTimeAsync(200);
  expect(wind.sources.filter(source => source.request?.finerThan)).toHaveLength(2);
  held.release();
});

it.each(['time', 'view', 'build', 'height'] as const)('cancels an upgrade on %s change and ignores its late failure', async change => {
  vi.useFakeTimers(); wind.overview = wind.deferredLoads = true;
  const f = harness(); f.session.update(); wind.sources[0]!.resolve!('ready');
  await vi.advanceTimersByTimeAsync(150);
  const upgrade = wind.sources.find(source => source.request?.finerThan)!;
  if (change === 'time') f.state.selectedFrame = 'f1';
  else if (change === 'view') f.setBounds([46, 40, 47, 41]);
  else if (change === 'build') f.state.build = { ...f.state.build, manifest: { ...f.state.build.manifest, buildId: `${f.state.build.manifest.buildId}-next` } };
  else { f.state.height = 500; f.session.heightChanged('surface'); }
  f.session.update();
  expect(upgrade.request!.signal.aborted).toBe(true);
  expect(upgrade.disposed).toBeGreaterThan(0);
  upgrade.reject!(new WindCapacityError(undefined, 'numeric'));
  await resolveHorizon();
  expect(f.session.preparation).toMatchObject({ ready: 40, limited: false });
  expect(f.session.installed?.source).not.toBe(upgrade);
});

it('keeps only the latest pending height eligible for installation', async () => {
  vi.useFakeTimers(); const f = harness();
  f.session.update(); await vi.advanceTimersByTimeAsync(1000);
  wind.deferredHeights.add(500); wind.deferredHeights.add(1000);
  f.state.height = 500; f.session.heightChanged('surface');
  const old = wind.preparations[0]!;
  f.state.height = 1000; f.session.heightChanged(500);
  const current = wind.preparations[1]!;
  expect(old.signal.aborted).toBe(true);
  current.resolve(); await vi.advanceTimersByTimeAsync(0);
  expect(f.session.installed?.height).toBe(1000);
  old.resolve(); await vi.advanceTimersByTimeAsync(0);
  expect(f.session.installed?.height).toBe(1000);
  expect(f.session.ready.get('f0')?.has(500)).toBe(false);
});

it('cancels an upgrade preparation when the height changes and ignores its late grid', async () => {
  vi.useFakeTimers(); wind.overview = true;
  const f = harness(); f.session.update(); await vi.advanceTimersByTimeAsync(1000);
  const upgrade = wind.sources.find(source => source.request?.finerThan)!;
  wind.deferredHeights.add('surface');
  upgrade.resolve!('ready'); await vi.advanceTimersByTimeAsync(0);
  const preparation = wind.preparations.find(item => item.source === upgrade)!;
  expect(preparation).toBeDefined();
  f.state.height = 500; f.session.heightChanged('surface');
  expect(preparation.signal.aborted).toBe(true);
  expect(upgrade.disposed).toBeGreaterThan(0);
  preparation.resolve(); await vi.advanceTimersByTimeAsync(1000);
  expect(f.session.installed?.source).not.toBe(upgrade);
  expect(f.session.installed?.height).toBe(500);
  expect(f.session.preparation).toMatchObject({ ready: 40, limited: false });
});

it('cancels a parked viewport preparation before its late completion', async () => {
  vi.useFakeTimers(); const f = harness(); f.session.update(); await vi.advanceTimersByTimeAsync(1000);
  wind.deferredHeights.add(500);
  f.state.height = 500; f.session.heightChanged('surface'); const old = wind.preparations[0]!;
  wind.deferredHeights.clear(); f.setBounds([46, 40, 47, 41]); f.session.update();
  expect(old.signal.aborted).toBe(true);
  await vi.advanceTimersByTimeAsync(1000); const current = f.session.installed?.source;
  old.resolve(); await vi.advanceTimersByTimeAsync(0);
  expect(f.session.installed?.source).toBe(current);
  expect(f.session.installed?.source).not.toBe(old.source);
});

it('trims historical heights under pressure while preserving every active-height frame', async () => {
  vi.useFakeTimers(); const budget = createPreparationBudget(18000), f = harness(budget);
  f.session.update(); await vi.advanceTimersByTimeAsync(1000);
  f.state.height = 500; f.session.heightChanged('surface'); await vi.advanceTimersByTimeAsync(1000);
  expect(budget.used).toBe(16000);
  f.state.height = 1000; f.session.heightChanged(500); await vi.advanceTimersByTimeAsync(1000);
  expect(f.session.preparation).toMatchObject({ ready: 40, limited: false });
  expect(wind.sources).toHaveLength(40);
  expect(wind.sources.every(source => source.disposed === 0)).toBe(true);
  expect([...f.session.ready.values()].every(heights => heights.has(1000))).toBe(true);
  expect(budget.used).toBe(8000);
});

it('completes source disposal and unsubscription when clearing the field throws', async () => {
  vi.useFakeTimers(); const budget = createPreparationBudget(18000), f = harness(budget);
  f.session.update(); await vi.advanceTimersByTimeAsync(1000);
  f.field.clear.mockImplementation(() => { throw new Error('lost graphics context'); });
  expect(() => f.session.destroy()).toThrow('lost graphics context');
  expect(wind.sources.every(source => source.disposed > 0)).toBe(true);
  expect(budget.used).toBe(0);
  expect(f.cache.onRelease).toBeNull();
  const count = wind.sources.length;
  await vi.advanceTimersByTimeAsync(1000); f.session.update();
  expect(wind.sources).toHaveLength(count);
});

it('contains an async display failure, keeps healthy data and retries on the next intent', async () => {
  vi.useFakeTimers(); const f = harness();
  f.field.install.mockImplementationOnce(() => { throw new Error('GPU installation failed'); });
  f.session.update(); await vi.advanceTimersByTimeAsync(1000);
  expect(f.field.install).toHaveBeenCalledOnce();
  expect(f.session.installed).toBeNull();
  expect(f.session.preparation).toMatchObject({ ready: 40, limited: false });
  expect(wind.sources).toHaveLength(40);
  expect(wind.sources.every(source => source.disposed === 0)).toBe(true);
  f.session.update();
  expect(f.field.install).toHaveBeenCalledTimes(2);
  expect(f.session.installed?.frame).toBe('f0');
  expect(wind.sources).toHaveLength(40);
});

it('contains a clear failure while an async selected frame replaces the installed frame', async () => {
  vi.useFakeTimers(); wind.deferredLoads = true;
  const f = harness(); f.session.update(); wind.sources[0]!.resolve!('ready');
  await vi.advanceTimersByTimeAsync(10);
  expect(f.session.installed?.frame).toBe('f0');
  f.state.selectedFrame = 'f1'; f.session.update();
  f.field.clear.mockImplementationOnce(() => { throw new Error('GPU clear failed'); });
  await resolveHorizon();
  expect(f.field.install).toHaveBeenCalledOnce();
  expect(f.session.installed).toBeNull();
  expect(f.session.preparation).toMatchObject({ ready: 40, limited: false });
  expect(wind.sources).toHaveLength(40);
  expect(wind.sources.every(source => source.disposed === 0)).toBe(true);
  f.session.update();
  expect(f.field.install).toHaveBeenCalledTimes(2);
  expect(f.session.installed?.frame).toBe('f1');
});

it('keeps an outgoing viewport source owned when clearing its graphics fails', async () => {
  vi.useFakeTimers(); const budget = createPreparationBudget(18000), f = harness(budget);
  f.session.update(); await vi.advanceTimersByTimeAsync(1000);
  const previous = f.session.installed!.source;
  f.field.clear.mockImplementationOnce(() => { throw new Error('GPU clear failed during pan'); });
  f.setBounds([46, 40, 47, 41]);
  expect(() => f.session.update()).not.toThrow();
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.session.installed?.source).not.toBe(previous);
  expect(f.session.preparation).toMatchObject({ ready: 40, limited: false });
  f.session.destroy();
  expect(wind.sources.every(source => source.disposed > 0)).toBe(true);
  expect(budget.used).toBe(0);
});

it('installs an adopted upgrade when clearing the outgoing graphics fails', async () => {
  vi.useFakeTimers(); wind.overview = true;
  const budget = createPreparationBudget(18000), f = harness(budget);
  f.session.update(); await vi.advanceTimersByTimeAsync(1000);
  const upgrade = wind.sources.find(source => source.request?.finerThan)!;
  expect(f.session.installed?.frame).toBe('f0');
  f.field.clear.mockImplementationOnce(() => { throw new Error('GPU clear failed during upgrade'); });
  upgrade.resolve!('ready'); await vi.advanceTimersByTimeAsync(0);
  expect(f.session.installed?.source).toBe(upgrade);
  expect(f.session.preparation).toMatchObject({ ready: 40, limited: false });
  f.session.destroy();
  expect(budget.used).toBe(0);
});

it.each(['numeric', 'preparation'] as const)('retries %s admission when the first cache eviction frees capacity', async resource => {
  vi.useFakeTimers(); wind.deferredLoads = true;
  const budget = createPreparationBudget(18000), cached = budget.reserve('unreferenced-wind', 1024)!;
  const f = harness(budget);
  f.cache.evictUnreferenced.mockImplementationOnce(() => {
    f.cache.allocatedBytes = 0; cached.release(); return 1024;
  });
  f.session.update();
  wind.sources[0]!.reject!(new WindCapacityError(undefined, resource));
  await vi.advanceTimersByTimeAsync(0);
  expect(f.session.preparation.limited).toBe(false);
  expect(wind.sources.filter(source => source.frame === 'f0')).toHaveLength(2);
  await resolveHorizon();
  expect(f.session.preparation).toMatchObject({ ready: 40, limited: false });
  f.session.destroy();
  expect(budget.used).toBe(0);
});

it('keeps a cleared session idle when a completed preparation finalizer is still queued', async () => {
  vi.useFakeTimers(); wind.deferredHeights.add('surface');
  const budget = createPreparationBudget(18000), f = harness(budget);
  f.session.update(); await vi.advanceTimersByTimeAsync(0);
  expect(wind.preparations).toHaveLength(1);
  wind.preparations[0]!.resolve();
  await Promise.resolve();
  f.session.clear();
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.session.resident).toBe(false);
  expect(wind.sources).toHaveLength(1);
  expect(wind.sources[0]!.disposed).toBeGreaterThan(0);
  expect(budget.used).toBe(0);
});

it.each(['height', 'raster'] as const)('contains a graphics clear failure during a %s transition', async transition => {
  vi.useFakeTimers(); const budget = createPreparationBudget(18000), f = harness(budget);
  f.session.update(); await vi.advanceTimersByTimeAsync(1000);
  f.field.clear.mockImplementationOnce(() => { throw new Error('GPU clear failed during transition'); });
  if (transition === 'height') f.state.height = 1500;
  else f.state.selectedFrame = 'f1';
  const change = () => transition === 'height'
    ? f.session.heightChanged('surface')
    : f.session.beforeRasterReveal({ build: f.state.build, frame: f.state.selectedFrame });
  expect(change).not.toThrow();
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.session.installed).toBeNull();
  expect(f.session.preparation).toMatchObject({ ready: 40, limited: false });
  f.session.update();
  expect(f.session.installed).toMatchObject({ frame: f.state.selectedFrame, height: f.state.height });
  expect(wind.sources).toHaveLength(40);
  f.session.destroy(); expect(budget.used).toBe(0);
});

it.each(['clear', 'destroy'] as const)('does not revive a session when graphics installation calls %s', async action => {
  vi.useFakeTimers(); const budget = createPreparationBudget(18000), f = harness(budget);
  f.field.install.mockImplementationOnce(() => f.session[action]());
  f.session.update(); await vi.advanceTimersByTimeAsync(1000);
  expect(f.session.installed === null).toBe(true);
  expect(f.session.displayed).toBe(false);
  expect(f.session.resident).toBe(false);
  expect(f.publish.displayed).toHaveBeenLastCalledWith(false);
  expect(f.publish.status).toHaveBeenLastCalledWith('unavailable');
  expect(wind.sources).toHaveLength(1);
  expect(wind.sources.every(source => source.disposed > 0)).toBe(true);
  expect(budget.used).toBe(0);
  if (action === 'destroy') expect(f.cache.onRelease).toBeNull();
});
