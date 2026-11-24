import { describe, expect, it } from 'vitest';
import {
  DRY_AIR_CP,
  DRY_AIR_GAS_CONSTANT,
  DRY_LAPSE_RATE_K_PER_M,
  GRAVITY_MPS2,
  ZERO_CELSIUS_K,
  celsiusToKelvin,
  dewpointFromGfsV16RhC,
  dewPointFromSpecificHumidityC,
  dewpointFromTempAndRhC,
  dryParcelTemperatureK,
  effectiveCloudHumidityPercent,
  gfsV16SaturationVaporPressureHpa,
  kelvinToCelsius,
  lclHeightMetersAgl,
  mixedPhaseSaturationVaporPressureHpa,
  potentialTemperatureK,
  relativeHumidityFromTempAndDewpointPercent,
  saturationMixingRatioGPerKg,
  saturationVaporPressureHpa,
  saturationVaporPressureIceHpa,
  surfaceKinematicHeatFluxKmPerS,
  virtualPotentialTemperatureK
} from './index.js';

describe('@av/thermodynamics', () => {
  it('converts temperatures and computes dry-adiabatic parcel cooling', () => {
    expect(celsiusToKelvin(0)).toBe(ZERO_CELSIUS_K);
    expect(kelvinToCelsius(ZERO_CELSIUS_K + 20)).toBeCloseTo(20, 6);
    expect(dryParcelTemperatureK(300, 500, 1500)).toBeCloseTo(
      300 - 1000 * DRY_LAPSE_RATE_K_PER_M,
      6
    );
    expect(GRAVITY_MPS2 / DRY_AIR_CP).toBeCloseTo(0.009767, 5);
    expect(DRY_AIR_GAS_CONSTANT).toBe(287.05);
  });

  it('computes potential temperature, vapor pressure, dewpoint, and LCL', () => {
    expect(potentialTemperatureK(293.15, 1000)).toBeCloseTo(293.15, 6);
    expect(potentialTemperatureK(283.15, 850)).toBeGreaterThan(295);
    expect(virtualPotentialTemperatureK(293.15, 1000, 0.01)).toBeGreaterThan(293.15);

    const es20 = saturationVaporPressureHpa(20);
    expect(es20).toBeCloseTo(23.37, 1);
    expect(saturationMixingRatioGPerKg(1000, 20)).toBeGreaterThan(14);

    const dp = dewpointFromTempAndRhC(20, 50);
    expect(dp).toBeCloseTo(9.27, 1);
    expect(lclHeightMetersAgl(20, 10)).toBe(1250);
  });

  it('computes Murphy & Koop ice vapor pressure and mixed-phase cloud RH continuously across 0..-40 °C', () => {
    // At >= 0 °C, mixed-phase and ice saturation join liquid Bolton continuously
    expect(saturationVaporPressureIceHpa(0)).toBeCloseTo(saturationVaporPressureHpa(0), 5);
    expect(mixedPhaseSaturationVaporPressureHpa(10)).toBe(saturationVaporPressureHpa(10));
    expect(effectiveCloudHumidityPercent(12, 8)).toBeCloseTo(relativeHumidityFromTempAndDewpointPercent(12, 8), 6);

    // At -40 °C, e_si(-40) ≈ 0.1285 hPa vs liquid Bolton e_sw(-40) ≈ 0.1905 hPa (ratio ≈ 0.674)
    const esi40 = saturationVaporPressureIceHpa(-40);
    const esw40 = saturationVaporPressureHpa(-40);
    expect(esi40).toBeCloseTo(0.1285, 3);
    expect(esi40 / esw40).toBeCloseTo(0.6745, 2);
    expect(mixedPhaseSaturationVaporPressureHpa(-30)).toBe(saturationVaporPressureIceHpa(-30));

    // Ice-saturated cirrus at -35 °C (liquid RH ~70%, Td ~ -38.4 °C) registers ~99% effective cloud RH
    expect(relativeHumidityFromTempAndDewpointPercent(-35, -38.4)).toBeLessThan(72);
    expect(effectiveCloudHumidityPercent(-35, -38.4)).toBeGreaterThan(98);
    expect(Number.isNaN(effectiveCloudHumidityPercent(NaN, -10))).toBe(true);
  });

  it('converts GFS v16 mixed-phase RH and specific humidity into liquid-vapor-pressure dewpoints', () => {
    expect(gfsV16SaturationVaporPressureHpa(8)).toBe(saturationVaporPressureHpa(8));
    expect(gfsV16SaturationVaporPressureHpa(-25)).toBe(saturationVaporPressureIceHpa(-25));
    expect(dewpointFromGfsV16RhC(10, 80)).toBeCloseTo(dewpointFromTempAndRhC(10, 80), 6);

    // Cascade negative fixture (47.50°N, 121.50°W, GFS 2026-11-20 00Z f003)
    const td450 = dewPointFromSpecificHumidityC(0.0002356488985, 450);
    expect(Math.abs(effectiveCloudHumidityPercent(-34.406195, td450) - 71.53)).toBeLessThanOrEqual(0.1);
    const td400 = dewPointFromSpecificHumidityC(0.0001077765628, 400);
    expect(Math.abs(effectiveCloudHumidityPercent(-41.870703, td400) - 66.79)).toBeLessThanOrEqual(0.1);

    // Secondary-level RH-only GFS conversion (-12 °C, 80% GFS v16 RH)
    const td875 = dewpointFromGfsV16RhC(-12, 80);
    expect(saturationVaporPressureHpa(td875)).toBeCloseTo(0.8 * gfsV16SaturationVaporPressureHpa(-12), 5);

    // Positive control (38.75°N, 78.25°W, 400 hPa): cold ice-saturated cloud preserved
    const tdPos = dewPointFromSpecificHumidityC(0.00078861, 400);
    expect(relativeHumidityFromTempAndDewpointPercent(-27.19, tdPos)).toBeCloseTo(76.45, 1);
    expect(effectiveCloudHumidityPercent(-27.19, tdPos)).toBeGreaterThanOrEqual(99.5);
  });

  it('computes surface kinematic sensible heat flux in K*m/s', () => {
    expect(surfaceKinematicHeatFluxKmPerS(240, 1.15, 1004)).toBeCloseTo(240 / (1.15 * 1004), 6);
    expect(surfaceKinematicHeatFluxKmPerS(-50)).toBe(0);
  });
});
