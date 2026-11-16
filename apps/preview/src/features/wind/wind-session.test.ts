import { describe, expect, it, vi } from 'vitest';
import { renderedFrames } from '@av/contracts/publication';
import { fixtureBuild } from '../../../../../tests/forecast-fixture';
import type { WindHeight, WindStatus } from './wind-model';

const wind = vi.hoisted(() => ({ status: 'ready' as 'ready' | 'unavailable' }));

vi.mock('@av/client/wind', () => ({
  WindDataSource: class {
    readonly isOverview = false;
    readonly admitted = undefined;
    readonly load = vi.fn(async () => wind.status);
    readonly dispose = vi.fn();
    readonly sample = vi.fn((_lat: number, _lon: number, height: WindHeight) => ({ u: 1, v: 2, status: 'valid', height }));
  }
}));

import { createWindSession } from './wind-session';

function harness() {
  wind.status = 'ready';
  const withWind = (suffix: string) => {
    const build = fixtureBuild({ buildId: `20260101T000000Z-${suffix.repeat(36)}` });
    (build.manifest as unknown as { mapData: { sha256: string; bytes: number } }).mapData = { sha256: 'a', bytes: 1 };
    return build;
  };
  const buildA = withWind('a'), buildB = withWind('b');
  const framesA = renderedFrames(buildA.manifest), framesB = renderedFrames(buildB.manifest);
  const statuses: WindStatus[] = [], qualities: boolean[] = [], fields: WindHeight[] = [], modes: string[] = [], displayed: boolean[] = [];
  let build = buildA, frame = framesA[0]!.id, height: WindHeight = 'surface', failed = false;
  let displayedRaster: { build: typeof buildA; frame: string } | null = null;
  let bounds = { west: -110, east: -90, south: 30, north: 45 };
  const clear = vi.fn();
  const session = createWindSession({
    apiBaseUrl: 'https://api.test', lowMemory: false,
    map: { getZoom: () => 5, getBounds: () => ({ getWest: () => bounds.west, getEast: () => bounds.east, getSouth: () => bounds.south, getNorth: () => bounds.north }) },
    scheduler: { fetch: vi.fn() as unknown as typeof fetch, dispose: vi.fn() },
    cache: { isBuildUnavailable: () => false, allocatedBytes: 0, clear: vi.fn() },
    overlay: { setWindActive: vi.fn() },
    field: { setField: (_field, mode) => { fields.push(height); modes.push(mode); }, clear },
    publish: {
      status: status => statuses.push(status), quality: overview => qualities.push(overview),
      displayed: value => displayed.push(value), reservation: vi.fn(), pointWind: vi.fn()
    },
    state: () => ({ build, selectedFrame: frame, height, visible: true, mapReady: true, expired: false, mapFailed: false, aborted: false }),
    displayedRaster: () => displayedRaster,
    replacementFailed: () => failed
  });
  return {
    session, buildA, buildB, framesA, framesB, statuses, fields, modes, displayed, clear,
    setBuild: (value: typeof buildA) => { build = value; }, setFrame: (value: string) => { frame = value; },
    setDisplayed: (value: typeof displayedRaster) => { displayedRaster = value; }, setFailed: (value: boolean) => { failed = value; },
    setHeight: (value: WindHeight) => { height = value; }, setBounds: (value: typeof bounds) => { bounds = value; }
  };
}

async function ready(test: ReturnType<typeof harness>) {
  test.session.update();
  await vi.waitFor(() => expect(test.session.current).not.toBeNull());
  await vi.waitFor(() => expect(test.statuses.at(-1)).toBe('ready'));
}

describe('wind session acquisition and presentation status', () => {
  it('reports ready after the raster catches up', async () => {
    const test = harness();
    await ready(test);
    test.setDisplayed({ build: test.buildA, frame: test.framesA[0]!.id });
    test.session.reconcile();
    expect(test.statuses.at(-1)).toBe('ready');
    expect(test.fields.at(-1)).toBe('surface');
  });

  it('keeps a retained source usable after raster replacement recovers', async () => {
    const test = harness();
    await ready(test);
    test.setDisplayed({ build: test.buildA, frame: test.framesA[1]!.id });
    test.setFailed(true);
    test.session.reconcile();
    expect(test.statuses.at(-1)).toBe('unavailable');
    test.setFailed(false);
    test.setDisplayed({ build: test.buildA, frame: test.framesA[0]!.id });
    test.session.reconcile();
    expect(test.statuses.at(-1)).toBe('ready');
    expect(test.fields.at(-1)).toBe('surface');
  });

  it('rebuilds the installed field when the selected height changes', async () => {
    const test = harness();
    await ready(test);
    test.setDisplayed({ build: test.buildA, frame: test.framesA[0]!.id });
    test.session.reconcile();
    test.setHeight(1000);
    test.session.heightChanged('surface');
    expect(test.fields.at(-1)).toBe(1000);
    expect(test.modes.at(-1)).toBe('replace');
  });

  it('reports unavailable and clears an unusable field when a replacement request fails', async () => {
    const test = harness();
    await ready(test);
    test.setDisplayed({ build: test.buildA, frame: test.framesA[0]!.id });
    test.session.reconcile();
    test.setFrame(test.framesA[1]!.id);
    test.setBounds({ west: -10, east: 10, south: 30, north: 45 });
    wind.status = 'unavailable';
    test.session.update();
    await vi.waitFor(() => expect(test.statuses.at(-1)).toBe('unavailable'));
    expect(test.clear).toHaveBeenCalled();
    expect(test.displayed.at(-1)).toBe(false);
  });

  it('does not install a new model field over the previous model raster', async () => {
    const test = harness();
    await ready(test);
    test.setDisplayed({ build: test.buildA, frame: test.framesA[0]!.id });
    test.session.reconcile();
    const before = test.fields.length;
    test.setBuild(test.buildB);
    test.setFrame(test.framesB[0]!.id);
    test.setDisplayed({ build: test.buildA, frame: test.framesA[0]!.id });
    test.session.update();
    await vi.waitFor(() => expect(test.session.current?.build).toBe(test.buildB));
    test.session.reconcile();
    expect(test.fields.length).toBe(before);
    expect(test.statuses.at(-1)).toBe('loading');
    test.setDisplayed({ build: test.buildB, frame: test.framesB[0]!.id });
    test.session.reconcile();
    expect(test.fields.length).toBeGreaterThan(before);
    expect(test.statuses.at(-1)).toBe('ready');
  });
});
