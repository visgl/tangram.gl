// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {Deck, MapView} from '@deck.gl/core';
import {webgl2Adapter} from '@luma.gl/core/webgl';
import {expect, test} from 'vitest';
import {BasemapLayer} from '../src/basemap-layer';

const SIZE = 128;

/** A FeatureCollection of one square, 16 degrees wide, centered at `longitude`, 0. */
function square(longitude: number) {
  const ring = [
    [longitude - 8, -8],
    [longitude + 8, -8],
    [longitude + 8, 8],
    [longitude - 8, 8],
    [longitude - 8, -8]
  ];
  return {
    type: 'FeatureCollection',
    features: [{type: 'Feature', properties: {}, geometry: {type: 'Polygon', coordinates: [ring]}}]
  };
}

/** A tile with a blue water square north of the center, in tile-local coordinates. */
const WATER = [
  {
    type: 'Feature',
    properties: {layerName: 'water'},
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [0.47, 0.4],
          [0.53, 0.4],
          [0.53, 0.44],
          [0.47, 0.44],
          [0.47, 0.4]
        ]
      ]
    }
  }
];

const style: any = {
  version: 8,
  sources: {
    tiles: {type: 'vector', tiles: ['https://example.com/{z}/{x}/{y}.pbf'], maxzoom: 0},
    shapes: {type: 'geojson', data: square(-25)}
  },
  layers: [
    {id: 'background', type: 'background', paint: {'background-color': '#000000'}},
    {
      id: 'water',
      type: 'fill',
      source: 'tiles',
      'source-layer': 'water',
      paint: {'fill-color': '#0000ff'}
    },
    {id: 'shapes', type: 'fill', source: 'shapes', paint: {'fill-color': '#ff0000'}}
  ]
};

/** Counts of the red and blue pixels in the left and right halves of the canvas. */
type Counts = {redLeft: number; redRight: number; blue: number};

function countPixels(deck: Deck<any>): Counts {
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const context = canvas.getContext('2d')!;
  context.drawImage(deck.getCanvas()!, 0, 0);
  const pixels = context.getImageData(0, 0, SIZE, SIZE).data;
  const counts = {redLeft: 0, redRight: 0, blue: 0};
  for (let i = 0; i < pixels.length; i += 4) {
    const [r, g, b] = [pixels[i], pixels[i + 1], pixels[i + 2]];
    if (r > 200 && g < 60 && b < 60) {
      if ((i / 4) % SIZE < SIZE / 2) counts.redLeft++;
      else counts.redRight++;
    } else if (b > 200 && r < 60 && g < 60) {
      counts.blue++;
    }
  }
  return counts;
}

/** A new `sourceData` entry redraws its source, and the vector source loads no tile again. */
test('sourceData moves a GeoJSON shape without loading the other sources again', async () => {
  const parent = document.createElement('div');
  document.body.append(parent);
  let deck: Deck<any> | undefined;
  let requests = 0;
  const fetch = async () => {
    requests++;
    return WATER;
  };
  let check: ((counts: Counts) => boolean) | undefined;
  let complete: (() => void) | undefined;
  let latest = '';
  const waitFor = (predicate: (counts: Counts) => boolean) =>
    new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`No expected frame: ${latest}`)), 30_000);
      check = predicate;
      complete = () => {
        clearTimeout(timeout);
        resolve();
      };
      window.requestAnimationFrame(() => deck?.redraw('frame'));
    });
  try {
    const initial = waitFor(({redLeft, redRight, blue}) => redLeft > 50 && !redRight && blue > 10);
    deck = new Deck({
      parent,
      width: SIZE,
      height: SIZE,
      useDevicePixels: false,
      deviceProps: {adapters: [webgl2Adapter]},
      views: new MapView({id: 'view'}),
      initialViewState: {longitude: 0, latitude: 0, zoom: 0},
      layers: [new BasemapLayer({id: 'basemap', style, fetch})],
      onError: error => {
        throw error;
      },
      onAfterRender: () => {
        if (
          !check ||
          !(deck as any)?.layerManager.getLayers().every((layer: any) => layer.isLoaded)
        ) {
          return;
        }
        const counts = countPixels(deck!);
        latest = `${JSON.stringify(counts)} requests=${requests}`;
        if (!check(counts)) {
          // `redraw` draws at once, so wait for the browser's next frame first.
          window.setTimeout(() => window.requestAnimationFrame(() => deck?.redraw('settle')), 20);
          return;
        }
        const done = complete!;
        check = undefined;
        complete = undefined;
        done();
      }
    });
    await initial;
    const basemap = () => (deck as any).layerManager.getLayers().find((l: any) => l.id === 'basemap');
    const resolvedStyle = basemap().state.resolvedStyle;
    const [waterTileset] = [...basemap().state.tilesets].find(
      ([source]: any) => source.type === 'vector'
    )!.slice(1);

    const moved = waitFor(({redLeft, redRight, blue}) => !redLeft && redRight > 50 && blue > 10);
    deck.setProps({
      layers: [new BasemapLayer({id: 'basemap', style, fetch, sourceData: {shapes: square(25)}})]
    });
    await moved;

    expect(requests).toBe(1);
    expect(basemap().state.resolvedStyle).toBe(resolvedStyle);
    const tilesets = [...basemap().state.tilesets];
    expect(tilesets.find(([source]: any) => source.type === 'vector')![1]).toBe(waterTileset);
  } finally {
    deck?.finalize();
    parent.remove();
  }
}, 60_000);
