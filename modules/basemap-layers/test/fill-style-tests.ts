// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

// deck.gl-community
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {MapView, _GlobeView as GlobeView, type View} from '@deck.gl/core';
import {describe, expect, test} from 'vitest';
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
  });
}
