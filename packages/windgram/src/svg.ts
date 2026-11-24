import type { WindgramView } from './model.ts';
import { sceneData } from './scene-store.ts';
import type { WindgramSvgOptions } from './scene-types.ts';
import windgramChartCss from './styles/windgram-chart.css?inline';
import { getWindgramCalloutRenderer } from './windgram-callout.ts';
import { renderWindgramSvg as renderSvg } from './windgram-chart.ts';
export { renderWindgramKey } from './windgram-chart.ts';

export function renderWindgramSvg(view: WindgramView, options: WindgramSvgOptions = {}): string {
  const variantCss = getWindgramCalloutRenderer(options.calloutVariant).stylesheet;
  return renderSvg(sceneData(view), { ...options, stylesheet: `${windgramChartCss}\n${variantCss}` });
}
