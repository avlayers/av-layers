// Pointer, touch, and keyboard inspection of a mounted chart: hour selection, magnetic Top-of-Lift snap,
// free-height drag, day zoom gestures, and the live readout.

import { formatMapLiftCell, formatPointMapLift } from '@av/client';
import type { WindgramCalloutVariant } from './windgram-callout.ts';
import { createCursorPainter } from './windgram-cursor.ts';
import { clamp, formatQuantity } from './windgram-format.ts';
import {
  dayBannerKey,
  minInspectHeightM,
  resolveChartPointer,
  TOL_SNAP_PX,
  visibleTolM,
  type WindgramInspectionMode,
} from './windgram-hit-test.ts';
import { readWindgram } from './windgram-inspector.ts';
import { bindAccessibleHost, createLiveReadout } from './windgram-live-readout.ts';
import { panelContainingX, visiblePanelHourIndices } from './windgram-panels.ts';
import {
  buildWindgramTelemetry,
  formatSnappedMapLiftAgl,
  formatWindgramHourStamp,
  formatWindgramReading,
  type WindgramTelemetryStrip,
} from './windgram-readout.ts';
import { heightToY } from './windgram-scale.ts';
import { createScreenGeometry } from './windgram-screen-geometry.ts';
import { visibleWindgramHourIndices } from './windgram-time-axis.ts';
import type { WindgramView } from './windgram-view.ts';

export type WindgramCalloutTrigger = 'always' | 'interact';

export type WindgramInspector = (() => void) & {
  /** Show an hour, or clear inspection with null. */
  select(hourIndex: number | null): void;
  /** Re-snap the active or selected hour back onto Top of Lift. */
  snapToTol(): void;
};

/** Inspect the published lift ceiling, free physical height, or magnetic Top-of-Lift + free height. */
export function mountWindgramInspector(
  host: HTMLElement,
  readout: HTMLElement | null,
  view: WindgramView,
  onSelectHour?: (validAt: string) => void,
  selectedHourIndex?: () => number,
  options: {
    mode?: WindgramInspectionMode;
    calloutVariant?: WindgramCalloutVariant;
    calloutTrigger?: WindgramCalloutTrigger;
    onStepHour?: (delta: -1 | 1) => void;
    onSelectDay?: (dateKey: string) => void;
    onZoomMode?: (direction: 'in' | 'out', dateKey?: string) => void;
    onTelemetry?: (telemetry: WindgramTelemetryStrip | null) => void;
    fallbackReadout?: () => string | null;
  } = {},
): WindgramInspector {
  const system = view.unitSystem;
  const svg = host.querySelector?.<SVGSVGElement>('svg.windgram') ?? null;
  const visibleHours = view.dayPanels?.length
    ? visiblePanelHourIndices(view.dayPanels, view.hours)
    : visibleWindgramHourIndices(view, 0);
  if (!visibleHours.length) {
    return Object.assign(() => {}, { select: (_index: number | null) => {}, snapToTol: () => {} });
  }
  const mode: WindgramInspectionMode = options.mode ?? 'lift';
  const calloutTrigger: WindgramCalloutTrigger = options.calloutTrigger ?? 'always';
  const interactiveOnly = calloutTrigger === 'interact';
  const heightMode = mode === 'height';
  const magneticMode = mode === 'magnetic';
  const freeCapable = heightMode || magneticMode;
  const ownerDocument = host.ownerDocument ?? (typeof document !== 'undefined' ? document : undefined);
  const cursorPainter = createCursorPainter(svg, view, options.calloutVariant);
  const hideFloatingCursor = cursorPainter.hide;

  const interactionLabel = magneticMode
    ? 'Interactive windgram. Hover, tap, or drag to inspect any height, with magnetic snap on Top of Lift. Left and right arrows change hour; up and down adjust height. Escape clears the selection.'
    : heightMode
      ? 'Interactive windgram. Hover or tap to inspect height. Left and right arrows change hour; up and down change height. Escape clears the selection.'
      : 'Interactive windgram. Hover or tap an hour for lift top AGL. Left and right arrows change hour. Escape clears the selection.';
  const restoreAccessibility = bindAccessibleHost(host, readout, interactionLabel);
  const instructions = `${freeCapable ? 'Hover or drag to inspect height' : 'Hover for lift top'} · click or tap to pin · left/right arrows change hour${freeCapable ? ' · up/down changes height' : ''} · Escape clears`;
  let activeHour: number | null = null;
  let activeHeightM: number | null = null;
  let snappedToTol = !heightMode;
  let pinned = false;
  let hovering = false;
  let touchActive = false;
  let pointerStart: { x: number; y: number; id: number; moved: boolean } | null = null;
  const activeTouches = new Map<number, { x: number; y: number }>();
  let pinchStartSpan: number | null = null;
  const geometry = createScreenGeometry(host, svg, ownerDocument);
  const invalidateGeometry = geometry.invalidate;
  const readGeometry = geometry.read;
  const liveReadout = createLiveReadout(host, readout, ownerDocument, interactionLabel, instructions);
  const { write: writeReadout, publish: publishReadout, cancel: cancelPendingReadout, flush: flushPendingReadout } = liveReadout;
  let disposed = false;

  const clear = () => {
    cancelPendingReadout();
    pinned = false;
    hovering = false;
    touchActive = false;
    activeHour = null;
    hideFloatingCursor();
    writeReadout(options.fallbackReadout?.() ?? instructions);
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
    const sourceHour = view.sourceHours[hourIndex];
    const lift = sourceHour.mapLift;
    const tolM = visibleTolM(view, hourIndex);
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

    const minFloorM = minInspectHeightM(view, hourIndex);
    const rawNativeTolM = sourceHour?.nativeUsableLiftTopM ?? null;
    const nativeTolM = rawNativeTolM !== null && rawNativeTolM >= view.floorM && rawNativeTolM <= view.topM
      ? rawNativeTolM
      : null;
    const keyboardMagneticFallback = keyboard && magneticMode && snappedToTol && tolM === null;
    const useTol = (magneticMode ? snappedToTol : !heightMode) && !keyboardMagneticFallback;
    const when = formatWindgramHourStamp(view, hourIndex, hour.validAt);
    const heightM = useTol
      ? hour.usableLiftTopM
      : clamp(inspectedHeightM ?? (keyboardMagneticFallback ? nativeTolM : null) ?? activeHeightM ?? tolM ?? nativeTolM ?? minFloorM + 90, minFloorM, view.topM);
    if (heightM !== null) activeHeightM = heightM;

    if (heightM === null || heightM < view.floorM || heightM > view.topM) {
      hideFloatingCursor();
      const reading = readWindgram(view, hourIndex, minFloorM);
      publishReadout(
        `${when} · ${formatPointMapLift(lift, system)} · ${formatWindgramReading(view, reading, 'surface').join(' · ')}`,
        undefined,
        deferAriaReadout,
      );
      options.onTelemetry?.(buildWindgramTelemetry(view, reading, lift, true, false));
      return;
    }

    const reading = readWindgram(view, hourIndex, heightM);
    const telemetry = buildWindgramTelemetry(view, reading, lift, useTol, tolM !== null);
    options.onTelemetry?.(telemetry);

    const hasAgl = useTol || reading.heightAglM !== null;
    const freeAglSuffix = reading.heightAglReference === 'model' ? 'model AGL' : 'AGL';
    const aglText = !useTol
      ? (hasAgl ? `${formatQuantity(reading.heightAglM, 'elevation', undefined, system)} ${freeAglSuffix}` : '')
      : formatSnappedMapLiftAgl(lift, reading, system, { finePointInterpolated: sourceHour?.finePointInterpolated });
    const srAglText = !useTol
      ? aglText
      : formatSnappedMapLiftAgl(lift, reading, system, {
          finePointInterpolated: sourceHour?.finePointInterpolated,
          includeSiteClearance: true,
        });
    const mslText = `${!useTol ? formatQuantity(reading.heightM, 'elevation', undefined, system) : formatMapLiftCell(lift.msl, system)} MSL`;

    const altHeadline = srAglText ? `${srAglText} · ${mslText}` : mslText;
    const title = `${when} · ${!useTol ? 'Inspected height' : 'Map usable lift'} · ${altHeadline}`;
    const values = formatWindgramReading(view, reading, 'height');
    publishReadout(`${title} · ${values.join(' · ')}`, title, deferAriaReadout);

    // In 'interact' mode, keep the floating callout & crosshairs hidden at rest until pointer/keyboard interaction.
    if (interactiveOnly && !hovering && !pinned) {
      hideFloatingCursor();
      return;
    }

    cursorPainter.paint({ hourIndex, x, heightM, tolM, useTol, aglText, mslText, telemetry, reading, touchActive, readGeometry });
  };

  const resolvePointer = (event: PointerEvent): { hourIndex: number; heightM?: number; snapTol: boolean } | null => {
    const geo = readGeometry();
    if (!geo) return null;
    const position = new DOMPoint(event.clientX, event.clientY).matrixTransform(geo.inverse);
    return resolveChartPointer(view, visibleHours, position, mode);
  };

  const endHover = () => {
    flushPendingReadout();
    hovering = false;
    touchActive = false;
    invalidateGeometry();
    if (heightMode || (interactiveOnly && !pinned)) {
      hideFloatingCursor();
      if (interactiveOnly && !pinned && activeHour !== null) {
        const selected = selectedHourIndex?.() ?? view.selectedHourIndex;
        if (visibleHours.includes(selected)) {
          snappedToTol = true;
          update(selected, false, undefined, true);
        }
      }
    } else if (activeHour !== null) {
      const selected = selectedHourIndex?.() ?? view.selectedHourIndex;
      if (!visibleHours.includes(selected)) clear();
      else if (selected !== activeHour || (magneticMode && !snappedToTol && !pinned)) {
        snappedToTol = true;
        update(selected, false, undefined, true);
      }
    }
  };

  const onMove = (event: PointerEvent) => {
    invalidateGeometry();
    touchActive = event.pointerType === 'touch';
    if (event.pointerType === 'touch' && event.pointerId !== undefined && activeTouches.has(event.pointerId)) {
      activeTouches.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (activeTouches.size === 2 && pinchStartSpan !== null && options.onZoomMode) {
        const pts = [...activeTouches.values()];
        const span = Math.abs(pts[0]!.x - pts[1]!.x);
        if (span > pinchStartSpan * 1.42 && view.dayPanels?.length) {
          const midX = (pts[0]!.x + pts[1]!.x) / 2;
          const geo = readGeometry();
          const svgPt = geo ? new DOMPoint(midX, pts[0]!.y).matrixTransform(geo.inverse) : null;
          const panel = svgPt ? panelContainingX(view.dayPanels, svgPt.x) : null;
          pinchStartSpan = null;
          options.onZoomMode('in', panel?.dateKey);
          return;
        }
        if (span < pinchStartSpan * 0.68 && !view.dayPanels?.length) {
          pinchStartSpan = null;
          options.onZoomMode('out');
          return;
        }
      }
      if (activeTouches.size >= 2) return;
    }

    if (dayBannerKey(event.target)) {
      if (!pinned) endHover();
      return;
    }

    const dragging = pointerStart?.id === event.pointerId;
    if (dragging && Math.hypot(event.clientX - pointerStart!.x, event.clientY - pointerStart!.y) > 6) {
      pointerStart!.moved = true;
    }
    if (magneticMode && dragging && pointerStart!.moved) {
      const p = resolvePointer(event);
      if (p) {
        hovering = true;
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
      const wasHovering = hovering;
      hovering = true;
      if (wasHovering && magneticMode && !p.snapTol && p.hourIndex === activeHour && !snappedToTol && p.heightM !== undefined && p.heightM === activeHeightM) {
        return;
      }
      const prevHour = activeHour;
      update(p.hourIndex, false, p.heightM, p.snapTol, wasHovering && p.hourIndex === prevHour);
    } else {
      endHover();
    }
  };

  const onDown = (event: PointerEvent) => {
    touchActive = event.pointerType === 'touch';
    if (event.pointerType === 'touch' && event.pointerId !== undefined) {
      activeTouches.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (activeTouches.size === 2) {
        const pts = [...activeTouches.values()];
        pinchStartSpan = Math.max(24, Math.abs(pts[0]!.x - pts[1]!.x));
        pointerStart = null;
        return;
      }
    }
    if (event.isPrimary === false) return;
    if (event.button !== undefined && event.button !== 0) return;
    if (dayBannerKey(event.target)) return;
    invalidateGeometry();
    pointerStart = { x: event.clientX, y: event.clientY, id: event.pointerId, moved: false };
    if (magneticMode && typeof host.setPointerCapture === 'function' && event.pointerId !== undefined) {
      try { host.setPointerCapture(event.pointerId); } catch { /* synthetic events may lack active pointerId */ }
    }
  };

  const releaseCapture = (pointerId: number | undefined) => {
    if (pointerId !== undefined) activeTouches.delete(pointerId);
    if (activeTouches.size < 2) pinchStartSpan = null;
    if (pointerId !== undefined && typeof host.releasePointerCapture === 'function') {
      try { host.releasePointerCapture(pointerId); } catch { /* ignore */ }
    }
  };

  const onUp = (event: PointerEvent) => {
    touchActive = event.pointerType === 'touch';
    const dayKey = dayBannerKey(event.target);
    if (dayKey) {
      pointerStart = null;
      releaseCapture(event.pointerId);
      options.onSelectDay?.(dayKey);
      return;
    }
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
    hovering = true;
    pinned = true;
    update(p.hourIndex, false, p.heightM, p.snapTol, false);
    onSelectHour?.(view.hours[p.hourIndex].validAt);
  };

  const onDblClick = (event: MouseEvent) => {
    if (!view.dayPanels?.length || !options.onSelectDay) return;
    const bannerDay = dayBannerKey(event.target);
    if (bannerDay) {
      options.onSelectDay(bannerDay);
      return;
    }
    const geo = readGeometry();
    if (!geo) return;
    const pos = new DOMPoint(event.clientX, event.clientY).matrixTransform(geo.inverse);
    const panel = panelContainingX(view.dayPanels, pos.x);
    if (panel) options.onSelectDay(panel.dateKey);
  };

  const onWheel = (event: WheelEvent) => {
    if (!options.onZoomMode || (!event.altKey && !event.ctrlKey)) return;
    if (Math.abs(event.deltaY) < 4) return;
    event.preventDefault();
    if (event.deltaY < 0 && view.dayPanels?.length) {
      const geo = readGeometry();
      const pos = geo ? new DOMPoint(event.clientX, event.clientY).matrixTransform(geo.inverse) : null;
      const panel = pos ? panelContainingX(view.dayPanels, pos.x) : null;
      options.onZoomMode('in', panel?.dateKey);
    } else if (event.deltaY > 0 && !view.dayPanels?.length) {
      options.onZoomMode('out');
    }
  };

  const onCancel = (event: PointerEvent) => {
    flushPendingReadout();
    pointerStart = null;
    invalidateGeometry();
    releaseCapture(event.pointerId);
  };
  const onLeave = () => {
    flushPendingReadout();
    if (!pinned) endHover();
    else { hovering = false; invalidateGeometry(); }
  };
  const onBlur = () => {
    flushPendingReadout();
    hovering = false;
    touchActive = false;
    invalidateGeometry();
    if (!pinned) return;
    pinned = false;
    if (heightMode) clear();
    else endHover();
  };
  const onKey = (event: KeyboardEvent) => {
    const bannerDay = dayBannerKey(event.target);
    if (bannerDay && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      options.onSelectDay?.(bannerDay);
      return;
    }
    if (event.key === 'Escape') {
      clear();
      return;
    }
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End', ...(freeCapable ? ['ArrowUp', 'ArrowDown'] : [])].includes(event.key)) return;
    event.preventDefault();
    touchActive = false;
    hovering = true;
    pinned = true;
    const explicitSelected = selectedHourIndex?.();
    if (explicitSelected === -1 && activeHour === null && options.onStepHour && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
      options.onStepHour(event.key === 'ArrowLeft' ? -1 : 1);
      return;
    }
    let hourIndex = Math.max(0, (explicitSelected !== undefined && explicitSelected >= 0 ? explicitSelected : undefined) ?? activeHour ?? view.selectedHourIndex);
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
      const minFloorM = minInspectHeightM(view, hourIndex);
      const base = activeHeightM ?? view.hours[hourIndex].usableLiftTopM ?? minFloorM + 90;
      const nextH = clamp(base + (event.key === 'ArrowUp' ? 100 : -100), minFloorM, view.topM);
      const tolM = visibleTolM(view, hourIndex);
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
  const docTarget = ownerDocument as (Document & Partial<EventTarget>) | undefined;
  const winTarget = ownerDocument?.defaultView as (Window & Partial<EventTarget>) | undefined;
  host.addEventListener('pointermove', onMove);
  host.addEventListener('pointerdown', onDown);
  host.addEventListener('pointerup', onUp);
  host.addEventListener('pointercancel', onCancel);
  host.addEventListener('pointerleave', onLeave);
  host.addEventListener('dblclick', onDblClick);
  host.addEventListener('wheel', onWheel, { passive: false });
  host.addEventListener('scroll', invalidateGeometry);
  docTarget?.addEventListener?.('scroll', invalidateGeometry, { capture: true, passive: true });
  winTarget?.addEventListener?.('resize', invalidateGeometry);
  host.addEventListener('keydown', onKey);
  host.addEventListener('blur', onBlur);
  return Object.assign(() => {
    if (disposed) return;
    disposed = true;
    liveReadout.dispose();
    activeTouches.clear();
    invalidateGeometry();
    host.removeEventListener?.('pointermove', onMove);
    host.removeEventListener?.('pointerdown', onDown);
    host.removeEventListener?.('pointerup', onUp);
    host.removeEventListener?.('pointercancel', onCancel);
    host.removeEventListener?.('pointerleave', onLeave);
    host.removeEventListener?.('dblclick', onDblClick);
    host.removeEventListener?.('wheel', onWheel);
    host.removeEventListener?.('scroll', invalidateGeometry);
    docTarget?.removeEventListener?.('scroll', invalidateGeometry, true);
    winTarget?.removeEventListener?.('resize', invalidateGeometry);
    host.removeEventListener?.('keydown', onKey);
    host.removeEventListener?.('blur', onBlur);
    restoreAccessibility();
    hideFloatingCursor();
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
      pinned = false;
      update(target, false, undefined, true);
    },
  });
}
