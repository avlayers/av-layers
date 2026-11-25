import { maplibregl } from '../features/map/map-controller';
import type { ModelId } from '@av/contracts/publication';
import type { PreviewContext } from './context';
import type { PreviewOps } from './display-ops';

function cleanup(releases: readonly (() => void)[]): void {
  for (const release of releases) {
    try { release(); } catch (error) { console.error('Preview cleanup failed', error); }
  }
}

/** Back/forward-cache suspension, map failure and permanent disposal, each releasing in reverse build order. */
export function createPageLifecycle(ctx: PreviewContext, ops: PreviewOps) {
  const { writer } = ctx.store, { live, state, services } = ctx;
  let resumeModel: ModelId | null = null;

  function disposePermanently(): void {
    if (state.destroyed) return;
    state.destroyed = true;
    live.point?.cancelEase();
    cleanup([
      () => ctx.forecastSession.dispose(), () => ctx.lifecycle.abort(),
      () => live.timeline?.destroy(), () => live.locationController?.dispose(),
      () => live.point?.marker.dispose(), () => live.point?.feature.dispose(), () => services.pointSeries.close(),
      () => live.wind?.destroyControls(), () => live.wind?.session.destroy(), () => services.windCache.clear(), () => live.seam?.destroy(),
      ...[...live.channels].reverse().map(channel => () => channel.destroy()),
      () => services.forecastScheduler.dispose(), () => live.map?.remove()
    ]);
    live.timeline = live.locationController = live.point = live.wind = null;
    live.seam = live.sky = live.overlay = null; live.channels = []; live.map = null;
  }

  return {
    disposePermanently,

    pageHide(event: PageTransitionEvent): void {
      if (!event.persisted) { disposePermanently(); return; }
      const pointInterrupted = live.point?.feature.pending;
      cleanup([
        () => { resumeModel = ctx.forecastSession.suspend(); },
        () => live.wind?.session.clear(), () => services.windCache.clear(), () => live.locationController?.reset(),
        () => {
          live.point?.marker.clear();
          if (!pointInterrupted) return;
          try { live.point?.feature.suspend(); }
          finally { writer.point({ open: true, busy: false, status: 'Point request interrupted. Click the map again.' }); }
        },
        ...[...live.channels].reverse().map(channel => () => channel.clear(true))
      ]);
    },

    pageShow(event: PageTransitionEvent): void {
      if (!event.persisted) return;
      if (resumeModel !== null) { const model = resumeModel; resumeModel = null; ctx.forecastSession.resume(model); return; }
      if (ctx.build() && ctx.forecastSession.ensureLive()) { ops.updateTimeUi(); ops.updateOverlay(); ops.refreshSeam(); ops.updateFreshness(); }
    },

    showMapFailure(error: unknown): void {
      writer.forecast({ mapFailed: true, pendingModel: null });
      writer.notices({
        error: error instanceof maplibregl.GPUInitializationError
          ? 'Map unavailable: this browser needs WebGL2. Enable graphics acceleration or try another browser.'
          : `Map initialization failed: ${error instanceof Error ? error.message : String(error)}`,
        freshness: ''
      });
      live.point?.marker.clear();
      writer.point({ open: false });
      disposePermanently();
    }
  };
}
