import { afterEach, expect, it, vi } from 'vitest';
import { fixtureBuild } from '../../../../tests/forecast-fixture';
import type { PreparationBudget } from '@av/client';
import type { CompactTimelineOptions } from '../features/timeline/timeline-controller';
import type { PointSessionOptions } from '../features/point/point-session';
import type { OverlayState } from '../features/raster/raster-overlay';
import { emptyOverlay } from '../stores/app-store';

const mocks = vi.hoisted(() => ({ resolveAutoBuild: vi.fn(), reconcileWind: vi.fn(), budget: null as PreparationBudget | null, pointOptions: null as PointSessionOptions | null, point: null as { frameId: string | null; current: unknown } | null, overlayState: null as ((state: OverlayState) => void) | null, windInstalled: null as unknown }));

vi.mock('@av/client', async importOriginal => {
  const actual = await importOriginal<typeof import('@av/client')>();
  return {
    ...actual,
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
      async loadRange() {}, suspend() {}, dispose() {}
    };
    mocks.point = session;
    return session;
  },
  createWindControls: () => ({ state: { visible: false }, setUnits() {}, setStatus() {}, setQuality() {}, setState() {}, destroy() {} })
}));
vi.mock('../features/map/map-controller', () => ({
  createMap: () => map,
  createMapCamera: () => ({ home: { lat: 40, lng: -100 }, followsPlace: () => false, sync: () => ({ center: map.getCenter(), changed: false }), offsetMinutes: () => 0, scale: () => ({ width: 1, text: '' }), focusRegion() {} }),
  maplibregl: { GPUInitializationError: class extends Error {} }
}));
vi.mock('../features/raster/raster-overlay', () => ({ RasterOverlay: class { constructor(_map: unknown, _baseUrl: string, _opacity: number, onState: (state: OverlayState) => void) { mocks.overlayState = onState; } select() {} prepare() {} refresh() {} setWindActive() {} setOpacity() {} setPlayback() {} clear() {} destroy() {} } }));
vi.mock('../features/map/coverage-seam', () => ({ CoverageSeam: class { sync() {} markReady() {} destroy() {} } }));
vi.mock('../features/wind/wind-overlay', () => ({ WindOverlay: class { setOptions() {} clear() {} destroy() {} } }));
vi.mock('../features/wind/wind-session', () => ({ createWindSession: () => ({ ready: new Map(), preparation: { limited: false }, resident: false, get installed() { return mocks.windInstalled; }, clear() {}, destroy() {}, update() {}, reconcile: mocks.reconcileWind, setPlaying() {}, heightChanged() {}, beforeRasterReveal() {} }) }));
vi.mock('../features/location/location-controller', () => ({ createLocationController: () => ({ locate() {}, reset() {}, dispose() {} }) }));
vi.mock('../platform/browser-lifecycle', () => ({ installBrowserLifecycle() {} }));
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
  getContainer(): object;
  remove(): void;
  fire(type: string, event?: unknown): void;
  center: { lat: number; lng: number };
};

async function harness() {
  const handlers = new Map<string, (...args: never[]) => void>();
  map = {
    center: { lat: 40, lng: -100 },
    on(type, handler) { handlers.set(type, handler); }, once(type, handler) { handlers.set(type, handler); },
    getCenter() { return this.center; }, getZoom: () => 6, getContainer: () => ({}), remove() {},
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
  const root = { querySelector: (selector: string) => hosts.get(selector) ?? null } as unknown as HTMLElement;
  const build = fixtureBuild({ mapFrameCount: 2, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString() });
  const frames = build.manifest.frames;
  const requests: { resolve: (result: unknown) => void; signal: AbortSignal }[] = [];
  mocks.resolveAutoBuild.mockReset().mockImplementation((_api, options: { signal: AbortSignal }) => new Promise(resolve => requests.push({ resolve, signal: options.signal })));
  mocks.point = null; mocks.pointOptions = null; mocks.overlayState = null; mocks.windInstalled = null; cancelled = null;
  const app = createPreviewApp();
  app.start(root);
  map.fire('style.load');
  requests[0]!.resolve({ build, frame: frames[0] });
  await vi.waitFor(() => expect(app.store.view.forecast.value.selectedFrame).toBe(frames[0]!.id));
  map.fire('click', { lngLat: { lat: 40, lng: -100 } });
  await vi.waitFor(() => expect(mocks.point?.current).toBeTruthy());
  writes.length = 0;
  return { app, build, frames, requests, writes, location };
}

function pointSelect(id: string): void {
  mocks.point!.frameId = id;
  mocks.pointOptions!.selectFrameById(id);
}

afterEach(() => { vi.unstubAllGlobals(); });

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
