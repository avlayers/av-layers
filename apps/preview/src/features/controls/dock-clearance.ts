/**
 * Publishes `--dock-clearance` on `app`: the pixels from the dock's top edge to the bottom of the app, safe
 * area included. The point card and map attribution keep clear of it in CSS; `point-camera.ts` measures the
 * dock itself. Stops when `signal` aborts.
 */
export function publishDockClearance(app: HTMLElement, signal: AbortSignal): void {
  const dock = app.querySelector<HTMLElement>('#map-controls');
  if (!dock || typeof ResizeObserver !== 'function') return;
  let published = -1;
  const publish = () => {
    const clearance = Math.max(0, Math.ceil(app.getBoundingClientRect().bottom - dock.getBoundingClientRect().top));
    // Writing the property restyles the whole app, so only a changed value is written.
    if (clearance === published) return;
    published = clearance;
    app.style.setProperty('--dock-clearance', `${clearance}px`);
  };
  const observer = new ResizeObserver(publish);
  observer.observe(dock);
  observer.observe(app);
  publish();
  signal.addEventListener('abort', () => { observer.disconnect(); app.style.removeProperty('--dock-clearance'); }, { once: true });
}
