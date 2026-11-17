import { describe, expect, it, vi } from 'vitest';
import type { SamplePayload } from './client-types.ts';
import { ApiClient } from './client-api.ts';
import { fieldSeriesPages } from './client-point.ts';
import type { PinnedBuild } from './client-types.ts';

describe('field series pages', () => {
  it('pages the frame axis inside the sample budget and preserves order', () => {
    expect(fieldSeriesPages(['h001', 'h002', 'h003'], 2, 4)).toEqual([['h001', 'h002'], ['h003']]);
    expect(fieldSeriesPages([], 1, 4)).toEqual([]);
    expect(() => fieldSeriesPages(['h001'], 4, 3)).toThrow(/sample budget/);
  });

  it('returns manifest order and stops when the caller aborts', async () => {
    const build = seriesBuild();
    const sample = vi.spyOn(ApiClient.prototype, 'sample').mockImplementation(async (_build, request) => ({
      frames: [...(request.frames as string[])].reverse().map(id => ({ id }))
    }) as unknown as Promise<SamplePayload>);
    const client = new ApiClient({ baseUrl: 'https://api.test', fetchImpl: vi.fn() });
    await expect(client.fieldSeries(build, { lat: 1, lon: 2, layers: ['precip-rate'] })).resolves.toMatchObject({ frames: [{ id: 'h001' }, { id: 'h002' }, { id: 'h003' }] });
    expect(sample.mock.calls.map(([, request]) => request.frames)).toEqual([['h001', 'h002'], ['h003']]);
    const signal = AbortSignal.abort();
    await expect(client.fieldSeries(build, { lat: 1, lon: 2, layers: ['precip-rate'], signal })).rejects.toThrow();
    await expect(client.fieldSeries(build, { lat: 1, lon: 2, layers: ['precip-rate'], frames: 'all' })).resolves.toMatchObject({ frames: [{ id: 'h001' }, { id: 'h002' }, { id: 'h003' }] });
    sample.mockRestore();
  });

  it('rejects duplicate and unknown frames before a request', async () => {
    const build = seriesBuild();
    const sample = vi.spyOn(ApiClient.prototype, 'sample').mockResolvedValue({ frames: [] } as unknown as SamplePayload);
    const client = new ApiClient({ baseUrl: 'https://api.test', fetchImpl: vi.fn() });
    await expect(client.fieldSeries(build, { lat: 1, lon: 2, layers: ['precip-rate'], frames: ['h001', 'h001'] })).rejects.toThrow(/unique/);
    await expect(client.fieldSeries(build, { lat: 1, lon: 2, layers: ['precip-rate'], frames: ['h001', 'h002', 'h001'] })).rejects.toThrow(/unique/);
    await expect(client.fieldSeries(build, { lat: 1, lon: 2, layers: ['precip-rate'], frames: ['h001', 'h002', 'h999'] })).rejects.toThrow(/unknown frame/);
    expect(sample).not.toHaveBeenCalled();
    sample.mockRestore();
  });

  it('returns a reversed selection that spans pages in the requested order', async () => {
    const build = seriesBuild();
    const sample = vi.spyOn(ApiClient.prototype, 'sample').mockImplementation(async (_build, request) => ({
      frames: [...(request.frames as string[])].reverse().map(id => ({ id }))
    }) as unknown as Promise<SamplePayload>);
    const client = new ApiClient({ baseUrl: 'https://api.test', fetchImpl: vi.fn() });
    await expect(client.fieldSeries(build, { lat: 1, lon: 2, layers: ['precip-rate'], frames: ['h003', 'h002', 'h001'] })).resolves.toMatchObject({ frames: [{ id: 'h003' }, { id: 'h002' }, { id: 'h001' }] });
    expect(sample.mock.calls.map(([, request]) => request.frames)).toEqual([['h003', 'h002'], ['h001']]);
    sample.mockRestore();
  });
});

function seriesBuild(): PinnedBuild {
  return { manifest: { frames: [{ id: 'h001' }, { id: 'h002' }, { id: 'h003' }], layers: ['precip-rate'], descriptors: { maxSampleValues: 2 } }, templates: {}, expiresAtMs: Date.now() + 60_000 } as unknown as PinnedBuild;
}
