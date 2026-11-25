// Anti-clobber sky-pocket placement for the floating Windgram hover callout.

import { clamp } from './windgram-format.ts';

export type CalloutHorizontalSide = 'left' | 'right';

export interface CalloutPlacementInput {
  readonly cursorX: number;
  readonly cursorY: number;
  readonly width: number;
  readonly height: number;
  readonly bounds: {
    readonly left: number;
    readonly top: number;
    readonly right: number;
    readonly bottom: number;
  };
  /** Optional convective dome ceiling Y per visible hour (smaller Y = higher in sky). */
  readonly ceilingSamples?: readonly { readonly x: number; readonly ceilingY: number | null }[];
  readonly preferredSide?: CalloutHorizontalSide;
  /** True during touch interaction so the floating card stays clear above the user's finger. */
  readonly touchMode?: boolean;
}

export interface CalloutPlacementResult {
  readonly x: number;
  readonly y: number;
  readonly side: CalloutHorizontalSide;
}

/**
 * Places the floating hover callout inside `bounds` while minimizing occlusion of:
 * 1) The active cursor crosshair bullseye `(cursorX, cursorY)` (plus thumb pad in `touchMode`)
 * 2) The active convective thermal dome (`y >= ceilingY`)
 * 3) Rapid side-flipping during smooth horizontal scrubbing (`preferredSide` hysteresis)
 */
export function placeWindgramCallout(input: CalloutPlacementInput): CalloutPlacementResult {
  const pad = 4;
  const { cursorX, cursorY, width, height, bounds, ceilingSamples, preferredSide = 'right', touchMode = false } = input;
  const minX = bounds.left + pad;
  const maxX = Math.max(minX, bounds.right - width - pad);
  const minY = bounds.top + pad;
  const maxY = Math.max(minY, bounds.bottom - height - pad);

  const hGap = touchMode ? 22 : 14;
  const rightNearX = clamp(cursorX + hGap, minX, maxX);
  const leftNearX = clamp(cursorX - hGap - width, minX, maxX);
  const farRightX = maxX;
  const farLeftX = minX;

  const skyTopY = minY;
  const aboveCursorY = clamp(cursorY - height - (touchMode ? 28 : 12), minY, maxY);
  const belowCursorY = clamp(cursorY + (touchMode ? 48 : 14), minY, maxY);

  const rawCandidates: Array<{ x: number; y: number; side: CalloutHorizontalSide }> = [
    { x: rightNearX, y: skyTopY, side: 'right' },
    { x: leftNearX, y: skyTopY, side: 'left' },
    { x: rightNearX, y: aboveCursorY, side: 'right' },
    { x: leftNearX, y: aboveCursorY, side: 'left' },
    { x: farRightX, y: skyTopY, side: 'right' },
    { x: farLeftX, y: skyTopY, side: 'left' },
    { x: rightNearX, y: belowCursorY, side: 'right' },
    { x: leftNearX, y: belowCursorY, side: 'left' },
    { x: farRightX, y: belowCursorY, side: 'right' },
    { x: farLeftX, y: belowCursorY, side: 'left' },
    { x: farRightX, y: maxY, side: 'right' },
    { x: farLeftX, y: maxY, side: 'left' },
  ];

  const clearanceX = touchMode ? 24 : 10;
  const clearanceYAbove = touchMode ? 20 : 10;
  const clearanceYBelow = touchMode ? 44 : 10;
  const skyWeight = touchMode ? 1.55 : 0.65;
  let best = rawCandidates[0]!;
  let bestCost = Infinity;

  for (const cand of rawCandidates) {
    let cost = 0;

    // 1) Strong penalty if candidate box covers or crowds the cursor bullseye or thumb pad
    const overlapsCursorX = cursorX >= cand.x - clearanceX && cursorX <= cand.x + width + clearanceX;
    const overlapsCursorY = cursorY >= cand.y - clearanceYBelow && cursorY <= cand.y + height + clearanceYAbove;
    if (overlapsCursorX && overlapsCursorY) {
      const dx = Math.min(cursorX - (cand.x - clearanceX), cand.x + width + clearanceX - cursorX);
      const dy = Math.min(cursorY - (cand.y - clearanceYBelow), cand.y + height + clearanceYAbove - cursorY);
      cost += 12_000 + Math.min(dx, dy) * 200;
    }

    // 2) Penalty if vertical cursor line cuts straight through the middle of the callout box
    if (cursorX > cand.x + 2 && cursorX < cand.x + width - 2) {
      cost += 2_400;
    }

    // 3) Convective dome clobber penalty: keep the red/orange thermal core & TOL curve uncovered
    if (ceilingSamples && ceilingSamples.length > 0) {
      let domeIntrusion = 0;
      let sampleCount = 0;
      const boxBottom = cand.y + height;
      for (const s of ceilingSamples) {
        if (s.x < cand.x - 6 || s.x > cand.x + width + 6) continue;
        sampleCount += 1;
        if (s.ceilingY !== null && boxBottom > s.ceilingY - 4) {
          const intrusion = Math.min(height, boxBottom - (s.ceilingY - 4));
          domeIntrusion += intrusion;
        }
      }
      if (sampleCount > 0) {
        cost += (domeIntrusion / sampleCount) * 18;
      }
    }

    // 4) Float in the calm upper sky to keep surface barbs and touch zone unobstructed
    cost += (cand.y - minY) * skyWeight;

    // 5) Mild proximity preference so eye travel across wide charts stays short
    const boxCenterX = cand.x + width / 2;
    cost += Math.abs(boxCenterX - cursorX) * 0.28;

    // 6) Hysteresis bonus to prevent side-flipping on tiny pointer jitter
    if (cand.side === preferredSide) {
      cost -= 22;
    }

    if (cost < bestCost) {
      bestCost = cost;
      best = cand;
    }
  }

  return best;
}
