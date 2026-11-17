import { afterEach, expect, it, vi } from 'vitest';
import { fixtureBuild } from '../../../../../tests/forecast-fixture';

const wind = vi.hoisted(() => ({ live: 0, retained: 0, peak: 0, unreferenced: 0, limit: 3, attempts: [] as string[], notify: null as null | (() => void) }));
vi.mock('@av/client/wind', () => ({
  WindCapacityError: class extends Error { readonly code = 'capacity'; },
  WindDataSource: class {
    readonly isOverview = false;
    readonly admitted = undefined;
    private acquired = false;
    readonly load = vi.fn(async (request: { frame: string }) => {
      wind.attempts.push(request.frame);
      if (wind.retained >= wind.limit * 1024) throw new RangeError('Wind cache exceeds byte budget');
      this.acquired = true; wind.live++; wind.retained += 1024;
      wind.peak = Math.max(wind.peak, wind.retained); return 'ready';
    });
    readonly dispose = vi.fn(() => {
      if (!this.acquired) return;
      this.acquired = false; wind.live--; wind.unreferenced++;
    });
    readonly prepare = vi.fn(() => ({ bounds: [0, 0, 1, 1] as [number, number, number, number], data: new Uint8Array(4), size: 1, height: 'surface' as const, key: 'p' }));
    readonly prepareAsync = async () => this.prepare();
    readonly field = () => ({ sample: () => ({ u: 1, v: 1, status: 0 }) });
    readonly sample = vi.fn(() => ({ u: 1, v: 1, status: 'valid' }));
  }
}));

import { createWindSession } from './wind-session';
const ARMENIA = { west: 44.27798057856188, east: 44.72201942143812, south: 40.104612670852696, north: 40.29538732914732 };
function session() {
  const build = fixtureBuild({ buildId: `20260101T000000Z-${'c'.repeat(36)}` });
  (build as { expiresAtMs: number }).expiresAtMs = Date.now() + 86_400_000;
  (build.manifest as unknown as { mapData: { sha256: string; bytes: number } }).mapData = { sha256: 'a', bytes: 1 };
  const cache = {
    isBuildUnavailable: () => false,
    get allocatedBytes() { return wind.retained; },
    clear: vi.fn(),
    onRelease: null as null | (() => void),
    evictUnreferenced() { const freed = wind.unreferenced * 1024; wind.unreferenced = 0; wind.retained -= freed; return freed; }
  };
  wind.notify = () => cache.onRelease?.();
  const view = createWindSession({
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
  return { view, cache };
}
afterEach(() => { vi.useRealTimers(); wind.live = 0; wind.retained = 0; wind.peak = 0; wind.unreferenced = 0; wind.attempts.length = 0; wind.notify = null; });

it('automatically resumes useful preparation after a real release while the admitted window stays bounded', async () => {
  vi.useFakeTimers();
  // A separate owner holds one cache entry until the first window has settled.
  wind.live = 1; wind.retained = 1024;
  const { view, cache } = session();
  try {
    view.update();
    await vi.advanceTimersByTimeAsync(20_000);
    const before = wind.attempts.length;
    expect(before).toBeLessThanOrEqual(7);
    expect(view.preparation).toMatchObject({ admitted: 2, ready: 2, limited: true });
    expect(wind.unreferenced).toBe(0);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(wind.attempts).toHaveLength(before);

    wind.live--; wind.unreferenced++;
    wind.notify!();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(wind.attempts.length).toBeGreaterThan(before);
    expect(view.preparation).toMatchObject({ admitted: 3, ready: 3, limited: true });
    const after = wind.attempts.length;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(wind.attempts).toHaveLength(after);
    expect(wind.peak).toBeLessThanOrEqual(wind.limit * 1024);
    expect(wind.retained).toBe(wind.limit * 1024);
  } finally { view.destroy(); cache.evictUnreferenced(); }
  expect(wind.live).toBe(0);
  expect(wind.retained).toBe(0);
});
