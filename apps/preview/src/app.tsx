import { AUTO_MODEL_ID, formatPlaceTime } from '@av/client';
import { renderedFrames } from '@av/contracts/publication';
import { MODEL_OPTIONS } from '@av/contracts/model-options';
import type { ModelId } from '@av/contracts/publication';
import type { LayerId } from '@av/contracts/layers';
import type { PinnedBuild, UnitSystem } from '@av/client';
import { themeCloudLegendStops, themeOption, themeRainLegendStops, type MapTheme } from './features/map/visual-theme';
import type { AltitudeReference } from './features/navigation/url-state';
import type { PreviewCommands } from './app/preview-commands';
import type { PreviewStore } from './stores/app-store';
import { legendModel } from './features/controls/legend-model';
import { ModelEmblem, ThemeIconPicker, WeatherChannelDock } from './features/controls/topbar-icons';
import { cleanModelDisplayLabel, formatModelResolutionKm } from './features/controls/topbar-model';

function Legend(props: {
  build: PinnedBuild | null;
  layer: LayerId | null;
  theme: MapTheme;
  cloudsVisible: boolean;
  rainVisible: boolean;
  isobarsVisible: boolean;
  units: UnitSystem;
  reference: AltitudeReference;
  referenceHidden: boolean;
  disabled: boolean;
  opacity: number;
  onReference: (reference: AltitudeReference) => void;
  onPrepareLayer: (layer: 'lift' | LayerId) => void;
  onOpacity: (value: number) => void;
  onOpacityStart: () => void;
  onOpacityReset: () => void;
}) {
  const model = props.build && props.layer ? legendModel(props.build, props.layer, props.units, props.theme) : null;
  const altitudeUnit = props.units === 'imperial' ? 'ft' : 'm';
  const unitLabel = model?.unitLabel ?? `Lift ${altitudeUnit}`;
  const cloudStops = themeCloudLegendStops(props.theme);
  const rainStops = themeRainLegendStops(props.theme);
  const activeTheme = themeOption(props.theme);

  return (
    <aside id="legend" class="ribbon" hidden={!model}>
      <div id="lift-controls">
        <span id="lift-units">{unitLabel}</span>
        <div id="reference" role="group" aria-label="Lift reference" hidden={props.referenceHidden}>
          {(['agl', 'msl'] as const).map(reference => (
            <button
              key={reference}
              id={`ref-${reference}`}
              type="button"
              class={props.reference === reference ? 'ref is-selected' : 'ref'}
              aria-pressed={props.reference === reference}
              disabled={props.disabled}
              onPointerEnter={() => props.onPrepareLayer(reference === 'agl' ? 'usable-lift-agl' : 'usable-lift-msl')}
              onFocus={() => props.onPrepareLayer(reference === 'agl' ? 'usable-lift-agl' : 'usable-lift-msl')}
              onPointerDown={() => props.onPrepareLayer(reference === 'agl' ? 'usable-lift-agl' : 'usable-lift-msl')}
              onClick={() => props.onReference(reference)}
            >{reference.toUpperCase()}</button>
          ))}
        </div>
        <label id="opacity-label" aria-label="Layer opacity">
          <input
            id="opacity"
            aria-label="Layer opacity"
            type="range" min="0" max="1" step="0.05"
            value={props.opacity}
            disabled={props.disabled}
            onPointerDown={props.onOpacityStart}
            onInput={event => props.onOpacity(Number((event.currentTarget as HTMLInputElement).value))}
            onChange={props.onOpacityReset}
          />
          <span id="opacity-readout">{`${Math.round(props.opacity * 100)}%`}</span>
        </label>
        <details id="legend-key" class="ribbon-key">
          <summary id="legend-key-toggle" aria-label="Map layer key">ⓘ</summary>
          <div class="ribbon-key-body">
            <p id="legend-theme"><strong>{activeTheme.label}:</strong> {activeTheme.summary}.</p>
            <p id="legend-reference">{model?.reference ?? ''}</p>
            <p id="legend-no-lift">{model?.noLift ?? ''}</p>
            <p id="legend-cutoff">{model?.cutoff ?? ''}</p>
            {props.cloudsVisible ? (
              <div class="mini-scale-block">
                <p class="mini-scale-label">Cloud cover (%)</p>
                <div class="mini-scale-row">
                  {cloudStops.map(stop => (
                    <span key={stop.label} class="mini-chip">
                      <i style={{ background: stop.color }} />
                      {stop.label}
                    </span>
                  ))}
                </div>
              </div>
            ) : null}
            {props.rainVisible ? (
              <div class="mini-scale-block">
                <p class="mini-scale-label">Precipitation (inner storm cuff + falling rain)</p>
                <div class="mini-scale-row">
                  {rainStops.map(stop => (
                    <span key={stop.label} class="mini-chip">
                      <i style={{ background: stop.color }} />
                      {stop.label}
                    </span>
                  ))}
                </div>
              </div>
            ) : null}
            {props.isobarsVisible ? (
              <p id="legend-isobars"><strong>Isobars:</strong> Sea-level pressure every 2 hPa (bold every 4 hPa) with synoptic H/L centers.</p>
            ) : null}
            <p>Shortcuts: <strong>[</strong> / <strong>]</strong> cycle map styles · <strong>I</strong> toggles isobars · hold <strong>Space</strong> (or press <strong>P</strong>) to peek at bare terrain.</p>
          </div>
        </details>
      </div>
      <div id="legend-body">
        {model ? (
          <div class="ribbon-main">
            <p class="ribbon-title">{model.title}</p>
            <div class="ribbon-scale">
              {model.stops.map((stop, index) => (
                <div key={index} class="ribbon-stop">
                  <span style={{ background: stop.color }} />
                  <span>{stop.label}</span>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </aside>
  );
}

export interface AppProps {
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

  const isAutoModel = intent.model === AUTO_MODEL_ID;
  const effectiveModelId = isAutoModel ? (build?.manifest.model ?? null) : intent.model;
  const resolvedOption = effectiveModelId ? MODEL_OPTIONS.find(option => option.modelId === effectiveModelId) : undefined;
  const rawLabel = isAutoModel
    ? (build ? `Auto · ${resolvedOption ? cleanModelDisplayLabel(resolvedOption.label) : build.manifest.model}` : 'Auto')
    : (resolvedOption ? cleanModelDisplayLabel(resolvedOption.label) : intent.model);
  const name = offline ? 'Synthetic fixture' : rawLabel;
  const activeModelKm = offline ? null : formatModelResolutionKm(effectiveModelId);
  const emblem = isAutoModel ? (build?.manifest.model ?? 'auto') : intent.model;

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
          kmBadge: formatModelResolutionKm(option.modelId)
        }))
      ];

  const selectedIndex = Math.max(0, frames.findIndex(frame => frame.id === forecast.selectedFrame));
  const selected = frames.find(frame => frame.id === forecast.selectedFrame);
  const timestamp = !build || !selected ? (forecast.expired ? 'Build expired — overlay removed' : 'No frame selected')
    : `Selected · ${formatPlaceTime(Date.parse(selected.validTime), forecast.offsetMinutes, 'stamp')}`;
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
              <ModelEmblem isAuto={isAutoModel} />
              <span id="model-name">{name}</span>
              {activeModelKm ? <span class="model-res-badge" aria-label={`Approximate resolution ${activeModelKm}`}>{activeModelKm}</span> : null}
              <span class="model-caret" aria-hidden="true">▾</span>
            </summary>
            <div id="models" role="toolbar" aria-label="Forecast model">
              {modelChoices.map(choice => {
                const isSelected = choice.modelId === intent.model;
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
            cloudStyle={intent.cloudStyle}
            rainStyle={intent.rainStyle}
            liftVisible={intent.liftVisible}
            cloudsVisible={intent.cloudsVisible}
            rainVisible={intent.rainVisible}
            isobarsVisible={intent.isobarsVisible}
            peeking={intent.peeking}
            disabled={controlsDisabled}
            onToggleChannel={commands.toggleWeatherLayer}
            onPrepareChannel={commands.prepareWeatherChannel}
            onSetCloudStyle={commands.setCloudStyle}
            onSetRainStyle={commands.setRainStyle}
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
        <div id="wind-controls" />
        <div id="display-units" role="group" aria-label="Display units">
          <button id="units-metric" type="button" aria-label="Metric units (km, m)" aria-pressed={intent.units === 'metric'} onClick={() => commands.setUnits('metric')}>km</button>
          <button id="units-imperial" type="button" aria-label="Imperial units (mi, ft)" aria-pressed={intent.units === 'imperial'} onClick={() => commands.setUnits('imperial')}>mi</button>
        </div>
      </aside>
      <p id="location-status" role="status" hidden={!location.message} title={location.detail}>{location.message}</p>
      <div id="map-controls">
        <div id="map-dock">
          <p id="distance-scale" aria-label="Map scale" style={{ width: `${notices.scaleWidth}px` }}>{notices.scaleText}</p>
          <Legend
            build={displayed?.build ?? null}
            layer={displayed?.layer ?? null}
            theme={intent.theme}
            cloudsVisible={intent.cloudsVisible}
            rainVisible={intent.rainVisible}
            isobarsVisible={intent.isobarsVisible}
            units={intent.units}
            reference={intent.reference}
            referenceHidden={intent.customLayer !== null}
            disabled={controlsDisabled}
            opacity={intent.opacity}
            onReference={commands.selectReference}
            onPrepareLayer={commands.prepareLayer}
            onOpacity={commands.setOpacity}
            onOpacityStart={commands.beginOpacityGesture}
            onOpacityReset={commands.resetOpacityGesture}
          />
          <footer id="timebar">
            <div id="compact-timeline" />
            <input
              id="time" class="sr-only" type="range" min="0" max={Math.max(0, frames.length - 1)} step="1"
              value={selectedIndex} aria-label="Forecast time" tabindex={-1}
            />
            <p id="timestamp" class="sr-only">{timestamp}</p>
          </footer>
          <div class="timebar-status">
            <p id="frame-status" role="status" aria-live="polite" data-quality={overlay.quality ?? 'none'}>{notices.frameStatus}</p>
            <p id="timeline-status" hidden={!notices.overviewTotal} data-ready={notices.overviewReady} data-total={notices.overviewTotal} data-detail-ready={notices.detailReady}>
              Preview{intent.windVisible && wind.supported ? ' + wind' : ''} ready {notices.overviewReady} / {notices.overviewTotal}
              {' · '}Detail ready {notices.detailReady} / {notices.overviewTotal}{notices.preparationLimited ? ' · Capacity limited' : ''}
            </p>
          </div>
        </div>
      </div>
      {offline ? <p class="toast fixture-warning">SYNTHETIC FIXTURE — development data</p> : null}
      <p id="horizon-notice" class="toast" role="status" hidden={!notices.horizon}>{notices.horizon}</p>
      <p id="tile-error" class={notices.tileError ? 'toast error' : 'toast status'} role={notices.tileError ? 'alert' : 'status'} hidden={!notices.tileError}>{notices.tileError}</p>
      <p id="error" class="toast error" role="alert" hidden={!notices.error}>{notices.error}</p>
      <p id="freshness" class="sr-only">{notices.freshness}</p>
      <section id="point-card" aria-label="Point forecast" hidden={!point.open} aria-busy={point.busy}>
        <div class="point-actions">
          <details id="point-settings">
            <summary aria-label="Forecast settings">⚙︎</summary>
            <div class="point-settings-body">
              <p id="point-location">{point.location}</p>
              <label id="point-horizon-label" class="point-units" hidden={!point.horizonSelectable}>
                Horizon
                <select id="point-horizon" value={intent.pointHorizon} onChange={event => commands.setPointHorizon((event.currentTarget as HTMLSelectElement).value === 'forecast' ? 'forecast' : 'day')}>
                  <option value="day">{point.horizonLabel}</option>
                  <option value="forecast">Full forecast</option>
                </select>
              </label>
              <details id="point-build-details" onToggle={event => { if ((event.currentTarget as HTMLDetailsElement).open) commands.refreshPointDiagnostics(); }}>
                <summary>Build details</summary>
                <dl id="meta" />
              </details>
            </div>
          </details>
          <button id="point-close" type="button" aria-label="Close point forecast" onClick={commands.closePoint}>×</button>
        </div>
        <div id="point-body" tabindex={-1} />
        <p id="point-wind" role="status">{point.wind}</p>
        <p id="point-status" role="status" hidden={!point.status}>{point.status}</p>
      </section>
    </>
  );
}
