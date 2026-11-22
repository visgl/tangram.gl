// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {Deck, MapView} from '@deck.gl/core';
import {webgl2Adapter} from '@luma.gl/core/webgl';
import {afterEach, describe, expect, test, vi} from 'vitest';
import {BasemapLayer, type BasemapLayerProps} from '../src/basemap-layer';
import {BasemapLoadError} from '../src/basemap-error';
import {DemPixelReadError} from '../src/dem-pixels';
import {DemTileLayer} from '../src/hillshade-layer';
import {
  KNOWN_TILE_SIZE,
  encodePng,
  fetchBlob,
  getKnownTileBytes,
  installCanvasNoise
} from './dem-pixel-fixtures';

// A browser that adds noise to canvas reads and has no VideoFrame, as Firefox with
// `privacy.resistFingerprinting`: DEM tiles fail through `onError`, and no wrong elevations are
// drawn by the hillshade or color-relief layers. The read method is chosen once per page.

const SIZE = 64;

let deck: Deck<MapView> | null = null;
let parent: HTMLDivElement | null = null;

afterEach(() => {
  deck?.finalize();
  deck = null;
  parent?.remove();
  parent = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** The view state of a DEM tile layer that this test reads: the tiles selected per viewport. */
type DemLayerState = {
  tilesetViews: Map<string, {selectedTiles?: {content: unknown}[] | null}>;
};

/** The hillshade and color-relief tile layers of the deck. */
function getDemLayers(): {state: DemLayerState}[] {
  const layerManager = (deck as unknown as {layerManager: {getLayers(): unknown[]}}).layerManager;
  return layerManager
    .getLayers()
    .filter(layer => layer instanceof DemTileLayer) as unknown as {state: DemLayerState}[];
}

describe('DEM tiles without exact pixel reads', () => {
  test('fail through onError, and are not drawn', async () => {
    installCanvasNoise();
    vi.stubGlobal('VideoFrame', undefined);
    const blob = await encodePng(getKnownTileBytes(), KNOWN_TILE_SIZE);
    const errors: Error[] = [];
    const style = {
      version: 8,
      sources: {
        terrain: {
          type: 'raster-dem',
          tiles: ['known://terrain/{z}/{x}/{y}.png'],
          encoding: 'terrarium',
          tileSize: KNOWN_TILE_SIZE,
          maxzoom: 0
        }
      },
      layers: [
        {id: 'relief', type: 'color-relief', source: 'terrain'},
        {id: 'shade', type: 'hillshade', source: 'terrain'}
      ]
    };

    parent = document.createElement('div');
    document.body.append(parent);
    deck = new Deck({
      parent,
      width: SIZE,
      height: SIZE,
      useDevicePixels: false,
      deviceProps: {adapters: [webgl2Adapter]},
      views: new MapView({id: 'view'}),
      viewState: {longitude: 0, latitude: 0, zoom: 0},
      layers: [
        new BasemapLayer({
          id: 'basemap',
          mode: 'map',
          style: style as BasemapLayerProps['style'],
          loadOptions: {fetch: fetchBlob(blob)},
          onError: (error: Error) => {
            errors.push(error);
            return true;
          }
        })
      ]
    });

    await vi.waitFor(() => expect(errors.length).toBeGreaterThan(0), {timeout: 30_000});
    const error = errors[0] as BasemapLoadError;
    expect(error).toBeInstanceOf(BasemapLoadError);
    expect(error.kind).toBe('tile');
    expect(error.sourceId).toBe('terrain');
    expect(error.cause).toBeInstanceOf(DemPixelReadError);
    expect(error.message).toMatch(/cannot be decoded exactly/);
    // Neither layer has a decoded tile to draw.
    const demLayers = getDemLayers();
    expect(demLayers.length).toBeGreaterThan(0);
    for (const layer of demLayers) {
      const tiles = [...layer.state.tilesetViews.values()].flatMap(
        view => view.selectedTiles || []
      );
      expect(tiles.length).toBeGreaterThan(0);
      expect(tiles.every(tile => !tile.content)).toBe(true);
    }
  });
});
