import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';

export const RASTER_WORKER_RESOURCE_LIMITS = Object.freeze({
  maxOldGenerationSizeMb: 64,
  maxYoungGenerationSizeMb: 16,
  stackSizeMb: 4
} as const);

const BOOTSTRAP = 'import("node:worker_threads").then(async ({workerData}) => { const {tsImport} = await import(workerData.loader); await tsImport(workerData.entry, workerData.entry); })';
const LOADER = pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm/api')).href;

/**
 * Starts a TypeScript worker through tsx under the raster worker memory limits.
 * `onFailure` receives worker errors and any exit while `closing()` is false.
 */
export function startTsWorker(entry: URL, data: object, name: string, onFailure: (error: unknown) => void, closing: () => boolean): Worker {
  const worker = new Worker(BOOTSTRAP, { eval: true, resourceLimits: { ...RASTER_WORKER_RESOURCE_LIMITS }, workerData: { ...data, loader: LOADER, entry: entry.href } });
  worker.on('error', onFailure);
  worker.on('exit', code => { if (!closing()) onFailure(new Error(`${name} worker unexpectedly exited ${code}`)); });
  return worker;
}
