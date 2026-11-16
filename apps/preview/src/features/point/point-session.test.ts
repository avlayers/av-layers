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
    api: {} as PointSessionOptions['api'], series: series as never,
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
    options!.onFrame('f027');
    expect(test.series.frameId).toBe('f027');
    expect(test.options.selectFrameById).toHaveBeenCalledWith('f027');
    expect(update).toHaveBeenLastCalledWith('f027', 'metric', 'f024', undefined, 0);
    expect(test.options.publish.changed).toHaveBeenCalled();
  });
});
