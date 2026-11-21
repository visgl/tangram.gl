// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {Deck, MapView} from '@deck.gl/core';
import {webgl2Adapter} from '@luma.gl/core/webgl';
import {afterEach, describe, expect, test, vi} from 'vitest';
import {BasemapLayer} from '../src/basemap-layer';

// A new style object keeps the TileJSON, the sprite and the tiles of the sources it shares with
// the previous style, as MapLibre GL JS's `setStyle(style, {diff: true})` keeps them.

const WIDTH = 256;
const HEIGHT = 128;

let deck: Deck<any> | null = null;
let parent: HTMLDivElement | null = null;
let onFrame: ((image: ImageData) => void) | null = null;

afterEach(() => {
  deck?.finalize();
  deck = null;
  parent?.remove();
  parent = null;
  onFrame = null;
});

/** The requests of one test: TileJSON and sprite requests, and tile requests. */
type Requests = {resources: string[]; tiles: string[]};

/** A 1 x 1 PNG for the sprite image. */
async function getPng(): Promise<Blob> {
  const canvas = new OffscreenCanvas(1, 1);
  canvas.getContext('2d')!.fillRect(0, 0, 1, 1);
  return await canvas.convertToBlob({type: 'image/png'});
}

/**
 * `loadOptions.fetch`: serves the TileJSON of each host and a sprite, and counts the requests. It
 * answers after `ready`, and with status 500 to the first request whose URL ends with `failOnce`.
 */
function createResourceFetch(
  requests: Requests,
  {ready, failOnce}: {ready?: Promise<void>; failOnce?: string} = {}
): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    requests.resources.push(url);
    await ready;
    if (failOnce && url.endsWith(failOnce)) {
      failOnce = undefined;
      return new Response('', {status: 500});
    }
    if (url.endsWith('/tiles.json')) {
      const host = new URL(url).host;
      return new Response(JSON.stringify({tiles: [`https://${host}/{z}/{x}/{y}.mvt`]}));
    }
    if (url.endsWith('/sprite.json')) {
      return new Response(
        JSON.stringify({
          dot: {x: 0, y: 0, width: 1, height: 1, pixelRatio: 1}
        })
      );
    }
    if (url.endsWith('/sprite.png')) {
      return new Response(await getPng());
    }
    return new Response('', {status: 404});
  }) as typeof fetch;
}

/** The square of a tile from x0 to x1, in tile-local coordinates. */
function halfTile(x0: number, x1: number): number[][][] {
  return [
    [
      [x0, 0],
      [x1, 0],
      [x1, 1],
      [x0, 1],
      [x0, 0]
    ]
  ];
}

/**
 * The `fetch` of the tiles: the left half of each tile is water and the right half is land. As
 * the MVT loader does, it decodes only the source layers of `loadOptions.mvt.layers`.
 */
function createTileFetch(requests: Requests) {
  return async (url: string, {loadOptions}: {loadOptions?: any}) => {
    requests.tiles.push(url);
    const layers: string[] | undefined = loadOptions?.mvt?.layers;
    return [
      {layerName: 'water', coordinates: halfTile(0, 0.5)},
      {layerName: 'land', coordinates: halfTile(0.5, 1)}
    ]
      .filter(({layerName}) => !layers || layers.includes(layerName))
      .map(({layerName, coordinates}) => ({
        type: 'Feature',
        properties: {layerName},
        geometry: {type: 'Polygon', coordinates}
      }));
  };
}

/** A style of one source at `host`, a white background, and the water in `water`. */
function createStyle({
  host = 'tiles.example.com',
  water = '#ff0000',
  land
}: {host?: string; water?: string; land?: string} = {}): any {
  return {
    version: 8,
    sprite: 'https://assets.example.com/sprite',
    glyphs: 'https://assets.example.com/fonts/{fontstack}/{range}.pbf',
    sources: {
      tiles: {type: 'vector', url: `https://${host}/tiles.json`}
    },
    layers: [
      {
        id: 'background',
        type: 'background',
        paint: {'background-color': '#ffffff'}
      },
      {
        id: 'water',
        type: 'fill',
        source: 'tiles',
        'source-layer': 'water',
        paint: {'fill-color': water}
      },
      ...(land
        ? [
            {
              id: 'land',
              type: 'fill',
              source: 'tiles',
              'source-layer': 'land',
              paint: {'fill-color': land}
            }
          ]
        : [])
    ]
  };
}

const VIEW = {longitude: 0, latitude: 0, zoom: 1, pitch: 0, bearing: 0};

/** The props of one test's layers: the same `loadOptions` and `fetch` for each style. */
function createProps(requests: Requests) {
  return {
    loadOptions: {fetch: createResourceFetch(requests)},
    fetch: createTileFetch(requests)
  };
}

function createLayer(style: unknown, props: ReturnType<typeof createProps>): BasemapLayer {
  return new BasemapLayer({id: 'basemap', style, ...props} as any);
}

function createDeck(layer: BasemapLayer): void {
  parent = document.createElement('div');
  document.body.append(parent);
  deck = new Deck({
    parent,
    width: WIDTH,
    height: HEIGHT,
    useDevicePixels: false,
    deviceProps: {adapters: [webgl2Adapter]},
    views: new MapView({id: 'map'}),
    viewState: VIEW as any,
    layers: [layer],
    onAfterRender: () => {
      const all = (deck as any)?.layerManager?.getLayers() || [];
      // The basemap draws sublayers once its style resolves.
      if (!onFrame || all.length < 3 || all.some((sublayer: any) => !sublayer.isLoaded)) {
        return;
      }
      const copy = document.createElement('canvas');
      copy.width = WIDTH;
      copy.height = HEIGHT;
      const context = copy.getContext('2d')!;
      context.drawImage(deck!.getCanvas()!, 0, 0);
      onFrame(context.getImageData(0, 0, WIDTH, HEIGHT));
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

/** The frame drawn once it has stopped changing: the style and the tiles load over frames. */
async function settledFrame(): Promise<ImageData> {
  let previous: ImageData | null = null;
  for (let same = 0; same < 5;) {
    window.setTimeout(() => window.requestAnimationFrame(() => deck?.redraw('settle')), 20);
    const image = await nextFrame();
    same = previous && image.data.every((value, i) => value === previous!.data[i]) ? same + 1 : 0;
    previous = image;
  }
  return previous!;
}

/** The number of pixels of each pure colour. */
function countColors(image: ImageData): {
  red: number;
  blue: number;
  green: number;
} {
  const counts = {red: 0, blue: 0, green: 0};
  for (let i = 0; i < image.data.length; i += 4) {
    const [r, g, b] = [image.data[i], image.data[i + 1], image.data[i + 2]];
    if (r > 200 && g < 50 && b < 50) counts.red++;
    if (b > 200 && g < 50 && r < 50) counts.blue++;
    if (g > 100 && r < 50 && b < 50) counts.green++;
  }
  return counts;
}

/** The internal state of the deck's BasemapLayer. */
function getBasemapState(): any {
  return (deck as any).layerManager.getLayers().find((layer: any) => layer.id === 'basemap').state;
}

describe('a new style object', () => {
  test('that changes only paint loads no TileJSON, sprite or tile again', async () => {
    const requests: Requests = {resources: [], tiles: []};
    const props = createProps(requests);
    createDeck(createLayer(createStyle(), props));
    expect(countColors(await settledFrame()).red).toBeGreaterThan(1000);
    expect(requests.resources.some(url => url.endsWith('/tiles.json'))).toBe(true);
    expect(requests.resources.some(url => url.endsWith('/sprite.png'))).toBe(true);
    expect(requests.tiles.length).toBeGreaterThan(0);
    const {glyphs, spriteAtlases} = getBasemapState();
    expect(glyphs).toBeTruthy();
    const resources = requests.resources.length;
    const tiles = requests.tiles.length;

    deck!.setProps({
      layers: [createLayer(createStyle({water: '#0000ff'}), props)]
    });
    const colors = countColors(await settledFrame());
    expect(colors.blue).toBeGreaterThan(1000);
    expect(colors.red).toBe(0);
    expect(requests.resources.slice(resources)).toEqual([]);
    expect(requests.tiles.slice(tiles)).toEqual([]);
    expect(getBasemapState().spriteAtlases).toBe(spriteAtlases);
    expect(getBasemapState().glyphs).toBe(glyphs);
  }, 60_000);

  test('with a new source URL loads that TileJSON and its tiles', async () => {
    const requests: Requests = {resources: [], tiles: []};
    const props = createProps(requests);
    createDeck(createLayer(createStyle(), props));
    await settledFrame();
    const resources = requests.resources.length;
    const tiles = requests.tiles.length;

    const style = createStyle({
      host: 'other.example.com',
      water: '#0000ff'
    });
    deck!.setProps({layers: [createLayer(style, props)]});
    expect(countColors(await settledFrame()).blue).toBeGreaterThan(1000);
    expect(requests.resources.slice(resources)).toEqual(['https://other.example.com/tiles.json']);
    const newTiles = requests.tiles.slice(tiles);
    expect(newTiles.length).toBeGreaterThan(0);
    expect(newTiles.every(url => url.startsWith('https://other.example.com/'))).toBe(true);
  }, 60_000);

  test('that draws one more source layer decodes the tiles again, and draws that layer', async () => {
    const requests: Requests = {resources: [], tiles: []};
    const props = createProps(requests);
    createDeck(createLayer(createStyle(), props));
    expect(countColors(await settledFrame()).green).toBe(0);
    const resources = requests.resources.length;
    const tiles = requests.tiles.length;

    const style = createStyle({land: '#00a000'});
    deck!.setProps({layers: [createLayer(style, props)]});
    const colors = countColors(await settledFrame());
    expect(colors.green).toBeGreaterThan(1000);
    expect(colors.red).toBeGreaterThan(1000);
    // The source and the sprite are the same: only the tiles load again.
    expect(requests.resources.slice(resources)).toEqual([]);
    expect(requests.tiles.length).toBeGreaterThan(tiles);
  }, 60_000);
});

/**
 * The first frame drawn with the layer of `style`. A frame that deck.gl had begun before the new
 * layer replaced the old one can come first: it is skipped.
 */
async function frameAfterUpdate(style: unknown, props: ReturnType<typeof createProps>) {
  deck!.setProps({layers: [createLayer(style, props)]});
  for (;;) {
    const frame = await nextFrame();
    const basemap = (deck as any).layerManager
      .getLayers()
      .find((layer: any) => layer.id === 'basemap');
    if (basemap.props.style === style) {
      return countColors(frame);
    }
  }
}

describe('a style update', () => {
  /** The style, with a blue copy of the water drawn before (under) the red water. */
  function layeredStyle(): any {
    const style = createStyle();
    const water = style.layers[1];
    style.layers.splice(1, 0, {...water, id: 'water-under', paint: {'fill-color': '#0000ff'}});
    return style;
  }

  test('draws a new paint value in the first frame after it, with no request', async () => {
    const requests: Requests = {resources: [], tiles: []};
    const props = createProps(requests);
    createDeck(createLayer(createStyle(), props));
    await settledFrame();
    const counts = [requests.resources.length, requests.tiles.length];

    const colors = await frameAfterUpdate(createStyle({water: '#0000ff'}), props);
    expect(colors.blue).toBeGreaterThan(1000);
    expect(colors.red).toBe(0);
    expect([requests.resources.length, requests.tiles.length]).toEqual(counts);
  }, 60_000);

  test('applies a new filter in the first frame after it, with no request', async () => {
    const requests: Requests = {resources: [], tiles: []};
    const props = createProps(requests);
    createDeck(createLayer(createStyle(), props));
    expect(countColors(await settledFrame()).red).toBeGreaterThan(1000);
    const counts = [requests.resources.length, requests.tiles.length];

    const style = createStyle();
    style.layers[1].filter = ['==', ['get', 'kind'], 'lake'];
    expect((await frameAfterUpdate(style, props)).red).toBe(0);
    expect([requests.resources.length, requests.tiles.length]).toEqual(counts);
  }, 60_000);

  test('applies a new visibility and layer order in the first frame after it', async () => {
    const requests: Requests = {resources: [], tiles: []};
    const props = createProps(requests);
    createDeck(createLayer(layeredStyle(), props));
    const colors = countColors(await settledFrame());
    expect([colors.red > 1000, colors.blue]).toEqual([true, 0]);
    const counts = [requests.resources.length, requests.tiles.length];

    const reordered = layeredStyle();
    reordered.layers.push(...reordered.layers.splice(1, 1));
    const over = await frameAfterUpdate(reordered, props);
    expect([over.blue > 1000, over.red]).toEqual([true, 0]);

    const hidden = layeredStyle();
    hidden.layers[2].layout = {visibility: 'none'};
    const under = await frameAfterUpdate(hidden, props);
    expect([under.blue > 1000, under.red]).toEqual([true, 0]);
    expect([requests.resources.length, requests.tiles.length]).toEqual(counts);
  }, 60_000);

  test('keeps the style layers that did not change, and their sources', async () => {
    const requests: Requests = {resources: [], tiles: []};
    const props = createProps(requests);
    createDeck(createLayer(createStyle(), props));
    await settledFrame();
    const before = getBasemapState().resolvedStyle;

    await frameAfterUpdate(createStyle({water: '#0000ff'}), props);
    const after = getBasemapState().resolvedStyle;
    expect(after).not.toBe(before);
    expect(after.layers[0]).toBe(before.layers[0]);
    expect(after.layers[1]).not.toBe(before.layers[1]);
    expect(after.sources).toBe(before.sources);
  }, 60_000);
});

test('a style changed in place and given as a shallow copy draws the change', async () => {
  const requests: Requests = {resources: [], tiles: []};
  const props = createProps(requests);
  const style = createStyle();
  createDeck(createLayer(style, props));
  expect(countColors(await settledFrame()).red).toBeGreaterThan(1000);

  style.layers[1].paint['fill-color'] = '#0000ff';
  deck!.setProps({layers: [createLayer({...style}, props)]});
  const colors = countColors(await settledFrame());
  expect([colors.blue > 1000, colors.red]).toEqual([true, 0]);
}, 60_000);

describe('a style update by diff', () => {
  test('a paint change during a load with new loadOptions draws once the load ends', async () => {
    const requests: Requests = {resources: [], tiles: []};
    const props = createProps(requests);
    const style = createStyle();
    createDeck(createLayer(style, props));
    expect(countColors(await settledFrame()).red).toBeGreaterThan(1000);

    // New loadOptions start a load that ends later; a paint change comes before it ends.
    let release!: () => void;
    const ready = new Promise<void>(resolve => (release = resolve));
    const slow = {...props, loadOptions: {fetch: createResourceFetch(requests, {ready})}};
    const previousToken = getBasemapState().loadToken;
    deck!.setProps({layers: [createLayer(style, slow)]});
    await vi.waitFor(() => expect(getBasemapState().loadToken).toBeGreaterThan(previousToken));
    const paintedLayer = createLayer(createStyle({water: '#0000ff'}), slow);
    deck!.setProps({layers: [paintedLayer]});
    await vi.waitFor(() => expect((deck as any).layerManager.getLayers()).toContain(paintedLayer));
    release();
    // The load with the new loadOptions ends.
    await vi.waitFor(() => expect(getBasemapState().styleLoadOptions).toBe(slow.loadOptions));
    const colors = countColors(await settledFrame());
    expect([colors.blue > 1000, colors.red]).toEqual([true, 0]);
  }, 60_000);

  test.each(['/tiles.json', '/sprite.json'])(
    'loads %s again after it failed to load',
    async failOnce => {
      const requests: Requests = {resources: [], tiles: []};
      const loadOptions = {fetch: createResourceFetch(requests, {failOnce})};
      const errors: Error[] = [];
      const props = {
        ...createProps(requests),
        loadOptions,
        onError: (error: Error) => {
          errors.push(error);
          return true;
        }
      };
      createDeck(createLayer(createStyle(), props));
      // Without its TileJSON, the source draws nothing: wait for the load, not for a frame.
      await vi.waitFor(() => expect(getBasemapState()?.resolvedStyle).toBeTruthy(), {
        timeout: 10_000
      });
      await new Promise(resolve => setTimeout(resolve, 500));
      expect(requests.resources.filter(url => url.endsWith(failOnce))).toHaveLength(1);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.message).toContain(failOnce);

      deck!.setProps({layers: [createLayer(createStyle({water: '#0000ff'}), props)]});
      const colors = countColors(await settledFrame());
      expect(requests.resources.filter(url => url.endsWith(failOnce))).toHaveLength(2);
      expect(colors.blue).toBeGreaterThan(1000);
    },
    60_000
  );
});
