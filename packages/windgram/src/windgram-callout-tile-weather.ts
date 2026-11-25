// Hover-tile quadrant 4: temperature, dewpoint, and the single highest-priority hazard cue.

import { MPH_PER_MPS } from '@av/contracts/units';
import type { WindgramReading } from './scene-types.ts';
import type { paintSkyCell, paintWindCell, TileConditions, TileElements } from './windgram-callout-tile-cells.ts';
import { HIGH_INSTABILITY_CAPE_JKG } from './windgram-clouds.ts';
import { convertQuantity, formatQuantity, METRES_PER_THOUSAND_FEET, unitLabel, type UnitSystem } from './windgram-format.ts';
import { setAttr, setText } from './windgram-svg-dom.ts';

export function paintWeatherCell(
  el: TileElements,
  reading: WindgramReading,
  conditions: TileConditions,
  useTol: boolean,
  unitSystem: UnitSystem,
  prior: ReturnType<typeof paintSkyCell> & ReturnType<typeof paintWindCell> & { readonly displayClimbMps: number | null },
): void {
  const { back, tempEl, dewpointEl, rainBg, rainIcon, hazardEl } = el;
  const { inLiquidSaturatedCloud, inConvectiveTower, hasRain, precipMm, inSaturatedCloud, shearedLift, inInversion } = conditions;
  const { tempC, layers, cuLayer, effectiveAlert, nearSurface, displayClimbMps } = prior;
  // Quadrant 4: Temperature + Dewpoint (Td) + Input-Supported Weather Cues
  if (tempC === null) {
    setText(tempEl, '—');
    setAttr(tempEl, 'class', 'wg-tile-val is-muted');
  } else {
    const dispTemp = Math.round(convertQuantity(tempC, 'temperature', unitSystem) ?? 0);
    const freezing = tempC <= 0;
    setText(tempEl, `${freezing ? '❄ ' : ''}${dispTemp}${unitLabel('temperature', unitSystem)}`);
    setAttr(tempEl, 'class', freezing ? 'wg-tile-val is-freeze' : 'wg-tile-val');
  }

  if (reading.dewPointC != null && Number.isFinite(reading.dewPointC)) {
    const dispTd = Math.round(convertQuantity(reading.dewPointC, 'temperature', unitSystem) ?? 0);
    setText(dewpointEl, `Td ${dispTd}°`);
  } else {
    setText(dewpointEl, '');
  }

  // Supercooled liquid icing requires liquid-water saturation (liquid RH >= 94%) in -20..0 °C
  const icingRisk = inLiquidSaturatedCloud && tempC !== null && tempC <= 0 && tempC >= -20;
  const cuDepthM = cuLayer?.depthM ?? 0;
  const inCuColumn =
    !useTol &&
    cuLayer !== null &&
    reading.heightM > cuLayer.baseM + 20 &&
    reading.heightM <= cuLayer.topM + 10;
  const cloudSuckRisk =
    (inConvectiveTower || inCuColumn || (useTol && Boolean(reading.cloudCapped))) &&
    cuDepthM >= 1000 &&
    (reading.peakClimbMps ?? 0) >= 1.8;
  const highCape = reading.capeJkg !== null && reading.capeJkg >= HIGH_INSTABILITY_CAPE_JKG;
  const capeRounded = highCape ? Math.round(reading.capeJkg!) : 0;
  const highShear = reading.windShear !== null && reading.windShear.perKmMps >= 6;
  if (effectiveAlert !== 'pennant' && cloudSuckRisk) {
    setAttr(back, 'class', 'wg-tile-back is-danger');
  }

  if (hasRain) {
    setAttr(rainBg, 'class', cloudSuckRisk || highCape || icingRisk ? 'wg-tile-cell-tint is-danger' : 'wg-tile-cell-tint is-rain');
    setAttr(rainIcon, 'visibility', 'visible');
    setAttr(hazardEl, 'x', '118.5');
    const rateLabel = formatQuantity(precipMm, 'rainRate', undefined, unitSystem);
    if (icingRisk && cloudSuckRisk) {
      setText(hazardEl, `${rateLabel} · ❄ Ice · Suck`);
      setAttr(hazardEl, 'class', 'wg-tile-sub is-danger');
    } else if (icingRisk) {
      setText(hazardEl, `${rateLabel} · ❄ Icing risk`);
      setAttr(hazardEl, 'class', 'wg-tile-sub is-danger');
    } else if (cloudSuckRisk) {
      setText(hazardEl, `${rateLabel} · ⚠ Suck`);
      setAttr(hazardEl, 'class', 'wg-tile-sub is-danger');
    } else if (highCape && highShear) {
      setText(hazardEl, `${rateLabel} · CAPE ${capeRounded} · Shr`);
      setAttr(hazardEl, 'class', 'wg-tile-sub is-danger');
    } else if (highCape) {
      setText(hazardEl, `${rateLabel} · CAPE ${capeRounded}`);
      setAttr(hazardEl, 'class', 'wg-tile-sub is-danger');
    } else if (highShear) {
      setText(hazardEl, `${rateLabel} · Shear`);
      setAttr(hazardEl, 'class', 'wg-tile-sub is-caution');
    } else if (reading.warmLayerAloft) {
      setText(hazardEl, `${rateLabel} · Warm aloft`);
      setAttr(hazardEl, 'class', 'wg-tile-sub is-caution');
    } else {
      setText(hazardEl, `Precip ${rateLabel}`);
      setAttr(hazardEl, 'class', 'wg-tile-sub is-rain');
    }
  } else {
    const precipKnownZero = precipMm !== null && Number.isFinite(precipMm) && precipMm <= 0.04;
    setAttr(rainBg, 'class', 'wg-tile-cell-tint');
    setAttr(rainIcon, 'visibility', 'hidden');
    setAttr(hazardEl, 'x', '110');
    if (icingRisk && cloudSuckRisk) {
      setText(hazardEl, '❄ Ice · ⚠ Suck');
      setAttr(hazardEl, 'class', 'wg-tile-sub is-danger');
    } else if (icingRisk) {
      setText(hazardEl, '❄ Icing risk');
      setAttr(hazardEl, 'class', 'wg-tile-sub is-danger');
    } else if (cloudSuckRisk && highCape) {
      setText(hazardEl, `⚠ Suck · CAPE ${capeRounded}`);
      setAttr(hazardEl, 'class', 'wg-tile-sub is-danger');
    } else if (cloudSuckRisk) {
      setText(hazardEl, '⚠ Cloud suck');
      setAttr(hazardEl, 'class', 'wg-tile-sub is-danger');
    } else if (nearSurface && reading.surfaceWindShift) {
      setText(hazardEl, 'Wind shift');
      setAttr(hazardEl, 'class', 'wg-tile-sub is-caution');
    } else if (highCape && highShear) {
      setText(hazardEl, `CAPE ${capeRounded} · Shear`);
      setAttr(hazardEl, 'class', 'wg-tile-sub is-danger');
    } else if (highCape) {
      setText(hazardEl, `CAPE ${capeRounded}`);
      setAttr(hazardEl, 'class', capeRounded >= 1800 ? 'wg-tile-sub is-danger' : 'wg-tile-sub is-caution');
    } else if (highShear && reading.windShear !== null) {
      const shearLabel = unitSystem === 'imperial'
        ? `Shear ${((reading.windShear.perKmMps * MPH_PER_MPS * METRES_PER_THOUSAND_FEET) / 1000).toFixed(1)} mph/kft`
        : `Shear ${reading.windShear.perKmMps.toFixed(1)}/km`;
      setText(hazardEl, shearLabel);
      setAttr(hazardEl, 'class', 'wg-tile-sub is-caution');
    } else if (reading.overdeveloped) {
      const coldResolvedTop = Boolean(cuLayer?.topTempC != null && cuLayer.topTempC <= -20 && cuDepthM >= 1500);
      setText(hazardEl, coldResolvedTop ? 'OD · Cold top' : 'OD spreadout');
      setAttr(hazardEl, 'class', 'wg-tile-sub is-caution');
    } else if (reading.warmLayerAloft) {
      setText(hazardEl, 'Warm aloft');
      setAttr(hazardEl, 'class', 'wg-tile-sub');
    } else if (!inSaturatedCloud && displayClimbMps !== null && displayClimbMps >= 0.2 && shearedLift) {
      const raspBs = Math.max(1, Math.round(reading.buoyancyShearRatio! * 10));
      setText(hazardEl, `B/S ${raspBs} · Sheared`);
      setAttr(hazardEl, 'class', 'wg-tile-sub is-caution');
    } else if (inInversion) {
      setText(hazardEl, 'Inversion');
      setAttr(hazardEl, 'class', 'wg-tile-sub');
    } else if (layers.length >= 2) {
      setText(hazardEl, precipKnownZero ? `Dry · ${layers.length} layers` : `${layers.length} cloud layers`);
      setAttr(hazardEl, 'class', 'wg-tile-sub');
    } else {
      setText(hazardEl, precipKnownZero ? 'Dry' : 'Precip —');
      setAttr(hazardEl, 'class', 'wg-tile-sub');
    }
  }
}
