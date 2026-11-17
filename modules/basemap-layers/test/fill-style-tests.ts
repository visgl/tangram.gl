// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

// deck.gl-community
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {MapView, _GlobeView as GlobeView, type View} from '@deck.gl/core';
import {describe, expect, test} from 'vitest';
import {getPatternAtlas} from '../src/fill-pattern';
import {getBasemapLayers} from '../src/index';
import type {SpriteAtlas} from '../src/sprite';
import {type BackendPaintTestOptions, createBackendRenderer, pixel, SIZE} from './backend-paint-tests';

/**
 * The tests of `fill-pattern` and `fill-translate`, for one GPU backend. The browser suite of this
 * module runs them on WebGL, and the rendering suite on WebGL and WebGPU.
 */

export const CENTER = SIZE / 2;

/**
 * A sprite with `quadrants`: an image split into red (top left), blue (top right), green (bottom
 * left) and black (bottom right) squares of `cell` atlas pixels, at `pixelRatio`.
 */
export async function createQuadrantSprite(cell: number, pixelRatio = 1): Promise<SpriteAtlas> {
  const size = cell * 2;
  const canvas = new OffscreenCanvas(size, size);
  const context = canvas.getContext('2d')!;
  for (const [x, y, color] of [
    [0, 0, 'rgb(255, 0, 0)'],
    [cell, 0, 'rgb(0, 0, 255)'],
    [0, cell, 'rgb(0, 255, 0)'],
    [cell, cell, 'rgb(0, 0, 0)']
  ] as const) {
    context.fillStyle = color;
    context.fillRect(x, y, cell, cell);
  }
  return {
    id: 'default',
    image: await createImageBitmap(canvas),
    mapping: {
      quadrants: {
        x: 0,
        y: 0,
        width: size,
        height: size,
        mask: false,
        pixelRatio
      }
    }
  };
}

/** A polygon from `west` to `east` and `south` to `north`, in degrees. */
export function box(west: number, south: number, east: number, north: number) {
  return {
    type: 'Feature',
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [west, south],
          [east, south],
          [east, north],
          [west, north],
          [west, south]
        ]
      ]
    },
    properties: {}
  };
}

/** The sublayers that a fill style layer draws for one tile of `features`. */
export function fillTile(
  paint: Record<string, unknown>,
  features: unknown[],
  {
    zoom,
    mode = 'map',
    spriteAtlases = []
  }: {zoom: number; mode?: 'map' | 'globe'; spriteAtlases?: SpriteAtlas[]}
) {
  const layers = getBasemapLayers({
    idPrefix: 'test',
    mode,
    zoom,
    spriteAtlases,
    styleDefinition: {
      version: 8,
      sources: {
        tiles: {
          type: 'vector',
          tiles: ['https://tiles.example.com/{z}/{x}/{y}.mvt']
        }
      },
      layers: [{id: 'fill', type: 'fill', source: 'tiles', paint}]
    } as any
  });
  const vectorLayer: any = layers.find(layer => layer.id === 'test-tiles');
  // The props that the tile layer passes to each tile.
  return vectorLayer.props.renderSubLayers({
    pickable: false,
    visible: true,
    opacity: 1,
    modelMatrix: null,
    coordinateSystem: 'default',
    coordinateOrigin: [0, 0, 0],
    extensions: [],
    highlightedObjectIndex: -1,
    highlightColor: [0, 0, 128, 128],
    wrapLongitude: false,
    id: 'test-tiles-tile',
    data: features,
    tile: {index: {x: 0, y: 0, z: Math.floor(zoom)}}
  });
}

const RED = [255, 0, 0];
const BLUE = [0, 0, 255];
const GREEN = [0, 255, 0];
const BLACK = [0, 0, 0];
const WHITE = [255, 255, 255];

function expectPatternColor(actual: number[], expected: number[], tolerance = 8) {
  for (let i = 0; i < 3; i++) {
    expect(Math.abs(actual[i] - expected[i]), `${actual} vs ${expected}`).toBeLessThanOrEqual(
      tolerance
    );
  }
}

/**
 * Checks that the quadrant pattern repeats every `period` screen pixels in x and y from the
 * canvas center, which lies on a corner of the pattern: the world origin is at the canvas center,
 * and the pattern is anchored to it.
 */
function expectQuadrants(image: ImageData, period: number) {
  const quarter = Math.floor(period / 4);
  const at = (cellX: number, cellY: number) =>
    pixel(
      image,
      Math.floor(CENTER + cellX * period + quarter),
      Math.floor(CENTER + cellY * period + quarter)
    );
  const atRight = (cellX: number, cellY: number) =>
    pixel(
      image,
      Math.floor(CENTER + cellX * period + period / 2 + quarter),
      Math.floor(CENTER + cellY * period + quarter)
    );
  const atBottom = (cellX: number, cellY: number) =>
    pixel(
      image,
      Math.floor(CENTER + cellX * period + quarter),
      Math.floor(CENTER + cellY * period + period / 2 + quarter)
    );
  for (const [cellX, cellY] of [
    [0, 0],
    [1, 0],
    [-1, 1],
    [-2, -2]
  ]) {
    expectPatternColor(at(cellX, cellY), RED);
    expectPatternColor(atRight(cellX, cellY), BLUE);
    expectPatternColor(atBottom(cellX, cellY), GREEN);
  }
}

/**
 * Checks the quadrant pattern's edges to the pixel, on the center row of the top quadrants: the
 * first and last pixel of each red and blue cell.
 */
function expectQuadrantEdges(image: ImageData, period: number) {
  const half = period / 2;
  const y = CENTER + Math.floor(half / 2);
  for (const cell of [-2, -1, 0, 1]) {
    const x = CENTER + cell * period;
    expectPatternColor(pixel(image, x, y), RED);
    expectPatternColor(pixel(image, x + half - 1, y), RED);
    expectPatternColor(pixel(image, x + half, y), BLUE);
    expectPatternColor(pixel(image, x + period - 1, y), BLUE);
  }
}

const WORLD = [box(-170, -80, 170, 80)];

/** Registers the `fill-pattern` and `fill-translate` tests for one GPU backend. */
export function defineFillStyleTests(options: BackendPaintTestOptions): void {
  const {deviceType} = options;
  const draw = createBackendRenderer(options);
  /** Renders layers centered at longitude/latitude 0, 0. */
  const render = (
    layers: unknown,
    viewState: {zoom: number; [key: string]: number},
    view: View = new MapView({id: 'fill-test'})
  ) =>
    draw([layers], {
      view,
      viewState: {longitude: 0, latitude: 0, bearing: 0, pitch: 0, ...viewState}
    });

  describe(`${deviceType}: fill-pattern`, () => {
    test('repeats the image at its CSS-pixel size, anchored to the world', async () => {
      const sprite = await createQuadrantSprite(8);
      const image = await render(
        fillTile({'fill-pattern': 'quadrants'}, WORLD, {
          zoom: 5,
          spriteAtlases: [sprite]
        }),
        {zoom: 5}
      );
      expectQuadrants(image, 16);
      expectQuadrantEdges(image, 16);
    });

    test('stays anchored to the world at a high zoom far from the origin', async () => {
      const zoom = 21;
      const worldSize = 512 * 2 ** zoom;
      // A center on a corner of the 16 px pattern: a whole number of patterns from the world's
      // top left corner.
      const x = 16 * 40_000_001;
      const y = 16 * 25_000_003;
      const longitude = (x / worldSize) * 360 - 180;
      const latitude = (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / worldSize))) * 180) / Math.PI;
      const sprite = await createQuadrantSprite(8, 1);
      // A sprite with other images too, of sizes whose least common multiple is large.
      for (let size = 7; size < 60; size++) {
        sprite.mapping[`icon-${size}`] = {
          x: 0,
          y: 0,
          width: size,
          height: size,
          mask: false,
          pixelRatio: 1
        };
      }
      const delta = 0.0001;
      const image = await render(
        fillTile(
          {'fill-pattern': 'quadrants'},
          [box(longitude - delta, latitude - delta, longitude + delta, latitude + delta)],
          {zoom, spriteAtlases: [sprite]}
        ),
        {zoom, longitude, latitude}
      );
      expectQuadrants(image, 16);
      expectQuadrantEdges(image, 16);
    });

    test('draws no seam where the sprite packs another image next to the pattern', async () => {
      // A red image with black images packed against its right and bottom edges.
      const canvas = new OffscreenCanvas(16, 16);
      const context = canvas.getContext('2d')!;
      context.fillStyle = 'rgb(0, 0, 0)';
      context.fillRect(0, 0, 16, 16);
      context.fillStyle = 'rgb(255, 0, 0)';
      context.fillRect(0, 0, 8, 8);
      const sprite: SpriteAtlas = {
        id: 'default',
        image: await createImageBitmap(canvas),
        mapping: {red: {x: 0, y: 0, width: 8, height: 8, mask: false, pixelRatio: 1}}
      };
      // Half a pixel off the pattern grid, so that pixels sample the pattern between two texels.
      const zoom = 5;
      const worldSize = 512 * 2 ** zoom;
      const longitude = ((worldSize / 2 + 0.5) / worldSize) * 360 - 180;
      const image = await render(
        fillTile({'fill-pattern': 'red'}, WORLD, {zoom, spriteAtlases: [sprite]}),
        {zoom, longitude, latitude: 0}
      );
      for (let x = CENTER - 16; x < CENTER + 16; x++) {
        for (const y of [CENTER - 5, CENTER, CENTER + 3]) {
          expectPatternColor(pixel(image, x, y), RED);
        }
      }
    });

    test('draws one of many large images, packed within the texture size limit', async () => {
      // 128 images of 128 x 128 pixels: in one row, with their borders, 16,640 pixels wide.
      const canvas = new OffscreenCanvas(2048, 1024);
      const context = canvas.getContext('2d')!;
      context.fillStyle = 'rgb(0, 0, 255)';
      context.fillRect(0, 0, 2048, 1024);
      context.fillStyle = 'rgb(255, 0, 0)';
      context.fillRect(1920, 896, 128, 128);
      const mapping: SpriteAtlas['mapping'] = {};
      for (let index = 0; index < 128; index++) {
        const [x, y] = [(index % 16) * 128, Math.floor(index / 16) * 128];
        mapping[`image-${index}`] = {x, y, width: 128, height: 128, mask: false, pixelRatio: 1};
      }
      const sprite: SpriteAtlas = {id: 'default', image: await createImageBitmap(canvas), mapping};
      // Every image is used by a feature off screen; the last, red, one fills the canvas.
      const features = [
        ...Array.from({length: 127}, (_, index) => ({
          ...box(100, 10, 101, 11),
          properties: {pattern: `image-${index}`}
        })),
        {...box(-170, -80, 170, 80), properties: {pattern: 'image-127'}}
      ];
      const image = await render(
        fillTile({'fill-pattern': ['get', 'pattern']}, features, {zoom: 5, spriteAtlases: [sprite]}),
        {zoom: 5}
      );
      expectPatternColor(pixel(image, CENTER, CENTER), RED);
      expectPatternColor(pixel(image, 10, 100), RED);
    });

    test('a missing image draws its outline but no fill, beside an image that is drawn', async () => {
      const sprite = await createQuadrantSprite(8);
      // The east half has no image; a polygon far away has one.
      const features = [
        {...box(0, -80, 170, 80), properties: {pattern: 'missing'}},
        {...box(100, 10, 101, 11), properties: {pattern: 'quadrants'}}
      ];
      const image = await render(
        fillTile(
          {
            'fill-pattern': ['get', 'pattern'],
            'fill-outline-color': '#000000',
            'fill-color': '#ff0000'
          },
          features,
          {zoom: 5, spriteAtlases: [sprite]}
        ),
        {zoom: 5}
      );
      // The west edge of the east half is outlined at the canvas center; inside, nothing is drawn.
      const edge = [CENTER - 1, CENTER, CENTER + 1].flatMap(x => pixel(image, x, CENTER - 20));
      expect(Math.min(...edge)).toBeLessThan(160);
      expectPatternColor(pixel(image, CENTER + 20, CENTER), WHITE, 0);
    });

    test('divides the image size by its pixel ratio', async () => {
      const sprite = await createQuadrantSprite(8, 2);
      const image = await render(
        fillTile({'fill-pattern': 'quadrants'}, WORLD, {
          zoom: 5,
          spriteAtlases: [sprite]
        }),
        {zoom: 5}
      );
      expectQuadrants(image, 8);
      expectQuadrantEdges(image, 8);
    });

    test('scales with the map from the integer zoom, as MapLibre GL JS does', async () => {
      const sprite = await createQuadrantSprite(8);
      // At zoom 6.5 the pattern sized at zoom 6 has grown by 2 ** 0.5, to 22.6 pixels.
      const image = await render(
        fillTile({'fill-pattern': 'quadrants'}, WORLD, {
          zoom: 6.5,
          spriteAtlases: [sprite]
        }),
        {zoom: 6.5}
      );
      const period = 16 * 2 ** 0.5;
      expectPatternColor(pixel(image, CENTER + 3, CENTER + 3), RED);
      expectPatternColor(pixel(image, CENTER + Math.floor(period / 2) + 3, CENTER + 3), BLUE);
      expectPatternColor(pixel(image, CENTER + Math.floor(period) + 3, CENTER + 3), RED);
      expectPatternColor(pixel(image, CENTER + 3, CENTER + Math.floor(period / 2) + 3), GREEN);
      expectPatternColor(pixel(image, CENTER + Math.floor(period / 2) + 3, CENTER + 14), BLACK);
    });

    // luma.gl uploads an image to a texture of a software WebGPU adapter (headless Chromium's
    // SwiftShader) through a 2D canvas, which keeps no color for transparent pixels. A GPU adapter
    // copies the image as is.
    test.skipIf(deviceType === 'webgpu')(
      'a light pattern on transparent pixels draws no dark edges where it is scaled',
      async () => {
        // White columns 3 atlas pixels wide on transparent ones, at zoom 6.5, where the pattern sized at
        // zoom 6 is filtered at 2 ** 0.5 times its size. On a white background every pixel stays white,
        // as with MapLibre's premultiplied atlas; transparent black would darken the columns' edges.
        const canvas = new OffscreenCanvas(8, 8);
        const context = canvas.getContext('2d')!;
        context.fillStyle = 'rgb(255, 255, 255)';
        context.fillRect(0, 0, 3, 8);
        const sprite: SpriteAtlas = {
          id: 'default',
          image: await createImageBitmap(canvas),
          mapping: {stripes: {x: 0, y: 0, width: 8, height: 8, mask: false, pixelRatio: 1}}
        };
        const image = await render(
          fillTile({'fill-pattern': 'stripes'}, WORLD, {zoom: 6.5, spriteAtlases: [sprite]}),
          {zoom: 6.5}
        );
        let darkest = 255;
        for (let y = 8; y < SIZE - 8; y++) {
          for (let x = 8; x < SIZE - 8; x++) {
            darkest = Math.min(darkest, ...pixel(image, x, y));
          }
        }
        expect(darkest).toBeGreaterThanOrEqual(250);
      }
    );

    test('a pattern takes no color from the pattern packed next to it', async () => {
      // A 4x4 image whose first column is transparent and the rest white, and an opaque red one.
      const canvas = new OffscreenCanvas(8, 4);
      const context = canvas.getContext('2d')!;
      context.fillStyle = 'rgb(255, 255, 255)';
      context.fillRect(1, 0, 3, 4);
      context.fillStyle = 'rgb(255, 0, 0)';
      context.fillRect(4, 0, 4, 4);
      const sprite: SpriteAtlas = {
        id: 'default',
        image: await createImageBitmap(canvas),
        mapping: {
          white: {x: 0, y: 0, width: 4, height: 4, mask: false, pixelRatio: 1},
          red: {x: 4, y: 0, width: 4, height: 4, mask: false, pixelRatio: 1}
        }
      };
      const {image, mapping} = getPatternAtlas(sprite, ['white', 'red']) as any;
      const {x, y} = mapping.white;
      // Every transparent pixel of the white image and its border has no red in it.
      for (let row = y - 1; row <= y + 4; row++) {
        for (let column = x - 1; column <= x + 4; column++) {
          const i = (row * image.width + column) * 4;
          if (image.data[i + 3] === 0) {
            expect([...image.data.slice(i, i + 3)], `${column}, ${row}`).not.toEqual([255, 0, 0]);
            expect(image.data[i + 1], `${column}, ${row}`).toBe(image.data[i]);
          }
        }
      }
    });

    test('fill-opacity applies to the pattern', async () => {
      const sprite = await createQuadrantSprite(8);
      const image = await render(
        fillTile({'fill-pattern': 'quadrants', 'fill-opacity': 0.5}, WORLD, {
          zoom: 5,
          spriteAtlases: [sprite]
        }),
        {zoom: 5}
      );
      expectPatternColor(pixel(image, CENTER + 4, CENTER + 4), [255, 128, 128]);
    });

    test('an image missing from the sprite draws nothing', async () => {
      const sprite = await createQuadrantSprite(8);
      // A fill that draws nothing, and has no outline, has no sublayer to render.
      const layers = fillTile({'fill-pattern': 'missing', 'fill-color': '#ff0000'}, WORLD, {
        zoom: 5,
        spriteAtlases: [sprite]
      });
      expect([layers].flat(Infinity).filter(Boolean)).toEqual([]);
    });

    test('keeps its size and shape on a globe', async () => {
      const sprite = await createQuadrantSprite(8);
      const image = await render(
        fillTile({'fill-pattern': 'quadrants'}, [box(-20, -20, 20, 20)], {
          zoom: 5,
          mode: 'globe',
          spriteAtlases: [sprite]
        }),
        {zoom: 5},
        new GlobeView({resolution: 36, id: 'fill-globe-test'})
      );
      expectQuadrants(image, 16);
    });
  });

  describe(`${deviceType}: fill-translate`, () => {
    /** The first x from the left, on the center row, that is not white. */
    function leftEdge(image: ImageData) {
      for (let x = 0; x < SIZE; x++) {
        if (pixel(image, x, CENTER).some(channel => channel < 128)) {
          return x;
        }
      }
      return -1;
    }

    /** The first y from the top, on the center column, that is not white. */
    function topEdge(image: ImageData) {
      for (let y = 0; y < SIZE; y++) {
        if (pixel(image, CENTER, y).some(channel => channel < 128)) {
          return y;
        }
      }
      return -1;
    }

    // The east half of the world: its west edge is at the canvas center.
    const EAST = [box(0, -80, 170, 80)];

    test('offsets a fill by fill-translate pixels', async () => {
      const plain = leftEdge(
        await render(fillTile({'fill-color': '#000000'}, EAST, {zoom: 5}), {zoom: 5})
      );
      // WebGPU's rasterizer can place the edge on either pixel next to the canvas center.
      expect(Math.abs(plain - CENTER)).toBeLessThanOrEqual(1);
      const translated = await render(
        fillTile({'fill-color': '#000000', 'fill-translate': [10, 0]}, EAST, {
          zoom: 5
        }),
        {zoom: 5}
      );
      expect(leftEdge(translated)).toBe(plain + 10);
    });

    test('moves the outline with the fill', async () => {
      const image = await render(
        fillTile(
          {
            'fill-color': '#ffffff',
            'fill-outline-color': '#000000',
            'fill-translate': [10, 0]
          },
          EAST,
          {zoom: 5}
        ),
        {zoom: 5}
      );
      expect(Math.abs(leftEdge(image) - (CENTER + 10))).toBeLessThanOrEqual(1);
    });

    test('a map anchor turns with the map, a viewport anchor stays on screen', async () => {
      // With the map turned 90 degrees, east points up and south to the right on screen: the
      // south half of the world lies right of the canvas center.
      const SOUTH = [box(-170, -80, 170, 0)];
      const viewState = {zoom: 5, bearing: 90};
      const plain = leftEdge(
        await render(fillTile({'fill-color': '#000000'}, SOUTH, {zoom: 5}), viewState)
      );
      expect(Math.abs(plain - CENTER)).toBeLessThanOrEqual(1);
      // A map-anchored offset of 10 px south moves the fill 10 px to the right on screen.
      const map = await render(
        fillTile({'fill-color': '#000000', 'fill-translate': [0, 10]}, SOUTH, {
          zoom: 5
        }),
        viewState
      );
      expect(leftEdge(map)).toBe(plain + 10);
      // A viewport-anchored offset of 10 px down moves it along its edge, which stays put.
      const viewport = await render(
        fillTile(
          {
            'fill-color': '#000000',
            'fill-translate': [0, 10],
            'fill-translate-anchor': 'viewport'
          },
          SOUTH,
          {zoom: 5}
        ),
        viewState
      );
      expect(leftEdge(viewport)).toBe(plain);
    });

    test('offsets a fill on a globe', async () => {
      const view = new GlobeView({resolution: 36, id: 'translate-globe-test'});
      const SOUTH = [box(-20, -20, 20, 0)];
      const plain = await render(
        fillTile({'fill-color': '#000000'}, SOUTH, {zoom: 5, mode: 'globe'}),
        {zoom: 5},
        view
      );
      const plainTop = topEdge(plain);
      expect(Math.abs(plainTop - CENTER)).toBeLessThanOrEqual(1);
      const translated = await render(
        fillTile({'fill-color': '#000000', 'fill-translate': [0, 10]}, SOUTH, {
          zoom: 5,
          mode: 'globe'
        }),
        {zoom: 5},
        view
      );
      expect(Math.abs(topEdge(translated) - (plainTop + 10))).toBeLessThanOrEqual(1);
    });

    test('moves the pattern with the fill on a map', async () => {
      const sprite = await createQuadrantSprite(8);
      // Half a pattern right: the blue cell is where the red one was.
      const image = await render(
        fillTile({'fill-pattern': 'quadrants', 'fill-translate': [8, 0]}, WORLD, {
          zoom: 5,
          spriteAtlases: [sprite]
        }),
        {zoom: 5}
      );
      expectPatternColor(pixel(image, CENTER + 4, CENTER + 4), BLUE);
      expectPatternColor(pixel(image, CENTER + 12, CENTER + 4), RED);
      expectPatternColor(pixel(image, CENTER + 4, CENTER + 12), BLACK);
    });
  });
}
