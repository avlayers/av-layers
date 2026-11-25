// Pluggable SVG hover/inspection callout renderers for Windgram charts.
// To swap the default callout or add a new variant (e.g. 'ribbon' or 'compass'),
// register a WindgramCalloutRenderer in WINDGRAM_CALLOUT_RENDERERS and update
// DEFAULT_WINDGRAM_CALLOUT (or pass `calloutVariant` at mount/render time).
// Placement lives in `windgram-callout-placement.ts`.

import type { WindgramReading } from './scene-types.ts';
import { classicRenderer } from './windgram-callout-classic.ts';
import { tile2x2Renderer } from './windgram-callout-tile.ts';
import type { UnitSystem } from './windgram-format.ts';
import type { WindgramTelemetryStrip } from './windgram-readout.ts';

export const WINDGRAM_CALLOUT_VARIANTS = ['tile-2x2', 'classic'] as const;
export type WindgramCalloutVariant = (typeof WINDGRAM_CALLOUT_VARIANTS)[number];
export const DEFAULT_WINDGRAM_CALLOUT: WindgramCalloutVariant = 'tile-2x2';

interface WindgramCalloutPayload {
  readonly aglText: string;
  readonly mslText: string;
  readonly useTol: boolean;
  readonly telemetry: WindgramTelemetryStrip;
  readonly reading: WindgramReading;
  readonly unitSystem: UnitSystem;
}

export interface BoundWindgramCallout {
  paint(payload: WindgramCalloutPayload): { readonly width: number; readonly height: number };
}

export interface WindgramCalloutRenderer {
  readonly id: WindgramCalloutVariant;
  readonly stylesheet: string;
  renderSvg(): string;
  bind(svg: ParentNode | null): BoundWindgramCallout;
}

const WINDGRAM_CALLOUT_RENDERERS: Readonly<Record<WindgramCalloutVariant, WindgramCalloutRenderer>> = {
  'tile-2x2': tile2x2Renderer,
  classic: classicRenderer,
};

export function getWindgramCalloutRenderer(variant?: WindgramCalloutVariant): WindgramCalloutRenderer {
  return WINDGRAM_CALLOUT_RENDERERS[variant ?? DEFAULT_WINDGRAM_CALLOUT];
}

export const windgramCalloutStyles = Object.values(WINDGRAM_CALLOUT_RENDERERS)
  .map((renderer) => renderer.stylesheet)
  .join('\n');
