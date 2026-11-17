import { expect, it } from 'vitest';
import { getProduct } from '@av/contracts/models';
import { pinnedSourcePrefix, sourceCycle, sourceModelId } from './source.js';

const model = { modelId: 'av-wrf', upstream: { modelId: 'pilot-source' } };
const cycle = '2026-11-13T00:00:00Z', prefix = 'upstream/pilot-source/20261113/00/';

it('binds an upstream receipt to its configured source independently of the public model', () => {
  expect(sourceModelId(model)).toBe('pilot-source');
  expect(sourceModelId({ modelId: 'gfs', upstream: {} })).toBe('gfs');
  expect(pinnedSourcePrefix(model, cycle, `${prefix}_ready.json`)).toBe(prefix);
  for (const key of [`upstream/av-wrf/20261113/00/_ready.json`, `upstream/other/20261113/00/_ready.json`, `${prefix}../_ready.json`]) {
    expect(() => pinnedSourcePrefix(model, cycle, key)).toThrow('must identify the model cycle');
  }
});

it('admits a Virginia WRF 12Z cycle and rejects 00Z', () => {
  const hours = getProduct('wrf-va-1km')!.forecast.cycleHoursUtc;
  expect(sourceCycle('2026-11-17T12:00:00Z', hours)).toBe('2026-11-17T12:00:00.000Z');
  expect(() => sourceCycle('2026-11-17T00:00:00Z', hours)).toThrow('exact ISO UTC');
});

it.each(['../source', '', 'a/b', null, 1])('rejects unsafe configured source identity %j', modelId => {
  expect(() => sourceModelId({ ...model, upstream: { modelId } })).toThrow();
});
