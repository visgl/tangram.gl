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

import {parseMltWithLoaders} from '../modules/tangram-renderer/src/procedures/mlt-loaders';
import {getPMTilesTile} from '../modules/tangram-renderer/src/procedures/pmtiles-loader';

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

  test('reuses a PMTiles source and requests the supplied tile index', async () => {
    const tileBytes = new Uint8Array([1, 2, 3]).buffer;
    getTile.mockResolvedValue(tileBytes);
    createDataSource.mockReturnValue({getTile});

    const archiveUrl = 'https://tiles.example.test/basemap.pmtiles';
    const tileIndex = {x: 5, y: 12, z: 8};
    const firstTile = await getPMTilesTile(archiveUrl, tileIndex);
    const secondTile = await getPMTilesTile(archiveUrl, tileIndex);

    expect(createDataSource).toHaveBeenCalledExactlyOnceWith(archiveUrl, {
      pmtiles: {shape: 'geojson-table'}
    });
    expect(getTile).toHaveBeenNthCalledWith(1, tileIndex);
    expect(getTile).toHaveBeenNthCalledWith(2, tileIndex);
    expect(firstTile).toBe(tileBytes);
    expect(secondTile).toBe(tileBytes);
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

    expect(workerScope.registerMvtDecoder).toHaveBeenCalledWith('loaders-mlt', expect.any(Function));
    expect(workerScope.registerMvtTileProvider).toHaveBeenCalledWith('loaders-pmtiles', expect.any(Function));
  });
});
