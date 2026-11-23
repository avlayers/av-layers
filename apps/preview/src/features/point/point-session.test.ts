import { describe, expect, it, vi } from 'vitest';
import { fixtureBuild } from '../../../../../tests/forecast-fixture';
import type { GeoPoint, PointSeriesContext } from '@av/client';
import type { PointSessionOptions } from './point-session';

const render = vi.fn((_host: HTMLElement, _payload: unknown, _build: unknown, _options: { onFrame(id: string): void }) => vi.fn());
const dispose = vi.fn();
vi.mock('@av/windgram', () => ({ renderPointWindgram: render, disposePointWindgram: dispose }));

import { createPointSession } from './point-session';

function harness() {
  const build = fixtureBuild(), point: GeoPoint = { lat: 40, lon: -100 };
  const context: PointSeriesContext = { build, point };
  const series = {
    current: context as PointSeriesContext | null,
    frameId: 'f024',
    pending: false,
    open: vi.fn(),
    close: vi.fn(),
    followMapFrame: vi.fn(),
    selectFrame: vi.fn((_context: PointSeriesContext, id: string) => { series.frameId = id; return true; }),
    async load(_horizon: unknown, _frame: string | null, view: { prepare?: () => Promise<void>; onProgress(payload: unknown, total: number, loading: boolean): void }) {
      await view.prepare?.();
      view.onProgress({}, 8, false);
    }
  };
  const options: PointSessionOptions = {
    series: series as never,
    body: () => ({ replaceChildren: vi.fn(), tabIndex: 0 }) as unknown as HTMLElement,
    getBuild: () => build, getSelectedFrame: () => 'f024', getUnits: () => 'metric', getHorizon: () => 'day',
    getMapOffset: () => 0, getDisplayedFrame: () => 'f024', ensureLive: () => true,
    pauseTimeline: vi.fn(), selectFrameById: vi.fn(),
    publish: {
      open: vi.fn(), close: vi.fn(), status: vi.fn(), busy: vi.fn(), horizon: vi.fn(), wind: vi.fn(), changed: vi.fn()
    }
  };
  return { session: createPointSession(options), series, updates: [] as Array<string | null>, options };
}

describe('point session selection beyond the map horizon', () => {
  it('refreshes the chart when no map frame exists for the selected hour', async () => {
    const test = harness();
    const update = vi.fn((frame: string | null) => { test.updates.push(frame); });
    render.mockReturnValue(update as never);
    await test.session.open({ lat: 40, lon: -100 });
    const options = render.mock.calls.at(-1)?.[3];
    expect(options).toBeDefined();
    vi.mocked(test.options.publish.changed).mockClear();
    options!.onFrame('f027');
    expect(test.series.frameId).toBe('f027');
    expect(test.options.selectFrameById).toHaveBeenCalledWith('f027');
    expect(update).toHaveBeenLastCalledWith('f027', 'metric', 'f024', undefined, 0);
    expect(test.options.publish.changed).toHaveBeenCalledTimes(1);
  });

  it('publishes independent site elevation, falls back to model ground instead of weather donor, honors outside-domain, and upgrades on late terrain arrival', async () => {
    const elevations: Array<[number | null, 'terrain' | 'model' | null]> = [];
    const build = fixtureBuild();
    const point: GeoPoint = { lat: 40.4186, lon: 44.4547 };
    let emitProgress!: (payload: unknown, total: number, loading: boolean) => void;
    const series = {
      current: { build, point } as PointSeriesContext | null,
      frameId: 'f024',
      pending: false,
      open: vi.fn(),
      close: vi.fn(),
      followMapFrame: vi.fn(),
      selectFrame: vi.fn(() => true),
      async load(_h: unknown, _f: string | null, view: { prepare?: () => Promise<void>; onProgress(payload: unknown, total: number, loading: boolean): void }) {
        await view.prepare?.();
        emitProgress = view.onProgress;
      },
    };
    const session = createPointSession({
      series: series as never,
      body: () => ({ replaceChildren: vi.fn(), tabIndex: 0 }) as unknown as HTMLElement,
      getBuild: () => build,
      getSelectedFrame: () => 'f024',
      getUnits: () => 'metric',
      getHorizon: () => 'day',
      getMapOffset: () => 0,
      getDisplayedFrame: () => 'f024',
      ensureLive: () => true,
      pauseTimeline: vi.fn(),
      selectFrameById: vi.fn(),
      publish: {
        open: vi.fn(),
        close: vi.fn(),
        status: vi.fn(),
        busy: vi.fn(),
        horizon: vi.fn(),
        wind: vi.fn(),
        elevation: (m, ref) => { elevations.push([m, ref]); },
        changed: vi.fn(),
      },
    });
    render.mockReturnValue(vi.fn() as never);
    await session.open(point);

    const donorFrame = {
      id: 'f024',
      validTime: build.manifest.frames[0]!.validTime,
      intervalStart: build.manifest.frames[0]!.intervalStart,
      intervalEnd: build.manifest.frames[0]!.intervalEnd,
      layers: {
        'usable-lift-msl': { value: 2770.101, status: 'valid', support: 0, interpolated: false, surfaceId: 'gfs-fine' },
        'usable-lift-agl': { value: 300, status: 'valid', support: 0, interpolated: false, surfaceId: 'gfs-fine' },
      },
      profile: { modelTerrainM: 1794, surfacePressureHpa: 820, status: 'valid', levels: [] },
    };

    // 1) Weather arrives before siteTerrain: reports native model terrain ('model'), never weather donor 2,470.101 m as 'terrain'
    emitProgress({ layers: [], frames: [donorFrame] }, 1, true);
    expect(elevations.at(-1)).toEqual([1794, 'model']);

    // 2) Late siteTerrain recovery upgrades header to independent site terrain (2,297.272 m)
    emitProgress({
      layers: [],
      frames: [donorFrame],
      siteTerrain: { elevationM: 2297.272, status: 'valid', interpolated: true, surfaceId: 'gfs-fine', surface: 'DSM', verticalDatum: 'EGM2008' },
    }, 1, false);
    expect(elevations.at(-1)).toEqual([2297.272, 'terrain']);

    // 3) Explicit outside-domain clears elevation rather than falling back to donor or model terrain
    emitProgress({
      layers: [],
      frames: [donorFrame],
      siteTerrain: { elevationM: null, status: 'outside-domain', interpolated: false, surfaceId: 'gfs-fine', surface: 'DSM', verticalDatum: 'EGM2008' },
    }, 1, false);
    expect(elevations.at(-1)).toEqual([null, null]);
  });
});
