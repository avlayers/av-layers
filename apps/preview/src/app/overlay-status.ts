import { formatZoneTime, type PinnedBuild } from '@av/client';
import type { OverlayState } from '../features/raster/raster-overlay';

export function sameSelection(a: OverlayState['displayed'], b: OverlayState['displayed']): boolean {
  return a === b || (!!a && !!b && a.build === b.build && a.layer === b.layer && a.frame === b.frame);
}

function sameList(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  if (a === b) return true;
  const la = a?.length ?? 0, lb = b?.length ?? 0;
  if (la !== lb) return false;
  for (let i = 0; i < la; i++) if (a![i] !== b![i]) return false;
  return true;
}

/** True when a raster state change alters anything the UI shows. */
export function overlayUiChanged(prev: OverlayState, next: OverlayState): boolean {
  return !(
    sameSelection(prev.displayed, next.displayed)
    && sameSelection(prev.requested, next.requested)
    && prev.quality === next.quality
    && prev.viewLoading === next.viewLoading
    && prev.overviewReady === next.overviewReady
    && prev.overviewTotal === next.overviewTotal
    && prev.overviewFailed === next.overviewFailed
    && prev.incomplete === next.incomplete
    && prev.replacementFailed === next.replacementFailed
    && Boolean(prev.limited) === Boolean(next.limited)
    && sameList(prev.previewReadyFrames, next.previewReadyFrames)
    && sameList(prev.detailReadyFrames, next.detailReadyFrames)
    && sameList(prev.detailDrawableFrames, next.detailDrawableFrames)
  );
}

interface StatusContext {
  readonly build: PinnedBuild | null;
  readonly pendingModel: string | null;
  readonly resolving: boolean;
  readonly expired: boolean;
  readonly playing: boolean;
  readonly timeZone: string;
}

/** The timeline status line and tile notice for the raster overlay state. */
export function overlayNotices(state: OverlayState, ctx: StatusContext): { frameStatus: string; overviewFailed: number; tileError: string } {
  const { displayed, requested, quality, viewLoading, overviewFailed, incomplete, replacementFailed } = state;
  const { pendingModel, playing } = ctx;
  const showing = displayed ? `Showing ${displayed.build.manifest.model} ${displayed.frame} ${displayed.layer}.` : 'No forecast displayed.';
  const pending = requested && (!displayed || displayed.build !== requested.build || displayed.layer !== requested.layer || displayed.frame !== requested.frame);
  const olderBuild = displayed && displayed.build !== ctx.build;
  const displayedTime = displayed?.build.manifest.frames.find(frame => frame.id === displayed.frame)?.validTime;
  const displayedLabel = displayedTime ? formatZoneTime(Date.parse(displayedTime), ctx.timeZone, 'stamp') : '';
  const frameStatus = !displayed ? requested ? replacementFailed ? 'Forecast unavailable · No forecast shown' : 'Loading selected time · No forecast shown' : ctx.expired ? 'Forecast expired' : pendingModel || ctx.resolving ? 'Loading forecast…' : 'No forecast shown'
    : pending ? `Showing ${displayedLabel} · ${replacementFailed ? 'Selected time unavailable' : 'Loading selected time…'}`
      : quality === 'overview' ? `${displayedLabel} · Overview${playing ? '' : (replacementFailed ? ' · Detail unavailable' : ' · Loading detail…')}`
        : viewLoading ? `${displayedLabel} · Loading this view…` : `${displayedLabel} · ${incomplete ? 'Detail incomplete' : 'Full detail'}`;
  const tileError = replacementFailed ? `Forecast replacement failed. ${showing}` : incomplete ? `Overlay tile failed to load — forecast display may be incomplete. ${showing}` : pendingModel ? `Loading ${pendingModel}. ${showing}` : olderBuild ? showing : '';
  return { frameStatus, overviewFailed, tileError };
}
