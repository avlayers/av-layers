import { AUTO_MODEL_ID, formatPlaceTime } from '@av/client';
import { renderedFrames } from '@av/contracts/publication';
import { MODEL_OPTIONS } from '@av/contracts/model-options';
import type { ModelId } from '@av/contracts/publication';
import type { LayerId } from '@av/contracts/layers';
import type { PinnedBuild, UnitSystem } from '@av/client';
import type { AltitudeReference } from './features/navigation/url-state';
import type { PreviewCommands } from './app/preview-commands';
import type { PreviewStore } from './stores/app-store';
import { legendModel } from './features/controls/legend-model';

function Legend(props: { build: PinnedBuild | null; layer: LayerId | null; units: UnitSystem; reference: AltitudeReference; referenceHidden: boolean; disabled: boolean; opacity: number; onReference: (reference: AltitudeReference) => void; onPrepareLayer: (layer: 'lift' | LayerId) => void; onOpacity: (value: number) => void; onOpacityStart: () => void; onOpacityReset: () => void; }) {
  const model = props.build && props.layer ? legendModel(props.build, props.layer, props.units) : null;
  const altitudeUnit = props.units === 'imperial' ? 'ft' : 'm';
  const unitLabel = model?.unitLabel ?? `Lift ${altitudeUnit}`;
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
            <p id="legend-reference">{model?.reference ?? ''}</p>
            <p id="legend-no-lift">{model?.noLift ?? ''}</p>
            <p id="legend-cutoff">{model?.cutoff ?? ''}</p>
            <p>Missing data and areas outside coverage are clear. Select a point to check its status.</p>
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

  const chosen = intent.model === AUTO_MODEL_ID && build ? `Auto · ${build.manifest.model}` : intent.model === AUTO_MODEL_ID ? 'Auto' : intent.model;
  const name = offline ? 'Synthetic fixture' : MODEL_OPTIONS.find(option => option.modelId === intent.model)?.label ?? chosen;
  const emblem = intent.model === AUTO_MODEL_ID ? build?.manifest.model ?? 'auto' : intent.model;
  const modelChoices = offline ? [{ modelId: fixtureModel, label: 'Synthetic fixture' }] : [...MODEL_OPTIONS, { modelId: AUTO_MODEL_ID as ModelId, label: 'Auto' }];
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
            <summary id="model-selected" data-model={emblem}>
              <svg class="model-emblem" viewBox="0 0 32 32" aria-hidden="true"><path d="M2 24 11 8l5 8 5-12 9 20M2 29h28" /></svg>
              <span id="model-name">{name}</span>
            </summary>
            <div id="models" role="toolbar" aria-label="Forecast model">
              {modelChoices.map(choice => (
                <button
                  key={choice.modelId}
                  type="button"
                  class={choice.modelId === intent.model ? 'model-button is-selected' : 'model-button'}
                  value={choice.modelId}
                  disabled={forecast.mapFailed || forecast.pendingModel !== null}
                  onClick={event => {
                    const details = (event.currentTarget as HTMLElement).closest('details');
                    if (details) details.open = false;
                    commands.selectModel(choice.modelId);
                  }}
                >{choice.label}</button>
              ))}
            </div>
          </details>
          {forecast.layers.length > 1 ? (
            <div id="layer-picker" role="group" aria-label="Forecast layer">
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
        <div id="display-units" role="group" aria-label="Display units">
          <button id="units-metric" type="button" aria-pressed={intent.units === 'metric'} onClick={() => commands.setUnits('metric')}>km</button>
          <button id="units-imperial" type="button" aria-pressed={intent.units === 'imperial'} onClick={() => commands.setUnits('imperial')}>mi</button>
        </div>
      </header>
      <button
        id="locate" type="button" aria-label="Go to current location"
        aria-busy={location.busy} disabled={location.busy || forecast.mapFailed} onClick={commands.locate}
      >
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
          <circle cx="12" cy="12" r="7" /><circle cx="12" cy="12" r="2.5" /><path d="M12 1v4m0 14v4M1 12h4m14 0h4" />
        </svg>
      </button>
      <p id="location-status" role="status" hidden={!location.message} title={location.detail}>{location.message}</p>
      <div id="wind-controls" />
      <div id="map-controls">
        <div id="map-dock">
          <p id="distance-scale" aria-label="Map scale" style={{ width: `${notices.scaleWidth}px` }}>{notices.scaleText}</p>
          <Legend
            build={displayed?.build ?? null}
            layer={displayed?.layer ?? null}
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
