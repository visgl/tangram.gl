// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {Deck, MapView} from '@deck.gl/core';
import {webgl2Adapter} from '@luma.gl/core/webgl';
import {afterEach, describe, expect, test, vi} from 'vitest';
import {BasemapLayer, registerBasemapProtocol, unregisterBasemapProtocol} from '../src/index';
import type {BasemapProtocolHandler, BasemapRequestParameters} from '../src/index';
import {encodeBoxTile} from './fixtures/mvt-test-tile';

// A basemap whose style, TileJSON, tiles, sprite and GeoJSON data all load from memory through a
// registered protocol handler.

const SIZE = 256;
/** A view of zoom 0, centered at 0, 0: the 512 pixel world, cut to its middle 256 pixels. */
const VIEW = {longitude: 0, latitude: 0, zoom: 0, pitch: 0, bearing: 0};

let deck: Deck<any> | null = null;
let parent: HTMLDivElement | null = null;
let onFrame: ((image: ImageData) => void) | null = null;

afterEach(() => {
  deck?.finalize();
  deck = null;
  parent?.remove();
  parent = null;
  onFrame = null;
  unregisterBasemapProtocol('mem');
});

async function createPng(size: number, color: string): Promise<Blob> {
  const canvas = new OffscreenCanvas(size, size);
  const context = canvas.getContext('2d')!;
  context.fillStyle = color;
  context.fillRect(0, 0, size, size);
  return canvas.convertToBlob({type: 'image/png'});
}

const STYLE = {
  version: 8,
  sprite: 'sprite',
  sources: {
    raster: {type: 'raster', tiles: ['raster/{z}/{x}/{y}.png'], tileSize: 512, maxzoom: 0},
    shapes: {type: 'vector', url: 'tiles.json'},
    points: {type: 'geojson', data: 'points.geojson'}
  },
  layers: [
    {id: 'raster', type: 'raster', source: 'raster'},
    {
      id: 'box',
      type: 'fill',
      source: 'shapes',
      'source-layer': 'shapes',
      paint: {'fill-color': '#ff0000', 'fill-antialias': false}
    },
    {
      id: 'square',
      type: 'symbol',
      source: 'points',
      layout: {'icon-image': 'square', 'icon-size': 2, 'icon-allow-overlap': true}
    }
  ]
};

/**
 * The resources of the basemap, by URL: a green raster tile, a red box west of the meridian in a
 * vector tile, and a blue sprite square at 45E.
 */
async function createResources(): Promise<Record<string, unknown>> {
  return {
    'mem://basemap/style.json': STYLE,
    'mem://basemap/tiles.json': {tiles: ['tiles/{z}/{x}/{y}.pbf'], maxzoom: 0},
    'mem://basemap/tiles/0/0/0.pbf': encodeBoxTile([-80, -40, -10, 40]),
    'mem://basemap/raster/0/0/0.png': await createPng(512, 'rgb(0, 255, 0)'),
    'mem://basemap/sprite.json': {square: {x: 0, y: 0, width: 16, height: 16, pixelRatio: 1}},
    'mem://basemap/sprite.png': await createPng(16, 'rgb(0, 0, 255)'),
    'mem://basemap/points.geojson': {
      type: 'FeatureCollection',
      features: [{type: 'Feature', properties: {}, geometry: {type: 'Point', coordinates: [45, 0]}}]
    }
  };
}

function registerMemoryProtocol(resources: Record<string, unknown>) {
  const requests: BasemapRequestParameters[] = [];
  const handler: BasemapProtocolHandler = async requestParameters => {
    requests.push(requestParameters);
    if (!(requestParameters.url in resources)) {
      throw new Error(`Not found: ${requestParameters.url}`);
    }
    return {data: resources[requestParameters.url]};
  };
  registerBasemapProtocol('mem', handler);
  return requests;
}

function createDeck(layers: unknown[]): void {
  parent = document.createElement('div');
  document.body.append(parent);
  deck = new Deck({
    parent,
    width: SIZE,
    height: SIZE,
    useDevicePixels: false,
    deviceProps: {adapters: [webgl2Adapter]},
    views: new MapView({id: 'map'}),
    viewState: VIEW as any,
    layers: layers as any[],
    onAfterRender: () => {
      const all = (deck as any)?.layerManager?.getLayers() || [];
      if (!onFrame || all.length < 4 || all.some((layer: any) => !layer.isLoaded)) {
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
}

function nextFrame(): Promise<ImageData> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error('Timed out rendering')), 30_000);
    onFrame = image => {
      onFrame = null;
      window.clearTimeout(timeout);
      resolve(image);
    };
  });
}

/** The frame drawn once it has stopped changing: the style, tiles and sprite load over frames. */
async function settledFrame(): Promise<ImageData> {
  let previous: ImageData | null = null;
  for (let same = 0; same < 10; ) {
    window.setTimeout(() => window.requestAnimationFrame(() => deck?.redraw('settle')), 20);
    const image = await nextFrame();
    same = previous && image.data.every((value, i) => value === previous!.data[i]) ? same + 1 : 0;
    previous = image;
  }
  return previous!;
}

/** The RGB of the pixel at a longitude/latitude of the view. */
function getPixel(image: ImageData, longitude: number, latitude: number): number[] {
  const [x, y] = deck!.getViewports()[0].project([longitude, latitude]);
  const i = (Math.round(y) * SIZE + Math.round(x)) * 4;
  return [...image.data.slice(i, i + 3)];
}

describe('a basemap that loads through a registered protocol', () => {
  test('draws the style, raster and vector tiles, GeoJSON data and sprite the handler serves', async () => {
    const requests = registerMemoryProtocol(await createResources());
    createDeck([new BasemapLayer({id: 'basemap', style: 'mem://basemap/style.json'})]);
    const image = await settledFrame();

    expect(getPixel(image, -45, 0), 'the vector tile box').toEqual([255, 0, 0]);
    expect(getPixel(image, 45, 0), 'the sprite icon').toEqual([0, 0, 255]);
    expect(getPixel(image, -85, 60), 'the raster tile').toEqual([0, 255, 0]);
    expect(requests.map(({type, url}) => `${type} ${url}`).sort()).toEqual([
      'arrayBuffer mem://basemap/tiles/0/0/0.pbf',
      'image mem://basemap/raster/0/0/0.png',
      'image mem://basemap/sprite.png',
      'json mem://basemap/points.geojson',
      'json mem://basemap/sprite.json',
      'json mem://basemap/style.json',
      'json mem://basemap/tiles.json'
    ]);
  }, 60_000);

  test('a vector tile that deck.gl cancels aborts the handler', async () => {
    const resources = await createResources();
    const tileRequests: AbortController[] = [];
    registerBasemapProtocol('mem', async ({url}, abortController) => {
      if (url.endsWith('.pbf')) {
        tileRequests.push(abortController);
        return new Promise(() => {});
      }
      if (!(url in resources)) {
        throw new Error(`Not found: ${url}`);
      }
      return {data: resources[url]};
    });
    createDeck([new BasemapLayer({id: 'basemap', style: 'mem://basemap/style.json'})]);
    await vi.waitFor(() => expect(tileRequests).toHaveLength(1), {timeout: 30_000});
    expect(tileRequests[0].signal.aborted).toBe(false);

    // Removing the layer releases its tiles, and deck.gl aborts the one still loading.
    deck!.setProps({layers: []});
    await vi.waitFor(() => expect(tileRequests[0].signal.aborted).toBe(true), {timeout: 10_000});
  }, 60_000);

  test('a style URL with an unknown scheme fails to load with an error that names the scheme', async () => {
    const layer = new BasemapLayer({id: 'basemap', style: 'unknown://basemap/style.json'});
    createDeck([layer]);
    await vi.waitFor(
      () => {
        const current = (deck as any).layerManager.getLayers().find((l: any) => l.id === 'basemap');
        expect(current?.state?.loadError?.message).toMatch(
          /No basemap protocol is registered for "unknown:\/\/"/
        );
      },
      {timeout: 10_000}
    );
  }, 30_000);
});
