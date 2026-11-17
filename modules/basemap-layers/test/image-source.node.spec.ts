// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/* eslint-disable import/no-extraneous-dependencies */
import {describe, expect, test} from 'vitest';
import {getBasemapLayers} from '../src/index.ts';
import {getStyleLayerRuns} from '../src/globe-layers.ts';
import {
  createImageMesh,
  getImageSourceBounds,
  getImageSourceCorners,
  getImageWarp,
  hasFlippedWinding,
  warpImagePoint,
  type ImageSourceCorners
} from '../src/image-source-layer.ts';
import {lngLatToMercatorWorld} from '../src/projected-viewport.ts';
import {RASTER_COLOR_BLEND_PARAMETERS} from '../src/raster-color-extension.ts';
import {resolveBasemapStyle} from '../src/style-resolver.ts';

const IMAGE_URL = 'https://images.example.com/quadrants.png';

/** Top left, top right, bottom right and bottom left, as the style specification lists them. */
const SKEWED: ImageSourceCorners = [
  [-1, 1.2],
  [1.4, 1],
  [1, -1],
  [-1.2, -0.8]
];

function getImageStyle(source: Record<string, unknown>, paint?: Record<string, unknown>): any {
  return {
    version: 8,
    sources: {overlay: {type: 'image', url: IMAGE_URL, coordinates: SKEWED, ...source}},
    layers: [{id: 'overlay', type: 'raster', source: 'overlay', ...(paint ? {paint} : {})}]
  };
}

function getImageLayer(
  source: Record<string, unknown> = {},
  paint?: Record<string, unknown>,
  mode: 'map' | 'globe' = 'map'
) {
  const layers = getBasemapLayers({
    idPrefix: 'test',
    mode,
    zoom: 5,
    styleDefinition: getImageStyle(source, paint)
  });
  return layers.find((layer: any) => layer.id === 'test-overlay') as any;
}

/** The bitmap layer an image layer draws, on a device of `deviceType`. */
function renderImage(imageLayer: any, deviceType = 'webgl'): any {
  imageLayer.context = {device: {type: deviceType}};
  imageLayer.internalState = {};
  const [bitmap] = [imageLayer.renderLayers()].flat();
  return bitmap;
}

describe('image source coordinates', () => {
  test('takes four [longitude, latitude] corners', () => {
    expect(getImageSourceCorners({type: 'image', coordinates: SKEWED})).toEqual(SKEWED);
  });

  test.each([
    ['missing', undefined],
    ['not an array', 'corners'],
    ['three corners', SKEWED.slice(0, 3)],
    ['five corners', [...SKEWED, SKEWED[0]]],
    ['a corner with one number', [[0], ...SKEWED.slice(1)]],
    ['a corner with three numbers', [[0, 0, 0], ...SKEWED.slice(1)]],
    ['a corner that is not a number', [['0', 0], ...SKEWED.slice(1)]],
    ['a corner that is not finite', [[Number.NaN, 0], ...SKEWED.slice(1)]]
  ])('rejects coordinates that are %s', (_, coordinates) => {
    expect(getImageSourceCorners({type: 'image', coordinates})).toBeNull();
  });

  test('turns the corners into the bounds of a bitmap layer: bottom left first, counterclockwise', () => {
    const [topLeft, topRight, bottomRight, bottomLeft] = SKEWED;
    expect(getImageSourceBounds(SKEWED)).toEqual([bottomLeft, topLeft, topRight, bottomRight]);
  });
});

/** Where the lines from `a` to `b` and from `c` to `d` cross. */
function intersect(a: number[], b: number[], c: number[], d: number[]): number[] {
  const denominator = (a[0] - b[0]) * (c[1] - d[1]) - (a[1] - b[1]) * (c[0] - d[0]);
  const s = ((a[0] - c[0]) * (c[1] - d[1]) - (a[1] - c[1]) * (c[0] - d[0])) / denominator;
  return [a[0] + s * (b[0] - a[0]), a[1] + s * (b[1] - a[1])];
}

describe('image warp', () => {
  const world = SKEWED.map(corner => lngLatToMercatorWorld(corner));

  test('a rectangle, or any parallelogram, is mapped affinely with one cell', () => {
    const rectangle: any = [
      [-1, 1],
      [1, 1],
      [1, -1],
      [-1, -1]
    ];
    expect(getImageWarp(rectangle)).toEqual([0, 0, 1]);
    expect(createImageMesh(rectangle).vertexCount).toBe(6);
    const parallelogram: any = [
      [-1, 1],
      [1.5, 1],
      [1, -1],
      [-1.5, -1]
    ];
    expect(getImageWarp(parallelogram)).toEqual([0, 0, 1]);
  });

  test('a skewed quad is warped as a perspective view, as MapLibre warps it', () => {
    const warp = getImageWarp(SKEWED);
    expect(warp[2]).toBe(0);
    expect(warp[0]).not.toBe(0);
    // Each corner of the image lands on its corner.
    const [topLeft, topRight, bottomRight, bottomLeft] = world;
    for (const [u, v, corner] of [
      [0, 0, topLeft],
      [1, 0, topRight],
      [1, 1, bottomRight],
      [0, 1, bottomLeft]
    ] as const) {
      const point = warpImagePoint(world, warp, u, v);
      expect(point[0]).toBeCloseTo(corner[0], 9);
      expect(point[1]).toBeCloseTo(corner[1], 9);
    }
    // A perspective view keeps lines straight: the image's center lands where the diagonals cross.
    const center = warpImagePoint(world, warp, 0.5, 0.5);
    const crossing = intersect(topLeft, bottomRight, topRight, bottomLeft);
    expect(center[0]).toBeCloseTo(crossing[0], 9);
    expect(center[1]).toBeCloseTo(crossing[1], 9);
  });

  test('a quad with no perspective view is warped bilinearly', () => {
    const [topLeft, topRight, bottomRight] = SKEWED;
    // The bottom left corner inside the triangle of the others: a concave quad.
    const concave: any = [topLeft, topRight, bottomRight, [0.2, 0.3]];
    expect(getImageWarp(concave)).toEqual([0, 0, 1]);
  });

  test('a strongly foreshortened quad blends towards the bilinear warp', () => {
    const [topLeft, topRight] = SKEWED;
    // The bottom edge is far shorter than the top one.
    const blend = getImageWarp([topLeft, topRight, [0.02, -1], [-0.02, -1]] as any)[2];
    expect(blend).toBeGreaterThan(0);
    expect(blend).toBeLessThan(1);
  });

  test('the mesh of a skewed quad follows the warp, with the image uniform in Web Mercator', () => {
    const mesh = createImageMesh(SKEWED);
    const warp = getImageWarp(SKEWED);
    const vertexCount = mesh.positions.length / 3;
    expect(mesh.vertexCount).toBeGreaterThan(6);
    for (let vertex = 0; vertex < vertexCount; vertex += 37) {
      const [u, v] = mesh.texCoords.subarray(vertex * 2, vertex * 2 + 2);
      const expected = warpImagePoint(world, warp, u, v);
      const actual = lngLatToMercatorWorld(mesh.positions.subarray(vertex * 3, vertex * 3 + 2));
      expect(actual[0]).toBeCloseTo(expected[0], 6);
      expect(actual[1]).toBeCloseTo(expected[1], 6);
    }
  });
});

describe('image source layers', () => {
  test('a raster layer over an image source draws in style order', () => {
    const style = getImageStyle({});
    style.layers.unshift({id: 'background', type: 'background'});
    const runs = getStyleLayerRuns(style.layers, style);
    expect(runs.map(run => [run.type, run.id])).toEqual([
      ['background', 'background'],
      ['raster', 'overlay']
    ]);
  });

  test.each([
    ['without a url', {url: undefined}],
    ['with an empty url', {url: ''}],
    ['without coordinates', {coordinates: undefined}],
    ['with three corners', {coordinates: SKEWED.slice(0, 3)}]
  ])('a source %s is skipped', (_, source) => {
    expect(getImageLayer(source)).toBeUndefined();
  });

  test('draws the image at its corners', () => {
    const imageLayer = getImageLayer();
    expect(imageLayer.props.image).toBe(IMAGE_URL);
    expect(imageLayer.props.corners).toEqual(SKEWED);
    const bitmap = renderImage(imageLayer);
    // `image` is an async prop: the layer loads the URL it was given.
    expect(bitmap.props[Symbol.for('asyncPropOriginal')].image).toBe(IMAGE_URL);
    expect(bitmap.props.bounds).toEqual(getImageSourceBounds(SKEWED));
  });

  test('takes raster-opacity, as raster tiles do', () => {
    expect(getImageLayer({}, {'raster-opacity': 0.4}).props.opacity ** (1 / 2.2)).toBeCloseTo(
      0.4,
      10
    );
    expect(getImageLayer().props.opacity).toBe(1);
  });

  test('takes the raster color adjustments, with premultiplied blending on WebGL only', () => {
    const plain = getImageLayer();
    expect(plain.props.extensions).toEqual([]);
    expect(renderImage(plain).props.parameters).not.toMatchObject(RASTER_COLOR_BLEND_PARAMETERS);

    const paint = {
      'raster-brightness-min': 0.1,
      'raster-brightness-max': 0.9,
      'raster-saturation': -0.5,
      'raster-contrast': 0.3,
      'raster-hue-rotate': 90
    };
    const adjusted = getImageLayer({}, paint);
    expect(adjusted.props.extensions.map((extension: any) => extension.constructor.name)).toEqual([
      'RasterColorExtension'
    ]);
    expect(adjusted.props.rasterColorAdjustments).toEqual({
      brightnessMin: 0.1,
      brightnessMax: 0.9,
      saturation: -0.5,
      contrast: 0.3,
      hueRotate: 90
    });
    expect(renderImage(adjusted).props.parameters).toMatchObject(RASTER_COLOR_BLEND_PARAMETERS);
    expect(renderImage(adjusted, 'webgpu').props.parameters).not.toMatchObject(
      RASTER_COLOR_BLEND_PARAMETERS
    );
  });

  test.each(['raster-resampling', 'resampling'])('%s: nearest magnifies with the nearest texel', property => {
    const nearest = renderImage(getImageLayer({}, {[property]: 'nearest'}));
    expect(nearest.props.textureParameters).toMatchObject({magFilter: 'nearest'});
    expect(renderImage(getImageLayer()).props.textureParameters).toBeNull();
  });
});

describe('image source winding', () => {
  const [topLeft, topRight, bottomRight, bottomLeft] = SKEWED;
  const MIRRORED = [topRight, topLeft, bottomLeft, bottomRight];

  test('corners listed clockwise on the map keep their winding', () => {
    expect(hasFlippedWinding(SKEWED)).toBe(false);
    expect(hasFlippedWinding(MIRRORED as any)).toBe(true);
  });

  test('a globe culls the front faces of a mirrored image, and the back faces of others', () => {
    expect(getImageLayer({}, undefined, 'globe').props.parameters.cullMode).toBe('back');
    expect(
      getImageLayer({coordinates: MIRRORED}, undefined, 'globe').props.parameters.cullMode
    ).toBe('front');
    expect(getImageLayer({coordinates: MIRRORED}).props.parameters.cullMode).toBe('none');
  });
});

describe('image source loading', () => {
  test('the url resolves against the style url, and is not fetched as TileJSON', async () => {
    const requested: string[] = [];
    const fetch = (async (url: string) => {
      requested.push(url);
      return {ok: true, status: 200, json: async () => getImageStyle({url: 'overlay.png'})};
    }) as unknown as typeof globalThis.fetch;
    const style = await resolveBasemapStyle('https://styles.example.com/v1/style.json', {fetch});
    expect(requested).toEqual(['https://styles.example.com/v1/style.json']);
    expect(style.sources.overlay.url).toBe('https://styles.example.com/v1/overlay.png');
    expect(style.sources.overlay.coordinates).toEqual(SKEWED);
  });
});
