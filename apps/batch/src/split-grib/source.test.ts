import { SPLIT_PRODUCT } from '../../../../tests/model-fixtures.js';
import { splitSource } from './source.js';
// Two native cells sit on output cells 0 and 1 (70.5N, 23.5W and 23.4375W).
const product = { ...SPLIT_PRODUCT, upstream: { ...SPLIT_PRODUCT.upstream, nativeGrid: { ...splitSource(SPLIT_PRODUCT).upstream.nativeGrid, pointCount: 2 } } as Record<string, unknown> };
const profile = splitSource(product);
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  coverageIndices,

  setBit,
  sparseCoverageFromDense,
  STATUS_MASK,
  STATUS_VALID,
  type CoverageMask
} from '@av/contracts';
import {
  deriveFrame,
  prepareShardedSamplePackLayout,
  resolveProductFrameHours,
  validateNormalizedFrame
} from '@av/forecast';
import { loadCoverage } from '../coverage.js';
import { assertForecastInputs } from '../capacity.js';
import { createNormalizedFrameTarget } from '../provider.js';
import { createSplitGribAcquisitionSession, recoverSplitGribFlux } from './acquire.js';
import { decodeSplitGribField } from './grib.js';
import { splitGribFieldUrl, verifySplitGribFieldMetadata } from './fields.js';
import { splitGribRunSentinelUrls } from './discover.js';

function request(url: string): { field: string; level: number | null; hour: number } {
  const match = /\/p\/([^/]+)(?:\/lvt1\/\d+\/lv1\/(\d+))?\/r\/[^/]+\/s\/PT(\d{3})H00M\.grib2$/.exec(new URL(url).pathname);
  if (!match) throw new Error(`Unexpected native field URL ${url}`);
  return { field: match[1]!, level: match[2] === undefined ? null : Number(match[2]), hour: Number(match[3]) };
}
const requests = (urls: readonly string[], field: string, hour?: number) =>
  urls.filter(url => { const item = request(url); return item.field === field && (hour === undefined || item.hour === hour); });
const cachePath = (cacheDir: string, url: string) =>
  join(cacheDir, 'objects', `${createHash('sha256').update(url).digest('hex').slice(0, 16)}-${url.split('/').at(-1)}`);

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

it('preserves east/north 10m and model winds', async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'av-icon-aux-'));
  tempDirs.push(cacheDir);
  const configured = splitSource({ ...product, layers: [...product.layers, 'cloud-cover-total', 'pbl-height-agl', 'wind-gust-10m', 'wind-10m-u', 'wind-10m-v'],
    capabilities: { ...product.capabilities, maxVerticalLevels: 2 },
    upstream: { ...product.upstream, modelLevels: [73, 74],
      auxSurface: { cloudTotalPct: { field: 'CLCT', kind: 'single-level', parameter: [6, 1], surface: [1, 0], unit: '%' },
        pblHeightM: { field: 'MH', kind: 'single-level', parameter: [19, 3], surface: [1, 0], unit: 'm' },
        gust10mMps: { field: 'VMAX_10M', kind: 'single-level', parameter: [2, 22], surface: [103, 10], statistic: 2, unit: 'm/s' },
        u10mMps: { field: 'U_10M', kind: 'single-level', parameter: [2, 2], surface: [103, 10], unit: 'm/s' },
        v10mMps: { field: 'V_10M', kind: 'single-level', parameter: [2, 3], surface: [103, 10], unit: 'm/s' } },
      auxLevels: {
        spfhKgKg: { field: 'QV', kind: 'model-level', parameter: [1, 0], surface: [150, null, 150], unit: 'kg/kg' },
        uWindMps: { field: 'U', kind: 'model-level', parameter: [2, 2], surface: [150, null, 150], unit: 'm/s' },
        vWindMps: { field: 'V', kind: 'model-level', parameter: [2, 3], surface: [150, null, 150], unit: 'm/s' }
      }
    } });
  const cycle = '2026-10-08T00:00:00Z', requested: string[] = [], baseFetch = syntheticFetch(cycle, requested);
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input), { field, hour, level } = request(url);
    if (!['QV', 'U', 'V', 'CLCT', 'MH', 'VMAX_10M', 'U_10M', 'V_10M'].includes(field)) return baseFetch(input, init);
    requested.push(url);
    const surface = level === null, gust = field === 'VMAX_10M';
    const spec = configured.specs[field]!;
    const zonal = field === 'U' || field === 'U_10M', meridional = field === 'V' || field === 'V_10M';
    const missing = hour === 5 && (field === 'V_10M' || (field === 'V' && level === 74));
    const bytes = buildSyntheticSplitGrib2({ referenceTimeIso: cycle,
      coordinateValueCount: surface ? 0 : 6,
      templateNumber: gust ? 8 : 0, statisticalProcess: gust ? 2 : undefined, startHour: hour - 1,
      parameterCategory: spec.parameterCategory, parameterNumber: spec.parameterNumber, hour,
      firstFixedSurfaceType: spec.firstFixedSurfaceType, firstFixedSurfaceValue: surface ? spec.firstFixedSurfaceValue : level,
      ...(surface ? {} : { secondFixedSurfaceType: 150, secondFixedSurfaceValue: level + 1 }),
      constantValue: field === 'QV' ? 0.005 : zonal ? 5 : meridional ? -2 : field === 'MH' ? 400 : gust ? 9.5 : 75,
      allMissing: missing,
      ...(meridional && !missing ? { overrides: { 0: 4 } } : {})
    });
    if (field === 'V_10M' && hour === 4) {
      const decoded = decodeSplitGribField(configured, bytes, Uint32Array.of(0, 1));
      expect(decoded.grid.kind).toBe('unstructured');
      expect([...decoded.values]).toEqual([4, -2]);
    }
    return new Response(Buffer.from(bytes));
  };
  const slot = createNormalizedFrameTarget(2, 2, true, false);
  const session = await createSplitGribAcquisitionSession(configured, { cycle, activeIndices: Uint32Array.of(0, 1), cacheDir, fetchImpl });
  try {
    const first = await session.acquire(4, slot);
    expect(first.auxSurface!.cloudTotalPct!.values[0]).toBe(75);
    expect(first.auxSurface!.pblHeightM!.values[0]).toBe(400);
    expect(first.auxSurface!.gust10mMps!.values[0]).toBe(9.5);
    expect(first.auxLevels!.spfhKgKg![0]!.values[0]).toBeCloseTo(0.005);
    expect([...first.auxSurface!.u10mMps!.values]).toEqual([5, 5]);
    expect([...first.auxSurface!.v10mMps!.values]).toEqual([4, -2]);
    expect(first.auxLevels!.uWindMps!.map(field => [...field!.values])).toEqual([[5, 5], [5, 5]]);
    expect(first.auxLevels!.vWindMps!.map(field => [...field!.values])).toEqual([[4, -2], [4, -2]]);
    expect(first.auxLevels!.spfhKgKg![0]!.values.buffer).toBeInstanceOf(SharedArrayBuffer);
    validateNormalizedFrame(first, first.activeIndices, configured.grid, 2, ['usable-lift-msl', 'usable-lift-agl'], 'model-levels');
    const second = await session.acquire(5, slot);
    expect(second.auxLevels!.spfhKgKg![0]!.values).toBe(first.auxLevels!.spfhKgKg![0]!.values);
    expect(second.auxSurface!.cloudTotalPct!.values).toBe(first.auxSurface!.cloudTotalPct!.values);
    for (const field of [second.auxSurface!.u10mMps!, second.auxSurface!.v10mMps!, second.auxLevels!.uWindMps![0]!, second.auxLevels!.vWindMps![0]!]) {
      expect([...field.missing]).toEqual([1, 1]);
      expect([...field.values]).toEqual([NaN, NaN]);
    }
    expect([...second.auxLevels!.vWindMps![1]!.values]).toEqual([4, -2]);
  } finally { await session.close(); }
});

const gribCache = new Map<string, Uint8Array>();
const shortProfile = splitSource({
  ...product,
  capabilities: { ...product.capabilities, maxVerticalLevels: 2 },
  upstream: { ...product.upstream, modelLevels: [73, 74] }
});

/**
 * Build a minimal valid single-field GRIB2 message on the fixture's native mesh (template 3.101).
 * Constant fields use zero-bit CCSDS; `overrides` switches to 8-bit simple packing.
 */
function buildSyntheticSplitGrib2(options: {
  discipline?: number;
  centre?: number;
  referenceTimeIso: string;
  allMissing?: boolean;
  coordinateValueCount?: number;
  templateNumber: 0 | 8;
  statisticalProcess?: 0 | 1 | 2;
  parameterCategory: number;
  parameterNumber: number;
  firstFixedSurfaceType: number;
  firstFixedSurfaceValue: number | null;
  secondFixedSurfaceType?: number;
  secondFixedSurfaceValue?: number | null;
  hour: number;
  startHour?: number;
  constantValue: number;
  overrides?: Readonly<Record<number, number>>;
  binaryScale?: number;
}): Uint8Array {
  const cacheKey = JSON.stringify(options);
  const cached = gribCache.get(cacheKey);
  if (cached) return cached;
  const native = profile.upstream.nativeGrid, pointCount = native.pointCount;
  const ref = new Date(options.referenceTimeIso);

  // Section 1 (21 bytes)
  const s1 = new Uint8Array(21);
  const v1 = new DataView(s1.buffer);
  v1.setUint32(0, 21, false);
  v1.setUint8(4, 1);
  v1.setUint16(5, options.centre ?? 78, false);
  v1.setUint16(7, 255, false);
  v1.setUint8(9, 19);
  v1.setUint8(10, 1);
  v1.setUint8(11, 1);
  v1.setUint16(12, ref.getUTCFullYear(), false);
  v1.setUint8(14, ref.getUTCMonth() + 1);
  v1.setUint8(15, ref.getUTCDate());
  v1.setUint8(16, ref.getUTCHours());
  v1.setUint8(17, ref.getUTCMinutes());
  v1.setUint8(18, ref.getUTCSeconds());
  v1.setUint8(19, 0);
  v1.setUint8(20, 1);

  // Section 3 (35 bytes, Template 3.101)
  const s3 = new Uint8Array(35);
  const v3 = new DataView(s3.buffer);
  v3.setUint32(0, 35, false);
  v3.setUint8(4, 3);
  v3.setUint32(6, pointCount, false);
  v3.setUint16(12, 101, false);
  v3.setUint8(14, 6); // Earth spherical radius 6,371,229 m
  v3.setUint16(15, Math.floor(native.number / 256), false);
  v3.setUint8(17, native.number % 256);
  v3.setUint8(18, 1);
  s3.set(Buffer.from(native.uuid, 'hex'), 19);

  // Section 4 (Template 4.0 = 34 bytes, Template 4.8 = 58 bytes)
  const s4Len = (options.templateNumber === 0 ? 34 : 58) + 4 * (options.coordinateValueCount ?? 0);
  const s4 = new Uint8Array(s4Len);
  const v4 = new DataView(s4.buffer);
  v4.setUint32(0, s4Len, false);
  v4.setUint8(4, 4);
  v4.setUint16(5, options.coordinateValueCount ?? 0, false);
  v4.setUint16(7, options.templateNumber, false);
  v4.setUint8(9, options.parameterCategory);
  v4.setUint8(10, options.parameterNumber);
  v4.setUint8(11, 2);
  v4.setUint8(17, 0); // minutes
  v4.setUint32(18, (options.templateNumber === 0 ? options.hour : options.startHour ?? 0) * 60, false);
  v4.setUint8(22, options.firstFixedSurfaceType);
  if (options.firstFixedSurfaceValue === null) {
    v4.setUint8(23, 0xff);
    v4.setUint32(24, 0xffffffff, false);
  } else {
    v4.setUint8(23, 0);
    v4.setUint32(24, options.firstFixedSurfaceValue, false);
  }
  const s2Type = options.secondFixedSurfaceType ?? 255;
  v4.setUint8(28, s2Type);
  if (options.secondFixedSurfaceValue === undefined || options.secondFixedSurfaceValue === null) {
    v4.setUint8(29, 0xff);
    v4.setUint32(30, 0xffffffff, false);
  } else {
    v4.setUint8(29, 0);
    v4.setUint32(30, options.secondFixedSurfaceValue, false);
  }
  if (options.templateNumber === 8) {
    const end = new Date(ref.getTime() + options.hour * 3_600_000);
    v4.setUint16(34, end.getUTCFullYear(), false);
    v4.setUint8(36, end.getUTCMonth() + 1);
    v4.setUint8(37, end.getUTCDate());
    v4.setUint8(38, end.getUTCHours());
    v4.setUint8(39, end.getUTCMinutes());
    v4.setUint8(40, end.getUTCSeconds());
    v4.setUint8(41, 1);
    v4.setUint32(42, 0, false);
    v4.setUint8(46, options.statisticalProcess ?? 0);
    v4.setUint8(47, 2);
    v4.setUint8(48, 0); // minutes
    v4.setUint32(49, (options.hour - (options.startHour ?? 0)) * 60, false);
  }

  const hasOverride = options.overrides !== undefined, binaryScale = options.binaryScale ?? 0;
  const s5Len = hasOverride ? 21 : 25;
  const s5 = new Uint8Array(s5Len);
  const v5 = new DataView(s5.buffer);
  v5.setUint32(0, s5Len, false);
  v5.setUint8(4, 5);
  v5.setUint32(5, options.allMissing ? 0 : pointCount, false);
  v5.setUint16(9, hasOverride ? 0 : 42, false);
  v5.setFloat32(11, options.constantValue, false);
  v5.setUint16(15, binaryScale < 0 ? 0x8000 | -binaryScale : binaryScale, false);
  v5.setUint16(17, 0, false);
  v5.setUint8(19, hasOverride ? 8 : 0);
  v5.setUint8(20, 0);
  if (!hasOverride) {
    v5.setUint8(21, 14);
    v5.setUint8(22, 32);
    v5.setUint16(23, 128, false);
  }

  const s6 = new Uint8Array(6 + (options.allMissing ? Math.ceil(pointCount / 8) : 0));
  new DataView(s6.buffer).setUint32(0, s6.length, false);
  s6[4] = 6;
  s6[5] = options.allMissing ? 0 : 255;

  // Section 7
  const payloadLen = hasOverride ? pointCount : 0;
  const s7 = new Uint8Array(5 + payloadLen);
  const v7 = new DataView(s7.buffer);
  v7.setUint32(0, s7.byteLength, false);
  v7.setUint8(4, 7);
  for (const [index, value] of Object.entries(options.overrides ?? {})) {
    s7[5 + Number(index)] = Math.round((value - options.constantValue) / 2 ** binaryScale);
  }

  const totalLen = 16 + s1.byteLength + s3.byteLength + s4.byteLength + s5.byteLength + s6.byteLength + s7.byteLength + 4;
  const out = new Uint8Array(totalLen);
  const vOut = new DataView(out.buffer);
  out.set([0x47, 0x52, 0x49, 0x42], 0); // "GRIB"
  vOut.setUint8(6, options.discipline ?? 0);
  vOut.setUint8(7, 2);
  vOut.setBigUint64(8, BigInt(totalLen), false);
  let offset = 16;
  for (const sec of [s1, s3, s4, s5, s6, s7]) {
    out.set(sec, offset);
    offset += sec.byteLength;
  }
  out.set([0x37, 0x37, 0x37, 0x37], offset); // "7777"
  gribCache.set(cacheKey, out);
  return out;
}

function syntheticFetch(cycle: string, requestedUrls: string[], resetHours?: number): typeof fetch {
  return async input => {
    const url = String(input);
    requestedUrls.push(url);
    const { field, hour, level } = request(url);
    const body = (bytes: Uint8Array): ArrayBuffer =>
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    if (field === 'CLAT' || field === 'CLON') {
      return new Response(
        body(buildSyntheticSplitGrib2({
          referenceTimeIso: cycle,
          templateNumber: 0,
          parameterCategory: 191,
          parameterNumber: field === 'CLAT' ? 1 : 2,
          firstFixedSurfaceType: 1,
          firstFixedSurfaceValue: 0,
          hour: 0,
          constantValue: field === 'CLAT' ? 70.5 : -23.5,
          ...(field === 'CLON' ? { overrides: { 1: -23.4375 }, binaryScale: -4 } : {})
        }))
      );
    }
    if (field === 'HSURF') {
      return new Response(
        body(buildSyntheticSplitGrib2({
          referenceTimeIso: cycle,
          templateNumber: 0,
          parameterCategory: 3,
          parameterNumber: 6,
          firstFixedSurfaceType: 1,
          firstFixedSurfaceValue: null,
          secondFixedSurfaceType: 101,
          hour: 0,
          constantValue: 1000
        }))
      );
    }
    if (field === 'HHL') {
      const height = 1000 + (75 - level!) * 200;
      return new Response(
        body(buildSyntheticSplitGrib2({
          referenceTimeIso: cycle,
          templateNumber: 0,
          parameterCategory: 3,
          parameterNumber: 6,
          firstFixedSurfaceType: 150,
          firstFixedSurfaceValue: level,
          secondFixedSurfaceType: 101,
          hour: 0,
          constantValue: height
        }))
      );
    }
    if ((field === 'T' || field === 'P') && level !== null) {
      const value =
        field === 'T'
          ? 290 - (74 - level) * 1.5 + hour * 0.1
          : 89000 - (74 - level) * 1500;
      return new Response(
        body(buildSyntheticSplitGrib2({
          referenceTimeIso: cycle,
          templateNumber: 0,
          parameterCategory: field === 'T' ? 0 : 3,
          parameterNumber: 0,
          firstFixedSurfaceType: 150,
          firstFixedSurfaceValue: level,
          secondFixedSurfaceType: 150,
          secondFixedSurfaceValue: level + 1,
          hour,
          constantValue: value
        }))
      );
    }
    if (['PS', 'T_2M', 'QV_2M', 'ASHFL_S', 'ALHFL_S'].includes(field)) {
      const specMap: Record<
        string,
        { t: 0 | 8; cat: number; num: number; s1: number; v1: number | null; val: number }
      > = {
        PS: { t: 0, cat: 3, num: 0, s1: 1, v1: null, val: 90000 },
        T_2M: { t: 0, cat: 0, num: 0, s1: 103, v1: 2, val: 295 + hour * 0.2 },
        QV_2M: { t: 0, cat: 1, num: 0, s1: 103, v1: 2, val: 0.008 },
        ASHFL_S: { t: 8, cat: 0, num: 11, s1: 1, v1: null, val: -150 - hour * 10 },
        ALHFL_S: { t: 8, cat: 0, num: 10, s1: 1, v1: null, val: -60 - hour * 5 }
      };
      const cfg = specMap[field]!;
      return new Response(
        body(buildSyntheticSplitGrib2({
          referenceTimeIso: cycle,
          templateNumber: cfg.t,
          startHour: resetHours === undefined ? 0 : Math.floor((hour - 1) / resetHours) * resetHours,
          parameterCategory: cfg.cat,
          parameterNumber: cfg.num,
          firstFixedSurfaceType: cfg.s1,
          firstFixedSurfaceValue: cfg.v1,
          hour,
          constantValue: cfg.val
        }))
      );
    }
    return new Response('not found', { status: 404 });
  };
}

it('recovers ICON precipitation intervals, retains raw companions and masks decreasing accumulations', async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'av-icon-precip-'));
  tempDirs.push(cacheDir);
  const cycle = '2026-10-08T00:00:00Z', requested: string[] = [];
  const configured = splitSource({ ...product, layers: ['usable-lift-msl', 'usable-lift-agl', 'precip-rate'],
    capabilities: { ...product.capabilities, maxVerticalLevels: 2 }, upstream: { ...product.upstream, modelLevels: [73, 74],
      fields: { ...(product.upstream.fields as object), precipitation: { field: 'TOT_PREC', kind: 'single-level', parameter: [1, 52], surface: [1, 0], statistic: 1 } }
    } });
  const baseFetch = syntheticFetch(cycle, requested);
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input), { field, hour } = request(url);
    if (field !== 'TOT_PREC') return baseFetch(input, init);
    requested.push(url);
    return new Response(Buffer.from(buildSyntheticSplitGrib2({ referenceTimeIso: cycle, templateNumber: 8,
      statisticalProcess: 1, parameterCategory: 1, parameterNumber: 52, firstFixedSurfaceType: 1, firstFixedSurfaceValue: 0,
      hour, constantValue: hour === 1 ? 2 : hour === 2 ? 5 : 4
    })));
  };
  expect(requests(splitGribRunSentinelUrls(configured, cycle), 'TOT_PREC')).toHaveLength(1);
  const session = await createSplitGribAcquisitionSession(configured, { cycle, activeIndices: Uint32Array.of(0), cacheDir, fetchImpl });
  const slot = createNormalizedFrameTarget(1, 2, true, true);
  try {
    const first = await session.acquire(1, slot);
    expect(first.precipitationMmPerHour![0]).toBe(2);
    expect(first.precipitationMmPerHour).toBe(slot.precipitationMmPerHour);
    first.precipitationMmPerHour![0] = 999;
    const second = await session.acquire(2, slot);
    expect(second.precipitationMmPerHour![0]).toBe(3);
    expect(second.intervals.precipitationWindow).toEqual({ start: '2026-10-08T01:00:00.000Z', end: '2026-10-08T02:00:00.000Z' });
    expect(second.intervals.precipitationSourceWindow!.start).toBe(cycle.replace('Z', '.000Z'));
    expect(requests(requested, 'TOT_PREC')).toHaveLength(2);
    validateNormalizedFrame(second, second.activeIndices, configured.grid, 2, configured.model.layers, 'model-levels');
    const third = await session.acquire(3, slot);
    expect(third.missing.precipitation![0]).toBe(1);
    expect(Number.isNaN(third.precipitationMmPerHour![0])).toBe(true);
  } finally { await session.close(); }
  expect(() => splitSource({ ...product, layers: ['precip-rate'], upstream: { ...product.upstream,
    fields: { ...(product.upstream.fields as object), precipitation: undefined } } })).toThrow('accumulation descriptor');
});

describe('DWD ICON-EU native adapter', () => {
  it('constructs canonical DWD Open Data URLs and sentinel probes', () => {
    const cycle = '2026-10-08T00:00:00Z', prefix = 'https://opendata.dwd.de/weather/nwp/v1/m/icon-eu/p/';
    expect(splitGribFieldUrl(profile, 'HSURF', cycle)).toBe(`${prefix}HSURF/r/2026-10-08T00%3A00/s/PT000H00M.grib2`);
    expect(splitGribFieldUrl(profile, 'HHL', cycle, { level: 75 })).toBe(`${prefix}HHL/lvt1/150/lv1/75/r/2026-10-08T00%3A00/s/PT000H00M.grib2`);
    expect(splitGribFieldUrl(profile, 'ASHFL_S', cycle, { hour: 6 })).toBe(`${prefix}ASHFL_S/r/2026-10-08T00%3A00/s/PT006H00M.grib2`);
    expect(splitGribFieldUrl(profile, 'T', cycle, { hour: 6, level: 74, baseUrl: 'http://mirror.test/dwd/' }))
      .toBe('http://mirror.test/dwd/T/lvt1/150/lv1/74/r/2026-10-08T00%3A00/s/PT006H00M.grib2');
    const sentinels = splitGribRunSentinelUrls(profile, cycle);
    expect(sentinels).toHaveLength(14);
  });

  it.each([
    ['multiple ranges', 41, 2],
    ['missing samples', 45, 1],
    ['different increment type', 47, 1],
    ['nonzero increment', 57, 1],
    ['unsupported increment unit', 53, 254],
    ['inconsistent start time', 21, 1],
    ['invalid end date', 36, 13],
    ['truncated coordinate values', 6, 1],
    ['wrong generating process', 11, 1]
  ] as const)('refuses statistical metadata with %s', (_label, byteOffset, value) => {
    const bytes = buildSyntheticSplitGrib2({ referenceTimeIso: '2026-10-08T00:00:00Z',
      templateNumber: 8, parameterCategory: 0, parameterNumber: 11,
      firstFixedSurfaceType: 1, firstFixedSurfaceValue: null, hour: 6, constantValue: -100 });
    bytes[16 + 21 + 35 + byteOffset] = value;
    expect(() => decodeSplitGribField(profile, bytes, Uint32Array.of(0))).toThrow();
  });

  it('accepts the six coordinate values carried by DWD model-level fields', () => {
    const cycle = '2026-10-08T00:00:00Z';
    const bytes = buildSyntheticSplitGrib2({ referenceTimeIso: cycle, coordinateValueCount: 6,
      templateNumber: 0, parameterCategory: 0, parameterNumber: 0,
      firstFixedSurfaceType: 150, firstFixedSurfaceValue: 74,
      secondFixedSurfaceType: 150, secondFixedSurfaceValue: 75, hour: 6, constantValue: 290 });
    const decoded = decodeSplitGribField(profile, bytes, Uint32Array.of(0));
    verifySplitGribFieldMetadata(profile, decoded, 'T', cycle, { hour: 6, level: 74 });
    expect(decoded.product.coordinateValueCount).toBe(6);
    expect(decoded.values[0]).toBe(290);
  });

  it('recovers configured flux signs and reset windows with matching frame provenance', async () => {
    const f1 = {
      values: new Float32Array([-80, 25, NaN]),
      missing: Uint8Array.of(0, 0, 1),
      product: {} as never
    };
    const r1 = recoverSplitGribFlux(profile, 'sensibleHeatFlux', f1, null, 1);
    expect(Array.from(r1.values.slice(0, 2))).toEqual([80, -25]);
    expect(Number.isNaN(r1.values[2]!)).toBe(true);
    expect(r1.missing).toEqual(Uint8Array.of(0, 0, 1));

    // At h=2, run-average 0..2h is -110 W/m² -> 2*(-110) - 1*(-80) = -140 downward = +140 upward W/m²
    const f2 = {
      values: new Float32Array([-110, 10, 0]),
      missing: Uint8Array.of(0, 0, 0),
      product: {} as never
    };
    const r2 = recoverSplitGribFlux(profile, 'sensibleHeatFlux', f2, f1, 2);
    expect(r2.values[0]).toBeCloseTo(140, 5);
    expect(r2.values[1]).toBeCloseTo(5, 5);
    expect(Number.isNaN(r2.values[2]!)).toBe(true);
    expect(r2.missing).toEqual(Uint8Array.of(0, 0, 1));

    const reset = splitSource({ ...profile.model, forecast: { ...profile.model.forecast, statisticsResetHours: 6 },
      upstream: { ...profile.upstream, fields: { ...profile.upstream.fields,
        sensibleHeatFlux: { ...profile.upstream.fields.sensibleHeatFlux, scale: 1 } } } });
    expect([...recoverSplitGribFlux(reset, 'sensibleHeatFlux', f1, null, 7).values.slice(0, 2)]).toEqual([-80, 25]);
    expect([...recoverSplitGribFlux(reset, 'sensibleHeatFlux', f2, f1, 8).values.slice(0, 2)]).toEqual([-140, -5]);
    const cacheDir = await mkdtemp(join(tmpdir(), 'av-split-reset-')), cycle = '2026-10-08T00:00:00Z';
    tempDirs.push(cacheDir);
    const session = await createSplitGribAcquisitionSession(reset, {
      cycle, activeIndices: Uint32Array.of(0), cacheDir, fetchImpl: syntheticFetch(cycle, [], 6)
    });
    try {
      for (const hour of [7, 8]) {
        const frame = await session.acquire(hour);
        expect(frame.intervals.fluxSourceWindow!.start).toBe('2026-10-08T06:00:00.000Z');
        expect(frame.intervals.usedCompanion).toBe(hour === 8);
        expect(frame.sensibleHeatFluxWm2[0]).toBe(hour === 7 ? -220 : -240);
      }
    } finally { await session.close(); }
  });

  it('caches static HSURF/HHL across forecast hours, fetches T/P per hour, and fetches preceding-hour flux companions', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'av-icon-session-'));
    tempDirs.push(cacheDir);
    const cycle = '2026-10-08T00:00:00Z';
    const requestedUrls: string[] = [];

    const fetchStub = syntheticFetch(cycle, requestedUrls);

    const active = Uint32Array.of(0, 1);
    const session = await createSplitGribAcquisitionSession(profile, {
      cycle,
      activeIndices: active,
      cacheDir,
      fetchImpl: fetchStub
    });

    // Acquire hour 4 first (simulating first daylight hour of the run -> must fetch f003 flux companions)
    const frame4 = await session.acquire(4);
    const target = createNormalizedFrameTarget(active.length, profile.modelLevels.length, true, false);
    const direct = await session.acquire(4, target);
    for (const field of ['terrainM', 'surfacePressurePa', 'temp2mK', 'specificHumidity2mKgKg', 'sensibleHeatFluxWm2', 'latentHeatFluxWm2'] as const) {
      expect(direct[field]).toBe(target[field]); expect(direct[field]).toEqual(frame4[field]);
    }
    for (const field of ['hgtM', 'tempK', 'pressurePa'] as const) for (let i = 0; i < profile.modelLevels.length; i++) {
      expect(direct[field][i]).toBe(target[field]![i]); expect(direct[field][i]).toEqual(frame4[field][i]);
    }
    expect(direct.missing).toEqual(frame4.missing);
    validateNormalizedFrame(
      frame4,
      active,
      profile.grid,
      profile.modelLevels.length,
      profile.model.layers
    );
    expect(frame4.precipitationMmPerHour).toBeUndefined();
    expect(frame4.pressureLevelsHpa).toBeUndefined();
    expect(frame4.pressurePa).toHaveLength(30);
    expect(frame4.hgtM[0]![0]).toBe(1100); // midpoint of HHL[74]=1200 and HHL[75]=1000
    expect(frame4.intervals.usedCompanion).toBe(true);
    // f004 ASHFL_S = -190, f003 ASHFL_S = -180 -> -(4*-190 - 3*-180) = -(-760 + 540) = +220 W/m²
    expect(frame4.sensibleHeatFluxWm2[0]).toBeCloseTo(220, 5);

    for (const field of ['CLAT', 'CLON', 'HSURF']) expect(requests(requestedUrls, field)).toHaveLength(1);
    expect(requests(requestedUrls, 'HHL')).toHaveLength(profile.halfLevels.length);
    expect(requests(requestedUrls, 'ASHFL_S', 3)).toHaveLength(1);

    // Acquire hour 5 next: static HSURF/HHL and f004 flux companions must be reused from memory,
    // while f005 T and P model levels are freshly acquired!
    const frame5 = await session.acquire(5);
    for (const field of ['CLAT', 'CLON', 'HSURF']) expect(requests(requestedUrls, field)).toHaveLength(1);
    expect(requests(requestedUrls, 'HHL')).toHaveLength(profile.halfLevels.length);
    expect(requests(requestedUrls, 'ASHFL_S', 4)).toHaveLength(1);
    expect(frame5.tempK[0]![0]).toBeCloseTo(290.5, 4);
    expect(frame4.tempK[0]![0]).toBeCloseTo(290.4, 4);

    // Discard disk flux objects, then jump to an earlier frame. Older decoded pairs
    // must have been released; the last completed pair alone remains reusable.
    for (const field of ['ASHFL_S', 'ALHFL_S']) for (const hour of [3, 4, 5]) {
      await rm(cachePath(cacheDir, splitGribFieldUrl(profile, field, cycle, { hour })));
    }
    await session.acquire(4);
    expect(requests(requestedUrls, 'ASHFL_S', 3)).toHaveLength(2);
    expect(requests(requestedUrls, 'ASHFL_S', 4)).toHaveLength(2);

    // Derive the lift-only ICON-EU frame and verify per-column pressure screening works
    const maskBytes = Math.ceil((profile.grid.width * profile.grid.height) / 8);
    const mask: CoverageMask = {
      grid: profile.grid,
      bounds: profile.model.bounds,
      output: new Uint8Array(maskBytes),
      halo: new Uint8Array(maskBytes),
      tiles: Uint8Array.of(1),
      maxZoom: 0
    };
    setBit(mask.output, 0);
    setBit(mask.halo, 1);
    const fields = deriveFrame(frame4, mask, {
      layers: profile.model.layers,
      daylightOnly: false
    });
    expect(fields['precip-rate']).toBeUndefined();
    expect(fields['usable-lift-msl']!.flags[0] & STATUS_MASK).toBe(STATUS_VALID);
    expect(fields['usable-lift-agl']!.flags[0] & STATUS_MASK).toBe(STATUS_VALID);
    await session.close();
  });

  it.each(['decode', 'metadata'])('replaces cached objects that fail %s validation', async kind => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'av-icon-repair-'));
    tempDirs.push(cacheDir);
    const cycle = '2026-10-08T00:00:00Z', requested: string[] = [];
    const good = syntheticFetch(cycle, requested);
    const invalid = kind === 'decode' ? Uint8Array.of(1, 2, 3) : buildSyntheticSplitGrib2({
      centre: 79, referenceTimeIso: cycle, templateNumber: 0, parameterCategory: 3,
      parameterNumber: 6, firstFixedSurfaceType: 1, firstFixedSurfaceValue: null,
      secondFixedSurfaceType: 101, hour: 0, constantValue: 1000
    });
    let attempts = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      if (request(String(input)).field === 'HSURF') attempts++;
      return good(input, init);
    };
    const options = { cycle, activeIndices: Uint32Array.of(0), cacheDir, fetchImpl };
    const first = await createSplitGribAcquisitionSession(shortProfile, options);
    await first.acquire(4);
    expect(attempts).toBe(1);
    expect(first.stats.retries).toBe(0);
    await first.close();

    await writeFile(cachePath(cacheDir, splitGribFieldUrl(shortProfile, 'HSURF', cycle)), invalid);
    const second = await createSplitGribAcquisitionSession(shortProfile, options);
    await second.acquire(5);
    expect(attempts).toBe(2);
    expect(second.stats.cacheHits).toBeGreaterThan(0);
    await second.close();
  });

  it('does not retry or cache a response that fails GRIB validation', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'av-icon-invalid-'));
    tempDirs.push(cacheDir);
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('invalid GRIB'));
    const session = await createSplitGribAcquisitionSession(shortProfile, { cycle: '2026-10-08T00:00:00Z', activeIndices: Uint32Array.of(0), cacheDir, fetchImpl });
    await expect(session.acquire(4)).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(await readdir(cacheDir)).toEqual([]);
    await session.close();
  });

  it('shares three attempts across a transient HTTP error and an interrupted body', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'av-icon-retry-')), cycle = '2026-10-08T00:00:00Z';
    tempDirs.push(cacheDir);
    const good = syntheticFetch(cycle, []);
    const fetchImpl = vi.fn(good).mockResolvedValueOnce(new Response('busy', { status: 503 }))
      .mockResolvedValueOnce(new Response(new ReadableStream({ start(controller) { controller.error(new TypeError('connection reset')); } })));
    const session = await createSplitGribAcquisitionSession(shortProfile, { cycle, activeIndices: Uint32Array.of(0), cacheDir, fetchImpl });
    try {
      await session.acquire(4);
      expect(session.stats.retries).toBe(2);
      expect(fetchImpl.mock.calls.slice(0, 3).map(([url]) => url)).toEqual(Array(3).fill(fetchImpl.mock.calls[0][0]));
    } finally { await session.close(); }
  });

  it('fails a permanent HTTP status once and preserves an unrelated cache filesystem error', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'av-icon-permanent-')), cycle = '2026-10-08T00:00:00Z';
    tempDirs.push(cacheDir);
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('missing', { status: 404 }));
    const options = { cycle, activeIndices: Uint32Array.of(0), cacheDir, fetchImpl };
    const missing = await createSplitGribAcquisitionSession(shortProfile, options);
    try {
      await expect(missing.acquire(4)).rejects.toThrow('HTTP 404');
      expect(fetchImpl).toHaveBeenCalledOnce();
    } finally { await missing.close(); }

    await writeFile(join(cacheDir, 'objects'), 'unexpected cache file');
    const inaccessible = await createSplitGribAcquisitionSession(shortProfile, options);
    try {
      await expect(inaccessible.acquire(4)).rejects.toMatchObject({ code: 'ENOTDIR' });
      expect(fetchImpl).toHaveBeenCalledOnce();
      expect(readFileSync(join(cacheDir, 'objects'), 'utf8')).toBe('unexpected cache file');
    } finally { await inaccessible.close(); }
  });

  it('shares one concurrency bound across surface, temperature and pressure downloads', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'av-icon-concurrent-'));
    tempDirs.push(cacheDir);
    const cycle = '2026-10-08T00:00:00Z', good = syntheticFetch(cycle, []);
    let active = 0, peak = 0;
    let release = () => {}, reachedLimit = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    const occupied = new Promise<void>(resolve => { reachedLimit = resolve; });
    const fetchImpl: typeof fetch = async (input, init) => {
      peak = Math.max(peak, ++active);
      try {
        if (request(String(input)).hour > 0) {
          if (active === 2) reachedLimit();
          await gate;
        }
        return await good(input, init);
      } finally { active--; }
    };
    const options = { cycle, activeIndices: Uint32Array.of(0), cacheDir, fetchImpl, concurrency: 2 };
    const session = await createSplitGribAcquisitionSession(shortProfile, options);
    const frame = session.acquire(4);
    await expect(session.acquire(5)).rejects.toThrow('active frame');
    await occupied;
    expect(active).toBe(2);
    release();
    await frame;
    expect(peak).toBe(2);
    expect(active).toBe(0);
    await session.close();
    for (const concurrency of [0, 1.5, 9, NaN]) {
      await expect(createSplitGribAcquisitionSession(shortProfile, { ...options, concurrency })).rejects.toThrow('concurrency');
    }
  });

  it('rejects unconfigured output hours before fetching or caching any objects', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'av-icon-hours-'));
    tempDirs.push(cacheDir);
    const fetchImpl = vi.fn<typeof fetch>(async () => { throw new Error('Unexpected download'); });
    const session = await createSplitGribAcquisitionSession(profile, { cycle: '2026-10-08T00:00:00Z', activeIndices: Uint32Array.of(0), cacheDir, fetchImpl });
    try {
      for (const hour of [0, -1, 1.5, NaN, Infinity, profile.model.frameHours.at(-1)! + 1]) {
        await expect(session.acquire(hour)).rejects.toThrow('Unsupported Split GRIB forecast hour');
      }
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(await readdir(cacheDir)).toEqual([]);
    } finally { await session.close(); }
  });

  it('rejects invalid active indices before run discovery', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'av-icon-indices-'));
    tempDirs.push(cacheDir);
    const fetchImpl = vi.fn<typeof fetch>(async () => { throw new Error('Unexpected discovery'); });
    for (const activeIndices of [new Uint32Array(), Uint32Array.of(profile.grid.width * profile.grid.height), Uint32Array.of(0, 0), [0] as unknown as Uint32Array]) {
      await expect(createSplitGribAcquisitionSession(profile, { activeIndices, cacheDir, fetchImpl })).rejects.toThrow(/activeIndices|active index/);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('pins requested cells and isolates returned frame geometry from caller mutations', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'av-icon-frame-ownership-'));
    tempDirs.push(cacheDir);
    const cycle = '2026-10-08T00:00:00Z', requested: string[] = [];
    const baseFetch = syntheticFetch(cycle, requested);
    const fetchImpl: typeof fetch = async (input, init) => {
      const { field, hour } = request(String(input));
      if (field !== 'T_2M') return baseFetch(input, init);
      return new Response(Buffer.from(buildSyntheticSplitGrib2({
        referenceTimeIso: cycle, templateNumber: 0, parameterCategory: 0, parameterNumber: 0,
        firstFixedSurfaceType: 103, firstFixedSurfaceValue: 2, hour, constantValue: 280,
        overrides: { 0: 300 }
      })));
    };
    const activeIndices = Uint32Array.of(0);
    const session = await createSplitGribAcquisitionSession(profile, { cycle, activeIndices, cacheDir, fetchImpl });
    try {
      const first = await session.acquire(4);
      expect(first.temp2mK[0]).toBe(300);
      activeIndices[0] = 1;
      first.activeIndices[0] = 2;
      first.terrainM[0] = -999;
      first.hgtM[0][0] = -888;
      first.hgtM[1] = Float32Array.of(-777);
      first.missing.terrain[0] = 1;
      first.missing.hgt[0][0] = 1;
      first.missing.hgt[1] = Uint8Array.of(1);
      const second = await session.acquire(5);
      expect([...second.activeIndices]).toEqual([0]);
      expect(second.temp2mK[0]).toBe(300);
      expect(second.terrainM[0]).toBe(1000);
      expect(second.hgtM[0][0]).toBe(1100);
      expect(second.hgtM[1][0]).toBe(1300);
      expect(second.missing.terrain[0]).toBe(0);
      expect(second.missing.hgt.slice(0, 2).map(level => level[0])).toEqual([0, 0]);
      expect(requests(requested, 'HSURF')).toHaveLength(1);
      expect(requests(requested, 'HHL')).toHaveLength(profile.halfLevels.length);
    } finally { await session.close(); }
  });

  it('keeps closed sessions closed without starting new downloads', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'av-icon-closed-'));
    tempDirs.push(cacheDir);
    const fetchImpl = vi.fn<typeof fetch>(async () => { throw new Error('Unexpected download'); });
    const session = await createSplitGribAcquisitionSession(profile, { cycle: '2026-10-08T00:00:00Z', activeIndices: Uint32Array.of(0), cacheDir, fetchImpl });
    await session.close();
    await session.close();
    await expect(session.acquire(4)).rejects.toThrow('session is closed');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each(['close', 'external abort'])('drains an active download after %s before close resolves', async mode => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'av-icon-close-active-'));
    tempDirs.push(cacheDir);
    const controller = new AbortController();
    const reason = mode === 'close' ? 'session is closed' : 'Cancelled externally';
    let started = () => {}, aborted = () => {}, release = () => {};
    const fetching = new Promise<void>(resolve => { started = resolve; });
    const cancelled = new Promise<void>(resolve => { aborted = resolve; });
    const drain = new Promise<void>(resolve => { release = resolve; });
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      const signal = init!.signal!;
      started();
      await new Promise<void>(resolve => signal.addEventListener('abort', () => { aborted(); resolve(); }, { once: true }));
      await drain;
      signal.throwIfAborted();
      throw new Error('Expected cancellation');
    });
    const session = await createSplitGribAcquisitionSession(profile, { cycle: '2026-10-08T00:00:00Z', activeIndices: Uint32Array.of(0), cacheDir, fetchImpl, signal: controller.signal });
    const acquisition = expect(session.acquire(4)).rejects.toThrow(reason);
    await fetching;
    let closed = false;
    if (mode === 'external abort') controller.abort(new Error(reason));
    const closing = session.close().then(() => { closed = true; });
    await cancelled;
    expect(closed).toBe(false);
    await expect(session.acquire(5)).rejects.toThrow(reason);
    release();
    await Promise.all([closing, acquisition]);
    expect(closed).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(await readdir(cacheDir)).toEqual([]);
    await session.close();
  });

  it.each(['declared', 'streamed'])('rejects and cancels an oversized %s download before caching it', async kind => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'av-icon-oversize-'));
    tempDirs.push(cacheDir);
    const cancel = vi.fn();
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)); },
      cancel
    }), { headers: kind === 'declared' ? { 'content-length': String(8 * 1024 * 1024 + 1) } : undefined }));
    const session = await createSplitGribAcquisitionSession(profile, { cycle: '2026-10-08T00:00:00Z', activeIndices: Uint32Array.of(0), cacheDir, fetchImpl });
    await expect(session.acquire(4)).rejects.toThrow('byte length');
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
    expect(await readdir(cacheDir)).toEqual([]);
    await session.close();
  });

  it('loads the bundled icon-eu-land-v1 coverage mask, passes build admission, and filters dark regional hours before acquisition', async () => {
    const mask = await loadCoverage(profile.model);
    const indices = coverageIndices(mask);
    const sparse = sparseCoverageFromDense({ width: mask.grid.width, height: mask.grid.height, wrapLongitude: mask.grid.wrapLongitude, gridHash: 'a'.repeat(64), output: mask.output, halo: mask.halo });
    const layout = prepareShardedSamplePackLayout(mask.grid, sparse.blockIds, 1);
    expect(indices.output.length).toBe(399913);
    expect(indices.active.length).toBe(409684);
    expect(layout.storedCells).toBe(528650);

    const regionalProduct = { ...profile.model, capabilities: { ...profile.model.capabilities, daylightFrames: 'regional-daylight' as const } };
    const daylightHours = resolveProductFrameHours(
      regionalProduct,
      mask,
      '2026-10-08T00:00:00Z',
      { outputIndices: indices.output }
    );
    // Night hours over Europe (00..01 UTC and 19..24 UTC in October) are omitted before acquisition
    expect(daylightHours).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);

    expect(() => assertForecastInputs(mask, regionalProduct)).not.toThrow();
  });
});
