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

// Lines kept at width 0 for a zoom step, alone or in a batch, draw nothing and are not picked.

const SIZE = 256;

let deck: Deck<any> | null = null;
let parent: HTMLDivElement | null = null;
const stableFrames = createStableFrameWait({getDeck: () => deck, width: SIZE, minLayers: 2});

function cleanup() {
  deck?.finalize();
  deck = null;
  parent?.remove();
  parent = null;
  stableFrames.cancel();
}

afterEach(cleanup);

const lineFeature = (layerName: string, id: number, coordinates: number[][]) => ({
  type: 'Feature',
  id,
  properties: {layerName, id},
  geometry: {type: 'LineString', coordinates}
});

/**
 * Every tile holds drawn roads, crossing and bent so that caps and joins show, and lines in other
 * source layers, which the kept style layers draw at width 0.
 */
const fetchTile = async () => [
  lineFeature('road', 1, [
    [0.1, 0.2],
    [0.9, 0.8]
  ]),
  lineFeature('road', 2, [
    [0.1, 0.8],
    [0.5, 0.5],
    [0.9, 0.85]
  ]),
  // In the tile's top left corner, which the view shows at every zoom of these tests: the view is
  // centered on a tile corner, and up to zoom 6 it draws the zoom 5 tiles (a vector source's tiles
  // are those at the floor of the zoom), so at 5.8 it shows only the corner of each tile.
  ...['zero', 'dashed', 'blurred'].map((layerName, index) =>
    lineFeature(layerName, 10 + index, [
      [0.02, 0.02 + 0.03 * index],
      [0.07, 0.05 + 0.03 * index],
      [0.12, 0.02 + 0.03 * index]
    ])
  )
];

/** 0 up to zoom 5, then wider: drawn from the 5.25 step on. */
const STARTS_AT_5 = ['interpolate', ['linear'], ['zoom'], 5, 0, 6, 6];
const ROUND = {'line-cap': 'round', 'line-join': 'round'};

/**
 * The style: a road casing and road with round caps and joins, and, with `kept`, three style
 * layers at width 0 at zoom 5: one batched with the roads, one dashed and one blurred.
 */
function style(kept: boolean, {alone = false} = {}) {
  const layers: any[] = [
    {id: 'background', type: 'background', paint: {'background-color': '#ffffff'}},
    {
      id: 'casing',
      type: 'line',
      'source-layer': 'road',
      layout: ROUND,
      paint: {'line-color': '#222222', 'line-width': 9}
    },
    ...(kept
      ? [
          {
            id: 'zero',
            type: 'line',
            'source-layer': 'zero',
            layout: alone ? {'line-cap': 'square'} : ROUND,
            paint: {'line-color': '#ff0000', 'line-width': STARTS_AT_5}
          },
          {
            id: 'dashed',
            type: 'line',
            'source-layer': 'dashed',
            layout: ROUND,
            paint: {
              'line-color': '#00aa00',
              'line-width': STARTS_AT_5,
              'line-dasharray': [2, 1]
            }
          },
          {
            id: 'blurred',
            type: 'line',
            'source-layer': 'blurred',
            layout: ROUND,
            paint: {'line-color': '#0000ff', 'line-width': STARTS_AT_5, 'line-blur': 2}
          }
        ]
      : []),
    {
      id: 'road',
      type: 'line',
      'source-layer': 'road',
      layout: ROUND,
      paint: {'line-color': '#ffcc00', 'line-width': 5}
    }
  ];
  return {
    version: 8,
    sources: {tiles: {type: 'vector', tiles: ['https://tiles.example.com/{z}/{x}/{y}.mvt']}},
    layers: layers.map(layer => (layer.type === 'background' ? layer : {...layer, source: 'tiles'}))
  } as any;
}

/** Resolves with the frame drawn once every sublayer has loaded and the frame stops changing. */
function nextFrame(): Promise<ImageData> {
  return stableFrames.waitForStableFrame({
    frames: 5,
    isSame: (a, b) => countDifferent(a, b) === 0,
    timeout: 30_000
  });
}

/** A basemap whose vector tile layers are pickable, as an application can make them. */
class PickableBasemapLayer extends BasemapLayer {
  static layerName = 'PickableBasemapLayer';
  renderLayers() {
    return (super.renderLayers() as any[]).map(layer => layer.clone({pickable: true}));
  }
}

async function render(
  basemapStyle: any,
  zoom = 5.1
): Promise<{image: ImageData; sublayers: string[]}> {
  cleanup();
  parent = document.createElement('div');
  document.body.append(parent);
  const frame = nextFrame();
  deck = new Deck({
    parent,
    width: SIZE,
    height: SIZE,
    useDevicePixels: false,
    deviceProps: {adapters: [webgl2Adapter]},
    views: new MapView({id: 'map'}),
    viewState: {longitude: 0, latitude: 0, zoom} as any,
    layers: [
      new PickableBasemapLayer({id: 'basemap', mode: 'map', fetch: fetchTile, style: basemapStyle})
    ],
    ...stableFrames.deckProps,
    onError: error => {
      throw error;
    }
  });
  const image = await frame;
  const sublayers = ((deck as any).layerManager.getLayers() as any[])
    .filter(layer => layer.constructor.layerName === 'StyledGeoJsonLayer')
    .map(layer => `${layer.props.visible === false ? 'hidden:' : ''}${layer.id.split('-').pop()}`);
  return {image, sublayers};
}

function countDifferent(a: ImageData, b: ImageData): number {
  let count = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    if (
      a.data[i] !== b.data[i] ||
      a.data[i + 1] !== b.data[i + 1] ||
      a.data[i + 2] !== b.data[i + 2]
    ) {
      count++;
    }
  }
  return count;
}

/** The ids of the line features picked anywhere in the view (the background has none). */
function pickAll(): number[] {
  const picked = deck!.pickObjects({x: 0, y: 0, width: SIZE, height: SIZE});
  const ids = picked.map((info: any) => info.object?.properties?.id).filter(id => id !== undefined);
  return [...new Set(ids)].sort((a, b) => a - b);
}

describe('lines kept at width 0', () => {
  test('draw the same pixels as without them, batched, dashed or alone', async () => {
    const without = await render(style(false));
    const batched = await render(style(true));
    // The kept line shares the roads' batch; the dashed one too; the blurred one is left out.
    expect(batched.sublayers.some(id => id.includes('"zero"'))).toBe(true);
    expect(batched.sublayers.some(id => id.includes('"dashed"'))).toBe(true);
    expect(batched.sublayers.some(id => id.includes('"blurred"'))).toBe(false);
    expect(countDifferent(batched.image, without.image)).toBe(0);

    // A kept line that cannot join the roads' batch draws alone, hidden.
    const alone = await render(style(true, {alone: true}));
    expect(alone.sublayers.some(id => id === 'hidden:"zero"')).toBe(true);
    expect(countDifferent(alone.image, without.image)).toBe(0);
  }, 90_000);

  test('are not picked, batched or alone', async () => {
    await render(style(true));
    expect(pickAll()).toEqual([1, 2]);
    await render(style(true, {alone: true}));
    expect(pickAll()).toEqual([1, 2]);
    // Steps later, with a width, the same lines in the same tiles are drawn and picked.
    await render(style(true), 5.8);
    expect(pickAll()).toEqual(expect.arrayContaining([10, 11, 12]));
  }, 90_000);
});
