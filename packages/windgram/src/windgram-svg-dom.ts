// Minimal attribute and text writers for live SVG nodes.

import { svgNumber as fmt } from './windgram-format.ts';

/** Writes only when the value changes. */
export const setAttr = (el: Element | null, name: string, value: string) => {
  if (el && el.getAttribute(name) !== value) el.setAttribute(name, value);
};

/** Writes only when the text changes. */
export const setText = (el: Element | null, value: string) => {
  if (el && el.textContent !== value) el.textContent = value;
};

/** Writes each numeric attribute rounded for SVG output. */
export function setSvgNumbers(element: Element | null, values: Record<string, number>): void {
  for (const [key, value] of Object.entries(values)) element?.setAttribute(key, String(fmt(value)));
}
