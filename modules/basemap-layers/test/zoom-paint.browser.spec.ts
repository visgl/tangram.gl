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

// Fills and lines whose paint depends on zoom take values and blend factors from a texture
// evaluated at the viewport zoom. After zooming across steps, they draw as a fresh basemap
// of the same view.

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

/** Each tile holds overlapping polygons and crossing lines, in tile-local coordinates. */
const fetchTile = async () => [
  {
    type: 'Feature',
    properties: {layerName: 'land', kind: 'park'},
    geometry: {type: 'Polygon', coordinates: [ring(0.1, 0.1, 0.6, 0.6)]}
  },
  {
    type: 'Feature',
    properties: {layerName: 'land', kind: 'water'},
    geometry: {type: 'Polygon', coordinates: [ring(0.4, 0.4, 0.9, 0.9)]}
  },
  ...[0.2, 0.5, 0.8].map((v, index) => ({
    type: 'Feature',
    properties: {layerName: 'road', rank: index},
    geometry: {
      type: 'LineString',
      coordinates: [
        [0.05, v],
        [0.95, 1 - v]
      ]
    }
  }))
];

const STYLE_LAYERS = [
  {
    id: 'park',
    type: 'fill',
    'source-layer': 'land',
    filter: ['==', ['get', 'kind'], 'park'],
    paint: {
      'fill-color': ['interpolate', ['linear'], ['zoom'], 0, '#33aa33', 8, '#aa33aa'],
      'fill-opacity': ['interpolate', ['linear'], ['zoom'], 0, 1, 8, 0.2]
    }
  },
  {
    id: 'water',
    type: 'fill',
    'source-layer': 'land',
    filter: ['==', ['get', 'kind'], 'water'],
    paint: {'fill-color': '#3366ff', 'fill-opacity': 0.7}
  },
  {
    id: 'casing',
    type: 'line',
    'source-layer': 'road',
    paint: {
      'line-color': ['interpolate', ['linear'], ['zoom'], 0, '#222222', 8, '#aa6600'],
      'line-width': ['interpolate', ['linear'], ['zoom'], 0, 2, 8, 18]
    }
  },
  {
    id: 'road',
    type: 'line',
    'source-layer': 'road',
    paint: {
      'line-color': ['match', ['get', 'rank'], 0, '#ffcc00', '#ffffff'],
      'line-width': ['interpolate', ['linear'], ['zoom'], 0, 1, 8, 9]
    }
  }
];

function makeStyle(styleLayers: any[]) {
  return {
    version: 8,
    sources: {tiles: {type: 'vector', tiles: ['https://tiles.example.com/{z}/{x}/{y}.mvt']}},
    layers: [
      {id: 'background', type: 'background', paint: {'background-color': '#ffffff'}},
      ...styleLayers.map(layer => ({...layer, source: 'tiles'}))
    ]
  } as any;
}

const STYLE = makeStyle(STYLE_LAYERS);

/**
 * `STYLE_LAYERS` with the paint they evaluate to at the 3.75 style zoom step, as constants, which
 * do not depend on the zoom the paint texture is written for.
 */
const t = 3.75 / 8;
const mix = (a: number, b: number) => a + (b - a) * t;
const STYLE_AT_3_75 = makeStyle(
  STYLE_LAYERS.map(layer => {
    const paint: Record<string, unknown> = {...layer.paint};
    if (layer.id === 'park') {
      paint['fill-color'] = `rgb(${mix(51, 170)}, ${mix(170, 51)}, ${mix(51, 170)})`;
      paint['fill-opacity'] = mix(1, 0.2);
    } else if (layer.id === 'casing') {
      paint['line-color'] = `rgb(${mix(34, 170)}, ${mix(34, 102)}, ${mix(34, 0)})`;
      paint['line-width'] = mix(2, 18);
    } else if (layer.id === 'road') {
      paint['line-width'] = mix(1, 9);
    }
    return {...layer, paint};
  })
);

/**
 * Resolves with the frame drawn once every sublayer has loaded and the frame stops changing. The
 * deck draws every frame itself (`_animate`), after it has updated its layers: a frame drawn with
 * `deck.redraw()` does not update the layers, and a tile that has loaded before its sublayers exist
 * counts as loaded.
 */
function nextFrame(): Promise<ImageData> {
  return new Promise((resolve, reject) => {
    let previous: ImageData | null = null;
    let same = 0;
    const timeout = window.setTimeout(() => reject(new Error('Timed out rendering')), 30_000);
    onFrame = image => {
      same = previous && countDifferent(previous, image) === 0 ? same + 1 : 0;
      previous = image;
      if (same < 5) {
        return;
      }
      onFrame = null;
      window.clearTimeout(timeout);
      resolve(image);
    };
  });
}

/** The map center used to sample a fixture's pixels. */
type Center = {longitude: number; latitude: number};
/** The center of the multi-tile fill and line fixture. */
const ORIGIN = {longitude: 0, latitude: 0};

function createDeck(
  zoom: number,
  style = STYLE,
  fetch: () => Promise<unknown[]> = fetchTile,
  center: Center = ORIGIN
): Promise<ImageData> {
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
    viewState: {...center, zoom},
    layers: [new BasemapLayer({id: 'basemap', mode: 'map', fetch, style})],
    _animate: true,
    onAfterRender: () => {
      const layerManager = (deck as any)?.layerManager;
      const layers = layerManager?.getLayers() || [];
      if (
        !onFrame ||
        layerManager?.needsUpdate() ||
        layers.length < 2 ||
        layers.some((l: any) => !l.isLoaded)
      ) {
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

function zoomTo(zoom: number, center: Center = ORIGIN): Promise<ImageData> {
  const frame = nextFrame();
  deck!.setProps({viewState: {...center, zoom}});
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

describe('zoom-dependent fill and line paint', () => {
  test('draws the same pixels as a fresh basemap after crossing style zoom steps', async () => {
    const first = await createDeck(4.45);
    // Across the 4.25 and 4 steps, the paint texture changes with the viewport zoom.
    const between = await zoomTo(4.2);
    const zoomed = await zoomTo(3.75);
    const fresh = await createDeck(3.75);
    // The paint differs at every step.
    expect(countDifferent(first, between)).toBeGreaterThan(1000);
    expect(countDifferent(between, fresh)).toBeGreaterThan(1000);
    expect(countDifferent(zoomed, fresh)).toBe(0);
    // Both draw the paint at the 3.75 step.
    const constant = await createDeck(3.75, STYLE_AT_3_75);
    expect(countDifferent(zoomed, constant)).toBe(0);
  }, 60_000);
});

/** Centers the viewport on a tile so its horizontal stroke crosses the center column. */
const TILE_CENTER = {
  longitude: 180 / 2 ** 15,
  latitude: -Math.atan(Math.sinh(Math.PI / 2 ** 15)) * 180 / Math.PI
};
/** A horizontal line with width and opacity stops supplied by its feature. */
const fetchStroke = async () => [{
  type: 'Feature',
  properties: {layerName: 'road', w0: 0, w1: 40, a0: 0.2, a1: 1},
  geometry: {type: 'LineString', coordinates: [[0.05, 0.501], [0.95, 0.501]]}
}];
/** A polygon with opacity stops supplied by its feature. */
const fetchFill = async () => [{
  type: 'Feature',
  properties: {layerName: 'road', a0: 0.2, a1: 1},
  geometry: {type: 'Polygon', coordinates: [ring(0.1, 0.1, 0.9, 0.9)]}
}];
/** A point at the viewport center with feature values for composite paint. */
const fetchCircle = async () => [{
  type: 'Feature',
  properties: {layerName: 'road', r0: 0, r1: 40, a0: 0.2, a1: 1},
  geometry: {type: 'Point', coordinates: [0.5, 0.5]}
}];
/** Both endpoints and two interior samples of a style zoom step. */
const sampleZooms = [15, 15.1, 15.2, 15.25];
/** Builds a zoom expression with stops that span four style zoom steps. */
const interpolateZoom = (at15: unknown, at16: unknown) =>
  ['interpolate', ['linear'], ['zoom'], 15, at15, 16, at16];

/** Captures the same map as it zooms through one style step. */
async function renderZooms(type: 'line' | 'fill' | 'circle', paint: Record<string, unknown>) {
  const style = makeStyle([{id: 'sample', type, 'source-layer': 'road', paint}]);
  const fetchers = {line: fetchStroke, fill: fetchFill, circle: fetchCircle};
  const images = [await createDeck(15, style, fetchers[type], TILE_CENTER)];
  for (const zoom of sampleZooms.slice(1)) {
    images.push(await zoomTo(zoom, TILE_CENTER));
  }
  return images;
}

/** The coverage of black paint on white in one pixel of the center column. */
function darkness(image: ImageData, y: number): number {
  return 1 - image.data[4 * (y * SIZE + SIZE / 2)] / 255;
}

/** Adds the paint coverage across the center column in pixels. */
function strokeWidth(image: ImageData): number {
  let width = 0;
  for (let y = 0; y < SIZE; y++) {
    width += darkness(image, y);
  }
  return width;
}

/** Checks that every sample increases and stays within tolerance of the continuous value. */
function expectContinuous(samples: number[], expected: number[], tolerance: number) {
  expect(samples[1]).toBeGreaterThan(samples[0]);
  expect(samples[2]).toBeGreaterThan(samples[1]);
  expect(samples[3]).toBeGreaterThan(samples[2]);
  samples.forEach((value, index) => expect(Math.abs(value - expected[index])).toBeLessThan(tolerance));
}

describe('continuous paint inside a style zoom step', () => {
  test.each([
    ['zoom-only', interpolateZoom(0, 40), {}, 0],
    ['composite from zero', interpolateZoom(['get', 'w0'], ['get', 'w1']), {}, 0],
    ['composite from positive width', interpolateZoom(['+', ['get', 'w0'], 4], ['+', ['get', 'w1'], 4]), {}, 4],
    ['dashed composite', interpolateZoom(['get', 'w0'], ['get', 'w1']), {'line-dasharray': [1000, 1]}, 0]
  ])('draws the %s line width in pixels', async (_, width, extraPaint, startWidth) => {
    const images = await renderZooms('line', {'line-color': '#000', 'line-width': width, ...extraPaint});
    expectContinuous(images.map(strokeWidth), [0, 4, 8, 10].map(width => width + startWidth), 0.75);
  });

  test.each<[string, 'line' | 'fill' | 'circle', Record<string, unknown>]>([
    ['line', 'line', {}],
    ['dashed line', 'line', {'line-dasharray': [1000, 1]}],
    ['fill', 'fill', {}],
    ['circle', 'circle', {}]
  ])('blends composite %s opacity', async (_, type, extraPaint) => {
    const opacity = interpolateZoom(['get', 'a0'], ['get', 'a1']);
    const paint = type === 'line'
      ? {'line-color': '#000', 'line-width': 12, 'line-opacity': opacity}
      : type === 'fill'
        ? {'fill-color': '#000', 'fill-antialias': false, 'fill-opacity': opacity}
        : {'circle-color': '#000', 'circle-radius': 16, 'circle-opacity': opacity};
    const images = await renderZooms(type, {...paint, ...extraPaint});
    expectContinuous(images.map(image => darkness(image, SIZE / 2)), [0.2, 0.28, 0.36, 0.4], 0.025);
  });

  test.each([
    ['zoom-only', interpolateZoom(0, 40), {}],
    ['composite', interpolateZoom(['get', 'r0'], ['get', 'r1']), {'circle-translate': [0, 4]}]
  ])('draws the %s circle radius in pixels', async (_, radius, extraPaint) => {
    const images = await renderZooms('circle', {'circle-color': '#000', 'circle-radius': radius, ...extraPaint});
    expectContinuous(images.map(image => strokeWidth(image) / 2), [0, 4, 8, 10], 0.75);
  });

  test('puts the continuous stroke outside the circle and blurs it with the fill', async () => {
    const paint = {
      'circle-color': '#ffffff',
      'circle-radius': 8,
      'circle-stroke-width': interpolateZoom(0, 40),
      'circle-stroke-color': interpolateZoom('#000000', '#ff0000'),
      'circle-stroke-opacity': interpolateZoom(1, 0),
      'circle-blur': 0.25
    };
    const images = await renderZooms('circle', paint);
    const style = makeStyle([{id: 'sample', type: 'circle', 'source-layer': 'road', paint: {
      ...paint, 'circle-stroke-width': 8, 'circle-stroke-color': 'rgb(51, 0, 0)', 'circle-stroke-opacity': 0.8
    }}]);
    const constant = await createDeck(15.2, style, fetchCircle, TILE_CENTER);
    expectContinuous(images.map(strokeWidth), [0, 4, 9, 10], 3);
    expect(countDifferent(images[2], constant)).toBe(0);
  });
});
