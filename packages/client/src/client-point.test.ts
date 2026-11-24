import { describe, expect, it, vi } from 'vitest';
import { ApiClient } from './client-api';
import { MAX_POINT_RESPONSE_BYTES, STATUS_NO_LIFT, STATUS_OUTSIDE, STATUS_UNAVAILABLE, STATUS_VALID, estimateProfileResponseBytes, manifestV5Schema, maxProfileFrames } from '@av/contracts';
import { WIND_FINE_CELL_BYTES, windLayout } from '@av/contracts/wind-data';
import { pointLiftExpectation, pointSeriesSelection } from './client-point';
import { evaluateFineTerrainContributors, PointTerrainCache } from './client-point-terrain';
import type { PointSeries } from './client-types';
import { fixturePointBuild, fixturePointFetch, fixtureProfileBuild, retainedProfileBuild, retainedPointBuild, fixturePointSample } from '../../../tests/client-point-fixture';

const point = { lat: 32.9, lon: -117.25 };
function setup() {
  const build = retainedPointBuild();
  const fetchImpl = vi.fn<typeof fetch>(async input => new Response(JSON.stringify(fixturePointSample(build, String(input)))));
  const api = new ApiClient({ baseUrl: 'https://api.test', fetchImpl, now: () => Date.parse(build.manifest.createdAt) });
  return { build, fetchImpl, loader: api.pointSeries(build, point) };
}

describe('cached point forecast pages', () => {
  it('pages native profiles within the byte budget and merges fine-surface lift', async () => {
    const max = maxProfileFrames(30, 24);
    expect(estimateProfileResponseBytes(max, 30, 24)).toBeLessThanOrEqual(MAX_POINT_RESPONSE_BYTES);
    expect(estimateProfileResponseBytes(max + 1, 30, 24)).toBeGreaterThan(MAX_POINT_RESPONSE_BYTES);
    const build = retainedProfileBuild(), m = build.manifest;
    if (m.version !== 5) throw new Error('Expected v5');
    const urls: URL[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async input => {
      urls.push(new URL(String(input)));
      return new Response(JSON.stringify(fixturePointFetch(build, String(input))));
    });
    const api = new ApiClient({ baseUrl: 'https://api.test', fetchImpl, now: () => Date.parse(m.createdAt) });
    const series = await api.pointSeries(build, point).load('forecast');
    const profiles = urls.filter(url => url.pathname.endsWith('/profile'));
    expect(profiles.length).toBeGreaterThan(1);
    for (const url of profiles) {
      const frames = url.searchParams.get('frame')!.split(','), layers = url.searchParams.get('layers')!.split(',');
      expect(estimateProfileResponseBytes(frames.length, 4, layers.length)).toBeLessThanOrEqual(MAX_POINT_RESPONSE_BYTES);
      expect(layers).not.toContain('mslp-hpa');
      expect(layers).not.toContain('sensible-heat-flux');
      expect(layers).not.toContain('latent-heat-flux');
    }
    const fineFrames = urls.filter(url => url.pathname.endsWith('/sample')).flatMap(url => url.searchParams.get('frame')!.split(','));
    expect(fineFrames).toEqual(m.frames.slice(0, m.mapFrameCount).map(frame => frame.id));
    expect(series.frames.every(frame => frame.profile?.status === 'valid' && frame.derived !== undefined)).toBe(true);
    expect(series.frames[0]?.layers['usable-lift-msl']).toMatchObject({ surfaceId: 'gfs-fine' });
    expect(series.frames.at(-1)?.layers['usable-lift-msl']).toBeUndefined();
    expect(series.layers).toContain('usable-lift-msl');
    expect(series.layers).toContain('cloud-cover-total');
    expect(series.layers).toContain('cloud-cover-low');
    expect(pointSeriesSelection(build, 'forecast').layers).toEqual(series.layers);
  });

  it.each([{ lift: [] }, { lift: ['usable-lift-agl'] }] as const)('requests only the lift channels a profiled build publishes ($lift)', async ({ lift }) => {
    const build = fixtureProfileBuild({ layers: ['precip-rate', ...lift], frameHours: [1, 2], mapFrameCount: 1 });
    manifestV5Schema.parse(build.manifest);
    const fetchImpl = vi.fn<typeof fetch>(async input => new Response(JSON.stringify(fixturePointFetch(build, String(input)))));
    const api = new ApiClient({ baseUrl: 'https://api.test', fetchImpl, now: () => Date.parse(build.manifest.createdAt) });
    const series = await api.pointSeries(build, point).load('forecast');
    const samples = fetchImpl.mock.calls.map(([input]) => new URL(String(input))).filter(url => url.pathname.endsWith('/sample'));
    expect(pointLiftExpectation(build)).toEqual({ layers: lift, frames: new Set(lift.length ? ['f001'] : []) });
    expect(samples.map(url => [url.searchParams.get('frame'), url.searchParams.get('layers')])).toEqual(lift.length ? [['f001', lift[0]]] : []);
    expect(series.layers).toEqual([...lift, 'precip-rate']);
    expect(series.frames.map(frame => frame.profile?.status)).toEqual(['valid', 'valid']);
    expect(series.frames[0].layers['usable-lift-agl']?.value).toBe(lift.length ? 500 : undefined);
    expect(series.frames[1].layers['usable-lift-agl']).toBeUndefined();
  });

  it('pages the native horizon without counting a cached map prefix against its budget', async () => {
    const build = fixtureProfileBuild({ frameHours: Array.from({ length: 24 }, (_, i) => i + 1), mapFrameCount: 2 });
    build.manifest.descriptors.maxSampleValues = 2;
    const fetchImpl = vi.fn<typeof fetch>(async input => new Response(JSON.stringify(fixturePointFetch(build, String(input)))));
    const api = new ApiClient({ baseUrl: 'https://api.test', fetchImpl, now: () => Date.parse(build.manifest.createdAt) });
    const loader = api.pointSeries(build, point);
    await loader.load('day');
    const before = fetchImpl.mock.calls.length;
    const series = await loader.load('forecast');
    const urls = fetchImpl.mock.calls.slice(before).map(([input]) => new URL(String(input)));
    expect(series.frames).toHaveLength(24);
    expect(urls.map(url => [url.pathname.split('/').at(-1), url.searchParams.get('frame')?.split(',').length])).toEqual([['profile', 22]]);
  });

  it('publishes selected and remaining lift samples independently of a pending profile', async () => {
    const build = fixtureProfileBuild({ frameHours: [1, 2], mapFrameCount: 2 });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const fetchImpl = vi.fn<typeof fetch>(async input => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/profile') && url.searchParams.get('frame') === 'f002') await gate;
      return new Response(JSON.stringify(fixturePointFetch(build, String(input))));
    });
    const api = new ApiClient({ baseUrl: 'https://api.test', fetchImpl, now: () => Date.parse(build.manifest.createdAt) });
    const onProgress = vi.fn<(series: PointSeries, total: number, loading: boolean) => void>();
    const pending = api.pointSeries(build, point).load('day', undefined, { frameId: 'f002', onProgress });
    try {
      await vi.waitFor(() => expect(onProgress).toHaveBeenCalledTimes(2));
      const requests = fetchImpl.mock.calls.map(([input]) => new URL(String(input)));
      expect(requests.map(url => [url.pathname.split('/').at(-1), url.searchParams.get('frame')])).toEqual([
        ['sample', 'f002'], ['profile', 'f002'], ['sample', 'f001']
      ]);
      const [early, total, loading] = onProgress.mock.calls[0]!;
      expect(early.frames.map(frame => frame.id)).toEqual(['f002']);
      expect(early.frames[0].layers).toEqual(fixturePointSample(build, String(requests[0])).frames[0].layers);
      expect(early.frames[0].profile).toBeUndefined();
      expect([total, loading]).toEqual([2, true]);
      expect(onProgress.mock.calls[1]![0].frames.map(frame => [frame.id, frame.layers['usable-lift-agl'].value, frame.profile])).toEqual([
        ['f001', 500, undefined], ['f002', 500, undefined]
      ]);
    } finally { release(); }
    const series = await pending;
    expect(series.frames.map(frame => frame.id)).toEqual(['f001', 'f002']);
    expect(series.frames[1].layers['usable-lift-agl']).toEqual(onProgress.mock.calls[0]![0].frames[0].layers['usable-lift-agl']);
    expect(series.frames[1].profile?.status).toBe('valid');
    expect(onProgress.mock.lastCall).toEqual([series, 2, false]);
  });

  it.each([200, 429])('waits for the selected lift response (%s) while profile pages continue', async status => {
    const build = fixtureProfileBuild({ frameHours: [1, 2], mapFrameCount: 2 });
    let releaseLift!: () => void, releaseProfile!: () => void;
    const liftGate = new Promise<void>(resolve => { releaseLift = resolve; });
    const profileGate = new Promise<void>(resolve => { releaseProfile = resolve; });
    const fetchImpl = vi.fn<typeof fetch>(async input => {
      const url = new URL(String(input)), frame = url.searchParams.get('frame');
      if (url.pathname.endsWith('/sample') && frame === 'f002') {
        await liftGate;
        if (status !== 200) return new Response(null, { status });
      }
      if (url.pathname.endsWith('/profile') && frame === 'f001') await profileGate;
      return new Response(JSON.stringify(fixturePointFetch(build, String(input))));
    });
    const api = new ApiClient({ baseUrl: 'https://api.test', fetchImpl, now: () => Date.parse(build.manifest.createdAt) });
    const onProgress = vi.fn<(series: PointSeries, total: number, loading: boolean) => void>();
    const pending = api.pointSeries(build, point).load('day', undefined, { frameId: 'f002', onProgress });
    const settled = status === 200 ? expect(pending).resolves.toBeDefined() : expect(pending).rejects.toMatchObject({ status });
    try {
      await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(3));
      expect(onProgress).not.toHaveBeenCalled();
      releaseLift();
      await vi.waitFor(() => expect(onProgress).toHaveBeenCalled());
      const [early, total, loading] = onProgress.mock.calls[0]!;
      expect(early.frames.map(frame => frame.id)).toEqual(['f002']);
      expect(early.frames[0].profile?.status).toBe('valid');
      expect(early.frames[0].layers['usable-lift-agl']?.value).toBe(status === 200 ? 500 : undefined);
      expect([total, loading]).toEqual([2, true]);
    } finally { releaseLift(); releaseProfile(); }
    await settled;
  });

  it('publishes the selected point-only profile independently of pending map samples', async () => {
    const build = fixtureProfileBuild({ frameHours: [1, 2], mapFrameCount: 1 });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const fetchImpl = vi.fn<typeof fetch>(async input => {
      if (new URL(String(input)).pathname.endsWith('/sample')) await gate;
      return new Response(JSON.stringify(fixturePointFetch(build, String(input))));
    });
    const api = new ApiClient({ baseUrl: 'https://api.test', fetchImpl, now: () => Date.parse(build.manifest.createdAt) });
    const onProgress = vi.fn<(series: PointSeries, total: number, loading: boolean) => void>();
    const pending = api.pointSeries(build, point).load('forecast', undefined, { frameId: 'f002', onProgress });
    try {
      await vi.waitFor(() => expect(onProgress).toHaveBeenCalled());
      const [early, total, loading] = onProgress.mock.calls[0]!;
      expect(early.frames.map(frame => frame.id)).toEqual(['f002']);
      expect(early.frames[0].profile?.status).toBe('valid');
      expect([total, loading]).toEqual([2, true]);
    } finally { release(); }
    await pending;
  });

  it.each(['f001', 'f002,f003'])('retains sample pages after a failed profile page (%s) and fetches only missing profiles on reload', async failedFrames => {
    const build = fixtureProfileBuild({ frameHours: [1, 2, 3], mapFrameCount: 2 });
    let fail = true;
    const fetchImpl = vi.fn<typeof fetch>(async input => {
      const url = new URL(String(input));
      if (fail && url.pathname.endsWith('/profile') && url.searchParams.get('frame') === failedFrames) {
        return new Response(null, { status: 429 });
      }
      return new Response(JSON.stringify(fixturePointFetch(build, String(input))));
    });
    const api = new ApiClient({ baseUrl: 'https://api.test', fetchImpl, now: () => Date.parse(build.manifest.createdAt) });
    const loader = api.pointSeries(build, point), onProgress = vi.fn<(series: PointSeries, total: number, loading: boolean) => void>();
    await expect(loader.load('forecast', undefined, { onProgress })).rejects.toMatchObject({ status: 429 });
    const [partial, total, loading] = onProgress.mock.lastCall!;
    expect(partial.frames.map(frame => frame.id)).toEqual(['f001', 'f002']);
    expect(partial.frames.map(frame => frame.layers['usable-lift-agl'].value)).toEqual([500, 500]);
    expect(partial.frames[0].profile?.status).toBe(failedFrames === 'f001' ? undefined : 'valid');
    expect(partial.frames[1].profile).toBeUndefined();
    expect([total, loading]).toEqual([3, false]);
    fail = false;
    const settled = fetchImpl.mock.calls.length;
    const recovered = await loader.load('forecast');
    expect(recovered.frames.map(frame => frame.profile?.status)).toEqual(['valid', 'valid', 'valid']);
    const retry = fetchImpl.mock.calls.slice(settled).map(([input]) => new URL(String(input)));
    expect(retry.every(url => url.pathname.endsWith('/profile'))).toBe(true);
    expect(retry.flatMap(url => url.searchParams.get('frame')!.split(','))).toEqual(failedFrames === 'f001' ? ['f001', 'f002', 'f003'] : ['f002', 'f003']);
  });

  it('rejects a profile completing after expiry without publishing or reusing it', async () => {
    const build = fixtureProfileBuild({ frameHours: [1], mapFrameCount: 1 });
    let now = Date.parse(build.manifest.createdAt), release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const fetchImpl = vi.fn<typeof fetch>(async input => {
      if (new URL(String(input)).pathname.endsWith('/profile')) await gate;
      return new Response(JSON.stringify(fixturePointFetch(build, String(input))));
    });
    const api = new ApiClient({ baseUrl: 'https://api.test', fetchImpl, now: () => now });
    const loader = api.pointSeries(build, point), onProgress = vi.fn();
    const pending = expect(loader.load('day', undefined, { onProgress })).rejects.toThrow('Build expired');
    await vi.waitFor(() => expect(onProgress).toHaveBeenCalledOnce());
    now = build.expiresAtMs;
    release();
    await pending;
    expect(onProgress).toHaveBeenCalledOnce();
    await expect(loader.load('day')).rejects.toThrow('Build expired');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('reuses selected lift while a superseded profile response is discarded', async () => {
    const build = fixtureProfileBuild({ frameHours: [1, 2, 3], mapFrameCount: 2 });
    let release!: () => void, firstProfile = true;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const fetchImpl = vi.fn<typeof fetch>(async input => {
      if (new URL(String(input)).pathname.endsWith('/profile') && firstProfile) {
        firstProfile = false;
        await gate;
      }
      return new Response(JSON.stringify(fixturePointFetch(build, String(input))));
    });
    const api = new ApiClient({ baseUrl: 'https://api.test', fetchImpl, now: () => Date.parse(build.manifest.createdAt) });
    const loader = api.pointSeries(build, point), onProgress = vi.fn();
    const superseded = expect(loader.load('forecast', undefined, { onProgress })).rejects.toThrow();
    await vi.waitFor(() => expect(onProgress).toHaveBeenCalledTimes(2));
    const day = await loader.load('day');
    await superseded;
    release();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(day.frames.map(frame => frame.profile?.status)).toEqual(['valid', 'valid']);
    expect(onProgress).toHaveBeenCalledTimes(2);
    const fineFrames = fetchImpl.mock.calls.map(([input]) => new URL(String(input)))
      .filter(url => url.pathname.endsWith('/sample')).map(url => url.searchParams.get('frame'));
    expect(fineFrames).toEqual(['f001', 'f002']);
  });

  it('publishes the selected hour before the remaining 23-frame page and reuses the complete range', async () => {
    const { build, fetchImpl, loader } = setup(), selected = build.manifest.frames[19].id;
    const updates: PointSeries[] = [], totals: number[] = [];
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    fetchImpl.mockImplementation(async input => {
      if (fetchImpl.mock.calls.length === 2) await gate;
      return new Response(JSON.stringify(fixturePointSample(build, String(input))));
    });
    const pending = loader.load('day', undefined, { frameId: selected, onProgress(series, total) { updates.push(series); totals.push(total); } });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    expect(updates).toHaveLength(1);
    expect(updates[0].frames.map(frame => frame.id)).toEqual([selected]);
    expect(updates[0].layers).toHaveLength(11);
    expect(totals).toEqual([24]);
    const requests = fetchImpl.mock.calls.map(([input]) => new URL(String(input)).searchParams.get('frame')!.split(','));
    expect(requests.map(ids => ids.length)).toEqual([1, 23]);
    expect(requests[1]).not.toContain(selected);
    release();
    expect((await pending).frames).toHaveLength(24);
    expect(updates[1].frames.map(frame => frame.id)).toEqual(build.manifest.frames.slice(0, 24).map(frame => frame.id));
    await loader.load('day');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('loads all 40 irregular map frames through three bounded pages with the selected hour first', async () => {
    const hours = [...Array.from({ length: 24 }, (_, i) => i + 1), ...Array.from({ length: 16 }, (_, i) => 27 + i * 3)];
    const build = fixturePointBuild({ frameHours: [...hours, 75, 78], mapFrameCount: 40 });
    const fetchImpl = vi.fn<typeof fetch>(async input => new Response(JSON.stringify(fixturePointSample(build, String(input)))));
    const api = new ApiClient({ baseUrl: 'https://api.test', fetchImpl, now: () => Date.parse(build.manifest.createdAt) });
    const progress = vi.fn(), loader = api.pointSeries(build, point);
    const series = await loader.load('day', undefined, { frameId: 'f072', onProgress: progress });
    expect(series.frames.map(frame => frame.id)).toEqual(hours.map(hour => `f${String(hour).padStart(3, '0')}`));
    expect(progress.mock.calls.map(([view, total]) => [view.frames.length, total])).toEqual([[1, 40], [24, 40], [40, 40]]);
    const frames = fetchImpl.mock.calls.map(([input]) => new URL(String(input)).searchParams.get('frame')!.split(','));
    expect(frames.map(page => page.length)).toEqual([1, 23, 16]);
    expect(frames[0]).toEqual(['f072']);
    expect(frames.flat()).toHaveLength(new Set(frames.flat()).size);
    for (const page of frames) expect(page.length * 11).toBeLessThanOrEqual(256);
    expect((await loader.load('forecast')).frames).toHaveLength(42);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    await loader.load('day');
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('prioritizes the selected hour and fetches remaining multi-group native profiles in one parallel wave', async () => {
    const hours = [...Array.from({ length: 24 }, (_, i) => i + 1), ...Array.from({ length: 16 }, (_, i) => 27 + i * 3)];
    const build = fixtureProfileBuild({ frameHours: hours, mapFrameCount: 40 });
    const native = build.manifest.surfaces.find(surface => surface.kind === 'native')!;
    const scalarShard = native.samples.shards[0]!;
    native.samples = {
      ...native.samples,
      format: 'frame-group-block-shards-v1',
      shards: [
        { ...scalarShard, group: 0, firstFrame: 0, frameCount: 24, blockShard: 0 },
        { ...scalarShard, group: 1, firstFrame: 24, frameCount: 16, blockShard: 0 },
      ],
    };
    const profileShard = native.profiles!.groups[0]!.shards[0]!;
    native.profiles!.groups = hours.map((_, index) => ({
      group: index,
      firstFrame: index,
      frameCount: 1,
      shards: [{ ...profileShard, group: index, firstFrame: index, frameCount: 1, key: `builds/${build.manifest.model}/${build.manifest.buildId}/profiles/g${index}/b0.pack` }],
    }));
    let activeProfiles = 0, peakProfiles = 0, releaseRest!: () => void;
    const restGate = new Promise<void>(resolve => { releaseRest = resolve; });
    const profilePages: string[][] = [];
    const fetchImpl = vi.fn<typeof fetch>(async input => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/profile')) {
        const page = url.searchParams.get('frame')!.split(',');
        profilePages.push(page);
        if (page.length === 1) return new Response(JSON.stringify(fixturePointFetch(build, String(input))));
        activeProfiles++; peakProfiles = Math.max(peakProfiles, activeProfiles);
        try {
          await restGate;
          return new Response(JSON.stringify(fixturePointFetch(build, String(input))));
        } finally { activeProfiles--; }
      }
      return new Response(JSON.stringify(fixturePointSample(build, String(input))));
    });
    const api = new ApiClient({ baseUrl: 'https://api.test', fetchImpl, now: () => Date.parse(build.manifest.createdAt) });
    const progress = vi.fn(), loader = api.pointSeries(build, point);
    const pending = loader.load('day', undefined, { frameId: 'f008', onProgress: progress });
    try { await vi.waitFor(() => expect(activeProfiles).toBe(7)); }
    finally { releaseRest(); }
    const series = await pending;
    expect(peakProfiles).toBe(7);
    expect(profilePages[0]).toEqual(['f008']);
    expect(profilePages.slice(1).map(page => page.length)).toEqual([5, 6, 6, 6, 5, 5, 6]);
    expect(series.frames).toHaveLength(40);
    expect(series.frames.every(frame => frame.profile?.status === 'valid')).toBe(true);

    // Disposing on the selected hour's progress callback never starts the parallel rest wave.
    const closePages: string[][] = [];
    const closeFetch = vi.fn<typeof fetch>(async input => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/profile')) closePages.push(url.searchParams.get('frame')!.split(','));
      return new Response(JSON.stringify(fixturePointFetch(build, String(input))));
    });
    const closeApi = new ApiClient({ baseUrl: 'https://api.test', fetchImpl: closeFetch, now: () => Date.parse(build.manifest.createdAt) });
    const closeLoader = closeApi.pointSeries(build, point);
    await expect(closeLoader.load('day', undefined, {
      frameId: 'f008',
      onProgress: () => closeLoader.dispose(),
    })).rejects.toThrow();
    expect(closePages).toEqual([['f008']]);
  });

  it('prioritizes a late native hour and stops further progress after close', async () => {
    const { fetchImpl, loader } = setup(), onProgress = vi.fn((_series: PointSeries, _total: number) => loader.dispose());
    await expect(loader.load('forecast', undefined, { frameId: 'f384', onProgress })).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(onProgress).toHaveBeenCalledOnce();
    const frame = onProgress.mock.calls[0]?.[0] as PointSeries | undefined;
    expect(frame?.frames.map(value => value.id)).toEqual(['f384']);
    expect(frame?.frames[0].layers['usable-lift-msl']).toMatchObject({ value: null, status: 'unavailable' });
    expect(frame?.frames[0].layers['thermal-top-msl']).toMatchObject({ value: 2500, status: 'valid' });
  });

  it('reaches the complete native horizon through validated bounded scalar pages and reuses both ranges', async () => {
    const { build, fetchImpl, loader } = setup();
    const day = await loader.load('day'), full = await loader.load('forecast');
    expect(day.frames.length).toBeLessThan(full.frames.length);
    expect(full.frames).toHaveLength(build.manifest.frames.length);
    expect(full.frames.at(-1)?.validTime).toBe(new Date(Date.parse(build.manifest.cycle) + 384 * 3600000).toISOString());
    expect(full.frames.length * full.layers.length).toBeGreaterThan(256);
    expect(full).not.toHaveProperty('version');
    expect(Object.keys(full).sort()).toEqual(['frames', 'layers']);
    for (const [input] of fetchImpl.mock.calls) {
      const url = new URL(String(input));
      expect(url.pathname).toMatch(/\/sample$/);
      expect(url.searchParams.get('frame')!.split(',').length * url.searchParams.get('layers')!.split(',').length).toBeLessThanOrEqual(256);
    }
    const last = full.frames.at(-1)!;
    expect(last.layers['usable-lift-msl']).toMatchObject({ status: 'unavailable', value: null });
    expect(last.layers['thermal-top-msl']).toMatchObject({ status: 'valid', value: 2500 });
    expect(last.layers['cloud-cover-total']).toMatchObject({ status: 'valid', value: 0 });
    const calls = fetchImpl.mock.calls.length;
    expect((await loader.load('day')).frames).toEqual(day.frames);
    expect((await loader.load('forecast')).frames).toEqual(full.frames);
    expect(fetchImpl).toHaveBeenCalledTimes(calls);
  });

  it('cancels a superseded range, serializes reads and preserves completed frames', async () => {
    const { build, fetchImpl, loader } = setup();
    let active = 0, peak = 0;
    fetchImpl.mockImplementation(async (input, init) => {
      active++; peak = Math.max(peak, active);
      try {
        if (fetchImpl.mock.calls.length === 2) await new Promise<never>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
        });
        return new Response(JSON.stringify(fixturePointSample(build, String(input))));
      } finally { active--; }
    });
    const full = loader.load('forecast');
    const rejected = expect(full).rejects.toThrow();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    const day = await loader.load('day');
    await rejected;
    expect(day.frames.length).toBeGreaterThan(0);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    await loader.load('forecast');
    expect(peak).toBe(1);
    const initialIds = new URL(String(fetchImpl.mock.calls[0][0])).searchParams.get('frame')!.split(',');
    expect(fetchImpl.mock.calls.slice(2).every(([input]) => new URL(String(input)).searchParams.get('frame')!.split(',').every(id => !initialIds.includes(id)))).toBe(true);
  });

  it('rejects a selection exceeding the page budget before transfer and disposes the point cache', async () => {
    const { build, fetchImpl, loader } = setup();
    build.manifest.descriptors.maxSampleValues = 11;
    await expect(loader.load('forecast')).rejects.toThrow('page budget exceeded');
    expect(fetchImpl).not.toHaveBeenCalled();
    loader.dispose();
    await expect(loader.load('day')).rejects.toThrow('closed');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('aborts the active page when its point is closed', async () => {
    const { fetchImpl, loader } = setup();
    let signal: AbortSignal | null | undefined;
    fetchImpl.mockImplementation(async (_input, init) => {
      signal = init?.signal;
      return new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(signal?.reason), { once: true }));
    });
    const pending = loader.load('forecast'), rejected = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(signal?.aborted).toBe(false));
    loader.dispose();
    await rejected;
    expect(signal?.aborted).toBe(true);
    await expect(loader.load('day')).rejects.toThrow('closed');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each(['model', 'buildId', 'cycle', 'expiresAt', 'method-id', 'method-hash', 'manifest'] as const)('rejects changed %s before reading its warm cache', async key => {
    const { build, fetchImpl, loader } = setup();
    await loader.load('day');
    const calls = fetchImpl.mock.calls.length;
    if (key === 'model') build.manifest.model = 'rrfs';
    else if (key === 'buildId') build.manifest.buildId = 'different-build';
    else if (key === 'expiresAt') build.manifest.expiresAt = '2099-01-01T00:00:00.000Z';
    else if (key === 'cycle') build.manifest.cycle = '2026-11-01T00:00:00.000Z';
    else if (key === 'method-id') build.manifest.method.id = 'changed-method';
    else if (key === 'method-hash') build.manifest.method.hash = 'f'.repeat(64);
    else build.manifest = structuredClone(build.manifest);
    await expect(loader.load('day')).rejects.toThrow('pinned build changed');
    expect(fetchImpl).toHaveBeenCalledTimes(calls);
  });

  it('rejects in-flight method drift before inserting that page into the cache', async () => {
    const { build, fetchImpl, loader } = setup(), original = { ...build.manifest.method };
    fetchImpl.mockImplementationOnce(async input => {
      build.manifest.method = { ...original, hash: 'f'.repeat(64) };
      const payload = fixturePointSample(build, String(input));
      payload.frames[0].layers['thermal-top-msl'].value = 9999;
      return new Response(JSON.stringify(payload));
    });
    await expect(loader.load('day')).rejects.toThrow('pinned build changed');
    build.manifest.method = original;
    const recovered = await loader.load('day');
    expect(recovered.frames[0].layers['thermal-top-msl'].value).toBe(2500);
    const first = new URL(String(fetchImpl.mock.calls[0][0])).searchParams.get('frame');
    expect(new URL(String(fetchImpl.mock.calls[1][0])).searchParams.get('frame')).toBe(first);
  });
});

describe('weather-independent static fine-tile point terrain (Finding 2)', () => {
  function makeTileView(tileSize: number, writer: (row: number, col: number, view: DataView, offset: number) => void): DataView {
    const bytes = new Uint8Array(tileSize * tileSize * WIND_FINE_CELL_BYTES);
    const view = new DataView(bytes.buffer);
    for (let r = 0; r < tileSize; r++) {
      for (let c = 0; c < tileSize; c++) {
        const pos = (r * tileSize + c) * WIND_FINE_CELL_BYTES;
        view.setUint8(pos + 8, STATUS_VALID | (STATUS_VALID << 2) | 0x10);
        writer(r, c, view, pos);
      }
    }
    return view;
  }

  it('keeps 1,240 m bilinear DSM elevation invariant when a weather donor is unavailable or no-lift, and handles missing terrain donors, 0 m sea level, coverage edges, and 4-tile corners', () => {
    const contributors = [
      { row: 0, column: 0, weight: 0.36 },
      { row: 0, column: 1, weight: 0.24 },
      { row: 1, column: 0, weight: 0.24 },
      { row: 1, column: 1, weight: 0.16 },
    ];
    const dsm = [
      [1000, 1200],
      [1400, 1600],
    ];
    // Hour 1: last weather donor marked STATUS_UNAVAILABLE while terrain donor stays STATUS_VALID
    const missingWeatherTile = makeTileView(64, (r, c, view, pos) => {
      const elev = dsm[r]?.[c] ?? 500;
      view.setFloat32(pos, elev, true);
      const liftStatus = r === 1 && c === 1 ? STATUS_UNAVAILABLE : STATUS_NO_LIFT;
      view.setUint8(pos + 8, STATUS_VALID | (liftStatus << 2) | 0x10);
    });
    // Hour 2: all four weather donors valid
    const fullWeatherTile = makeTileView(64, (r, c, view, pos) => {
      const elev = dsm[r]?.[c] ?? 500;
      view.setFloat32(pos, elev, true);
      view.setFloat32(pos + 4, elev + 300, true);
      view.setUint8(pos + 8, STATUS_VALID | (STATUS_VALID << 2) | 0x10);
    });

    const evalWith = (tile: DataView) => evaluateFineTerrainContributors({
      contributors,
      fineGridWidth: 128,
      fineTileSize: 64,
      resolveSlot: logical => logical,
      tiles: new Map([[0, tile]]),
      surfaceId: 'icon-eu-fine',
      surface: 'DSM',
      verticalDatum: 'EGM2008',
    });
    const hour1 = evalWith(missingWeatherTile);
    const hour2 = evalWith(fullWeatherTile);
    expect(hour1).toMatchObject({ status: 'valid', interpolated: true, surfaceId: 'icon-eu-fine', surface: 'DSM', verticalDatum: 'EGM2008' });
    expect(hour1.elevationM).toBeCloseTo(1240, 6);
    expect(hour2.elevationM).toBeCloseTo(1240, 6);

    // Missing terrain donor falls back to nearest contributor (1,000 m, interpolated: false)
    const missingTerrainTile = makeTileView(64, (r, c, view, pos) => {
      const elev = dsm[r]?.[c] ?? 0;
      view.setFloat32(pos, elev, true);
      const terrainSt = r === 1 && c === 1 ? STATUS_UNAVAILABLE : STATUS_VALID;
      view.setUint8(pos + 8, terrainSt | (STATUS_UNAVAILABLE << 2) | 0x10);
    });
    expect(evalWith(missingTerrainTile)).toMatchObject({ elevationM: 1000, status: 'valid', interpolated: false });

    // Valid 0 m sea-level elevation stays numeric zero
    const seaLevelTile = makeTileView(64, (_r, _c, view, pos) => {
      view.setFloat32(pos, 0, true);
      view.setUint8(pos + 8, STATUS_VALID | (STATUS_NO_LIFT << 2) | 0x10);
    });
    expect(evalWith(seaLevelTile)).toMatchObject({ elevationM: 0, status: 'valid', interpolated: true });

    // Nearest contributor outside coverage mask returns outside-domain
    const outsideEdgeTile = makeTileView(64, (r, c, view, pos) => {
      view.setFloat32(pos, 500, true);
      const outputBit = r === 0 && c === 0 ? 0 : 0x10;
      view.setUint8(pos + 8, (outputBit ? STATUS_VALID : STATUS_OUTSIDE) | (STATUS_OUTSIDE << 2) | outputBit);
    });
    expect(evalWith(outsideEdgeTile)).toMatchObject({ elevationM: null, status: 'outside-domain', interpolated: false });

    // Four-tile corner seam across row 63..64 and column 63..64
    const cornerContributors = [
      { row: 63, column: 63, weight: 0.25 },
      { row: 63, column: 64, weight: 0.25 },
      { row: 64, column: 63, weight: 0.25 },
      { row: 64, column: 64, weight: 0.25 },
    ];
    const cornerTiles = new Map<number, DataView>([
      [0, makeTileView(64, (r, c, view, pos) => { if (r === 63 && c === 63) view.setFloat32(pos, 2100, true); })],
      [1, makeTileView(64, (r, c, view, pos) => { if (r === 63 && c === 0) view.setFloat32(pos, 2200, true); })],
      [2, makeTileView(64, (r, c, view, pos) => { if (r === 0 && c === 63) view.setFloat32(pos, 2300, true); })],
      [3, makeTileView(64, (r, c, view, pos) => { if (r === 0 && c === 0) view.setFloat32(pos, 2589.088, true); })],
    ]);
    const cornerResult = evaluateFineTerrainContributors({
      contributors: cornerContributors,
      fineGridWidth: 128,
      fineTileSize: 64,
      resolveSlot: logical => logical,
      tiles: cornerTiles,
      surfaceId: 'icon-eu-fine',
      surface: 'DSM',
      verticalDatum: 'EGM2008',
    });
    expect(cornerResult.interpolated).toBe(true);
    expect(cornerResult.elevationM).toBeCloseTo(2297.272, 4);
  });

  it('loads fine-tile siteTerrain via ApiClient.pointSeries independently of interpolated weather, caches across loads, handles 404 companion, and aborts stale point switches', async () => {
    const build = fixtureProfileBuild({ frameHours: [1, 2], mapFrameCount: 2 });
    build.manifest.mapData = { sha256: 'c'.repeat(64), bytes: 512 };
    const native = build.manifest.surfaces.find(s => s.kind === 'native')!;
    const fine = build.manifest.surfaces.find(s => s.kind === 'fine')!;
    const windTileSize = 16;
    const fineTileSize = 64;
    const wLayout = windLayout(native.grid.width, native.grid.height, windTileSize, 4);
    const fLayout = windLayout(fine.grid.width, fine.grid.height, fineTileSize);
    const makeShards = (layout: ReturnType<typeof windLayout>) => Array.from({ length: layout.pages }, (_, page) => ({
      sha256: 'a'.repeat(64),
      indexSha256: 'b'.repeat(64),
      count: layout.pageCount(page),
      bytes: layout.pageCount(page) * layout.chunkBytes,
    }));
    const descriptor = {
      version: 3 as const,
      frame: 'f001',
      levels: 4,
      tileSize: windTileSize,
      fineTileSize: fineTileSize as 64,
      wind: makeShards(wLayout),
      fine: makeShards(fLayout),
    };
    const fineTileBytes = new Uint8Array(fineTileSize * fineTileSize * WIND_FINE_CELL_BYTES);
    const fineTileView = new DataView(fineTileBytes.buffer);
    for (let i = 0; i < fineTileBytes.byteLength; i += WIND_FINE_CELL_BYTES) {
      fineTileView.setFloat32(i, 2297.272, true);
      fineTileView.setFloat32(i + 4, 0, true);
      fineTileView.setUint8(i + 8, STATUS_VALID | (STATUS_NO_LIFT << 2) | 0x10);
    }

    let dataCalls = 0;
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      init?.signal?.throwIfAborted();
      const url = new URL(String(input));
      if (url.pathname.endsWith('/data/f001')) {
        dataCalls++;
        return new Response(JSON.stringify(descriptor), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.pathname.includes('/data/f001/fine/')) {
        dataCalls++;
        return new Response(fineTileBytes, { status: 200, headers: { 'content-type': 'application/octet-stream' } });
      }
      const payload = fixturePointFetch(build, String(input)) as Record<string, unknown>;
      if (url.pathname.endsWith('/sample')) {
        // All map frames interpolated or no-usable-lift so pointMapLift.terrainM === null
        const sample = payload as ReturnType<typeof fixturePointSample>;
        for (const frame of sample.frames) {
          frame.layers['usable-lift-msl'] = { ...frame.layers['usable-lift-msl']!, value: 2427.4957, interpolated: true };
          frame.layers['usable-lift-agl'] = { ...frame.layers['usable-lift-agl']!, value: 130.2237, interpolated: true };
        }
      }
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const api = new ApiClient({ baseUrl: 'https://api.test', fetchImpl, now: () => Date.parse(build.manifest.createdAt) });
    const araPoint = { lat: 40.4186, lon: 44.4547 };
    const loader = api.pointSeries(build, araPoint);
    const first = await loader.load('day');
    expect(first.siteTerrain?.status).toBe('valid');
    expect(first.siteTerrain?.elevationM).toBeCloseTo(2297.272, 2);
    const callsAfterFirst = dataCalls;
    expect(callsAfterFirst).toBeGreaterThanOrEqual(2);
    // Second range load reuses cached siteTerrain with zero additional /data/ reads
    const second = await loader.load('forecast');
    expect(second.siteTerrain).toEqual(first.siteTerrain);
    expect(dataCalls).toBe(callsAfterFirst);

    // Missing companion (404) degrades cleanly and returns the point series
    const missingBuild = fixtureProfileBuild({ frameHours: [1], mapFrameCount: 1 });
    missingBuild.manifest.mapData = { sha256: 'd'.repeat(64), bytes: 512 };
    const api404 = new ApiClient({
      baseUrl: 'https://api.test',
      fetchImpl: async input => {
        const url = new URL(String(input));
        if (url.pathname.includes('/data/')) return new Response(null, { status: 404 });
        return new Response(JSON.stringify(fixturePointFetch(missingBuild, String(input))));
      },
      now: () => Date.parse(missingBuild.manifest.createdAt),
    });
    const fallbackSeries = await api404.pointSeries(missingBuild, point).load('day');
    expect(fallbackSeries.siteTerrain).toBeUndefined();
    expect(fallbackSeries.frames).toHaveLength(1);

    // Closing a point loader aborts an in-flight terrain tile request immediately
    let terrainSignal: AbortSignal | undefined;
    const slowBuild = fixtureProfileBuild({ frameHours: [1], mapFrameCount: 1 });
    slowBuild.manifest.mapData = { sha256: 'e'.repeat(64), bytes: 512 };
    const apiSlow = new ApiClient({
      baseUrl: 'https://api.test',
      fetchImpl: async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname.includes('/data/')) {
          terrainSignal = init?.signal ?? undefined;
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
          });
        }
        return new Response(JSON.stringify(fixturePointFetch(slowBuild, String(input))));
      },
      now: () => Date.parse(slowBuild.manifest.createdAt),
    });
    const slowLoader = apiSlow.pointSeries(slowBuild, araPoint);
    const pendingSlow = expect(slowLoader.load('day')).rejects.toThrow();
    await vi.waitFor(() => expect(terrainSignal?.aborted).toBe(false));
    slowLoader.dispose();
    await pendingSlow;
    expect(terrainSignal?.aborted).toBe(true);

    // Concurrent clicks on the same build coalesce the descriptor fetch even if the first caller aborts
    let descFetches = 0;
    let releaseDesc!: () => void;
    const descGate = new Promise<void>(resolve => { releaseDesc = resolve; });
    const sharedCache = new PointTerrainCache();
    const coalescedFetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith(`/data/${build.manifest.frames[0]!.id}`)) {
        descFetches++;
        await descGate;
        init?.signal?.throwIfAborted();
        return new Response(JSON.stringify(descriptor), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.pathname.includes('/fine/')) {
        return new Response(Uint8Array.from(fineTileBytes), { status: 200, headers: { 'content-type': 'application/octet-stream' } });
      }
      throw new Error('Unexpected URL');
    });
    const abortFirst = new AbortController();
    const firstRead = sharedCache.read('https://api.test', coalescedFetchImpl, build, araPoint, abortFirst.signal);
    const secondRead = sharedCache.read('https://api.test', coalescedFetchImpl, build, { lat: 40.42, lon: 44.46 });
    await vi.waitFor(() => expect(descFetches).toBe(1));
    abortFirst.abort(new DOMException('Aborted', 'AbortError'));
    await expect(firstRead).rejects.toThrow();
    releaseDesc();
    const resolvedSecond = await secondRead;
    expect(resolvedSecond?.status).toBe('valid');
    expect(descFetches).toBe(1);

    // 1) Bounded terrain deadline: unresponsive terrain settles within 30 ms deadline so weather completes well under 180 ms
    const deadlineBuild = fixtureProfileBuild({ frameHours: [1, 2], mapFrameCount: 1 });
    deadlineBuild.manifest.model = 'icon-eu';
    deadlineBuild.manifest.surfaces = structuredClone(build.manifest.surfaces);
    deadlineBuild.manifest.descriptors.bounds = build.manifest.descriptors.bounds;
    deadlineBuild.manifest.mapData = { sha256: 'f'.repeat(64), bytes: 512 };
    const apiDeadline = new ApiClient({
      baseUrl: 'https://api.test',
      requestTimeoutMs: 30,
      fetchImpl: async input => {
        const url = new URL(String(input));
        if (url.pathname.includes('/data/')) {
          return new Promise<Response>(() => {}); // completely unresponsive terrain endpoint
        }
        return new Response(JSON.stringify(fixturePointFetch(deadlineBuild, String(input))));
      },
      now: () => Date.parse(deadlineBuild.manifest.createdAt),
    });
    const progressLoadingStates: boolean[] = [];
    const t0 = performance.now();
    const completedWeather = await apiDeadline.pointSeries(deadlineBuild, araPoint).load('day', undefined, {
      onProgress(_payload, _total, isLoading) {
        progressLoadingStates.push(isLoading);
      },
    });
    expect(performance.now() - t0).toBeLessThan(180);
    expect(completedWeather.frames).toHaveLength(1);
    expect(progressLoadingStates.at(-1)).toBe(false);

    // 2) Transient 503 retries on forecast load and recovers Mount Ara terrain (unlike authoritative 404)
    let terrainAttempts503 = 0;
    const retryBuild = structuredClone(deadlineBuild);
    retryBuild.manifest.buildId = '20261123T000000Z-retry-503';
    const api503 = new ApiClient({
      baseUrl: 'https://api.test',
      fetchImpl: async input => {
        const url = new URL(String(input));
        if (url.pathname.endsWith(`/data/${retryBuild.manifest.frames[0]!.id}`)) {
          terrainAttempts503++;
          if (terrainAttempts503 === 1) return new Response(null, { status: 503 });
          return new Response(JSON.stringify({ ...descriptor, frame: retryBuild.manifest.frames[0]!.id }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url.pathname.includes('/fine/')) {
          return new Response(Uint8Array.from(fineTileBytes), { status: 200, headers: { 'content-type': 'application/octet-stream' } });
        }
        return new Response(JSON.stringify(fixturePointFetch(retryBuild, String(input))));
      },
      now: () => Date.parse(retryBuild.manifest.createdAt),
    });
    const retryLoader = api503.pointSeries(retryBuild, araPoint);
    const after503Day = await retryLoader.load('day');
    expect(after503Day.siteTerrain).toBeUndefined();
    expect(terrainAttempts503).toBe(1);
    const after503Forecast = await retryLoader.load('forecast');
    expect(terrainAttempts503).toBe(2);
    expect(after503Forecast.siteTerrain?.elevationM).toBeCloseTo(2297.272, 3);

    // 3) Zero-overlapping-waiter point switch: cancel A while descriptor is loading, then open B before A settles
    let switchDescCalls = 0;
    const switchGates: (() => void)[] = [];
    const switchBuild = structuredClone(deadlineBuild);
    switchBuild.manifest.buildId = '20261123T000000Z-switch-ab';
    const apiSwitch = new ApiClient({
      baseUrl: 'https://api.test',
      fetchImpl: async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith(`/data/${switchBuild.manifest.frames[0]!.id}`)) {
          const callNum = ++switchDescCalls;
          if (callNum === 1) {
            await new Promise<void>(resolve => { switchGates.push(resolve); });
            init?.signal?.throwIfAborted();
          }
          return new Response(JSON.stringify({ ...descriptor, frame: switchBuild.manifest.frames[0]!.id }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url.pathname.includes('/fine/')) {
          return new Response(Uint8Array.from(fineTileBytes), { status: 200, headers: { 'content-type': 'application/octet-stream' } });
        }
        return new Response(JSON.stringify(fixturePointFetch(switchBuild, String(input))));
      },
      now: () => Date.parse(switchBuild.manifest.createdAt),
    });
    const pointALoader = apiSwitch.pointSeries(switchBuild, { lat: 40.42, lon: 44.46 });
    const pendingA = pointALoader.load('day');
    await vi.waitFor(() => expect(switchDescCalls).toBe(1));
    pointALoader.dispose();
    await expect(pendingA).rejects.toThrow();

    // Point A's underlying fetch has NOT settled yet (switchGates[0] still pending), and Point B opens immediately
    const pointBLoader = apiSwitch.pointSeries(switchBuild, araPoint);
    const bDay = await pointBLoader.load('day');
    expect(switchDescCalls).toBe(2);
    expect(bDay.siteTerrain?.elevationM).toBeCloseTo(2297.272, 3);
    const bForecast = await pointBLoader.load('forecast');
    expect(bForecast.siteTerrain?.elevationM).toBeCloseTo(2297.272, 3);
    switchGates.forEach(release => release());

    // 4) Multi-chunk boundary point: when chunk 293 fails with 503 while chunk 294 is still pending,
    // chunk 294 is aborted when unshared (so retry recovers cleanly) and preserved when shared by an independent caller.
    const multiBuild = structuredClone(deadlineBuild);
    multiBuild.manifest.buildId = '20261123T000000Z-multi-chunk';
    const multiDesc = {
      ...descriptor,
      frame: multiBuild.manifest.frames[0]!.id,
    };
    // On GFS 0.125° fine grid (originLat=90, originLon=-180, tilesAcross=45, fineTileSize=64):
    // lat=40.25 -> row=398 (tile row 6); lon=11.9375 -> col=1535.5 straddles slot 293 (col 1535) and slot 294 (col 1536).
    const seamPoint = { lat: 40.25, lon: 11.9375 };
    const slot294OnlyPoint = { lat: 40.25, lon: 12.125 };
    let slot293Calls = 0;
    let slot294Calls = 0;
    const slot294Signals: AbortSignal[] = [];
    const multiCache = new PointTerrainCache();
    const multiFetch = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith(`/data/${multiDesc.frame}`)) {
        return new Response(JSON.stringify(multiDesc), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.pathname.endsWith('/fine/293')) {
        slot293Calls++;
        if (slot293Calls === 1) return new Response(null, { status: 503 });
        return new Response(Uint8Array.from(fineTileBytes), { status: 200, headers: { 'content-type': 'application/octet-stream' } });
      }
      if (url.pathname.endsWith('/fine/294')) {
        const callIdx = ++slot294Calls;
        if (init?.signal) slot294Signals.push(init.signal);
        if (callIdx === 1) {
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
          });
        }
        return new Response(Uint8Array.from(fineTileBytes), { status: 200, headers: { 'content-type': 'application/octet-stream' } });
      }
      throw new Error(`Unexpected URL ${url.pathname}`);
    });
    await expect(multiCache.read('https://api.test', multiFetch, multiBuild, seamPoint, { timeoutMs: 200 })).rejects.toThrow(/503/);
    expect(slot294Signals[0]?.aborted).toBe(true);

    // Retry immediately recovers and resolves both chunks cleanly
    const recoveredSeam = await multiCache.read('https://api.test', multiFetch, multiBuild, seamPoint, { timeoutMs: 200 });
    expect(recoveredSeam?.status).toBe('valid');
    expect(recoveredSeam?.elevationM).toBeCloseTo(2297.272, 3);
    expect(slot293Calls).toBe(2);
    expect(slot294Calls).toBe(2);

    // When a second independent caller shares chunk 294, chunk 293 failing for caller 1 does NOT abort chunk 294 for caller 2
    const sharedMultiCache = new PointTerrainCache();
    let sharedSlot293Calls = 0;
    let releaseSharedSlot294!: () => void;
    const sharedSlot294Gate = new Promise<void>(resolve => { releaseSharedSlot294 = resolve; });
    let sharedSlot294Signal: AbortSignal | undefined;
    const sharedMultiFetch = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith(`/data/${multiDesc.frame}`)) {
        return new Response(JSON.stringify(multiDesc), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.pathname.endsWith('/fine/293')) {
        sharedSlot293Calls++;
        await new Promise(resolve => setTimeout(resolve, 5));
        return new Response(null, { status: 503 });
      }
      if (url.pathname.endsWith('/fine/294')) {
        sharedSlot294Signal = init?.signal ?? undefined;
        await sharedSlot294Gate;
        init?.signal?.throwIfAborted();
        return new Response(Uint8Array.from(fineTileBytes), { status: 200, headers: { 'content-type': 'application/octet-stream' } });
      }
      throw new Error(`Unexpected URL ${url.pathname}`);
    });
    const caller1 = sharedMultiCache.read('https://api.test', sharedMultiFetch, multiBuild, seamPoint, { timeoutMs: 500 });
    const caller2 = sharedMultiCache.read('https://api.test', sharedMultiFetch, multiBuild, slot294OnlyPoint, { timeoutMs: 500 });
    await expect(caller1).rejects.toThrow(/503/);
    expect(sharedSlot293Calls).toBe(1);
    expect(sharedSlot294Signal?.aborted).toBe(false);
    releaseSharedSlot294();
    const caller2Res = await caller2;
    expect(caller2Res?.status).toBe('valid');
  });
});
