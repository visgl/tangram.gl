// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {afterEach, describe, expect, test, vi} from 'vitest';

const {createDataSource, getTile, parseSync} = vi.hoisted(() => ({
  createDataSource: vi.fn(),
  getTile: vi.fn(),
  parseSync: vi.fn()
}));

vi.mock('@loaders.gl/pmtiles', () => ({
  PMTilesSourceLoader: {createDataSource}
}));

vi.mock('@loaders.gl/mlt/bundled', () => ({
  MLTLoader: {parseSync}
}));

vi.mock('@loaders.gl/mvt/mvt-geojson-loader', () => ({
  MVTGeoJSONLoaderWithParser: {parseSync}
}));

import {parseMltWithLoaders} from '../modules/tangram-renderer/src/procedures/mlt-loaders';
import {parseMvtWithLoaders} from '../modules/tangram-renderer/src/procedures/mvt-loaders';
import {createPMTilesSource} from '../modules/tangram-renderer/src/procedures/pmtiles-loader';

describe('loaders.gl tile adapters', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  test('normalizes MLT features to Tangram layers and tile coordinates', () => {
    parseSync.mockReturnValue({
      features: [{
        type: 'Feature',
        id: 11,
        geometry: {type: 'Point', coordinates: [0.5, 0.25]},
        properties: {
          __tangram_layer: 'roads',
          metadata: '{"kind":"local"}',
          untouched: 'value'
        }
      }]
    });

    const tileBytes = new Uint8Array([4, 5, 6]);
    const layers = parseMltWithLoaders(tileBytes, {parseJson: ['metadata']});

    expect(parseSync).toHaveBeenCalledWith(expect.any(ArrayBuffer), {
      mlt: {shape: 'geojson-table', coordinates: 'local', layerProperty: '__tangram_layer'}
    });
    expect(layers).toEqual({
      roads: {
        type: 'FeatureCollection',
        features: [{
          type: 'Feature',
          id: 11,
          geometry: {type: 'Point', coordinates: [2048, 1024]},
          properties: {metadata: {kind: 'local'}, untouched: 'value'}
        }]
      }
    });
  });

  test('returns no Tangram layers for an empty MLT tile', () => {
    parseSync.mockReturnValue({features: []});
    expect(parseMltWithLoaders(new ArrayBuffer(0))).toEqual({});
  });

  test('normalizes loaders.gl MVT features and preserves Tangram parse_json behavior', () => {
    parseSync.mockReturnValue({
      features: [{
        type: 'Feature',
        id: 12,
        geometry: {type: 'Point', coordinates: [0.25, 0.5]},
        properties: {
          __tangram_layer: 'places',
          metadata: '{"rank":3}',
          label: 'Town'
        }
      }]
    });

    const layers = parseMvtWithLoaders(new Uint8Array([8, 9]), {parseJson: ['metadata']});

    expect(parseSync).toHaveBeenCalledWith(expect.any(ArrayBuffer), {
      mvt: {coordinates: 'local', layerProperty: '__tangram_layer'}
    });
    expect(layers).toEqual({
      places: {
        type: 'FeatureCollection',
        features: [{
          type: 'Feature',
          id: 12,
          geometry: {type: 'Point', coordinates: [1024, 2048]},
          properties: {metadata: {rank: 3}, label: 'Town'}
        }]
      }
    });
  });

  test('reuses a PMTiles source and requests the supplied tile index', async () => {
    const tileBytes = new Uint8Array([1, 2, 3]).buffer;
    getTile.mockResolvedValue(tileBytes);
    createDataSource.mockReturnValue({getTile, metadata: Promise.resolve({format: 'pmtiles', maxZoom: 14}),
      pmtiles: {getMetadata: async () => ({})}});

    const archiveUrl = 'https://tiles.example.test/basemap.pmtiles';
    const tileIndex = {x: 5, y: 12, z: 8};
    const source = createPMTilesSource(archiveUrl);
    const firstTile = await source.getTile(tileIndex);
    const secondTile = await source.getTile(tileIndex);

    expect(createDataSource).toHaveBeenCalledExactlyOnceWith(archiveUrl, {core: {fetch: expect.any(Function)}});
    expect(getTile).toHaveBeenNthCalledWith(1, {...tileIndex, signal: undefined});
    expect(getTile).toHaveBeenNthCalledWith(2, {...tileIndex, signal: undefined});
    expect(await source.getMetadata?.()).toMatchObject({format: 'pmtiles', maxZoom: 14});
    source.dispose();
    await expect(source.getTile(tileIndex)).rejects.toMatchObject({name: 'AbortError'});
    expect(firstTile).toBe(tileBytes);
    expect(secondTile).toBe(tileBytes);
  });

  test('archive transport keeps headers and disposal cancellation through body completion', async () => {
    createDataSource.mockReturnValue({getTile, metadata: Promise.resolve({format: 'pmtiles',
      attributions: [], tilejson: {htmlAttribution: 'archive credit'}}), pmtiles: {getMetadata: async () => ({attribution: 'raw credit'})}});
    const source = createPMTilesSource('archive.pmtiles', {headers: {Authorization: 'source-token'}});
    const transport: (url: string, options: RequestInit) => Promise<Response> = createDataSource.mock.calls[0][1].core.fetch;
    let signal: AbortSignal | null | undefined;
    let rejectBody: (reason: Error) => void = () => {};
    const body = new Promise<ArrayBuffer>((_resolve, reject) => { rejectBody = reject; });
    vi.stubGlobal('fetch', vi.fn(async (_url: string, options: RequestInit) => {
      signal = options.signal;
      expect(new Headers(options.headers).get('Authorization')).toBe('source-token');
      expect(new Headers(options.headers).get('Range')).toBe('bytes=0-126');
      signal?.addEventListener('abort', () => rejectBody(new Error('body aborted')), {once: true});
      return {arrayBuffer: () => body};
    }));
    try {
      expect(await source.getMetadata?.()).toMatchObject({attributions: ['archive credit', 'raw credit']});
      const pending = transport('archive.pmtiles', {headers: {Range: 'bytes=0-126'}});
      await vi.waitFor(() => expect(signal).toBeDefined());
      source.dispose();
      await expect(pending).rejects.toThrow('body aborted');
      expect(signal?.aborted).toBe(true);
    } finally { source.dispose(); vi.unstubAllGlobals(); }
  });

  test('archive transport forwards per-request abort without retiring the source', async () => {
    createDataSource.mockReturnValue({getTile, metadata: Promise.resolve({format: 'pmtiles'}), pmtiles: {getMetadata: async () => ({})}});
    const source = createPMTilesSource('archive.pmtiles');
    const transport: (url: string, options: RequestInit) => Promise<Response> = createDataSource.mock.calls[0][1].core.fetch;
    const controller = new AbortController();
    let signal: AbortSignal | null | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, options: RequestInit) => {
      signal = options.signal;
      return new Response(new Uint8Array([1]), {status: 206});
    }));
    try {
      controller.abort();
      await transport('archive.pmtiles', {signal: controller.signal});
      expect(signal?.aborted).toBe(true);
      expect(await source.getMetadata?.()).toMatchObject({format: 'pmtiles'});
      source.dispose();
      await expect(source.getMetadata?.()).rejects.toMatchObject({name: 'AbortError'});
    } finally { source.dispose(); vi.unstubAllGlobals(); }
  });

  test('registers both integrations against the active worker global', async () => {
    type WorkerRegistrations = {
      registerMvtDecoder: (name: string, decoder: unknown) => void;
      registerMvtTileProvider: (name: string, provider: unknown) => void;
    };
    const workerScope = {
      registerMvtDecoder: vi.fn(),
      registerMvtTileProvider: vi.fn()
    } satisfies WorkerRegistrations;
    const previousSelf = Object.getOwnPropertyDescriptor(globalThis, 'self');
    Object.defineProperty(globalThis, 'self', {configurable: true, value: workerScope});

    try {
      await import('../modules/tangram-renderer/src/experimental/loaders-gl-worker');
    } finally {
      if (previousSelf) {
        Object.defineProperty(globalThis, 'self', previousSelf);
      } else {
        Reflect.deleteProperty(globalThis, 'self');
      }
    }

    expect(workerScope.registerMvtDecoder).toHaveBeenCalledWith('loaders-mvt', expect.any(Function));
    expect(workerScope.registerMvtDecoder).toHaveBeenCalledWith('loaders-mlt', expect.any(Function));
    expect(workerScope.registerMvtTileProvider).toHaveBeenCalledWith('loaders-pmtiles', {createSource: expect.any(Function)});
  });
});
