import { describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '@av/client';
import { renderedFrames } from '@av/contracts/publication';
import { fixtureBuild } from '../../../../../tests/forecast-fixture';
import type { PreviewIntent } from '../../stores/app-store';
import { createForecastSession } from './forecast-session';

function build() {
  return fixtureBuild({ expiresAt: new Date(Date.now() + 86_400_000).toISOString(), createdAt: new Date().toISOString() });
}

function harness() {
  const builds = [build(), build()];
  const calls: string[] = [];
  const intent: PreviewIntent = {
    model: 'gfs', reference: 'agl', customLayer: null, opacity: 0.5, units: 'metric',
    windStyle: 'trails', windVisible: true, windVisibleOverride: null, windPaused: false,
    windHeight: 'surface', fixedWindHeight: 0, pointHorizon: 'day', requestedTime: null
  };
  let current = { ...intent };
  const latest = vi.fn(async (model: string) => { calls.push(model); return builds[0]!; });
  const session = createForecastSession({
    api: { latest } as unknown as ApiClient,
    writer: {
      forecast: update => { calls.push(`forecast:${JSON.stringify(update)}`); },
      intent: update => { current = { ...current, ...update }; calls.push(`intent:${JSON.stringify(update)}`); },
      notices: update => { calls.push(`notices:${JSON.stringify(update)}`); }
    },
    intent: () => current,
    center: () => ({ lat: 40, lon: -100 }),
    mapFailed: () => false,
    aborted: () => false,
    now: () => Date.now(),
    hooks: {
      onLoading: model => calls.push(`loading:${model}`),
      onBuild: (next, frame, resolved) => calls.push(`build:${next.manifest.buildId}:${frame}:${resolved}`),
      onSameBuild: frame => calls.push(`same:${frame}`),
      onCleared: message => calls.push(`cleared:${message}`),
      onExpired: () => calls.push('expired'),
      onUrl: mode => calls.push(`url:${mode}`),
      watchExpiry: () => () => undefined,
      startTimer: () => calls.push('timer:start'),
      stopTimer: () => calls.push('timer:stop')
    }
  });
  return { session, calls, latest, builds, current: () => current };
}

describe('forecast session', () => {
  it('loads a manual model and commits its selected frame and time', async () => {
    const test = harness();
    await test.session.load('gfs');
    const frame = renderedFrames(test.builds[0]!.manifest).at(-1)!;
    expect(test.session.build).toBe(test.builds[0]);
    expect(test.session.selectedFrame).toBe(frame.id);
    expect(test.current().requestedTime).toBe(frame.validTime);
    expect(test.session.pendingModel).toBeNull();
    expect(test.calls.some(call => call.startsWith('build:'))).toBe(true);
    expect(test.calls).toContain('url:replace');
  });

  it('ignores a stale completion after a newer load starts', async () => {
    const test = harness();
    let resolveFirst!: (value: unknown) => void;
    const first = new Promise(resolve => { resolveFirst = resolve; });
    test.latest.mockImplementationOnce(async () => first as never);
    const stale = test.session.load('gfs');
    const fresh = test.session.load('icon-eu');
    resolveFirst(test.builds[0]);
    await stale; await fresh;
    expect(test.session.build).toBe(test.builds[0]);
    expect(test.session.pendingModel).toBeNull();
  });

  it('expires an overdue build and stops its timer', async () => {
    const test = harness();
    await test.session.load('gfs');
    test.calls.length = 0;
    const overdue = fixtureBuild({ expiresAt: new Date(Date.now() - 1_000).toISOString(), createdAt: new Date(Date.now() - 2_000).toISOString() });
    test.session.expire();
    expect(test.calls).toContain('expired');
    expect(test.session.expired).toBe(true);
    expect(overdue).toBeDefined();
  });

  it('suspends a pending discovery and resumes it', async () => {
    const test = harness();
    test.latest.mockImplementationOnce(() => new Promise(() => undefined));
    void test.session.load('gfs');
    const resumed = test.session.suspend();
    expect(resumed).toBe('gfs');
    test.session.resume(resumed!);
    expect(test.latest).toHaveBeenCalledTimes(2);
  });
});
