import type { WindgramView } from './model.ts';
import { sceneData } from './scene-store.ts';
import { adoptDocumentStyleSheet } from './style-registry.ts';
import windgramChartCss from './styles/windgram-chart.css?inline';
import { windgramCalloutStyles, type WindgramCalloutVariant } from './windgram-callout.ts';
import {
  mountWindgram as mount,
  type WindgramCalloutTrigger,
  type WindgramMountOptions,
} from './windgram-dom.ts';

export type WindgramMount = ReturnType<typeof mountWindgram>;
export type { WindgramCalloutTrigger, WindgramCalloutVariant,   };

const CHART_DOCUMENT_CSS = `${windgramChartCss}\n${windgramCalloutStyles}`;

/** Mount a chart and install its stylesheet in the host document. */
export function mountWindgram(host: HTMLElement, options: WindgramMountOptions & { view: WindgramView }) {
  const owner = host.ownerDocument ?? (typeof document !== 'undefined' ? document : undefined);
  adoptDocumentStyleSheet(owner, 'av-windgram-chart-style', CHART_DOCUMENT_CSS);
  const chart = mount(host, { ...options, view: sceneData(options.view) });
  return {
    update: (view: WindgramView) => chart.update(sceneData(view)),
    select: chart.select,
    snapToTol: chart.snapToTol,
    setMode: chart.setMode,
    setCalloutVariant: chart.setCalloutVariant,
    dispose: chart.dispose,
  };
}
