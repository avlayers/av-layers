import { describe, expect, it } from 'vitest';
import { getProduct, type ModelDefinition } from '@av/contracts/models';
import { sourceIntervalHours } from '@av/contracts';
import { intervalMeanAmountMm, recoverTrailingWindow } from '@av/forecast/intervals';
import { assertWrfWeatherDefinitions } from '@av/forecast/direct-scalars';
import { parseIdx } from '@azohra/meteo.grib';
import contract from '../../../../packages/contracts/schemas/wrf-zarr-v3.schema.json' with { type: 'json' };
import { indexedGribCompanionSpecs, indexedGribCurrentSpecs } from './fields.ts';
import { indexedGribWindowStart } from './intervals.ts';
import { indexedSource } from './source.ts';
import { selectUniqueRecord } from './transport.ts';
import { splitSource } from '../split-grib/source.ts';

function index(lines: string[]) {
  const text = [...lines, `${lines.length + 1}:1000:d=2026111600:DUMMY:surface:other:`].join('\n');
  return { text, records: parseIdx(text) };
}

describe('weather source selection', () => {
  const gfs = getProduct('gfs')!;
  const rrfs = getProduct('rrfs')!;

  it('keeps the configured auxiliary set for a full product and drops it for lift and precipitation', () => {
    const full = indexedSource(gfs);
    expect(Object.keys(full.upstream.auxSurface ?? {})).toEqual(Object.keys(gfs.upstream.auxSurface as object));
    expect(Object.keys(full.upstream.auxLevels ?? {})).toEqual(Object.keys(gfs.upstream.auxLevels as object));
    const reduced = indexedSource({ ...gfs, layers: ['usable-lift-msl', 'usable-lift-agl', 'precip-rate'] } as ModelDefinition);
    expect(reduced.upstream.auxSurface).toBeUndefined();
    expect(reduced.upstream.auxLevels).toBeUndefined();
    const icon = getProduct('icon-eu')!;
    const fullIcon = splitSource(icon);
    expect(Object.keys(fullIcon.upstream.auxSurface ?? {})).toEqual(Object.keys(icon.upstream.auxSurface as object));
    const reducedIcon = splitSource({ ...icon, layers: ['usable-lift-msl', 'usable-lift-agl'] } as ModelDefinition);
    expect(reducedIcon.upstream.auxSurface).toBeUndefined();
    expect(reducedIcon.upstream.auxLevels).toBeUndefined();
  });

  it('rejects a cloud binding whose level or units differ from the definition', () => {
    const upstream = gfs.upstream;
    const cloud = { ...(upstream.auxSurface as { cloudTotalPct: object }).cloudTotalPct, variable: 'TCDC', level: 'low cloud layer', unit: '%' };
    expect(() => indexedSource({ ...gfs, upstream: { ...upstream, auxSurface: { ...(upstream.auxSurface as object), cloudTotalPct: cloud } } } as ModelDefinition)).toThrow(/cloudTotalPct/);
    const fraction = { ...cloud, level: 'entire atmosphere', unit: '1' };
    expect(() => indexedSource({ ...gfs, upstream: { ...upstream, auxSurface: { ...(upstream.auxSurface as object), cloudTotalPct: fraction } } } as ModelDefinition)).toThrow(/units/);
  });

  it('selects instantaneous cloud and the trailing precipitation window', () => {
    const source = indexedSource(gfs);
    const current = indexedGribCurrentSpecs(source, 27);
    expect(current.find(spec => spec.key === 'precipitation')!.forecast).toBe('24-27 hour acc fcst');
    expect(indexedGribCompanionSpecs(source, 27).find(spec => spec.key === 'precipitation')!.forecast).toBe('24-26 hour acc fcst');
    expect(current.find(spec => spec.key === 'auxSurface.cloudTotalPct')!.forecast).toBe('27 hour fcst');
    const cloud = index([
      '1:0:d=2026111600:TCDC:entire atmosphere:0-27 hour ave fcst:',
      '2:100:d=2026111600:TCDC:entire atmosphere:27 hour fcst:'
    ]);
    expect(selectUniqueRecord(cloud.records, cloud.text, { key: 'cloud', variable: 'TCDC', level: 'entire atmosphere', forecast: '27 hour fcst' }).record.offset).toBe(100);
    const rrfsSource = indexedSource(rrfs);
    expect(indexedGribCurrentSpecs(rrfsSource, 4).find(spec => spec.key === 'precipitation')!.forecast).toBe('3-4 hour acc fcst');
    const precip = index([
      '1:0:d=2026111600:APCP:surface:0-4 hour acc fcst:',
      '2:80:d=2026111600:APCP:surface:3-4 hour acc fcst:'
    ]);
    expect(selectUniqueRecord(precip.records, precip.text, { key: 'precipitation', variable: 'APCP', level: 'surface', forecast: '3-4 hour acc fcst' }).record.offset).toBe(80);
  });

  it('recovers the f027 one-hour rate and multiplies a rate by its own duration', () => {
    const source = indexedSource(gfs);
    const recover = (hour: number, current: number, previous: number) => {
      const start = indexedGribWindowStart(source, hour);
      const step = sourceIntervalHours(gfs, hour);
      return recoverTrailingWindow({
        currentValues: Float64Array.of(current), currentMissing: Uint8Array.of(0),
        companionValues: Float64Array.of(previous), companionMissing: Uint8Array.of(0),
        currentHours: hour - start, previousHours: hour - step - start, statistic: 'accumulation', packingErrorCurrent: 0, packingErrorPrevious: 0
      });
    };
    expect(indexedGribWindowStart(source, 27)).toBe(24);
    expect(sourceIntervalHours(gfs, 27)).toBe(1);
    const hour27 = recover(27, 3, 2);
    expect(hour27.derivedHours).toBe(1);
    expect(hour27.values[0]).toBe(1);
    expect(intervalMeanAmountMm(hour27.values[0]!, 1)).toBe(1);
    expect(indexedGribWindowStart(source, 126)).toBe(120);
    expect(sourceIntervalHours(gfs, 126)).toBe(3);
    const tail = recover(126, 9, 6);
    expect(tail.derivedHours).toBe(3);
    expect(intervalMeanAmountMm(tail.values[0]!, 3)).toBe(3);
    expect(intervalMeanAmountMm(1, Number.NaN)).toBeNull();
    const packed = recoverTrailingWindow({
      currentValues: Float64Array.of(1, 1), currentMissing: Uint8Array.of(0, 0), companionValues: Float64Array.of(1.05, 1.2), companionMissing: Uint8Array.of(0, 0),
      currentHours: 2, previousHours: 1, statistic: 'accumulation', packingErrorCurrent: 0.05, packingErrorPrevious: 0.05
    });
    expect(packed.values[0]).toBe(0);
    expect(packed.missing[1]).toBe(1);
  });

  it('binds WRF definitions to the v3 contract strings', () => {
    const published = {
      capeParcelDefinition: contract.capeParcelDefinition,
      lowCloudDefinition: contract.lowCloudDefinition,
      precipitationField: 'precip_mm_hr',
      totalCloudField: 'cloud_total_pct'
    };
    expect(() => assertWrfWeatherDefinitions('wrf-fixture', published)).not.toThrow();
    expect(() => assertWrfWeatherDefinitions('av-wrf', published)).not.toThrow();
    expect(() => assertWrfWeatherDefinitions('av-wrf', { ...published, capeParcelDefinition: 'other' })).toThrow(/CAPE/);
  });
});
