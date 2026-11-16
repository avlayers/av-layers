import { afterEach, expect, it, vi } from 'vitest';
import { fixtureBuild } from '../../../../../tests/forecast-fixture';

const wind = vi.hoisted(() => ({ loads: [] as string[] }));
vi.mock('@av/client/wind', () => ({
  WindCapacityError: class extends Error { readonly code = 'capacity'; },
  WindDataSource: class {
    readonly isOverview = false;
    readonly admitted = undefined;
    readonly load = vi.fn(async (request: { frame: string }) => { wind.loads.push(request.frame); return 'ready'; });
    readonly dispose = vi.fn();
    readonly prepare = vi.fn(() => ({ bounds: [0, 0, 1, 1], data: new Uint8Array(4), size: 1, height: 'surface', key: 'p' }));
    readonly field = () => ({ sample: () => ({ u: 1, v: 1, status: 0 }) });
    readonly sample = vi.fn(() => ({ u: 1, v: 1, status: 'valid' }));
  }
}));

import { createWindSession } from './wind-session';

const ARMENIA = { west: 44.27798057856188, east: 44.72201942143812, south: 40.104612670852696, north: 40.29538732914732 };
const WIDE = { west: -110, east: -90, south: 30, north: 45 };

afterEach(() => { vi.useRealTimers(); });

it('warms the full rendered axis only while the viewport stays small', async () => {
  vi.useFakeTimers();
  wind.loads.length = 0;
  const build = fixtureBuild({ buildId: `20260101T000000Z-${'a'.repeat(36)}` });
  (build.manifest as unknown as { mapData: { sha256: string; bytes: number } }).mapData = { sha256: 'a', bytes: 1 };
  let bounds = WIDE; const frame = build.manifest.frames[0]!.id;
  const session = createWindSession({
    apiBaseUrl: 'https://api.test', lowMemory: false,
    map: { getZoom: () => 5, getBounds: () => ({ getWest: () => bounds.west, getEast: () => bounds.east, getSouth: () => bounds.south, getNorth: () => bounds.north }) },
    scheduler: { fetch: vi.fn() as unknown as typeof fetch },
    cache: { isBuildUnavailable: () => false, allocatedBytes: 0, clear: vi.fn() },
    overlay: { setWindActive: vi.fn() },
    field: { setField: vi.fn(), setPrepared: vi.fn(), clear: vi.fn() },
    publish: { status: vi.fn(), quality: vi.fn(), displayed: vi.fn(), reservation: vi.fn(), pointWind: vi.fn() },
    state: () => ({ build, selectedFrame: frame, height: 'surface', visible: true, mapReady: true, expired: false, mapFailed: false, aborted: false }),
    displayedRaster: () => null,
    replacementFailed: () => false
  });
  session.update();
  await vi.advanceTimersByTimeAsync(1_200);
  expect(wind.loads).toEqual([frame]);
  bounds = ARMENIA;
  session.update();
  await vi.advanceTimersByTimeAsync(5_000);
  expect(wind.loads.length).toBeGreaterThan(1);
  expect(new Set(wind.loads).size).toBeGreaterThanOrEqual(8);
  session.destroy();
});
