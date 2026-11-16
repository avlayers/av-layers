export interface BrowserCacheStore {
  match(url: string): Promise<Response | undefined>;
  put(url: string, response: Response): Promise<void>;
  delete(request: string | { url: string }): Promise<boolean>;
  keys(): Promise<ReadonlyArray<{ url: string }>>;
}

export function browserCaches(): { open(name: string): Promise<BrowserCacheStore> } | undefined {
  const caches = (globalThis as unknown as { caches?: { open?: (name: string) => Promise<BrowserCacheStore> } }).caches;
  const open = caches?.open;
  if (typeof open !== 'function') return;
  return { open: name => open.call(caches, name) };
}
