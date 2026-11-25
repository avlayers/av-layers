// Classic 4-row text callout ('classic'), kept registered so callers can switch or A/B compare with one option change.

import classicStylesheet from './styles/windgram-callout-classic.css?inline';
import type { BoundWindgramCallout, WindgramCalloutRenderer } from './windgram-callout.ts';
import { setAttr, setText } from './windgram-svg-dom.ts';

export const classicRenderer: WindgramCalloutRenderer = {
  id: 'classic',
  stylesheet: classicStylesheet,
  renderSvg(): string {
    return (
      '<rect data-cursor-back="" height="58" rx="7" class="wg-inspector-back"/>' +
      '<text x="10" y="13.5" data-cursor-badge="" class="wg-inspector-badge"/>' +
      '<text x="10" y="27.5" data-cursor-agl="" data-cursor-agl-classic="" class="wg-inspector-agl"/>' +
      '<text x="92" y="27.5" data-cursor-msl="" class="wg-inspector-msl"/>' +
      '<text x="10" y="41" data-cursor-meteo="" class="wg-inspector-meteo"/>' +
      '<text x="10" y="53" data-cursor-soar="" class="wg-inspector-soar"/>'
    );
  },
  bind(svg: ParentNode | null): BoundWindgramCallout {
    const q = <T extends Element>(sel: string) => svg?.querySelector<T>(sel) ?? null;
    const back = q<SVGRectElement>('[data-cursor-back]');
    const badge = q<SVGTextElement>('[data-cursor-badge]');
    const agl = q<SVGTextElement>('[data-cursor-agl]');
    const msl = q<SVGTextElement>('[data-cursor-msl]');
    const meteo = q<SVGTextElement>('[data-cursor-meteo]');
    const soar = q<SVGTextElement>('[data-cursor-soar]');
    const rich = Boolean(badge || meteo || soar);
    return {
      paint({ aglText, mslText, useTol, telemetry }) {
        setText(agl, aglText);
        setText(msl, mslText);
        if (rich && msl) {
          const mslX = aglText ? Math.round(10 + aglText.length * 6.9 + 8) : 10;
          setAttr(msl, 'x', String(mslX));
        }
        setText(badge, telemetry.calloutBadge);
        setAttr(badge, 'class', useTol ? 'wg-inspector-badge' : 'wg-inspector-badge is-free');
        setText(meteo, telemetry.calloutMeteo);
        setText(soar, telemetry.calloutSoar);
        setAttr(soar, 'class', telemetry.hasPositiveClimb ? 'wg-inspector-soar' : 'wg-inspector-soar is-muted');
        const height = rich ? (telemetry.calloutSoar ? 58 : telemetry.calloutMeteo ? 46 : 34) : 47;
        const row2Width = rich
          ? (aglText ? aglText.length * 6.9 + 8 + mslText.length * 5.8 : mslText.length * 6.2)
          : Math.max(aglText.length * 8.2, mslText.length * 5.8);
        const width = Math.ceil(Math.max(
          row2Width,
          rich ? telemetry.calloutBadge.length * 5.8 : 0,
          rich ? telemetry.calloutMeteo.length * 5.8 : 0,
          rich ? telemetry.calloutSoar.length * 5.8 : 0,
        )) + 20;
        if (rich) setAttr(back, 'height', String(height));
        setAttr(back, 'width', String(width));
        return { width, height };
      },
    };
  },
};
