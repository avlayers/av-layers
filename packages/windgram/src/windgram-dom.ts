import { formatMapLiftCell, formatPointMapLift } from '@av/client';
import {
  getWindgramCalloutRenderer,
  placeWindgramCallout,
  type CalloutHorizontalSide,
  type WindgramCalloutVariant,
} from './windgram-callout.ts';
import { renderWindgramSvg } from './windgram-chart.ts';
import { clamp, formatQuantity, svgNumber as fmt } from './windgram-format.ts';
import {
  buildWindgramTelemetry,
  formatSnappedMapLiftAgl,
  formatWindgramHourStamp,
  formatWindgramReading,
  type WindgramTelemetryStrip,
} from './windgram-readout.ts';
import { heightToY, yToHeight } from './windgram-scale.ts';
import { readWindgram } from './windgram-inspector.ts';
import { hourX, visibleWindgramHourIndices } from './windgram-time-axis.ts';
import type { WindgramDayPanel, WindgramView } from './windgram-view.ts';

export type WindgramInspectionMode = 'magnetic' | 'lift' | 'height';
export type WindgramCalloutTrigger = 'always' | 'interact';

export interface WindgramMountOptions {
  /** Unique among charts in the host document. */
  idPrefix: string;
  readout?: HTMLElement | null;
  onSelectHour?: (validAt: string) => void;
  onStepHour?: (delta: -1 | 1) => void;
  onSelectDay?: (dateKey: string) => void;
  onZoomMode?: (direction: 'in' | 'out', dateKey?: string) => void;
  onTelemetry?: (telemetry: WindgramTelemetryStrip | null) => void;
  selectedValidAt?: string | null;
  /** 'magnetic' snaps within 16px of Top of Lift while allowing free-altitude inspection anywhere else. */
  inspectionMode?: WindgramInspectionMode;
  /** Pluggable floating hover callout renderer ('tile-2x2' default, 'classic' fallback). */
  calloutVariant?: WindgramCalloutVariant;
  /**
   * 'interact' keeps the floating callout hidden at rest until pointer hover, touch/tap,
   * or keyboard navigation so 0% of the chart is covered when opened; 'always' shows it immediately.
   */
  calloutTrigger?: WindgramCalloutTrigger;
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

function panelContainingHour(panels: readonly WindgramDayPanel[] | undefined, hourIndex: number): WindgramDayPanel | null {
  if (!panels?.length) return null;
  return panels.find(p => p.endHourIndex >= p.startHourIndex && hourIndex >= p.startHourIndex && hourIndex <= p.endHourIndex) ?? null;
}

function panelContainingX(panels: readonly WindgramDayPanel[] | undefined, x: number): WindgramDayPanel | null {
  if (!panels?.length) return null;
  return panels.find(p => x >= p.left && x <= p.left + p.width) ?? null;
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
    calloutTrigger?: WindgramCalloutTrigger;
    onStepHour?: (delta: -1 | 1) => void;
    onSelectDay?: (dateKey: string) => void;
    onZoomMode?: (direction: 'in' | 'out', dateKey?: string) => void;
    onTelemetry?: (telemetry: WindgramTelemetryStrip | null) => void;
  } = {},
): WindgramInspector {
  const system = view.unitSystem;
  const svg = host.querySelector?.<SVGSVGElement>('svg.windgram') ?? null;
  const visibleHours = view.dayPanels?.length
    ? view.dayPanels.flatMap(panel => {
        if (panel.endHourIndex < panel.startHourIndex) return [];
        const inPanel: number[] = [];
        for (let idx = panel.startHourIndex; idx <= panel.endHourIndex; idx++) {
          const hx = view.hours[idx]!.x;
          if (hx >= panel.left - 0.5 && hx <= panel.left + panel.width + 0.5) inPanel.push(idx);
        }
        return inPanel;
      })
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
  const cursor = svg?.querySelector<SVGGElement>('[data-windgram-cursor]') ?? null;
  const verticalHalo = svg?.querySelector<SVGLineElement>('[data-cursor-vertical-halo]') ?? null;
  const horizontalHalo = svg?.querySelector<SVGLineElement>('[data-cursor-horizontal-halo]') ?? null;
  const vertical = svg?.querySelector<SVGLineElement>('[data-cursor-vertical]') ?? null;
  const horizontal = svg?.querySelector<SVGLineElement>('[data-cursor-horizontal]') ?? null;
  const tolRing = svg?.querySelector<SVGCircleElement>('[data-cursor-tol-ring]') ?? null;
  const pointHalo = svg?.querySelector<SVGCircleElement>('[data-cursor-point-halo]') ?? null;
  const point = svg?.querySelector<SVGCircleElement>('[data-cursor-point]') ?? null;
  const callout = svg?.querySelector<SVGGElement>('[data-cursor-readout]') ?? null;
  const calloutBack = svg?.querySelector<SVGRectElement>('[data-cursor-back]') ?? null;
  const boundCallout = getWindgramCalloutRenderer(options.calloutVariant).bind(svg);

  // Precompute convective dome ceiling Y samples once per scene for O(1) anti-clobber callout placement.
  const ceilingSamples = view.hours.map((h, i) => {
    const z = h.usableLiftTopM ?? view.sourceHours[i]?.nativeUsableLiftTopM ?? view.sourceHours[i]?.thermalTopM ?? null;
    return {
      x: h.x,
      ceilingY: z !== null && z >= view.floorM && z <= view.topM ? heightToY(view, z) : null,
    };
  });

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
  let hovering = false;
  let touchActive = false;
  let preferredSide: CalloutHorizontalSide = 'right';
  let pointerStart: { x: number; y: number; id: number; moved: boolean } | null = null;
  const activeTouches = new Map<number, { x: number; y: number }>();
  let pinchStartSpan: number | null = null;
  let cachedGeo: CachedSvgGeometry | null = null;
  let geoClearScheduled = false;
  let pendingReadout: { text: string; title?: string } | null = null;
  let readoutFlushTimer: ReturnType<typeof setTimeout> | null = null;
  let lastText = readout?.textContent ?? '';
  let disposed = false;

  const invalidateGeometry = () => {
    cachedGeo = null;
  };

  const readGeometry = (): CachedSvgGeometry | null => {
    const matrix = svg?.getScreenCTM?.() ?? null;
    if (!matrix || typeof host.getBoundingClientRect !== 'function') return null;
    const bounds = host.getBoundingClientRect();
    if (
      cachedGeo &&
      cachedGeo.bounds.left === bounds.left &&
      cachedGeo.bounds.top === bounds.top &&
      cachedGeo.bounds.right === bounds.right &&
      cachedGeo.bounds.bottom === bounds.bottom
    ) {
      return cachedGeo;
    }
    const viewport = ownerDocument?.defaultView;
    const geo: CachedSvgGeometry = {
      inverse: matrix.inverse(),
      bounds: { left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom },
      vw: viewport?.innerWidth ?? Infinity,
      vh: viewport?.innerHeight ?? Infinity,
    };
    cachedGeo = geo;
    if (!geoClearScheduled) {
      geoClearScheduled = true;
      queueMicrotask(() => {
        geoClearScheduled = false;
        cachedGeo = null;
      });
    }
    return geo;
  };

  const minInspectHeightM = (hourIndex: number): number => {
    const source = view.sourceHours[hourIndex];
    const groundM = source?.fineTerrainM ?? source?.modelTerrainM ?? view.floorM;
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

  const cancelPendingReadout = () => {
    pendingReadout = null;
    if (readoutFlushTimer !== null) {
      clearTimeout(readoutFlushTimer);
      readoutFlushTimer = null;
    }
  };

  const flushPendingReadout = () => {
    if (readoutFlushTimer !== null) {
      clearTimeout(readoutFlushTimer);
      readoutFlushTimer = null;
    }
    if (pendingReadout && !disposed) {
      const { text, title } = pendingReadout;
      pendingReadout = null;
      writeReadout(text, title);
    }
  };

  const publishReadout = (text: string, title: string | undefined, defer: boolean) => {
    if (!defer) {
      cancelPendingReadout();
      writeReadout(text, title);
      return;
    }
    pendingReadout = { text, title };
    readoutFlushTimer ??= setTimeout(flushPendingReadout, 60);
  };

  const hideFloatingCursor = () => {
    cursor?.setAttribute('visibility', 'hidden');
    tolRing?.setAttribute('visibility', 'hidden');
  };

  const clear = () => {
    cancelPendingReadout();
    pinned = false;
    hovering = false;
    touchActive = false;
    activeHour = null;
    hideFloatingCursor();
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
    const sourceHour = view.sourceHours[hourIndex];
    const lift = sourceHour.mapLift;
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

    const minFloorM = minInspectHeightM(hourIndex);
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

    const y = heightToY(view, heightM);
    const setNums = (element: Element | null, values: Record<string, number>) => {
      for (const [key, value] of Object.entries(values)) element?.setAttribute(key, String(fmt(value)));
    };
    const panel = panelContainingHour(view.dayPanels, hourIndex);
    const hLeft = panel ? panel.left : view.left;
    const hRight = panel ? panel.left + panel.width : view.left + view.plotWidth;
    setNums(verticalHalo, { x1: x, x2: x, y1: view.top, y2: view.bottom });
    setNums(horizontalHalo, { x1: hLeft, x2: hRight, y1: y, y2: y });
    setNums(vertical, { x1: x, x2: x, y1: view.top, y2: view.bottom });
    setNums(horizontal, { x1: hLeft, x2: hRight, y1: y, y2: y });
    setNums(pointHalo, { cx: x, cy: y });
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
    const visibleSpan = Math.max(0, visibleRight - visibleLeft);
    const mobileScale = visibleSpan > 0 && visibleSpan < 336 ? 0.9 : 1;
    const effectiveWidth = Math.min(painted.width * mobileScale, Math.max(0, visibleSpan - padding * 2));
    const effectiveHeight = painted.height * mobileScale;
    if (effectiveWidth / mobileScale < painted.width) setNums(calloutBack, { width: effectiveWidth / mobileScale });

    const placed = placeWindgramCallout({
      cursorX: x,
      cursorY: y,
      width: effectiveWidth,
      height: effectiveHeight,
      bounds: { left: visibleLeft, top: visibleTop, right: visibleRight, bottom: visibleBottom },
      ceilingSamples,
      preferredSide,
      touchMode: touchActive,
    });
    preferredSide = placed.side;
    callout?.setAttribute(
      'transform',
      mobileScale === 1
        ? `translate(${fmt(placed.x)} ${fmt(placed.y)})`
        : `translate(${fmt(placed.x)} ${fmt(placed.y)}) scale(${mobileScale})`,
    );
  };

  const resolveDayBannerTarget = (target: EventTarget | null): string | null => {
    if (!target || typeof (target as Element).closest !== 'function') return null;
    const banner = (target as Element).closest('[data-windgram-day]');
    return banner?.getAttribute('data-windgram-day') ?? null;
  };

  const resolvePointer = (event: PointerEvent): { hourIndex: number; heightM?: number; snapTol: boolean } | null => {
    const geo = readGeometry();
    if (!geo) return null;
    const position = new DOMPoint(event.clientX, event.clientY).matrixTransform(geo.inverse);
    if (position.x < view.left || position.x > view.left + view.plotWidth) return null;
    let candidateHours = visibleHours;
    if (view.dayPanels?.length) {
      const panel = panelContainingX(view.dayPanels, position.x);
      if (!panel || panel.endHourIndex < panel.startHourIndex) return null;
      if (panel.uncoveredSpans.some(span => position.x >= span.x && position.x <= span.x + span.width)) {
        return null;
      }
      candidateHours = visibleHours.filter(idx => idx >= panel.startHourIndex && idx <= panel.endHourIndex);
      if (!candidateHours.length) return null;
      const dataLeft = view.hours[candidateHours[0]!].x - panel.columnWidth / 2;
      const dataRight = view.hours[candidateHours.at(-1)!].x + panel.columnWidth / 2;
      if (position.x < dataLeft || position.x > dataRight) return null;
    } else {
      const dataLeft = view.hours[0].x - view.columnWidth / 2;
      const dataRight = view.hours.at(-1)!.x + view.columnWidth / 2;
      if (position.x < dataLeft || position.x > dataRight) return null;
    }
    const hourIndex = candidateHours.reduce((best, index) =>
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

    if (resolveDayBannerTarget(event.target)) {
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
    if (resolveDayBannerTarget(event.target)) return;
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
    const dayKey = resolveDayBannerTarget(event.target);
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
    const bannerDay = resolveDayBannerTarget(event.target);
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
    const bannerDay = resolveDayBannerTarget(event.target);
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
    cancelPendingReadout();
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
    for (const [name, value] of originalAttributes) {
      if (value === null) host.removeAttribute?.(name);
      else host.setAttribute?.(name, value);
    }
    for (const [name, value] of readoutAttributes) {
      if (value === null) readout?.removeAttribute?.(name);
      else readout?.setAttribute?.(name, value);
    }
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

/** Owns one SVG host; callers own profiles, layout, routing and persisted state. */
export function mountWindgram(host: HTMLElement, options: WindgramMountOptions & { view: WindgramView }) {
  let clearInspector: WindgramInspector | null = null;
  let disposed = false;
  let view = options.view;
  let mode: WindgramInspectionMode | undefined = options.inspectionMode;
  let calloutVariant: WindgramCalloutVariant | undefined = options.calloutVariant;
  const calloutTrigger: WindgramCalloutTrigger | undefined = options.calloutTrigger;
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
        const panel = panelContainingHour(view.dayPanels, index);
        const colW = panel ? panel.columnWidth : view.columnWidth;
        const pLeft = panel ? panel.left : view.left;
        const pRight = panel ? panel.left + panel.width : view.left + view.plotWidth;
        const sliceHours = panel ? view.hours.slice(panel.startHourIndex, panel.endHourIndex + 1) : view.hours;
        const localIdx = panel ? index - panel.startHourIndex : index;
        const left = Math.max(pLeft, hourX(sliceHours, localIdx - 0.5, colW));
        const right = Math.min(pRight, hourX(sliceHours, localIdx + 0.5, colW));
        cursor.setAttribute('x', String(left));
        cursor.setAttribute('width', String(Math.max(2, right - left)));
      }
    }
    const tolDot = host.querySelector?.<SVGCircleElement>('[data-selected-tol-dot]') ?? null;
    if (tolDot) {
      const tolM = index >= 0 ? view.hours[index]?.usableLiftTopM ?? null : null;
      if (index >= 0 && tolM !== null && tolM >= view.floorM && tolM <= view.topM) {
        tolDot.setAttribute('cx', String(fmt(view.hours[index]!.x)));
        tolDot.setAttribute('cy', String(fmt(heightToY(view, tolM))));
        tolDot.setAttribute('visibility', 'visible');
      } else {
        tolDot.setAttribute('visibility', 'hidden');
      }
    }
    if (view.dayPanels?.length && typeof host.querySelectorAll === 'function') {
      const activePanel = index >= 0 ? panelContainingHour(view.dayPanels, index) : null;
      for (const el of host.querySelectorAll('[data-windgram-day]')) {
        const dayKey = el.getAttribute('data-windgram-day');
        const isBest = Boolean(view.dayPanels.find(p => p.dateKey === dayKey)?.isBestDay);
        const isSelected = Boolean(activePanel && dayKey === activePanel.dateKey);
        el.setAttribute('class', `wg-day-banner${isSelected ? ' is-selected' : ''}${isBest ? ' is-best' : ''}`);
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
      calloutTrigger,
      onStepHour: options.onStepHour,
      onSelectDay: options.onSelectDay,
      onZoomMode: options.onZoomMode,
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
      const inspectorGroup = svg.querySelector?.('[data-windgram-cursor]') ?? null;
      const selected = ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'rect');
      for (const [key, value] of Object.entries({
        y: view.top, height: view.plotHeight, width: view.columnWidth,
        fill: '#237e81', 'fill-opacity': 0.06, stroke: '#1e3a8a', 'stroke-opacity': 0.35, 'stroke-width': 1,
        'pointer-events': 'none', 'data-selected-hour': '',
      })) selected.setAttribute(key, String(value));
      svg.insertBefore?.(selected, inspectorGroup);

      const selectedTolDot = ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'circle');
      for (const [key, value] of Object.entries({
        r: '5.2', fill: 'none', stroke: '#fbbf24', 'stroke-width': '2',
        visibility: 'hidden', 'pointer-events': 'none', 'data-selected-tol-dot': '',
      })) selectedTolDot.setAttribute(key, String(value));
      svg.insertBefore?.(selectedTolDot, inspectorGroup);
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
