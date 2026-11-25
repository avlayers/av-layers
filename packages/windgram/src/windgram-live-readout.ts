// Accessible host labelling and the polite live readout written beside a mounted chart.

/** Labels the host and readout for assistive tech; the returned function restores their original attributes. */
export function bindAccessibleHost(host: HTMLElement, readout: HTMLElement | null, interactionLabel: string): () => void {
  const originalAttributes = new Map(['tabindex', 'role', 'aria-label', 'aria-describedby'].map((key) => [key, host.getAttribute?.(key) ?? null]));
  const readoutAttributes = new Map(['role', 'aria-live', 'aria-atomic'].map((key) => [key, readout?.getAttribute?.(key) ?? null]));
  host.tabIndex = 0;
  host.setAttribute?.('role', 'group');
  host.setAttribute?.('aria-label', interactionLabel);
  if (readout?.id) host.setAttribute?.('aria-describedby', readout.id);
  readout?.setAttribute?.('role', 'status');
  readout?.setAttribute?.('aria-live', 'polite');
  readout?.setAttribute?.('aria-atomic', 'true');
  return () => {
    for (const [name, value] of originalAttributes) {
      if (value === null) host.removeAttribute?.(name);
      else host.setAttribute?.(name, value);
    }
    for (const [name, value] of readoutAttributes) {
      if (value === null) readout?.removeAttribute?.(name);
      else readout?.setAttribute?.(name, value);
    }
  };
}

/** Writes readout text immediately or coalesced over 60 ms; falls back to the host label without a readout element. */
export function createLiveReadout(
  host: HTMLElement,
  readout: HTMLElement | null,
  ownerDocument: Document | undefined,
  interactionLabel: string,
  instructions: string,
) {
  let pendingReadout: { text: string; title?: string } | null = null;
  let readoutFlushTimer: ReturnType<typeof setTimeout> | null = null;
  let lastText = readout?.textContent ?? '';
  let disposed = false;

  const writeReadout = (text: string, title?: string) => {
    if (text === lastText) return;
    if (readout && title && ownerDocument && typeof ownerDocument.createTextNode === 'function') {
      const strong = ownerDocument.createElement('strong');
      strong.textContent = title;
      readout.replaceChildren(strong, ownerDocument.createTextNode(text.slice(title.length)));
    } else if (readout) {
      readout.textContent = text;
    } else {
      host.setAttribute?.('aria-label', text === instructions ? interactionLabel : `${interactionLabel} ${text}`);
    }
    lastText = text;
  };

  const cancelPendingReadout = () => {
    pendingReadout = null;
    if (readoutFlushTimer !== null) {
      clearTimeout(readoutFlushTimer);
      readoutFlushTimer = null;
    }
  };

  const flushPendingReadout = () => {
    if (readoutFlushTimer !== null) {
      clearTimeout(readoutFlushTimer);
      readoutFlushTimer = null;
    }
    if (pendingReadout && !disposed) {
      const { text, title } = pendingReadout;
      pendingReadout = null;
      writeReadout(text, title);
    }
  };

  const publishReadout = (text: string, title: string | undefined, defer: boolean) => {
    if (!defer) {
      cancelPendingReadout();
      writeReadout(text, title);
      return;
    }
    pendingReadout = { text, title };
    readoutFlushTimer ??= setTimeout(flushPendingReadout, 60);
  };

  return {
    write: writeReadout,
    publish: publishReadout,
    cancel: cancelPendingReadout,
    flush: flushPendingReadout,
    dispose() {
      disposed = true;
      cancelPendingReadout();
    },
  };
}
