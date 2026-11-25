// Converts loaded point frames into the forecast, day calendar, and status flags the panel renders.

import type { PinnedBuild, PointFrame, PointSeries, PointTerrain, pointLiftExpectation } from '@av/client';
import type { createPointForecast, SiteForecast } from './model.ts';
import { groupFrames, type Calendar } from './point-calendar.ts';
import { findBestSoaringDayKey } from './point-view-mode.ts';

export type PointWindgramInput = Pick<PointSeries, 'frames' | 'siteTerrain'>;

interface PointData extends Calendar {
  loaded: ReadonlyMap<string, PointFrame>;
  forecast: SiteForecast;
  siteTerrainKey: string;
  bestDayKey: string | null;
  daylightDayCount: number;
  hasSounding: boolean;
  hasValues: boolean;
  partial: boolean;
}

/** Returns a memoized converter: unchanged frames, totals, and terrain reuse the previous result. */
export function createPointDataSource(
  build: PinnedBuild,
  toForecast: ReturnType<typeof createPointForecast>,
  lift: ReturnType<typeof pointLiftExpectation>,
  countDaylightDays: (cal: Calendar) => number,
) {
  const { layers: liftLayers, frames: mapFrames } = lift;
  let grouped: Calendar | undefined;
  let derivedMemo: {
    frames: readonly PointFrame[];
    totalFrames: number | undefined;
    siteTerrain: PointTerrain | null | undefined;
    data: PointData;
  } | null = null;
  return (nextInput: PointWindgramInput, nextOptions: { readonly totalFrames?: number }): PointData => {
    if (
      derivedMemo &&
      derivedMemo.totalFrames === nextOptions.totalFrames &&
      derivedMemo.siteTerrain === nextInput.siteTerrain &&
      derivedMemo.frames.length === nextInput.frames.length &&
      derivedMemo.frames.every((f, i) => f === nextInput.frames[i])
    ) {
      return derivedMemo.data;
    }
    const loaded = new Map(nextInput.frames.map(frame => [frame.id, frame]));
    const frames = nextOptions.totalFrames === undefined
      ? build.manifest.frames.filter(frame => loaded.has(frame.id))
      : build.manifest.frames.slice(0, nextOptions.totalFrames);
    const forecast = toForecast(frames, loaded, nextInput.siteTerrain);
    const previous = grouped;
    const calendar = previous && previous.frames.length === frames.length && frames.every(({ id, validTime }, i) => {
      const old = previous.frames[i]!;
      return old.id === id && old.validTime === validTime;
    }) ? previous : groupFrames(frames, forecast.site.timeZone);
    grouped = calendar;

    const forecastMap = new Map(
      forecast.hours.map(h => [
        h.validAt,
        {
          usableLiftTopM: h.mapLift.mslM,
          terrainM: h.fineTerrainM ?? h.modelTerrainM,
          thermalVelocityMps: h.thermalVelocityMps,
          surfaceWindMps: h.surface.windSpeedMps,
        },
      ]),
    );
    // While frames are still loading the ranking is provisional, so no day is starred yet.
    const bestDayKey = frames.every(({ id }) => loaded.has(id)) ? findBestSoaringDayKey(calendar.dayKeys, calendar.days, forecastMap) : null;
    const siteTerrainKey = nextInput.siteTerrain
      ? `${nextInput.siteTerrain.status}:${nextInput.siteTerrain.elevationM ?? 'null'}`
      : '';

    const result: PointData = {
      ...calendar,
      loaded,
      forecast,
      siteTerrainKey,
      bestDayKey,
      daylightDayCount: countDaylightDays(calendar),
      hasSounding: forecast.hours.some(hour => hour.levels.length > 0),
      hasValues: nextInput.frames.some(frame => Object.values(frame.layers).some(cell => cell.status === 'valid')),
      partial: frames.some(({ id }) => {
        const frame = loaded.get(id);
        return !frame?.profile || (mapFrames.has(id) && liftLayers.some(layer => !frame.layers[layer]));
      }),
    };
    derivedMemo = {
      frames: nextInput.frames,
      totalFrames: nextOptions.totalFrames,
      siteTerrain: nextInput.siteTerrain,
      data: result,
    };
    return result;
  };
}
