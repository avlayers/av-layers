import { describe, expect, it, vi } from 'vitest';
import { renderedFrames } from '@av/contracts/publication';
import { fixtureBuild } from '../../../../../tests/forecast-fixture';
import type { WindHeight, WindStatus } from './wind-model';

vi.mock('@av/client/wind', () => ({
  WindDataSource: class {
    readonly isOverview = false;
    readonly admitted = undefined;
    readonly load = vi.fn(async () => 'ready' as const);
    readonly dispose = vi.fn();
    readonly sample = vi.fn((_lat: number, _lon: number, height: WindHeight) => ({ u: 1, v: 2, status: 'valid', height }));
  }
}));

import { createWindSession } from './wind-session';

function harness() {
  const build = fixtureBuild(), frames = renderedFrames(build.manifest), frame = frames[0]!.id;
  (build.manifest as unknown as { mapData: { sha256: string; bytes: number } }).mapData = { sha256: 'a', bytes: 1 };
  const statuses: WindStatus[] = [], qualities: boolean[] = [], fields: WindHeight[] = [], modes: string[] = [];
  let height: WindHeight = 'surface', displayedFrame: string | null = null, failed = false;
  const state = () => ({ build, selectedFrame: frame, height, visible: true, mapReady: true, expired: false, mapFailed: false, aborted: false });
  const session = createWindSession({
    apiBaseUrl: 'https://api.test', lowMemory: false,
    map: { getZoom: () => 5, getBounds: () => ({ getWest: () => -110, getEast: () => -90, getSouth: () => 30, getNorth: () => 45 }) },
    scheduler: { fetch: vi.fn() as unknown as typeof fetch, dispose: vi.fn() },
    cache: { isBuildUnavailable: () => false, allocatedBytes: 0, clear: vi.fn() },
    overlay: { setWindActive: vi.fn() },
    field: { setField: (_field, mode) => { fields.push(height); modes.push(mode); }, clear: vi.fn() },
    publish: {
      status: status => statuses.push(status), quality: overview => qualities.push(overview),
      displayed: vi.fn(), reservation: vi.fn(), pointWind: vi.fn()
    },
    state,
    displayedRaster: () => displayedFrame ? { build, frame: displayedFrame } : null,
    replacementFailed: () => failed
  });
  return { session, statuses, fields, modes, frames, setDisplayed: (value: string | null) => { displayedFrame = value; }, setFailed: (value: boolean) => { failed = value; }, setHeight: (value: WindHeight) => { height = value; } };
}

describe('wind session acquisition and presentation status', () => {
  it('reports ready after the raster catches up', async () => {
    const test = harness();
    test.session.update();
    await vi.waitFor(() => expect(test.session.current).not.toBeNull());
    test.setDisplayed(test.frames[0]!.id);
    test.session.reconcile();
    expect(test.statuses.at(-1)).toBe('ready');
    expect(test.fields.at(-1)).toBe('surface');
  });

  it('keeps a retained source usable after raster replacement recovers', async () => {
    const test = harness();
    test.session.update();
    await vi.waitFor(() => expect(test.session.current).not.toBeNull());
    test.setDisplayed(test.frames[1]!.id);
    test.setFailed(true);
    test.session.reconcile();
    expect(test.statuses.at(-1)).toBe('unavailable');
    test.setFailed(false);
    test.setDisplayed(test.frames[0]!.id);
    test.session.reconcile();
    expect(test.statuses.at(-1)).toBe('ready');
    expect(test.fields.at(-1)).toBe('surface');
  });

  it('rebuilds the installed field when the selected height changes', async () => {
    const test = harness();
    test.session.update();
    await vi.waitFor(() => expect(test.session.current).not.toBeNull());
    test.setDisplayed(test.frames[0]!.id);
    test.session.reconcile();
    test.setHeight(1000);
    test.session.heightChanged('surface');
    expect(test.fields.at(-1)).toBe(1000);
    expect(test.modes.at(-1)).toBe('replace');
  });
});
