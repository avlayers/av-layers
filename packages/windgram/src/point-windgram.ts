import {
  formatMapLiftCell,
  formatPlaceTime,
  formatPointMapLift,
  formatPointMapTimes,
  hasNativeProfiles,
  pointLiftExpectation,
  pointMapLift,
  samePoint,
  type GeoPoint,
  type PinnedBuild,
  type PointFrame,
  type PointSeries,
  type PointTerrain,
  type UnitSystem,
} from '@av/client';
import { formatSitePlaceTime, timeZoneOffsetMinutesAt } from '@av/client/timezone';
import {
  mountWindgram,
  type WindgramCalloutTrigger,
  type WindgramCalloutVariant,
  type WindgramMount,
} from './dom.ts';
import { localDateKey } from './internal-meteo.ts';
import {
  buildStitchedWindgramView,
  buildWindgramView,
  createPointForecast,
  type SiteForecast,
  type WindgramView,
} from './model.ts';
import { sceneData } from './scene-store.ts';
import { adoptDocumentStyleSheet } from './style-registry.ts';
import windgramPanelCss from './styles/windgram-panel.css?inline';
import {
  DEFAULT_MULTI_DAY_SPAN,
  DEFAULT_POINT_VIEW_MODE,
  findBestSoaringDayKey,
  formatDayWindowLabel,
  formatShortDayLabel,
  POINT_VIEW_MODE_SPECS,
  resolveInitialWindowStartKey,
  resolveStitchedDayWindow,
  type PointViewMode,
} from './point-view-mode.ts';
import { renderPointSeries } from './scalar-point.ts';
import { renderWindgramKey } from './svg.ts';
import { DEFAULT_WINDGRAM_FIELD_MODE, type WindgramFieldMode } from './windgram-atmosphere.ts';
import { findVisibleChartHourIndex } from './windgram-dom.ts';
import { clamp } from './windgram-format.ts';
import { readWindgram } from './windgram-inspector.ts';
import { formatWindgramHourStamp, formatWindgramReading, type WindgramTelemetryStrip } from './windgram-readout.ts';
import { daylightForDate } from './windgram-time-axis.ts';

const STYLE_ID = 'av-windgram-document-style';

function ensureDocumentStyles(owner: Document): void {
  adoptDocumentStyleSheet(owner, STYLE_ID, windgramPanelCss);
}

export interface PointWindgramOptions {
  readonly point: GeoPoint;
  readonly frameId: string | null;
  readonly mapFrameId?: string | null;
  readonly unitSystem: UnitSystem;
  readonly timeZone?: string;
  readonly totalFrames?: number;
  readonly loading?: boolean;
  readonly mapOffsetMinutes?: number;
  readonly calloutVariant?: WindgramCalloutVariant;
  readonly calloutTrigger?: WindgramCalloutTrigger;
  readonly fieldMode?: WindgramFieldMode;
  readonly viewMode?: PointViewMode;
  readonly onViewModeChange?: (mode: PointViewMode) => void;
  readonly onRequestFullHorizon?: () => void;
  readonly onVisibleDaysChange?: (days: readonly string[] | null) => void;
  onFrame(id: string): void;
}

type Update = (frameId: string | null, units?: UnitSystem, mapFrameId?: string | null, loading?: boolean, mapOffsetMinutes?: number) => void;
type FrameRef = { readonly id: string; readonly validTime: string };
type DayHour = { readonly id: string; readonly validAt: string };
type PointWindgramInput = Pick<PointSeries, 'frames' | 'siteTerrain'>;

interface PointWindgramState {
  readonly section: HTMLElement;
  readonly build: PinnedBuild;
  readonly point: GeoPoint;
  readonly update: Update;
  refresh(input: PointWindgramInput, options: PointWindgramOptions): void;
  dispose(): void;
}

interface Calendar {
  frames: readonly FrameRef[];
  frameIdByValidTime: ReadonlyMap<string, string>;
  days: ReadonlyMap<string, readonly DayHour[]>;
  dayKeys: readonly string[];
}

interface Data extends Calendar {
  loaded: ReadonlyMap<string, PointFrame>;
  forecast: SiteForecast;
  siteTerrainKey: string;
  bestDayKey: string | null;
  daylightDayCount: number;
  hasSounding: boolean;
  hasValues: boolean;
  partial: boolean;
}

function groupFrames(frames: readonly FrameRef[], timeZone: string): Calendar {
  const frameIdByValidTime = new Map<string, string>();
  const days = new Map<string, DayHour[]>();
  const references = frames.map(({ id, validTime }) => {
    frameIdByValidTime.set(validTime, id);
    const key = localDateKey(validTime, timeZone);
    const hour = { id, validAt: validTime };
    const hours = days.get(key);
    if (hours) hours.push(hour);
    else days.set(key, [hour]);
    return { id, validTime };
  });
  return { frames: references, frameIdByValidTime, days, dayKeys: [...days.keys()] };
}

function localMinutesOfDay(ms: number, timeZone: string): number {
  const shifted = new Date(ms + timeZoneOffsetMinutesAt(ms, timeZone) * 60_000);
  return shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
}

function pickRepresentativeFrameInDay(
  dayHours: readonly DayHour[],
  currentValidTime: string | null,
  timeZone: string,
): string | null {
  if (!dayHours.length) return null;
  const currentMs = currentValidTime ? Date.parse(currentValidTime) : NaN;
  const targetMinutes = Number.isFinite(currentMs) ? localMinutesOfDay(currentMs, timeZone) : 14 * 60;
  let best = dayHours[0]!;
  let bestDist = Infinity;
  for (const candidate of dayHours) {
    const ms = Date.parse(candidate.validAt);
    if (!Number.isFinite(ms)) continue;
    const dist = Math.abs(localMinutesOfDay(ms, timeZone) - targetMinutes);
    if (dist < bestDist) {
      bestDist = dist;
      best = candidate;
    }
  }
  return best.id;
}

function formatSplitClocks(
  point: GeoPoint,
  explicitTimeZone: string | undefined,
  isUtcFallback: boolean,
  pointValidTime: string | null,
  pointOffsetMinutes: number,
  mapValidTime: string | null,
  mapOffsetMinutes: number,
): string {
  if (!pointValidTime) return 'Point time unavailable';
  if (!isUtcFallback) {
    return formatPointMapTimes(
      { validTime: pointValidTime, offsetMinutes: pointOffsetMinutes },
      mapValidTime ? { validTime: mapValidTime, offsetMinutes: mapOffsetMinutes } : null,
    );
  }
  const pointMs = Date.parse(pointValidTime);
  const pointStamp = formatSitePlaceTime(pointMs, point, 'stamp', explicitTimeZone);
  if (!mapValidTime) return `Point: ${pointStamp} · Map: unavailable`;
  const mapMs = Date.parse(mapValidTime);
  if (pointMs === mapMs && mapOffsetMinutes === 0) return `Point and map: ${pointStamp}`;
  const mapStamp = mapOffsetMinutes === 0
    ? formatSitePlaceTime(mapMs, point, 'stamp', explicitTimeZone)
    : formatPlaceTime(mapMs, mapOffsetMinutes, 'stamp');
  return `Point: ${pointStamp} · Map: ${mapStamp}`;
}

const states = new WeakMap<HTMLElement, PointWindgramState>();
let nextPanelId = 0;

function createPointWindgram(
  container: HTMLElement,
  input: PointWindgramInput,
  build: PinnedBuild,
  options: PointWindgramOptions,
): PointWindgramState {
  const owner = container.ownerDocument;
  const browser = owner.defaultView;
  const node = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] => {
    const el = owner.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  };
  ensureDocumentStyles(owner);
  const { layers: liftLayers, frames: mapFrames } = pointLiftExpectation(build);
  const manifestFrameById = new Map(build.manifest.frames.map(frame => [frame.id, frame]));
  const usesDsm = build.manifest.surfaces.some(surface => surface.kind === 'fine' && surface.terrain?.surface === 'DSM');
  const toForecast = createPointForecast(build, options.point, {
    timeZone: options.timeZone,
    siteTerrain: input.siteTerrain,
  });

  // Full manifest calendar lets us know immediately whether 2+ daylight forecast days exist in this model run.
  const initialProbeForecast = toForecast([], new Map(), input.siteTerrain);
  const initialProbeSite = initialProbeForecast.site;
  const manifestCalendar = groupFrames(build.manifest.frames, initialProbeSite.timeZone);
  const countDaylightDays = (cal: Calendar): number => {
    let count = 0;
    for (const dayKey of cal.dayKeys) {
      const hours = cal.days.get(dayKey);
      if (!hours?.length) continue;
      const daylight = daylightForDate(initialProbeForecast, dayKey, initialProbeSite.timeZone);
      if (!daylight) { count++; continue; }
      const firstMs = Date.parse(hours[0]!.validAt);
      const lastMs = Date.parse(hours.at(-1)!.validAt);
      if (firstMs <= daylight.sunset && lastMs >= daylight.sunrise) count++;
    }
    return count;
  };
  const supportsMultiDay = countDaylightDays(manifestCalendar) > 1;

  let grouped: Calendar | undefined;
  let derivedMemo: {
    frames: readonly PointFrame[];
    totalFrames: number | undefined;
    siteTerrain: PointTerrain | null | undefined;
    data: Data;
  } | null = null;
  const derive = (nextInput: PointWindgramInput, nextOptions: PointWindgramOptions): Data => {
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
    const bestDayKey = findBestSoaringDayKey(calendar.dayKeys, calendar.days, forecastMap);
    const siteTerrainKey = nextInput.siteTerrain
      ? `${nextInput.siteTerrain.status}:${nextInput.siteTerrain.elevationM ?? 'null'}`
      : '';

    const result: Data = {
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
  let data = derive(input, options);

  const section = node('section', 'av-point-series av-windgram-panel');
  const idPrefix = `av-point-windgram-${++nextPanelId}`;
  const time = node('p', 'av-point-time');
  const liftSummary = node('p', 'av-windgram-lift-summary');
  const profileStatus = node('p', 'av-windgram-profile-status');
  profileStatus.role = 'status';
  const incomplete = node('p', 'av-point-incomplete', 'Forecast incomplete. Some hours could not be loaded.');
  incomplete.role = 'status';
  const chartHost = node('div', 'av-windgram-host');

  const srReadout = node('p', 'windgram-readout');
  srReadout.id = `${idPrefix}-readout`;

  // Chip-free 1-line bottom bar: [ (1-Day | 3-Day) + (‹ Day/Window ›) + conditional ↺ TOL ] ... [ Key ⓘ ]
  const bar = node('div', 'av-windgram-bar');
  const navRow = node('div', 'av-windgram-nav');

  const scopeGroup = node('div', 'wg-scope-seg');
  scopeGroup.role = 'group';
  scopeGroup.ariaLabel = 'Forecast view';
  const modeButtons = new Map<PointViewMode, HTMLButtonElement>();
  for (const spec of POINT_VIEW_MODE_SPECS) {
    const btn = node('button', 'wg-scope-btn', spec.label);
    btn.type = 'button';
    btn.ariaLabel = spec.ariaLabel;
    btn.setAttribute?.('data-point-view', spec.id);
    modeButtons.set(spec.id, btn);
    scopeGroup.append(btn);
  }
  scopeGroup.hidden = !supportsMultiDay;

  const stepper = node('div', 'wg-day-stepper');
  stepper.role = 'group';
  stepper.ariaLabel = 'Forecast day navigation';
  const stepPrevBtn = node('button', 'wg-step-btn', '‹');
  stepPrevBtn.type = 'button';
  const stepLabelEl = node('span', 'wg-step-label');
  const stepNextBtn = node('button', 'wg-step-btn', '›');
  stepNextBtn.type = 'button';
  stepper.append(stepPrevBtn, stepLabelEl, stepNextBtn);

  const snapTolBtn = node('button', 'wg-chip is-alt', '↺ TOL');
  snapTolBtn.type = 'button';
  snapTolBtn.title = 'Return cursor to Top of Lift';
  snapTolBtn.hidden = true;

  navRow.append(scopeGroup, stepper, snapTolBtn);

  const keyPop = node('details', 'av-windgram-key-pop');
  keyPop.addEventListener('toggle', () => {
    if (!keyPop.open) return;
    const siblingInfo = container.parentElement?.querySelector?.<HTMLDetailsElement>('#point-settings[open]');
    if (siblingInfo) siblingInfo.open = false;
  });
  const keySummary = node('summary', 'av-windgram-key-btn');
  keySummary.ariaLabel = 'Visual chart key';
  const keyIcon = node('span', 'av-windgram-key-glyph');
  keyIcon.setAttribute?.('aria-hidden', 'true');
  keyIcon.innerHTML =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 12 12" width="11" height="11" aria-hidden="true">' +
    '<rect x="1" y="1.5" width="10" height="2.2" rx="1" fill="#38bdf8"/>' +
    '<rect x="1" y="4.9" width="10" height="2.2" rx="1" fill="#facc15"/>' +
    '<rect x="1" y="8.3" width="10" height="2.2" rx="1" fill="#f97316"/>' +
    '</svg>';
  keySummary.append(keyIcon, node('span', undefined, 'Key'));
  const keyCard = node('div', 'av-windgram-key');
  keyPop.append(keySummary, keyCard);
  bar.append(navRow, keyPop);

  section.append(chartHost, liftSummary, time, profileStatus, incomplete, srReadout, bar);
  container.replaceChildren(section);

  const resolvePointOffsetMinutes = (validIso?: string | null): number => {
    const ms = validIso ? Date.parse(validIso) : NaN;
    return Number.isFinite(ms) ? timeZoneOffsetMinutesAt(ms, initialProbeSite.timeZone) : 0;
  };

  let units: UnitSystem = options.unitSystem;
  let explicitMapOffset = options.mapOffsetMinutes;
  let loading = options.loading ?? false;
  let selectedFrameId = options.frameId;
  let mapFrameId = options.mapFrameId === undefined ? options.frameId : options.mapFrameId;
  const todayLocalKey = localDateKey(new Date().toISOString(), initialProbeSite.timeZone);
  const initialWindowStartKey = resolveInitialWindowStartKey(manifestCalendar.dayKeys, todayLocalKey);
  let fieldMode: WindgramFieldMode = options.fieldMode ?? DEFAULT_WINDGRAM_FIELD_MODE;
  let viewMode: PointViewMode = supportsMultiDay ? (options.viewMode ?? DEFAULT_POINT_VIEW_MODE) : '1d';
  let windowAnchorKey: string | null = initialWindowStartKey;
  let keepWindowAnchor = true;
  let onFrame = options.onFrame;
  let onViewModeChange = options.onViewModeChange;
  let onRequestFullHorizon = options.onRequestFullHorizon;
  let onVisibleDaysChange = options.onVisibleDaysChange;
  let lastPublishedDaysKey = '';
  let keySignature = '';
  let activeWidth = 0;
  let activeHeight: number | undefined;
  let singleDayCache: { key: string; frames: readonly (PointFrame | undefined)[]; daylight: WindgramView; full?: WindgramView } | null = null;
  let stitchedCache: { key: string; frames: readonly (PointFrame | undefined)[]; view: WindgramView } | null = null;
  let mountedView: WindgramView | null = null;
  let mounted: WindgramMount | null = null;
  let renderEpoch = 0;
  let disposed = false;

  snapTolBtn.addEventListener('click', () => mounted?.snapToTol());

  const publishVisibleDays = (days: readonly string[] | null) => {
    const key = days ? days.join(',') : '';
    if (key === lastPublishedDaysKey) return;
    lastPublishedDaysKey = key;
    onVisibleDaysChange?.(days);
  };

  const paintTelemetry = (telemetry: WindgramTelemetryStrip | null) => {
    if (disposed) return;
    snapTolBtn.hidden = !telemetry?.canSnapToTol;
  };

  const chartHeight = () => {
    const cap = browser?.getComputedStyle?.(chartHost).maxHeight;
    const pixels = cap?.endsWith('px') ? Number(cap.slice(0, -2)) : NaN;
    return Number.isFinite(pixels) ? Math.floor(pixels) : undefined;
  };

  const currentPointValidTime = (): string | null => {
    if (selectedFrameId === null) return null;
    return data.loaded.get(selectedFrameId)?.validTime
      ?? manifestFrameById.get(selectedFrameId)?.validTime
      ?? null;
  };

  const selectDay = (targetDayKey: string) => {
    const dayHours = data.days.get(targetDayKey) ?? manifestCalendar.days.get(targetDayKey);
    if (!dayHours?.length) return;
    if (!data.days.has(targetDayKey)) {
      onRequestFullHorizon?.();
    }
    const targetFrameId = pickRepresentativeFrameInDay(dayHours, currentPointValidTime(), initialProbeSite.timeZone);
    if (targetFrameId && targetFrameId !== selectedFrameId) {
      onFrame(targetFrameId);
    }
  };

  const switchMode = (nextMode: PointViewMode, focusDayKey?: string) => {
    if (disposed || !supportsMultiDay) return;
    const modeChanged = viewMode !== nextMode;
    viewMode = nextMode;
    keepWindowAnchor = false;
    const epochBefore = renderEpoch;
    if (focusDayKey) selectDay(focusDayKey);
    if (!modeChanged && !focusDayKey) return;
    if (modeChanged) {
      if (nextMode === '3d' && data.dayKeys.length < manifestCalendar.dayKeys.length && !onViewModeChange) {
        onRequestFullHorizon?.();
      }
      onViewModeChange?.(nextMode);
    }
    if (renderEpoch === epochBefore) {
      update(selectedFrameId, units, mapFrameId, loading, explicitMapOffset);
    }
  };

  for (const [id, btn] of modeButtons) {
    btn.addEventListener('click', () => switchMode(id));
  }

  stepPrevBtn.addEventListener('click', () => {
    if (disposed) return;
    const timeZone = data.forecast.site.timeZone;
    const validAt = currentPointValidTime();
    const curDay = (validAt && localDateKey(validAt, timeZone)) || data.dayKeys[0];
    if (viewMode === '3d' && data.dayKeys.length > 1) {
      const win = resolveStitchedDayWindow(data.dayKeys, { focusDayKey: curDay, anchorStartKey: windowAnchorKey, keepAnchor: keepWindowAnchor });
      if (!win.canStepPrev) return;
      const nextStartKey = data.dayKeys[win.startIndex - 1]!;
      windowAnchorKey = nextStartKey;
      keepWindowAnchor = true;
      const nextWindow = data.dayKeys.slice(win.startIndex - 1, win.startIndex - 1 + win.windowDays.length);
      if (curDay && !nextWindow.includes(curDay)) {
        selectDay(nextWindow.at(-1)!);
      }
      update(selectedFrameId, units, mapFrameId, loading, explicitMapOffset);
      return;
    }
    const allKeys = manifestCalendar.dayKeys;
    const idx = curDay ? allKeys.indexOf(curDay) : -1;
    if (idx > 0) selectDay(allKeys[idx - 1]!);
  });

  stepNextBtn.addEventListener('click', () => {
    if (disposed) return;
    const timeZone = data.forecast.site.timeZone;
    const validAt = currentPointValidTime();
    const curDay = (validAt && localDateKey(validAt, timeZone)) || data.dayKeys[0];
    if (viewMode === '3d') {
      if (data.dayKeys.length < manifestCalendar.dayKeys.length) {
        onRequestFullHorizon?.();
      }
      const keys = data.dayKeys.length > 1 ? data.dayKeys : manifestCalendar.dayKeys;
      const win = resolveStitchedDayWindow(keys, { focusDayKey: curDay, anchorStartKey: windowAnchorKey, keepAnchor: keepWindowAnchor });
      if (!win.canStepNext) return;
      const nextStartKey = keys[win.startIndex + 1]!;
      windowAnchorKey = nextStartKey;
      keepWindowAnchor = true;
      const nextWindow = keys.slice(win.startIndex + 1, win.startIndex + 1 + win.windowDays.length);
      if (curDay && !nextWindow.includes(curDay)) {
        selectDay(nextWindow[0]!);
      }
      update(selectedFrameId, units, mapFrameId, loading, explicitMapOffset);
      return;
    }
    const allKeys = manifestCalendar.dayKeys;
    const idx = curDay ? allKeys.indexOf(curDay) : -1;
    if (idx >= 0 && idx < allKeys.length - 1) selectDay(allKeys[idx + 1]!);
  });

  const dayViews = (dayKey: string, hours: readonly DayHour[], widthPx: number, heightPx: number | undefined) => {
    const frames = hours.map(hour => data.loaded.get(hour.id));
    const key = `${dayKey}|${units}|${fieldMode}|${widthPx}|${heightPx}|${hours.length}|${data.siteTerrainKey}`;
    if (singleDayCache?.key !== key || singleDayCache.frames.some((frame, i) => frame !== frames[i])) {
      const timeZone = data.forecast.site.timeZone;
      const daylight = buildWindgramView(data.forecast, {
        unitSystem: units, fieldMode, timeZone, widthPx, heightPx, compact: true, heightRange: 'soaring', hours: { timeZone, dateKey: dayKey },
      });
      singleDayCache = { key, frames, daylight };
    }
    return singleDayCache;
  };

  const stitchedDayViews = (
    windowDays: readonly string[],
    selectedDayKey: string | undefined,
    bestDayKey: string | null,
    widthPx: number,
    heightPx: number | undefined,
  ): WindgramView => {
    const frames = windowDays.flatMap(d => (data.days.get(d) ?? []).map(h => data.loaded.get(h.id)));
    const key = `${windowDays.join(',')}|${bestDayKey ?? ''}|${units}|${fieldMode}|${widthPx}|${heightPx}|${frames.length}|${data.siteTerrainKey}`;
    if (stitchedCache?.key !== key || stitchedCache.frames.some((frame, i) => frame !== frames[i])) {
      const view = buildStitchedWindgramView(data.forecast, {
        unitSystem: units,
        fieldMode,
        timeZone: data.forecast.site.timeZone,
        widthPx,
        heightPx,
        compact: true,
        heightRange: 'soaring',
        dateKeys: windowDays,
        selectedDateKey: selectedDayKey ?? null,
        bestDateKey: bestDayKey,
      });
      stitchedCache = { key, frames, view };
    }
    return stitchedCache.view;
  };

  const step = (delta: -1 | 1) => {
    if (disposed || !data.frames.length) return;
    const timeZone = data.forecast.site.timeZone;
    const navigable = data.dayKeys.flatMap(dayKey => {
      const hours = data.days.get(dayKey) ?? [];
      const daylight = daylightForDate(data.forecast, dayKey, timeZone);
      if (!daylight) return hours;
      const inDaylight = hours.filter(h => {
        const ms = Date.parse(h.validAt);
        return ms >= daylight.sunrise && ms <= daylight.sunset;
      });
      return inDaylight.length >= Math.min(2, hours.length) && inDaylight.length > 0 ? inDaylight : hours;
    });
    const list: readonly DayHour[] = navigable.length
      ? navigable
      : data.frames.map(f => ({ id: f.id, validAt: f.validTime }));
    const curMs = Date.parse(currentPointValidTime() ?? '');
    const exactIndex = list.findIndex(frame => frame.id === selectedFrameId);
    let target: DayHour | undefined;
    if (exactIndex >= 0) {
      const nextIndex = exactIndex + delta;
      if (nextIndex >= 0 && nextIndex < list.length) target = list[nextIndex];
    } else if (Number.isFinite(curMs)) {
      target = delta > 0
        ? list.find(frame => Date.parse(frame.validAt) > curMs)
        : list.findLast(frame => Date.parse(frame.validAt) < curMs);
    }
    if (target && target.id !== selectedFrameId) onFrame(target.id);
  };

  const update: Update = (frameId, nextUnits = units, nextMapFrameId = mapFrameId, nextLoading = loading, nextMapOffset = explicitMapOffset) => {
    if (disposed) return;
    renderEpoch += 1;
    const timeZone = data.forecast.site.timeZone;
    units = nextUnits;
    if (typeof nextMapOffset === 'number') explicitMapOffset = nextMapOffset;
    loading = nextLoading;
    if (selectedFrameId !== null && frameId !== selectedFrameId) keepWindowAnchor = false;
    selectedFrameId = frameId;
    mapFrameId = nextMapFrameId;
    incomplete.hidden = !data.partial || loading;

    const loadedFrame = frameId === null ? undefined : data.loaded.get(frameId);
    const pointFrame = loadedFrame ?? (frameId === null ? undefined : manifestFrameById.get(frameId));
    const mapFrame = mapFrameId === null ? undefined : manifestFrameById.get(mapFrameId);
    const pointOffset = resolvePointOffsetMinutes(pointFrame?.validTime);
    const resolvedMapOffset = explicitMapOffset ?? resolvePointOffsetMinutes(mapFrame?.validTime);
    time.textContent = formatSplitClocks(
      options.point,
      options.timeZone,
      Boolean(initialProbeSite.isUtcFallback),
      pointFrame?.validTime ?? null,
      pointOffset,
      mapFrame?.validTime ?? null,
      resolvedMapOffset,
    );
    time.hidden = !pointFrame || pointFrame.id === mapFrameId;

    const pendingLift = loading && frameId !== null && mapFrames.has(frameId) && liftLayers.some(layer => !loadedFrame?.layers[layer]);
    const lift = pointMapLift(loadedFrame, build);
    liftSummary.textContent = pendingLift ? 'Loading map lift…' : `MSL ${formatMapLiftCell(lift.msl, units)} · AGL ${formatMapLiftCell(lift.agl, units)}`;
    const hasProfile = loadedFrame?.profile?.status === 'valid' && loadedFrame.profile.levels.length > 0;
    profileStatus.hidden = hasProfile;
    profileStatus.textContent = loading && !loadedFrame?.profile ? 'Loading native profile…' : 'Native profile unavailable.';

    const selectedValidAt = pointFrame?.validTime ?? null;
    const selectedDay = selectedValidAt ? localDateKey(selectedValidAt, timeZone) : undefined;
    const targetDayKey = selectedDay && data.days.has(selectedDay) ? selectedDay : data.days.keys().next().value;
    const dayHours = targetDayKey === undefined ? undefined : data.days.get(targetDayKey);
    const showChart = dayHours !== undefined && (data.hasSounding || (!loading && data.hasValues));
    chartHost.hidden = bar.hidden = !showChart;
    liftSummary.hidden = liftLayers.length === 0 || showChart;
    if (!showChart || targetDayKey === undefined) {
      publishVisibleDays(null);
      return;
    }

    const southernHemisphere = options.point.lat < 0;
    const nextKeySig = `${units}|${fieldMode}|${southernHemisphere ? 'S' : 'N'}`;
    if (keySignature !== nextKeySig) {
      keyCard.innerHTML = renderWindgramKey(units, usesDsm, fieldMode, southernHemisphere);
      keySignature = nextKeySig;
    }

    // Update [1-Day | 3-Day] segmented toggle state + Day/Window stepper
    const effectiveMode: PointViewMode = supportsMultiDay && viewMode === '3d' && data.daylightDayCount > 1 ? '3d' : '1d';
    for (const [id, btn] of modeButtons) {
      const active = viewMode === id;
      btn.className = active ? 'wg-scope-btn is-active' : 'wg-scope-btn';
      btn.ariaPressed = String(active);
    }

    const widthPx = chartHost.clientWidth > 0 ? chartHost.clientWidth : 420;
    const heightPx = chartHeight();
    activeWidth = widthPx;
    activeHeight = heightPx;

    let view: WindgramView;
    if (effectiveMode === '3d') {
      const win = resolveStitchedDayWindow(data.dayKeys, {
        focusDayKey: targetDayKey,
        anchorStartKey: windowAnchorKey,
        keepAnchor: keepWindowAnchor,
      });
      if (!keepWindowAnchor || (windowAnchorKey !== null && data.dayKeys.includes(windowAnchorKey))) {
        windowAnchorKey = win.windowDays[0] ?? null;
      }
      stepper.hidden = false;
      stepPrevBtn.disabled = !win.canStepPrev;
      stepPrevBtn.ariaLabel = 'Previous 3-day window';
      stepNextBtn.disabled = !win.canStepNext && data.dayKeys.length >= manifestCalendar.dayKeys.length;
      stepNextBtn.ariaLabel = 'Next 3-day window';
      stepLabelEl.textContent = formatDayWindowLabel(win.windowDays);
      stepLabelEl.className = 'wg-step-label';
      stepLabelEl.title = '';
      stepLabelEl.removeAttribute?.('title');
      publishVisibleDays(win.windowDays);
      view = stitchedDayViews(win.windowDays, targetDayKey, data.bestDayKey, widthPx, heightPx);
    } else {
      const allKeys = manifestCalendar.dayKeys;
      const dayIdx = allKeys.indexOf(targetDayKey);
      stepper.hidden = allKeys.length <= 1;
      stepPrevBtn.disabled = dayIdx <= 0;
      stepPrevBtn.ariaLabel = 'Previous day';
      stepNextBtn.disabled = dayIdx < 0 || dayIdx >= allKeys.length - 1;
      stepNextBtn.ariaLabel = 'Next day';
      const isBest = data.bestDayKey === targetDayKey;
      stepLabelEl.textContent = `${formatShortDayLabel(targetDayKey)}${isBest ? ' ★' : ''}`;
      stepLabelEl.className = isBest ? 'wg-step-label is-best' : 'wg-step-label';
      if (isBest) {
        stepLabelEl.title = '★ Highest daily thermal score in window (peak usable lift height, w*, and surface wind)';
      } else {
        stepLabelEl.title = '';
        stepLabelEl.removeAttribute?.('title');
      }
      publishVisibleDays(viewMode === '3d' ? [targetDayKey] : null);

      const views = dayViews(targetDayKey, dayHours, widthPx, heightPx);
      const daylightView = views.daylight;
      const visibleDayHours = daylightView.hours.filter(hour => hour.x >= daylightView.left && hour.x <= daylightView.left + daylightView.plotWidth);
      const useDaylightCrop = visibleDayHours.length >= Math.min(2, dayHours.length) && visibleDayHours.length > 0;
      view = useDaylightCrop ? daylightView : (views.full ??= buildWindgramView(data.forecast, {
        unitSystem: units, fieldMode, timeZone, widthPx, heightPx, compact: true, heightRange: 'soaring', hours: dayHours,
      }));
    }

    const rawView = sceneData(view);
    const selectedInVisibleChart = findVisibleChartHourIndex(rawView, selectedValidAt) >= 0;
    time.hidden = !pointFrame || (pointFrame.id === mapFrameId && selectedInVisibleChart);

    let offChartReadout: string | null = null;
    if (!selectedInVisibleChart && selectedValidAt !== null && dayHours) {
      const fullView = sceneData(
        dayViews(targetDayKey, dayHours, widthPx, heightPx).full ??= buildWindgramView(data.forecast, {
          unitSystem: units, fieldMode, timeZone, widthPx, heightPx, compact: true, heightRange: 'soaring', hours: dayHours,
        }),
      );
      const fullIdx = fullView.hours.findIndex(hour => hour.validAt === selectedValidAt);
      if (fullIdx >= 0) {
        const fullHour = fullView.hours[fullIdx]!;
        const sourceHour = fullView.sourceHours[fullIdx]!;
        const when = formatWindgramHourStamp(fullView, fullIdx, fullHour.validAt);
        const minFloorM = Math.max(fullView.floorM, sourceHour.mapLift.terrainM ?? sourceHour.modelTerrainM ?? fullView.floorM);
        const tolM = fullHour.usableLiftTopM !== null && fullHour.usableLiftTopM >= fullView.floorM && fullHour.usableLiftTopM <= fullView.topM
          ? fullHour.usableLiftTopM
          : null;
        const inspectM = tolM ?? clamp(minFloorM + 90, minFloorM, fullView.topM);
        const reading = readWindgram(fullView, fullIdx, inspectM);
        offChartReadout = `${when} · ${formatPointMapLift(sourceHour.mapLift, units)} · ${formatWindgramReading(fullView, reading, tolM !== null ? 'height' : 'surface').join(' · ')}`;
      }
    }

    if (!mounted) {
      mounted = mountWindgram(chartHost, {
        view,
        idPrefix,
        readout: srReadout,
        selectedValidAt,
        offChartReadout,
        inspectionMode: 'magnetic',
        calloutVariant: options.calloutVariant,
        calloutTrigger: options.calloutTrigger ?? 'interact',
        onStepHour: step,
        onSelectDay: dateKey => switchMode('1d', dateKey),
        onZoomMode: (direction, dateKey) => {
          if (direction === 'in') switchMode('1d', dateKey);
          else switchMode('3d');
        },
        onTelemetry: paintTelemetry,
        onSelectHour: validAt => {
          const id = data.frameIdByValidTime.get(validAt);
          if (id) onFrame(id);
        },
      });
    } else {
      if (mountedView !== view) mounted.update(view);
      mounted.select(selectedValidAt, offChartReadout);
    }
    mountedView = view;
  };

  const refresh = (nextInput: PointWindgramInput, nextOptions: PointWindgramOptions) => {
    data = derive(nextInput, nextOptions);
    onFrame = nextOptions.onFrame;
    onViewModeChange = nextOptions.onViewModeChange;
    onRequestFullHorizon = nextOptions.onRequestFullHorizon;
    onVisibleDaysChange = nextOptions.onVisibleDaysChange;
    if (nextOptions.fieldMode !== undefined) {
      fieldMode = nextOptions.fieldMode;
    }
    if (nextOptions.viewMode !== undefined && supportsMultiDay) {
      viewMode = nextOptions.viewMode;
    }
    if (typeof nextOptions.mapOffsetMinutes === 'number') explicitMapOffset = nextOptions.mapOffsetMinutes;
    update(nextOptions.frameId, nextOptions.unitSystem, nextOptions.mapFrameId, nextOptions.loading, explicitMapOffset);
  };

  if (viewMode === '3d' && data.dayKeys.length < Math.min(DEFAULT_MULTI_DAY_SPAN, manifestCalendar.dayKeys.length)) {
    onRequestFullHorizon?.();
  }
  update(selectedFrameId, units, mapFrameId, loading);

  const resize = () => {
    if (disposed || container.children[0] !== section || chartHost.clientWidth <= 0) return;
    if (chartHost.clientWidth !== activeWidth || chartHeight() !== activeHeight) update(selectedFrameId, units, mapFrameId, loading);
  };
  browser?.addEventListener('resize', resize);
  const observer = browser?.ResizeObserver ? new browser.ResizeObserver(resize) : null;
  observer?.observe(chartHost);

  const state: PointWindgramState = {
    section,
    build,
    point: options.point,
    update,
    refresh,
    dispose() {
      if (disposed) return;
      disposed = true;
      publishVisibleDays(null);
      keyPop.open = false;
      browser?.removeEventListener('resize', resize);
      observer?.disconnect();
      mounted?.dispose();
      mounted = null;
    },
  };
  return state;
}

export function renderPointWindgram(
  container: HTMLElement,
  input: PointWindgramInput,
  build: PinnedBuild,
  options: PointWindgramOptions,
): Update {
  if (!hasNativeProfiles(build)) {
    disposePointWindgram(container);
    return renderPointSeries(container, { frames: input.frames }, build, options);
  }
  const existing = states.get(container);
  if (existing && existing.build === build && samePoint(existing.point, options.point) && container.children[0] === existing.section) {
    existing.refresh(input, options);
    return existing.update;
  }
  disposePointWindgram(container);
  const state = createPointWindgram(container, input, build, options);
  states.set(container, state);
  return state.update;
}

export function disposePointWindgram(container: HTMLElement): void {
  states.get(container)?.dispose();
  states.delete(container);
}
