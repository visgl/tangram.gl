// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import type {RangeResponse, Source} from 'pmtiles';
import {Compression, PMTiles, TileType} from 'pmtiles';
import type {BasemapLoadOptions, BasemapSource} from './style-resolver';

/** The URL prefix of a PMTiles archive, as in the `pmtiles` protocol of MapLibre GL JS. */
export const PMTILES_PROTOCOL = 'pmtiles://';

/** The tile type that each source type draws, by PMTiles tile type. */
const TILE_TYPES: Record<number, {sourceTypes: string[]; mimeType: string; name: string}> = {
  [TileType.Mvt]: {
    sourceTypes: ['vector'],
    mimeType: 'application/vnd.mapbox-vector-tile',
    name: 'MVT'
  },
  [TileType.Png]: {sourceTypes: ['raster', 'raster-dem'], mimeType: 'image/png', name: 'PNG'},
  [TileType.Jpeg]: {sourceTypes: ['raster', 'raster-dem'], mimeType: 'image/jpeg', name: 'JPEG'},
  [TileType.Webp]: {sourceTypes: ['raster', 'raster-dem'], mimeType: 'image/webp', name: 'WebP'},
  [TileType.Avif]: {sourceTypes: ['raster', 'raster-dem'], mimeType: 'image/avif', name: 'AVIF'}
};

/** Tile and directory compressions that the archive reader decompresses. */
const SUPPORTED_COMPRESSIONS = new Set([Compression.None, Compression.Gzip]);

/** The archive URL and tile index of a tile URL expanded from a PMTiles tile template. */
const TILE_URL = /^pmtiles:\/\/(.+)\/(\d+)\/(\d+)\/(\d+)$/;

/** Whether `url` names a PMTiles archive (`pmtiles://<archive URL>`). */
export function isPMTilesUrl(url: unknown): url is string {
  return typeof url === 'string' && url.startsWith(PMTILES_PROTOCOL);
}

/** The tile template of an archive: `pmtiles://<archive URL>/{z}/{x}/{y}`. */
export function getPMTilesTileTemplate(archiveUrl: string): string {
  return `${PMTILES_PROTOCOL}${archiveUrl}/{z}/{x}/{y}`;
}

/** The archive URL and tile index of a tile URL, or null for another URL. */
export function parsePMTilesTileUrl(
  url: string
): {archiveUrl: string; z: number; x: number; y: number} | null {
  const match = TILE_URL.exec(url);
  return match
    ? {archiveUrl: match[1], z: Number(match[2]), x: Number(match[3]), y: Number(match[4])}
    : null;
}

/**
 * Reads byte ranges of an archive with HTTP range requests, through the `fetch` and `fetchOptions`
 * of the load options.
 */
class FetchRangeSource implements Source {
  constructor(
    private readonly url: string,
    private readonly loadOptions: BasemapLoadOptions | undefined
  ) {}

  getKey(): string {
    return this.url;
  }

  async getBytes(offset: number, length: number, signal?: AbortSignal): Promise<RangeResponse> {
    let response = await this.fetchRange(offset, offset + length - 1, signal);
    // An archive shorter than the first read, which is 16 KiB: some servers refuse the range.
    if (offset === 0 && response.status === 416) {
      const size = Number(response.headers.get('Content-Range')?.match(/^bytes \*\/(\d+)$/)?.[1]);
      if (!size) {
        throw new Error(`PMTiles archive ${this.url}: no size in the 416 response`);
      }
      response = await this.fetchRange(0, size - 1, signal);
    }
    if (!response.ok) {
      throw new Error(`Failed to load PMTiles archive: ${this.url} (${response.status})`);
    }
    const data = await response.arrayBuffer();
    if (data.byteLength > length) {
      throw new Error(
        `PMTiles archive ${this.url}: the server returned more bytes than requested. It must ` +
          'support HTTP range requests.'
      );
    }
    return {data};
  }

  private fetchRange(first: number, last: number, signal?: AbortSignal): Promise<Response> {
    const fetchOptions = this.loadOptions?.fetchOptions;
    const headers = new Headers(fetchOptions?.headers);
    headers.set('Range', `bytes=${first}-${last}`);
    const fetchFn = this.loadOptions?.fetch || fetch;
    return fetchFn(this.url, {...fetchOptions, headers, ...(signal ? {signal} : {})});
  }
}

/** Load options without a `fetch` or `fetchOptions` of their own share this key. */
const DEFAULT_KEY = {};

/** Opened archives, by `fetch`, by `fetchOptions` and by archive URL. */
const archives = new WeakMap<object, WeakMap<object, Map<string, PMTiles>>>();

/**
 * The reader of an archive, opened once per archive URL, `fetch` and `fetchOptions`: it keeps the
 * header and directories it has read.
 */
function getArchive(url: string, loadOptions: BasemapLoadOptions | undefined): PMTiles {
  const fetchKey = loadOptions?.fetch || DEFAULT_KEY;
  const fetchOptionsKey = loadOptions?.fetchOptions || DEFAULT_KEY;
  let byFetchOptions = archives.get(fetchKey);
  if (!byFetchOptions) {
    byFetchOptions = new WeakMap();
    archives.set(fetchKey, byFetchOptions);
  }
  let byUrl = byFetchOptions.get(fetchOptionsKey);
  if (!byUrl) {
    byUrl = new Map();
    byFetchOptions.set(fetchOptionsKey, byUrl);
  }
  let archive = byUrl.get(url);
  if (!archive) {
    archive = new PMTiles(new FetchRangeSource(url, loadOptions));
    byUrl.set(url, archive);
  }
  return archive;
}

/**
 * The source fields of an archive, read from its header, as MapLibre GL JS's `pmtiles` protocol
 * makes them: a tile template, `minzoom`, `maxzoom` and `bounds`. Throws if the archive cannot be
 * read, or if its tiles are not of a type that a `sourceType` source draws, or are compressed with
 * a method other than gzip.
 */
export async function getPMTilesSourceFields(
  archiveUrl: string,
  sourceType: string,
  loadOptions?: BasemapLoadOptions
): Promise<Partial<BasemapSource>> {
  const header = await getArchive(archiveUrl, loadOptions).getHeader();
  const tileType = TILE_TYPES[header.tileType];
  if (!tileType?.sourceTypes.includes(sourceType)) {
    throw new Error(
      `PMTiles archive ${archiveUrl} holds ${tileType?.name ?? 'unknown'} tiles, which a ` +
        `${sourceType} source cannot draw`
    );
  }
  for (const compression of [header.tileCompression, header.internalCompression]) {
    if (!SUPPORTED_COMPRESSIONS.has(compression)) {
      throw new Error(
        `PMTiles archive ${archiveUrl}: compression ${Compression[compression]} is not supported`
      );
    }
  }
  return {
    tiles: [getPMTilesTileTemplate(archiveUrl)],
    minzoom: header.minZoom,
    maxzoom: header.maxZoom,
    bounds: [header.minLon, header.minLat, header.maxLon, header.maxLat]
  };
}

/**
 * A `fetch` that answers the URLs of PMTiles tile templates with the tile, read from its archive
 * with range requests through the `fetch` and `fetchOptions` of `loadOptions`, and passes every
 * other URL to that `fetch`. A tile the archive does not hold is an empty response (status 204).
 */
export function createPMTilesFetch(loadOptions: BasemapLoadOptions | undefined): typeof fetch {
  return async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const tile = parsePMTilesTileUrl(url);
    if (!tile) {
      return (loadOptions?.fetch || fetch)(input, init);
    }
    const archive = getArchive(tile.archiveUrl, loadOptions);
    const header = await archive.getHeader();
    const response = await archive.getZxy(tile.z, tile.x, tile.y, init?.signal ?? undefined);
    if (!response) {
      return new Response(null, {status: 204});
    }
    const mimeType = TILE_TYPES[header.tileType]?.mimeType || 'application/octet-stream';
    return new Response(response.data, {headers: {'Content-Type': mimeType}});
  };
}

/** Load options with the PMTiles `fetch`, by the load options they extend. */
const pmtilesLoadOptions = new WeakMap<object, NonNullable<BasemapLoadOptions>>();

/**
 * The load options that a source's tiles load with: for a source whose tiles are in a PMTiles
 * archive, `loadOptions` with a `fetch` that reads them (see `createPMTilesFetch`), the same object
 * for the same `loadOptions`; for every other source, `loadOptions` as they are.
 */
export function getTileLoadOptions<LoadOptionsT extends BasemapLoadOptions | undefined>(
  source: BasemapSource,
  loadOptions: LoadOptionsT
): LoadOptionsT {
  if (!source.tiles?.some(isPMTilesUrl)) {
    return loadOptions;
  }
  const key = loadOptions || DEFAULT_KEY;
  let options = pmtilesLoadOptions.get(key);
  if (!options) {
    options = {...loadOptions, fetch: createPMTilesFetch(loadOptions)};
    pmtilesLoadOptions.set(key, options);
  }
  return options as LoadOptionsT;
}
