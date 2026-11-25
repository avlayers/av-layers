import { formatPlaceTime, formatPointMapTimes, placeDateKey, pointFrameView, seriesTable, type GeoPoint, type PinnedBuild, type PointSeries, type UnitSystem } from '@av/client';
import { formatSitePlaceTime, pointOffsetMinutesAt } from '@av/client/timezone';
import { adoptPanelStyles, elementFactory } from './panel-dom.ts';

function setCssVar(element: HTMLElement, name: string, value: string): void {
  if (typeof element.style.setProperty === 'function') element.style.setProperty(name, value);
  else (element.style as unknown as Record<string, string>)[name] = value;
}

/** Mount one bounded series; frame/unit updates reuse its bars and cached values. */
export function renderPointSeries(
  container: HTMLElement, payload: Pick<PointSeries, 'frames'>, build: PinnedBuild,
  options: { point: GeoPoint; frameId: string | null; mapFrameId?: string | null; mapOffsetMinutes?: number; unitSystem: UnitSystem; totalFrames?: number; loading?: boolean; onFrame(id: string): void }
): (frameId: string | null, units?: UnitSystem, mapFrameId?: string | null, loading?: boolean, mapOffsetMinutes?: number) => void {
  const owner = container.ownerDocument;
  adoptPanelStyles(owner);
  const node = elementFactory(owner);
  const previous = container.querySelector?.<HTMLElement>('.av-point-chart');
  const previousScroll = previous?.scrollLeft ?? 0;
  const previousSelected = previous?.querySelector<HTMLButtonElement>('button[aria-pressed="true"]');
  let followSelection = !previous || previous.clientWidth <= 0 || !previousSelected || previousSelected.value !== options.frameId ||
    (previousSelected.offsetLeft >= previousScroll && previousSelected.offsetLeft + previousSelected.offsetWidth <= previousScroll + previous.clientWidth);
  const focused = previous?.contains(owner.activeElement) ? owner.activeElement as HTMLButtonElement : null;
  const wasOpen = container.querySelector?.<HTMLDetailsElement>('details')?.open ?? false;
  const section = node('section', 'av-point-series');
  const summary = node('p', 'av-point-values');
  const time = node('p', 'av-point-time');
  const incomplete = node('p', 'av-point-incomplete', 'Forecast incomplete. Some hours could not be loaded.');
  incomplete.role = 'status';
  const chart = node('div', 'av-point-chart');
  chart.role = 'group';
  chart.ariaLabel = 'Point forecast times; heights MSL';
  const legend = node('p', 'av-point-legend');
  const details = node('details', 'av-point-details');
  const table = node('div');
  const heading = node('summary', undefined, 'Values and source surfaces');
  details.append(heading, table);
  details.addEventListener('toggle', () => {
    if (!details.open || table.children.length) return;
    const { manifest } = build;
    const layers = Object.keys(payload.frames[0]?.layers ?? {});
    const model = seriesTable(payload, layers, manifest.descriptors.layers);
    const values = node('table'), head = node('tr');
    head.append(...model.headings.map(label => node('th', undefined, label)));
    values.append(head);
    const validColumn = model.headings.indexOf('Valid');
    for (const cells of model.rows) {
      const row = node('tr');
      row.append(...cells.map((text, cell) => node('td', undefined, cell === validColumn ? formatSitePlaceTime(Date.parse(text), options.point, 'stamp') : text)));
      values.append(row);
    }
    table.replaceChildren(values);
  });
  const viewsByUnit: Partial<Record<UnitSystem, ReturnType<typeof pointFrameView>[]>> = {};
  const getViews = (units: UnitSystem) => viewsByUnit[units] ??= payload.frames.map(frame => pointFrameView(frame, build, units));
  const views = getViews(options.unitSystem);
  const knownFloors = views.filter(view => view.terrainM !== null).length;
  legend.textContent = knownFloors === 0 ? 'Heights MSL · Blue lift ceiling marks · Gold LCL · Surface elevation unknown'
    : knownFloors === views.length ? 'Heights MSL · Blue lift bars · Gold LCL · Gray surface elevation'
    : 'Heights MSL · Blue lift bars or ceiling marks · Gold LCL · Gray surface elevation where known';
  if (views.some(view => view.thermalTopM !== null)) legend.textContent += ' · Native thermal top purple';
  const heightValues = views.flatMap(view => [view.terrainM, view.mslM, view.lclM, view.thermalTopM].filter((value): value is number => value !== null));
  const minimum = Math.min(0, ...heightValues), span = Math.max(1, ...heightValues) - minimum;
  const percent = (meters: number) => Math.min(100, Math.max(0, (meters - minimum) / span * 100));
  const positions = new Map(build.manifest.frames.map((frame, index) => [frame.id, index]));
  const elapsed = payload.frames.map((frame, index) => index && positions.get(frame.id) === positions.get(payload.frames[index - 1].id)! + 1
    ? (Date.parse(frame.validTime) - Date.parse(payload.frames[index - 1].validTime)) / 3600000 : 0);
  const offsetAt = (iso: string | undefined) => {
    const ms = iso ? Date.parse(iso) : NaN;
    return Number.isFinite(ms) ? pointOffsetMinutesAt(options.point, ms).offsetMinutes : 0;
  };
  const bars = payload.frames.map((frame, index) => {
    const frameMs = Date.parse(frame.validTime);
    const frameOffset = offsetAt(frame.validTime);
    const prevFrame = index === 0 ? undefined : payload.frames[index - 1]!;
    const localDate = placeDateKey(frameMs, frameOffset);
    const previousDate = prevFrame ? placeDateKey(Date.parse(prevFrame.validTime), offsetAt(prevFrame.validTime)) : '';
    const firstOfDay = index === 0 || localDate !== previousDate;
    const localHour = new Date(frameMs + frameOffset * 60_000).getUTCHours();
    const gapText = elapsed[index] > 1 ? `+${elapsed[index]} h` : '', gapWidth = gapText ? Math.max(24, gapText.length * 6) : 0;
    const button = node('button', firstOfDay ? 'av-point-bar is-day-start' : 'av-point-bar');
    const plot = node('span', 'av-point-plot');
    const hour = node('span', 'av-point-hour', `${firstOfDay && localDate ? `${localDate.slice(5)} ` : ''}${String(localHour).padStart(2, '0')}`);
    button.type = 'button';
    button.value = frame.id;
    if (gapWidth > 0) setCssVar(button, '--gap-width', `${gapWidth}px`);
    const view = views[index];
    if (view.terrainM !== null) {
      const floor = node('span', 'av-point-terrain');
      setCssVar(floor, '--bar-height', `${percent(view.terrainM)}%`);
      plot.append(floor);
    }
    if (view.mslM !== null) {
      const lift = node('span', view.terrainM === null ? 'av-point-ceiling-marker' : 'av-point-lift-bar');
      if (view.terrainM === null) {
        setCssVar(lift, '--bar-bottom', `${percent(view.mslM)}%`);
      } else {
        setCssVar(lift, '--bar-bottom', `${percent(view.terrainM)}%`);
        setCssVar(lift, '--bar-height', `${Math.max(0, percent(view.mslM) - percent(view.terrainM))}%`);
      }
      plot.append(lift);
    }
    if (view.lclM !== null) {
      const lcl = node('span', 'av-point-lcl');
      setCssVar(lcl, '--bar-bottom', `${percent(view.lclM)}%`);
      plot.append(lcl);
    }
    if (view.thermalTopM !== null) {
      const top = node('span', 'av-point-native-top');
      setCssVar(top, '--bar-bottom', `${percent(view.thermalTopM)}%`);
      plot.append(top);
    }
    button.append(plot, hour);
    button.addEventListener('click', () => options.onFrame(frame.id));
    if (gapText) {
      const gap = node('span', 'av-point-gap', gapText);
      gap.ariaHidden = 'true';
      button.append(gap);
    }
    button.addEventListener('keydown', event => {
      const target = event.key === 'ArrowRight' ? index + 1 : event.key === 'ArrowLeft' ? index - 1 : event.key === 'Home' ? 0 : event.key === 'End' ? payload.frames.length - 1 : -1;
      if (target < 0 || target >= payload.frames.length) return;
      event.preventDefault();
      bars[target].focus();
      options.onFrame(payload.frames[target].id);
    });
    chart.append(button);
    return button;
  });
  section.append(chart, time, incomplete, summary, legend, details);
  container.replaceChildren(section);
  chart.scrollLeft = previousScroll;
  details.open = wasOpen;
  let units = options.unitSystem;
  const partial = options.totalFrames === undefined ? options.loading === true : payload.frames.length < options.totalFrames;
  let loading = options.loading ?? partial;
  let selectedFrameId = options.frameId;
  let mapFrameId = options.mapFrameId === undefined ? options.frameId : options.mapFrameId;
  let explicitMapOffset = options.mapOffsetMinutes;
  let labelledUnits: UnitSystem | undefined;
  const update = (frameId: string | null, nextUnits = units, nextMapFrameId = mapFrameId, nextLoading = loading, nextMapOffset = explicitMapOffset) => {
    units = nextUnits;
    if (typeof nextMapOffset === 'number') explicitMapOffset = nextMapOffset;
    loading = nextLoading;
    followSelection ||= frameId !== selectedFrameId;
    selectedFrameId = frameId;
    incomplete.hidden = !partial || loading;
    mapFrameId = nextMapFrameId;
    const currentViews = getViews(units);
    const selectedIndex = payload.frames.findIndex(frame => frame.id === frameId), frame = payload.frames[selectedIndex];
    const pointFrame = frame ?? build.manifest.frames.find(frame => frame.id === frameId);
    const mapFrame = build.manifest.frames.find(frame => frame.id === mapFrameId);
    const pointOffset = offsetAt(pointFrame?.validTime);
    const resolvedMapOffset = explicitMapOffset ?? offsetAt(mapFrame?.validTime);
    time.textContent = formatPointMapTimes(
      pointFrame ? { validTime: pointFrame.validTime, offsetMinutes: pointOffset } : null,
      mapFrame ? { validTime: mapFrame.validTime, offsetMinutes: resolvedMapOffset } : null
    );
    time.hidden = !pointFrame || pointFrame.id === mapFrameId;
    const hasSelection = frame !== undefined;
    summary.textContent = frame ? currentViews[selectedIndex].summary : loading ? 'Loading selected point hour…' : 'Selected point hour unavailable.';
    bars.forEach((bar, index) => {
      const frame = payload.frames[index], selected = frame.id === frameId;
      bar.ariaPressed = String(selected);
      bar.tabIndex = selected || (!hasSelection && index === 0) ? 0 : -1;
      if (labelledUnits !== units) {
        bar.ariaLabel = `${formatPlaceTime(Date.parse(frame.validTime), offsetAt(frame.validTime), 'stamp')}${elapsed[index] > 1 ? ` · ${elapsed[index]} h after previous shown time` : ''} · ${currentViews[index].summary}`;
        bar.title = bar.ariaLabel;
      }
    });
    labelledUnits = units;
    const selected = bars[selectedIndex];
    if (followSelection && selected && chart.clientWidth > 0) {
      const left = selected.offsetLeft, width = selected.offsetWidth;
      if (width > 0 && Number.isFinite(left + width + chart.scrollLeft + chart.clientWidth)) {
        chart.scrollLeft = Math.max(left + width - chart.clientWidth, Math.min(chart.scrollLeft, left));
        followSelection = false;
      }
    }
  };
  update(options.frameId);
  if (focused) bars.find(bar => bar.value === focused.value)?.focus({ preventScroll: true });
  return update;
}
