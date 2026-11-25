import { sourceIntervalHours } from '@av/contracts';
import type { SplitSource } from './source.js';
import { sourceCycle, sourceCycleParts, sourceUrl, sourceWindowStart } from '../source.js';
import type { DecodedSplitGribField } from './grib.js';

export function validateSplitGribCycle(source: SplitSource, cycleIso: string): string {
  return sourceCycle(cycleIso, source.model.forecast.cycleHoursUtc);
}

export function formatSplitGribRunStamp(source: SplitSource, cycleIso: string): string {
  const normalized = validateSplitGribCycle(source, cycleIso);
  return normalized.slice(0, 13).replace(/[-T]/g, '');
}

/** Construct a configured field URL, including native-grid and isobaric vertical selectors. */
export function splitGribFieldUrl(source: SplitSource,
  field: string,
  cycleIso: string,
  options: {
    readonly hour?: number;
    readonly level?: number | null;
    readonly baseUrl?: string;
  } = {}
): string {
  const spec = (Object.hasOwn(source.specs, field) ? source.specs[field] : undefined);
  if (!spec) {
    throw new Error(`Unsupported Split GRIB field ${field}`);
  }
  const level = options.level;
  const isHalfLevel = source.upstream.fields.halfLevelHeight !== undefined && field === source.upstream.fields.halfLevelHeight.field;
  const levelRequired = spec.kind === 'model-level' || spec.kind === 'isobaric-level' || isHalfLevel;
  if (spec.kind === 'isobaric-level') {
    if (!Number.isInteger(level) || !source.pressureLevelsHpa.includes(level!)) throw new Error('Invalid source vertical level');
  } else if (levelRequired && (!Number.isInteger(level) || level! < 1 || level! > (spec.kind === 'model-level' ? source.modelLevels[0]! : source.halfLevels.at(-1)!))) {
    throw new Error('Invalid source vertical level');
  }
  const hour = options.hour ?? 0;
  if (!Number.isInteger(hour) || hour < 0 || hour > 120) throw new Error(`Source forecast hour out of range: ${hour}`);
  const normalizedCycle = validateSplitGribCycle(source, cycleIso);
  let template = source.upstream.urlTemplate;
  if (options.baseUrl) {
    const suffixIndex = template.includes('/{field}') ? template.indexOf('/{field}') : template.indexOf('/{date}');
    template = options.baseUrl.replace(/\/+$/, '') + (suffixIndex >= 0 ? template.slice(suffixIndex) : '');
  }
  const levelPath = spec.kind === 'isobaric-level'
    ? `_ISBL_${String(level).padStart(4, '0')}`
    : levelRequired
      ? `/lvt1/${spec.firstFixedSurfaceType}/lv1/${level}`
      : '';
  return sourceUrl(template, {
    ...sourceCycleParts(normalizedCycle),
    field,
    levelPath,
    referenceTime: normalizedCycle.slice(0, 16).replace(':', '%3A'),
    forecastHour: String(spec.kind === 'time-invariant' ? 0 : hour).padStart(3, '0')
  });
}

/**
 * Verify that a decoded Split GRIB GRIB2 field matches the expected run cycle, centre,
 * parameter identity, vertical level, and forecast time window. Mesh identity is checked at decode.
 */
export function verifySplitGribFieldMetadata(source: SplitSource,
  decoded: DecodedSplitGribField,
  field: string,
  cycleIso: string,
  options: { readonly hour?: number; readonly level?: number | null } = {}
): void {
  const spec = (Object.hasOwn(source.specs, field) ? source.specs[field] : undefined);
  if (!spec) {
    throw new Error(`Unsupported Split GRIB field ${field}`);
  }
  const cycleMs = Date.parse(validateSplitGribCycle(source, cycleIso));
  const id = decoded.identification;
  const actualRefMs = Date.UTC(id.year, id.month - 1, id.day, id.hour, id.minute, id.second);
  if (actualRefMs !== cycleMs) {
    throw new Error(
      `Split GRIB ${field} reference time mismatch: expected ${new Date(cycleMs).toISOString()}, got ${new Date(actualRefMs).toISOString()}`
    );
  }
  if (decoded.identification.centre !== source.upstream.centre) {
    throw new Error(`Split GRIB ${field} unexpected originating centre ${decoded.identification.centre} (expected ${source.upstream.centre})`);
  }
  const p = decoded.product;
  if (
    decoded.discipline !== spec.discipline ||
    p.parameterCategory !== spec.parameterCategory ||
    p.parameterNumber !== spec.parameterNumber ||
    p.templateNumber !== spec.templateNumber ||
    p.firstFixedSurfaceType !== spec.firstFixedSurfaceType ||
    p.secondFixedSurfaceType !== spec.secondFixedSurfaceType
  ) {
    throw new Error(
      `Split GRIB ${field} GRIB2 parameter/template mismatch: got d=${decoded.discipline} c=${p.parameterCategory} n=${p.parameterNumber} t=4.${p.templateNumber} s1=${p.firstFixedSurfaceType} s2=${p.secondFixedSurfaceType}`
    );
  }

  const expectedHour = spec.kind === 'time-invariant' ? 0 : (options.hour ?? 0);
  if (spec.templateNumber === 0) {
    if (Math.abs(p.endHour - expectedHour) > 1e-6) {
      throw new Error(
        `Split GRIB ${field} forecast hour mismatch: expected f${expectedHour}, got f${p.endHour}`
      );
    }
  } else {
    const startHour = spec.statisticalProcessCode === 2 ? expectedHour - sourceIntervalHours(source.model.forecast, expectedHour) : sourceWindowStart(source.model.forecast, expectedHour);
    if (
      p.statisticalProcessCode !== spec.statisticalProcessCode ||
      Math.abs(p.startHour - startHour) > 1e-6 ||
      Math.abs(p.endHour - expectedHour) > 1e-6
    ) {
      throw new Error(
        `Split GRIB ${field} statistical interval mismatch: expected ${startHour}..${expectedHour}h (process ${spec.statisticalProcessCode}), got ${p.startHour}..${p.endHour}h (process ${p.statisticalProcessCode})`
      );
    }
  }

  if (spec.firstFixedSurfaceValue !== null && p.firstFixedSurfaceValue !== spec.firstFixedSurfaceValue) {
    throw new Error(
      `Split GRIB ${field} fixed surface value mismatch: expected ${spec.firstFixedSurfaceValue}, got ${String(p.firstFixedSurfaceValue)}`
    );
  }
  if (spec.secondFixedSurfaceValue !== undefined && p.secondFixedSurfaceValue !== spec.secondFixedSurfaceValue) {
    throw new Error(`Split GRIB ${field} second fixed surface value mismatch`);
  }

  if (options.level !== undefined && options.level !== null) {
    const expectedSurfaceValue = spec.kind === 'isobaric-level' ? options.level * 100 : options.level;
    if (p.firstFixedSurfaceValue !== expectedSurfaceValue) {
      throw new Error(
        `Split GRIB ${field} model level mismatch: expected ${expectedSurfaceValue}, got ${String(p.firstFixedSurfaceValue)}`
      );
    }
    if (spec.kind === 'model-level' && p.secondFixedSurfaceValue !== options.level + 1) {
      throw new Error(
        `Split GRIB ${field} lower half-level mismatch: expected ${options.level + 1}, got ${String(p.secondFixedSurfaceValue)}`
      );
    }
  }
}
