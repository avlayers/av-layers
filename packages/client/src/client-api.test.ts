import { describe, expect, it, vi } from 'vitest';
import { ApiClient, ExpiredBuildError, InvalidApiResponseError, type LatestPayload } from './index';
import { FIXTURE_BUILD_ID, fixtureManifestV5, fixtureLatest } from '../../../tests/forecast-fixture';
import { createPreparationBudget } from './client-preparation-budget';
import { createForecastRequestScheduler } from './client-request-scheduler';

const expiresAt = '2026-10-31T00:00:00.000Z';
const created = '2026-10-30T00:00:00.000Z';
const frames = fixtureManifestV5().frames;
const layerIds = fixtureManifestV5().layers;
function manifest() { return fixtureManifestV5({ createdAt: created, expiresAt }); }
function latestPayload(): LatestPayload & { manifest: ReturnType<typeof manifest> } { return fixtureLatest(manifest()) as LatestPayload & { manifest: ReturnType<typeof manifest> }; }

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('ApiClient.latest', () => {
  it('fetches one expanded manifest and pins the returned build', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(latestPayload()));
    const client = new ApiClient({ baseUrl: 'https://api.test/', fetchImpl, now: () => Date.parse(created) });
    const build = await client.latest('gfs');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe('https://api.test/v1/models/gfs/latest?expand=manifest');
    expect(build.manifest.buildId).toBe(FIXTURE_BUILD_ID);
    expect(build.templates['usable-lift-msl']).toContain('/usable-lift-msl/{frame}/{z}/{x}/{y}.webp');
    expect(build.manifest.surfaces).toEqual(manifest().surfaces);
    expect(build.expiresAtMs).toBe(Date.parse(expiresAt));
  });

  it('preserves forecast-horizon metadata without rejecting retained historical forecasts', async () => {
    const payload = latestPayload();
    payload.manifest!.expiresAt = '2026-11-06T00:00:00.000Z';
    payload.pointer.retained[0]!.expiresAt = payload.manifest!.expiresAt;
    payload.freshness = { ageSeconds: 90000, expiresAt: payload.manifest!.expiresAt, cycle: created,
      latestValidTime: frames.at(-1)!.validTime, horizonExhausted: true, horizonRemainingSeconds: 0 };
    const client = new ApiClient({ baseUrl: 'https://api.test', fetchImpl: async () => jsonResponse(payload),
      now: () => Date.parse('2026-10-31T06:00:00Z') });
    const build = await client.latest('gfs');
    expect(build.manifest.frames).toEqual(frames);
  });

  it.each([
    ['missing freshness', () => ({ ...latestPayload(), freshness: undefined })],
    ['invalid manifest without freshness', () => ({ ...latestPayload(), freshness: undefined, manifest: { ...manifest(), method: null } })],
    ['invalid method', () => ({ ...latestPayload(), manifest: { ...manifest(), method: null } })],
    ['invalid frame time', () => ({ ...latestPayload(), manifest: { ...manifest(), frames: [{ ...frames[0], validTime: 'not-a-time' }] } })],
    ['incomplete pointer', () => ({ ...latestPayload(), pointer: { model: 'gfs', latestBuildId: manifest().buildId } })],
    ['missing expanded manifest', () => ({ ...latestPayload(), manifest: undefined })]
  ])('rejects %s at the response boundary', async (_name, payload) => {
    const client = new ApiClient({ baseUrl: 'https://api.test', fetchImpl: async () => jsonResponse(payload()), now: () => Date.parse(created) });
    await expect(client.latest('gfs')).rejects.toBeInstanceOf(InvalidApiResponseError);
  });

  it('rejects a manifest that does not match the pinned pointer build', async () => {
    const payload = latestPayload();
    payload.manifest = { ...payload.manifest!, buildId: 'other' };
    const client = new ApiClient({ baseUrl: 'https://api.test', fetchImpl: (async () => jsonResponse(payload)) as typeof fetch });
    await expect(client.latest('gfs')).rejects.toBeInstanceOf(InvalidApiResponseError);
  });

  it('rejects an expired build before returning a viewable model', async () => {
    const client = new ApiClient({
      baseUrl: 'https://api.test',
      fetchImpl: (async () => jsonResponse(latestPayload())) as typeof fetch,
      now: () => Date.parse(expiresAt) + 1
    });
    await expect(client.latest('gfs')).rejects.toBeInstanceOf(ExpiredBuildError);
  });

  it('propagates structured problem details', async () => {
    const client = new ApiClient({
      baseUrl: 'https://api.test',
      fetchImpl: (async () => jsonResponse({ type: 'urn:windy-av:not-retained', title: 'not-retained', detail: 'expired', status: 404 }, 404)) as typeof fetch
    });
    await expect(client.latest('gfs')).rejects.toMatchObject({ status: 404, code: 'not-retained', message: 'expired' });
  });
});

describe('ApiClient.sample', () => {
  function samplePayload(selected = frames) {
    const published = manifest();
    return {
      version: 5,
      model: 'gfs',
      buildId: FIXTURE_BUILD_ID,
      lat: -32.9,
      lon: -68.9,
      method: published.method,
      source: published.source,
      surfaces: published.surfaces.map(({ id, kind, layers, coverage }) => ({ id, kind, layers, coverage })),
      expiresAt,
      frames: selected.map(frame => ({
        ...frame,
        layers: Object.fromEntries(layerIds.map(layer => [layer, {
          value: 310, status: 'valid', support: layer === 'precip-rate' ? 0 : 4, interpolated: false,
          surfaceId: published.surfaces.find(surface => surface.layers.includes(layer))!.id
        }]))
      }))
    };
  }

  const malformed: Array<[string, (p: ReturnType<typeof samplePayload>) => void]> = [
    ['empty frames', p => { p.frames = []; }],
    ['missing frame', p => { p.frames.pop(); }],
    ['duplicate frame', p => { p.frames[1] = p.frames[0]; }],
    ['wrong time', p => { p.frames[0].validTime = created; }],
    ['missing latitude', p => { Object.assign(p, { lat: undefined }); }],
    ['missing expiry', p => { Object.assign(p, { expiresAt: undefined }); }],
    ['wrong expiry', p => { p.expiresAt = created; }],
    ['wrong method hash', p => { p.method.hash = 'f'.repeat(64); }],
    ['wrong coverage hash', p => { p.surfaces[0].coverage.hash = 'f'.repeat(64); }],
    ['wrong source', p => { p.source.provenanceSha256 = 'f'.repeat(64); }],
    ['missing layer', p => { delete p.frames[0].layers['precip-rate']; }],
    ['extra layer', p => { p.frames[0].layers.extra = p.frames[0].layers['precip-rate']; }],
    ['wrong surface owner', p => { p.frames[0].layers['precip-rate'].surfaceId = 'gfs-fine'; }],
    ['invalid rain support', p => { p.frames[0].layers['precip-rate'].support = 4; }],
    ['unknown support bit', p => { p.frames[0].layers['usable-lift-agl'].support = 256; }],
    ['support integer overflow', p => { p.frames[0].layers['usable-lift-agl'].support = 2 ** 32; }],
    ['valid null', p => { Object.assign(p.frames[0].layers['precip-rate'], { value: null }); }],
    ['outside with value', p => { p.frames[0].layers['precip-rate'].status = 'outside-domain'; }],
    ['no lift rain', p => { p.frames[0].layers['precip-rate'].status = 'no-usable-lift'; }]
  ];
  it.each(malformed)('rejects %s in the complete sample contract', async (_name, edit) => {
    const payload = samplePayload(); edit(payload);
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse(latestPayload())).mockResolvedValueOnce(jsonResponse(payload));
    const client = new ApiClient({ baseUrl: 'https://api.test', fetchImpl, now: () => Date.parse(created) });
    const build = await client.latest('gfs');
    await expect(client.sample(build, { lat: -32.9, lon: -68.9, frames: 'all' })).rejects.toBeInstanceOf(InvalidApiResponseError);
  });
  it('validates a legitimate partial selection and refuses absent identifiers before fetching', async () => {
    const payload = samplePayload(); payload.frames = [{ ...payload.frames[2], layers: { 'precip-rate': payload.frames[2].layers['precip-rate'] } }];
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse(latestPayload())).mockResolvedValueOnce(jsonResponse(payload));
    const client = new ApiClient({ baseUrl: 'https://api.test', fetchImpl, now: () => Date.parse(created) });
    const build = await client.latest('gfs');
    expect((await client.sample(build, { lat: -32.9, lon: -68.9, frames: ['f009'], layers: ['precip-rate'] })).frames).toHaveLength(1);
    await expect(client.sample(build, { lat: 0, lon: 0, frames: ['not-in-build'] })).rejects.toBeInstanceOf(RangeError);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('uses the pinned no-lift descriptor for a fine-surface value', async () => {
    const pinned = manifest();
    pinned.descriptors.layers['usable-lift-agl'].noLiftSampleValue = null;
    const payload = samplePayload([frames[0]]);
    Object.assign(payload.frames[0].layers['usable-lift-agl'], { value: null, status: 'no-usable-lift' });
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse(fixtureLatest(pinned))).mockResolvedValueOnce(jsonResponse(payload));
    const client = new ApiClient({ baseUrl: 'https://api.test', fetchImpl, now: () => Date.parse(created) });
    const build = await client.latest('gfs');
    const result = await client.sample(build, { lat: payload.lat, lon: payload.lon });
    expect(result.frames[0].layers['usable-lift-agl']).toMatchObject({ value: null, status: 'no-usable-lift', surfaceId: 'gfs-fine' });
  });

  it('supports more than eight frames within the admitted result budget', async () => {
    const selected = [...frames, { ...frames[7], id: 'f027' }];
    const latest = fixtureLatest(fixtureManifestV5({ createdAt: created, expiresAt, frames: selected }));
    const payload = samplePayload(selected);
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse(latest)).mockResolvedValueOnce(jsonResponse(payload));
    const client = new ApiClient({ baseUrl: 'https://api.test', fetchImpl, now: () => Date.parse(created) });
    const build = await client.latest('gfs');
    expect((await client.sample(build, { lat: -32.9, lon: -68.9, frames: 'all' })).frames).toHaveLength(9);
  });

  it('requests the explicit all-8-frame × all-3-layer series in one call', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(latestPayload()))
      .mockResolvedValueOnce(jsonResponse(samplePayload()));
    const client = new ApiClient({ baseUrl: 'https://api.test', fetchImpl, now: () => Date.parse(created) });
    const build = await client.latest('gfs');
    const series = await client.sample(build, { lat: -32.9, lon: -68.9, frames: 'all', layers: [...layerIds] });
    const url = new URL(String(fetchImpl.mock.calls[1][0]));
    expect(url.pathname).toBe(`/v1/models/gfs/runs/${FIXTURE_BUILD_ID}/sample`);
    expect(url.searchParams.get('frame')).toBe('all');
    expect(url.searchParams.get('layers')).toBe('usable-lift-msl,usable-lift-agl,precip-rate');
    expect(series.frames).toHaveLength(8);
    expect(Object.keys(series.frames[0].layers)).toHaveLength(3);
  });

  it('fails before issuing a request when the pinned build has expired', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(latestPayload()));
    const client = new ApiClient({ baseUrl: 'https://api.test', fetchImpl: fetchImpl as typeof fetch, now: () => Date.parse(created) });
    const build = await client.latest('gfs');
    await expect(client.sample(build, { lat: 0, lon: 0, now: Date.parse(expiresAt) })).rejects.toBeInstanceOf(ExpiredBuildError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rejects responses that cross the pinned expiry while in flight', async () => {
    let now = Date.parse(created);
    let resolveResponse!: (response: Response) => void;
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(latestPayload()))
      .mockImplementationOnce(() => new Promise(resolve => { resolveResponse = resolve; }));
    const client = new ApiClient({ baseUrl: 'https://api.test', fetchImpl, now: () => now });
    const build = await client.latest('gfs');
    const pending = client.sample(build, { lat: 0, lon: 0 });
    now = Date.parse(expiresAt);
    resolveResponse(jsonResponse(samplePayload()));
    await expect(pending).rejects.toBeInstanceOf(ExpiredBuildError);
  });

  it('rejects a sample for a different model or mismatched coordinates or malformed layer status', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(latestPayload()))
      .mockResolvedValueOnce(jsonResponse({ ...(samplePayload() as object), model: 'hrrr' }))
      .mockResolvedValueOnce(jsonResponse({ ...(samplePayload() as object), lat: 12, lon: 34 }))
      .mockResolvedValueOnce(jsonResponse({
        ...(samplePayload() as object),
        frames: [{ ...frames[0], layers: Object.fromEntries(layerIds.map(layer => [layer, { value: 310, status: 'bogus', support: 0, interpolated: false }])) }]
      }));
    const client = new ApiClient({ baseUrl: 'https://api.test', fetchImpl, now: () => Date.parse(created) });
    const build = await client.latest('gfs');
    await expect(client.sample(build, { lat: -32.9, lon: -68.9 })).rejects.toBeInstanceOf(InvalidApiResponseError);
    await expect(client.sample(build, { lat: -32.9, lon: -68.9 })).rejects.toBeInstanceOf(InvalidApiResponseError);
    await expect(client.sample(build, { lat: -32.9, lon: -68.9 })).rejects.toBeInstanceOf(InvalidApiResponseError);
  });

  it('rejects out-of-range coordinates and oversized requests', async () => {
    const client = new ApiClient({ baseUrl: 'https://api.test', fetchImpl: (async () => jsonResponse(latestPayload())) as typeof fetch, now: () => Date.parse(created) });
    const build = await client.latest('gfs');
    await expect(client.sample(build, { lat: 91, lon: 0 })).rejects.toBeInstanceOf(RangeError);
    await expect(client.sample(build, { lat: 0, lon: 0, layers: [...layerIds, ...layerIds] })).rejects.toBeInstanceOf(RangeError);
  });

  it('cancels in-flight requests through AbortSignal', async () => {
    const pending = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      });
    }) as typeof fetch;
    const client = new ApiClient({ baseUrl: 'https://api.test', fetchImpl: pending });
    const controller = new AbortController();
    const request = client.latest('gfs', { signal: controller.signal });
    controller.abort();
    await expect(request).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('bounded request lifecycle', () => {
  it('retries a transient read once and never retries invalid JSON or not-retained responses', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('busy', { status: 503 })).mockResolvedValueOnce(jsonResponse(latestPayload()));
    const onMetric = vi.fn().mockImplementationOnce(() => { throw new Error('Observer failed'); });
    const client = new ApiClient({ baseUrl: 'https://api.test', fetchImpl, now: () => Date.parse(created), retryDelayMs: 0, onMetric });
    expect((await client.latest('gfs')).manifest.buildId).toBe(latestPayload().pointer.latestBuildId);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    for (const response of [new Response('invalid'), new Response('{}', { status: 404 })]) {
      fetchImpl.mockReset().mockResolvedValue(response); await expect(client.latest('gfs')).rejects.toThrow(); expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
    expect(onMetric.mock.calls.map(([metric]) => [metric.route, metric.attempts, metric.outcome])).toEqual([
      ['latest', 2, 'success'], ['latest', 1, 'failure'], ['latest', 1, 'failure']
    ]);
  });
  it('aborts on its deadline and preserves caller cancellation', async () => {
    let signal: AbortSignal | undefined;
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => { signal = init?.signal ?? undefined; return new Promise(() => {}); });
    const client = new ApiClient({ baseUrl: 'https://api.test', fetchImpl, requestTimeoutMs: 5 });
    await expect(client.latest('gfs')).rejects.toThrow('Request deadline exceeded'); expect(signal?.aborted).toBe(true);
    const abort = new AbortController(); abort.abort(new Error('changed selection'));
    await expect(client.latest('gfs', { signal: abort.signal })).rejects.toThrow('changed selection'); expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('cancels oversized response streams before parsing', async () => {
    const cancel = vi.fn();
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(
      new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(1024 * 1024 + 1)); }, cancel }),
      { headers: { 'content-length': '12' } }
    ));
    const client = new ApiClient({ baseUrl: 'https://api.test', fetchImpl });
    await expect(client.latest('gfs')).rejects.toThrow('Response exceeds byte budget'); expect(cancel).toHaveBeenCalledTimes(1); expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('shared JSON preparation budget', () => {
  it('makes selected JSON progress when foreground responses compete for the processing floor', async () => {
    const MiB = 1024 * 1024, budget = createPreparationBudget(28 * MiB, { foregroundReserveBytes: 24 * MiB });
    const background = budget.reserve('background', 4 * MiB, 'background')!;
    const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
    const headers: Array<(response: Response) => void> = [];
    const fetchImpl = vi.fn<typeof fetch>((_input, init) => new Promise((resolve, reject) => {
      headers.push(resolve); init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true });
    }));
    const scheduler = createForecastRequestScheduler({ budget, fetchImpl });
    const client = new ApiClient({ baseUrl: 'https://api.test', fetchImpl: scheduler.fetch, budget, now: () => Date.parse(created) });
    const controllers = Array.from({ length: 24 }, () => new AbortController());
    const requests = controllers.map(controller => client.latest('gfs', { signal: controller.signal }));
    const outcomes = Promise.allSettled(requests);
    try {
      await vi.waitFor(() => expect(scheduler.stats().active + scheduler.stats().queued).toBe(24));
      await vi.waitFor(() => expect(headers.length).toBeGreaterThan(0));
      headers[0](new Response(new ReadableStream<Uint8Array>({ start(controller) { streams.push(controller); } })));
      streams[0].enqueue(new TextEncoder().encode(JSON.stringify(latestPayload()))); streams[0].close();
      expect((await requests[0]).manifest.buildId).toBe(FIXTURE_BUILD_ID);
    } finally {
      controllers.forEach(controller => controller.abort()); scheduler.dispose(); await outcomes; background.release();
    }
    expect(budget.used).toBe(0);
  });
  it('charges buffer, decoded text and parsed schema work, then releases transient leases', async () => {
    const encoded = new TextEncoder().encode(JSON.stringify(latestPayload()));
    const budget = createPreparationBudget(4 * 1024 * 1024);
    const snapshots: Readonly<Record<string, number>>[] = [];
    const reserve = budget.reserve.bind(budget);
    vi.spyOn(budget, 'reserve').mockImplementation((category, bytes) => {
      const lease = reserve(category, bytes); snapshots.push(budget.snapshot()); return lease;
    });
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(encoded, { headers: { 'content-length': String(encoded.length) } }));
    const scheduler = createForecastRequestScheduler({ fetchImpl, budget });
    const client = new ApiClient({ baseUrl: 'https://api.test', fetchImpl: scheduler.fetch, budget, now: () => Date.parse(created) });
    try {
      const build = await client.latest('gfs');
      expect(build.manifest.buildId).toBe(FIXTURE_BUILD_ID);
      expect(snapshots.some(snapshot => snapshot['json-buffer'] === encoded.length && snapshot.response === 1024)).toBe(true);
      expect(snapshots.some(snapshot => snapshot['json-buffer'] === encoded.length && snapshot['json-parsed'] === encoded.length * 16 && snapshot['json-text'] === encoded.length * 2)).toBe(true);
      expect(budget.used).toBe(0);
    } finally { scheduler.dispose(); }
  });

  it('fails under parse pressure without leaks and recovers after budget release', async () => {
    const encoded = new TextEncoder().encode(JSON.stringify(latestPayload()));
    const budget = createPreparationBudget(1024 * 1024 + encoded.length * 19), blocker = budget.reserve('other', 1)!;
    let response!: Response;
    const fetchImpl = vi.fn<typeof fetch>(async () => { response = new Response(encoded, { headers: { 'content-length': String(encoded.length) } }); return response; });
    const client = new ApiClient({ baseUrl: 'https://api.test', fetchImpl, budget, now: () => Date.parse(created) });
    try {
      await expect(client.latest('gfs')).rejects.toThrow('JSON preparation budget exhausted');
      expect(response.body?.locked).toBe(false);
      expect(budget.snapshot()).toEqual({ other: 1 });
      blocker.release();
      expect((await client.latest('gfs')).manifest.buildId).toBe(FIXTURE_BUILD_ID);
      expect(budget.used).toBe(0);
    } finally { blocker.release(); }
  });

  it('releases growth and parse allocations on malformed data and schema rejection', async () => {
    const budget = createPreparationBudget(2 * 1024 * 1024);
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(`${' '.repeat(2000)}invalid`))
      .mockResolvedValueOnce(jsonResponse({ missing: true }));
    const client = new ApiClient({ baseUrl: 'https://api.test', fetchImpl, budget });
    await expect(client.latest('gfs')).rejects.toThrow('Response is not valid JSON');
    expect(budget.used).toBe(0);
    await expect(client.latest('gfs')).rejects.toThrow('does not match contract schema');
    expect(budget.used).toBe(0);
  });

  it('holds the reader allocation until asynchronous cancellation settles', async () => {
    const budget = createPreparationBudget(2 * 1024 * 1024);
    let release!: () => void;
    const cancel = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
    const response = new Response(new ReadableStream<Uint8Array>({ cancel }));
    const controller = new AbortController();
    const client = new ApiClient({ baseUrl: 'https://api.test', fetchImpl: async () => response, budget });
    const pending = client.latest('gfs', { signal: controller.signal });
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    try {
      await vi.waitFor(() => expect(budget.snapshot()).toEqual({ response: 1024 * 1024, 'json-buffer': 1024 }));
      controller.abort(); await rejected;
      expect(budget.snapshot()).toEqual({ response: 1024 * 1024, 'json-buffer': 1024 });
      release();
      await vi.waitFor(() => expect(budget.used).toBe(0));
      expect(response.body?.locked).toBe(false);
    } finally { release?.(); }
  });

  it('bounds concurrent JSON buffers with shared transport reservations and recovers after cancellation', async () => {
    const budget = createPreparationBudget(4096);
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(new ReadableStream<Uint8Array>({ cancel() {} })));
    const scheduler = createForecastRequestScheduler({ budget, fetchImpl });
    const client = new ApiClient({ baseUrl: 'https://api.test', fetchImpl: scheduler.fetch, budget });
    const controllers = Array.from({ length: 3 }, () => new AbortController());
    const requests = controllers.slice(0, 2).map(controller => client.latest('gfs', { signal: controller.signal }));
    requests.forEach(request => void request.catch(() => {}));
    try {
      await vi.waitFor(() => expect(budget.snapshot()).toEqual({ response: 2048, 'json-buffer': 2048 }));
      requests.push(client.latest('gfs', { signal: controllers[2].signal }));
      void requests[2].catch(() => {});
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(scheduler.stats()).toEqual({ active: 2, queued: 1 });
      controllers[0].abort();
      await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(3));
      await vi.waitFor(() => expect(budget.snapshot()).toEqual({ response: 2048, 'json-buffer': 2048 }));
    } finally {
      controllers.forEach(controller => controller.abort());
      await Promise.allSettled(requests); scheduler.dispose();
      await vi.waitFor(() => expect(budget.used).toBe(0));
    }
  });
});
