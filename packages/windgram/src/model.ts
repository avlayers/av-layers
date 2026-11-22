import type { SiteForecast } from './internal-meteo.ts';
import type { SkyCoverageCode, WindgramCloudLayerSummary, WindgramView, WindgramOptions, WindgramReading } from './scene-types.ts';
import { publishScene, sceneData } from './scene-store.ts';
import { buildWindgramView as buildView } from './windgram-view.ts';
import { buildStitchedWindgramView as buildStitchedView, type StitchedWindgramOptions } from './windgram-stitched.ts';
import { readWindgram as readView } from './windgram-inspector.ts';

export { createPointForecast, type CreatePointForecastOptions } from './from-av-profile.ts';
export { resolveCivilTimeZone, timeZoneForLongitude, timeZoneOffsetMinutesAt } from './time-zone.ts';
export type { PublishedForecastHour, SiteForecast } from './internal-meteo.ts';
export type { SkyCoverageCode, WindgramCloudLayerSummary, WindgramView, WindgramOptions, WindgramReading };
export type { StitchedWindgramOptions };

/** Build from a validated forecast. Retain the original scene handle for rendering and inspection. */
export function buildWindgramView(profile: SiteForecast, options: WindgramOptions): WindgramView {
  return publishScene(buildView(profile, options));
}
/** Build a multi-day stitched daylight scene on a shared vertical scale. */
export function buildStitchedWindgramView(profile: SiteForecast, options: StitchedWindgramOptions): WindgramView {
  return publishScene(buildStitchedView(profile, options));
}
/** Read at metres MSL; output field names specify units and missing weather remains null. */
export function readWindgram(view: WindgramView, hourIndex: number, heightM: number): WindgramReading {
  return readView(sceneData(view), hourIndex, heightM);
}
