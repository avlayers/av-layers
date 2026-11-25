import { AUTO_MODEL_ID } from '@av/client';
import type { ModelId } from '@av/contracts/publication';
import { committedFrame, restoredCustomLayer, visibleCustomLayer } from '../features/forecast/forecast-model';
import type { PreviewContext } from './context';
import type { PreviewOps } from './display-ops';
import { resolveDisplay } from './startup';

/** Writes the view into the URL and restores it on back/forward, with the same precedence as startup. */
export function createUrlWiring(ctx: PreviewContext, ops: PreviewOps): Pick<PreviewOps, 'writeUrl' | 'applyHistory'> {
  const { writer } = ctx.store, { live, history } = ctx;
  return {
    writeUrl(mode) {
      const map = live.map;
      if (!map || !ctx.forecast().mapReady || !ctx.state.urlReady || ctx.forecast().pendingModel) return;
      const center = map.getCenter(), current = ctx.build(), cur = ctx.intent();
      const validTime = cur.model === AUTO_MODEL_ID ? cur.requestedTime ?? undefined : current?.manifest.frames.find(frame => frame.id === ctx.selectedFrame())?.validTime;
      history.write({
        model: cur.model, reference: cur.reference, layer: cur.customLayer, opacity: cur.opacity,
        lat: center.lat, lon: center.lng, zoom: map.getZoom(), validTime, theme: cur.theme, dockView: cur.dockView,
        liftVisible: cur.liftVisible, cloudsVisible: cur.cloudsVisible, rainVisible: cur.rainVisible, isobarsVisible: cur.isobarsVisible,
        ...(cur.windVisibleOverride !== null ? { windVisible: cur.windVisible } : {}),
        windStyle: cur.windStyle, windHeight: cur.windHeight, units: cur.units
      }, mode, true);
    },

    async applyHistory() {
      if (ctx.aborted()) return;
      live.timeline?.cancelGesture();
      const urlState = history.read(window.location.search), change = history.beginRestore();
      try {
        const display = resolveDisplay(urlState, ctx.startup.preferences);
        writer.intent({
          reference: urlState.reference,
          customLayer: restoredCustomLayer(ctx.build(), visibleCustomLayer(urlState.layer), Boolean(urlState.model && urlState.model !== ctx.intent().model)),
          theme: display.theme, dockView: display.dockView, opacity: display.opacity,
          liftVisible: display.liftVisible, cloudsVisible: display.cloudsVisible, rainVisible: display.rainVisible,
          isobarsVisible: display.isobarsVisible, peeking: false
        });
        live.timeline?.setVariant?.(display.dockView);
        ops.syncChannels();
        if (display.units !== ctx.intent().units) ops.setUnits(display.units);
        live.wind?.restore({ visible: display.windVisible, style: display.windStyle, height: display.windHeight }, urlState.windVisible);
        if (urlState.camera) live.map?.jumpTo(urlState.camera, { previewHistory: true });
        writer.intent({ requestedTime: urlState.validTime });
        if (urlState.model && urlState.model !== ctx.intent().model) { await ctx.forecastSession.load(urlState.model as ModelId); return; }
        if (ctx.intent().model === AUTO_MODEL_ID) { await ctx.forecastSession.loadAuto(); return; }
        const current = ctx.build();
        if (current) {
          const committed = committedFrame(current, urlState.validTime, Date.now());
          if (committed.id !== ctx.selectedFrame()) { live.timeline?.pause(); live.point?.feature.followMapFrame(committed.id); }
          if (committed.id && committed.validTime) ctx.forecastSession.commitFrame(committed.id, committed.validTime);
          ops.updateTimeUi(); ops.updateOverlay();
        }
      } finally { history.endRestore(change); }
    }
  };
}
