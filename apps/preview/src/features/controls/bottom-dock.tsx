import type { ComponentChildren } from 'preact';
import type { LayerId } from '@av/contracts/layers';
import type { PinnedBuild, UnitSystem } from '@av/client';
import { themeOption, type MapTheme } from '../../themes/registry';
import type { AltitudeReference } from '../../layers/registry';
import { liftLayerFor } from '../../layers/registry';
import {
  DOCK_VIEW_OPTIONS,
  legendRangeSummary,
  spectrumGradientCss,
  type DockViewId,
  type DockViewOption
} from './bottom-dock-model';
import { legendModel, type LegendModel } from './legend-model';

interface BottomDockProps {
  readonly dockView: DockViewId;
  readonly build: PinnedBuild | null;
  readonly layer: LayerId | null;
  readonly theme: MapTheme;
  readonly liftVisible: boolean;
  readonly cloudsVisible: boolean;
  readonly rainVisible: boolean;
  readonly isobarsVisible: boolean;
  readonly units: UnitSystem;
  readonly reference: AltitudeReference;
  readonly referenceHidden: boolean;
  readonly disabled: boolean;
  readonly opacity: number;
  readonly scaleWidth: number;
  readonly scaleText: string;
  readonly frameStatus: string;
  readonly quality: string;
  readonly windActive: boolean;
  readonly overviewReady: number;
  readonly overviewTotal: number;
  readonly detailReady: number;
  readonly preparationLimited: boolean;
  readonly selectedIndex: number;
  readonly frameCount: number;
  readonly timestamp: string;
  readonly onReference: (reference: AltitudeReference) => void;
  readonly onPrepareLayer: (layer: 'lift' | LayerId) => void;
  readonly onOpacity: (value: number) => void;
  readonly onOpacityStart: () => void;
  readonly onOpacityReset: () => void;
  readonly onSelectDockView: (dockView: DockViewId) => void;
}

interface ResolvedDockProps extends BottomDockProps {
  readonly model: LegendModel | null;
  readonly unitLabel: string;
}

function ReferenceToggle(props: {
  reference: AltitudeReference;
  referenceHidden: boolean;
  disabled: boolean;
  onReference: (reference: AltitudeReference) => void;
  onPrepareLayer: (layer: 'lift' | LayerId) => void;
}) {
  return (
    <div id="reference" role="group" aria-label="Lift reference" hidden={props.referenceHidden}>
      {(['agl', 'msl'] as const).map(reference => (
        <button
          key={reference}
          id={`ref-${reference}`}
          type="button"
          class={props.reference === reference ? 'ref is-selected' : 'ref'}
          aria-pressed={props.reference === reference}
          disabled={props.disabled}
          onPointerEnter={() => props.onPrepareLayer(liftLayerFor(reference))}
          onFocus={() => props.onPrepareLayer(liftLayerFor(reference))}
          onPointerDown={() => props.onPrepareLayer(liftLayerFor(reference))}
          onClick={() => props.onReference(reference)}
        >{reference.toUpperCase()}</button>
      ))}
    </div>
  );
}

function ScaleStops(props: { model: LegendModel }) {
  return (
    <div class="ribbon-main">
      <p class="ribbon-title">{props.model.title}</p>
      <div class="ribbon-scale">
        {props.model.stops.map((stop, index) => (
          <div key={index} class="ribbon-stop">
            <span style={{ background: stop.color }} />
            <span>{stop.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function DockViewSwitcher(props: {
  dockView: string;
  options?: readonly DockViewOption[];
  onSelectDockView: (dockView: DockViewId) => void;
}) {
  const options = props.options ?? DOCK_VIEW_OPTIONS;
  if (options.length <= 1) return null;
  return (
    <div class="dock-view-switcher" role="group" aria-label="Bottom dock layout">
      <span class="dock-view-label">Bottom bar</span>
      <div class="dock-view-pills">
        {options.map(option => {
          const active = option.id === props.dockView;
          return (
            <button
              key={option.id}
              type="button"
              class={active ? 'dock-view-pill is-selected' : 'dock-view-pill'}
              aria-pressed={active}
              title={option.summary}
              onClick={() => props.onSelectDockView(option.id)}
            >{option.label}</button>
          );
        })}
      </div>
    </div>
  );
}

function LayerKeyBody(props: ResolvedDockProps) {
  const cloudStops = themeOption(props.theme).cloudLegend;
  const rainStops = themeOption(props.theme).rainLegend;
  const activeTheme = themeOption(props.theme);
  const opacityPct = `${Math.round(props.opacity * 100)}%`;

  return (
    <div class="ribbon-key-body">
      <div class="capsule-popover-controls">
        <div class="capsule-popover-row">
          <span id="lift-units">{props.unitLabel}</span>
          <ReferenceToggle
            reference={props.reference}
            referenceHidden={props.referenceHidden}
            disabled={props.disabled}
            onReference={props.onReference}
            onPrepareLayer={props.onPrepareLayer}
          />
        </div>
        <label id="opacity-label" class="capsule-opacity-row" aria-label="Layer opacity">
          <span class="capsule-opacity-title">Opacity</span>
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
          <span id="opacity-readout">{opacityPct}</span>
        </label>
        {props.model ? (
          <div class="capsule-popover-scale">
            <ScaleStops model={props.model} />
          </div>
        ) : null}
      </div>
      <p id="legend-theme"><strong>{activeTheme.label}:</strong> {activeTheme.summary}.</p>
      {props.model ? (
        <>
          <p id="legend-reference">{props.model.reference}</p>
          <p id="legend-no-lift">{props.model.noLift}</p>
          <p id="legend-cutoff">{props.model.cutoff}</p>
        </>
      ) : null}
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
      <DockViewSwitcher dockView={props.dockView} onSelectDockView={props.onSelectDockView} />
      <p class="legend-shortcuts">Shortcuts: <strong>[</strong> / <strong>]</strong> map style · <strong>W</strong> wind · <strong>I</strong> isobars · <strong>Space</strong> / <strong>P</strong> peek.</p>
    </div>
  );
}

function CapsuleLegendChrome(props: ResolvedDockProps) {
  const { model } = props;
  const opacityPct = `${Math.round(props.opacity * 100)}%`;
  const rangeText = model ? legendRangeSummary(model.stops) : '';
  const refBadge = props.referenceHidden ? props.unitLabel : props.reference.toUpperCase();
  const nextRef: AltitudeReference = props.reference === 'agl' ? 'msl' : 'agl';
  const gradient = model ? spectrumGradientCss(model.stops) : 'transparent';

  return (
    <aside id="legend" class="capsule-legend" hidden={!model}>
      <div
        class={props.liftVisible ? 'capsule-spectrum-lip' : 'capsule-spectrum-lip is-muted'}
        style={{ background: gradient }}
        aria-hidden="true"
      />
      <div class="capsule-inline-controls">
        <details id="legend-key" class="ribbon-key capsule-key">
          <summary id="legend-key-toggle" class="capsule-key-trigger" aria-label={`Layer key${rangeText ? ` ${rangeText}` : ''}, opacity ${opacityPct}`}>
            <span class="capsule-key-swatch" style={{ background: gradient }} aria-hidden="true" />
            {props.referenceHidden ? <span class="capsule-chip-lead">{refBadge}</span> : 'Key'}
          </summary>
          <LayerKeyBody {...props} />
        </details>
        {!props.referenceHidden ? (
          <button
            type="button"
            class="capsule-ref-flip"
            disabled={props.disabled}
            aria-label={`Lift reference ${props.reference.toUpperCase()}, activate for ${nextRef.toUpperCase()}`}
            title={`Switch to ${nextRef.toUpperCase()}`}
            onPointerEnter={() => props.onPrepareLayer(liftLayerFor(nextRef))}
            onFocus={() => props.onPrepareLayer(liftLayerFor(nextRef))}
            onPointerDown={() => props.onPrepareLayer(liftLayerFor(nextRef))}
            onClick={() => props.onReference(nextRef)}
          >{refBadge}</button>
        ) : null}
      </div>
    </aside>
  );
}

const DOCK_LEGEND_RENDERERS: Record<DockViewId, (props: ResolvedDockProps) => ComponentChildren> = {
  capsule: CapsuleLegendChrome
};

let legendCache: {
  build: PinnedBuild;
  layer: LayerId;
  units: UnitSystem;
  theme: MapTheme;
  model: LegendModel | null;
} | null = null;

function cachedLegendModel(
  build: PinnedBuild | null,
  layer: LayerId | null,
  units: UnitSystem,
  theme: MapTheme
): LegendModel | null {
  if (!build || !layer) return null;
  if (
    legendCache
    && legendCache.build === build
    && legendCache.layer === layer
    && legendCache.units === units
    && legendCache.theme === theme
  ) {
    return legendCache.model;
  }
  const model = legendModel(build, layer, units, theme);
  legendCache = { build, layer, units, theme, model };
  return model;
}

export function BottomDock(props: BottomDockProps) {
  const model = cachedLegendModel(props.build, props.layer, props.units, props.theme);
  const altitudeUnit = props.units === 'imperial' ? 'ft' : 'm';
  const unitLabel = model?.unitLabel ?? `Lift ${altitudeUnit}`;
  const resolved: ResolvedDockProps = { ...props, model, unitLabel };
  const renderLegend = DOCK_LEGEND_RENDERERS[props.dockView];

  return (
    <div id="map-controls" data-dock-view={props.dockView}>
      <div id="map-dock" data-dock-view={props.dockView} data-has-legend={model ? 'true' : 'false'}>
        <p id="distance-scale" aria-label="Map scale" style={{ width: `${props.scaleWidth}px` }}>{props.scaleText}</p>
        {renderLegend(resolved)}
        <footer id="timebar">
          <div id="compact-timeline" />
          <input
            id="time" class="sr-only" type="range" min="0" max={Math.max(0, props.frameCount - 1)} step="1"
            value={props.selectedIndex} aria-label="Forecast time" tabindex={-1}
          />
          <p id="timestamp" class="sr-only">{props.timestamp}</p>
        </footer>
        <div class="timebar-status sr-only">
          <p id="frame-status" role="status" aria-live="polite" data-quality={props.quality}>{props.frameStatus}</p>
          <p id="timeline-status" hidden={!props.overviewTotal} data-ready={props.overviewReady} data-total={props.overviewTotal} data-detail-ready={props.detailReady}>
            Preview{props.windActive ? ' + wind' : ''} ready {props.overviewReady} / {props.overviewTotal}
            {' · '}Detail ready {props.detailReady} / {props.overviewTotal}{props.preparationLimited ? ' · Capacity limited' : ''}
          </p>
        </div>
      </div>
    </div>
  );
}
