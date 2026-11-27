// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {Deck, MapView} from '@deck.gl/core';
import {webgl2Adapter} from '@luma.gl/core/webgl';
import {afterEach, describe, expect, test} from 'vitest';
import {
  BasemapLayer,
  createRasterTileFingerprintFilter,
  getRasterTileFingerprint
} from '../src/index';
import {createStableFrameWait} from './stable-frame';

const SIZE = 128;
const TILE_SIZE = 512;
/** The color of the placeholder image that the test service returns where it has no data. */
const PLACEHOLDER_COLOR = [255, 0, 255];
/** The lowest zoom at which the test service returns the placeholder. */
const PLACEHOLDER_ZOOM = 2;

let deck: Deck<any> | null = null;
let parent: HTMLDivElement | null = null;
// The imagery tile layer draws a bitmap for each of the 4 tiles.
const stableFrames = createStableFrameWait({
  getDeck: () => deck,
  width: SIZE,
  isReady: current => {
    const all = (current as any).layerManager.getLayers();
    return (
      all.some((layer: any) => layer.id === 'basemap-imagery') &&
      all.filter((layer: any) => layer.id.startsWith('basemap-imagery-')).length >= 4
    );
  }
});

afterEach(() => {
  deck?.finalize();
  deck = null;
  stableFrames.cancel();
  parent?.remove();
  parent = null;
});

/** The color of the area of the zoom 2 tile `x`, `y`, at any zoom that has data. */
function getAreaColor(x: number, y: number): number[] {
  return [30 + 60 * x, 30 + 60 * y, 0];
}

/** A PNG of `columns` by `rows` cells, each filled with the color `getColor` returns. */
async function createPng(
  columns: number,
  rows: number,
  getColor: (column: number, row: number) => number[]
): Promise<ArrayBuffer> {
  const canvas = new OffscreenCanvas(TILE_SIZE, TILE_SIZE);
  const context = canvas.getContext('2d')!;
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const [r, g, b] = getColor(column, row);
      context.fillStyle = `rgb(${r}, ${g}, ${b})`;
      context.fillRect(
        (column * TILE_SIZE) / columns,
        (row * TILE_SIZE) / rows,
        TILE_SIZE / columns,
        TILE_SIZE / rows
      );
    }
  }
  return (await canvas.convertToBlob({type: 'image/png'})).arrayBuffer();
}

/**
 * A tile service with data at zooms 0 and 1 only. From zoom 2 it returns one placeholder image
 * with status 200. A tile with data shows the color of each zoom 2 tile area it covers.
 */
async function createTileService() {
  const placeholder = await createPng(1, 1, () => PLACEHOLDER_COLOR);
  const requests: string[] = [];
  const fetchTile = (async (url: string | URL | Request) => {
    requests.push(String(url));
    const [z, x, y] = String(url).split('/').slice(-3).map(Number);
    if (z >= PLACEHOLDER_ZOOM) {
      return new Response(placeholder.slice(0), {headers: {'Content-Type': 'image/png'}});
    }
    const cells = 2 ** (PLACEHOLDER_ZOOM - z);
    const png = await createPng(cells, cells, (column, row) =>
      getAreaColor(x * cells + column, y * cells + row)
    );
    return new Response(png, {headers: {'Content-Type': 'image/png'}});
  }) as typeof fetch;
  return {placeholder, requests, fetchTile};
}

const STYLE = {
  version: 8,
  sources: {
    imagery: {type: 'raster', tiles: ['https://tiles.test/{z}/{x}/{y}'], tileSize: TILE_SIZE}
  },
  layers: [{id: 'imagery', type: 'raster', source: 'imagery'}]
};

/**
 * Renders the basemap at zoom 2, centered where the zoom 2 tiles 1/1, 2/1, 1/2 and 2/2 meet, and
 * returns the frame drawn once every layer has loaded the tiles it selected.
 */
function render(props: object): Promise<ImageData> {
  parent = document.createElement('div');
  document.body.append(parent);
  const frame = stableFrames.waitForStableFrame({frames: 1, afterFrames: 20, timeout: 30_000});
  deck = new Deck({
    parent,
    width: SIZE,
    height: SIZE,
    useDevicePixels: false,
    deviceProps: {adapters: [webgl2Adapter]},
    views: new MapView({id: 'map', repeat: false}),
    initialViewState: {longitude: 0, latitude: 0, zoom: 2},
    layers: [new BasemapLayer({id: 'basemap', style: STYLE, ...props} as any)],
    ...stableFrames.deckProps,
    onError: stableFrames.fail
  });
  return frame;
}

function pixel(image: ImageData, x: number, y: number): number[] {
  const i = (y * SIZE + x) * 4;
  return [image.data[i], image.data[i + 1], image.data[i + 2]];
}

function expectColor(actual: number[], expected: number[]) {
  for (let i = 0; i < 3; i++) {
    expect(Math.abs(actual[i] - expected[i]), `${actual} is not ${expected}`).toBeLessThanOrEqual(
      3
    );
  }
}

/** The centers of the four zoom 2 tiles in view, with the tile each one is in. */
const TILE_CENTERS = [
  {pixel: [32, 32], tile: [1, 1]},
  {pixel: [96, 32], tile: [2, 1]},
  {pixel: [32, 96], tile: [1, 2]},
  {pixel: [96, 96], tile: [2, 2]}
];

describe('raster tiles of a service that returns a placeholder image', () => {
  test('are drawn as the service returns them without rejectRasterTile', async () => {
    const {fetchTile, requests} = await createTileService();
    const image = await render({loadOptions: {fetch: fetchTile}});
    for (const {pixel: [x, y]} of TILE_CENTERS) {
      expectColor(pixel(image, x, y), PLACEHOLDER_COLOR);
    }
    // The `fetch` of `loadOptions` loads raster tiles.
    expect(requests).toContain('https://tiles.test/2/1/1');
  });

  test('load with the `fetch` prop of the layer', async () => {
    const {fetchTile} = await createTileService();
    const urls: string[] = [];
    const image = await render({
      fetch: async (url: string) => {
        urls.push(url);
        const response = await fetchTile('https://tiles.test/1/0/0');
        return createImageBitmap(await response.blob());
      }
    });
    expect(urls).toContain('https://tiles.test/2/1/1');
    // Every tile draws the image that `fetch` returned, the zoom 1 tile 0/0. The top left of the
    // tile 2/2 is in view, and shows the top left area of that image.
    expectColor(pixel(image, 96, 96), getAreaColor(0, 0));
  });

  test('are drawn from the nearest ancestor that has data with rejectRasterTile', async () => {
    const {fetchTile, placeholder, requests} = await createTileService();
    const rejectRasterTile = createRasterTileFingerprintFilter([
      await getRasterTileFingerprint(placeholder)
    ]);
    const image = await render({loadOptions: {fetch: fetchTile}, rejectRasterTile});
    // Each zoom 2 tile shows its own quadrant of its zoom 1 parent, not the placeholder.
    for (const {pixel: [x, y], tile: [tileX, tileY]} of TILE_CENTERS) {
      expectColor(pixel(image, x, y), getAreaColor(tileX, tileY));
    }
    // Points near the corners of the view are in the same four tiles.
    expectColor(pixel(image, 4, 4), getAreaColor(1, 1));
    expectColor(pixel(image, 123, 123), getAreaColor(2, 2));
    expect(requests).toContain('https://tiles.test/2/1/1');
    expect(requests).toContain('https://tiles.test/1/0/0');
  });
});
