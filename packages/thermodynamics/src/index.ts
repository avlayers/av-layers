/** Dry-air thermodynamic kernels. Inputs and outputs use the units in each name. */
import {
  DRY_AIR_CP,
  DRY_LAPSE_RATE_K_PER_M,
  POISSON_EXPONENT_DRY_AIR,
  STANDARD_PRESSURE_HPA,
  THERMODYNAMIC_CONSTANTS,
  WATER_DRY_AIR_MOLAR_MASS_RATIO,
  ZERO_CELSIUS_K
} from './constants.js';
export * from './constants.js';

const {
  saturationVaporPressureScaleHpa: SATURATION_SCALE_HPA,
  saturationExponent: SATURATION_EXPONENT,
  saturationTemperatureOffsetC: SATURATION_OFFSET_C
} = THERMODYNAMIC_CONSTANTS;

export const kelvinToCelsius = (kelvin: number): number => kelvin - ZERO_CELSIUS_K;

export const celsiusToKelvin = (celsius: number): number => celsius + ZERO_CELSIUS_K;

/**
 * Potential temperature θ (K) from temperature T (K) and pressure P (hPa).
 */
export const potentialTemperatureK = (temperatureK: number, pressureHpa: number): number => {
  if (!Number.isFinite(temperatureK) || !Number.isFinite(pressureHpa) || pressureHpa <= 0) {
    return NaN;
  }
  return temperatureK * (STANDARD_PRESSURE_HPA / pressureHpa) ** POISSON_EXPONENT_DRY_AIR;
};

/**
 * Virtual potential temperature θ_v (K) from temperature T (K), pressure P (hPa),
 * and water-vapor mixing ratio r (kg/kg).
 */
export const virtualPotentialTemperatureK = (
  temperatureK: number,
  pressureHpa: number,
  mixingRatioKgKg = 0
): number => {
  const theta = potentialTemperatureK(temperatureK, pressureHpa);
  if (!Number.isFinite(theta)) {
    return NaN;
  }
  const r = Number.isFinite(mixingRatioKgKg) && mixingRatioKgKg > 0 ? mixingRatioKgKg : 0;
  return theta * (1 + 0.61 * r);
};

/**
 * Bolton (1980) saturation vapor pressure e_s (hPa) over liquid water from temperature (°C),
 * using the shared thermodynamic constants.
 */
export const saturationVaporPressureHpa = (tempC: number): number => {
  if (!Number.isFinite(tempC)) {
    return NaN;
  }
  return (
    SATURATION_SCALE_HPA *
    Math.exp((SATURATION_EXPONENT * tempC) / (tempC + SATURATION_OFFSET_C))
  );
};

/**
 * Murphy & Koop (2005) saturation vapor pressure e_si (hPa) over hexagonal ice for T <= 0 °C,
 * joining liquid-water saturation continuously at 0 °C.
 */
export const saturationVaporPressureIceHpa = (tempC: number): number => {
  if (!Number.isFinite(tempC)) return NaN;
  if (tempC >= 0) return saturationVaporPressureHpa(tempC);
  const tk = tempC + ZERO_CELSIUS_K;
  if (!(tk > 0)) return NaN;
  const lnPa = 9.550426 - 5723.265 / tk + 3.53068 * Math.log(tk) - 0.00728332 * tk;
  return Math.exp(lnPa) / THERMODYNAMIC_CONSTANTS.pascalsPerHectopascal;
};

/**
 * Mixed-phase saturation vapor pressure (hPa): pure liquid water at T >= 0 °C,
 * pure ice at T <= -23 °C, and quadratic mixed-phase ramp across -23 °C < T < 0 °C.
 */
export const mixedPhaseSaturationVaporPressureHpa = (tempC: number): number => {
  if (!Number.isFinite(tempC)) return NaN;
  if (tempC >= 0) return saturationVaporPressureHpa(tempC);
  if (tempC <= -23) return saturationVaporPressureIceHpa(tempC);
  const liquidFraction = ((tempC + 23) / 23) ** 2;
  return (
    liquidFraction * saturationVaporPressureHpa(tempC) +
    (1 - liquidFraction) * saturationVaporPressureIceHpa(tempC)
  );
};

/** Relative humidity (%) over liquid water from temperature and dewpoint (°C). */
export function relativeHumidityFromTempAndDewpointPercent(temperatureC: number, dewPointC: number): number {
  return Math.max(0, Math.min(100, 100 * saturationVaporPressureHpa(dewPointC) / saturationVaporPressureHpa(temperatureC)));
}

/**
 * Phase-aware cloud relative humidity (%) comparing vapor pressure from Bolton dewpoint
 * against mixed-phase liquid/ice saturation at ambient temperature.
 */
export function effectiveCloudHumidityPercent(temperatureC: number, dewPointC: number): number {
  return Math.max(
    0,
    Math.min(100, (100 * saturationVaporPressureHpa(dewPointC)) / mixedPhaseSaturationVaporPressureHpa(temperatureC))
  );
}

/**
 * Saturation mixing ratio w_s (g/kg) from pressure (hPa) and temperature (°C),
 * using `1000 * WATER_DRY_AIR_MOLAR_MASS_RATIO` (622 g/kg).
 */
export const saturationMixingRatioGPerKg = (pressureHpa: number, tempC: number): number => {
  const es = saturationVaporPressureHpa(tempC);
  if (!Number.isFinite(es) || !Number.isFinite(pressureHpa) || pressureHpa <= es) {
    return NaN;
  }
  return (1000 * WATER_DRY_AIR_MOLAR_MASS_RATIO * es) / (pressureHpa - es);
};

/**
 * GFS v16 isobaric relative-humidity reference saturation vapor pressure (hPa):
 * pure liquid water at T >= 0 °C, pure ice at T <= -20 °C, and a linear ramp across -20 °C < T < 0 °C.
 */
export const gfsV16SaturationVaporPressureHpa = (tempC: number): number => {
  if (!Number.isFinite(tempC)) return NaN;
  if (tempC >= 0) return saturationVaporPressureHpa(tempC);
  if (tempC <= -20) return saturationVaporPressureIceHpa(tempC);
  const liquidWeight = (tempC + 20) / 20;
  return (
    liquidWeight * saturationVaporPressureHpa(tempC) +
    (1 - liquidWeight) * saturationVaporPressureIceHpa(tempC)
  );
};

const boltonDewpointFromVaporPressureC = (vaporPressureHpa: number): number => {
  if (!Number.isFinite(vaporPressureHpa) || vaporPressureHpa <= 0) return NaN;
  const lnRatio = Math.log(vaporPressureHpa / SATURATION_SCALE_HPA);
  return (SATURATION_OFFSET_C * lnRatio) / (SATURATION_EXPONENT - lnRatio);
};

const boltonDewpointFromEsAndRhC = (esHpa: number, rhPercent: number): number =>
  !Number.isFinite(esHpa) || esHpa <= 0 || !Number.isFinite(rhPercent) || rhPercent <= 0
    ? NaN
    : boltonDewpointFromVaporPressureC((esHpa * Math.min(100, Math.max(0.1, rhPercent))) / 100);

/** Dewpoint temperature (°C) over liquid water from ambient temperature (°C) and liquid-reference RH (%). */
export const dewpointFromTempAndRhC = (tempC: number, rhPercent: number): number =>
  boltonDewpointFromEsAndRhC(saturationVaporPressureHpa(tempC), rhPercent);

/** Liquid-vapor-pressure Bolton dewpoint (°C) from ambient temperature (°C) and GFS v16 mixed-phase RH (%). */
export const dewpointFromGfsV16RhC = (tempC: number, rhPercent: number): number =>
  boltonDewpointFromEsAndRhC(gfsV16SaturationVaporPressureHpa(tempC), rhPercent);

export type UpperAirMoistureReference = 'liquid-vapor-pressure';

/** Resolve the upper-air moisture reference of a published profile build. */
export function resolveUpperAirMoistureReference(
  _model?: string,
  _declared?: UpperAirMoistureReference
): UpperAirMoistureReference {
  return 'liquid-vapor-pressure';
}

export interface InterpretedUpperAirMoisture {
  readonly dewPointC: number | null;
  readonly liquidRhPercent: number | null;
  readonly cloudRhPercent: number | null;
  readonly modelRhPercent: number | null;
}

/**
 * Recover physical liquid-vapor-pressure Bolton dewpoint, liquid RH, and mixed-phase cloud RH
 * from a stored upper-air level.
 */
export function interpretUpperAirMoisture(
  temperatureC: number | null | undefined,
  storedDewPointC: number | null | undefined,
  _reference: UpperAirMoistureReference = 'liquid-vapor-pressure'
): InterpretedUpperAirMoisture {
  const hasT = typeof temperatureC === 'number' && Number.isFinite(temperatureC);
  const hasTd = typeof storedDewPointC === 'number' && Number.isFinite(storedDewPointC);
  const dewPointC = hasTd ? storedDewPointC : null;
  if (!hasT || dewPointC === null) {
    return { dewPointC, liquidRhPercent: null, cloudRhPercent: null, modelRhPercent: null };
  }
  const liquidRhPercent = relativeHumidityFromTempAndDewpointPercent(temperatureC, dewPointC);
  const cloudRhPercent = effectiveCloudHumidityPercent(temperatureC, dewPointC);
  return {
    dewPointC,
    liquidRhPercent: Number.isFinite(liquidRhPercent) ? liquidRhPercent : null,
    cloudRhPercent: Number.isFinite(cloudRhPercent) ? cloudRhPercent : null,
    modelRhPercent: Number.isFinite(liquidRhPercent) ? liquidRhPercent : null
  };
}

/**
 * Espy / dry-adiabatic lifted condensation level (LCL) height AGL in meters.
 */
export const lclHeightMetersAgl = (surfaceTempC: number, surfaceDewpointC: number): number => {
  if (!Number.isFinite(surfaceTempC) || !Number.isFinite(surfaceDewpointC)) {
    return NaN;
  }
  const spread = Math.max(0, surfaceTempC - surfaceDewpointC);
  return 125 * spread;
};

/** Bolton parcel LCL above its origin, in metres AGL. */
export function boltonLclHeightMetersAgl(temperatureC: number, dewPointC: number): number {
  const temperatureK = temperatureC + ZERO_CELSIUS_K, dewPointK = dewPointC + ZERO_CELSIUS_K;
  if (!Number.isFinite(temperatureK) || !Number.isFinite(dewPointK) || temperatureK <= 0 || dewPointK <= 0) return NaN;
  if (dewPointC >= temperatureC) return 0;
  const lclK = 1 / (1 / (dewPointK - 56) + Math.log(temperatureK / dewPointK) / 800) + 56;
  return Math.max(0, (temperatureK - lclK) / DRY_LAPSE_RATE_K_PER_M);
}

/** Water-vapor mixing ratio in kg/kg from dewpoint and ambient pressure. */
export function mixingRatioFromDewPointKgKg(dewPointC: number, pressureHpa: number): number {
  const e = saturationVaporPressureHpa(dewPointC);
  return Number.isFinite(e) && e >= 0 && Number.isFinite(pressureHpa) && pressureHpa > e
    ? WATER_DRY_AIR_MOLAR_MASS_RATIO * e / (pressureHpa - e) : NaN;
}

export function dewPointFromMixingRatioC(mixingRatioKgKg: number, pressureHpa: number): number {
  if (!Number.isFinite(mixingRatioKgKg) || mixingRatioKgKg <= 0 || !Number.isFinite(pressureHpa) || pressureHpa <= 0) return NaN;
  return boltonDewpointFromVaporPressureC(mixingRatioKgKg * pressureHpa / (WATER_DRY_AIR_MOLAR_MASS_RATIO + mixingRatioKgKg));
}

export function dewPointFromSpecificHumidityC(specificHumidityKgKg: number, pressureHpa: number): number {
  return Number.isFinite(specificHumidityKgKg) && specificHumidityKgKg > 0 && specificHumidityKgKg < 1
    ? dewPointFromMixingRatioC(specificHumidityKgKg / (1 - specificHumidityKgKg), pressureHpa) : NaN;
}

/** Upward geometric velocity in m/s from pressure velocity omega in Pa/s and optional specific humidity. */
export function geometricWFromOmegaMps(omegaPaS: number, pressureHpa: number, temperatureC: number, specificHumidityKgKg = 0): number {
  const temperatureK = temperatureC + ZERO_CELSIUS_K;
  if (!Number.isFinite(omegaPaS) || !Number.isFinite(pressureHpa) || !Number.isFinite(temperatureK) || pressureHpa <= 0 || temperatureK <= 0
      || !(specificHumidityKgKg >= 0 && specificHumidityKgKg < 1)) return NaN;
  const virtualTemperatureK = temperatureK * (1 + (1 / WATER_DRY_AIR_MOLAR_MASS_RATIO - 1) * specificHumidityKgKg);
  return omegaPaS === 0 ? 0 : -omegaPaS * THERMODYNAMIC_CONSTANTS.dryAirGasConstantJkgK * virtualTemperatureK /
    (pressureHpa * THERMODYNAMIC_CONSTANTS.pascalsPerHectopascal * THERMODYNAMIC_CONSTANTS.gravityMps2);
}

/** Hydrostatic pressure velocity in Pa/s from upward geometric velocity and specific humidity. */
export function omegaFromGeometricWPaS(wMps: number, pressureHpa: number, temperatureC: number, specificHumidityKgKg = 0): number {
  const temperatureK = temperatureC + ZERO_CELSIUS_K;
  if (!Number.isFinite(wMps) || !Number.isFinite(pressureHpa) || !Number.isFinite(temperatureK) || pressureHpa <= 0 || temperatureK <= 0
      || !(specificHumidityKgKg >= 0 && specificHumidityKgKg < 1)) return NaN;
  const virtualTemperatureK = temperatureK * (1 + (1 / WATER_DRY_AIR_MOLAR_MASS_RATIO - 1) * specificHumidityKgKg);
  return wMps === 0 ? 0 : -wMps * pressureHpa * THERMODYNAMIC_CONSTANTS.pascalsPerHectopascal * THERMODYNAMIC_CONSTANTS.gravityMps2 /
    (THERMODYNAMIC_CONSTANTS.dryAirGasConstantJkgK * virtualTemperatureK);
}

/**
 * Dry-adiabatic parcel temperature at target altitude `zM` given initial
 * parcel temperature `t0` at altitude `z0M` and dry lapse rate `dryLapseRateKperM`.
 * Because 1 K/m === 1 °C/m, this linear cooling holds in either °C or K.
 */
export const dryParcelTemperature = (
  t0: number,
  z0M: number,
  zM: number,
  dryLapseRateKperM: number = DRY_LAPSE_RATE_K_PER_M
): number => t0 - dryLapseRateKperM * (zM - z0M);

/**
 * Dry-adiabatic parcel temperature in Celsius (°C) at target altitude `zM` (m)
 * given initial parcel temperature `t0C` (°C) at altitude `z0M` (m).
 */
export const dryParcelTemperatureC = dryParcelTemperature;

/**
 * Dry-adiabatic parcel temperature in Kelvin (K) at target altitude `zM` (m)
 * given initial parcel temperature `t0K` (K) at altitude `z0M` (m).
 */
export const dryParcelTemperatureK = dryParcelTemperature;

/**
 * Surface kinematic sensible heat flux w'θ'_0 (K·m/s) from upward surface sensible
 * heat flux H (W/m²) and air density ρ (kg/m³):
 *
 *   w'θ'_0 = H / (ρ · c_p)
 */
export const surfaceKinematicHeatFluxKmPerS = (
  sensibleHeatFluxWm2: number,
  airDensityKgM3 = 1.15,
  cpJPerKgK: number = DRY_AIR_CP
): number => {
  if (
    !Number.isFinite(sensibleHeatFluxWm2) ||
    !Number.isFinite(airDensityKgM3) ||
    airDensityKgM3 <= 0 ||
    !Number.isFinite(cpJPerKgK) ||
    cpJPerKgK <= 0
  ) {
    return NaN;
  }
  return Math.max(0, sensibleHeatFluxWm2) / (airDensityKgM3 * cpJPerKgK);
};
