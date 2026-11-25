import { describe, expect, it } from 'vitest';
import { buildSkyCoverSpans } from './windgram-clouds.ts';
import type { PublishedForecastHour } from './internal-meteo.ts';

const hour = (over: Partial<PublishedForecastHour>): PublishedForecastHour => ({
  modelTerrainM: 0, fineTerrainM: null, thermalTopM: null, thermalVelocityMps: null, nativeUsableLiftTopM: null,
  effectiveCloudLimitM: null, surfaceLclM: null, mixedLayerLclM: null, cloudCapped: null, overdeveloped: null,
  mapLift: { mslM: null, msl: { status: 'unavailable' } },
  ...over
} as unknown as PublishedForecastHour);

describe('sky cover strip', () => {
  const view = { viewHours: [{ x: 10 }], columnWidth: 20, leftBound: 0, rightBound: 20, topM: 4000 };
  const moist = [{ cloudHumidityPercent: [{ altitudeM: 3800, value: 99 }, { altitudeM: 4000, value: 99 }] }] as unknown as Parameters<typeof buildSkyCoverSpans>[0]['sampling'];
  const withTotal = (total: number | null) => [hour({ surface: { cloudCoverTotalPercent: total, cloudCoverLowPercent: null } } as Partial<PublishedForecastHour>)];

  it('follows model total cloud even when the humidity is saturated', () => {
    expect(buildSkyCoverSpans({ ...view, sourceHours: withTotal(0), sampling: moist })).toEqual([]);
    expect(buildSkyCoverSpans({ ...view, sourceHours: withTotal(70), sampling: moist })[0]).toMatchObject({ tier: 'bkn', coverPercent: 70 });
  });

  it('infers cover from humidity only when total cloud is missing', () => {
    expect(buildSkyCoverSpans({ ...view, sourceHours: withTotal(null), sampling: moist })[0]).toMatchObject({ tier: 'ovc', coverPercent: 95 });
  });
});
