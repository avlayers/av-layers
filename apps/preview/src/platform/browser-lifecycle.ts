export interface BrowserLifecycleOptions {
  readonly document: Document;
  readonly window: Window;
  readonly signal: AbortSignal;
  readonly onVisibility: () => void;
  readonly onPageHide: (event: PageTransitionEvent) => void;
  readonly onPageShow: (event: PageTransitionEvent) => void;
}

/** Visibility, focus and BFCache subscriptions for one preview app lifetime. */
export function installBrowserLifecycle(options: BrowserLifecycleOptions): void {
  const { document, window, signal } = options;
  document.addEventListener('visibilitychange', options.onVisibility, { signal });
  window.addEventListener('focus', options.onVisibility, { signal });
  window.addEventListener('pagehide', event => options.onPageHide(event), { signal });
  window.addEventListener('pageshow', event => options.onPageShow(event), { signal });
}
