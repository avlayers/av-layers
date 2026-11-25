import { AUTO_MODEL_ID, normalizePoint, type PointHorizon } from '@av/client';
import { liftLayerFor } from '../layers/registry';
import type { PreviewContext } from './context';
import type { PreviewOps } from './display-ops';
import type { PreviewCommands } from './preview-commands';

/**
 * Opacity slider history: a drag writes the URL and preference once, on release; a tap or key
 * step pushes the first change and replaces after that.
 */
function createOpacityGesture() {
  let committed = false, dragging = false, dirty = false;
  return {
    begin() { committed = false; dragging = true; dirty = false; },
    /** Returns the history mode to write now, or null while a drag is in progress. */
    changed(): 'push' | 'replace' | null {
      if (dragging) { dirty = true; return null; }
      const mode = committed ? 'replace' : 'push';
      committed = true;
      return mode;
    },
    /** Ends the gesture; returns the history mode to commit a dragged change with, or null. */
    reset(): 'push' | 'replace' | null {
      const mode = dragging && dirty ? (committed ? 'replace' : 'push') : null;
      dragging = dirty = false; committed = false;
      return mode;
    }
  };
}

/** The commands the UI calls; each updates intent, then the channels, preferences and URL. */
export function createCommands(ctx: PreviewContext, ops: PreviewOps): PreviewCommands {
  const { writer } = ctx.store, { live, history } = ctx, preferences = ctx.startup.preferences;
  const opacity = createOpacityGesture();

  const showLayer = (patch: Partial<Pick<ReturnType<typeof ctx.intent>, 'reference' | 'customLayer'>>): void => {
    live.timeline?.cancelGesture();
    writer.intent({ ...patch, liftVisible: true, peeking: false });
    ops.syncChannels();
    ops.updateOverlay(); ops.writeUrl('push');
    if (ctx.intent().model === AUTO_MODEL_ID) void ctx.forecastSession.loadAuto();
  };

  const commands: PreviewCommands = {
    selectModel(model) {
      if (ctx.mapFailed()) return;
      live.timeline?.cancelGesture();
      if (ctx.intent().model === AUTO_MODEL_ID) history.cancelRestore();
      void ctx.forecastSession.load(model);
      ops.focusRegion(model);
    },
    selectReference(reference) { showLayer({ reference, customLayer: null }); },
    selectLayer(selected) { showLayer({ customLayer: selected === 'lift' ? null : selected }); },
    prepareLayer(target) {
      const current = ctx.build(), frame = ctx.selectedFrame();
      const id = target === 'lift' ? liftLayerFor(ctx.intent().reference) : target;
      if (current && frame && current.templates[id]) live.overlay?.prepare(id, frame);
    },
    prepareWeatherChannel(channel) {
      const frame = ctx.selectedFrame();
      if (channel === 'lift') commands.prepareLayer('lift');
      else if (channel !== 'wind' && frame) ops.prepareFrame(frame, channel);
    },
    setTheme(theme) {
      if (ctx.intent().theme === theme) return;
      writer.intent({ theme });
      preferences.setTheme(theme);
      ops.syncChannels();
      ops.writeUrl('replace');
    },
    setDockView(dockView) {
      if (ctx.intent().dockView === dockView) return;
      writer.intent({ dockView });
      preferences.setDockView(dockView);
      live.timeline?.setVariant?.(dockView);
      ops.writeUrl('replace');
    },
    toggleWeatherLayer(channel) {
      const cur = ctx.intent();
      if (channel === 'wind') {
        live.wind?.set({ style: cur.windStyle, visible: cur.peeking ? true : !cur.windVisible, paused: cur.windPaused, height: cur.windHeight });
        return;
      }
      const key = `${channel}Visible` as const;
      writer.intent({ [key]: !cur[key], peeking: false });
      ops.syncChannels();
      ops.writeUrl('replace');
    },
    setPeeking(peeking) {
      if (ctx.intent().peeking === peeking) return;
      writer.intent({ peeking });
      ops.syncChannels();
    },
    setOpacity(value) {
      const next = Math.min(1, Math.max(0, value));
      if (ctx.intent().opacity === next) return;
      writer.intent({ opacity: next });
      ops.syncChannels();
      const mode = opacity.changed();
      if (!mode) return;
      preferences.setOpacity(next);
      ops.writeUrl(mode);
    },
    beginOpacityGesture() { opacity.begin(); },
    resetOpacityGesture() {
      const mode = opacity.reset();
      if (!mode) return;
      preferences.setOpacity(ctx.intent().opacity);
      ops.writeUrl(mode);
    },
    setUnits: units => ops.setUnits(units),
    setWind(state) { live.wind?.set(state); },
    setPointHorizon(horizon) {
      const next = horizon as PointHorizon;
      if (ctx.intent().pointHorizon === next) return;
      writer.intent({ pointHorizon: next });
      void live.point?.feature.setHorizon(next);
    },
    setPointViewMode(mode) {
      const nextHorizon: PointHorizon = mode === '3d' ? 'forecast' : ctx.intent().pointHorizon;
      const horizonChanged = nextHorizon !== ctx.intent().pointHorizon;
      writer.intent({ pointViewMode: mode, pointHorizon: nextHorizon });
      preferences.setPointViewMode(mode);
      if (horizonChanged) void live.point?.feature.setHorizon(nextHorizon);
      else live.point?.feature.syncViewMode?.();
    },
    selectFrame(index, mode) { ops.selectIndex(index, mode); },
    updateRun() { void ctx.forecastSession.updateRun(); },
    forecastAtCenter() {
      const map = live.map;
      if (!map || ctx.mapFailed() || !live.point) return;
      const center = map.getCenter();
      void live.point.feature.open(normalizePoint(center.lat, center.lng)).then(() => document.querySelector<HTMLElement>('#point-body')?.focus());
    },
    setPlaying(playing) {
      writer.forecast({ playing });
      for (const channel of live.channels) channel.setPlayback?.(playing);
      live.wind?.session.playbackChanged();
      ops.updatePreparation();
    },
    locate() { live.locationController?.locate(); },
    closePoint() { live.point?.close(); },
    refreshPointDiagnostics() { live.point?.feature.refreshDiagnostics(); }
  };
  return commands;
}
