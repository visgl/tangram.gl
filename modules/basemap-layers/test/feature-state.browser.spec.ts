// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {Deck, MapView} from '@deck.gl/core';
import {webgl2Adapter} from '@luma.gl/core/webgl';
import {afterEach, describe, expect, test, vi} from 'vitest';
import {BasemapLayer} from '../src/basemap-layer';
import type {BasemapFeatureState} from '../src/feature-state';

// A hover state set with `featureState` recolors the hovered feature, and only its paint
// attributes are computed again: no polygon or path is tessellated again. A picked feature names
// its style layer, source, source layer and id, also in a sublayer that draws several style layers.

const SIZE = 256;

let deck: Deck<any> | null = null;
let parent: HTMLDivElement | null = null;
let onFrame: ((image: ImageData) => void) | null = null;

function cleanup() {
  deck?.finalize();
  deck = null;
  parent?.remove();
  parent = null;
  onFrame = null;
}

afterEach(cleanup);

const ring = (x0: number, y0: number, x1: number, y1: number) => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
  [x0, y0]
];

/** Each tile holds two buildings, a park and a road, in tile-local coordinates. */
const fetchTile = async () => [
  {
    type: 'Feature',
    id: 1,
    properties: {layerName: 'building', name: 'one'},
    geometry: {type: 'Polygon', coordinates: [ring(0.1, 0.1, 0.4, 0.4)]}
  },
  {
    type: 'Feature',
    id: 2,
    properties: {layerName: 'building', name: 'two'},
    geometry: {type: 'Polygon', coordinates: [ring(0.6, 0.1, 0.9, 0.4)]}
  },
  {
    type: 'Feature',
    id: 3,
    properties: {layerName: 'park'},
    geometry: {type: 'Polygon', coordinates: [ring(0.1, 0.6, 0.9, 0.9)]}
  },
  {
    type: 'Feature',
    id: 4,
    properties: {layerName: 'road'},
    geometry: {
      type: 'LineString',
      coordinates: [
        [0.05, 0.5],
        [0.95, 0.5]
      ]
    }
  }
];

const STYLE = {
  version: 8,
  sources: {tiles: {type: 'vector', tiles: ['https://tiles.example.com/{z}/{x}/{y}.mvt']}},
  layers: [
    {id: 'background', type: 'background', paint: {'background-color': '#ffffff'}},
    // Two fills without an outline, drawn in one sublayer.
    {
      id: 'building',
      type: 'fill',
      source: 'tiles',
      'source-layer': 'building',
      paint: {
        'fill-color': [
          'case',
          ['boolean', ['feature-state', 'hover'], false],
          '#ff0000',
          '#0000ff'
        ],
        'fill-antialias': false
      }
    },
    {
      id: 'park',
      type: 'fill',
      source: 'tiles',
      'source-layer': 'park',
      paint: {'fill-color': '#00ff00', 'fill-antialias': false}
    },
    {
      id: 'road',
      type: 'line',
      source: 'tiles',
      'source-layer': 'road',
      paint: {'line-color': '#000000', 'line-width': 3}
    }
  ]
} as any;

/** Resolves with the frame drawn once every sublayer has loaded and the frame stops changing. */
function nextFrame(): Promise<ImageData> {
  return new Promise((resolve, reject) => {
    let previous: ImageData | null = null;
    let same = 0;
    const timeout = window.setTimeout(() => reject(new Error('Timed out rendering')), 30_000);
    onFrame = image => {
      same = previous && countDifferent(previous, image) === 0 ? same + 1 : 0;
      previous = image;
      if (same < 5) {
        window.setTimeout(() => window.requestAnimationFrame(() => deck?.redraw('settle')), 20);
        return;
      }
      onFrame = null;
      window.clearTimeout(timeout);
      resolve(image);
    };
    window.requestAnimationFrame(() => deck?.redraw('frame'));
  });
}

function getBasemap(featureState: BasemapFeatureState | null) {
  return new BasemapLayer({
    id: 'basemap',
    mode: 'map',
    pickable: true,
    fetch: fetchTile,
    style: STYLE,
    featureState
  } as any);
}

function createDeck(featureState: BasemapFeatureState | null): Promise<ImageData> {
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
    viewState: {longitude: 0, latitude: 0, zoom: 3.6} as any,
    layers: [getBasemap(featureState)],
    onAfterRender: () => {
      const layers = (deck as any)?.layerManager?.getLayers() || [];
      if (!onFrame || layers.length < 2 || layers.some((l: any) => !l.isLoaded)) {
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

function countDifferent(a: ImageData, b: ImageData): number {
  let count = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    if (
      Math.abs(a.data[i] - b.data[i]) > 2 ||
      Math.abs(a.data[i + 1] - b.data[i + 1]) > 2 ||
      Math.abs(a.data[i + 2] - b.data[i + 2]) > 2
    ) {
      count++;
    }
  }
  return count;
}

/** The pixels of a color, and the first of them. */
function findColor(image: ImageData, [r, g, b]: number[]): {count: number; at: [number, number]} {
  let count = 0;
  let at: [number, number] = [-1, -1];
  for (let i = 0; i < image.data.length; i += 4) {
    if (
      Math.abs(image.data[i] - r) < 8 &&
      Math.abs(image.data[i + 1] - g) < 8 &&
      Math.abs(image.data[i + 2] - b) < 8
    ) {
      if (count === 0) {
        at = [(i / 4) % SIZE, Math.floor(i / 4 / SIZE)];
      }
      count++;
    }
  }
  return {count, at};
}

/** The tessellators of every polygon and path layer drawn, which hold their geometry. */
function getTesselators(): any[] {
  const layers: any[] = (deck as any).layerManager.getLayers();
  return layers
    .map(layer => layer.state?.polygonTesselator ?? layer.state?.pathTesselator)
    .filter(Boolean);
}

const RED = [255, 0, 0];
const BLUE = [0, 0, 255];
const GREEN = [0, 255, 0];

describe('feature-state', () => {
  test('recolors a hovered feature without tessellating its geometry again', async () => {
    const before = await createDeck(null);
    const blue = findColor(before, BLUE);
    expect(blue.count).toBeGreaterThan(100);
    expect(findColor(before, RED).count).toBe(0);

    const tesselators = getTesselators();
    expect(tesselators.length).toBeGreaterThan(0);
    const updates = tesselators.map(tesselator => vi.spyOn(tesselator, 'updateGeometry'));

    const frame = nextFrame();
    deck!.setProps({layers: [getBasemap({tiles: {building: {2: {hover: true}}}})]});
    const after = await frame;
    const red = findColor(after, RED);
    // Building 2 of each tile turns red, building 1 stays blue.
    expect(red.count).toBeGreaterThan(50);
    expect(findColor(after, BLUE).count).toBeGreaterThan(50);
    expect(red.count + findColor(after, BLUE).count).toBeCloseTo(blue.count, -1);
    // The park and the road are drawn as before.
    expect(findColor(after, GREEN).count).toBe(findColor(before, GREEN).count);

    for (const update of updates) {
      expect(update).not.toHaveBeenCalled();
    }
    expect(getTesselators()).toEqual(tesselators);
  }, 60_000);

  test('a picked feature names its style layer, source, source layer and id', async () => {
    const image = await createDeck({tiles: {building: {2: {hover: true}}}});
    const pick = ([x, y]: [number, number]) => deck!.pickObject({x, y, radius: 0}) as any;

    const two = pick(findColor(image, RED).at);
    expect(two.basemapFeature).toEqual({
      id: 2,
      source: 'tiles',
      sourceLayer: 'building',
      styleLayerId: 'building',
      properties: {name: 'two'}
    });
    expect(pick(findColor(image, BLUE).at).basemapFeature.id).toBe(1);
    // The park is drawn in the buildings' sublayer.
    const park = pick(findColor(image, GREEN).at);
    expect(park.sourceLayer.id).toBe(two.sourceLayer.id);
    expect(park.basemapFeature).toMatchObject({id: 3, sourceLayer: 'park', styleLayerId: 'park'});
  }, 60_000);
});
