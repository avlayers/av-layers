import { afterEach, expect, it, vi } from 'vitest';
import { fixtureBuild } from '../../../../tests/forecast-fixture';
import type { PreparationBudget } from '@av/client';
import type { CompactTimelineOptions } from '../features/timeline/timeline-controller';
import type { PointSessionOptions } from '../features/point/point-session';
import type { WindControlsOptions } from '../features/wind/wind-controls';
import type { BrowserLifecycleOptions } from '../platform/browser-lifecycle';
import type { OverlayState, RasterOverlayOptions } from '../features/raster/raster-overlay';
import { emptyOverlay } from '../stores/app-store';

const mocks = vi.hoisted(() => ({ resolveAutoBuild: vi.fn(), reconcileWind: vi.fn(), budget: null as PreparationBudget | null, pointOptions: null as PointSessionOptions | null, point: null as { frameId: string | null; current: unknown } | null, overlayState: null as ((state: OverlayState) => void) | null, rasterOptions: null as RasterOverlayOptions | null, windInstalled: null as unknown, windStaged: null as unknown, windMemory: vi.fn(() => ({ horizonNumericRemaining: 4096 })), windHorizonRemaining: vi.fn(() => 4096), windDestroy: vi.fn(), rasterDestroy: vi.fn(), overlayDestroy: vi.fn(), schedulerDispose: vi.fn(), windControls: null as WindControlsOptions | null, windClear: vi.fn(), rasterClear: vi.fn(), locationReset: vi.fn(), lifecycle: null as BrowserLifecycleOptions | null }));

vi.mock('@av/client', async importOriginal => {
  const actual = await importOriginal<typeof import('@av/client')>();
  return {
    ...actual,
    createForecastRequestScheduler(...args: Parameters<typeof actual.createForecastRequestScheduler>) {
      const scheduler = actual.createForecastRequestScheduler(...args), dispose = scheduler.dispose;
      scheduler.dispose = () => { mocks.schedulerDispose(); dispose(); };
      return scheduler;
    },
    createPreparationBudget(...args: Parameters<typeof actual.createPreparationBudget>) {
      const budget = actual.createPreparationBudget(...args);
      mocks.budget = budget;
      return budget;
    },
    resolveAutoBuild: mocks.resolveAutoBuild,
    watchBuildExpiry: () => () => {}
  };
});
vi.mock('../features/lazy', () => ({
  createPointSession(options: PointSessionOptions) {
    mocks.pointOptions = options;
    const session = {
      frameId: options.getSelectedFrame(), current: null as unknown, pending: false,
      async open(point: unknown) { session.current = { build: options.getBuild(), point }; },
      close() { session.current = null; },
      updateSelection() {}, followMapFrame(frame: string | null) { session.frameId = frame; },
      formatWindTime(validMs: number) { return new Date(validMs).toISOString(); },
      renderBuildDetails() {},
      async loadRange() {}, suspend() {}, dispose() {}
    };
    mocks.point = session;
    return session;
  },
  createWindControls: (_host: unknown, options: WindControlsOptions) => { mocks.windControls = options; return { state: { visible: false }, setUnits() {}, setStatus() {}, setQuality() {}, setState() {}, destroy() {} }; }
}));
vi.mock('../features/map/map-controller', () => ({
  createMap: () => map,
  createMapCamera: () => ({ home: { lat: 40, lng: -100 }, followsPlace: () => false, sync: () => ({ center: map.getCenter(), changed: false }), offsetMinutes: () => 0, scale: () => ({ width: 1, text: '' }), focusRegion() {} }),
  maplibregl: { GPUInitializationError: class extends Error {} }
}));
vi.mock('../features/raster/raster-overlay', () => ({ RasterOverlay: class { update() {} constructor(_map: unknown, _baseUrl: string, _opacity: number, onState: (state: OverlayState) => void, _fetch: unknown, _request: unknown, options: RasterOverlayOptions) { mocks.overlayState = onState; mocks.rasterOptions = options; } select() {} prepare() {} refresh() {} setWindActive() {} setOpacity() {} setPlayback() {} clear() { mocks.rasterClear(); } destroy() { mocks.rasterDestroy(); } } }));
vi.mock('../features/map/coverage-seam', () => ({ CoverageSeam: class { sync() {} markReady() {} destroy() {} } }));
vi.mock('../features/wind/wind-overlay', () => ({ WindOverlay: class { update() {} setOptions() {} clear() {} destroy() { mocks.overlayDestroy(); } } }));
vi.mock('../features/wind/wind-session', () => ({ createWindSession: () => ({ ready: new Map(), preparation: { limited: false }, resident: false, get installed() { return mocks.windInstalled; }, get staged() { return mocks.windStaged; }, get memory() { return mocks.windMemory(); }, get horizonNumericRemaining() { return mocks.windHorizonRemaining(); }, clear() { mocks.windClear(); }, destroy() { mocks.windDestroy(); }, update() {}, reconcile: mocks.reconcileWind, playbackChanged() {}, heightChanged() {}, beforeRasterReveal() {} }) }));
vi.mock('../features/location/location-controller', () => ({ createLocationController: () => ({ locate() {}, reset() { mocks.locationReset(); }, dispose() {} }) }));
vi.mock('../platform/browser-lifecycle', () => ({ installBrowserLifecycle(options: BrowserLifecycleOptions) { mocks.lifecycle = options; } }));
vi.mock('../features/timeline/timeline-controller', () => ({
  createCompactTimeline(_host: unknown, options: CompactTimelineOptions) {
    timelineOptions = options;
    return { update() {}, setMapCenter() {}, setOffsetMinutes() {}, pause() {}, destroy() {}, cancelGesture: () => { const result = cancelled; cancelled = null; return result; } };
  }
}));

import { createPreviewApp } from './create-preview-app';

let timelineOptions: CompactTimelineOptions;
let cancelled: { changed: boolean; delivered: boolean } | null;
let map: {
  on(type: string, handler: (...args: never[]) => void): void;
  once(type: string, handler: (...args: never[]) => void): void;
  getCenter(): { lat: number; lng: number };
  getZoom(): number;
  getBounds(): { getWest(): number; getEast(): number; getSouth(): number; getNorth(): number };
  getContainer(): object;
  zoom: number;
  remove(): void;
  fire(type: string, event?: unknown): void;
  center: { lat: number; lng: number };
};

async function harness(wind = false) {
  const handlers = new Map<string, (...args: never[]) => void>();
  map = {
    center: { lat: 40, lng: -100 }, zoom: 6,
    on(type, handler) { handlers.set(type, handler); }, once(type, handler) { handlers.set(type, handler); },
    getCenter() { return this.center; }, getZoom() { return this.zoom; },
    getBounds: () => ({ getWest: () => -100.2, getEast: () => -99.8, getSouth: () => 39.8, getNorth: () => 40.2 }),
    getContainer: () => ({}), remove: vi.fn(),
    fire(type, event = {}) { handlers.get(type)?.(event as never); }
  };
  const location = { pathname: '/', search: '?model=auto&wind=0&lat=40&lon=-100&z=6' };
  const writes: { mode: string; url: string }[] = [];
  const setUrl = (mode: string, url: string) => { writes.push({ mode, url }); location.search = new URL(url, 'https://preview.test').search; };
  const win = Object.assign(new EventTarget(), {
    location, localStorage: null,
    history: { pushState: (_: unknown, __: string, url: string) => setUrl('push', url), replaceState: (_: unknown, __: string, url: string) => setUrl('replace', url) },
    setInterval: () => 1, clearInterval() {}
  });
  const hosts = new Map(['#map', '#wind-controls', '#compact-timeline'].map(id => [id, { hidden: false }]));
  const doc = Object.assign(new EventTarget(), { visibilityState: 'visible', querySelector: (selector: string) => hosts.get(selector) ?? null });
  vi.stubGlobal('window', win);
  vi.stubGlobal('document', doc);
  vi.stubGlobal('navigator', {});
  const root = { dataset: {}, querySelector: (selector: string) => hosts.get(selector) ?? null } as unknown as HTMLElement;
  const build = fixtureBuild({ mapFrameCount: 2, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString() });
  if (wind) build.manifest.mapData = { sha256: 'a'.repeat(64), bytes: 1 };
  const frames = build.manifest.frames;
  const requests: { resolve: (result: unknown) => void; signal: AbortSignal }[] = [];
  mocks.resolveAutoBuild.mockReset().mockImplementation((_api, options: { signal: AbortSignal }) => new Promise(resolve => requests.push({ resolve, signal: options.signal })));
  mocks.point = null; mocks.pointOptions = null; mocks.overlayState = null; mocks.rasterOptions = null; mocks.windInstalled = null; mocks.windStaged = null; cancelled = null;
  mocks.windMemory.mockClear(); mocks.windHorizonRemaining.mockClear();
  mocks.windDestroy.mockReset(); mocks.rasterDestroy.mockReset(); mocks.overlayDestroy.mockReset(); mocks.schedulerDispose.mockReset(); mocks.windControls = null;
  mocks.windClear.mockReset(); mocks.rasterClear.mockReset(); mocks.locationReset.mockReset(); mocks.lifecycle = null;
  const app = createPreviewApp();
  app.start(root);
  map.fire('style.load');
  requests[0]!.resolve({ build, frame: frames[0] });
  await vi.waitFor(() => expect(app.store.view.forecast.value.selectedFrame).toBe(frames[0]!.id));
  map.fire('click', { lngLat: { lat: 40, lng: -100 } });
  await vi.waitFor(() => expect(mocks.point?.current).toBeTruthy());
  if (wind) await vi.waitFor(() => expect(mocks.windControls).not.toBeNull());
  writes.length = 0;
  return { app, build, frames, requests, writes, location };
}

function pointSelect(id: string): void {
  mocks.point!.frameId = id;
  mocks.pointOptions!.selectFrameById(id);
}

afterEach(() => { vi.unstubAllGlobals(); });

it('keeps wind gesture URL writes on the final control commit', async () => {
  const test = await harness(true);
  const control = mocks.windControls!;
  control.onChange({ style: 'hybrid', visible: true, paused: false, height: 1500 });
  control.onChange({ style: 'hybrid', visible: true, paused: false, height: 2000 });
  expect(test.app.store.view.intent.value.windHeight).toBe(2000);
  expect(test.writes).toHaveLength(0);
  control.onCommit!();
  expect(test.writes).toHaveLength(1);
  expect(new URLSearchParams(test.location.search).get('wheight')).toBe('2000');
  test.app.dispose();
});

it('finishes application cleanup when wind destruction fails', async () => {
  const test = await harness(), error = new Error('Lost graphics context');
  const report = vi.spyOn(console, 'error').mockImplementation(() => {});
  mocks.windDestroy.mockImplementationOnce(() => { throw error; });
  try {
    expect(() => test.app.dispose()).not.toThrow();
    expect(mocks.overlayDestroy).toHaveBeenCalledTimes(1);
    expect(mocks.rasterDestroy).toHaveBeenCalledTimes(1);
    expect(mocks.schedulerDispose).toHaveBeenCalledTimes(1);
    expect(map.remove).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith('Preview cleanup failed', error);
    test.app.dispose();
    expect(mocks.windDestroy).toHaveBeenCalledTimes(1);
    expect(mocks.schedulerDispose).toHaveBeenCalledTimes(1);
  } finally { report.mockRestore(); }
});

it('suspends outstanding work for BFCache even when clearing graphics fails', async () => {
  const test = await harness(), error = new Error('Lost graphics context');
  map.fire('moveend');
  const request = test.requests.at(-1)!;
  const report = vi.spyOn(console, 'error').mockImplementation(() => {});
  mocks.windClear.mockImplementationOnce(() => { throw error; });
  try {
    expect(() => mocks.lifecycle!.onPageHide({ persisted: true } as PageTransitionEvent)).not.toThrow();
    expect(request.signal.aborted).toBe(true);
    expect(mocks.locationReset).toHaveBeenCalled();
    expect(mocks.rasterClear).toHaveBeenCalled();
    expect(report).toHaveBeenCalledWith('Preview cleanup failed', error);
    expect(map.remove).not.toHaveBeenCalled();
  } finally { test.app.dispose(); report.mockRestore(); }
});

it('preserves selected response and processing headroom during speculative admission', async () => {
  const test = await harness();
  const budget = mocks.budget!, responsesBytes = 4 * 1024 * 1024, processingBytes = 20 * 1024 * 1024;
  const background = budget.reserve('test-background', budget.limit - budget.used - responsesBytes - processingBytes, 'background');
  const overflow = budget.reserve('test-background-overflow', 1, 'background');
  const responses = budget.reserve('test-selected-response', responsesBytes);
  const processing = budget.reserve('test-selected-processing', processingBytes);
  try {
    expect(background).not.toBeNull();
    expect(overflow).toBeNull();
    expect(responses).not.toBeNull();
    expect(processing).not.toBeNull();
    expect(budget.used).toBe(budget.limit);
  } finally {
    processing?.release(); responses?.release(); overflow?.release(); background?.release(); test.app.dispose();
  }
});

it('checks raster admission without collecting whole-horizon wind diagnostics', async () => {
  const test = await harness();
  Object.assign(test.build.manifest, { mapData: { sha256: 'a', bytes: 1 } });
  mocks.windStaged = { build: test.build, frame: test.frames[0]!.id, height: 'surface' };
  test.app.commands.setWind({ style: 'hybrid', visible: true, paused: false, height: 'surface' });
  mocks.windMemory.mockClear(); mocks.windHorizonRemaining.mockClear();
  for (let index = 0; index < 120; index++) expect(mocks.rasterOptions!.protectedBytes!()).toBeGreaterThan(4096);
  expect(mocks.windHorizonRemaining).toHaveBeenCalledTimes(120);
  expect(mocks.windMemory).not.toHaveBeenCalled();
  test.app.dispose();
});

it('reconciles wind coverage during camera movement before move end', async () => {
  const test = await harness();
  mocks.reconcileWind.mockClear();
  map.fire('move');
  expect(mocks.reconcileWind).toHaveBeenCalledTimes(1);
  test.app.dispose();
});

it.each([1, 0])('preserves a point-only selection when same-build Auto resolves map frame %s', async resultIndex => {
  const test = await harness();
  timelineOptions.onIntent?.(1);
  timelineOptions.onSelect(1, 'none');
  cancelled = { changed: true, delivered: true };
  const previousRequests = test.requests.length;
  pointSelect(test.frames[2]!.id);
  expect(test.requests).toHaveLength(previousRequests + 1);
  const request = test.requests.at(-1)!;
  request.resolve({ build: test.build, frame: test.frames[resultIndex] });
  await new Promise(resolve => setTimeout(resolve, 0));
  await vi.waitFor(() => expect(test.app.store.view.forecast.value.selectedFrame).toBe(test.frames[resultIndex]!.id));
  expect(mocks.point!.frameId).toBe(test.frames[2]!.id);
  expect(test.writes.filter(write => write.mode === 'push')).toHaveLength(1);
  test.app.dispose();
});

it('repairs the current URL after an intervening camera write and a drag returned to start', async () => {
  const test = await harness();
  timelineOptions.onIntent?.(1);
  timelineOptions.onSelect(1, 'none');
  map.center = { lat: 41, lng: -100 };
  map.fire('moveend');
  const stale = test.requests.at(-1)!;
  expect(new URLSearchParams(test.location.search).get('t')).toBe(test.frames[1]!.validTime);
  timelineOptions.onIntent?.(0);
  expect(stale.signal.aborted).toBe(true);
  timelineOptions.onSelect(0, 'none');
  cancelled = { changed: true, delivered: false };
  pointSelect(test.frames[2]!.id);
  const params = new URLSearchParams(test.location.search);
  expect(params.get('t')).toBe(test.frames[0]!.validTime);
  expect(params.get('lat')).toBe('41.0000');
  expect(test.writes.filter(write => write.mode === 'push')).toHaveLength(1);
  expect(test.writes.at(-1)!.mode).toBe('replace');
  stale.resolve({ build: test.build, frame: test.frames[1] });
  test.requests.at(-1)!.resolve({ build: test.build, frame: test.frames[0] });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(test.app.store.view.forecast.value.selectedFrame).toBe(test.frames[0]!.id);
  await vi.waitFor(() => expect(mocks.point!.frameId).toBe(test.frames[2]!.id));
  test.app.dispose();
});

it('continues following automatic and explicit map selections', async () => {
  const test = await harness();
  map.fire('moveend');
  test.requests.at(-1)!.resolve({ build: test.build, frame: test.frames[1] });
  await vi.waitFor(() => expect(test.app.store.view.forecast.value.selectedFrame).toBe(test.frames[1]!.id));
  expect(mocks.point!.frameId).toBe(test.frames[1]!.id);
  pointSelect(test.frames[2]!.id);
  test.app.commands.selectFrame(0, 'push');
  expect(mocks.point!.frameId).toBe(test.frames[0]!.id);
  test.app.dispose();
});

it('closes the point when Auto resolves a new build', async () => {
  const test = await harness();
  pointSelect(test.frames[2]!.id);
  const next = fixtureBuild({
    buildId: '20261030T000000Z-00000000-0000-4000-8000-000000000001', mapFrameCount: 2,
    createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString()
  });
  map.fire('moveend');
  test.requests.at(-1)!.resolve({ build: next, frame: next.manifest.frames[0] });
  await vi.waitFor(() => expect(test.app.store.view.forecast.value.build).toBe(next));
  expect(mocks.point!.current).toBeNull();
  test.app.dispose();
});

it('withholds map wind until the displayed raster matches the installed wind frame', async () => {
  const test = await harness();
  const displayed = test.frames[0]!, selected = test.frames[2]!, layer = 'usable-lift-agl' as const;
  const sample = vi.fn(() => ({ u: 1, v: 0, status: 'valid' }));
  mocks.windInstalled = { build: test.build, frame: selected.id, isOverview: false, height: 'surface', source: { sample } };
  pointSelect(selected.id);
  mocks.overlayState!({ ...emptyOverlay, requested: { build: test.build, layer, frame: selected.id }, displayed: { build: test.build, layer, frame: displayed.id } });
  mocks.pointOptions!.publish.changed();
  expect(test.app.store.view.point.value.wind).toBe('');
  expect(sample).not.toHaveBeenCalled();
  mocks.overlayState!({ ...emptyOverlay, requested: { build: test.build, layer, frame: selected.id }, displayed: { build: test.build, layer, frame: selected.id } });
  expect(test.app.store.view.point.value.wind).toContain('Map wind');
  expect(sample).toHaveBeenCalledTimes(1);
  const other = fixtureBuild({
    buildId: '20261030T000000Z-00000000-0000-4000-8000-000000000001', mapFrameCount: 2,
    createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString()
  });
  mocks.windInstalled = { build: other, frame: selected.id, isOverview: false, height: 'surface', source: { sample } };
  mocks.pointOptions!.publish.changed();
  expect(test.app.store.view.point.value.wind).toBe('');
  expect(sample).toHaveBeenCalledTimes(1);
  test.app.dispose();
});

it('marks the default world zoom as a globe and a tight view as local', async () => {
  const test = await harness();
  expect(mocks.resolveAutoBuild.mock.calls[0]?.[1]).toMatchObject({ globe: false, lat: 40, lon: -100 });
  map.zoom = 2;
  map.fire('moveend');
  await vi.waitFor(() => expect(mocks.resolveAutoBuild).toHaveBeenCalledTimes(2));
  expect(mocks.resolveAutoBuild.mock.calls[1]?.[1]).toMatchObject({ globe: true, lat: 40, lon: -100 });
  test.app.dispose();
});

it('closes an open windgram on map click instead of selecting a new point, then opens on the next click', async () => {
  const test = await harness();
  expect(mocks.point?.current).toEqual({ build: test.build, point: { lat: 40, lon: -100 } });

  // Clicking elsewhere on the map while open closes the windgram rather than jumping to the new coordinate.
  map.fire('click', { lngLat: { lat: 42.5, lng: -98.25 } });
  expect(mocks.point?.current).toBeNull();
  expect(test.app.store.view.point.value.open).toBe(false);

  // Once closed, the next map click opens the windgram at the newly clicked coordinate.
  map.fire('click', { lngLat: { lat: 42.5, lng: -98.25 } });
  await vi.waitFor(() => expect(mocks.point?.current).toEqual({ build: test.build, point: { lat: 42.5, lon: -98.25 } }));
  test.app.dispose();
});
