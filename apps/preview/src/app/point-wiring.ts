import type { Map as MapLibreMap } from 'maplibre-gl';
import type { PinnedBuild, PointHorizon, PointSeriesController, UnitSystem } from '@av/client';
import { easePointIntoClearView } from '../features/point/point-camera';
import { createPointFeature, type PointFeature, type PointWind } from '../features/point/point-feature';
import { createPointMarker, type PointMarker } from '../features/point/point-marker';
import type { PointViewMode } from '@av/windgram';
import type { PreviewStore } from '../stores/app-store';

type Coords = { lat: number; lon: number };
type Elevation = { metres: number | null; reference: 'terrain' | 'model' | null };

const coordsLabel = (coords: Coords): string => `${coords.lat.toFixed(3)}°, ${coords.lon.toFixed(3)}°`;

function detailLabel(coords: Coords, elev: Elevation, units: UnitSystem): string {
  const base = coordsLabel(coords);
  if (elev.metres === null || !Number.isFinite(elev.metres)) return base;
  const converted = units === 'imperial' ? Math.round(elev.metres / 0.3048) : Math.round(elev.metres);
  const unit = units === 'imperial' ? 'ft' : 'm';
  return `${base} · ${elev.reference === 'model' ? 'model ' : ''}${converted.toLocaleString('en-US')} ${unit} MSL`;
}

interface PointWiringOptions {
  readonly root: HTMLElement;
  readonly map: MapLibreMap;
  readonly store: PreviewStore;
  readonly series: PointSeriesController;
  readonly build: () => PinnedBuild | null;
  readonly selectedFrame: () => string | null;
  readonly mapOffsetMinutes: () => number;
  readonly displayedFrame: () => string | null;
  readonly wind: () => PointWind | null;
  readonly ensureLive: () => boolean;
  readonly timeline: () => { pause(): void; setHighlightedDays?(days: readonly string[] | null): void } | null;
  readonly selectFrameById: (id: string) => void;
  readonly setViewMode: (mode: PointViewMode) => void;
  readonly setHorizon: (horizon: PointHorizon) => void;
  readonly destroyed: () => boolean;
}

/** The point card, its map marker and the camera ease that keeps the point clear of the card. */
export interface PointWiring {
  readonly feature: PointFeature;
  readonly marker: PointMarker;
  readonly isOpen: () => boolean;
  close(): void;
  /** Re-renders the location labels in `units`. */
  relabel(units: UnitSystem): void;
  syncBarReserve(): void;
  /** Stops a pending ease when the user moves the map. */
  cancelEase(): void;
}

export function createPointWiring(options: PointWiringOptions): PointWiring {
  const { root, map, store: { writer, view } } = options;
  let ease: { point: Coords; settled: boolean } | null = null;
  let coords: Coords | null = null;
  let elevation: Elevation = { metres: null, reference: null };

  const syncBarReserve = (): void => {
    const card = root.querySelector<HTMLElement>('#point-card');
    const trigger = root.querySelector<HTMLElement>('#point-info-trigger');
    if (!card || !trigger || !('offsetWidth' in trigger)) return;
    const width = trigger.offsetWidth;
    if (width > 0) card.style?.setProperty?.('--av-bar-reserve-right', `${Math.ceil(width + 8)}px`);
  };
  const relabel = (units: UnitSystem): void => {
    if (coords && view.point.value.open) writer.point({ location: coordsLabel(coords), detailLocation: detailLabel(coords, elevation, units) });
  };
  const easeAfterLayout = (token: { point: Coords; settled: boolean }): void => {
    const schedule = root.ownerDocument?.defaultView?.requestAnimationFrame ?? ((cb: FrameRequestCallback) => { cb(0); return 0; });
    schedule(() => {
      syncBarReserve();
      if (!options.destroyed() && ease === token && view.point.value.open) easePointIntoClearView(map, root, token.point);
    });
  };
  const forget = (): void => {
    ease = null; coords = null; elevation = { metres: null, reference: null };
    options.timeline()?.setHighlightedDays?.(null);
    marker.clear();
  };

  const marker = createPointMarker(map, root.ownerDocument ?? document);
  const feature = createPointFeature({
    root: () => root,
    series: options.series,
    isOpen: () => view.point.value.open,
    getBuild: options.build,
    getSelectedFrame: options.selectedFrame,
    getUnits: () => view.intent.value.units,
    getHorizon: () => view.intent.value.pointHorizon,
    getViewMode: () => view.intent.value.pointViewMode,
    getMapOffset: options.mapOffsetMinutes,
    getDisplayedFrame: options.displayedFrame,
    getWind: options.wind,
    ensureLive: options.ensureLive,
    pauseTimeline: () => options.timeline()?.pause(),
    selectFrameById: options.selectFrameById,
    onViewModeChange: options.setViewMode,
    onRequestFullHorizon: () => { if (view.intent.value.pointHorizon !== 'forecast') options.setHorizon('forecast'); },
    onVisibleDaysChange: days => options.timeline()?.setHighlightedDays?.(days),
    publish: {
      open: point => {
        ease = { point, settled: false };
        coords = point;
        elevation = { metres: null, reference: null };
        marker.show(point);
        writer.point({ open: true, location: coordsLabel(point), detailLocation: coordsLabel(point) });
        easeAfterLayout(ease);
      },
      close: () => { forget(); writer.point({ open: false, status: '', wind: '' }); },
      status: text => writer.point({ status: text }),
      busy: busy => {
        writer.point({ busy });
        syncBarReserve();
        if (ease && !ease.settled && root.querySelector('#point-body .av-point-series')) {
          ease.settled = true;
          easeAfterLayout(ease);
        }
      },
      horizon: (selectable, label) => writer.point({ horizonSelectable: selectable, horizonLabel: label }),
      wind: text => writer.point({ wind: text }),
      elevation: (metres, reference) => { elevation = { metres, reference }; relabel(view.intent.value.units); }
    }
  });

  return {
    feature, marker, relabel, syncBarReserve,
    isOpen: () => Boolean(view.point.value.open || feature.current || feature.pending),
    close() {
      ease = null;
      options.timeline()?.setHighlightedDays?.(null);
      marker.clear();
      feature.close();
    },
    cancelEase() { ease = null; }
  };
}
