import { browserTimeZone, buildDiagnosticRows, formatPlaceTime, formatViewerTime, longitudeOffsetHours, type PinnedBuild } from '@av/client';

/** Build diagnostics are rendered on first open, outside the startup chunk. */
export function renderBuildDetails(container: HTMLElement, build: PinnedBuild, longitude: number | undefined): void {
  const format = (label: string, value: string): string => {
    if (label === 'Cycle' || label === 'Expires') {
      const ms = Date.parse(value);
      return Number.isFinite(ms) ? formatViewerTime(ms, browserTimeZone()) : value;
    }
    if (label === 'Horizon') {
      const [start, end] = value.split(' → ');
      const a = Date.parse(start ?? ''), b = Date.parse(end ?? '');
      if (!Number.isFinite(a) || !Number.isFinite(b) || longitude === undefined || !Number.isFinite(longitude)) return value;
      const offset = longitudeOffsetHours(longitude) * 60;
      return `${formatPlaceTime(a, offset, 'stamp')} → ${formatPlaceTime(b, offset, 'stamp')}`;
    }
    return value;
  };
  container.replaceChildren(...buildDiagnosticRows(build).flatMap(([label, raw]) => {
    const value = format(label, raw), detail = document.createElement('dd');
    if (label === 'Source data' && /^https?:\/\//i.test(value)) {
      const link = document.createElement('a');
      link.textContent = 'View source receipts';
      link.href = value; link.target = '_blank'; link.rel = 'noopener noreferrer';
      detail.append(link);
    } else detail.textContent = value;
    const term = document.createElement('dt');
    term.textContent = label;
    return [term, detail];
  }));
}
