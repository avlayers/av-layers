import { previewQuery, previewUrl } from './url-state';

export type PreviewUrlState = Parameters<typeof previewUrl>[1];

export interface HistoryHost {
  pathname(): string;
  search(): string;
  push(url: string): void;
  replace(url: string): void;
}

export interface HistoryController {
  read(search: string): ReturnType<typeof previewQuery>;
  write(state: PreviewUrlState, mode: 'push' | 'replace', allowed: boolean): void;
  beginRestore(): number;
  endRestore(generation: number): void;
  cancelRestore(): void;
  restoring(): boolean;
  revision(): number;
}

/** URL projection, history mode and restoration suppression for the preview. */
export function createHistoryController(host: HistoryHost, offline: boolean): HistoryController {
  let revision = 0, active: number | null = null;
  return {
    read(search) { return previewQuery(search, offline); },
    write(state, mode, allowed) {
      if (!allowed || active !== null) return;
      const next = previewUrl(host.pathname(), state);
      if (next === `${host.pathname()}${host.search()}`) return;
      (mode === 'push' ? host.push : host.replace)(next);
    },
    beginRestore() { active = ++revision; return active; },
    endRestore(generation) { if (active === generation) active = null; },
    cancelRestore() { active = null; },
    restoring() { return active !== null; },
    revision() { return revision; }
  };
}
