import { isGlobeView, normalizePoint, watchBuildExpiry } from '@av/client';
import { layerOptions, validatedCustomLayer } from '../features/forecast/forecast-model';
import { createForecastSession } from '../features/forecast/forecast-session';
import type { PreviewContext } from './context';
import type { PreviewOps } from './display-ops';

/** Creates the forecast session and routes its build, expiry and URL events to the display. */
export function createForecastWiring(ctx: PreviewContext, ops: PreviewOps): ReturnType<typeof createForecastSession> {
  const { writer } = ctx.store, { live, state } = ctx;
  let expiryTimer: number | null = null;
  return createForecastSession({
    api: ctx.services.api, writer, intent: ctx.intent,
    center: () => { const center = live.map!.getCenter(); return normalizePoint(center.lat, center.lng); },
    bounds: () => {
      if (!live.map) return null;
      const b = live.map.getBounds();
      return [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()] as const;
    },
    globe: () => {
      if (!live.map) return false;
      const bounds = live.map.getBounds();
      return isGlobeView({ zoom: live.map.getZoom(), west: bounds.getWest(), east: bounds.getEast() });
    },
    mapFailed: ctx.mapFailed, aborted: ctx.aborted, now: () => Date.now(),
    hooks: {
      onLoading(model) {
        live.wind?.session.clear(); live.point?.close();
        writer.notices({ tileError: '', horizon: '', error: '', frameStatus: 'Loading forecast…', freshness: `Loading ${model} latest immutable build…` });
        ops.updateTimeUi();
      },
      onBuild(next) {
        state.urlReady = true;
        writer.forecast({ layers: layerOptions(next) });
        const customLayer = validatedCustomLayer(next, ctx.intent().customLayer);
        if (customLayer !== ctx.intent().customLayer) writer.intent({ customLayer });
        live.wind?.syncSupport(); ops.updateTimeUi(); ops.updateOverlay(); ops.updateFreshness();
      },
      onSameBuild(frame) {
        live.timeline?.pause();
        if (live.point?.feature.frameId === ctx.selectedFrame()) live.point.feature.followMapFrame(frame);
      },
      onCleared(message) {
        state.urlReady = true;
        live.wind?.syncSupport(); ops.syncLayers(); ops.clearForecast();
        ops.showError(message); writer.notices({ freshness: 'No viewable build' });
      },
      onExpired() {
        writer.notices({ tileError: '', horizon: '' });
        ctx.services.windCache.clear(); ops.clearForecast();
        writer.notices({ freshness: 'Expired immutable build' });
        ops.showError('This build has expired. Reload to discover the latest retained build.');
      },
      onUrl(mode) { ops.writeUrl(mode); },
      watchExpiry(next, expire) { return watchBuildExpiry(next.expiresAtMs, expire, [document, window]); },
      startTimer() { if (expiryTimer === null) expiryTimer = window.setInterval(() => ops.updateFreshness(), 5000); },
      stopTimer() { if (expiryTimer !== null) { window.clearInterval(expiryTimer); expiryTimer = null; } }
    }
  });
}
