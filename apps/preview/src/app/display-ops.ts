import { AUTO_MODEL_ID, formatBuildFreshness, formatRunAge, formatZoneTime, mapForecastHorizonNotice, type UnitSystem } from '@av/client';
import { MODEL_OPTIONS } from '@av/contracts/model-options';
import { renderedFrames, type ModelId } from '@av/contracts/publication';
import { layerOptions, validatedCustomLayer } from '../features/forecast/forecast-model';
import { preparedAxisReadiness } from '../stores/app-store';
import { themeOption } from '../themes/registry';
import type { PreviewContext } from './context';
import { effect } from '@preact/signals';
import { overlayNotices } from './overlay-status';

/** The operations the wiring modules call on each other, resolved at call time. */
export interface PreviewOps {
  syncChannels(): void;
  clearForecast(): void;
  syncLayers(): void;
  syncSelectedAdmission(): void;
  showError(message: string): void;
  updatePreparation(): void;
  updateScale(): void;
  paintMapHorizon(now?: number): void;
  updateFreshness(): void;
  updateTimeUi(): void;
  updateWind(): void;
  refreshSeam(): void;
  updateOverlay(): void;
  prepareFrame(frameId: string, channel?: 'clouds' | 'rain' | 'isobars'): void;
  prepareFrameIndex(index: number): void;
  selectIndex(index: number, mode: 'none' | 'push' | 'replace', fromTimeline?: boolean): void;
  focusRegion(model: ModelId): void;
  setUnits(units: UnitSystem): void;
  writeUrl(mode: 'push' | 'replace'): void;
  applyHistory(): Promise<void>;
}

/** Keeps the store's notices, the timeline and every map channel in step with the selected build and frame. */
export function createDisplayOps(ctx: PreviewContext, ops: PreviewOps): Omit<PreviewOps, 'writeUrl' | 'applyHistory'> {
  const { writer, view } = ctx.store, { live, state } = ctx;
  return {
    /** Forwards theme, opacity, visibility and units to every map channel. */
    syncChannels() {
      for (const channel of live.channels) channel.update(ctx.intent());
      live.wind?.syncHostVisibility();
    },

    clearForecast() {
      live.wind?.session.clear(); live.point?.close();
      for (const channel of [...live.channels].reverse()) channel.clear();
      live.seam?.sync(null, null); ops.updateTimeUi();
    },

    syncLayers() {
      const current = ctx.build();
      writer.forecast({ layers: layerOptions(current) });
      const customLayer = validatedCustomLayer(current, ctx.intent().customLayer);
      if (customLayer !== ctx.intent().customLayer) writer.intent({ customLayer });
    },

    syncSelectedAdmission() {
      ctx.services.forecastScheduler.setForegroundPending(++state.admissionEpoch, state.rasterPending || state.windPending);
    },

    showError(message) { writer.notices({ error: message }); },

    updatePreparation() {
      const current = ctx.build(), raster = view.overlay.value;
      const frames = current && !ctx.forecast().expired ? renderedFrames(current.manifest) : [];
      const compatible = raster.requested?.build === current && raster.requested?.layer === ctx.layer();
      const previews = new Set(compatible ? raster.previewReadyFrames ?? [] : []);
      const details = new Set(compatible ? raster.detailDrawableFrames ?? raster.detailReadyFrames ?? [] : []);
      const readiness = preparedAxisReadiness(frames, previews, details, live.wind?.readyFrames() ?? null);
      writer.notices({ ...readiness, preparationLimited: Boolean(raster.limited || live.wind?.limited()) });
      live.timeline?.setReadiness?.(readiness.overviewReady, readiness.overviewTotal, raster.viewLoading);
    },

    updateScale() {
      if (!live.camera) return;
      const scale = live.camera.scale(ctx.intent().units);
      writer.notices({ scaleWidth: scale.width, scaleText: scale.text });
    },

    paintMapHorizon(now = Date.now()) {
      const current = ctx.build();
      if (!current || ctx.forecast().expired) return;
      writer.notices({ horizon: mapForecastHorizonNotice(current.manifest, now, ms => formatZoneTime(ms, ctx.forecast().timeZone, 'stamp')) ?? '' });
    },

    updateFreshness() {
      live.overlay?.refresh();
      const current = ctx.build();
      if (!current || ctx.forecast().expired) return;
      const now = Date.now();
      if (current.expiresAtMs <= now) { ctx.forecastSession.expire(); return; }
      ops.paintMapHorizon(now);
      writer.notices({
        freshness: (ctx.intent().model === AUTO_MODEL_ID ? `${current.manifest.model} · ` : '') + formatBuildFreshness(current.manifest, current.expiresAtMs, now),
        runAge: formatRunAge(current.manifest.cycle, now)
      });
    },

    updateTimeUi() {
      const current = ctx.build(), frames = current ? renderedFrames(current.manifest) : [];
      live.timeline?.update(frames, ctx.selectedFrame(), !current || ctx.forecast().expired || ctx.forecast().mapFailed);
    },

    updateWind() { live.wind?.session.update(); live.point?.feature.syncWind(); },
    refreshSeam() { live.seam?.sync(ctx.build(), ctx.layer()); },

    updateOverlay() {
      const current = ctx.build(), frame = ctx.selectedFrame(), selected = ctx.layer();
      if (!ctx.forecast().mapReady || !current || !frame || !selected || !ctx.forecastSession.ensureLive()) return;
      ops.updateWind();
      writer.notices({ error: '' }); state.selectingOverlay = true;
      try {
        live.overlay!.select(current, selected, frame);
        live.sky?.select(current, frame);
        ops.syncChannels();
        ops.refreshSeam();
      } catch (error) { ops.showError(`Overlay display failed: ${error instanceof Error ? error.message : String(error)}`); }
      finally { state.selectingOverlay = false; live.point?.feature.syncSelection(); }
    },

    /** Warms `frameId` for every visible channel, or for one sky channel. */
    prepareFrame(frameId, channel) {
      const current = ctx.build();
      if (!current) return;
      const selected = ctx.layer();
      if (!channel && selected && current.templates[selected] && ctx.intent().liftVisible) live.overlay?.prepare(selected, frameId);
      live.sky?.prepare(current, frameId, channel);
    },

    prepareFrameIndex(index) {
      const current = ctx.build();
      const frame = current && ctx.forecast().mapReady && !ctx.forecast().expired ? renderedFrames(current.manifest)[index] : undefined;
      if (frame) ops.prepareFrame(frame.id);
    },

    selectIndex(index, mode, fromTimeline = false) {
      const current = ctx.build();
      const frame = current ? renderedFrames(current.manifest)[index] : undefined;
      if (!frame) return;
      if (!fromTimeline) live.timeline?.cancelGesture();
      if (ctx.intent().model === AUTO_MODEL_ID && ctx.intent().requestedTime !== frame.validTime) ctx.forecastSession.cancelAuto();
      ctx.forecastSession.commitFrame(frame.id, frame.validTime);
      ops.updateTimeUi(); live.point?.feature.followMapFrame(frame.id); ops.updateOverlay(); live.point?.feature.syncSelection();
      if (mode !== 'none') {
        ops.writeUrl(mode);
        if (ctx.intent().model === AUTO_MODEL_ID) void ctx.forecastSession.loadAuto();
      }
    },

    focusRegion(model) {
      live.camera?.focusRegion(MODEL_OPTIONS.find(choice => choice.modelId === model)?.bounds);
    },

    setUnits(units) {
      writer.intent({ units });
      ctx.startup.preferences.setUnits(units);
      live.wind?.setUnits(units);
      ops.syncChannels();
      live.point?.relabel(units);
      ops.updateScale(); live.point?.feature.syncSelection();
      ops.writeUrl('replace');
    }
  };
}

/**
 * Effects for the views that derive purely from store signals (root chrome, frame status line, tile
 * notice), so every change repaints them without a caller remembering to. Disposed when `signal` aborts.
 */
export function installDerivedViews(ctx: PreviewContext, root: HTMLElement, signal: AbortSignal): void {
  const { writer, view } = ctx.store;
  const disposers = [
    effect(() => { root.dataset.chrome = themeOption(view.intent.value.theme).darkChrome ? 'dark' : 'light'; }),
    effect(() => {
      const { build, pendingModel, expired, playing, timeZone } = view.forecast.value;
      writer.notices(overlayNotices(view.overlay.value, { build, pendingModel, expired, playing, timeZone }));
    })
  ];
  signal.addEventListener('abort', () => { for (const dispose of disposers) dispose(); }, { once: true });
}
