import { describe, expect, it } from 'vitest';
import { estimateThermalClimbAtHeight, nativeThermalColumn, resolveConvectiveEnvelope } from './windgram-climb.ts';
import { buildSkyCoverSpans, classifyConvectiveCloudRegime } from './windgram-clouds.ts';
import type { PublishedForecastHour } from './internal-meteo.ts';

const hour = (over: Partial<PublishedForecastHour>): PublishedForecastHour => ({
  modelTerrainM: 0, fineTerrainM: null, thermalTopM: null, thermalVelocityMps: null, nativeUsableLiftTopM: null,
  effectiveCloudLimitM: null, surfaceLclM: null, mixedLayerLclM: null, cloudCapped: null, overdeveloped: null,
  mapLift: { mslM: null, msl: { status: 'unavailable' } },
  ...over
} as unknown as PublishedForecastHour);

describe('native climb column', () => {
  it('keeps a deep valley fine ceiling separate from a shallow native column', () => {
    // Native ground 2,000 m, depth 200 m, w* 0.5 m/s; the fine map says 1,982 m usable over 0 m terrain.
    const valley = hour({
      modelTerrainM: 2000, fineTerrainM: 0, thermalTopM: 2200, thermalVelocityMps: 0.5, nativeUsableLiftTopM: null,
      mapLift: { mslM: 1982, msl: { status: 'valid' } } as PublishedForecastHour['mapLift']
    });
    const column = nativeThermalColumn(valley)!;
    expect(column).toMatchObject({ groundM: 2000, thermalTopM: 2200, usableTopM: null });
    expect(resolveConvectiveEnvelope(column, 0)).toBeNull();
    // A known native column with no usable climb reads 0, never a climb rate invented from the fine ceiling.
    expect(estimateThermalClimbAtHeight(1000, column, 0)).toEqual({ estimatedClimbMps: 0, peakClimbMps: null });
    expect(valley.mapLift.mslM).toBe(1982);
  });

  it('reads null climb when native inputs are missing', () => {
    expect(nativeThermalColumn(hour({ thermalTopM: 1500 }))).toBeNull();
    expect(estimateThermalClimbAtHeight(500, null, 0)).toEqual({ estimatedClimbMps: null, peakClimbMps: null });
  });

  it('builds ordinary native lift from model ground', () => {
    const column = nativeThermalColumn(hour({ modelTerrainM: 300, thermalTopM: 2300, thermalVelocityMps: 2.5, nativeUsableLiftTopM: 2000 }))!;
    const env = resolveConvectiveEnvelope(column, 250)!;
    expect(env).toMatchObject({ groundM: 300, floorM: 300, usableTopM: 2000, convectiveDepthM: 2000 });
    expect(env.peakClimbMps).toBeGreaterThan(1);
  });

  it('keeps the convective depth to thermal top under a cloud cap', () => {
    const column = nativeThermalColumn(hour({ modelTerrainM: 0, thermalTopM: 2000, thermalVelocityMps: 2, nativeUsableLiftTopM: 1200, effectiveCloudLimitM: 1200 }))!;
    expect(resolveConvectiveEnvelope(column)!.convectiveDepthM).toBe(2000);
  });

  it('classifies cumulus from the native column alone', () => {
    const base = { modelTerrainM: 0, thermalTopM: 1500, thermalVelocityMps: 2, nativeUsableLiftTopM: 1300 };
    expect(classifyConvectiveCloudRegime(hour({ ...base, surfaceLclM: 1510 }))).toBe('cu');
    // A higher fine ceiling cannot push the native top up to the condensation level.
    expect(classifyConvectiveCloudRegime(hour({
      ...base, surfaceLclM: 2500, mapLift: { mslM: 2600, msl: { status: 'valid' } } as PublishedForecastHour['mapLift']
    }))).toBe('none');
  });
});

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
