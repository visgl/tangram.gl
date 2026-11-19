// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {Deck, MapView} from '@deck.gl/core';
import {MaskExtension, type MaskExtensionProps} from '@deck.gl/extensions';
import {SolidPolygonLayer} from '@deck.gl/layers';
import {webgl2Adapter} from '@luma.gl/core/webgl';
import {afterEach, describe, expect, test} from 'vitest';
import {BasemapLayer} from '../src/basemap-layer';

// The `extensions` of a `BasemapLayer`, and their props, reach the layers that draw the basemap:
// a mask layer masks its background, fills, lines and labels.

const SIZE = 256;
/** Labels are masked by their anchors: one anchored inside the mask can reach this far out of it. */
const LABEL_REACH = 48;

let deck: Deck<any> | null = null;
let parent: HTMLDivElement | null = null;
let onFrame: ((image: ImageData) => void) | null = null;

afterEach(() => {
  deck?.finalize();
  deck = null;
  parent?.remove();
  parent = null;
  onFrame = null;
});

/** Each tile holds a square, two lines across it and four labelled points, in tile-local coordinates. */
const fetchTile = async (url: string) => {
  const [z, x, y] = url
    .match(/(\d+)\/(\d+)\/(\d+)\.mvt/)!
    .slice(1)
    .map(Number);
  return [
    {
      type: 'Feature',
      properties: {layerName: 'area'},
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [0.1, 0.1],
            [0.9, 0.1],
            [0.9, 0.9],
            [0.1, 0.9],
            [0.1, 0.1]
          ]
        ]
      }
    },
    // The view center is a corner of four tiles: a line and a label near each corner are in view.
    ...[0.15, 0.85].map(y => ({
      type: 'Feature',
      properties: {layerName: 'road'},
      geometry: {
        type: 'LineString',
        coordinates: [
          [0, y],
          [1, y]
        ]
      }
    })),
    ...[
      [0.12, 0.12],
      [0.88, 0.12],
      [0.12, 0.88],
      [0.88, 0.88]
    ].map(coordinates => ({
      type: 'Feature',
      properties: {layerName: 'place', name: `T${z}${x}${y}`},
      geometry: {type: 'Point', coordinates}
    }))
  ];
};

const STYLE = {
  version: 8,
  sources: {tiles: {type: 'vector', tiles: ['https://tiles.example.com/{z}/{x}/{y}.mvt']}},
  layers: [
    {id: 'background', type: 'background', paint: {'background-color': '#ffffff'}},
    {
      id: 'area',
      type: 'fill',
      source: 'tiles',
      'source-layer': 'area',
      paint: {'fill-color': '#ff0000'}
    },
    {
      id: 'road',
      type: 'line',
      source: 'tiles',
      'source-layer': 'road',
      paint: {'line-color': '#00ff00', 'line-width': 6}
    },
    {
      id: 'place',
      type: 'symbol',
      source: 'tiles',
      'source-layer': 'place',
      layout: {'text-field': ['get', 'name'], 'text-size': 12},
      paint: {'text-color': '#000000'}
    }
  ]
} as any;

/** A mask over the west half of the world: the left half of the view. */
const createMask = () =>
  new SolidPolygonLayer<[number, number][]>({
  id: 'mask',
  data: [
    [
      [-170, -80],
      [0, -80],
      [0, 80],
      [-170, 80]
    ]
  ],
  getPolygon: polygon => polygon,
  operation: 'mask'
});

/** Resolves with the frame drawn once every sublayer has loaded and the frame has stopped changing. */
function render(layers: unknown[]): Promise<ImageData> {
  parent = document.createElement('div');
  document.body.append(parent);
  const frame = new Promise<ImageData>((resolve, reject) => {
    let previous: ImageData | null = null;
    let same = 0;
    const timeout = window.setTimeout(() => {
      const loading = ((deck as any)?.layerManager?.getLayers() || [])
        .filter((layer: any) => !layer.isLoaded)
        .map((layer: any) => layer.id);
      reject(new Error(`Timed out rendering: ${same} equal frames, loading ${loading}`));
    }, 60_000);
    onFrame = image => {
      same = previous && isSame(previous, image) ? same + 1 : 0;
      previous = image;
      if (same < 10) {
        // `redraw` draws at once, so wait for the browser's next frame first.
        window.setTimeout(() => window.requestAnimationFrame(() => deck?.redraw('settle')), 20);
        return;
      }
      onFrame = null;
      window.clearTimeout(timeout);
      resolve(image);
    };
  });
  window.requestAnimationFrame(() => deck?.redraw('frame'));
  deck = new Deck({
    parent,
    width: SIZE,
    height: SIZE,
    useDevicePixels: false,
    deviceProps: {adapters: [webgl2Adapter]},
    views: new MapView({id: 'map'}),
    viewState: {longitude: 0, latitude: 0, zoom: 4.05} as any,
    layers: layers as any,
    onAfterRender: () => {
      const loaded = (deck as any)?.layerManager?.getLayers() || [];
      // A basemap draws no sublayers until its style resolves: wait for more than it and the mask.
      if (!onFrame || loaded.length < 3 || loaded.some((layer: any) => !layer.isLoaded)) {
        return;
      }
      const copy = document.createElement('canvas');
      copy.width = SIZE;
      copy.height = SIZE;
      const context = copy.getContext('2d')!;
      context.drawImage(deck!.getCanvas()!, 0, 0);
      onFrame(context.getImageData(0, 0, SIZE, SIZE));
    },
    onError: error => {
      throw error;
    }
  });
  return frame;
}

function isSame(a: ImageData, b: ImageData): boolean {
  return a.data.every((value, index) => Math.abs(value - b.data[index]) <= 8);
}

/** The pixels of the columns from `left` to `right` that are drawn, and those of each color. */
function count(image: ImageData, left: number, right: number) {
  const counts = {drawn: 0, white: 0, red: 0, green: 0, dark: 0};
  for (let y = 0; y < SIZE; y++) {
    for (let x = left; x < right; x++) {
      const i = (y * SIZE + x) * 4;
      const [r, g, b, a] = image.data.slice(i, i + 4);
      if (a === 0) continue;
      counts.drawn++;
      if (r > 200 && g > 200 && b > 200) counts.white++;
      if (r > 200 && g < 60 && b < 60) counts.red++;
      if (g > 200 && r < 60 && b < 60) counts.green++;
      if (r < 60 && g < 60 && b < 60) counts.dark++;
    }
  }
  return counts;
}

describe('the extensions of a BasemapLayer', () => {
  test('a MaskExtension masks the background, fills, lines and labels', {timeout: 180_000}, async () => {
    const inside = [0, SIZE / 2 - 2] as const;
    const outside = [SIZE / 2 + LABEL_REACH, SIZE] as const;
    const outsideArea = (outside[1] - outside[0]) * SIZE;

    // Without the extension, the basemap draws on both sides.
    const plain = await render([
      createMask(),
      new BasemapLayer({id: 'basemap', fetch: fetchTile, style: STYLE})
    ]);
    const plainOutside = count(plain, ...outside);
    expect(plainOutside.drawn).toBe(outsideArea);
    expect(plainOutside.red).toBeGreaterThan(0);
    expect(plainOutside.green).toBeGreaterThan(0);
    expect(plainOutside.dark).toBeGreaterThan(0);
    deck!.finalize();
    parent!.remove();

    const masked = await render([
      createMask(),
      new BasemapLayer<MaskExtensionProps>({
        id: 'basemap',
        fetch: fetchTile,
        style: STYLE,
        extensions: [new MaskExtension()],
        maskId: 'mask'
      })
    ]);
    // Outside the mask, no layer of the basemap draws.
    expect(count(masked, ...outside)).toEqual({drawn: 0, white: 0, red: 0, green: 0, dark: 0});
    // Inside it, the basemap draws as without the mask.
    expect(count(masked, ...inside)).toEqual(count(plain, ...inside));
    expect(count(masked, ...inside).drawn).toBe((inside[1] - inside[0]) * SIZE);
  });
});
