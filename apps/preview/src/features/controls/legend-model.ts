import { activePalettes, type PinnedBuild, type UnitSystem } from '@av/client';
import { LIFT_RENDER_STYLE, LIFT_STEP_RENDER_STYLE, type LayerId } from '@av/contracts/layers';
import { isLiftLayer, shortLayerName } from '../forecast/forecast-model';
import { themeLiftLegendColors, themeOption, type MapTheme } from '../map/visual-theme';

export interface LegendStop { readonly color: string; readonly label: string }
export interface LegendModel {
  readonly title: string;
  readonly unitLabel: string;
  readonly stops: readonly LegendStop[];
  readonly reference: string;
  readonly noLift: string;
  readonly cutoff: string;
}

export function legendModel(build: PinnedBuild, layer: LayerId, units: UnitSystem, theme: MapTheme = 'stone'): LegendModel | null {
  const palette = activePalettes(build.manifest.descriptors.palettes, layer, build.manifest.descriptors.layers)[0];
  if (!palette) return null;
  const descriptor = build.manifest.descriptors.layers[layer], liftLayer = isLiftLayer(layer);
  const altitudeUnit = units === 'imperial' ? 'ft' : 'm';
  const colors = liftLayer ? themeLiftLegendColors(theme, palette.edges, palette.colors.length) : palette.colors;
  const colorCount = colors.length;
  const stops = colors.map((color, index) => {
    const edge = index === colorCount - 1 && palette.edges.length > colorCount ? palette.edges[colorCount] : palette.edges[index];
    const showTick = edge !== undefined && (index === 0 || index === colorCount - 1 || index === Math.floor(colorCount / 3) || index === Math.floor(colorCount * 2 / 3));
    const value = edge === undefined ? 0 : liftLayer ? Math.round(edge * (units === 'imperial' ? 3.280839895 : 1)) : edge;
    const label = !showTick ? '' : !liftLayer ? (value >= 100 ? String(Math.round(value)) : String(Number(value.toFixed(1)))) : value >= 1000 ? `${Number((value / 1000).toFixed(1))}k` : String(value);
    return { color, label };
  });
  const title = layer === 'usable-lift-agl' ? `Lift above ground (${altitudeUnit} AGL)`
    : layer === 'usable-lift-msl' ? `Top of usable lift (${altitudeUnit} MSL)`
      : `${descriptor.label} (${palette.units})`;
  if (liftLayer) {
    const renderStyle = build.manifest.tool.liftRenderStyle;
    const sink = build.manifest.descriptors.methods[descriptor.methodId]?.parameters.sinkRateMps;
    const opt = themeOption(theme);
    const classicMslGround = theme === 'classic' && layer === 'usable-lift-msl' && (renderStyle === LIFT_STEP_RENDER_STYLE || renderStyle === LIFT_RENDER_STYLE);
    return {
      title,
      unitLabel: `Lift ${altitudeUnit}`,
      stops,
      reference: `${layer === 'usable-lift-agl' ? 'AGL shows usable lift height above ground.' : 'MSL shows top of usable lift above sea level.'} (${opt.shortLabel}: ${opt.summary})`,
      noLift: classicMslGround
        ? 'No usable lift: Classic Soaring MSL colors ground elevation.'
        : 'No usable lift: clear areas over terrain relief.',
      cutoff: Number.isFinite(sink) && sink > 0 ? `Usable lift requires predicted updrafts above ${sink} m/s. Nearby terrain can cross this cutoff.` : 'Usable lift depends on the predicted updraft and terrain.'
    };
  }
  return {
    title,
    unitLabel: `${shortLayerName(layer, descriptor)} ${palette.units}`,
    stops,
    reference: `${descriptor.label} in ${palette.units}.`,
    noLift: descriptor.hideNonPositiveValues ? 'Zero or trace values are clear on the map.' : 'Shaded across all covered cells.',
    cutoff: descriptor.timeSupport.startsWith('interval') ? 'Aggregated over the forecast interval ending at the selected time.' : 'Instantaneous value at the selected valid time.'
  };
}
