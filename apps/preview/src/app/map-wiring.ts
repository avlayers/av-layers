import { AUTO_MODEL_ID, normalizePoint } from '@av/client';
import { maplibregl } from '../features/map/map-controller';
import type { PreviewContext } from './context';
import type { PreviewOps } from './display-ops';
import type { PointWiring } from './point-wiring';
import type { WindWiring } from './wind-wiring';

/** Follows the map camera into the clock, timeline, URL and point card. */
export function installMapWiring(ctx: PreviewContext, ops: PreviewOps, map: maplibregl.Map, point: PointWiring, wind: WindWiring,
  showMapFailure: (error: unknown) => void): void {
  const { writer } = ctx.store, { live, state, history } = ctx;

  function syncMapClock(settled: boolean): void {
    const camera = live.camera;
    if (!live.map || !camera) return;
    const next = camera.sync();
    if (!Number.isFinite(next.center.lat) || !Number.isFinite(next.center.lng)) return;
    // Avoid re-rendering <App /> or rebuilding the timeline's solar DOM at 60 fps mid-pan.
    if (settled || next.changed || ctx.forecast().mapCenter === null) writer.forecast({ mapCenter: next.center });
    if (settled || next.changed || !Number.isFinite(state.lastTimelineLat)
      || Math.abs(next.center.lat - state.lastTimelineLat) >= 0.20 || Math.abs(next.center.lng - state.lastTimelineLng) >= 0.20) {
      state.lastTimelineLat = next.center.lat;
      state.lastTimelineLng = next.center.lng;
      live.timeline?.setMapCenter(next.center.lat, next.center.lng);
    }
    if (!next.changed) return;
    const offsetMinutes = camera.offsetMinutes();
    writer.forecast({ offsetMinutes });
    live.timeline?.setOffsetMinutes(offsetMinutes);
    ops.updateTimeUi(); ops.updateOverlayStatus(); ops.paintMapHorizon(); live.point?.feature.syncSelection();
  }

  map.on('click', event => {
    if (ctx.mapFailed()) return;
    if (point.isOpen()) { point.close(); return; }
    void point.feature.open(normalizePoint(event.lngLat.lat, event.lngLat.lng));
  });
  map.on('move', () => { syncMapClock(false); point.marker.sync(); wind.session.reconcile(); });
  map.on('resize', () => { point.marker.sync(); point.syncBarReserve(); });
  map.on('movestart', event => {
    if (!('pointCamera' in event)) point.cancelEase();
    if (ctx.intent().model === AUTO_MODEL_ID && !('previewHistory' in event) && !('pointCamera' in event)) {
      history.cancelRestore();
      ctx.forecastSession.cancelAuto();
    }
  });
  map.on('moveend', event => {
    syncMapClock(true); point.marker.sync(); ops.updateScale();
    const pointCameraMove = Boolean(event && typeof event === 'object' && 'pointCamera' in event);
    if (ctx.intent().model !== AUTO_MODEL_ID || pointCameraMove) ops.updateWind();
    if (ctx.build() && !ctx.forecast().expired) ops.updateTimeUi();
    if (ctx.intent().model === AUTO_MODEL_ID && !history.restoring() && !pointCameraMove) void ctx.forecastSession.loadAuto();
    if (state.urlReady && !history.restoring()) ops.writeUrl('push');
    ops.refreshSeam();
  });
  map.on('error', (event: { error?: unknown }) => {
    if (ctx.mapFailed() || !(event.error instanceof maplibregl.GPUInitializationError)) return;
    showMapFailure(event.error);
  });
  map.once('style.load', () => {
    if (ctx.aborted() || ctx.mapFailed()) return;
    if (!ctx.startup.query.camera) ops.focusRegion(ctx.intent().model);
    writer.forecast({ mapReady: true });
    live.seam?.markReady(); ops.updateOverlay(); ops.refreshSeam(); ops.writeUrl('replace');
  });
}
