import { addProtocol } from 'maplibre-gl';
import type { RasterTileSourceProtocol } from '@av/client';
import { isMapTheme, type MapTheme } from '../../themes/registry';
import { remapTileToBitmap, shouldRemapTile } from './tile-remap';

/**
 * Registers `protocol.scheme` with MapLibre. A tile URL's `#theme` suffix (else `theme()`) picks the
 * palette; remapped lift tiles of `usable-lift-msl` take their mask from the matching AGL tile.
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
    let maskData: ArrayBuffer | null = null;
    if (rawUrl.includes('/usable-lift-msl/')) {
      const aglUrl = rawUrl.replace('/usable-lift-msl/', '/usable-lift-agl/');
      const maskRes = await protocol()!.requestTile(aglUrl, { priority: 'foreground', signal: controller.signal }).response.catch(() => null);
      if (maskRes) { maskData = maskRes.data; maskRes.release(); }
    }
    const bitmap = await remapTileToBitmap(
      response.data,
      rawUrl.includes('/precip-rate/') ? 'rain' : 'lift',
      slotTheme,
      maskData,
      { priority: 'foreground', signal: controller.signal, transferInput: true }
    );
    return { ...response, data: bitmap };
  });
}
