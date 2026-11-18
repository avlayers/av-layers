import { formatMapLiftCell, formatPlaceTime, formatPointMapLift } from '@av/client';
import { getWindgramCalloutRenderer, type WindgramCalloutVariant } from './windgram-callout.ts';
import { renderWindgramSvg } from './windgram-chart.ts';
import { clamp, formatQuantity, svgNumber as fmt } from './windgram-format.ts';
import { buildWindgramTelemetry, formatWindgramReading, type WindgramTelemetryStrip } from './windgram-readout.ts';
import { heightToY, yToHeight } from './windgram-scale.ts';
import { readWindgram } from './windgram-inspector.ts';
import { hourX, visibleWindgramHourIndices } from './windgram-time-axis.ts';
import type { WindgramView } from './windgram-view.ts';

export type WindgramInspectionMode = 'magnetic' | 'lift' | 'height';

export interface WindgramMountOptions {
  /** Unique among charts in the host document. */
  idPrefix: string;
  readout?: HTMLElement | null;
  onSelectHour?: (validAt: string) => void;
  onStepHour?: (delta: -1 | 1) => void;
  onTelemetry?: (telemetry: WindgramTelemetryStrip | null) => void;
  selectedValidAt?: string | null;
  /** 'magnetic' snaps within 16px of Top of Lift while allowing free-altitude inspection anywhere else. */
  inspectionMode?: WindgramInspectionMode;
  /** Pluggable floating hover callout renderer ('tile-2x2' default, 'classic' fallback). */
  calloutVariant?: WindgramCalloutVariant;
}

const TOL_SNAP_PX = 16;

type WindgramInspector = (() => void) & {
  /** Show an hour, or clear inspection with null. */
  select(hourIndex: number | null): void;
  /** Re-snap the active or selected hour back onto Top of Lift. */
  snapToTol(): void;
};

interface CachedSvgGeometry {
  readonly inverse: DOMMatrix;
  readonly bounds: { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number };
  readonly vw: number;
  readonly vh: number;
}

/** Inspect the published lift ceiling, free physical height, or magnetic Top-of-Lift + free height. */
function mountWindgramInspector(
  host: HTMLElement,
  readout: HTMLElement | null,
  view: WindgramView,
  onSelectHour?: (validAt: string) => void,
  selectedHourIndex?: () => number,
  options: {
    mode?: WindgramInspectionMode;
    calloutVariant?: WindgramCalloutVariant;
    onStepHour?: (delta: -1 | 1) => void;
    onTelemetry?: (telemetry: WindgramTelemetryStrip | null) => void;
  } = {},
): WindgramInspector {
  const system = view.unitSystem;
  const svg = host.querySelector?.<SVGSVGElement>('svg.windgram') ?? null;
  const visibleHours = visibleWindgramHourIndices(view, 0);
  if (!visibleHours.length) {
    return Object.assign(() => {}, { select: (_index: number | null) => {}, snapToTol: () => {} });
  }
  const mode: WindgramInspectionMode = options.mode ?? 'lift';
  const heightMode = mode === 'height';
  const magneticMode = mode === 'magnetic';
  const freeCapable = heightMode || magneticMode;
  const ownerDocument = host.ownerDocument ?? (typeof document !== 'undefined' ? document : undefined);
  const cursor = svg?.querySelector<SVGGElement>('[data-windgram-cursor]') ?? null;
  const vertical = svg?.querySelector<SVGLineElement>('[data-cursor-vertical]') ?? null;
  const horizontal = svg?.querySelector<SVGLineElement>('[data-cursor-horizontal]') ?? null;
  const tolRing = svg?.querySelector<SVGCircleElement>('[data-cursor-tol-ring]') ?? null;
  const point = svg?.querySelector<SVGCircleElement>('[data-cursor-point]') ?? null;
  const callout = svg?.querySelector<SVGGElement>('[data-cursor-readout]') ?? null;
  const calloutBack = svg?.querySelector<SVGRectElement>('[data-cursor-back]') ?? null;
  const boundCallout = getWindgramCalloutRenderer(options.calloutVariant).bind(svg);

  const originalAttributes = new Map(['tabindex', 'role', 'aria-label', 'aria-describedby'].map((key) => [key, host.getAttribute?.(key) ?? null]));
  const readoutAttributes = new Map(['role', 'aria-live', 'aria-atomic'].map((key) => [key, readout?.getAttribute?.(key) ?? null]));
  const interactionLabel = magneticMode
    ? 'Interactive windgram. Hover, tap, or drag to inspect any height, with magnetic snap on Top of Lift. Left and right arrows change hour; up and down adjust height. Escape clears the selection.'
    : heightMode
      ? 'Interactive windgram. Hover or tap to inspect height. Left and right arrows change hour; up and down change height. Escape clears the selection.'
      : 'Interactive windgram. Hover or tap an hour for lift top AGL. Left and right arrows change hour. Escape clears the selection.';
  host.tabIndex = 0;
  host.setAttribute?.('role', 'group');
  host.setAttribute?.('aria-label', interactionLabel);
  if (readout?.id) host.setAttribute?.('aria-describedby', readout.id);
  readout?.setAttribute?.('role', 'status');
  readout?.setAttribute?.('aria-live', 'polite');
  readout?.setAttribute?.('aria-atomic', 'true');
  const instructions = `${freeCapable ? 'Hover or drag to inspect height' : 'Hover for lift top'} · click or tap to pin · left/right arrows change hour${freeCapable ? ' · up/down changes height' : ''} · Escape clears`;
  let activeHour: number | null = null;
  let activeHeightM: number | null = null;
  let snappedToTol = !heightMode;
  let pinned = false;
  let pointerStart: { x: number; y: number; id: number; moved: boolean } | null = null;
  let cachedGeo: CachedSvgGeometry | null = null;
  let lastText = readout?.textContent ?? '';
  let disposed = false;

  const readGeometry = (): CachedSvgGeometry | null => {
    if (cachedGeo) return cachedGeo;
    const matrix = svg?.getScreenCTM?.() ?? null;
    if (!matrix) return null;
    const bounds = host.getBoundingClientRect();
    const viewport = ownerDocument?.defaultView;
    const geo: CachedSvgGeometry = {
      inverse: matrix.inverse(),
      bounds: { left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom },
      vw: viewport?.innerWidth ?? Infinity,
      vh: viewport?.innerHeight ?? Infinity,
    };
    if (pointerStart) cachedGeo = geo;
    return geo;
  };

  const invalidateGeometry = () => { cachedGeo = null; };

  const minInspectHeightM = (hourIndex: number): number => {
    const source = view.sourceHours[hourIndex];
    const groundM = source?.mapLift.terrainM ?? source?.modelTerrainM ?? view.floorM;
    const modelFloor10M = source?.modelTerrainM !== null && source?.modelTerrainM !== undefined
      ? source.modelTerrainM + 10
      : -Infinity;
    return Math.min(view.topM, Math.max(view.floorM, groundM + 10, modelFloor10M));
  };

  const hasValidTol = (hourIndex: number): number | null => {
    const tol = view.hours[hourIndex]?.usableLiftTopM ?? null;
    return tol !== null && tol >= view.floorM && tol <= view.topM ? tol : null;
  };

  const writeReadout = (text: string, title?: string) => {
    if (text === lastText) return;
    if (readout && title && ownerDocument && typeof ownerDocument.createTextNode === 'function') {
      const strong = ownerDocument.createElement('strong');
      strong.textContent = title;
      readout.replaceChildren(strong, ownerDocument.createTextNode(text.slice(title.length)));
    } else if (readout) {
      readout.textContent = text;
    } else {
      host.setAttribute?.('aria-label', text === instructions ? interactionLabel : `${interactionLabel} ${text}`);
    }
    lastText = text;
  };

  const clear = () => {
    pinned = false;
    activeHour = null;
    cursor?.setAttribute('visibility', 'hidden');
    tolRing?.setAttribute('visibility', 'hidden');
    writeReadout(instructions);
    options.onTelemetry?.(null);
  };

  const update = (
    hourIndex: number,
    keyboard = false,
    inspectedHeightM?: number,
    forceTolSnap?: boolean,
    deferAriaReadout = false,
  ) => {
    const hour = view.hours[hourIndex];
    const lift = view.sourceHours[hourIndex].mapLift;
    const tolM = hasValidTol(hourIndex);
    activeHour = hourIndex;
    const x = hour.x;
    if (keyboard) {
      onSelectHour?.(hour.validAt);
      if (disposed) return;
      const matrix = svg?.getScreenCTM?.() ?? null;
      if (matrix) {
        const screen = new DOMPoint(x, view.top).matrixTransform(matrix);
        const rect = host.getBoundingClientRect();
        const clearance = view.compact ? view.left + 16 : 32;
        if (screen.x < rect.left + clearance) { host.scrollLeft -= rect.left + clearance - screen.x; invalidateGeometry(); }
        else if (screen.x > rect.right - 32) { host.scrollLeft += screen.x - rect.right + 32; invalidateGeometry(); }
      }
    }

    if (magneticMode) {
      if (forceTolSnap === true) snappedToTol = true;
      else if (forceTolSnap === false) snappedToTol = false;
    } else {
      snappedToTol = !heightMode;
    }

    const useTol = magneticMode ? snappedToTol : !heightMode;
    const minFloorM = minInspectHeightM(hourIndex);
    const when = formatPlaceTime(Date.parse(hour.validAt), view.offsetMinutes, 'stamp');
    const heightM = useTol
      ? hour.usableLiftTopM
      : clamp(inspectedHeightM ?? activeHeightM ?? tolM ?? minFloorM + 90, minFloorM, view.topM);
    if (heightM !== null) activeHeightM = heightM;

    if (heightM === null || heightM < view.floorM || heightM > view.topM) {
      cursor?.setAttribute('visibility', 'hidden');
      tolRing?.setAttribute('visibility', 'hidden');
      const reading = readWindgram(view, hourIndex, minFloorM);
      if (!deferAriaReadout) {
        writeReadout(`${when} · ${formatPointMapLift(lift, system)} · ${formatWindgramReading(view, reading, 'surface').join(' · ')}`);
      }
      options.onTelemetry?.(buildWindgramTelemetry(view, reading, lift, true, false));
      return;
    }

    const reading = readWindgram(view, hourIndex, heightM);
    const telemetry = buildWindgramTelemetry(view, reading, lift, useTol, tolM !== null);
    options.onTelemetry?.(telemetry);

    const y = heightToY(view, heightM);
    const setNums = (element: Element | null, values: Record<string, number>) => {
      for (const [key, value] of Object.entries(values)) element?.setAttribute(key, String(fmt(value)));
    };
    setNums(vertical, { x1: x, x2: x, y1: view.top, y2: view.bottom });
    setNums(horizontal, { x1: view.left, x2: view.left + view.plotWidth, y1: y, y2: y });
    setNums(point, { cx: x, cy: y });
    if (tolRing) {
      if (!useTol && tolM !== null) {
        setNums(tolRing, { cx: x, cy: heightToY(view, tolM) });
        tolRing.setAttribute('visibility', 'visible');
      } else {
        tolRing.setAttribute('visibility', 'hidden');
      }
    }
    cursor?.setAttribute('visibility', 'visible');
    const hasAgl = useTol || reading.heightAglM !== null;
    const aglText = !useTol
      ? (hasAgl ? `${formatQuantity(reading.heightAglM, 'elevation', undefined, system)} AGL` : '')
      : `${formatMapLiftCell(lift.agl, system)} AGL`;
    const mslText = `${!useTol ? formatQuantity(reading.heightM, 'elevation', undefined, system) : formatMapLiftCell(lift.msl, system)} MSL`;

    const painted = boundCallout.paint({
      aglText,
      mslText,
      useTol,
      telemetry,
      reading,
      unitSystem: system,
    });

    let visibleLeft = view.left, visibleRight = view.left + view.plotWidth;
    let visibleTop = view.top, visibleBottom = view.bottom;
    const geo = readGeometry();
    if (geo) {
      const topLeft = new DOMPoint(Math.max(0, geo.bounds.left), Math.max(0, geo.bounds.top)).matrixTransform(geo.inverse);
      const bottomRight = new DOMPoint(
        Math.min(geo.vw, geo.bounds.right),
        Math.min(geo.vh, geo.bounds.bottom),
      ).matrixTransform(geo.inverse);
      visibleLeft = Math.max(visibleLeft, topLeft.x);
      visibleRight = Math.min(visibleRight, bottomRight.x);
      visibleTop = Math.max(visibleTop, topLeft.y);
      visibleBottom = Math.min(visibleBottom, bottomRight.y);
    }
    const padding = 4;
    const calloutHeight = painted.height;
    const calloutWidth = Math.min(painted.width, Math.max(0, visibleRight - visibleLeft - padding * 2));
    if (calloutWidth < painted.width) setNums(calloutBack, { width: calloutWidth });
    const calloutX = Math.max(
      visibleLeft + padding,
      Math.min(
        x + 12 + calloutWidth <= visibleRight - padding ? x + 12 : x - 12 - calloutWidth,
        visibleRight - calloutWidth - padding,
      ),
    );
    const calloutY = Math.max(
      visibleTop + padding,
      Math.min(
        y - calloutHeight - 12 >= visibleTop + padding ? y - calloutHeight - 12 : y + 12,
        visibleBottom - calloutHeight - padding,
      ),
    );
    callout?.setAttribute('transform', `translate(${fmt(calloutX)} ${fmt(calloutY)})`);

    if (!deferAriaReadout) {
      const altHeadline = aglText ? `${aglText} · ${mslText}` : mslText;
      const title = `${when} · ${!useTol ? 'Inspected height' : 'Map usable lift'} · ${altHeadline}`;
      const values = formatWindgramReading(view, reading, 'height');
      writeReadout(`${title} · ${values.join(' · ')}`, title);
    }
  };

  const resolvePointer = (event: PointerEvent): { hourIndex: number; heightM?: number; snapTol: boolean } | null => {
    const geo = readGeometry();
    if (!geo) return null;
    const position = new DOMPoint(event.clientX, event.clientY).matrixTransform(geo.inverse);
    if (position.x < view.left || position.x > view.left + view.plotWidth) return null;
    const dataLeft = view.hours[0].x - view.columnWidth / 2;
    const dataRight = view.hours.at(-1)!.x + view.columnWidth / 2;
    if (position.x < dataLeft || position.x > dataRight) return null;
    const hourIndex = visibleHours.reduce((best, index) =>
      Math.abs(view.hours[index].x - position.x) < Math.abs(view.hours[best].x - position.x) ? index : best);
    if (position.y < view.top || position.y > view.bottom) {
      if (magneticMode && position.y >= 0 && position.y <= view.height) {
        return { hourIndex, snapTol: true };
      }
      return null;
    }
    if (magneticMode) {
      const tolM = hasValidTol(hourIndex);
      if (tolM !== null && Math.abs(position.y - heightToY(view, tolM)) <= TOL_SNAP_PX) {
        return { hourIndex, heightM: tolM, snapTol: true };
      }
      const minFloorM = minInspectHeightM(hourIndex);
      const rawM = yToHeight(view, position.y);
      const heightM = rawM <= minFloorM
        ? minFloorM
        : clamp(Math.round(rawM / 2) * 2, minFloorM, view.topM);
      return { hourIndex, heightM, snapTol: false };
    }
    const minFloorM = heightMode ? minInspectHeightM(hourIndex) : view.floorM;
    return { hourIndex, heightM: clamp(yToHeight(view, position.y), minFloorM, view.topM), snapTol: !heightMode };
  };

  const endHover = () => {
    invalidateGeometry();
    if (heightMode) cursor?.setAttribute('visibility', 'hidden');
    else if (activeHour !== null) {
      const selected = selectedHourIndex?.() ?? view.selectedHourIndex;
      if (!visibleHours.includes(selected)) clear();
      else if (selected !== activeHour || (magneticMode && !snappedToTol && !pinned)) {
        snappedToTol = true;
        update(selected, false, undefined, true);
      }
    }
  };

  const onMove = (event: PointerEvent) => {
    const dragging = pointerStart?.id === event.pointerId;
    if (dragging && Math.hypot(event.clientX - pointerStart!.x, event.clientY - pointerStart!.y) > 6) {
      pointerStart!.moved = true;
    }
    if (magneticMode && dragging && pointerStart!.moved) {
      const p = resolvePointer(event);
      if (p) {
        if (!p.snapTol && p.hourIndex === activeHour && !snappedToTol && p.heightM !== undefined && p.heightM === activeHeightM) {
          return;
        }
        pinned = true;
        const prevHour = activeHour;
        update(p.hourIndex, false, p.heightM, p.snapTol, true);
        if (p.hourIndex !== prevHour) onSelectHour?.(view.hours[p.hourIndex].validAt);
      }
      return;
    }
    if (event.pointerType !== 'mouse' || pinned) return;
    const p = resolvePointer(event);
    if (p && (p.heightM !== undefined || !magneticMode)) {
      if (magneticMode && !p.snapTol && p.hourIndex === activeHour && !snappedToTol && p.heightM !== undefined && p.heightM === activeHeightM) {
        return;
      }
      update(p.hourIndex, false, p.heightM, p.snapTol);
    } else {
      endHover();
    }
  };

  const onDown = (event: PointerEvent) => {
    if (event.isPrimary === false) return;
    if (event.button !== undefined && event.button !== 0) return;
    invalidateGeometry();
    pointerStart = { x: event.clientX, y: event.clientY, id: event.pointerId, moved: false };
    if (magneticMode && typeof host.setPointerCapture === 'function' && event.pointerId !== undefined) {
      try { host.setPointerCapture(event.pointerId); } catch { /* synthetic events may lack active pointerId */ }
    }
  };

  const releaseCapture = (pointerId: number | undefined) => {
    if (pointerId !== undefined && typeof host.releasePointerCapture === 'function') {
      try { host.releasePointerCapture(pointerId); } catch { /* ignore */ }
    }
  };

  const onUp = (event: PointerEvent) => {
    const start = pointerStart;
    pointerStart = null;
    invalidateGeometry();
    releaseCapture(event.pointerId);
    if (!start || start.id !== event.pointerId) return;
    if (start.moved) {
      if (activeHour !== null) {
        update(activeHour, false, snappedToTol ? undefined : activeHeightM ?? undefined, snappedToTol, false);
      }
      return;
    }
    if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 10) return;
    const p = resolvePointer(event);
    if (!p) return;
    pinned = true;
    update(p.hourIndex, false, p.heightM, p.snapTol, false);
    onSelectHour?.(view.hours[p.hourIndex].validAt);
  };

  const onCancel = (event: PointerEvent) => {
    pointerStart = null;
    invalidateGeometry();
    releaseCapture(event.pointerId);
  };
  const onLeave = () => {
    if (!pinned) endHover();
    else invalidateGeometry();
  };
  const onBlur = () => {
    invalidateGeometry();
    if (!pinned) return;
    pinned = false;
    if (heightMode) clear();
    else endHover();
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      clear();
      return;
    }
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End', ...(freeCapable ? ['ArrowUp', 'ArrowDown'] : [])].includes(event.key)) return;
    event.preventDefault();
    pinned = true;
    let hourIndex = Math.max(0, selectedHourIndex?.() ?? activeHour ?? view.selectedHourIndex);
    if (event.key === 'ArrowLeft') {
      let previous = visibleHours.length - 1;
      while (previous >= 0 && visibleHours[previous] >= hourIndex) previous--;
      if (previous < 0 && options.onStepHour) { options.onStepHour(-1); return; }
      hourIndex = visibleHours[Math.max(0, previous)];
    }
    if (event.key === 'ArrowRight') {
      const next = visibleHours.find(index => index > hourIndex);
      if (next === undefined && options.onStepHour) { options.onStepHour(1); return; }
      hourIndex = next ?? visibleHours.at(-1)!;
    }
    if (event.key === 'Home') hourIndex = visibleHours[0];
    if (event.key === 'End') hourIndex = visibleHours.at(-1)!;
    if (freeCapable && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      hourIndex = visibleHours.find(index => index >= hourIndex) ?? visibleHours.at(-1)!;
      const minFloorM = minInspectHeightM(hourIndex);
      const base = activeHeightM ?? view.hours[hourIndex].usableLiftTopM ?? minFloorM + 90;
      const nextH = clamp(base + (event.key === 'ArrowUp' ? 100 : -100), minFloorM, view.topM);
      const tolM = hasValidTol(hourIndex);
      if (magneticMode && tolM !== null && Math.abs(heightToY(view, nextH) - heightToY(view, tolM)) <= TOL_SNAP_PX * 0.6) {
        activeHeightM = tolM;
        update(hourIndex, true, tolM, true);
        return;
      }
      activeHeightM = nextH;
      update(hourIndex, true, nextH, false);
      return;
    }
    update(hourIndex, true, magneticMode && !snappedToTol ? activeHeightM ?? undefined : undefined, magneticMode ? snappedToTol : undefined);
  };
  host.addEventListener('pointermove', onMove);
  host.addEventListener('pointerdown', onDown);
  host.addEventListener('pointerup', onUp);
  host.addEventListener('pointercancel', onCancel);
  host.addEventListener('pointerleave', onLeave);
  host.addEventListener('scroll', invalidateGeometry);
  host.addEventListener('keydown', onKey);
  host.addEventListener('blur', onBlur);
  return Object.assign(() => {
    if (disposed) return;
    disposed = true;
    invalidateGeometry();
    host.removeEventListener?.('pointermove', onMove);
    host.removeEventListener?.('pointerdown', onDown);
    host.removeEventListener?.('pointerup', onUp);
    host.removeEventListener?.('pointercancel', onCancel);
    host.removeEventListener?.('pointerleave', onLeave);
    host.removeEventListener?.('scroll', invalidateGeometry);
    host.removeEventListener?.('keydown', onKey);
    host.removeEventListener?.('blur', onBlur);
    for (const [name, value] of originalAttributes) {
      if (value === null) host.removeAttribute?.(name);
      else host.setAttribute?.(name, value);
    }
    for (const [name, value] of readoutAttributes) {
      if (value === null) readout?.removeAttribute?.(name);
      else readout?.setAttribute?.(name, value);
    }
    cursor?.setAttribute('visibility', 'hidden');
    tolRing?.setAttribute('visibility', 'hidden');
  }, {
    select: (index: number | null) => {
      if (disposed) return;
      if (index === null || !visibleHours.includes(index)) clear();
      else update(index, false, magneticMode && !snappedToTol ? activeHeightM ?? undefined : undefined, magneticMode ? snappedToTol : undefined);
    },
    snapToTol: () => {
      if (disposed) return;
      const target = activeHour ?? selectedHourIndex?.() ?? view.selectedHourIndex;
      if (!visibleHours.includes(target)) return;
      snappedToTol = true;
      update(target, false, undefined, true);
    },
  });
}

/** Owns one SVG host; callers own profiles, layout, routing and persisted state. */
export function mountWindgram(host: HTMLElement, options: WindgramMountOptions & { view: WindgramView }) {
  let clearInspector: WindgramInspector | null = null;
  let disposed = false;
  let view = options.view;
  let mode: WindgramInspectionMode | undefined = options.inspectionMode;
  let calloutVariant: WindgramCalloutVariant | undefined = options.calloutVariant;
  let selectedValidAt = options.selectedValidAt === undefined ? view.hours[view.selectedHourIndex]?.validAt ?? null : options.selectedValidAt;
  const select = (validAt: string | null) => {
    if (disposed) return;
    selectedValidAt = validAt;
    const index = validAt ? view.hours.findIndex(hour => hour.validAt === validAt && hour.x >= view.left && hour.x <= view.left + view.plotWidth) : -1;
    clearInspector?.select(index >= 0 ? index : null);
    const cursor = host.querySelector?.<SVGRectElement>('[data-selected-hour]') ?? null;
    if (cursor) {
      cursor.setAttribute('visibility', index >= 0 ? 'visible' : 'hidden');
      if (index >= 0) {
        const left = Math.max(view.left, hourX(view.hours, index - 0.5, view.columnWidth));
        const right = Math.min(view.left + view.plotWidth, hourX(view.hours, index + 0.5, view.columnWidth));
        cursor.setAttribute('x', String(left));
        cursor.setAttribute('width', String(right - left));
      }
    }
  };
  const bindInspector = () => {
    clearInspector?.();
    clearInspector = mountWindgramInspector(host, options.readout ?? null, view, validAt => {
      select(validAt);
      options.onSelectHour?.(validAt);
    }, () => view.hours.findIndex(hour => hour.validAt === selectedValidAt), {
      mode,
      calloutVariant,
      onStepHour: options.onStepHour,
      onTelemetry: options.onTelemetry,
    });
    select(selectedValidAt);
  };
  const update = (next: WindgramView) => {
    if (disposed) return;
    clearInspector?.();
    clearInspector = null;
    view = next;
    host.innerHTML = renderWindgramSvg(view, { idPrefix: options.idPrefix, calloutVariant });
    const svg = host.querySelector?.<SVGSVGElement>('svg.windgram') ?? null;
    const ownerDocument = host.ownerDocument ?? (typeof document !== 'undefined' ? document : undefined);
    if (svg && ownerDocument && typeof ownerDocument.createElementNS === 'function') {
      const selected = ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'rect');
      for (const [key, value] of Object.entries({
        y: view.top, height: view.plotHeight, width: view.columnWidth,
        fill: '#237e81', 'fill-opacity': 0.04, stroke: '#237e81', 'stroke-width': 1,
        'pointer-events': 'none', 'data-selected-hour': '',
      })) selected.setAttribute(key, String(value));
      svg.insertBefore?.(selected, svg.querySelector?.('[data-windgram-cursor]') ?? null);
    }
    bindInspector();
  };
  update(view);
  return {
    update, select,
    snapToTol() {
      if (!disposed) clearInspector?.snapToTol();
    },
    setMode(nextMode: WindgramInspectionMode) {
      if (disposed || mode === nextMode) return;
      mode = nextMode;
      bindInspector();
    },
    setCalloutVariant(nextVariant: WindgramCalloutVariant) {
      if (disposed || calloutVariant === nextVariant) return;
      calloutVariant = nextVariant;
      update(view);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearInspector?.();
      clearInspector = null;
      host.replaceChildren();
    },
  };
}
