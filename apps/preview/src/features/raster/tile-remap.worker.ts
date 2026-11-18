import { createBitmapWorkspace, decodeAndRemapBitmap, type RemapKind } from './tile-remap-core';
import type { MapTheme } from '../map/visual-theme';

export interface WorkerRemapRequest {
  readonly id: number;
  readonly data: ArrayBuffer;
  readonly maskData: ArrayBuffer | null;
  readonly kind: RemapKind;
  readonly theme: MapTheme;
}

export type WorkerRemapResponse =
  | { readonly id: number; readonly bitmap: ImageBitmap }
  | { readonly id: number; readonly error: string };

interface WorkerScope {
  onmessage: ((event: MessageEvent<WorkerRemapRequest>) => void) | null;
  postMessage(message: WorkerRemapResponse, transfer?: Transferable[]): void;
}

const scope = self as unknown as WorkerScope;
const workspace = createBitmapWorkspace();

scope.onmessage = event => {
  const { id, data, maskData, kind, theme } = event.data;
  void decodeAndRemapBitmap(workspace, data, kind, theme, maskData)
    .then(bitmap => {
      scope.postMessage({ id, bitmap }, [bitmap]);
    })
    .catch(error => {
      scope.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
    });
};
