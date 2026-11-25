// SVG/HTML string helpers shared by the chart and its key.

import { svgNumber as fmt } from './windgram-format.ts';

export const SVG_NS = 'http://www.w3.org/2000/svg';
export const escapeMarkup = (value: string) =>
  value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);
export const svgText = (x: number, y: number, value: string, attrs = '') =>
  `<text x="${fmt(x)}" y="${fmt(y)}" ${attrs}>${escapeMarkup(value)}</text>`;
