import type { GeoPoint } from '@av/client';

interface ScreenBox {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

interface PointRevealGeometry {
  readonly pointPx: { readonly x: number; readonly y: number };
  readonly viewport: { readonly width: number; readonly height: number };
  readonly cardRect: ScreenBox | null;
  readonly topbarBottomPx?: number;
  readonly bottomClearancePx?: number;
  readonly rightClearancePx?: number;
}

interface PointRevealTarget {
  readonly targetX: number;
  readonly targetY: number;
  readonly panBy: [number, number];
  readonly centerOffset: [number, number];
}

interface PannablePointMap {
  project?(lngLat: [number, number]): { x: number; y: number };
  easeTo?(
    options: { center: [number, number]; offset: [number, number]; duration?: number },
    eventData?: Record<string, unknown>
  ): unknown;
  panBy?(offset: [number, number], options?: { duration?: number }, eventData?: Record<string, unknown>): unknown;
  getContainer(): unknown;
}

const MOBILE_MAX_WIDTH = 760;
const RENDERED_CARD_MIN_HEIGHT = 150;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Computes the unobscured screen pixel `(targetX, targetY)` where the selected
 * Windgram coordinate should rest, along with camera `centerOffset` and `panBy` deltas.
 */
export function computePointRevealTarget(input: PointRevealGeometry): PointRevealTarget | null {
  const { pointPx, viewport, cardRect } = input;
  if (
    !Number.isFinite(pointPx.x)
    || !Number.isFinite(pointPx.y)
    || viewport.width < 120
    || viewport.height < 120
  ) {
    return null;
  }

  const topbarBottom = input.topbarBottomPx ?? 84;
  const bottomClearance = input.bottomClearancePx ?? 68;
  const rightClearance = input.rightClearancePx ?? 64;
  const rawCardValid = Boolean(cardRect && cardRect.right > cardRect.left && cardRect.bottom > cardRect.top);
  const cardHeight = rawCardValid ? cardRect!.bottom - cardRect!.top : 0;
  const hasRenderedChart = rawCardValid && cardHeight >= RENDERED_CARD_MIN_HEIGHT;

  if (viewport.width <= MOBILE_MAX_WIDTH) {
    // Usable map space on mobile is the open window below #topbar and above #point-card.
    // During the initial loading frame before the SVG mounts, #point-card is ~28px tall;
    // estimate its full sheet height so the camera immediately centers above the sheet.
    const usableTop = clamp(topbarBottom + 10, 72, Math.round(viewport.height * 0.32));
    const estimatedSheetHeight = Math.min(416, Math.round(Math.min(viewport.height * 0.54, viewport.height - 132)));
    const sheetTop = hasRenderedChart
      ? cardRect!.top
      : Math.max(usableTop + 60, viewport.height - 66 - estimatedSheetHeight);
    const usableBottom = Math.max(usableTop + 44, sheetTop - 12);
    const targetX = Math.round(viewport.width / 2);
    const targetY = Math.round((usableTop + usableBottom) / 2);
    const dx = Math.round(pointPx.x - targetX);
    const dy = Math.round(pointPx.y - targetY);
    if (Math.hypot(dx, dy) < 14) return null;
    return {
      targetX,
      targetY,
      panBy: [dx, dy],
      centerOffset: [targetX - Math.round(viewport.width / 2), targetY - Math.round(viewport.height / 2)],
    };
  }

  const effectiveCard: ScreenBox = hasRenderedChart
    ? cardRect!
    : {
        left: 12,
        top: 58,
        right: Math.min(662, viewport.width - 64),
        bottom: Math.min(viewport.height - 84, 486),
      };

  const minX = 48;
  const maxX = Math.max(minX + 60, viewport.width - rightClearance - 16);
  const minY = Math.max(72, topbarBottom + 12);
  const maxY = Math.max(minY + 60, viewport.height - bottomClearance - 16);
  const cardPad = 20;
  const underCard =
    pointPx.x >= effectiveCard.left - cardPad
    && pointPx.x <= effectiveCard.right + cardPad
    && pointPx.y >= effectiveCard.top - cardPad
    && pointPx.y <= effectiveCard.bottom + cardPad;
  const nearEdge = pointPx.x < minX || pointPx.x > maxX || pointPx.y < minY || pointPx.y > maxY;
  if (!underCard && !nearEdge) return null;

  let targetX = clamp(pointPx.x, minX + 16, maxX - 16);
  let targetY = clamp(pointPx.y, minY + 16, maxY - 16);

  if (underCard) {
    const openLeft = effectiveCard.right + 36;
    if (maxX - openLeft >= 80) {
      targetX = Math.round(openLeft + (maxX - openLeft) * 0.42);
      targetY = clamp(pointPx.y, minY + 20, maxY - 20);
    } else if (maxY - (effectiveCard.bottom + 28) >= 60) {
      targetY = Math.round((effectiveCard.bottom + 28 + maxY) / 2);
    }
  }

  const dx = Math.round(pointPx.x - targetX);
  const dy = Math.round(pointPx.y - targetY);
  if (Math.hypot(dx, dy) < 10) return null;
  return {
    targetX,
    targetY,
    panBy: [dx, dy],
    centerOffset: [targetX - Math.round(viewport.width / 2), targetY - Math.round(viewport.height / 2)],
  };
}

export function computePointRevealPan(input: PointRevealGeometry): [number, number] | null {
  return computePointRevealTarget(input)?.panBy ?? null;
}

function measureElementBox(el: unknown): ScreenBox | null {
  if (!el || typeof (el as Element).getBoundingClientRect !== 'function') return null;
  const rect = (el as Element).getBoundingClientRect();
  if (!Number.isFinite(rect.left) || !Number.isFinite(rect.top) || rect.width <= 0 || rect.height <= 0) return null;
  return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
}

/** Smoothly eases the camera so the selected Windgram dot sits in unobscured usable map space. */
export function easePointIntoClearView(map: PannablePointMap, root: ParentNode, point: GeoPoint): boolean {
  if (typeof map.project !== 'function' || (typeof map.easeTo !== 'function' && typeof map.panBy !== 'function')) {
    return false;
  }
  const container = map.getContainer() as { clientWidth?: number; clientHeight?: number; getBoundingClientRect?: () => DOMRect } | null;
  const containerBox = measureElementBox(container);
  const width = containerBox ? containerBox.right - containerBox.left : (container?.clientWidth ?? 0);
  const height = containerBox ? containerBox.bottom - containerBox.top : (container?.clientHeight ?? 0);
  if (width <= 0 || height <= 0) return false;

  const originLeft = containerBox?.left ?? 0;
  const originTop = containerBox?.top ?? 0;
  const cardNode = root.querySelector?.('#point-card');
  const rawCard = cardNode && !(cardNode as HTMLElement).hidden ? measureElementBox(cardNode) : null;
  const cardRect = rawCard
    ? {
        left: rawCard.left - originLeft,
        top: rawCard.top - originTop,
        right: rawCard.right - originLeft,
        bottom: rawCard.bottom - originTop,
      }
    : null;
  const rawTopbar = measureElementBox(root.querySelector?.('#topbar'));
  const topbarBottomPx = rawTopbar ? Math.max(0, rawTopbar.bottom - originTop) : undefined;

  const projected = map.project([point.lon, point.lat]);
  const target = computePointRevealTarget({
    pointPx: projected,
    viewport: { width, height },
    cardRect,
    topbarBottomPx,
  });
  if (!target) return false;

  const ownerDoc = 'ownerDocument' in root ? root.ownerDocument : null;
  const reducedMotion = Boolean(ownerDoc?.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches);
  const duration = reducedMotion ? 0 : 260;
  if (typeof map.easeTo === 'function') {
    map.easeTo({ center: [point.lon, point.lat], offset: target.centerOffset, duration }, { pointCamera: true });
  } else {
    map.panBy!(target.panBy, { duration }, { pointCamera: true });
  }
  return true;
}
