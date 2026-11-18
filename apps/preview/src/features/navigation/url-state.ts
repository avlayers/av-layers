import { LAYER_IDS, type LayerId } from '@av/contracts/layers';
import { MODEL_OPTIONS } from '@av/contracts/model-options';
import { WIND_HEIGHTS } from '@av/contracts/wind-data';
import { AUTO_MODEL_ID, type UnitSystem } from '@av/client';
import { isCloudStyleId, isRainStyleId, type CloudStyleChoice, type RainStyleChoice } from '../map/channel-styles';
import { isMapTheme, type MapTheme } from '../map/visual-theme';

export type AltitudeReference = 'agl' | 'msl';
export type WindStyleParam = 'trails' | 'barbs' | 'hybrid';

function finiteParam(value: string | null): number | null {
  if (value === null || value.trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function parseFlag(value: string | null): boolean | null {
  return value === '0' ? false : value === '1' ? true : null;
}

function parseWindHeight(value: string | null): 'surface' | number | 'lift' | null {
  if (value === 'surface' || value === 'lift') return value;
  const n = finiteParam(value);
  return n !== null && n > 0 ? WIND_HEIGHTS.reduce((best, stop) => Math.abs(stop - n) < Math.abs(best - n) ? stop : best) : null;
}

export function previewQuery(search: string, offline: boolean) {
  const params = new URLSearchParams(search);
  const model = params.get('model');
  const lat = finiteParam(params.get('lat')), lon = finiteParam(params.get('lon')), zoom = finiteParam(params.get('z'));
  const opacity = finiteParam(params.get('opacity'));
  const rawLayer = params.get('layer');
  const layer = rawLayer && (LAYER_IDS as readonly string[]).includes(rawLayer) ? rawLayer as LayerId : null;
  const reference: AltitudeReference = params.get('ref') === 'msl' || layer === 'usable-lift-msl' ? 'msl' : 'agl';
  const wstyle = params.get('wstyle');
  const units = params.get('units');
  const theme = params.get('theme');
  const cstyle = params.get('cstyle');
  const rstyle = params.get('rstyle');
  return {
    model: model && (model === AUTO_MODEL_ID ? !offline : offline || MODEL_OPTIONS.some(option => option.modelId === model)) ? model : null,
    reference,
    layer: layer && layer !== 'usable-lift-agl' && layer !== 'usable-lift-msl' ? layer : null,
    opacity: opacity === null ? null : Math.min(1, Math.max(0, opacity)),
    validTime: params.get('t'),
    theme: isMapTheme(theme) ? theme : null,
    cloudStyle: cstyle === 'auto' || isCloudStyleId(cstyle) ? (cstyle as CloudStyleChoice) : null,
    rainStyle: rstyle === 'auto' || isRainStyleId(rstyle) ? (rstyle as RainStyleChoice) : null,
    liftVisible: parseFlag(params.get('lift')),
    cloudsVisible: parseFlag(params.get('clouds')),
    rainVisible: parseFlag(params.get('rain')),
    isobarsVisible: parseFlag(params.get('isobars')),
    windVisible: parseFlag(params.get('wind')),
    windStyle: wstyle === 'trails' || wstyle === 'barbs' || wstyle === 'hybrid' ? wstyle as WindStyleParam : null,
    windHeight: parseWindHeight(params.get('wheight')),
    units: units === 'metric' || units === 'imperial' ? units as UnitSystem : null,
    camera: lat !== null && Math.abs(lat) <= 90 && lon !== null && zoom !== null
      ? { center: [lon, lat] as [number, number], zoom } : null
  };
}

export function previewUrl(pathname: string, state: {
  model: string;
  reference: AltitudeReference;
  layer?: LayerId | null;
  opacity: number;
  lat: number;
  lon: number;
  zoom: number;
  validTime?: string;
  theme?: MapTheme;
  cloudStyle?: CloudStyleChoice;
  rainStyle?: RainStyleChoice;
  liftVisible?: boolean;
  cloudsVisible?: boolean;
  rainVisible?: boolean;
  isobarsVisible?: boolean;
  windVisible?: boolean;
  windStyle?: WindStyleParam;
  windHeight?: 'surface' | number | 'lift';
  units?: UnitSystem;
}): string {
  const params = new URLSearchParams({
    model: state.model, ref: state.reference, opacity: String(Math.round(state.opacity * 100) / 100),
    lat: state.lat.toFixed(4), lon: state.lon.toFixed(4), z: String(Math.round(state.zoom * 100) / 100)
  });
  if (state.layer && state.layer !== 'usable-lift-agl' && state.layer !== 'usable-lift-msl') params.set('layer', state.layer);
  if (state.validTime) params.set('t', state.validTime);
  if (state.theme && state.theme !== 'stone') params.set('theme', state.theme);
  if (state.cloudStyle && state.cloudStyle !== 'auto') params.set('cstyle', state.cloudStyle);
  if (state.rainStyle && state.rainStyle !== 'auto') params.set('rstyle', state.rainStyle);
  if (state.liftVisible === false) params.set('lift', '0');
  if (state.cloudsVisible === false) params.set('clouds', '0');
  if (state.rainVisible === false) params.set('rain', '0');
  if (state.isobarsVisible === true) params.set('isobars', '1');
  if (state.windVisible !== undefined) params.set('wind', state.windVisible ? '1' : '0');
  if (state.windStyle && state.windStyle !== 'trails') params.set('wstyle', state.windStyle);
  if (state.windHeight && state.windHeight !== 'surface') params.set('wheight', String(state.windHeight));
  if (state.units && state.units !== 'metric') params.set('units', state.units);
  return `${pathname}?${params}`;
}
