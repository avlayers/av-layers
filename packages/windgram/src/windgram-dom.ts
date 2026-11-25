// Mounts one chart SVG: renders the scene, adds the selected-hour marks, and rebinds the inspector.

import { type WindgramCalloutVariant } from './windgram-callout.ts';
import { renderWindgramSvg } from './windgram-chart.ts';
import { svgNumber as fmt } from './windgram-format.ts';
import { visibleTolM, type WindgramInspectionMode } from './windgram-hit-test.ts';
import { mountWindgramInspector, type WindgramCalloutTrigger, type WindgramInspector } from './windgram-interaction.ts';
import { SVG_NS } from './windgram-markup.ts';
import { panelContainingHour, panelShowsX } from './windgram-panels.ts';
import type { WindgramTelemetryStrip } from './windgram-readout.ts';
import { heightToY } from './windgram-vertical.ts';
import { hourX } from './windgram-time-axis.ts';
import type { WindgramView } from './windgram-view.ts';

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
  offChartReadout?: string | null;
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

export function findVisibleChartHourIndex(view: WindgramView, validAt: string | null): number {
  if (!validAt) return -1;
  return view.hours.findIndex((hour, index) => {
    if (hour.validAt !== validAt) return false;
    const panel = panelContainingHour(view.dayPanels, index);
    if (panel) return panelShowsX(panel, hour.x);
    return hour.x >= view.left && hour.x <= view.left + view.plotWidth;
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
  let offChartReadout: string | null = options.offChartReadout ?? null;
  const select = (validAt: string | null, nextOffChartReadout?: string | null) => {
    if (disposed) return;
    selectedValidAt = validAt;
    if (nextOffChartReadout !== undefined) offChartReadout = nextOffChartReadout;
    const index = findVisibleChartHourIndex(view, validAt);
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
      const tolM = index >= 0 ? visibleTolM(view, index) : null;
      if (tolM !== null) {
        tolDot.setAttribute('cx', String(fmt(view.hours[index]!.x)));
        tolDot.setAttribute('cy', String(fmt(heightToY(view, tolM))));
        tolDot.setAttribute('visibility', 'visible');
      } else {
        tolDot.setAttribute('visibility', 'hidden');
      }
    }
    if (view.dayPanels?.length && typeof host.querySelectorAll === 'function') {
      const rawIndex = index >= 0 ? index : (validAt ? view.hours.findIndex(hour => hour.validAt === validAt) : -1);
      const activePanel = rawIndex >= 0 ? panelContainingHour(view.dayPanels, rawIndex) : null;
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
      offChartReadout = null;
      select(validAt, null);
      options.onSelectHour?.(validAt);
    }, () => findVisibleChartHourIndex(view, selectedValidAt), {
      mode,
      calloutVariant,
      calloutTrigger,
      onStepHour: options.onStepHour,
      onSelectDay: options.onSelectDay,
      onZoomMode: options.onZoomMode,
      onTelemetry: options.onTelemetry,
      fallbackReadout: () => offChartReadout,
    });
    select(selectedValidAt, offChartReadout);
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
      const selected = ownerDocument.createElementNS(SVG_NS, 'rect');
      for (const [key, value] of Object.entries({
        y: view.top, height: view.plotHeight, width: view.columnWidth,
        fill: '#237e81', 'fill-opacity': 0.06, stroke: '#1e3a8a', 'stroke-opacity': 0.35, 'stroke-width': 1,
        'pointer-events': 'none', 'data-selected-hour': '',
      })) selected.setAttribute(key, String(value));
      svg.insertBefore?.(selected, inspectorGroup);

      const selectedTolDot = ownerDocument.createElementNS(SVG_NS, 'circle');
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
