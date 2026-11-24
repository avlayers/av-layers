// Vertical altitude/pressure scale construction and screen-coordinate transforms
// for Windgram charts.

import { windFromComponents } from '@av/soaring';
import type { SiteForecast } from './internal-meteo.ts';
import {
  classifyConvectiveCloudRegime,
  omegaToVerticalVelocityMps,
  WAVE_ASCENT_MIN_MPS,
  WAVE_MIN_WIND_KT,
} from './windgram-atmosphere.ts';
import { finiteScalar, mpsToKnots } from './windgram-format.ts';
import { median } from './windgram-time-axis.ts';

export interface HeightAnchor {
  heightM: number;
  y: number;
  pressureHpa: number | null;
}

export interface WindgramScale {
  anchors: readonly HeightAnchor[];
  top: number;
  bottom: number;
  floorM: number;
  topM: number;
}

const ICON_ISOBAR_TICKS_HPA = [
  1000, 975, 950, 925, 900, 875, 850, 800, 750, 700, 650,
  600, 550, 500, 450, 400, 350, 300, 250, 200, 150, 100,
] as const;

export function heightToY(view: WindgramScale, heightM: number): number {
  const anchors = view.anchors;
  if (heightM <= view.floorM) return view.bottom;
  if (heightM >= view.topM) return view.top;
  for (let i = 1; i < anchors.length; i++) {
    const a = anchors[i - 1], b = anchors[i];
    if (heightM <= b.heightM) return a.y + (b.y - a.y) * (heightM - a.heightM) / (b.heightM - a.heightM);
  }
  return view.top;
}

export function yToHeight(view: WindgramScale, y: number): number {
  if (y >= view.bottom) return view.floorM;
  if (y <= view.top) return view.topM;
  for (let i = 1; i < view.anchors.length; i++) {
    const a = view.anchors[i - 1], b = view.anchors[i];
    if (y >= b.y) return a.heightM + (b.heightM - a.heightM) * (a.y - y) / (a.y - b.y);
  }
  return view.topM;
}

/** Compare with the last retained label so dense profiles still have an axis. */
export function visibleHeightAnchors(
  view: { anchors: readonly HeightAnchor[]; top: number; compact: boolean },
): HeightAnchor[] {
  const minimumGap = view.compact ? 23 : 29;
  const selected: HeightAnchor[] = [];
  for (const anchor of view.anchors) {
    const previous = selected.at(-1);
    if (!previous || (anchor.y - view.top > 20 && previous.y - anchor.y >= minimumGap)) selected.push(anchor);
  }
  return selected;
}

/**
 * Builds the vertical height scale and anchors for a full profile or a soaring band.
 * Screen position follows elevation, so equal height steps stay equal on the axis.
 */
export function buildWindgramVerticalScale(
  profile: SiteForecast,
  hours: readonly SiteForecast['hours'][number][],
  options: {
    compact: boolean;
    heightRange?: 'soaring' | 'full';
    top: number;
    bottom: number;
    plotHeight: number;
  },
): {
  floorM: number;
  topM: number;
  anchors: HeightAnchor[];
} {
  const { compact, top, bottom, plotHeight } = options;
  const known = (values: (number | null)[]) => values.filter((value): value is number => value !== null);
  const grounds = known(hours.map(hour => hour.modelTerrainM));
  const fineTerrain = known(hours.map(hour => hour.fineTerrainM ?? null));
  const liftTops = known(hours.map(hour => hour.mapLift.mslM));
  const nativeLiftTops = known(hours.map(hour => hour.nativeUsableLiftTopM ?? null));
  const waveTops = known(
    hours.flatMap(hour => {
      const precip = finiteScalar(hour.surface.precipitationMmHr);
      if (precip !== null && precip >= 0.08) return [];
      return hour.levels.map(l => {
        if (l.omegaPaS === null || !Number.isFinite(l.omegaPaS)) return null;
        if (l.heightM === null || !Number.isFinite(l.heightM) || l.heightM > 7500) return null;
        const w = omegaToVerticalVelocityMps(l.omegaPaS, l.temperatureC, l.pressureHpa, l.heightM);
        if (w === null || w < WAVE_ASCENT_MIN_MPS) return null;
        const wind = windFromComponents(finiteScalar(l.uWindMps), finiteScalar(l.vWindMps));
        const speedKt = wind.speedMps === null ? null : mpsToKnots(wind.speedMps);
        if (speedKt !== null && speedKt < WAVE_MIN_WIND_KT) return null;
        return l.heightM;
      });
    }),
  );
  const heights = known(hours.flatMap(hour => hour.levels.map(level => level.heightM)));
  const referenceHeights = [...grounds, ...fineTerrain, ...heights, ...liftTops, ...nativeLiftTops];
  // Anchor chart floor at real site ground when known (clipping underground air below site ground);
  // otherwise anchor at native model ground, adding 50 m room only for sub-ground or isolated ceilings.
  const floorM = fineTerrain.length
    ? Math.min(...fineTerrain, ...liftTops.filter(h => h < Math.min(...fineTerrain)).map(h => h - 25))
    : grounds.length
      ? Math.min(...grounds, ...liftTops.filter(h => h < Math.min(...grounds) + 50).map(h => h - 50))
      : referenceHeights.length
        ? Math.min(...referenceHeights, ...liftTops.map(height => height - 50))
        : 0;
  const focused = options.heightRange === 'soaring' || (compact && options.heightRange !== 'full');
  const grouped = new Map<number, number[]>();
  const pushGroup = (p: number, z: number) => {
    const zs = grouped.get(p);
    if (zs) zs.push(z);
    else grouped.set(p, [z]);
  };

  if (profile.model === 'icon-eu') {
    // Native hybrid pressures change with each forecast hour. Fixed isobar ticks
    // keep the display scale independent of that changing pressure inventory.
    for (const hour of hours) {
      const levels = hour.levels
        .map(level => ({ p: finiteScalar(level.pressureHpa), z: finiteScalar(level.heightM) }))
        .filter((level): level is { p: number; z: number } => level.p !== null && level.p > 0 && level.z !== null)
        .sort((a, b) => a.z - b.z);
      for (const p of ICON_ISOBAR_TICKS_HPA) {
        for (let i = 1; i < levels.length; i++) {
          const a = levels[i - 1], b = levels[i];
          if (a.p <= b.p || p > a.p || p < b.p) continue;
          const fraction = (Math.log(p) - Math.log(a.p)) / (Math.log(b.p) - Math.log(a.p));
          const z = a.z + fraction * (b.z - a.z);
          if (z > (hour.modelTerrainM ?? floorM) + 5) pushGroup(p, z);
          break;
        }
      }
    }
  } else {
    for (const h of hours) {
      for (const l of h.levels) {
        const p = finiteScalar(l.pressureHpa), z = finiteScalar(l.heightM);
        if (p !== null && z !== null && z > (h.modelTerrainM ?? floorM) + 5) pushGroup(p, z);
      }
    }
  }

  const levelAnchors = [...grouped]
    .map(([pressureHpa, zs]) => ({ pressureHpa, heightM: median(zs) }))
    .sort((a, b) => a.heightM - b.heightM)
    .filter((a, i, all) => i === 0 || a.heightM > all[i - 1].heightM + 5);

  const highest = Math.max(floorM + 800, ...referenceHeights);
  const fullTopM = highest + (highest - floorM) * 0.04;

  const soaringTops = liftTops.length ? liftTops : nativeLiftTops;
  const activeCuTops = known(
    hours.map(hour => {
      if (classifyConvectiveCloudRegime(hour) === 'none') return null;
      const limits = [hour.effectiveCloudLimitM, hour.surfaceLclM].filter((v): v is number => v !== null && Number.isFinite(v));
      if (!limits.length) return null;
      const baseM = Math.min(...limits);
      const liftTop = hour.mapLift.mslM ?? hour.nativeUsableLiftTopM ?? null;
      const top = Math.max(hour.thermalTopM ?? -Infinity, liftTop ?? -Infinity);
      return Number.isFinite(top) ? Math.min(Math.max(baseM + 200, top), baseM + 1000, floorM + 4500) : null;
    }),
  );
  const peakM = Math.max(floorM, ...grounds, ...fineTerrain, ...soaringTops, ...activeCuTops, ...waveTops);
  const focusedTopM = Math.ceil(Math.max(floorM + 1000, peakM + Math.max(500, (peakM - floorM) * 0.25)) / 250) * 250;
  const calmDay = hours.length > 0 && hours.every(hour => hour.thermalVelocityMps === 0);
  const topM = focused && (soaringTops.length || waveTops.length || calmDay) ? Math.min(fullTopM, focusedTopM) : fullTopM;

  const modelGround = grounds.length ? Math.min(...grounds) : null;
  const anchorFloorM = Math.max(floorM, modelGround ?? floorM);
  const spanM = Math.max(1, topM - floorM);
  const yAt = (heightM: number) => bottom - ((heightM - floorM) / spanM) * plotHeight;
  const anchors: HeightAnchor[] = [
    { pressureHpa: null, heightM: floorM, y: bottom },
    ...(modelGround !== null && modelGround > floorM && modelGround < topM ? [{ pressureHpa: null, heightM: modelGround, y: yAt(modelGround) }] : []),
    ...levelAnchors
      .filter(anchor => anchor.heightM > anchorFloorM + 5 && anchor.heightM < topM)
      .map(anchor => ({ ...anchor, y: yAt(anchor.heightM) })),
    { pressureHpa: null, heightM: topM, y: top },
  ];

  return { floorM, topM, anchors };
}
