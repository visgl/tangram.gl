// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

// deck.gl-community
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {Deck, MapView} from '@deck.gl/core';
import {webgl2Adapter} from '@luma.gl/core/webgl';
import {afterEach, describe, expect, test} from 'vitest';
import {BasemapLayer} from '../src/basemap-layer';

// A picked label reports its feature in longitude/latitude, and the tile it was placed for.

const SIZE = 256;

/**
 * How long to wait for the label to become pickable. Deck start-up, shader compiles and the first
 * draws run on software WebGL in CI, beside other browser test files: with coverage instrumentation
 * they took more than 25 s on some runs. This stays below the test's own timeout, so that a label
 * that never becomes pickable fails with the message below.
 */
const PICKABLE_TIMEOUT_MS = 50_000;

type ViewState = {longitude: number; latitude: number; zoom: number};

let deck: Deck<any> | null = null;
let parent: HTMLDivElement | null = null;
let polling = false;

function cleanup() {
  polling = false;
  deck?.finalize();
  deck = null;
  parent?.remove();
  parent = null;
}

afterEach(cleanup);

/** Each tile holds one labelled point at its center, in tile-local coordinates. */
const fetchTile = async (url: string) => {
  const [z, x, y] = url
    .match(/(\d+)\/(\d+)\/(\d+)\.mvt/)!
    .slice(1)
    .map(Number);
  return [
    {
      type: 'Feature',
      properties: {layerName: 'place', name: `T${z}${x}${y}`},
      geometry: {type: 'Point', coordinates: [0.5, 0.5]}
    }
  ];
};

const STYLE = {
  version: 8,
  sources: {tiles: {type: 'vector', tiles: ['https://tiles.example.com/{z}/{x}/{y}.mvt']}},
  layers: [
    {id: 'background', type: 'background', paint: {'background-color': '#ffffff'}},
    {
      id: 'place',
      type: 'symbol',
      source: 'tiles',
      'source-layer': 'place',
      layout: {'text-field': ['get', 'name'], 'text-size': 20},
      paint: {'text-color': '#000000'}
    }
  ]
} as any;

/**
 * Resolves with the first feature picked at `x`, `y` once every sublayer has loaded: a style
 * resolves, and the tile and font load, over several frames. Each animation frame draws once and
 * picks once, also while sublayers still load, so the wait never depends on a frame that deck
 * draws by itself, and ends at the first frame that has the label.
 */
function pickWhenDrawn(x: number, y: number): Promise<any> {
  return new Promise((resolve, reject) => {
    const start = performance.now();
    polling = true;
    const finish = (settle: () => void) => {
      polling = false;
      settle();
    };
    const poll = () => {
      if (!polling) {
        return;
      }
      let info: any = null;
      try {
        const layers = (deck as any)?.layerManager?.getLayers() || [];
        // A basemap draws no sublayers until its style resolves.
        if (layers.length >= 2 && layers.every((layer: any) => layer.isLoaded)) {
          // `redraw` draws at once: the label is placed before the pick reads it.
          deck!.redraw('poll');
          info = deck!.pickObject({x, y, radius: 4});
        }
      } catch (error) {
        // An error in an animation frame would otherwise end the polling silently.
        finish(() => reject(error));
        return;
      }
      // The pickable background is picked until the label draws over it.
      if (info?.object?.properties) {
        finish(() => resolve(info));
      } else if (performance.now() - start > PICKABLE_TIMEOUT_MS) {
        finish(() => reject(new Error('Timed out waiting for a pickable label')));
      } else {
        window.requestAnimationFrame(poll);
      }
    };
    window.requestAnimationFrame(poll);
  });
}

function createDeck(layer: unknown, viewState: ViewState): void {
  parent = document.createElement('div');
  document.body.append(parent);
  deck = new Deck({
    parent,
    width: SIZE,
    height: SIZE,
    useDevicePixels: false,
    deviceProps: {adapters: [webgl2Adapter]},
    views: new MapView({id: 'map'}),
    viewState: viewState as any,
    layers: [layer as any],
    onError: error => {
      throw error;
    }
  });
}

/** A basemap whose vector tile layers are pickable, as an application can make them. */
class PickableBasemapLayer extends BasemapLayer {
  static layerName = 'PickableBasemapLayer';
  renderLayers(): any {
    return (super.renderLayers() as any[]).map(layer => layer.clone({pickable: true}));
  }
}

describe('a picked label', () => {
  test('reports its feature in longitude/latitude and its tile', async () => {
    const basemap = new PickableBasemapLayer({
      id: 'basemap',
      mode: 'map',
      fetch: fetchTile,
      style: STYLE
    } as any);
    // The center of tile 1-1-1, (0.75, 0.75) of the world, at the center of the view.
    const anchor = [90, (360 / Math.PI) * Math.atan(Math.exp(-0.5 * Math.PI)) - 90];
    createDeck(basemap, {longitude: anchor[0], latitude: anchor[1], zoom: 1.2});
    const info = await pickWhenDrawn(SIZE / 2, SIZE / 2);
    expect(info.object.properties.name).toBe('T111');
    expect(info.tile?.id).toBe('1-1-1');
    const [lng, lat] = info.object.geometry.coordinates;
    expect(lng).toBeCloseTo(anchor[0], 4);
    expect(lat).toBeCloseTo(anchor[1], 4);
  }, 60_000);
});
