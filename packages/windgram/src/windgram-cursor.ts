// Crosshair, Top-of-Lift ring, and floating callout placement for the active inspection.

import { getWindgramCalloutRenderer, type WindgramCalloutVariant } from './windgram-callout.ts';
import { placeWindgramCallout, type CalloutHorizontalSide } from './windgram-callout-placement.ts';
import { svgNumber as fmt, type UnitSystem } from './windgram-format.ts';
import { panelContainingHour } from './windgram-panels.ts';
import type { WindgramReading } from './scene-types.ts';
import type { WindgramTelemetryStrip } from './windgram-readout.ts';
import { heightToY } from './windgram-vertical.ts';
import type { ScreenGeometry } from './windgram-screen-geometry.ts';
import { setSvgNumbers } from './windgram-svg-dom.ts';
import type { WindgramView } from './windgram-view.ts';

interface CursorPaint {
  readonly hourIndex: number;
  readonly x: number;
  readonly heightM: number;
  readonly tolM: number | null;
  readonly useTol: boolean;
  readonly aglText: string;
  readonly mslText: string;
  readonly telemetry: WindgramTelemetryStrip;
  readonly reading: WindgramReading;
  readonly touchActive: boolean;
  readonly readGeometry: () => ScreenGeometry | null;
}

export function createCursorPainter(svg: SVGSVGElement | null, view: WindgramView, calloutVariant: WindgramCalloutVariant | undefined) {
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
  const boundCallout = getWindgramCalloutRenderer(calloutVariant).bind(svg);

  // Precompute convective dome ceiling Y samples once per scene for O(1) anti-clobber callout placement.
  const ceilingSamples = view.hours.map((h, i) => {
    const z = h.usableLiftTopM ?? view.sourceHours[i]?.nativeUsableLiftTopM ?? view.sourceHours[i]?.thermalTopM ?? null;
    return {
      x: h.x,
      ceilingY: z !== null && z >= view.floorM && z <= view.topM ? heightToY(view, z) : null,
    };
  });
  let preferredSide: CalloutHorizontalSide = 'right';

  const hideFloatingCursor = () => {
    cursor?.setAttribute('visibility', 'hidden');
    tolRing?.setAttribute('visibility', 'hidden');
  };

  const paint = ({ hourIndex, x, heightM, tolM, useTol, aglText, mslText, telemetry, reading, touchActive, readGeometry }: CursorPaint) => {
    const system: UnitSystem = view.unitSystem;
    const y = heightToY(view, heightM);
    const panel = panelContainingHour(view.dayPanels, hourIndex);
    const hLeft = panel ? panel.left : view.left;
    const hRight = panel ? panel.left + panel.width : view.left + view.plotWidth;
    setSvgNumbers(verticalHalo, { x1: x, x2: x, y1: view.top, y2: view.bottom });
    setSvgNumbers(horizontalHalo, { x1: hLeft, x2: hRight, y1: y, y2: y });
    setSvgNumbers(vertical, { x1: x, x2: x, y1: view.top, y2: view.bottom });
    setSvgNumbers(horizontal, { x1: hLeft, x2: hRight, y1: y, y2: y });
    setSvgNumbers(pointHalo, { cx: x, cy: y });
    setSvgNumbers(point, { cx: x, cy: y });
    if (tolRing) {
      if (!useTol && tolM !== null) {
        setSvgNumbers(tolRing, { cx: x, cy: heightToY(view, tolM) });
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
    if (effectiveWidth / mobileScale < painted.width) setSvgNumbers(calloutBack, { width: effectiveWidth / mobileScale });

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

  return { hide: hideFloatingCursor, paint };
}
