import type { WindgramView } from './model.ts';
import { sceneData } from './scene-store.ts';
import { chartStyles } from './chart-styles.ts';
import type { WindgramCalloutVariant } from './windgram-callout.ts';
import {
  mountWindgram as mount,
  type WindgramCalloutTrigger,
  type WindgramInspectionMode,
  type WindgramMountOptions,
} from './windgram-dom.ts';

export type WindgramMount = ReturnType<typeof mountWindgram>;
export type { WindgramCalloutTrigger, WindgramCalloutVariant, WindgramInspectionMode, WindgramMountOptions };

/** Mount a chart and install its stylesheet in the host document. */
export function mountWindgram(host: HTMLElement, options: WindgramMountOptions & { view: WindgramView }) {
  const owner = host.ownerDocument ?? (typeof document !== 'undefined' ? document : undefined);
  const styleId = 'av-windgram-chart-style';
  if (owner?.head && !owner.getElementById?.(styleId)) {
    const style = owner.createElement('style');
    style.id = styleId;
    style.textContent = chartStyles;
    owner.head.append(style);
  }
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
