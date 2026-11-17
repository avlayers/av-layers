import { afterEach, expect, it, vi } from 'vitest';
import { fixtureBuild } from '../../../../../tests/forecast-fixture';

const wind = vi.hoisted(() => ({ live: 0, limit: 3, attempts: [] as string[] }));
vi.mock('@av/client/wind', () => ({
  WindCapacityError: class extends Error { readonly code = 'capacity'; },
  WindDataSource: class {
    readonly isOverview = false;
    readonly admitted = undefined;
    frame = '';
    readonly load = vi.fn(async (request: { frame: string }) => {
      wind.attempts.push(request.frame);
      if (wind.live >= wind.limit) throw new RangeError('Wind cache exceeds byte budget');
      wind.live++; this.frame = request.frame; return 'ready';
    });
    readonly dispose = vi.fn(() => { wind.live = Math.max(0, wind.live - 1); });
    readonly prepare = vi.fn(() => ({ bounds: [0, 0, 1, 1] as [number, number, number, number], data: new Uint8Array(4), size: 1, height: 'surface' as const, key: 'p' }));
    readonly field = () => ({ sample: () => ({ u: 1, v: 1, status: 0 }) });
    readonly sample = vi.fn(() => ({ u: 1, v: 1, status: 'valid' }));
  }
}));

import { createWindSession } from './wind-session';
const ARMENIA = { west: 44.27798057856188, east: 44.72201942143812, south: 40.104612670852696, north: 40.29538732914732 };

function session() {
  const build = fixtureBuild({ buildId: `20260101T000000Z-${'b'.repeat(36)}` });
  (build as { expiresAtMs: number }).expiresAtMs = Date.now() + 86_400_000;
  (build.manifest as unknown as { mapData: { sha256: string; bytes: number } }).mapData = { sha256: 'a', bytes: 1 };
  const frame = build.manifest.frames[0]!.id;
  return createWindSession({
    apiBaseUrl: 'https://api.test', lowMemory: false,
    map: { getZoom: () => 10, getBounds: () => ({ getWest: () => ARMENIA.west, getEast: () => ARMENIA.east, getSouth: () => ARMENIA.south, getNorth: () => ARMENIA.north }) },
    scheduler: { fetch: vi.fn() as unknown as typeof fetch },
    cache: { isBuildUnavailable: () => false, get allocatedBytes() { return wind.live * 1024; }, clear: vi.fn() },
    overlay: { setWindActive: vi.fn() },
    field: { install: vi.fn(), setField: vi.fn(), setPrepared: vi.fn(), clear: vi.fn() },
    publish: { status: vi.fn(), quality: vi.fn(), displayed: vi.fn(), reservation: vi.fn(), pointWind: vi.fn() },
    state: () => ({ build, selectedFrame: frame, height: 'surface', visible: true, mapReady: true, expired: false, mapFailed: false, aborted: false }),
    displayedRaster: () => null,
    replacementFailed: () => false
  });
}

afterEach(() => { vi.useRealTimers(); wind.live = 0; wind.limit = 3; wind.attempts.length = 0; });

it('settles on a bounded admitted window instead of evicting and reacquiring', async () => {
  vi.useFakeTimers();
  const view = session();
  view.update();
  await vi.advanceTimersByTimeAsync(20_000);
  const attempts = wind.attempts.length;
  expect(attempts).toBeLessThanOrEqual(7);
  expect(view.preparation).toMatchObject({ promised: 8, admitted: 3, limited: true });
  await vi.advanceTimersByTimeAsync(20_000);
  expect(wind.attempts.length).toBe(attempts);
  view.destroy();
});

it('resumes expansion after an explicit clear releases the admitted window', async () => {
  vi.useFakeTimers();
  const view = session();
  view.update();
  await vi.advanceTimersByTimeAsync(10_000);
  const first = wind.attempts.length;
  view.clear();
  view.update();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(wind.attempts.length).toBeGreaterThan(first);
  expect(view.preparation.limited).toBe(true);
  view.destroy();
});
