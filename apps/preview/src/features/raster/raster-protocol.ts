import { addProtocol } from 'maplibre-gl';
import type { RasterTileSourceProtocol } from '@av/client';
import { isMapTheme, type MapTheme } from '../../themes/registry';
import { layerInUrl, remapFor } from '../../layers/registry';
import { remapTileToBitmap, shouldRemapTile } from './tile-remap';

/**
 * Registers `protocol.scheme` with MapLibre. A tile URL's `#theme` suffix (else `theme()`) picks the
 * palette; a layer's remap ramp and mask layer come from the layer registry.
 */
export function registerRasterProtocol(protocol: () => RasterTileSourceProtocol | null, scheme: string, theme: () => MapTheme): void {
  addProtocol(scheme, async (params, controller) => {
    const hashIdx = params.url.indexOf('#');
    const cleanUrl = hashIdx >= 0 ? params.url.slice(0, hashIdx) : params.url;
    const hashTheme = hashIdx >= 0 ? params.url.slice(hashIdx + 1) : '';
    const slotTheme: MapTheme = isMapTheme(hashTheme) ? hashTheme : theme();
    const response = await protocol()!.load({ ...params, url: cleanUrl }, controller);
    if (!shouldRemapTile(slotTheme, response.data)) return response;
    const httpIdx = cleanUrl.indexOf('http');
    const rawUrl = httpIdx >= 0 ? cleanUrl.slice(httpIdx) : cleanUrl;
    const layer = layerInUrl(rawUrl), remap = layer ? remapFor(layer) : { ramp: 'lift' as const, mask: null };
    let maskData: ArrayBuffer | null = null;
    if (layer && remap.mask) {
      const maskUrl = rawUrl.replace(`/${layer}/`, `/${remap.mask}/`);
      const maskRes = await protocol()!.requestTile(maskUrl, { priority: 'foreground', signal: controller.signal }).response.catch(() => null);
      if (maskRes) { maskData = maskRes.data; maskRes.release(); }
    }
    const bitmap = await remapTileToBitmap(
      response.data,
      remap.ramp,
      slotTheme,
      maskData,
      { priority: 'foreground', signal: controller.signal, transferInput: true }
    );
    return { ...response, data: bitmap };
  });
}
