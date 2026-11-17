import { afterEach, expect, it, vi } from 'vitest';
import { DEFAULT_PRODUCT, PRODUCTS, getProduct } from '@av/contracts/models';
import { type ProductDefinition, type ManifestV5 } from '@av/contracts';
import { fixtureManifestV5 } from '../tests/forecast-fixture.js';
import { assertUsefulHorizon } from '../apps/batch/src/publication.js';
import { monitor } from './monitor-health.js';
import * as serving from './smoke-api.js';

const HOUR = 3600000;
function fixture(product: ProductDefinition = DEFAULT_PRODUCT, cycle = '2026-12-21T00:00:00Z', hours = product.frameHours) {
  const manifest = fixtureManifestV5({ layers: ['precip-rate'] });
  manifest.model = product.modelId; manifest.cycle = cycle;
  manifest.createdAt = new Date(Date.parse(cycle) + 1000).toISOString();
  manifest.expiresAt = new Date(Date.parse(cycle) + 7 * 86400000).toISOString();
  manifest.frames = hours.map(hour => ({
    id: `f${String(hour).padStart(3, '0')}`, validTime: new Date(Date.parse(cycle) + hour * HOUR).toISOString(),
    intervalStart: new Date(Date.parse(cycle) + (hour - product.intervalHours) * HOUR).toISOString(),
    intervalEnd: new Date(Date.parse(cycle) + hour * HOUR).toISOString()
  }));
  return manifest;
}
function observe(manifest: ManifestV5, now: number) {
  vi.spyOn(Date, 'now').mockReturnValue(now);
  vi.spyOn(serving, 'probeApi').mockImplementation(async options => { options.observeManifest?.(manifest); return manifest; });
  return monitor('https://api.example', manifest.model);
}
afterEach(() => vi.restoreAllMocks());

it('keeps identity and expiry findings when a later serving probe fails', async () => {
  const manifest = fixture(); manifest.expiresAt = new Date(0).toISOString();
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse(manifest.cycle));
  vi.spyOn(serving, 'probeApi').mockImplementation(async options => {
    options.observeManifest?.(manifest);
    options.observeClient?.({ route: 'sample', attempts: 2, elapsedMs: 250, outcome: 'failure' });
    throw new Error('sample unavailable');
  });
  const result = await monitor('https://api.example');
  expect(result).toMatchObject({ healthy: false, model: DEFAULT_PRODUCT.modelId, buildId: manifest.buildId, sourceRevision: manifest.recipe.sourceRevision });
  expect(result.findings.join(';')).toContain('expired-publication');
  expect(result.findings.join(';')).toContain('sample unavailable');
  expect(result.clientRequests.sample).toEqual({ count: 1, retries: 1, failed: 1, maxElapsedMs: 250 });
});

it('reports the first successful response when a probe retries', async () => {
  const manifest = fixture();
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse(manifest.cycle));
  vi.spyOn(serving, 'probeApi').mockImplementation(async options => {
    options.observeManifest?.(manifest);
    options.observeProbe?.('latest', { status: 503, elapsedMs: 20 });
    options.observeProbe?.('latest', { status: 200, elapsedMs: 8, responseCache: 'hit' });
    options.observeProbe?.('latest', { status: 200, elapsedMs: 11 });
    return manifest;
  });
  const result = await monitor('https://api.example');
  expect(result.healthy).toBe(true);
  expect(result.probes.latest).toMatchObject({ status: 200, elapsedMs: 8, responseCache: 'hit' });
});

it.each(PRODUCTS)('uses monitoring age, horizon and expiry for $modelId', async product => {
  const manifest = fixture(product), cycle = Date.parse(manifest.cycle), last = product.frameHours.at(-1)!;
  const span = Math.min(product.monitoring.maxCycleAgeHours, last - product.monitoring.minHorizonHours);
  const deadline = cycle + span * HOUR - (span >= last ? 1 : 0);
  expect((await observe(manifest, deadline)).healthy).toBe(true);
  const staleAt = cycle + (product.monitoring.maxCycleAgeHours + product.frameHours.at(-1)! + 1) * HOUR;
  const stale = await observe(manifest, staleAt);
  expect(stale.findings.join(';')).toContain('upstream-lag');
  expect(stale.findings.join(';')).toContain('shrinking-horizon');
  expect(stale.findings.join(';')).toContain('exhausted-horizon');
  expect(stale.findings.some(finding => finding.startsWith('expired-publication'))).toBe(staleAt >= Date.parse(manifest.expiresAt));
});

it.each(PRODUCTS.filter(product => product.capabilities.daylightFrames === 'regional-daylight'))('keeps $modelId daylight-filtered horizons aligned with health', async product => {
  const cycle = '2026-12-21T00:00:00Z';
  const shortened = product.frameHours.filter((_, index) => index % 2 === 0);
  for (const hours of [product.frameHours, shortened]) {
    const manifest = fixture(product, cycle, hours);
    const deadline = Math.min(
      Date.parse(cycle) + Math.min(product.freshness.maxCycleAgeHours, product.frameHours.at(-1)! - product.freshness.minHorizonHours) * HOUR,
      Date.parse(manifest.frames.at(-1)!.validTime) - 1
    );
    expect(() => assertUsefulHorizon(manifest, deadline)).not.toThrow();
    expect((await observe(manifest, deadline)).findings).toEqual([]);
    expect(() => assertUsefulHorizon(manifest, deadline + 1)).toThrow('useful forecast horizon');
    expect((await observe(manifest, deadline + 1)).healthy).toBe(false);
  }
});

it('keeps a delivered Virginia cycle healthy until the next 12Z', async () => {
  const manifest = fixture(getProduct('wrf-va-1km')!, '2026-11-17T12:00:00.000Z');
  expect((await observe(manifest, Date.parse('2026-11-17T18:01:00.000Z'))).healthy).toBe(true);
  expect((await observe(manifest, Date.parse('2026-11-18T11:00:00.000Z'))).findings).toEqual([]);
  const exhausted = await observe(manifest, Date.parse('2026-11-18T12:00:00.000Z'));
  expect(exhausted.healthy).toBe(false);
  expect(exhausted.findings.join(';')).toContain('exhausted-horizon');
  expect(exhausted.findings.some(finding => finding.startsWith('upstream-lag'))).toBe(false);
});

it.each(['No publication for wrf-va-1km', 'corrupt publication'])('fails health when the publication probe reports %s', async defect => {
  vi.spyOn(serving, 'probeApi').mockRejectedValue(new Error(defect));
  const result = await monitor('https://api.example', 'wrf-va-1km');
  expect(result.healthy).toBe(false);
  expect(result.findings.join(';')).toContain('serving-integrity');
  expect(result.findings.join(';')).toContain(defect);
});

it('fails an expired Virginia publication inside its monitoring age', async () => {
  const manifest = fixture(getProduct('wrf-va-1km')!, '2026-11-17T12:00:00.000Z');
  manifest.expiresAt = '2026-11-17T13:00:00.000Z';
  const result = await observe(manifest, Date.parse('2026-11-17T14:00:00.000Z'));
  expect(result.healthy).toBe(false);
  expect(result.findings.join(';')).toContain('expired-publication');
  expect(result.findings.some(finding => finding.startsWith('upstream-lag'))).toBe(false);
});

it('reports an unknown model before probing', async () => {
  const probe = vi.spyOn(serving, 'probeApi');
  expect((await monitor('https://api.example', 'unknown')).findings.join(';')).toContain('Unknown forecast model');
  expect(probe).not.toHaveBeenCalled();
});

it('finds an exhausted map prefix even when later native samples remain', async () => {
  const retained = fixture(DEFAULT_PRODUCT, '2026-11-06T00:00:00Z', [1, 24, 72, 384]);
  const manifest = { ...retained, mapFrameCount: 2 };
  expect((await observe(manifest, Date.parse(manifest.cycle) + 25 * HOUR)).findings.join(';')).toContain('exhausted-horizon');
});
