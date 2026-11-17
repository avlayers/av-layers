import { describe, expect, it, vi } from 'vitest';
import { fixtureBuild } from '../../../../../tests/forecast-fixture';
import { formatPlaceTime, longitudeOffsetHours, type GeoPoint, type PinnedBuild, type PointSeriesContext } from '@av/client';

const lazy = vi.hoisted(() => ({ createPointSession: vi.fn() }));
vi.mock('../lazy', () => ({ createPointSession: lazy.createPointSession }));

import { createPointFeature, type PointWind } from './point-feature';

const point: GeoPoint = { lat: 40, lon: -100 };

function expectedStamp(build: PinnedBuild, frame: string): string {
  const validTime = build.manifest.frames.find(candidate => candidate.id === frame)!.validTime;
  return formatPlaceTime(Date.parse(validTime), longitudeOffsetHours(point.lon) * 60, 'stamp');
}

async function harness() {
  const build = fixtureBuild();
  const context: PointSeriesContext = { build, point };
  const session = {
    current: context as PointSeriesContext | null,
    frameId: 'f003' as string | null,
    pending: false,
    open: vi.fn(async () => {}),
    close: vi.fn(),
    updateSelection: vi.fn(),
    followMapFrame: vi.fn(),
    loadRange: vi.fn(async () => {}),
    suspend: vi.fn(),
    dispose: vi.fn()
  };
  lazy.createPointSession.mockReturnValue(session);
  const sample = vi.fn(() => ({ u: 3, v: 4, status: 'valid' }));
  let wind: PointWind | null = { build, frame: 'f003', sample };
  const publish = {
    open: vi.fn(), close: vi.fn(), status: vi.fn(), busy: vi.fn(), horizon: vi.fn(), wind: vi.fn()
  };
  const feature = createPointFeature({
    root: () => null,
    series: {} as never,
    getBuild: () => build,
    getSelectedFrame: () => 'f003',
    getUnits: () => 'metric',
    getHorizon: () => 'day',
    getMapOffset: () => 0,
    getDisplayedFrame: () => 'f003',
    getWind: () => wind,
    ensureLive: () => true,
    pauseTimeline: vi.fn(),
    selectFrameById: vi.fn(),
    publish
  });
  return {
    build, sample, publish, feature,
    setWind(next: PointWind | null) { wind = next; }
  };
}

describe('point map wind readout', () => {
  it('keeps the native label and sampling', async () => {
    const test = await harness();
    await test.feature.open(point);
    test.feature.syncWind();
    expect(test.publish.wind).toHaveBeenLastCalledWith(`Map wind · ${expectedStamp(test.build, 'f003')} · 18 km/h`);
    expect(test.sample).toHaveBeenCalledTimes(1);
    expect(test.sample).toHaveBeenCalledWith(point.lat, point.lon);
  });

  it('marks an overview source explicitly', async () => {
    const test = await harness();
    test.setWind({ build: test.build, frame: 'f003', overview: true, sample: test.sample });
    await test.feature.open(point);
    test.feature.syncWind();
    expect(test.publish.wind).toHaveBeenLastCalledWith(`Map wind overview · ${expectedStamp(test.build, 'f003')} · 18 km/h`);
    expect(test.sample).toHaveBeenCalledTimes(1);
  });

  it('blanks mismatched frame, build, and cleared source without sampling', async () => {
    const test = await harness();
    await test.feature.open(point);
    test.sample.mockClear();

    test.setWind({ build: test.build, frame: 'f006', sample: test.sample });
    test.feature.syncWind();
    expect(test.publish.wind).toHaveBeenLastCalledWith('');

    test.setWind({ build: fixtureBuild({ buildId: '20261030T000000Z-00000000-0000-4000-8000-000000000001' }), frame: 'f003', sample: test.sample });
    test.feature.syncWind();
    expect(test.publish.wind).toHaveBeenLastCalledWith('');

    test.setWind(null);
    test.feature.syncWind();
    expect(test.publish.wind).toHaveBeenLastCalledWith('');

    expect(test.sample).not.toHaveBeenCalled();
  });
});
