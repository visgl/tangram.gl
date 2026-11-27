// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {Deck, OrthographicView} from '@deck.gl/core';
import {Texture} from '@luma.gl/core';
import {webgl2Adapter} from '@luma.gl/core/webgl';
import {afterEach, describe, expect, test} from 'vitest';
import {getBasemapLayers} from '../src/index';

const SIZE = 128;

let deck: Deck<any> | null = null;
let parent: HTMLDivElement | null = null;

afterEach(() => {
  deck?.finalize();
  deck = null;
  parent?.remove();
  parent = null;
});

/** The bitmap layer that a raster style layer draws for one tile covering the whole canvas. */
function rasterTile(paint: Record<string, unknown>, image: HTMLCanvasElement, index = {x: 0, y: 0, z: 5}) {
  const layers = getBasemapLayers({
    idPrefix: 'test',
    mode: 'map',
    zoom: 5,
    styleDefinition: {
      version: 8,
      sources: {raster: {type: 'raster', tiles: ['https://tiles.example.com/{z}/{x}/{y}.png']}},
      layers: [{id: 'imagery', type: 'raster', source: 'raster', paint}]
    } as any
  });
  const rasterLayer: any = layers.find(layer => layer.id === 'test-imagery');
  const half = SIZE / 2;
  // As in `TileLayer.renderLayers`, the tile receives the layer's props and its sublayer props.
  rasterLayer.context = {device: {type: 'webgl'}};
  return rasterLayer.props.renderSubLayers({
    ...rasterLayer.props,
    ...rasterLayer.getSubLayerProps({id: 'tile'}),
    id: 'test-imagery-tile',
    data: image,
    tile: {index, bbox: {west: -half, south: -half, east: half, north: half}}
  });
}

/**
 * Renders layers on a white canvas and returns the first frame drawn after they load.
 *
 * The test timeout bounds the wait. Concurrent browser test files share one GPU process, so a
 * shorter limit here times out on a busy CI runner while the layers still load.
 */
function render(layers: unknown[]) {
  parent = document.createElement('div');
  document.body.append(parent);
  return new Promise<ImageData>((resolve, reject) => {
    deck = new Deck({
      parent,
      width: SIZE,
      height: SIZE,
      useDevicePixels: false,
      deviceProps: {adapters: [webgl2Adapter]},
      views: new OrthographicView({id: 'flat'}),
      initialViewState: {target: [0, 0, 0], zoom: 0},
      layers: layers as any,
      onAfterRender: () => {
        const loaded = (deck as any)?.layerManager?.getLayers() || [];
        if (!loaded.length || loaded.some((layer: any) => !layer.isLoaded)) {
          // Draw again in the next frame, so that the wait never depends on a frame that deck draws
          // by itself.
          window.requestAnimationFrame(() => deck?.redraw('load'));
          return;
        }
        const copy = document.createElement('canvas');
        copy.width = SIZE;
        copy.height = SIZE;
        const context = copy.getContext('2d')!;
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, SIZE, SIZE);
        context.drawImage(deck!.getCanvas()!, 0, 0);
        resolve(context.getImageData(0, 0, SIZE, SIZE));
      },
      onError: error => {
        reject(error);
      }
    });
  });
}

function pixel(image: ImageData, x: number, y: number): number[] {
  const i = (y * SIZE + x) * 4;
  return [image.data[i], image.data[i + 1], image.data[i + 2]];
}


/** A 2 by 2 image, one color per quadrant: top left, top right, bottom left, bottom right. */
function createQuadrants(colors: number[][]): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = 2;
  canvas.height = 2;
  const context = canvas.getContext('2d')!;
  colors.forEach(([r, g, b], i) => {
    context.fillStyle = `rgb(${r}, ${g}, ${b})`;
    context.fillRect(i % 2, Math.floor(i / 2), 1, 1);
  });
  return canvas;
}

function expectColor(actual: number[], expected: number[]) {
  for (let i = 0; i < 3; i++) {
    expect(Math.abs(actual[i] - expected[i])).toBeLessThanOrEqual(2);
  }
}

const TILE = [200, 80, 40];
const RED = [220, 30, 30];
const GREEN = [30, 200, 60];
const BLUE = [40, 60, 220];
const YELLOW = [230, 210, 20];
/** The parent of tile 1/1/0: its top-right quadrant (green) covers the tile. */
const PARENT = createQuadrants([RED, GREEN, BLUE, YELLOW]);
const DURATION = 300;
const mix = (a: number[], b: number[], t: number) => a.map((value, i) => value + (b[i] - value) * t);

/**
 * Tile 1/1/0 as a style with `raster-fade-duration` draws it, `elapsed` ms after it was first
 * drawn, with or without its parent 0/0/0 to fade from.
 */
function fadingTile(elapsed: number, withParent: boolean) {
  const time = 1000;
  return rasterTile({'raster-fade-duration': DURATION}, createQuadrants([TILE, TILE, TILE, TILE]), {
    x: 1,
    y: 0,
    z: 1
  }).clone({
    rasterFadeClock: () => time + elapsed,
    rasterFade: {
      start: time,
      parent: withParent ? {topLeft: [0.5, 0], scale: 0.5} : null
    },
    rasterFadeParentImage: withParent ? PARENT : null
  });
}

describe('raster-fade-duration in the browser', () => {
  const center = (image: ImageData) => pixel(image, SIZE / 2, SIZE / 2);

  test('a tile cross-fades from the part of its parent that covers it', async () => {
    expectColor(center(await render([fadingTile(0, true)])), GREEN);
  });

  test('halfway through the fade, the tile is half its parent', async () => {
    expectColor(center(await render([fadingTile(DURATION / 2, true)])), mix(GREEN, TILE, 0.5));
  });

  test('at the end of the fade, the tile is drawn alone', async () => {
    expectColor(center(await render([fadingTile(DURATION, true)])), TILE);
  });

  test('after the fade, the tile lets go of its parent image without an error', async () => {
    // What `RasterFadeTileLayer` gives a tile's layer when its fade ends. The image is not `null`:
    // deck.gl's `image` prop type fails on `null` after an image, and the layer keeps drawing
    // with its old props.
    const tile = fadingTile(DURATION, true);
    await render([tile]);
    const [before] = (deck as any).layerManager.getLayers();
    const ancestorTexture = before.props.rasterFadeParentImage;
    expect(ancestorTexture).toBeInstanceOf(Texture);
    expect(ancestorTexture.destroyed).toBe(false);
    const errors: unknown[] = [];
    const released = (deck as any).device.createTexture({width: 1, height: 1});
    try {
      await new Promise<void>(resolve => {
        deck!.setProps({
          onError: error => {
            errors.push(error);
          },
          onAfterRender: () => resolve(),
          layers: [
            tile.clone({rasterFade: {start: 1000, parent: null}, rasterFadeParentImage: released})
          ]
        });
      });
      expect(errors).toEqual([]);
      const [drawn] = (deck as any).layerManager.getLayers();
      expect(drawn.internalState.propsInTransition.rasterFade.parent).toBeNull();
      expect(ancestorTexture.destroyed).toBe(true);
    } finally {
      released.destroy();
    }
  });

  test('a tile without a parent fades in from transparent', async () => {
    const white = [255, 255, 255];
    expectColor(center(await render([fadingTile(0, false)])), white);
    deck?.finalize();
    deck = null;
    parent?.remove();
    expectColor(center(await render([fadingTile(DURATION / 2, false)])), mix(white, TILE, 0.5));
  });
});
