// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

// deck.gl-community
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {Deck, MapView, _GlobeView as GlobeView} from '@deck.gl/core';
import {webgl2Adapter} from '@luma.gl/core/webgl';
import {afterEach, describe, expect, test} from 'vitest';
import {BasemapLayer} from '../src/basemap-layer';
import {toFixtureUrl} from './reference-render/fixtures';

// A hillshade draws on a globe as on a map. At zoom 10 the globe is nearly flat over the view.

const SIZE = 256;
const BACKGROUND = [242, 239, 233];
const VIEW_STATE = {
  longitude: -121.81640625,
  latitude: 46.8000594467873,
  zoom: 10 + Math.log2(300 / 256),
  pitch: 0,
  bearing: 0
};

const STYLE = {
  version: 8,
  sources: {
    terrain: {
      type: 'raster-dem',
      tiles: [
        toFixtureUrl('https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png')
      ],
      encoding: 'terrarium',
      tileSize: 256,
      maxzoom: 11
    }
  },
  layers: [
    {id: 'background', type: 'background', paint: {'background-color': '#f2efe9'}},
    {id: 'hillshade', type: 'hillshade', source: 'terrain'}
  ]
};

let deck: Deck<any> | null = null;
let parent: HTMLDivElement | null = null;

afterEach(() => {
  deck?.finalize();
  deck = null;
  parent?.remove();
  parent = null;
});

/** The pixels of the basemap drawn in `mode`, once every tile has loaded. */
function render(mode: 'map' | 'globe'): Promise<Uint8ClampedArray> {
  parent = document.createElement('div');
  document.body.append(parent);
  return new Promise((resolve, reject) => {
    let settled = 0;
    let redrawPending = false;
    const isLoaded = () => {
      const layers = (deck as any)?.layerManager?.getLayers() || [];
      const tileLayers = layers.filter((layer: any) => layer.state?.tileset);
      return (
        tileLayers.length > 0 &&
        tileLayers.every((layer: any) => layer.state.tileset.selectedTiles) &&
        layers.every((layer: any) => layer.isLoaded)
      );
    };
    // Draws in a later browser frame, once every layer has loaded: until then each frame only
    // checks again, so that the wait adds no draws while the tiles load. At most one such frame
    // is pending, so that each settle frame is one browser frame. The test timeout is the only
    // limit: on a busy CI runner one render can take more than 30 s.
    const redrawWhenLoaded = (reason: string) => {
      if (redrawPending) {
        return;
      }
      redrawPending = true;
      const check = () =>
        window.requestAnimationFrame(() => {
          if (deck && !isLoaded()) {
            check();
            return;
          }
          redrawPending = false;
          deck?.redraw(reason);
        });
      check();
    };
    deck = new Deck({
      parent: parent!,
      width: SIZE,
      height: SIZE,
      useDevicePixels: false,
      deviceProps: {adapters: [webgl2Adapter]},
      views: mode === 'globe' ? new GlobeView({resolution: 36, id: 'view'}) : new MapView({id: 'view'}),
      viewState: VIEW_STATE as any,
      layers: [new BasemapLayer({id: 'basemap', mode, style: structuredClone(STYLE) as any})],
      onAfterRender: () => {
        if (!isLoaded()) {
          // Deck does not always draw again by itself when the last tile loads.
          redrawWhenLoaded('load');
          return;
        }
        if (settled++ < 2) {
          redrawWhenLoaded('settle');
          return;
        }
        const copy = document.createElement('canvas');
        copy.width = SIZE;
        copy.height = SIZE;
        const context = copy.getContext('2d')!;
        context.drawImage(deck!.getCanvas()!, 0, 0);
        resolve(context.getImageData(0, 0, SIZE, SIZE).data);
      },
      onError: error => reject(error)
    });
  });
}

/** The median of the pixels' summed RGB differences from `color`. */
function medianDifference(pixels: Uint8ClampedArray, color: number[]) {
  const differences: number[] = [];
  for (let index = 0; index < pixels.length; index += 4) {
    let difference = 0;
    for (let channel = 0; channel < 3; channel++) {
      difference += Math.abs(pixels[index + channel] - color[channel]);
    }
    differences.push(difference);
  }
  differences.sort((a, b) => a - b);
  return differences[Math.floor(differences.length / 2)];
}

function meanColor(pixels: Uint8ClampedArray): number[] {
  const sums = [0, 0, 0];
  for (let index = 0; index < pixels.length; index += 4) {
    for (let channel = 0; channel < 3; channel++) {
      sums[channel] += pixels[index + channel];
    }
  }
  return sums.map(sum => sum / (pixels.length / 4));
}

describe('hillshade on a globe', () => {
  test('draws as on a map', async () => {
    const map = await render('map');
    deck?.finalize();
    parent?.remove();
    const globe = await render('globe');
    // The hillshade is drawn: most pixels are shaded away from the background.
    expect(medianDifference(globe, BACKGROUND)).toBeGreaterThan(50);
    // `GlobeView` draws a zoom at another scale than `MapView`, so the pixels do not line up; the
    // shading's colors do.
    const mapMean = meanColor(map);
    const globeMean = meanColor(globe);
    for (let channel = 0; channel < 3; channel++) {
      expect(Math.abs(globeMean[channel] - mapMean[channel])).toBeLessThanOrEqual(4);
    }
  }, 60_000);
});
