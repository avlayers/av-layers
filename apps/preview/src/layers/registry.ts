import { LAYER_IDS, type LayerId } from '@av/contracts/layers';
import type { AltitudeReference } from '../features/navigation/url-state';

// Preview-side layer facts, one record per `LayerId`; `features/` reads them through the helpers below.
// Dock channel records (glyphs, copy, visibility field) live in `channels.ts`.

/** One of the paired AGL and MSL lift layers that the altitude toggle switches between. */
interface LiftLayerRecord {
  readonly reference: AltitudeReference;
  readonly legendTitle: (unit: 'm' | 'ft') => string;
  readonly legendReference: string;
  /** The published lift palette colours ground elevation where there is no usable lift. */
  readonly publishedGroundColors: boolean;
}

/** Preview-side facts about a forecast layer. The published layer descriptor owns label, units and palette. */
interface LayerRecord {
  readonly lift?: LiftLayerRecord;
  /** Layer picker and legend name; defaults to the descriptor label. */
  readonly shortName?: string;
  /** Drawn by its own map channel and never offered as a custom layer. */
  readonly hidden?: true;
}

const LAYER_RECORDS: Readonly<Record<LayerId, LayerRecord>> = {
  'usable-lift-msl': { lift: {
    reference: 'msl', legendTitle: unit => `Top of usable lift (${unit} MSL)`,
    legendReference: 'MSL shows top of usable lift above sea level.', publishedGroundColors: true
  } },
  'usable-lift-agl': { lift: {
    reference: 'agl', legendTitle: unit => `Lift above ground (${unit} AGL)`,
    legendReference: 'AGL shows usable lift height above ground.', publishedGroundColors: false
  } },
  'precip-rate': { hidden: true },
  'thermal-velocity': {},
  'thermal-top-msl': {},
  'pbl-height-agl': {},
  'sensible-heat-flux': {},
  'latent-heat-flux': {},
  'surface-lcl-msl': {},
  'cape-jkg': {},
  'cloud-cover-total': { shortName: 'Cloud' },
  'cloud-cover-low': { shortName: 'Cloud' },
  'sfc-temp-c': {},
  'sfc-dewpoint-c': {},
  'mslp-hpa': {},
  'wind-10m-u': {},
  'wind-10m-v': {},
  'wind-gust-10m': {},
  'bl-mean-wind-u': {},
  'bl-mean-wind-v': {}
};

const LIFT_BY_REFERENCE = new Map<AltitudeReference, LayerId>(
  LAYER_IDS.flatMap(id => { const lift = LAYER_RECORDS[id].lift; return lift ? [[lift.reference, id] as const] : []; })
);

export const layerRecord = (layer: LayerId): LayerRecord => LAYER_RECORDS[layer];

export const isLiftLayer = (layer: LayerId): boolean => !!LAYER_RECORDS[layer].lift;

/** The lift layer shown for an altitude reference. */
export const liftLayerFor = (reference: AltitudeReference): LayerId => LIFT_BY_REFERENCE.get(reference)!;
