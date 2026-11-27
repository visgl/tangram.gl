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
import {createStableFrameWait} from './stable-frame';

// Two BasemapLayers stacked in one deck, as a base style and a labels style, place their labels
// together as the layers of one style: where their labels overlap, the later layer's is drawn.

const WIDTH = 640;
const HEIGHT = 96;

let deck: Deck<any> | null = null;
let parent: HTMLDivElement | null = null;
// Both basemaps draw sublayers once their styles resolve.
const stableFrames = createStableFrameWait({
  getDeck: () => deck,
  width: WIDTH,
  height: HEIGHT,
  minLayers: 4
});

afterEach(() => {
  deck?.finalize();
  deck = null;
  parent?.remove();
  parent = null;
  stableFrames.cancel();
});

/** Each tile holds one point labelled `name` at its center. */
const fetchLabel = (name: string) => async () => [
  {
    type: 'Feature',
    properties: {layerName: 'place', name},
    geometry: {type: 'Point', coordinates: [0.5, 0.5]}
  }
];

/** A style of one label layer, its text in `color`, with a white background when `background`. */
function labelStyle(host: string, color: string, background: boolean): any {
  return {
    version: 8,
    sources: {tiles: {type: 'vector', tiles: [`https://${host}.example.com/{z}/{x}/{y}.mvt`]}},
    layers: [
      ...(background
        ? [{id: 'background', type: 'background', paint: {'background-color': '#ffffff'}}]
        : []),
      {
        id: 'place',
        type: 'symbol',
        source: 'tiles',
        'source-layer': 'place',
        layout: {'text-field': ['get', 'name'], 'text-size': 20},
        paint: {'text-color': color}
      }
    ]
  };
}

function stackedBasemaps(props: Record<string, unknown> = {}): BasemapLayer[] {
  return [
    new BasemapLayer({
      id: 'base',
      fetch: fetchLabel('Base'),
      style: labelStyle('base', '#ff0000', true),
      labelPlacementInterval: 0
    } as any),
    new BasemapLayer({
      id: 'labels',
      fetch: fetchLabel('Labels'),
      style: labelStyle('labels', '#0000ff', false),
      labelPlacementInterval: 0,
      ...props
    } as any)
  ];
}

/** The center of tile 2-1-1: its label lands at the center of each view. */
const VIEW = {
  longitude: -45,
  latitude: (360 / Math.PI) * Math.atan(Math.exp(0.25 * Math.PI)) - 90,
  zoom: 2,
  pitch: 0,
  bearing: 0
};

function createDeck(layers: unknown[], deckProps: Record<string, unknown> = {}): void {
  parent = document.createElement('div');
  document.body.append(parent);
  deck = new Deck({
    parent,
    width: WIDTH,
    height: HEIGHT,
    useDevicePixels: false,
    deviceProps: {adapters: [webgl2Adapter]},
    views: new MapView({id: 'map'}),
    viewState: VIEW as any,
    layers: layers as any[],
    ...stableFrames.deckProps,
    onError: error => {
      throw error;
    },
    ...deckProps
  });
}

/** The frame drawn once it has stopped changing: styles resolve, and fonts load, over frames. */
function settledFrame(): Promise<ImageData> {
  return stableFrames.waitForStableFrame({
    frames: 10,
    isSame: (a, b) => a.data.every((value, i) => value === b.data[i]),
    timeout: 30_000
  });
}

/** The number of red and of blue text pixels in columns `x0..x1`. */
function countColors(image: ImageData, x0 = 0, x1 = WIDTH): {red: number; blue: number} {
  let red = 0;
  let blue = 0;
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * WIDTH + x) * 4;
      const [r, g, b] = [image.data[i], image.data[i + 1], image.data[i + 2]];
      if (r > 160 && g < 100 && b < 100) red++;
      if (b > 160 && g < 100 && r < 100) blue++;
    }
  }
  return {red, blue};
}

describe('stacked BasemapLayers', () => {
  test("place their labels together: the later layer's label hides the one it overlaps", async () => {
    createDeck(stackedBasemaps());
    const {red, blue} = countColors(await settledFrame());
    expect(blue).toBeGreaterThan(20);
    expect(red).toBe(0);
  }, 60_000);

  test('with separateLabelPlacement, each draws its labels regardless of the other', async () => {
    createDeck(stackedBasemaps({separateLabelPlacement: true}));
    const {red, blue} = countColors(await settledFrame());
    expect(blue).toBeGreaterThan(20);
    expect(red).toBeGreaterThan(20);
  }, 60_000);

  test("in views the deck's layerFilter gives each to, neither hides the other's labels", async () => {
    const half = WIDTH / 2;
    createDeck(stackedBasemaps(), {
      views: [
        new MapView({id: 'left', x: 0, width: half}),
        new MapView({id: 'right', x: half, width: half})
      ],
      viewState: {left: VIEW, right: VIEW},
      layerFilter: ({layer, viewport}: any) =>
        layer.id === 'base' ? viewport.id === 'left' : viewport.id === 'right'
    });
    const image = await settledFrame();
    const left = countColors(image, 0, half);
    const right = countColors(image, half, WIDTH);
    expect(left.red).toBeGreaterThan(20);
    expect(left.blue).toBe(0);
    expect(right.blue).toBeGreaterThan(20);
    expect(right.red).toBe(0);
  }, 60_000);
});
