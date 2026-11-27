// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {Deck, MapView} from '@deck.gl/core';
import {webgl2Adapter} from '@luma.gl/core/webgl';
import {afterEach, describe, expect, test} from 'vitest';
import {BasemapLayer} from '../src/basemap-layer';
import {createStableFrameWait} from './stable-frame';

// Color-relief ramps over DEM tiles of one flat elevation, served from the page.

const SIZE = 64;
const TILE_URL = 'https://dem.test/';
const realFetch = globalThis.fetch;

let deck: Deck<any> | null = null;
let parent: HTMLDivElement | null = null;
// Every tile layer has selected its tiles.
const stableFrames = createStableFrameWait({
  getDeck: () => deck,
  width: SIZE,
  isReady: current => {
    const layers = (current as any).layerManager.getLayers();
    const tileLayers = layers.filter((layer: any) => layer.state?.tileset);
    return (
      tileLayers.length > 0 &&
      tileLayers.every((layer: any) => layer.state.tileset.selectedTiles)
    );
  }
});

afterEach(() => {
  deck?.finalize();
  deck = null;
  stableFrames.cancel();
  parent?.remove();
  parent = null;
  globalThis.fetch = realFetch;
});

/** Serves every DEM tile as one RGB pixel color. */
function serveFlatTiles([r, g, b]: number[]) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(TILE_URL)) {
      return realFetch(input, init);
    }
    const tile = new OffscreenCanvas(256, 256);
    const context = tile.getContext('2d')!;
    const pixels = context.createImageData(256, 256);
    for (let offset = 0; offset < pixels.data.length; offset += 4) {
      pixels.data.set([r, g, b, 255], offset);
    }
    context.putImageData(pixels, 0, 0);
    return new Response(await tile.convertToBlob({type: 'image/png'}), {
      headers: {'content-type': 'image/png'}
    });
  }) as typeof fetch;
}

/** The color at the center of a color relief drawn over the served tiles. */
function render(source: Record<string, unknown>, ramp: unknown[]): Promise<number[]> {
  const style = {
    version: 8,
    sources: {
      dem: {type: 'raster-dem', tiles: [`${TILE_URL}{z}/{x}/{y}.png`], tileSize: 256, ...source}
    },
    layers: [
      {id: 'background', type: 'background', paint: {'background-color': '#808080'}},
      {id: 'relief', type: 'color-relief', source: 'dem', paint: {'color-relief-color': ramp}}
    ]
  };
  parent = document.createElement('div');
  document.body.append(parent);
  return new Promise((resolve, reject) => {
    stableFrames.waitForStableFrame({frames: 3, timeout: 30_000}).then(image => {
      const center = ((SIZE / 2) * SIZE + SIZE / 2) * 4;
      resolve(Array.from(image.data.slice(center, center + 3)));
    }, reject);
    deck = new Deck({
      parent: parent!,
      width: SIZE,
      height: SIZE,
      useDevicePixels: false,
      deviceProps: {adapters: [webgl2Adapter]},
      views: new MapView({id: 'view'}),
      viewState: {longitude: 10, latitude: 10, zoom: 5, pitch: 0, bearing: 0} as any,
      layers: [new BasemapLayer({id: 'basemap', style: style as any})],
      ...stableFrames.deckProps,
      onError: error => reject(error)
    });
  });
}

describe('color-relief stops', () => {
  test('a stop is at the elevation that a custom encoding with overlapping factors decodes', async () => {
    // With the style spec's default custom factors [1, 1, 1, 0], the pixel [100, 0, 0] is 100 m.
    serveFlatTiles([100, 0, 0]);
    const color = await render({encoding: 'custom'}, [
      'interpolate',
      ['linear'],
      ['elevation'],
      0,
      '#000000',
      100,
      '#ffffff'
    ]);
    expect(color).toEqual([255, 255, 255]);
  }, 60_000);

  test('stops that round to one DEM step color a flat area by the upper stop', async () => {
    // A mapbox pixel of 0 meters, 10000 / 0.1 = 100000 = [1, 134, 160]. The stops 0 and 0.04
    // round to the same 0.1 meter step.
    serveFlatTiles([1, 134, 160]);
    const color = await render({encoding: 'mapbox'}, [
      'interpolate',
      ['linear'],
      ['elevation'],
      0,
      '#0000ff',
      0.04,
      '#ff0000'
    ]);
    expect(color).toEqual([255, 0, 0]);
  }, 60_000);
});
