// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {beforeAll, beforeEach, describe, expect, test, vi} from 'vitest';
import {_CustomProjectionViewport as CustomProjectionViewport} from '@deck.gl/core';
import {projectionEngine} from '@math.gl/geospatial/projection';
import {getProjectedTileIndices} from '../src/projected-tile-selection';
import {basemapTilesetAdapter, ProjectedTileset2D} from '../src/projected-tileset';

vi.mock('../src/projected-tile-selection', async importOriginal => {
  const original = await importOriginal<typeof import('../src/projected-tile-selection')>();
  return {...original, getProjectedTileIndices: vi.fn(original.getProjectedTileIndices)};
});

type CRS = ConstructorParameters<typeof CustomProjectionViewport>[0]['crs'];

let viewport: CustomProjectionViewport;

beforeAll(async () => {
  const utm: CRS = await projectionEngine.getCRS('EPSG:32632');
  viewport = new CustomProjectionViewport({crs: utm, center: [10.5, 48, 0], zoom: 13, width: 800, height: 600});
});

beforeEach(() => {
  vi.mocked(getProjectedTileIndices).mockClear();
});

/** The `minZoom` of each call to `getProjectedTileIndices` since the last clear. */
const getReceivedMinZooms = () => vi.mocked(getProjectedTileIndices).mock.calls.map(([, options]) => options.minZoom);

describe('the source minZoom reaches the projected tile selection', () => {
  test('ProjectedTileset2D passes its minZoom to getProjectedTileIndices', () => {
    const tileset = new ProjectedTileset2D({getTileData: () => null, tileSize: 512, minZoom: 3, maxZoom: 14});
    tileset.update(viewport);
    expect(getReceivedMinZooms()).toEqual([3]);
    tileset.finalize();
  });

  test('the basemap tileset adapter passes its minZoom to getProjectedTileIndices', () => {
    basemapTilesetAdapter.getTileIndices({tileSize: 512, minZoom: 3, maxZoom: 14, extent: null, viewState: viewport});
    expect(getReceivedMinZooms()).toEqual([3]);
  });
});
