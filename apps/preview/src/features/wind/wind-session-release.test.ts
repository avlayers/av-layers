import { afterEach, expect, it, vi } from 'vitest';
import { fixtureBuild } from '../../../../../tests/forecast-fixture';

const wind = vi.hoisted(() => ({ live: 0, retained: 0, unreferenced: 0, limit: 3, attempts: [] as string[], notify: null as null | (() => void) }));
vi.mock('@av/client/wind', () => ({
  WindCapacityError: class extends Error { readonly code = 'capacity'; },
  WindDataSource: class {
    readonly isOverview = false;
    readonly admitted = undefined;
    readonly load = vi.fn(async (request: { frame: string }) => {
      wind.attempts.push(request.frame);
      if (wind.live >= wind.limit) throw new RangeError('Wind cache exceeds byte budget');
      wind.live++; wind.retained += 1024; return 'ready';
    });
    readonly dispose = vi.fn(() => { wind.live = Math.max(0, wind.live - 1); wind.unreferenced++; });
    readonly prepare = vi.fn(() => ({ bounds: [0, 0, 1, 1] as [number, number, number, number], data: new Uint8Array(4), size: 1, height: 'surface' as const, key: 'p' }));
    readonly field = () => ({ sample: () => ({ u: 1, v: 1, status: 0 }) });
    readonly sample = vi.fn(() => ({ u: 1, v: 1, status: 'valid' }));
  }
}));

import { createWindSession } from './wind-session';
const ARMENIA = { west: 44.27798057856188, east: 44.72201942143812, south: 40.104612670852696, north: 40.29538732914732 };
function session() {
  const build = fixtureBuild({ buildId: `20260101T000000Z-${'c'.repeat(36)}` });
  (build.manifest as unknown as { mapData: { sha256: string; bytes: number } }).mapData = { sha256: 'a', bytes: 1 };
  const cache = {
    isBuildUnavailable: () => false,
    get allocatedBytes() { return wind.retained; },
    clear: vi.fn(),
    onRelease: null as null | (() => void),
    evictUnreferenced() { const freed = wind.unreferenced * 1024; wind.unreferenced = 0; wind.retained -= freed; return freed; }
  };
  wind.notify = () => cache.onRelease?.();
  return createWindSession({
    apiBaseUrl: 'https://api.test', lowMemory: false,
    map: { getZoom: () => 10, getBounds: () => ({ getWest: () => ARMENIA.west, getEast: () => ARMENIA.east, getSouth: () => ARMENIA.south, getNorth: () => ARMENIA.north }) },
    scheduler: { fetch: vi.fn() as unknown as typeof fetch }, cache,
    overlay: { setWindActive: vi.fn() },
    field: { install: vi.fn(), setField: vi.fn(), setPrepared: vi.fn(), clear: vi.fn() },
    publish: { status: vi.fn(), quality: vi.fn(), displayed: vi.fn(), reservation: vi.fn(), pointWind: vi.fn() },
    state: () => ({ build, selectedFrame: build.manifest.frames[0]!.id, height: 'surface', visible: true, mapReady: true, expired: false, mapFailed: false, aborted: false }),
    displayedRaster: () => null,
    replacementFailed: () => false
  });
}
afterEach(() => { vi.useRealTimers(); wind.live = 0; wind.retained = 0; wind.unreferenced = 0; wind.attempts.length = 0; wind.notify = null; });

it('automatically resumes useful preparation after a real release while the admitted window stays bounded', async () => {
  vi.useFakeTimers();
  const view = session();
  view.update();
  await vi.advanceTimersByTimeAsync(20_000);
  const before = wind.attempts.length;
  expect(before).toBeLessThanOrEqual(5);
  expect(view.preparation.limited).toBe(true);
  wind.live = 2; wind.unreferenced = 1;
  wind.notify!();
  await vi.advanceTimersByTimeAsync(20_000);
  expect(wind.attempts.length).toBeGreaterThan(before);
  expect(wind.retained).toBeLessThanOrEqual(wind.limit * 1024);
  view.destroy();
});
