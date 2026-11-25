import { AUTO_MODEL_ID, formatZoneTime } from '@av/client';
import { renderedFrames } from '@av/contracts/publication';
import { MODEL_OPTIONS } from '@av/contracts/model-options';
import type { ModelId } from '@av/contracts/publication';
import type { PreviewCommands } from './app/preview-commands';
import type { PreviewStore } from './stores/app-store';
import { BottomDock } from './features/controls/bottom-dock';
import { ModelEmblem, ThemeIconPicker, WeatherChannelDock } from './features/controls/topbar-icons';
import { cleanModelDisplayLabel, formatModelResolutionKm, modelRegionSubtitle } from './features/controls/topbar-model';

interface AppProps {
  readonly store: PreviewStore;
  readonly commands: PreviewCommands;
  readonly offline: boolean;
  readonly fixtureModel: ModelId;
}

export function App({ store, commands, offline, fixtureModel }: AppProps) {
  const intent = store.view.intent.value;
  const forecast = store.view.forecast.value;
  const overlay = store.view.overlay.value;
  const point = store.view.point.value;
  const wind = store.view.wind.value;
  const location = store.view.location.value;
  const notices = store.view.notices.value;

  const frames = forecast.build ? renderedFrames(forecast.build.manifest).flatMap(frame => frame.id ? [{ id: frame.id, validTime: frame.validTime }] : []) : [];
  const build = forecast.build;
  const activeBuild = build && !forecast.expired ? build : null;

  const isAutoModel = !offline && intent.model === AUTO_MODEL_ID;
  const effectiveModelId = isAutoModel ? (activeBuild?.manifest.model ?? null) : intent.model;
  const resolvedOption = effectiveModelId ? MODEL_OPTIONS.find(option => option.modelId === effectiveModelId) : undefined;
  const rawLabel = isAutoModel
    ? (activeBuild ? `Auto · ${resolvedOption ? cleanModelDisplayLabel(resolvedOption.label) : activeBuild.manifest.model}` : 'Auto')
    : (resolvedOption ? cleanModelDisplayLabel(resolvedOption.label) : intent.model);
  const name = offline ? 'Synthetic fixture' : rawLabel;
  const activeModelKm = offline ? null : formatModelResolutionKm(effectiveModelId);
  const emblem = offline ? fixtureModel : (isAutoModel ? (activeBuild?.manifest.model ?? 'auto') : intent.model);

  const modelChoices: ReadonlyArray<{
    readonly modelId: ModelId;
    readonly label: string;
    readonly subtitle?: string;
    readonly kmBadge: string | null;
    readonly isAuto?: boolean;
  }> = offline
    ? [{ modelId: fixtureModel, label: 'Synthetic fixture', kmBadge: null }]
    : [
        {
          modelId: AUTO_MODEL_ID as ModelId,
          label: 'Auto',
          subtitle: 'Best model for map view',
          kmBadge: isAutoModel && activeModelKm ? activeModelKm : 'Best km',
          isAuto: true
        },
        ...MODEL_OPTIONS.map(option => ({
          modelId: option.modelId,
          label: cleanModelDisplayLabel(option.label),
          subtitle: modelRegionSubtitle(option.modelId),
          kmBadge: formatModelResolutionKm(option.modelId)
        }))
      ];

  const selectedIndex = Math.max(0, frames.findIndex(frame => frame.id === forecast.selectedFrame));
  const selected = frames.find(frame => frame.id === forecast.selectedFrame);
  const timestamp = !build || !selected ? (forecast.expired ? 'Build expired — overlay removed' : 'No frame selected')
    : `Selected · ${formatZoneTime(Date.parse(selected.validTime), forecast.timeZone, 'stamp')}`;
  const controlsDisabled = !build || forecast.expired || forecast.mapFailed || forecast.pendingModel !== null;
  const displayed = overlay.displayed;

  return (
    <>
      <div id="map" />
      <header id="topbar">
        <div class="topbar-row">
          <details id="model-picker">
            <summary
              id="model-selected"
              data-model={emblem}
              data-auto={isAutoModel ? 'true' : 'false'}
              title={activeModelKm ? `${name} · Approx. ${activeModelKm} grid spacing` : name}
            >
              {isAutoModel ? <ModelEmblem isAuto /> : null}
              <span id="model-name">{name}</span>
              {activeModelKm ? <span class="model-res-badge" aria-label={`Approximate resolution ${activeModelKm}`}>{activeModelKm}</span> : null}
              <span class="model-caret" aria-hidden="true">▾</span>
            </summary>
            <div id="models" role="toolbar" aria-label="Forecast model">
              {modelChoices.map(choice => {
                const isSelected = offline || choice.modelId === intent.model;
                return (
                  <button
                    key={choice.modelId}
                    type="button"
                    class={isSelected ? 'model-button is-selected' : 'model-button'}
                    value={choice.modelId}
                    disabled={forecast.mapFailed || forecast.pendingModel !== null}
                    onClick={event => {
                      const details = (event.currentTarget as HTMLElement).closest('details');
                      if (details) details.open = false;
                      commands.selectModel(choice.modelId);
                    }}
                  >
                    <span class="model-choice-lead">
                      <ModelEmblem isAuto={Boolean(choice.isAuto)} />
                      <span class="model-choice-copy">
                        <span class="model-choice-title">{choice.label}</span>
                        {choice.subtitle ? <span class="model-choice-sub">{choice.subtitle}</span> : null}
                      </span>
                    </span>
                    {choice.kmBadge ? <span class="model-choice-km">{choice.kmBadge}</span> : null}
                  </button>
                );
              })}
            </div>
          </details>

          <ThemeIconPicker
            theme={intent.theme}
            onSelectTheme={commands.setTheme}
          />

          <WeatherChannelDock
            theme={intent.theme}
            units={intent.units}
            windSupported={wind.supported}
            windVisible={intent.windVisible}
            windStyle={intent.windStyle}
            windPaused={intent.windPaused}
            windHeight={intent.windHeight}
            windStatus={wind.status}
            liftVisible={intent.liftVisible}
            cloudsVisible={intent.cloudsVisible}
            rainVisible={intent.rainVisible}
            isobarsVisible={intent.isobarsVisible}
            peeking={intent.peeking}
            disabled={controlsDisabled}
            onToggleChannel={commands.toggleWeatherLayer}
            onPrepareChannel={commands.prepareWeatherChannel}
            onSetWindStyle={style => commands.setWind({ style, visible: true, paused: intent.windPaused, height: intent.windHeight })}
            onSetWindPaused={paused => commands.setWind({ style: intent.windStyle, visible: true, paused, height: intent.windHeight })}
            onSetPeeking={commands.setPeeking}
          />

          {forecast.layers.length > 1 ? (
            <div id="layer-picker" role="group" aria-label="Primary forecast field">
              <span class="dock-group-tag" aria-hidden="true">Field</span>
              {forecast.layers.map(item => (
                <button
                  key={item.id} type="button"
                  class={item.id === (intent.customLayer ?? 'lift') ? 'layer-button is-selected' : 'layer-button'}
                  aria-pressed={item.id === (intent.customLayer ?? 'lift')}
                  disabled={controlsDisabled}
                  onPointerEnter={() => commands.prepareLayer(item.id)}
                  onFocus={() => commands.prepareLayer(item.id)}
                  onPointerDown={() => commands.prepareLayer(item.id)}
                  onClick={() => commands.selectLayer(item.id)}
                >{item.label}</button>
              ))}
            </div>
          ) : null}
        </div>
        {intent.peeking ? (
          <div class="topbar-subrow">
            <span id="peek-badge" role="status">Bare terrain peek · Release or tap Peek to restore</span>
          </div>
        ) : null}
      </header>
      <aside id="right-rail" aria-label="Map instruments">
        <button
          id="locate" type="button" aria-label="Go to current location"
          aria-busy={location.busy} disabled={location.busy || forecast.mapFailed} onClick={commands.locate}
        >
          <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true">
            <circle cx="12" cy="12" r="6.8" /><circle cx="12" cy="12" r="2.2" /><path d="M12 2v3.5m0 13V22M2 12h3.5m13 0H22" />
          </svg>
        </button>
        <div id="wind-controls" hidden={!wind.supported || !intent.windVisible || intent.peeking} />
        <div id="display-units" role="group" aria-label="Display units">
          <button id="units-metric" type="button" aria-label="Metric units (km, m)" aria-pressed={intent.units === 'metric'} onClick={() => commands.setUnits('metric')}>km</button>
          <button id="units-imperial" type="button" aria-label="Imperial units (mi, ft)" aria-pressed={intent.units === 'imperial'} onClick={() => commands.setUnits('imperial')}>mi</button>
        </div>
      </aside>
      <p id="location-status" role="status" hidden={!location.message} title={location.detail}>{location.message}</p>
      <BottomDock
        dockView={intent.dockView}
        build={displayed?.build ?? null}
        layer={displayed?.layer ?? null}
        theme={intent.theme}
        liftVisible={intent.liftVisible}
        cloudsVisible={intent.cloudsVisible}
        rainVisible={intent.rainVisible}
        isobarsVisible={intent.isobarsVisible}
        units={intent.units}
        reference={intent.reference}
        referenceHidden={intent.customLayer !== null}
        disabled={controlsDisabled}
        opacity={intent.opacity}
        scaleWidth={notices.scaleWidth}
        scaleText={notices.scaleText}
        frameStatus={notices.skyStatus ? `${notices.frameStatus} · ${notices.skyStatus}` : notices.frameStatus}
        quality={overlay.quality ?? 'none'}
        windActive={intent.windVisible && wind.supported}
        overviewReady={notices.overviewReady}
        overviewTotal={notices.overviewTotal}
        detailReady={notices.detailReady}
        preparationLimited={notices.preparationLimited}
        selectedIndex={selectedIndex}
        frameCount={frames.length}
        timestamp={timestamp}
        onReference={commands.selectReference}
        onPrepareLayer={commands.prepareLayer}
        onOpacity={commands.setOpacity}
        onOpacityStart={commands.beginOpacityGesture}
        onOpacityReset={commands.resetOpacityGesture}
        onSelectDockView={commands.setDockView}
      />
      {offline ? <p class="toast fixture-warning">SYNTHETIC FIXTURE — development data</p> : null}
      <p id="horizon-notice" class="toast" role="status" hidden={!notices.horizon}>{notices.horizon}</p>
      <p id="tile-error" class={notices.tileError ? 'toast error' : 'toast status'} role={notices.tileError ? 'alert' : 'status'} hidden={!notices.tileError}>{notices.tileError}</p>
      <p id="error" class="toast error" role="alert" hidden={!notices.error}>{notices.error}</p>
      <p id="freshness" class="sr-only">{notices.freshness}</p>
      <section
        id="point-card"
        aria-label="Point forecast"
        hidden={!point.open}
        aria-busy={point.busy}
      >
        <div id="point-body" tabindex={-1} />
        <p id="point-status" role="status" hidden={!point.status}>{point.status}</p>
        <details
          id="point-settings"
          class="point-info-tip"
          onToggle={event => {
            const target = event.currentTarget as HTMLDetailsElement;
            if (!target.open) return;
            const keyPop = target.closest('#point-card')?.querySelector<HTMLDetailsElement>('.av-windgram-key-pop[open]');
            if (keyPop) keyPop.open = false;
          }}
        >
          <summary id="point-info-trigger" aria-label="Point details" title={(point.detailLocation ?? point.location) || 'Point coordinates and forecast details'}>
            <span class="point-info-coords">{point.location}</span>
            <span class="point-info-glyph" aria-hidden="true">ⓘ</span>
          </summary>
          <div class="point-settings-body">
            <p id="point-location">{point.detailLocation ?? point.location}</p>
            <p id="point-wind" role="status" hidden={!point.wind}>{point.wind}</p>
            <details id="point-build-details" onToggle={event => { if ((event.currentTarget as HTMLDetailsElement).open) commands.refreshPointDiagnostics(); }}>
              <summary>Build details</summary>
              <dl id="meta" />
            </details>
          </div>
        </details>
      </section>
    </>
  );
}
