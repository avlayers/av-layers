import { formatMapLiftCell, formatPointMapTimes, hasNativeProfiles, longitudeOffsetHours, pointLiftExpectation, pointMapLift, samePoint, type GeoPoint, type PinnedBuild, type PointFrame, type PointSeries, type UnitSystem } from '@av/client';
import { mountWindgram, type WindgramCalloutVariant, type WindgramMount } from './dom.ts';
import { panelStyles } from './panel-styles.ts';
import { renderPointSeries } from './scalar-point.ts';
import { localDateKey } from './internal-meteo.ts';
import { buildWindgramView, createPointForecast, type SiteForecast, type WindgramView } from './model.ts';
import { renderWindgramKey } from './svg.ts';
import type { WindgramTelemetryStrip } from './windgram-readout.ts';

const STYLE_ID = 'av-windgram-document-style';

function ensureDocumentStyles(owner: Document): void {
  if (!owner.head || owner.getElementById?.(STYLE_ID)) return;
  const style = owner.createElement('style');
  style.id = STYLE_ID;
  style.textContent = panelStyles;
  owner.head.append(style);
}

export interface PointWindgramOptions {
  readonly point: GeoPoint;
  readonly frameId: string | null;
  readonly mapFrameId?: string | null;
  readonly unitSystem: UnitSystem;
  readonly totalFrames?: number;
  readonly loading?: boolean;
  readonly mapOffsetMinutes?: number;
  readonly calloutVariant?: WindgramCalloutVariant;
  onFrame(id: string): void;
}

type Update = (frameId: string | null, units?: UnitSystem, mapFrameId?: string | null, loading?: boolean, mapOffsetMinutes?: number) => void;
type FrameRef = { readonly id: string; readonly validTime: string };
type DayHour = { readonly id: string; readonly validAt: string };
type PointWindgramInput = Pick<PointSeries, 'frames'>;

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
}

interface Data extends Calendar {
  loaded: ReadonlyMap<string, PointFrame>;
  forecast: SiteForecast;
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
  return { frames: references, frameIdByValidTime, days };
}

const states = new WeakMap<HTMLElement, PointWindgramState>();
let nextPanelId = 0;

function createPointWindgram(
  container: HTMLElement,
  input: PointWindgramInput,
  build: PinnedBuild,
  options: PointWindgramOptions
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
  const usesDsm = build.manifest.surfaces.some(surface => surface.kind === 'fine' && surface.terrain?.surface === 'DSM');
  const toForecast = createPointForecast(build, options.point);
  let grouped: Calendar | undefined;
  const derive = (nextInput: PointWindgramInput, nextOptions: PointWindgramOptions): Data => {
    const loaded = new Map(nextInput.frames.map(frame => [frame.id, frame]));
    const frames = nextOptions.totalFrames === undefined
      ? build.manifest.frames.filter(frame => loaded.has(frame.id))
      : build.manifest.frames.slice(0, nextOptions.totalFrames);
    const forecast = toForecast(frames, loaded);
    const previous = grouped;
    const calendar = previous && previous.frames.length === frames.length && frames.every(({ id, validTime }, i) => {
      const old = previous.frames[i];
      return old.id === id && old.validTime === validTime;
    }) ? previous : groupFrames(frames, forecast.site.timeZone);
    grouped = calendar;
    return {
      ...calendar, loaded, forecast,
      hasSounding: forecast.hours.some(hour => hour.levels.length > 0),
      hasValues: nextInput.frames.some(frame => Object.values(frame.layers).some(cell => cell.status === 'valid')),
      partial: frames.some(({ id }) => {
        const frame = loaded.get(id);
        return !frame?.profile || (mapFrames.has(id) && liftLayers.some(layer => !frame.layers[layer]));
      })
    };
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

  // Accessible screen-reader live readout + Option A 1-line Telemetry Strip & Key Popover.
  const srReadout = node('p', 'windgram-readout');
  srReadout.id = `${idPrefix}-readout`;
  srReadout.style.cssText = 'position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);border:0';

  const bar = node('div', 'av-windgram-bar');
  const chipsRow = node('div', 'av-windgram-chips');
  const keyPop = node('details', 'av-windgram-key-pop');
  const keySummary = node('summary', 'av-windgram-key-btn');
  keySummary.ariaLabel = 'Visual chart key';
  keySummary.append(node('span', undefined, 'Key '), node('span', undefined, 'ⓘ'));
  const keyCard = node('div', 'av-windgram-key');
  keyPop.append(keySummary, keyCard);
  bar.append(chipsRow, keyPop);

  section.append(chartHost, liftSummary, time, profileStatus, incomplete, srReadout, bar);
  container.replaceChildren(section);

  let units: UnitSystem = options.unitSystem;
  let mapOffsetMinutes = options.mapOffsetMinutes ?? longitudeOffsetHours(options.point.lon) * 60;
  let loading = options.loading ?? false;
  let selectedFrameId = options.frameId;
  let mapFrameId = options.mapFrameId === undefined ? options.frameId : options.mapFrameId;
  let onFrame = options.onFrame;
  let keyUnits: UnitSystem | null = null;
  let activeWidth = 0;
  let activeHeight: number | undefined;
  let viewCache: { key: string; frames: readonly (PointFrame | undefined)[]; daylight: WindgramView; full?: WindgramView } | null = null;
  let mountedView: WindgramView | null = null;
  let mounted: WindgramMount | null = null;
  let disposed = false;
  let lastChipLayoutKey = '';
  let liveAltEl: HTMLElement | null = null;

  const paintTelemetry = (telemetry: WindgramTelemetryStrip | null) => {
    if (disposed) return;
    if (!telemetry) {
      if (lastChipLayoutKey === 'empty') return;
      lastChipLayoutKey = 'empty';
      liveAltEl = null;
      chipsRow.replaceChildren(node('span', 'wg-chip', 'Tap or drag chart to inspect'));
      return;
    }
    const altMode = !telemetry.altChip ? 'none' : telemetry.canSnapToTol ? 'btn' : telemetry.snappedToTol ? 'tol' : 'plain';
    const layoutKey = `${telemetry.timeChip}|${altMode}|${telemetry.chips.join('\u0001')}`;
    if (layoutKey === lastChipLayoutKey && (altMode === 'none' || liveAltEl)) {
      if (liveAltEl && liveAltEl.textContent !== telemetry.altChip) liveAltEl.textContent = telemetry.altChip;
      return;
    }
    lastChipLayoutKey = layoutKey;
    const items: HTMLElement[] = [node('span', 'wg-chip is-time', telemetry.timeChip)];
    if (!telemetry.altChip) {
      liveAltEl = null;
    } else if (telemetry.canSnapToTol) {
      const snapBtn = node('button', 'wg-chip is-alt', telemetry.altChip);
      snapBtn.type = 'button';
      snapBtn.title = 'Return cursor to Top of Lift';
      snapBtn.addEventListener('click', () => mounted?.snapToTol());
      liveAltEl = snapBtn;
      items.push(snapBtn);
    } else {
      const span = node('span', telemetry.snappedToTol ? 'wg-chip is-tol' : 'wg-chip', telemetry.altChip);
      liveAltEl = span;
      items.push(span);
    }
    for (const label of telemetry.chips) items.push(node('span', 'wg-chip', label));
    chipsRow.replaceChildren(...items);
  };

  const chartHeight = () => {
    const cap = browser?.getComputedStyle(chartHost).maxHeight;
    const pixels = cap?.endsWith('px') ? Number(cap.slice(0, -2)) : NaN;
    return Number.isFinite(pixels) ? Math.floor(pixels) : undefined;
  };

  const dayViews = (dayKey: string, hours: readonly DayHour[], widthPx: number, heightPx: number | undefined) => {
    const frames = hours.map(hour => data.loaded.get(hour.id));
    const key = `${dayKey}|${units}|${widthPx}|${heightPx}|${hours.length}`;
    if (viewCache?.key !== key || viewCache.frames.some((frame, i) => frame !== frames[i])) {
      const timeZone = data.forecast.site.timeZone;
      const daylight = buildWindgramView(data.forecast, {
        unitSystem: units, timeZone, widthPx, heightPx, compact: true, heightRange: 'soaring', hours: { timeZone, dateKey: dayKey }
      });
      viewCache = { key, frames, daylight };
    }
    return viewCache;
  };

  const step = (delta: -1 | 1) => {
    if (disposed || !data.frames.length) return;
    const index = data.frames.findIndex(frame => frame.id === selectedFrameId);
    const target = data.frames[Math.max(0, Math.min(data.frames.length - 1, index + delta))];
    if (target.id !== selectedFrameId) onFrame(target.id);
  };

  const update: Update = (frameId, nextUnits = units, nextMapFrameId = mapFrameId, nextLoading = loading, nextMapOffset = mapOffsetMinutes) => {
    if (disposed) return;
    const timeZone = data.forecast.site.timeZone;
    units = nextUnits;
    if (typeof nextMapOffset === 'number') mapOffsetMinutes = nextMapOffset;
    loading = nextLoading;
    selectedFrameId = frameId;
    mapFrameId = nextMapFrameId;
    incomplete.hidden = !data.partial || loading;

    const loadedFrame = frameId === null ? undefined : data.loaded.get(frameId);
    const pointFrame = loadedFrame ?? build.manifest.frames.find(frame => frame.id === frameId);
    const mapFrame = build.manifest.frames.find(frame => frame.id === mapFrameId);
    const pointOffset = longitudeOffsetHours(options.point.lon) * 60;
    time.textContent = formatPointMapTimes(
      pointFrame ? { validTime: pointFrame.validTime, offsetMinutes: pointOffset } : null,
      mapFrame ? { validTime: mapFrame.validTime, offsetMinutes: mapOffsetMinutes } : null
    );
    time.hidden = !pointFrame || pointFrame.id === mapFrameId;

    const pendingLift = loading && frameId !== null && mapFrames.has(frameId) && liftLayers.some(layer => !loadedFrame?.layers[layer]);
    const lift = pointMapLift(loadedFrame, build);
    liftSummary.textContent = pendingLift ? 'Loading map lift…' : `MSL ${formatMapLiftCell(lift.msl, units)} · AGL ${formatMapLiftCell(lift.agl, units)}`;
    const hasProfile = loadedFrame?.profile?.status === 'valid' && loadedFrame.profile.levels.length > 0;
    profileStatus.hidden = hasProfile;
    profileStatus.textContent = loading && !loadedFrame?.profile ? 'Loading native profile…' : 'Native profile unavailable.';

    const selectedValidAt = pointFrame?.validTime ?? null;
    const selectedDay = selectedValidAt && localDateKey(selectedValidAt, timeZone);
    const targetDayKey = selectedDay && data.days.has(selectedDay) ? selectedDay : data.days.keys().next().value;
    const dayHours = targetDayKey === undefined ? undefined : data.days.get(targetDayKey);
    const showChart = dayHours !== undefined && (data.hasSounding || (!loading && data.hasValues));
    chartHost.hidden = bar.hidden = !showChart;
    liftSummary.hidden = liftLayers.length === 0 || showChart;
    if (!showChart || targetDayKey === undefined) return;

    if (keyUnits !== units) {
      keyCard.innerHTML = renderWindgramKey(units, usesDsm);
      keyUnits = units;
    }

    const widthPx = chartHost.clientWidth > 0 ? chartHost.clientWidth : 420;
    const heightPx = chartHeight();
    activeWidth = widthPx;
    activeHeight = heightPx;
    const views = dayViews(targetDayKey, dayHours, widthPx, heightPx), daylightView = views.daylight;
    const visibleDayHours = daylightView.hours.filter(hour => hour.x >= daylightView.left && hour.x <= daylightView.left + daylightView.plotWidth);
    const selectedInDaylight = selectedValidAt === null || visibleDayHours.some(hour => hour.validAt === selectedValidAt);
    const useDaylightCrop = selectedInDaylight && visibleDayHours.length >= Math.min(2, dayHours.length) && visibleDayHours.length > 0;
    const view = useDaylightCrop ? daylightView : (views.full ??= buildWindgramView(data.forecast, {
      unitSystem: units, timeZone, widthPx, heightPx, compact: true, heightRange: 'soaring', hours: dayHours
    }));

    if (!mounted) {
      mounted = mountWindgram(chartHost, {
        view,
        idPrefix,
        readout: srReadout,
        selectedValidAt,
        inspectionMode: 'magnetic',
        calloutVariant: options.calloutVariant,
        onStepHour: step,
        onTelemetry: paintTelemetry,
        onSelectHour: validAt => {
          const id = data.frameIdByValidTime.get(validAt);
          if (id) onFrame(id);
        }
      });
    } else {
      if (mountedView !== view) mounted.update(view);
      mounted.select(selectedValidAt);
    }
    mountedView = view;
  };

  const refresh = (nextInput: PointWindgramInput, nextOptions: PointWindgramOptions) => {
    data = derive(nextInput, nextOptions);
    onFrame = nextOptions.onFrame;
    if (typeof nextOptions.mapOffsetMinutes === 'number') mapOffsetMinutes = nextOptions.mapOffsetMinutes;
    update(nextOptions.frameId, nextOptions.unitSystem, nextOptions.mapFrameId, nextOptions.loading, mapOffsetMinutes);
  };

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
      keyPop.open = false;
      browser?.removeEventListener('resize', resize);
      observer?.disconnect();
      mounted?.dispose();
      mounted = null;
    }
  };
  return state;
}

export function renderPointWindgram(
  container: HTMLElement,
  input: PointWindgramInput,
  build: PinnedBuild,
  options: PointWindgramOptions
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
