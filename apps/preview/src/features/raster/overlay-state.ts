import type { DetailReadiness } from './detail-readiness';
import { matches, type RasterSelection } from './raster-slots';

/** What the raster overlay shows and how far the requested frame has loaded. */
export interface OverlayState { displayed: RasterSelection | null; requested: RasterSelection | null; quality: 'overview' | 'detail' | null; viewLoading: boolean; overviewReady: number; overviewTotal: number; overviewFailed: number; incomplete: boolean; replacementFailed: boolean; previewReadyFrames?: readonly string[]; detailReadyFrames?: readonly string[]; limited?: boolean; detailState?: DetailReadiness; cameraRevision?: number; requiredTiles?: number; loadedTiles?: number; pendingTiles?: number; erroredTiles?: number; coarseReadyFrames?: readonly string[]; detailBytesReadyFrames?: readonly string[]; detailDrawableFrames?: readonly string[] }

const sameSelection = (a: RasterSelection | null, b: RasterSelection | null): boolean => a === b || matches(a, b);
const sameFrames = (a: readonly string[] | undefined, b: readonly string[] | undefined): boolean => a?.join('\0') === b?.join('\0');

/** Whether `next` would tell a listener nothing `last` did not. */
export function sameOverlayState(last: OverlayState | null, next: OverlayState): boolean {
  return !!last && sameSelection(last.displayed, next.displayed) && sameSelection(last.requested, next.requested)
    && last.quality === next.quality && last.viewLoading === next.viewLoading
    && last.overviewReady === next.overviewReady && last.overviewTotal === next.overviewTotal
    && last.overviewFailed === next.overviewFailed && last.incomplete === next.incomplete && last.limited === next.limited
    && sameFrames(last.previewReadyFrames, next.previewReadyFrames) && sameFrames(last.detailReadyFrames, next.detailReadyFrames)
    && last.replacementFailed === next.replacementFailed && last.detailState === next.detailState
    && last.cameraRevision === next.cameraRevision && last.requiredTiles === next.requiredTiles
    && last.loadedTiles === next.loadedTiles && last.pendingTiles === next.pendingTiles && last.erroredTiles === next.erroredTiles
    && sameFrames(last.coarseReadyFrames, next.coarseReadyFrames)
    && sameFrames(last.detailBytesReadyFrames, next.detailBytesReadyFrames)
    && sameFrames(last.detailDrawableFrames, next.detailDrawableFrames);
}
