// Element factory and document stylesheet shared by the point panels.

import { adoptDocumentStyleSheet } from './style-registry.ts';
import windgramPanelCss from './styles/windgram-panel.css?inline';

const STYLE_ID = 'av-windgram-document-style';

export function adoptPanelStyles(owner: Document): void {
  adoptDocumentStyleSheet(owner, STYLE_ID, windgramPanelCss);
}

/** Creates an element with an optional class and text. */
export function elementFactory(owner: Document) {
  return <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] => {
    const el = owner.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  };
}
