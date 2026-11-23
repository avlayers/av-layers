import { afterEach, describe, expect, it, vi } from 'vitest';
import { fixtureBuild } from '../../../../../tests/forecast-fixture';
import type { GeoPoint, PinnedBuild, PointSeriesContext } from '@av/client';
import { formatSitePlaceTime } from '@av/client/timezone';

const lazy = vi.hoisted(() => ({ createPointSession: vi.fn() }));
vi.mock('../lazy', () => ({ createPointSession: lazy.createPointSession }));

import { createPointFeature, type PointWind } from './point-feature';

const point: GeoPoint = { lat: 40, lon: -100 };
afterEach(() => vi.unstubAllGlobals());

function expectedStamp(build: PinnedBuild, frame: string, target: GeoPoint = point): string {
  const validTime = build.manifest.frames.find(candidate => candidate.id === frame)!.validTime;
  return formatSitePlaceTime(Date.parse(validTime), target, 'stamp');
}

async function harness(initialFrames?: PinnedBuild['manifest']['frames']) {
  const build = fixtureBuild(initialFrames ? { frames: initialFrames, mapFrameCount: initialFrames.length } : {});
  let activePoint: GeoPoint = point;
  const session = {
    get current(): PointSeriesContext | null { return { build, point: activePoint }; },
    frameId: build.manifest.frames[0]!.id as string | null,
    pending: false,
    open: vi.fn(async (next: GeoPoint) => { activePoint = next; }),
    close: vi.fn(),
    updateSelection: vi.fn(),
    followMapFrame: vi.fn((id: string | null) => { if (id) session.frameId = id; }),
    formatWindTime: vi.fn((validMs: number) => formatSitePlaceTime(validMs, activePoint, 'stamp')),
    renderBuildDetails: vi.fn(),
    loadRange: vi.fn(async () => {}),
    suspend: vi.fn(),
    dispose: vi.fn()
  };
  lazy.createPointSession.mockReturnValue(session);
  const sample = vi.fn(() => ({ u: 3, v: 4, status: 'valid' }));
  let selectedFrame = build.manifest.frames[0]!.id;
  let wind: PointWind | null = { build, frame: selectedFrame, sample };
  const publish = {
    open: vi.fn(), close: vi.fn(), status: vi.fn(), busy: vi.fn(), horizon: vi.fn(), wind: vi.fn()
  };
  let rootElement: HTMLElement | null = null;
  const feature = createPointFeature({
    root: () => rootElement,
    series: {} as never,
    getBuild: () => build,
    getSelectedFrame: () => selectedFrame,
    getUnits: () => 'metric',
    getHorizon: () => 'day',
    getMapOffset: () => -480,
    getDisplayedFrame: () => selectedFrame,
    getWind: () => wind,
    ensureLive: () => true,
    pauseTimeline: vi.fn(),
    selectFrameById: vi.fn(),
    publish
  });
  return {
    build, sample, publish, feature, session,
    setRoot(next: HTMLElement | null) { rootElement = next; },
    setWind(next: PointWind | null) { wind = next; },
    setFrame(frameId: string) {
      selectedFrame = frameId;
      session.frameId = frameId;
      wind = { build, frame: frameId, sample };
    }
  };
}

describe('point map wind readout', () => {
  it.each(['close', 'suspend', 'dispose'] as const)('cancels a lazy point open on %s before it can start requests', async action => {
    const test = await harness();
    lazy.createPointSession.mockClear();
    const pending = test.feature.open(point);
    const importing = test.feature.pending;
    test.feature[action]();
    expect(test.feature.pending).toBe(false);
    await pending;
    expect(test.session.open).not.toHaveBeenCalled();
    expect(test.publish.horizon).not.toHaveBeenCalled();
    expect(importing).toBe(true);
    expect(test.feature.pending).toBe(false);
    if (action === 'dispose') {
      expect(lazy.createPointSession).not.toHaveBeenCalled();
      await test.feature.open(point);
      expect(lazy.createPointSession).not.toHaveBeenCalled();
    } else {
      await test.feature.open(point);
      expect(test.session.open).toHaveBeenCalledOnce();
    }
    test.feature.dispose();
  });

  it('dismisses a pending lazy open outside the map before requests can start, while keeping #model-picker open', async () => {
    class NodeStub { contains(node: unknown) { return node === this; } }
    vi.stubGlobal('Node', NodeStub);
    const test = await harness();
    const map = new NodeStub() as unknown as Element;
    const modelPicker = new NodeStub() as unknown as Element;
    const outside = new NodeStub() as unknown as Node;
    test.setRoot({
      querySelector: (selector: string) => (selector === '#model-picker' ? modelPicker : null)
    } as unknown as HTMLElement);
    const pending = test.feature.open(point);
    test.feature.dismiss(map, map);
    expect(test.feature.pending).toBe(true);
    test.feature.dismiss(modelPicker, map);
    expect(test.feature.pending).toBe(true);
    test.feature.dismiss(outside, map);
    expect(test.feature.pending).toBe(false);
    await pending;
    expect(test.session.open).not.toHaveBeenCalled();
    expect(test.publish.horizon).not.toHaveBeenCalled();
    test.feature.dispose();
  });

  it('allows only the newest click waiting on the lazy session to open', async () => {
    const test = await harness(), next = { lat: 41, lon: -99 };
    const first = test.feature.open(point), second = test.feature.open(next);
    await Promise.all([first, second]);
    expect(test.session.open).toHaveBeenCalledExactlyOnceWith(next);
    test.feature.dispose();
  });

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

  it('resolves civil site time across Yerevan, Virginia, Madrid, Boise, DST transitions, half-hour zones, point switches, and offshore UTC fallback', async () => {
    const frames = [
      { id: 'f001', validTime: '2026-07-15T12:00:00.000Z', intervalStart: '2026-07-15T11:00:00.000Z', intervalEnd: '2026-07-15T12:00:00.000Z' },
      { id: 'f002', validTime: '2026-11-01T05:00:00.000Z', intervalStart: '2026-11-01T04:00:00.000Z', intervalEnd: '2026-11-01T05:00:00.000Z' },
      { id: 'f003', validTime: '2026-11-01T06:00:00.000Z', intervalStart: '2026-11-01T05:00:00.000Z', intervalEnd: '2026-11-01T06:00:00.000Z' },
      { id: 'f004', validTime: '2026-03-08T06:00:00.000Z', intervalStart: '2026-03-08T05:00:00.000Z', intervalEnd: '2026-03-08T06:00:00.000Z' },
      { id: 'f005', validTime: '2026-03-08T07:00:00.000Z', intervalStart: '2026-03-08T06:00:00.000Z', intervalEnd: '2026-03-08T07:00:00.000Z' },
    ];
    const test = await harness(frames);
    const sites: ReadonlyArray<readonly [GeoPoint, string]> = [
      [{ lat: 40.179, lon: 44.499 }, 'Jul 15, 16:00 (12:00 UTC)'],
      [{ lat: 38.8473, lon: -78.4121 }, 'Jul 15, 08:00 (12:00 UTC)'],
      [{ lat: 40.4168, lon: -3.7038 }, 'Jul 15, 14:00 (12:00 UTC)'],
      [{ lat: 43.615, lon: -116.202 }, 'Jul 15, 06:00 (12:00 UTC)'],
      [{ lat: 47.56, lon: -52.71 }, 'Jul 15, 09:30 (12:00 UTC)'],
      [{ lat: 30.0, lon: -40.0 }, 'Jul 15, 12:00 UTC (UTC fallback)'],
    ];
    for (const [site, expected] of sites) {
      await test.feature.open(site);
      test.setFrame('f001');
      test.feature.syncWind();
      expect(test.publish.wind).toHaveBeenLastCalledWith(`Map wind · ${expected} · 18 km/h`);
    }

    // US fall-back (Nov 1, 2026) and spring jump (Mar 8, 2026) at New York / Virginia
    await test.feature.open({ lat: 38.8473, lon: -78.4121 });
    test.setFrame('f002');
    test.feature.syncWind();
    expect(test.publish.wind).toHaveBeenLastCalledWith('Map wind · Nov 1, 01:00 (05:00 UTC) · 18 km/h');
    test.setFrame('f003');
    test.feature.syncWind();
    expect(test.publish.wind).toHaveBeenLastCalledWith('Map wind · Nov 1, 01:00 (06:00 UTC) · 18 km/h');
    test.setFrame('f004');
    test.feature.syncWind();
    expect(test.publish.wind).toHaveBeenLastCalledWith('Map wind · Mar 8, 01:00 (06:00 UTC) · 18 km/h');
    test.setFrame('f005');
    test.feature.syncWind();
    expect(test.publish.wind).toHaveBeenLastCalledWith('Map wind · Mar 8, 03:00 (07:00 UTC) · 18 km/h');
    test.feature.dispose();
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
