import { afterEach, expect, it, vi } from 'vitest';
import { renderedFrames } from '@av/contracts/publication';
import { createPreparationBudget, type PinnedBuild, type PreparationBudget } from '@av/client';
import { fixtureBuild } from '../../../../../tests/forecast-fixture';
import type { WindHeight } from './wind-model';

const wind = vi.hoisted(() => ({
  sources: [] as Array<{
    frame: string; disposed: number; prepared: Set<string | number>; fetchImpl: typeof fetch;
    requests: Array<{ frame: string; bounds: number[]; core?: number[]; signal: AbortSignal; startedAt: number }>;
    resolve: ((status: 'ready' | 'unavailable') => void) | null;
    reject: ((error: Error) => void) | null;
    promote: () => void;
    setPriority: (priority: 'foreground' | 'background') => void;
    settled: boolean;
    fields: Set<string | number>;
    fieldBuilds: number;
    memoryCalls: number;
  }>,
  deferred: false,
  unavailable: new Set<string>(),
  preparations: [] as Array<[string, string | number]>,
  events: [] as string[],
  capacityFrame: '', capacityAvailable: false, reserved: 0,
  fieldCapacity: false,
  prepareUnavailable: new Set<string | number>(),
  prepareCapacity: new Set<string | number>(),
  prepareFailFrame: '',
  numericLimit: 0, numericUsed: 0, numericChunk: 12 * 1024 * 1024,
  overview: false
}));

vi.mock('@av/client/wind', () => {
  class WindCapacityError extends Error {
    readonly code = 'capacity';
    constructor(readonly resource: 'numeric' | 'preparation') { super('Wind cache exceeds byte budget'); }
  }
  return {
  WindCapacityError,
  WindDataSource: class {
    frame = '';
    disposed = 0;
    readonly prepared = new Set<string | number>();
    readonly fields = new Set<string | number>();
    fieldBuilds = 0;
    memoryCalls = 0;
    readonly requests: Array<{ frame: string; bounds: number[]; core?: number[]; signal: AbortSignal; startedAt: number }> = [];
    readonly admitted = undefined;
    readonly isOverview = wind.overview;
    readonly fetchImpl: typeof fetch;
    reservation = false;
    lease: { release(): void } | null = null;
    numeric = 0;
    budget?: PreparationBudget;
    resolve: ((status: 'ready' | 'unavailable') => void) | null = null;
    reject: ((error: Error) => void) | null = null;
    promote = vi.fn();
    setPriority = vi.fn();
    settled = false;
    constructor(_base: string, options: { fetchImpl: typeof fetch; budget?: PreparationBudget }) { this.fetchImpl = options.fetchImpl; this.budget = options.budget; wind.sources.push(this); }
    load(request: { frame: string; bounds: number[]; core?: number[]; signal: AbortSignal }): Promise<'ready' | 'unavailable'> {
      this.frame = request.frame; this.requests.push({ ...request, startedAt: Date.now() });
      if (wind.numericLimit) {
        if (wind.numericUsed + wind.numericChunk > wind.numericLimit) return Promise.reject(new WindCapacityError('numeric'));
        const lease = this.budget?.reserve('wind-numeric', wind.numericChunk);
        if (this.budget && !lease) return Promise.reject(new RangeError('Wind cache exceeds byte budget'));
        this.lease = lease ?? null; this.numeric = wind.numericChunk; wind.numericUsed += this.numeric;
      }
      if (request.frame === wind.capacityFrame && !wind.capacityAvailable) {
        this.reservation = true; wind.reserved++;
        return Promise.reject(new RangeError('Wind cache exceeds byte budget'));
      }
      if (wind.deferred) return new Promise((resolve, reject) => { this.resolve = value => { this.settled = true; resolve(value); }; this.reject = error => { this.settled = true; reject(error); }; });
      this.settled = true;
      return Promise.resolve(wind.unavailable.has(request.frame) ? 'unavailable' : 'ready');
    }
    dispose(): void { wind.events.push(`dispose:${this.frame}`); this.disposed++; if (this.reservation) { this.reservation = false; wind.reserved--; } wind.numericUsed -= this.numeric; this.numeric = 0; this.lease?.release(); this.lease = null; }
    prepare(height: WindHeight) {
      this.prepared.add(height); wind.preparations.push([this.frame, height]); wind.events.push(`prepare:${height}`);
      if (this.frame === wind.prepareFailFrame) throw new Error('prepare failed');
      if (wind.prepareCapacity.has(height)) throw new RangeError('Wind cache exceeds byte budget');
      if (wind.prepareUnavailable.has(height)) return undefined;
      return { bounds: [0, 0, 1, 1] as [number, number, number, number], data: new Uint8Array(4), size: 1, height, key: `${this.frame}:${height}` };
    }
    hasPrepared(height: WindHeight): boolean { return this.prepared.has(height); }
    hasField(height: WindHeight): boolean { return this.fields.has(height); }
    field(height: WindHeight) {
      if (wind.fieldCapacity) throw new RangeError('Wind cache exceeds byte budget');
      if (!this.fields.has(height)) { this.fields.add(height); this.fieldBuilds++; }
      return { sample: () => ({ u: height === 500 ? 5 : 1, v: 2, status: 0 }) };
    }
    sample(_lat: number, _lon: number, _height: WindHeight) { return { u: 1, v: 2, status: 'valid' }; }
    memoryUsage() { this.memoryCalls++; return { preparedBytes: 0, fieldSamplerBytes: 0, numericBytes: 0, horizonNumericRemaining: 4096 }; }
  }
}; });

import { createWindSession, type WindSession } from './wind-session';

type ProposedSession = WindSession & {
  readonly ready: ReadonlyMap<string, ReadonlySet<WindHeight>>;
  readonly staged: { build: PinnedBuild; frame: string; height: WindHeight } | null;
  beforeRasterReveal(target: { build: PinnedBuild; frame: string }): void;
};

const opened: WindSession[] = [];
afterEach(() => {
  for (const session of opened.splice(0)) session.destroy();
  vi.useRealTimers(); wind.sources.length = 0; wind.preparations.length = 0;
  wind.unavailable.clear(); wind.deferred = false; wind.overview = false;
  wind.capacityFrame = ''; wind.capacityAvailable = false; wind.reserved = 0;
  wind.fieldCapacity = false;
  wind.prepareUnavailable.clear(); wind.prepareCapacity.clear();
  wind.prepareFailFrame = '';
  wind.numericLimit = wind.numericUsed = 0;
  wind.events.length = 0;
});

function harness(lowMemory = false, budget?: PreparationBudget) {
  const build = fixtureBuild();
  (build as { expiresAtMs: number }).expiresAtMs = Date.now() + 86_400_000;
  (build.manifest as unknown as { mapData: { sha256: string; bytes: number } }).mapData = { sha256: 'a', bytes: 1 };
  const frames = renderedFrames(build.manifest).map(frame => frame.id);
  const state: { build: PinnedBuild; selectedFrame: string; height: WindHeight; visible: boolean; mapReady: boolean; expired: boolean; mapFailed: boolean; aborted: boolean } = {
    build, selectedFrame: frames[0]!, height: 'surface', visible: true, mapReady: true, expired: false, mapFailed: false, aborted: false
  };
  let bounds = { west: -110, east: -90, south: 30, north: 45 };
  let raster: { build: PinnedBuild; frame: string } | null = null;
  const scheduler = { fetch: vi.fn(async () => new Response()) as typeof fetch };
  const cache = { isBuildUnavailable: () => false, get allocatedBytes() { return wind.numericLimit ? wind.numericUsed : wind.capacityFrame && !wind.capacityAvailable ? 1024 : 0; }, clear: vi.fn(), onRelease: null as null | (() => void) };
  const field = { install: vi.fn(), setField: vi.fn(), setPrepared: vi.fn(), clear: vi.fn(() => { wind.events.push('clear'); }) };
  const publish = { status: vi.fn(), quality: vi.fn(), displayed: vi.fn(), reservation: vi.fn(), pointWind: vi.fn() };
  const selectedPending = vi.fn();
  const relieveDisplay = vi.fn<() => boolean>(() => false);
  const session = createWindSession({
    apiBaseUrl: 'https://api.test', lowMemory, scheduler, cache, budget, field, publish, selectedPending, relieveDisplay,
    map: { getZoom: () => 5, getBounds: () => ({ getWest: () => bounds.west, getEast: () => bounds.east, getSouth: () => bounds.south, getNorth: () => bounds.north }) },
    overlay: { setWindActive: vi.fn() }, state: () => state, displayedRaster: () => raster, replacementFailed: () => false
  });
  opened.push(session);
  return { session: session as ProposedSession, state, build, frames, scheduler, cache, field, publish, selectedPending, relieveDisplay,
    setBounds: (value: typeof bounds) => { bounds = value; }, setRaster: (value: typeof raster) => { raster = value; } };
}

it.each([false, true])('warms every rendered frame across days for a wide viewport with lowMemory=%s', async lowMemory => {
  vi.useFakeTimers();
  const f = harness(lowMemory);
  expect(new Set(renderedFrames(f.build.manifest).map(frame => frame.validTime.slice(0, 10))).size).toBeGreaterThan(1);
  f.session.update();
  await vi.advanceTimersByTimeAsync(20_000);
  expect(new Set(wind.sources.flatMap(source => source.requests.map(request => request.frame)))).toEqual(new Set(f.frames));
  expect(wind.sources[0]!.frame).toBe(f.frames[0]);
});

it('reads horizon protection without scanning every prepared frame', async () => {
  vi.useFakeTimers();
  const f = harness(), frames = f.build.manifest.frames;
  const first = frames[0]!;
  while (frames.length < 40) frames.push({ ...first, id: `horizon-${frames.length}`, validTime: new Date(Date.parse(first.validTime) + frames.length * 3_600_000).toISOString() });
  f.build.manifest.mapFrameCount = frames.length;
  f.session.update();
  await vi.advanceTimersByTimeAsync(20_000);
  expect(f.session.ready.size).toBe(40);
  for (const source of wind.sources) source.memoryCalls = 0;
  expect(f.session.horizonNumericRemaining).toBe(4096);
  expect(wind.sources.reduce((count, source) => count + source.memoryCalls, 0)).toBe(1);
  expect(wind.sources.find(source => source.frame === f.state.selectedFrame)!.memoryCalls).toBe(1);
});

it('runs six independent frame loads through the shared scheduler', async () => {
  vi.useFakeTimers(); wind.deferred = true;
  const f = harness();
  f.setBounds({ west: 44.4, east: 44.5, south: 40.1, north: 40.2 });
  f.session.update();
  expect(wind.sources[0]!.frame).toBe(f.frames[0]);
  wind.sources[0]!.resolve!('ready');
  await vi.advanceTimersByTimeAsync(2_000);
  const pending = wind.sources.filter(source => source.resolve && source.frame !== f.frames[0]);
  expect(pending).toHaveLength(6);
  expect(new Set(pending.map(source => source.frame)).size).toBe(6);
  for (const source of pending) await source.fetchImpl('https://api.test/wind');
  expect(f.scheduler.fetch).toHaveBeenCalledTimes(6);
});

it('promotes an in-progress selected frame without aborting or restarting its load', async () => {
  vi.useFakeTimers(); wind.deferred = true;
  const f = harness();
  f.setBounds({ west: 44.4, east: 44.5, south: 40.1, north: 40.2 });
  f.session.update();
  wind.sources[0]!.resolve!('ready');
  await vi.advanceTimersByTimeAsync(2_000);
  const promoted = wind.sources.find(source => source.frame === f.frames[1])!;
  expect(promoted).toBeDefined();
  const request = promoted.requests[0]!;
  f.state.selectedFrame = promoted.frame;
  f.session.update();
  expect(request.signal.aborted).toBe(false);
  expect(promoted.promote).toHaveBeenCalledOnce();
  expect(wind.sources.filter(source => source.frame === promoted.frame)).toHaveLength(1);
  expect(promoted.requests).toHaveLength(1);
  promoted.resolve!('ready');
  await vi.advanceTimersByTimeAsync(0);
  expect(f.session.current?.frame).toBe(promoted.frame);
});

it('signals selected pending while acquisition is unresolved', async () => {
  vi.useFakeTimers(); wind.deferred = true;
  const f = harness();
  f.session.update();
  expect(f.selectedPending).toHaveBeenLastCalledWith(true);
  wind.sources[0]!.resolve!('ready');
  await vi.advanceTimersByTimeAsync(0);
  expect(f.selectedPending).toHaveBeenLastCalledWith(false);
});

it('lets existing speculative loads finish without admitting distant work while selected wind is pending', async () => {
  vi.useFakeTimers(); wind.deferred = true;
  const f = harness(), frames = f.build.manifest.frames;
  frames.push({ ...frames[7]!, id: 'extra-8' }, { ...frames[7]!, id: 'extra-9' });
  f.build.manifest.mapFrameCount = frames.length;
  f.session.update();
  wind.sources[0]!.resolve!('ready');
  await vi.advanceTimersByTimeAsync(1_000);
  expect(wind.sources.filter(source => source.frame !== f.frames[0])).toHaveLength(6);
  f.state.selectedFrame = 'extra-9';
  f.session.update();
  const selected = wind.sources.find(source => source.frame === 'extra-9')!;
  expect(selected).toBeDefined();
  wind.sources.find(source => source.frame === f.frames[1])!.resolve!('ready');
  await vi.advanceTimersByTimeAsync(1_000);
  expect(wind.sources.some(source => source.frame === 'extra-8')).toBe(false);
  selected.resolve!('ready');
  await vi.advanceTimersByTimeAsync(1_000);
  expect(wind.sources.some(source => source.frame === 'extra-8')).toBe(true);
});

it('bounds outstanding loads under rapid cold selections and demotes obsolete foreground sources', async () => {
  vi.useFakeTimers(); wind.deferred = true;
  const f = harness(), frames = f.build.manifest.frames;
  for (let i = 8; i < 40; i++) frames.push({ ...frames[7]!, id: `extra-${i}` });
  f.build.manifest.mapFrameCount = frames.length;
  f.session.update(); wind.sources[0]!.resolve!('ready');
  await vi.advanceTimersByTimeAsync(1_000);
  expect(wind.sources.filter(source => !source.settled)).toHaveLength(6);
  f.state.selectedFrame = 'extra-8'; f.session.update();
  const first = wind.sources.find(source => source.frame === 'extra-8')!;
  expect(first).toBeDefined();
  for (let i = 9; i < 40; i++) { f.state.selectedFrame = `extra-${i}`; f.session.update(); }
  expect(first.setPriority).toHaveBeenCalledWith('background');
  expect(wind.sources.filter(source => !source.settled).length).toBeLessThanOrEqual(8);
});

it('passes the actual camera as core before the optional pan halo', async () => {
  vi.useFakeTimers();
  const f = harness();
  f.setBounds({ west: 44, east: 45, south: 40, north: 41 });
  f.session.update();
  const request = wind.sources[0]!.requests[0]!;
  expect(request.core).toEqual([44, 40, 45, 41]);
  expect(request.bounds[0]).toBeLessThan(44);
  expect(request.bounds[1]).toBeLessThan(40);
  expect(request.bounds[2]).toBeGreaterThan(45);
  expect(request.bounds[3]).toBeGreaterThan(41);
});

it('keeps installed wind and prepared days during a short pan inside the retained halo', async () => {
  vi.useFakeTimers();
  const f = harness();
  f.setBounds({ west: 44.4, east: 44.5, south: 40.1, north: 40.2 });
  f.setRaster({ build: f.build, frame: f.frames[0]! });
  f.session.update();
  await vi.advanceTimersByTimeAsync(1_000);
  const sources = [...wind.sources], installed = f.session.installed, ready = f.session.preparation.ready;
  expect(ready).toBe(f.frames.length);
  expect(installed).not.toBeNull();
  f.field.clear.mockClear(); f.field.install.mockClear();
  f.setBounds({ west: 44.41, east: 44.51, south: 40.11, north: 40.21 });
  f.session.reconcile();
  f.session.update();
  await vi.advanceTimersByTimeAsync(1_000);
  expect(f.session.installed).toEqual(installed);
  expect(f.session.preparation.ready).toBe(ready);
  expect(wind.sources).toEqual(sources);
  expect(sources.some(source => source.disposed > 0)).toBe(false);
  expect(f.field.clear).not.toHaveBeenCalled();
  expect(f.field.install).not.toHaveBeenCalled();
});

it('keeps native profiles and prepares the selected height first, then the full axis', async () => {
  vi.useFakeTimers();
  const f = harness();
  f.setBounds({ west: 44.4, east: 44.5, south: 40.1, north: 40.2 });
  f.session.update();
  await vi.advanceTimersByTimeAsync(20_000);
  const sources = [...wind.sources], count = sources.reduce((sum, source) => sum + source.requests.length, 0);
  wind.preparations.length = 0;
  f.state.height = 500;
  f.session.heightChanged('surface');
  await vi.advanceTimersByTimeAsync(1_000);
  expect(wind.preparations[0]).toEqual([f.state.selectedFrame, 500]);
  expect(new Set(wind.preparations.filter(([, height]) => height === 500).map(([frame]) => frame))).toEqual(new Set(f.frames));
  expect(wind.sources).toEqual(sources);
  expect(sources.reduce((sum, source) => sum + source.requests.length, 0)).toBe(count);
  expect(sources.every(source => source.prepared.has('surface') && source.prepared.has(500))).toBe(true);
  expect(sources.every(source => source.fields.has('surface') && source.fields.has(500))).toBe(true);
});

it('keeps cached samplers ready across repeated warm height and time changes', async () => {
  vi.useFakeTimers();
  const f = harness();
  f.setRaster({ build: f.build, frame: f.frames[0]! });
  f.session.update();
  await vi.advanceTimersByTimeAsync(20_000);
  expect(wind.sources.every(source => source.fields.has('surface'))).toBe(true);
  f.state.height = 500; f.session.heightChanged('surface');
  await vi.advanceTimersByTimeAsync(1_000);
  const builds = wind.sources.map(source => source.fieldBuilds);
  for (const frame of [f.frames[3]!, f.frames[6]!, f.frames[1]!]) {
    f.state.selectedFrame = frame; f.session.update();
    f.session.beforeRasterReveal({ build: f.build, frame });
    f.setRaster({ build: f.build, frame }); f.session.reconcile();
  }
  f.state.height = 'surface'; f.session.heightChanged(500);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(wind.sources.map(source => source.fieldBuilds)).toEqual(builds);
  expect([...f.session.ready.values()].every(heights => heights.has('surface') && heights.has(500))).toBe(true);
});

it('clears the installed old height and point sampler before an unavailable height preparation', async () => {
  vi.useFakeTimers();
  const f = harness();
  f.setRaster({ build: f.build, frame: f.frames[0]! });
  f.session.update();
  await vi.advanceTimersByTimeAsync(0);
  expect(f.session.installed?.height).toBe('surface');
  wind.prepareUnavailable.add(500);
  wind.events.length = 0; f.field.clear.mockClear(); f.publish.pointWind.mockClear();
  f.state.height = 500;
  f.session.heightChanged('surface');
  expect(f.field.clear).toHaveBeenCalledOnce();
  expect(wind.events.indexOf('clear')).toBeLessThan(wind.events.indexOf('prepare:500'));
  expect(f.session.installed).toBeNull();
  expect(f.publish.displayed).toHaveBeenLastCalledWith(false);
  expect(f.publish.pointWind).toHaveBeenCalledOnce();
  f.session.reconcile();
  expect(f.session.installed).toBeNull();
  await vi.advanceTimersByTimeAsync(0);
  expect(f.session.installed).toBeNull();
  expect(f.publish.status).toHaveBeenLastCalledWith('unavailable');
});

it('clears the installed old height before a capacity-limited preparation and keeps it cleared', async () => {
  vi.useFakeTimers();
  const f = harness();
  f.setRaster({ build: f.build, frame: f.frames[0]! });
  f.session.update();
  await vi.advanceTimersByTimeAsync(0);
  expect(f.session.installed?.height).toBe('surface');
  const installs = f.field.install.mock.calls.length;
  wind.prepareCapacity.add(500);
  wind.events.length = 0; f.field.clear.mockClear(); f.publish.pointWind.mockClear();
  f.state.height = 500;
  f.session.heightChanged('surface');
  expect(f.field.clear).toHaveBeenCalledOnce();
  expect(wind.events.indexOf('clear')).toBeLessThan(wind.events.indexOf('prepare:500'));
  expect(f.session.installed).toBeNull();
  expect(f.session.displayed).toBe(false);
  expect(f.publish.status).toHaveBeenLastCalledWith('loading');
  await vi.advanceTimersByTimeAsync(5_000);
  f.session.reconcile();
  expect(f.session.installed).toBeNull();
  expect(f.session.displayed).toBe(false);
  expect(f.field.install).toHaveBeenCalledTimes(installs);
});

it('drops stale-camera readiness, clears installed wind, and restores the warm job on pan back', async () => {
  vi.useFakeTimers();
  const f = harness();
  const home = { west: 44.4, east: 44.5, south: 40.1, north: 40.2 };
  f.setBounds(home);
  f.setRaster({ build: f.build, frame: f.frames[0]! });
  f.session.update();
  await vi.advanceTimersByTimeAsync(20_000);
  const sources = [...wind.sources], requests = sources.reduce((sum, source) => sum + source.requests.length, 0);
  expect(f.session.installed?.frame).toBe(f.frames[0]);
  expect(f.session.ready.get(f.frames[0]!)).toEqual(new Set(['surface']));
  expect(f.session.preparation.ready).toBeGreaterThan(0);
  f.setBounds({ west: 10, east: 20, south: 0, north: 10 });
  f.field.clear.mockClear(); f.publish.pointWind.mockClear();
  f.session.reconcile();
  expect(f.session.installed).toBeNull();
  expect(f.field.clear).toHaveBeenCalled();
  expect(f.publish.pointWind).toHaveBeenCalled();
  expect(f.session.ready.has(f.frames[0]!)).toBe(false);
  expect(f.session.current).toBeNull();
  expect(f.session.staged).toBeNull();
  expect(f.session.preparation.ready).toBe(0);
  const installs = f.field.install.mock.calls.length;
  f.session.beforeRasterReveal({ build: f.build, frame: f.frames[0]! });
  expect(f.session.installed).toBeNull();
  expect(f.field.install).toHaveBeenCalledTimes(installs);
  f.setBounds(home);
  f.session.reconcile();
  expect(f.session.installed).toMatchObject({ frame: f.frames[0], height: 'surface' });
  expect(f.session.ready.get(f.frames[0]!)).toEqual(new Set(['surface']));
  expect(f.session.current?.frame).toBe(f.frames[0]);
  expect(f.session.preparation.ready).toBeGreaterThan(0);
  expect(wind.sources).toEqual(sources);
  expect(sources.reduce((sum, source) => sum + source.requests.length, 0)).toBe(requests);
  expect(sources.some(source => source.disposed > 0)).toBe(false);
  f.session.destroy();
  expect(sources.every(source => source.disposed > 0)).toBe(true);
});

it('drops expired build readiness, current, staged, and installed wind', async () => {
  vi.useFakeTimers();
  const f = harness();
  f.setRaster({ build: f.build, frame: f.frames[0]! });
  f.session.update();
  await vi.advanceTimersByTimeAsync(0);
  expect(f.session.installed?.frame).toBe(f.frames[0]);
  (f.build as { expiresAtMs: number }).expiresAtMs = Date.now() - 1;
  f.session.reconcile();
  expect(f.session.ready.size).toBe(0);
  expect(f.session.current).toBeNull();
  expect(f.session.staged).toBeNull();
  expect(f.session.preparation.ready).toBe(0);
  expect(f.session.installed).toBeNull();
});

it('reports exact retained frame and height readiness instead of only a matching count', async () => {
  vi.useFakeTimers();
  const f = harness();
  f.setBounds({ west: 44.4, east: 44.5, south: 40.1, north: 40.2 });
  wind.unavailable.add(f.frames[1]!);
  f.session.update();
  await vi.advanceTimersByTimeAsync(5_000);
  expect(f.session.ready).toBeInstanceOf(Map);
  expect(f.session.ready.get(f.frames[0]!)).toEqual(new Set(['surface']));
  expect(f.session.ready.has(f.frames[1]!)).toBe(false);
  expect(f.session.ready.get(f.frames[2]!)).toEqual(new Set(['surface']));
});

it('does not mark a prepared lattice ready when its raw sampler cannot be admitted', async () => {
  vi.useFakeTimers(); wind.fieldCapacity = true;
  const f = harness();
  f.session.update();
  await vi.advanceTimersByTimeAsync(1_000);
  expect(wind.sources[0]!.prepared.has('surface')).toBe(true);
  expect(f.session.ready.get(f.frames[0]!)?.has('surface')).toBe(false);
  expect(f.session.preparation.limited).toBe(true);
  expect(f.selectedPending).toHaveBeenLastCalledWith(false);
});

it('wakes at the earliest cooldown without interaction', async () => {
  vi.useFakeTimers();
  const f = harness();
  f.setBounds({ west: 44.4, east: 44.5, south: 40.1, north: 40.2 });
  wind.unavailable.add(f.frames[1]!);
  wind.unavailable.add(f.frames[2]!);
  f.session.update();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(wind.sources.filter(source => source.frame === f.frames[1])).toHaveLength(1);
  expect(wind.sources.filter(source => source.frame === f.frames[2])).toHaveLength(1);
  const failed = wind.sources.filter(source => wind.unavailable.has(source.frame));
  const earliest = failed.reduce((first, source) => source.requests[0]!.startedAt < first.requests[0]!.startedAt ? source : first);
  await vi.advanceTimersByTimeAsync(earliest.requests[0]!.startedAt + 30_000 - Date.now() - 1);
  expect(wind.sources.filter(source => source.frame === earliest.frame)).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(wind.sources.filter(source => source.frame === earliest.frame).length).toBeGreaterThan(1);
  for (const later of failed.filter(source => source.requests[0]!.startedAt > earliest.requests[0]!.startedAt)) {
    expect(wind.sources.filter(source => source.frame === later.frame)).toHaveLength(1);
  }
});

it('bounds retries for a persistent terminal failure', async () => {
  vi.useFakeTimers();
  const f = harness();
  f.setBounds({ west: 44.4, east: 44.5, south: 40.1, north: 40.2 });
  wind.unavailable.add(f.frames[1]!);
  f.session.update();
  await vi.advanceTimersByTimeAsync(40_000);
  expect(wind.sources.filter(source => source.frame === f.frames[1]).length).toBeGreaterThan(1);
  await vi.advanceTimersByTimeAsync(300_000);
  const attempts = wind.sources.filter(source => source.frame === f.frames[1]).length;
  expect(attempts).toBeLessThanOrEqual(8);
  await vi.advanceTimersByTimeAsync(300_000);
  expect(wind.sources.filter(source => source.frame === f.frames[1])).toHaveLength(attempts);
});

it('automatically retries and terminates persistent preparation failure on the last frame', async () => {
  vi.useFakeTimers();
  const f = harness(), frame = f.frames.at(-1)!;
  wind.prepareFailFrame = frame;
  f.session.update();
  await vi.advanceTimersByTimeAsync(1_000);
  expect(f.session.failed.get(frame)?.attempts).toBe(1);
  await vi.advanceTimersByTimeAsync(100_000);
  expect(f.session.failed.get(frame)).toEqual({ attempts: 4, retryAt: null });
  expect(wind.sources.filter(source => source.frame === frame)).toHaveLength(4);
  await vi.advanceTimersByTimeAsync(300_000);
  expect(wind.sources.filter(source => source.frame === frame)).toHaveLength(4);
});

it('retains a previous core view across two move-end updates', async () => {
  vi.useFakeTimers();
  const f = harness(), home = { west: 44.4, east: 44.5, south: 40.1, north: 40.2 };
  f.setBounds(home); f.session.update();
  await vi.advanceTimersByTimeAsync(10_000);
  const old = wind.sources.find(source => source.frame === f.frames[0])!;
  const builds = old.fieldBuilds;
  f.setBounds({ west: 10, east: 11, south: 0, north: 1 }); f.session.update();
  await vi.advanceTimersByTimeAsync(10_000);
  f.setBounds(home); f.session.update();
  await vi.advanceTimersByTimeAsync(1_000);
  expect(f.session.current?.source).toBe(old);
  expect(old.disposed).toBe(0);
  expect(old.requests).toHaveLength(1);
  expect(old.fieldBuilds).toBe(builds);
});

it.each(['visibility', 'expiry', 'dispose'] as const)('cancels retry work on %s', async reason => {
  vi.useFakeTimers();
  const f = harness();
  f.setBounds({ west: 44.4, east: 44.5, south: 40.1, north: 40.2 });
  wind.unavailable.add(f.frames[1]!);
  f.session.update();
  await vi.advanceTimersByTimeAsync(5_000);
  const before = wind.sources.length;
  if (reason === 'visibility') f.state.visible = false;
  else if (reason === 'expiry') f.state.expired = true;
  else f.session.destroy();
  if (reason !== 'dispose') f.session.update();
  await vi.advanceTimersByTimeAsync(120_000);
  expect(wind.sources).toHaveLength(before);
});

it('disposes pending sources automatically at build expiry', async () => {
  vi.useFakeTimers(); wind.deferred = true;
  const f = harness();
  (f.build as { expiresAtMs: number }).expiresAtMs = Date.now() + 5_000;
  f.session.update();
  const source = wind.sources[0]!;
  await vi.advanceTimersByTimeAsync(5_000);
  expect(source.requests[0]!.signal.aborted).toBe(true);
  expect(source.disposed).toBe(1);
  expect(f.session.resident).toBe(false);
  expect(f.session.installed).toBeNull();
});

it('detaches the installed renderer before disposing its source', async () => {
  vi.useFakeTimers();
  const f = harness();
  f.setRaster({ build: f.build, frame: f.frames[0]! });
  f.session.update();
  await vi.advanceTimersByTimeAsync(0);
  expect(f.session.installed?.frame).toBe(f.frames[0]);
  wind.events.length = 0;
  f.session.clear();
  expect(wind.events.indexOf('clear')).toBeLessThan(wind.events.indexOf(`dispose:${f.frames[0]}`));
  expect(wind.events).toContain(`dispose:${f.frames[0]}`);
});

it('stages selected wind without publishing and clears old wind synchronously before raster reveal', async () => {
  vi.useFakeTimers();
  const f = harness();
  f.setRaster({ build: f.build, frame: f.frames[0]! });
  f.session.update();
  await vi.advanceTimersByTimeAsync(0);
  f.state.selectedFrame = f.frames[1]!;
  f.session.update();
  await vi.advanceTimersByTimeAsync(0);
  expect(f.session.staged?.build?.manifest.buildId).toBe(f.build.manifest.buildId);
  expect(f.session.staged?.frame).toBe(f.frames[1]);
  expect(f.session.staged?.height).toBe('surface');
  expect(f.session.installed?.frame).toBe(f.frames[0]);
  const installs = f.field.install.mock.calls.length;
  f.session.beforeRasterReveal({ build: f.build, frame: f.frames[1]! });
  expect(f.field.clear).toHaveBeenCalled();
  expect(f.field.install).toHaveBeenCalledTimes(installs + 1);
  expect(f.session.installed?.frame).toBe(f.frames[1]);
  f.setRaster({ build: f.build, frame: f.frames[1]! });
  f.session.reconcile();
  expect(f.session.installed?.frame).toBe(f.frames[1]);
  expect(f.field.install.mock.calls.at(-1)?.[2]).toBe('replace');
});

it('clears installed wind and its point sampler before revealing a cold target', async () => {
  vi.useFakeTimers();
  const f = harness();
  f.setRaster({ build: f.build, frame: f.frames[0]! });
  f.session.update();
  await vi.advanceTimersByTimeAsync(0);
  expect(f.session.installed?.frame).toBe(f.frames[0]);
  wind.deferred = true;
  f.state.selectedFrame = f.frames[7]!;
  f.session.update();
  f.field.clear.mockClear();
  expect(typeof f.session.beforeRasterReveal).toBe('function');
  f.session.beforeRasterReveal({ build: f.build, frame: f.frames[7]! });
  expect(f.field.clear).toHaveBeenCalledOnce();
  expect(f.session.installed).toBeNull();
  f.setRaster({ build: f.build, frame: f.frames[7]! });
  f.session.reconcile();
  expect(f.session.installed).toBeNull();
});

it('releases a rejected capacity reservation before re-admitting on a real release', async () => {
  vi.useFakeTimers();
  const f = harness();
  f.setBounds({ west: 44.4, east: 44.5, south: 40.1, north: 40.2 });
  wind.capacityFrame = f.frames[1]!;
  f.session.update();
  await vi.advanceTimersByTimeAsync(5_000);
  const rejected = wind.sources.find(source => source.frame === wind.capacityFrame)!;
  expect(rejected).toBeDefined();
  expect(rejected.disposed).toBe(1);
  expect(wind.reserved).toBe(0);
  const attempts = wind.sources.filter(source => source.frame === wind.capacityFrame).length;
  wind.capacityAvailable = true;
  f.cache.onRelease?.();
  await vi.advanceTimersByTimeAsync(5_000);
  expect(wind.sources.filter(source => source.frame === wind.capacityFrame).length).toBeGreaterThan(attempts);
  expect(wind.reserved).toBe(0);
});

it('retries wind admission after display pressure relief', async () => {
  vi.useFakeTimers();
  const f = harness();
  wind.capacityFrame = f.frames[0]!;
  f.relieveDisplay.mockImplementation(() => { wind.capacityAvailable = true; return true; });
  f.session.update();
  await vi.advanceTimersByTimeAsync(1_000);
  expect(f.relieveDisplay).toHaveBeenCalled();
  expect(f.session.ready.get(f.frames[0]!)?.has('surface')).toBe(true);
  expect(wind.reserved).toBe(0);
});

it.each(['numeric', 'speculative'] as const)('settles %s capacity pressure without degrading the display', async kind => {
  vi.useFakeTimers();
  const f = harness();
  f.setRaster({ build: f.build, frame: f.frames[0]! });
  if (kind === 'numeric') wind.numericLimit = 1;
  else wind.capacityFrame = f.frames[1]!;
  let reliefs = 0;
  f.relieveDisplay.mockImplementation(() => ++reliefs <= 3);
  f.session.update();
  await vi.advanceTimersByTimeAsync(1_000);
  expect(f.session.preparation.limited).toBe(true);
  expect(f.relieveDisplay).not.toHaveBeenCalled();
  const attempts = wind.sources.length;
  await vi.advanceTimersByTimeAsync(20_000);
  expect(wind.sources).toHaveLength(attempts);
  if (kind === 'speculative') expect(f.session.installed?.frame).toBe(f.frames[0]);
});

it('relieves selected shared pressure after a numeric block has cleared', async () => {
  vi.useFakeTimers();
  const f = harness();
  wind.numericLimit = 1;
  f.session.update();
  await vi.advanceTimersByTimeAsync(1_000);
  expect(f.session.preparation.limited).toBe(true);
  expect(f.relieveDisplay).not.toHaveBeenCalled();
  wind.numericLimit = 0;
  wind.capacityFrame = f.frames[0]!;
  f.relieveDisplay.mockImplementation(() => { wind.capacityAvailable = true; return true; });
  f.state.height = 500;
  f.session.heightChanged('surface');
  await vi.advanceTimersByTimeAsync(1_000);
  expect(f.relieveDisplay).toHaveBeenCalled();
  expect(f.session.preparation.limited).toBe(false);
});

it('keeps numeric admission blocked when only renderer memory is released', async () => {
  vi.useFakeTimers();
  const budget = createPreparationBudget(128 * 1024 * 1024);
  const renderer = budget.reserve('raster', 1024 * 1024)!;
  const f = harness(false, budget);
  wind.numericLimit = 1;
  f.session.update();
  await vi.advanceTimersByTimeAsync(1_000);
  const attempts = wind.sources.length;
  expect(f.session.preparation.limited).toBe(true);
  renderer.release();
  await vi.advanceTimersByTimeAsync(1_000);
  expect(f.session.preparation.limited).toBe(true);
  expect(wind.sources).toHaveLength(attempts);
  expect(f.relieveDisplay).not.toHaveBeenCalled();
});

it.each(['numeric cache', 'shared budget'] as const)('reclaims distant retained frames for a cold selection under %s pressure', async kind => {
  vi.useFakeTimers();
  const budget = createPreparationBudget(128 * 1024 * 1024);
  const other = kind === 'shared budget' ? budget.reserve('other', 104 * 1024 * 1024)! : null;
  wind.numericLimit = kind === 'numeric cache' ? 32 * 1024 * 1024 : 128 * 1024 * 1024;
  const f = harness(false, kind === 'shared budget' ? budget : undefined);
  f.session.update();
  await vi.advanceTimersByTimeAsync(1_000);
  expect(f.session.preparation.limited).toBe(true);
  f.state.selectedFrame = f.frames.at(-1)!;
  f.session.update();
  await vi.advanceTimersByTimeAsync(1_000);
  expect(f.session.current?.frame).toBe(f.state.selectedFrame);
  expect(wind.sources.some(source => source.disposed > 0 && source.frame !== f.state.selectedFrame)).toBe(true);
  f.session.destroy(); other?.release();
  expect(wind.numericUsed).toBe(0);
  expect(budget.used).toBe(0);
});

it.each(['build', 'view'] as const)('cancels obsolete pending work on %s change', async reason => {
  vi.useFakeTimers(); wind.deferred = true;
  const f = harness();
  f.session.update();
  const old = wind.sources[0]!;
  if (reason === 'build') {
    const next = fixtureBuild({ buildId: `20260101T000000Z-${'a'.repeat(36)}` });
    (next as { expiresAtMs: number }).expiresAtMs = Date.now() + 86_400_000;
    (next.manifest as unknown as { mapData: { sha256: string; bytes: number } }).mapData = { sha256: 'a', bytes: 1 };
    f.state.build = next;
  } else f.setBounds({ west: 20, east: 21, south: 30, north: 31 });
  f.session.update();
  expect(old.requests[0]!.signal.aborted).toBe(true);
  old.resolve!('ready');
  await vi.advanceTimersByTimeAsync(0);
  expect(f.session.current?.source).not.toBe(old);
  expect(old.disposed).toBeGreaterThan(0);
});

it('does not publish an obsolete late selected completion after the epoch changes', async () => {
  vi.useFakeTimers(); wind.deferred = true;
  const f = harness();
  f.setRaster({ build: f.build, frame: f.frames[0]! });
  f.session.update();
  const old = wind.sources[0]!;
  f.state.selectedFrame = f.frames[1]!;
  f.session.update();
  old.resolve!('ready');
  await vi.advanceTimersByTimeAsync(0);
  expect(f.session).toHaveProperty('staged');
  expect(f.session.staged?.frame).not.toBe(f.frames[0]);
  expect(f.field.install).not.toHaveBeenCalled();
});

it('reports overview quality and retains the raw native field for point and barb sampling', async () => {
  vi.useFakeTimers(); wind.overview = true;
  const f = harness();
  f.setRaster({ build: f.build, frame: f.frames[0]! });
  f.session.update();
  await vi.advanceTimersByTimeAsync(0);
  expect(f.publish.quality).toHaveBeenLastCalledWith(true);
  const installed = f.field.install.mock.calls.at(-1)?.[0];
  expect(installed?.sample(40, 44)).toEqual({ u: 1, v: 2, status: 0 });
  expect(f.session.current?.source.sample(40, 44, 'surface')).toMatchObject({ u: 1, v: 2, status: 'valid' });
});
