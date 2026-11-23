import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getProduct, type ModelDefinition } from '@av/contracts/models';
import { canonicalGridJson, planWholeDomainGrid, setBit, sourceIntervalHours, sparseCoverageFromDense, sparseCoverageLookup, STATUS_MASK, STATUS_NO_LIFT, STATUS_UNAVAILABLE, STATUS_VALID, SUPPORT_CUMULUS, type CoverageMask, type Grid } from '@av/contracts';
import { intervalMeanAmountMm, recoverTrailingWindow } from '@av/forecast/intervals';
import { assertWrfWeatherDefinitions } from '@av/forecast/direct-scalars';
import { deriveFrame } from '@av/forecast/frame';
import { prepareNativeProfiles, readProfileRecord } from '@av/forecast';
import { preparePackedTerrainColumns } from '@av/forecast/refinement';
import type { AuxField, NormalizedFrame } from '@av/forecast/inputs';
import { effectiveCloudHumidityPercent, gfsV16SaturationVaporPressureHpa, saturationVaporPressureHpa } from '@av/thermodynamics';
import { decodePackedWindChunk, normalizedWindColumn, samplePackedWindColumns } from '@av/forecast/wind';
import { normalizedFixtureFrame } from '../../../../scripts/fixtures/normalized-provider.js';
import { createWindDataWriter } from '../wind-data.js';
import type { WholeDomainPrepared } from '../whole-domain/prepare.js';
import { parseIdx } from '@azohra/meteo.grib';
import contract from '../../../../packages/contracts/schemas/wrf-zarr-v3.schema.json' with { type: 'json' };
import { indexedGribCompanionSpecs, indexedGribCurrentSpecs } from './fields.ts';
import { indexedGribWindowStart } from './intervals.ts';
import { indexedSource } from './source.ts';
import { createIndexedGribProvider } from './provider.ts';
import { selectUniqueRecord } from './transport.ts';
import { splitSource } from '../split-grib/source.ts';

function index(lines: string[]) {
  const text = [...lines, `${lines.length + 1}:1000:d=2026111600:DUMMY:surface:other:`].join('\n');
  return { text, records: parseIdx(text) };
}

function pick<T>(fields: Readonly<Record<string, T>> | undefined, keys: readonly string[]): Record<string, T> | undefined {
  if (!fields) return undefined;
  const selected = Object.fromEntries(Object.entries(fields).filter(([id]) => keys.includes(id))) as Record<string, T>;
  return Object.keys(selected).length ? selected : undefined;
}

function boundaryFrame() {
  const grid: Grid = { kind: 'regular-latlon', earthRadiusM: 6371229, width: 32, height: 2,
    lon0: 0, lat0: 1, dx: 0.1, dy: -0.1, wrapLongitude: false };
  const active = Uint32Array.of(0, 16, 32, 48), frame = normalizedFixtureFrame(grid, active, '2026-06-21T00:00:00Z', 12, 1);
  const values = (value: number) => new Float32Array(active.length).fill(value);
  const aux = (value: number): AuxField => ({ values: values(value), missing: new Uint8Array(active.length) });
  const mask: CoverageMask = { grid, output: new Uint8Array(8), halo: new Uint8Array(8), tiles: Uint8Array.of(1), maxZoom: 0 };
  for (const index of active) setBit(mask.output, index);
  const coverage = sparseCoverageFromDense({ ...grid, gridHash: 'a'.repeat(64), output: mask.output, halo: mask.halo });
  frame.temp2mK.fill(298.15);
  frame.hgtM = [200, 600, 1200, 1800].map(values);
  frame.tempK = [23, 20, 15, 12].map(temperature => values(temperature + 273.15));
  frame.pressureLevelsHpa = [980, 940, 880, 820];
  frame.missing.hgt = frame.hgtM.map(() => new Uint8Array(active.length));
  frame.missing.temp = frame.tempK.map(() => new Uint8Array(active.length));
  frame.auxSurface = { mslpPa: aux(101325), u10mMps: aux(3), v10mMps: aux(-4), gust10mMps: aux(8),
    pblHeightM: aux(800), capeJkg: aux(250), cloudTotalPct: aux(60), cloudLowPct: aux(25) };
  frame.auxLevels = { rhPercent: [60, 70, 90, 90].map(aux), uWindMps: [4, 5, 6, 7].map(aux), vWindMps: [-1, -2, -3, -4].map(aux) };
  return { frame, mask, coverage };
}

function structuredCloneFrame(frame: NormalizedFrame): NormalizedFrame {
  return structuredClone(frame);
}

describe('weather source selection', () => {
  const gfs = getProduct('gfs')!;
  const rrfs = getProduct('rrfs')!;

  it('keeps the configured auxiliary set for a full product and drops it for lift and precipitation', () => {
    const full = indexedSource(gfs);
    expect(Object.keys(full.upstream.auxSurface ?? {})).toEqual(Object.keys(gfs.upstream.auxSurface as object));
    expect(Object.keys(full.upstream.auxLevels ?? {})).toEqual(Object.keys(gfs.upstream.auxLevels as object));
    const fullWind = indexedSource(gfs, { numericWind: true });
    expect(Object.keys(fullWind.upstream.auxSurface ?? {})).toEqual(Object.keys(gfs.upstream.auxSurface as object));
    expect(Object.keys(fullWind.upstream.auxLevels ?? {})).toEqual(Object.keys(gfs.upstream.auxLevels as object));
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

  it('keeps the boundary-layer wind anchor and numeric wind inputs', async () => {
    const icon = getProduct('icon-eu')!;
    const boundary = ['usable-lift-msl', 'usable-lift-agl', 'precip-rate', 'bl-mean-wind-u', 'bl-mean-wind-v'] as const;
    const lift = ['usable-lift-msl', 'usable-lift-agl', 'precip-rate'] as const;
    for (const source of [indexedSource({ ...gfs, layers: [...boundary] } as ModelDefinition), splitSource({ ...icon, layers: [...boundary] } as ModelDefinition)]) {
      for (const id of ['pblHeightM', 'u10mMps', 'v10mMps']) expect(source.upstream.auxSurface).toHaveProperty(id);
      for (const id of ['uWindMps', 'vWindMps']) expect(source.upstream.auxLevels).toHaveProperty(id);
      expect(source.upstream.auxSurface).not.toHaveProperty('cloudTotalPct');
    }
    const one = indexedSource({ ...gfs, layers: ['bl-mean-wind-u'] } as ModelDefinition);
    for (const id of ['pblHeightM', 'u10mMps', 'v10mMps']) expect(one.upstream.auxSurface).toHaveProperty(id);
    for (const id of ['uWindMps', 'vWindMps']) expect(one.upstream.auxLevels).toHaveProperty(id);
    const reduced = { ...gfs, layers: [...lift] } as ModelDefinition;
    expect(indexedSource(reduced).upstream.auxSurface).toBeUndefined();
    const numeric = indexedSource(reduced, { numericWind: true });
    expect(Object.keys(numeric.upstream.auxSurface ?? {}).sort()).toEqual(['u10mMps', 'v10mMps']);
    expect(Object.keys(numeric.upstream.auxLevels ?? {}).sort()).toEqual(['uWindMps', 'vWindMps']);
    const provider = createIndexedGribProvider(reduced, { numericWind: true });
    expect(provider.auxiliarySurfaceFields).toBe(2);
    expect(provider.auxiliaryLevelFields).toBe(2);
    expect(createIndexedGribProvider(reduced).auxiliarySurfaceFields).toBe(0);
    const iconReduced = { ...icon, layers: ['usable-lift-msl', 'usable-lift-agl'] } as ModelDefinition;
    expect(splitSource(iconReduced).upstream.auxLevels).toBeUndefined();
    const iconWind = splitSource(iconReduced, { numericWind: true });
    expect(Object.keys(iconWind.upstream.auxSurface ?? {}).sort()).toEqual(['u10mMps', 'v10mMps']);
    expect(Object.keys(iconWind.upstream.auxLevels ?? {}).sort()).toEqual(['uWindMps', 'vWindMps']);

    const { frame, mask, coverage } = boundaryFrame();
    const slot = sparseCoverageLookup(coverage, 0, 0)!.offset;
    const original = deriveFrame(frame, mask, { layers: [...boundary], nativeCoverage: coverage });
    const kept = indexedSource({ ...gfs, layers: [...boundary] } as ModelDefinition);
    const selected = structuredCloneFrame(frame);
    selected.auxSurface = pick(selected.auxSurface, Object.keys(kept.upstream.auxSurface ?? {})) as typeof selected.auxSurface;
    selected.auxLevels = pick(selected.auxLevels, Object.keys(kept.upstream.auxLevels ?? {})) as typeof selected.auxLevels;
    const acquired = deriveFrame(selected, mask, { layers: [...boundary], nativeCoverage: coverage });
    expect(acquired['bl-mean-wind-u']!.flags[slot] & STATUS_MASK).toBe(STATUS_VALID);
    expect(acquired['bl-mean-wind-v']!.flags[slot] & STATUS_MASK).toBe(STATUS_VALID);
    expect(acquired['bl-mean-wind-u']!.values[slot]).toBe(original['bl-mean-wind-u']!.values[slot]);
    expect(acquired['bl-mean-wind-v']!.values[slot]).toBe(original['bl-mean-wind-v']!.values[slot]);
    delete selected.auxSurface!.u10mMps;
    delete selected.auxSurface!.v10mMps;
    const dropped = deriveFrame(selected, mask, { layers: [...boundary], nativeCoverage: coverage });
    expect(dropped['bl-mean-wind-u']!.flags[slot] & STATUS_MASK).toBe(STATUS_UNAVAILABLE);
    expect(dropped['bl-mean-wind-v']!.flags[slot] & STATUS_MASK).toBe(STATUS_UNAVAILABLE);

    const root = await mkdtemp(join(tmpdir(), 'av-wind-reduced-'));
    try {
      const grid = { kind: 'regular-latlon' as const, width: 1, height: 1, lon0: 0, lat0: 0, dx: 1, dy: 1, earthRadiusM: 6371000, wrapLongitude: false };
      const values = (n: number) => new Float32Array([n]);
      const missing = () => new Uint8Array(1);
      const aux = (n: number) => ({ values: values(n), missing: missing() });
      const windFrame = {
        activeIndices: Uint32Array.of(0), terrainM: values(100), surfacePressurePa: values(100000), pressureLevelsHpa: [900],
        hgtM: [values(1500)], missing: { terrain: missing(), surfacePressure: missing(), hgt: [missing()] },
        auxSurface: { u10mMps: aux(3.5), v10mMps: aux(-1.5) }, auxLevels: { uWindMps: [aux(8)], vWindMps: [aux(-4)] }
      } as unknown as NormalizedFrame;
      expect(normalizedWindColumn(windFrame, 0)).toMatchObject({ surface: { u: 3.5, v: -1.5 } });
      const bare = { ...windFrame, auxSurface: undefined, auxLevels: undefined } as NormalizedFrame;
      expect(normalizedWindColumn(bare, 0)).toMatchObject({ surface: null, levels: [null, null] });
      const output = Uint8Array.of(1);
      const windCoverage = sparseCoverageFromDense({ ...grid, gridHash: 'a'.repeat(64), output, halo: new Uint8Array(1) });
      const plan = { native: grid, fine: grid };
      const prepared = { plan, fine: { mask: { coverage: windCoverage } } } as unknown as WholeDomainPrepared;
      const writer = createWindDataWriter(root, 'gfs', 'build', 1, plan, { mapFrames: 1, numericBytes: 0, estimatedPeakBytes: 0 });
      await writer.writeFrame(windFrame, 'f1', { values: values(0), flags: missing() }, prepared, { elevationM: values(100), valid: Uint8Array.of(1) });
      const bytes = await readFile(join(root, 'builds/gfs/build/map-data/f1/wind-0.bin'));
      const chunk = decodePackedWindChunk(bytes);
      const samplePlan = { contributors: [{ index: 0, row: 0, column: 0, weight: 1 }], byteRange: { offset: 0, length: 1 } };
      expect(samplePackedWindColumns(samplePlan, [chunk], [0], 'surface')).toMatchObject({ u: 3.5, v: -1.5, status: STATUS_VALID });
      expect(samplePackedWindColumns(samplePlan, [chunk], [0], 1500)).toMatchObject({ u: 8, v: -4, status: STATUS_VALID });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('keeps PBL height when surface LCL runs the native diagnostic', () => {
    const icon = getProduct('icon-eu')!;
    const layers = ['usable-lift-msl', 'usable-lift-agl', 'precip-rate', 'surface-lcl-msl'] as const;
    const nativeGrid: Grid = { kind: 'regular-latlon', width: 2, height: 2, earthRadiusM: 6371229, lon0: 0, lat0: 40, dx: 0.1, dy: -0.1, wrapLongitude: false };
    const plan = planWholeDomainGrid(nativeGrid, 2);
    const active = Uint32Array.of(0, 1, 2, 3);
    const mask: CoverageMask = { grid: nativeGrid, output: new Uint8Array(1), halo: new Uint8Array(1), tiles: Uint8Array.of(1), maxZoom: 0 };
    for (const index of active) setBit(mask.output, index);
    const frame = normalizedFixtureFrame(nativeGrid, active, '2026-06-21T00:00:00Z', 12, 1);
    const values = (value: number) => new Float32Array(active.length).fill(value);
    const aux = (value: number): AuxField => ({ values: values(value), missing: new Uint8Array(active.length) });
    frame.terrainM = values(100);
    frame.temp2mK = values(25 + 273.15);
    frame.specificHumidity2mKgKg = values(0.019);
    frame.sensibleHeatFluxWm2 = values(80);
    frame.latentHeatFluxWm2 = values(0);
    frame.surfacePressurePa = values(100000);
    frame.hgtM = [400, 900, 1500].map(values);
    frame.tempK = [30, 22, 12].map(temperature => values(temperature + 273.15));
    frame.pressureLevelsHpa = [960, 900, 850];
    frame.missing.hgt = frame.hgtM.map(() => new Uint8Array(active.length));
    frame.missing.temp = frame.tempK.map(() => new Uint8Array(active.length));
    frame.auxSurface = { pblHeightM: aux(120), cloudTotalPct: aux(60) };
    frame.auxLevels = { rhPercent: [20, 20, 20].map(aux) };
    const hash = (grid: Grid) => createHash('sha256').update(canonicalGridJson(grid)).digest('hex');
    const fineCells = plan.fine.width * plan.fine.height;
    const fineMask: CoverageMask = { grid: plan.fine, output: new Uint8Array(Math.ceil(fineCells / 8)), halo: new Uint8Array(Math.ceil(fineCells / 8)), tiles: Uint8Array.of(1), maxZoom: 0 };
    for (let index = 0; index < fineCells; index++) setBit(fineMask.output, index);
    const coverage = sparseCoverageFromDense({ ...plan.fine, gridHash: hash(plan.fine), output: fineMask.output, halo: fineMask.halo });
    const count = coverage.offsets[coverage.blockIds.length]!;
    const terrain = { elevationM: new Float32Array(count).fill(100), valid: new Uint8Array(count).fill(1) };
    const diagnostics = { ceilingMslM: new Float32Array(active.length), buoyancyM2S3: new Float32Array(active.length), branch: new Uint8Array(active.length) };
    const day = { intervalStart: '2026-06-21T11:00:00Z', validTime: '2026-06-21T12:00:00Z' };
    const packed = preparePackedTerrainColumns(plan, coverage, active, frame.hgtM.length, { maxBytes: 2_000_000, expectedGridHash: hash(plan.fine) });
    const deriveFine = (source: NormalizedFrame) => {
      const flags = deriveFrame(source, mask, { layers: [...layers], daylightOnly: false })['usable-lift-msl']!.flags;
      return packed.derive(source, terrain, day, { daylightOnly: false, nativeClearance: { validTime: day.validTime, grid: nativeGrid, diagnostics, flags } }).fields;
    };
    for (const source of [indexedSource({ ...gfs, layers: [...layers] } as ModelDefinition), splitSource({ ...icon, layers: [...layers] } as ModelDefinition)]) {
      expect(source.upstream.auxSurface).toHaveProperty('pblHeightM');
      expect(source.upstream.auxSurface).not.toHaveProperty('cloudTotalPct');
      const selected = structuredCloneFrame(frame);
      selected.auxSurface = pick(selected.auxSurface, Object.keys(source.upstream.auxSurface ?? {})) as typeof selected.auxSurface;
      selected.auxLevels = pick(selected.auxLevels, Object.keys(source.upstream.auxLevels ?? {})) as typeof selected.auxLevels;
      const unpruned = deriveFine(frame);
      const acquired = deriveFine(selected);
      for (const layer of ['usable-lift-msl', 'usable-lift-agl'] as const) {
        expect([...acquired[layer].values]).toEqual([...unpruned[layer].values]);
        expect([...acquired[layer].flags]).toEqual([...unpruned[layer].flags]);
        expect(acquired[layer].flags.every(flag => flag === (STATUS_NO_LIFT | SUPPORT_CUMULUS))).toBe(true);
        expect(acquired[layer].values.every(value => value === (layer === 'usable-lift-msl' ? 100 : 0))).toBe(true);
      }
      delete selected.auxSurface!.pblHeightM;
      const dropped = deriveFine(selected);
      expect(dropped['usable-lift-msl'].flags.every(flag => flag === STATUS_NO_LIFT)).toBe(true);
      expect([...dropped['usable-lift-msl'].values]).toEqual([...unpruned['usable-lift-msl'].values]);
    }
    expect(indexedSource({ ...gfs, layers: ['usable-lift-msl', 'usable-lift-agl', 'precip-rate'] } as ModelDefinition).upstream.auxSurface).toBeUndefined();
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

  it('scopes GFS SPFH to primary levels, GFS v16 RH to secondary levels, and preserves moisture across packed profiles', () => {
    const source = indexedSource(gfs);
    const specs = indexedGribCurrentSpecs(source, 3);
    const spfhLevels = specs.filter(spec => spec.auxId === 'spfhKgKg').map(spec => spec.levelHpa);
    const rhLevels = specs.filter(spec => spec.auxId === 'rhPercent').map(spec => spec.levelHpa);
    expect(spfhLevels).toContain(450);
    expect(spfhLevels).toContain(400);
    expect(spfhLevels).not.toContain(875);
    expect(rhLevels).toContain(875);
    expect(rhLevels).not.toContain(450);

    // Two-column packed round-trip: cell 0 = Cascades negative + 875 hPa RH-only secondary; cell 1 = 400 hPa positive control
    const grid: Grid = { kind: 'regular-latlon', earthRadiusM: 6371229, width: 2, height: 1, lon0: -121.5, lat0: 47.5, dx: 43.25, dy: -8.75, wrapLongitude: false };
    const active = Uint32Array.of(0, 1);
    const frame = normalizedFixtureFrame(grid, active, '2026-11-20T00:00:00Z', 3, 1);
    frame.terrainM = Float32Array.of(400, 300);
    frame.surfacePressurePa = Float32Array.of(96500, 98000);
    frame.temp2mK = Float32Array.of(276.15, 278.15);
    frame.specificHumidity2mKgKg = Float32Array.of(0.004, 0.0045);
    frame.pressureLevelsHpa = [875, 450, 400];
    frame.hgtM = [
      Float32Array.of(1220, 1250),
      Float32Array.of(6150, 6280),
      Float32Array.of(7020, 7180),
    ];
    frame.tempK = [
      Float32Array.of(-12 + 273.15, -6 + 273.15),
      Float32Array.of(-34.406195 + 273.15, -21.0 + 273.15),
      Float32Array.of(-41.870703 + 273.15, -27.19 + 273.15),
    ];
    frame.missing.hgt = frame.hgtM.map(() => new Uint8Array(2));
    frame.missing.temp = frame.tempK.map(() => new Uint8Array(2));
    frame.rhReference = 'gfs-v16-mixed';
    frame.auxLevels = {
      spfhKgKg: [
        { values: Float32Array.of(NaN, NaN), missing: Uint8Array.of(1, 1) }, // 875 hPa secondary: SPFH absent
        { values: Float32Array.of(0.0002356488985, 0.0006), missing: Uint8Array.of(0, 0) },
        { values: Float32Array.of(0.0001077765628, 0.00078861), missing: Uint8Array.of(0, 0) },
      ],
      rhPercent: [
        { values: Float32Array.of(80, 75), missing: Uint8Array.of(0, 0) }, // 875 hPa secondary: RH present
        { values: Float32Array.of(NaN, NaN), missing: Uint8Array.of(1, 1) },
        { values: Float32Array.of(NaN, NaN), missing: Uint8Array.of(1, 1) },
      ],
    };
    const output = Uint8Array.of(0b11);
    const coverage = sparseCoverageFromDense({ ...grid, gridHash: 'b'.repeat(64), output, halo: new Uint8Array(1) });
    const reader = prepareNativeProfiles(frame, coverage);
    const cascades = readProfileRecord(reader.readRecord(0));
    expect(cascades.levels).toHaveLength(3);
    // 875 hPa secondary RH-only level preserves true vapor pressure from GFS v16 RH
    expect(saturationVaporPressureHpa(cascades.levels[0]!.dewPointC!)).toBeCloseTo(
      0.8 * gfsV16SaturationVaporPressureHpa(-12),
      2,
    );
    // 450 hPa & 400 hPa Cascades negative control within +-0.1% across packed boundary
    expect(Math.abs(effectiveCloudHumidityPercent(cascades.levels[1]!.temperatureC!, cascades.levels[1]!.dewPointC!) - 71.53)).toBeLessThanOrEqual(0.1);
    expect(Math.abs(effectiveCloudHumidityPercent(cascades.levels[2]!.temperatureC!, cascades.levels[2]!.dewPointC!) - 66.79)).toBeLessThanOrEqual(0.1);

    // Positive control (38.75°N, 78.25°W, 400 hPa): cold cloud evidence preserved across packed boundary
    const positive = readProfileRecord(reader.readRecord(1));
    expect(effectiveCloudHumidityPercent(positive.levels[2]!.temperatureC!, positive.levels[2]!.dewPointC!)).toBeGreaterThanOrEqual(99.5);
  });

  it('binds WRF definitions to the v3 contract strings', () => {
    const published = {
      capeParcelDefinition: contract.capeParcelDefinition,
      lowCloudDefinition: contract.lowCloudDefinition,
      precipitationField: 'precip_mm_hr',
      totalCloudField: 'cloud_total_pct',
      lowCloudField: 'cloud_low_pct',
      capeField: 'cape_jkg'
    };
    expect(() => assertWrfWeatherDefinitions('wrf-fixture', published)).not.toThrow();
    expect(() => assertWrfWeatherDefinitions('av-wrf', published)).not.toThrow();
    expect(() => assertWrfWeatherDefinitions('av-wrf', { ...published, capeParcelDefinition: 'other' })).toThrow(/CAPE/);
    expect(() => assertWrfWeatherDefinitions('av-wrf', { ...published, capeField: 'cape' })).toThrow(/CAPE/);
    expect(() => assertWrfWeatherDefinitions('av-wrf', { ...published, lowCloudField: 'cloud' })).toThrow(/low-cloud/);
  });
});
