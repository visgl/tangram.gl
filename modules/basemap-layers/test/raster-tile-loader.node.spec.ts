// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {TileLayer} from '@deck.gl/geo-layers';
import {describe, expect, test, vi} from 'vitest';
import {getBasemapLayers} from '../src/index';
import type {RasterTileResponse} from '../src/index';
import {
  type ImageCrop,
  RasterTileLoader,
  getAncestorCrop,
  getAncestorIndex,
  getRasterTileLoader
} from '../src/raster-tile-loader';

const TILE_SIZE = 256;
const PLACEHOLDER = new Uint8Array([1, 2, 3, 4]);

/** A decoded test image: the URL it came from, and the part cut out of it. */
type TestImage = {url: string; width: number; height: number; crop?: ImageCrop};

type TestLoaderOptions = {
  /** The lowest zoom at which the service returns the placeholder. */
  placeholderZoom?: number;
  /** URLs that the service answers with this status. */
  status?: Record<string, number>;
  minZoom?: number;
};

/** A loader over a service that returns `PLACEHOLDER` from `placeholderZoom`, and the URL below. */
function createLoader({placeholderZoom = Infinity, status = {}, minZoom}: TestLoaderOptions = {}) {
  const fetchTile = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
    const [z] = String(url).split('/').slice(-3).map(Number);
    if (status[String(url)]) {
      return new Response(null, {status: status[String(url)]});
    }
    return new Response(z >= placeholderZoom ? PLACEHOLDER : new TextEncoder().encode(String(url)));
  });
  const rejectTile = vi.fn(
    ({arrayBuffer}: RasterTileResponse) =>
      arrayBuffer.byteLength === PLACEHOLDER.length &&
      new Uint8Array(arrayBuffer).every((byte, i) => byte === PLACEHOLDER[i])
  );
  const loader = new RasterTileLoader({
    tiles: ['https://tiles.test/{z}/{x}/{y}.png'],
    sourceId: 'imagery',
    minZoom,
    rejectTile,
    loadOptions: {fetch: fetchTile as typeof fetch, fetchOptions: {mode: 'cors'}},
    decodeImage: async arrayBuffer =>
      ({
        url: new TextDecoder().decode(arrayBuffer),
        width: TILE_SIZE,
        height: TILE_SIZE
      }) as any,
    cropImage: async (image, crop) => ({...image, crop}) as any
  });
  const load = (x: number, y: number, z: number, signal?: AbortSignal) =>
    loader.getTileData({index: {x, y, z}, id: `${x}-${y}-${z}`, signal} as any) as Promise<
      TestImage | null
    >;
  const requests = () => fetchTile.mock.calls.map(([url]) => String(url));
  return {loader, load, fetchTile, rejectTile, requests};
}

describe('RasterTileLoader', () => {
  test('draws a tile that has data from its own image', async () => {
    const {load, fetchTile, rejectTile, requests} = createLoader();
    const image = await load(5, 3, 3);
    expect(image).toEqual({url: 'https://tiles.test/3/5/3.png', width: 256, height: 256});
    expect(requests()).toEqual(['https://tiles.test/3/5/3.png']);
    expect(fetchTile.mock.calls[0][1]).toMatchObject({mode: 'cors'});
    const [tile] = rejectTile.mock.calls[0];
    expect(tile.url).toBe('https://tiles.test/3/5/3.png');
    expect(tile.sourceId).toBe('imagery');
    expect(tile.index).toEqual({x: 5, y: 3, z: 3});
    expect(new TextDecoder().decode(tile.arrayBuffer)).toBe('https://tiles.test/3/5/3.png');
  });

  test('draws a tile without data from the quadrant of its parent', async () => {
    const {load, requests} = createLoader({placeholderZoom: 3});
    const image = await load(5, 2, 3);
    expect(image).toEqual({
      url: 'https://tiles.test/2/2/1.png',
      width: 256,
      height: 256,
      crop: {x: 128, y: 0, width: 128, height: 128}
    });
    expect(requests()).toEqual(['https://tiles.test/3/5/2.png', 'https://tiles.test/2/2/1.png']);
  });

  test('draws from the nearest ancestor that has data', async () => {
    const {load, requests} = createLoader({placeholderZoom: 2});
    const image = await load(5, 3, 3);
    expect(image?.url).toBe('https://tiles.test/1/1/0.png');
    expect(image?.crop).toEqual({x: 64, y: 192, width: 64, height: 64});
    expect(requests()).toEqual([
      'https://tiles.test/3/5/3.png',
      'https://tiles.test/2/2/1.png',
      'https://tiles.test/1/1/0.png'
    ]);
  });

  test('draws nothing when no ancestor from the minimum zoom has data', async () => {
    const {load, requests} = createLoader({placeholderZoom: 0, minZoom: 2});
    expect(await load(5, 3, 3)).toBeNull();
    expect(requests()).toEqual(['https://tiles.test/3/5/3.png', 'https://tiles.test/2/2/1.png']);
  });

  test('requests an ancestor once for all of the tiles it covers', async () => {
    const {load, requests} = createLoader({placeholderZoom: 3});
    const images = await Promise.all([load(4, 2, 3), load(5, 2, 3), load(4, 3, 3)]);
    expect(images.map(image => image?.crop)).toEqual([
      {x: 0, y: 0, width: 128, height: 128},
      {x: 128, y: 0, width: 128, height: 128},
      {x: 0, y: 128, width: 128, height: 128}
    ]);
    expect(requests().filter(url => url === 'https://tiles.test/2/2/1.png')).toHaveLength(1);
  });

  test('a tile with an empty response has no data', async () => {
    const fetchTile = vi.fn(async (url: string | URL | Request) =>
      String(url).includes('/3/') ? new Response(new Uint8Array(0)) : new Response('parent')
    );
    const loader = new RasterTileLoader({
      tiles: ['https://tiles.test/{z}/{x}/{y}.png'],
      sourceId: 'imagery',
      rejectTile: () => false,
      loadOptions: {fetch: fetchTile as typeof fetch},
      decodeImage: async () => ({width: 256, height: 256}) as any,
      cropImage: async (_image, crop) => crop as any
    });
    const image = await loader.getTileData({index: {x: 1, y: 1, z: 3}, id: 'a'} as any);
    expect(image).toEqual({x: 128, y: 128, width: 128, height: 128});
  });

  test('a failed request is an error of the tile', async () => {
    const {load} = createLoader({status: {'https://tiles.test/3/5/3.png': 404}});
    await expect(load(5, 3, 3)).rejects.toThrow('https://tiles.test/3/5/3.png (404)');
  });

  test('skips an ancestor that fails to load, and requests it again later', async () => {
    const {load, requests} = createLoader({
      placeholderZoom: 3,
      status: {'https://tiles.test/2/2/1.png': 500}
    });
    expect((await load(5, 3, 3))?.url).toBe('https://tiles.test/1/1/0.png');
    expect((await load(4, 3, 3))?.url).toBe('https://tiles.test/1/1/0.png');
    expect(requests().filter(url => url === 'https://tiles.test/2/2/1.png')).toHaveLength(2);
    expect(requests().filter(url => url === 'https://tiles.test/1/1/0.png')).toHaveLength(1);
  });

  test('draws nothing for a tile that was aborted while its ancestor loaded', async () => {
    const {load} = createLoader({placeholderZoom: 3});
    const controller = new AbortController();
    const pending = load(5, 3, 3, controller.signal);
    controller.abort();
    expect(await pending).toBeNull();
  });

  test('keeps a limited number of ancestors', async () => {
    const {load, requests} = createLoader({placeholderZoom: 8});
    // 40 tiles with 40 different parents, then the first again.
    for (let x = 0; x < 80; x += 2) {
      await load(x, 0, 8);
    }
    await load(78, 1, 8);
    expect(requests().filter(url => url === 'https://tiles.test/7/39/0.png')).toHaveLength(1);
    await load(0, 1, 8);
    expect(requests().filter(url => url === 'https://tiles.test/7/0/0.png')).toHaveLength(2);
  });

  test('keeps the ancestors that were used last', async () => {
    const {load, requests} = createLoader({placeholderZoom: 8});
    const count = (url: string) => requests().filter(request => request === url).length;
    // 32 parents fill the cache. The first is used again, then one more parent is added.
    for (let x = 0; x < 64; x += 2) {
      await load(x, 0, 8);
    }
    await load(1, 0, 8);
    await load(64, 0, 8);
    await load(0, 1, 8);
    expect(count('https://tiles.test/7/0/0.png')).toBe(1);
    await load(2, 1, 8);
    expect(count('https://tiles.test/7/1/0.png')).toBe(2);
  });
});

describe('ancestor tiles', () => {
  test('getAncestorIndex', () => {
    expect(getAncestorIndex({x: 5, y: 3, z: 3}, 1)).toEqual({x: 2, y: 1, z: 2});
    expect(getAncestorIndex({x: 5, y: 3, z: 3}, 3)).toEqual({x: 0, y: 0, z: 0});
  });

  test('getAncestorCrop', () => {
    expect(getAncestorCrop({x: 0, y: 0, z: 1}, 1, 256, 256)).toEqual({
      x: 0,
      y: 0,
      width: 128,
      height: 128
    });
    expect(getAncestorCrop({x: 7, y: 6, z: 3}, 3, 512, 256)).toEqual({
      x: 448,
      y: 192,
      width: 64,
      height: 32
    });
    // One pixel is the smallest part.
    expect(getAncestorCrop({x: 255, y: 0, z: 8}, 8, 256, 256)).toEqual({
      x: 255,
      y: 0,
      width: 1,
      height: 1
    });
    // A tile smaller than one pixel of its ancestor takes the pixel it is in.
    expect(getAncestorCrop({x: 511, y: 2, z: 9}, 9, 256, 256)).toEqual({
      x: 255,
      y: 1,
      width: 1,
      height: 1
    });
    expect(getAncestorCrop({x: 1023, y: 1023, z: 12}, 10, 256, 256)).toEqual({
      x: 255,
      y: 255,
      width: 1,
      height: 1
    });
  });
});

describe('raster style layers', () => {
  const source = {type: 'raster', tiles: ['https://tiles.test/{z}/{x}/{y}.png'], minzoom: 2};
  const styleDefinition = {
    version: 8,
    sources: {imagery: source},
    layers: [{id: 'imagery', type: 'raster', source: 'imagery'}]
  } as any;
  const getRasterLayer = (options: object): any =>
    getBasemapLayers({idPrefix: 'test', styleDefinition, zoom: 3, ...options}).find(
      layer => layer.id === 'test-imagery'
    );

  test('load with the fetch and loadOptions of the basemap', () => {
    const fetchTile = async () => null;
    const loadOptions = {fetch: globalThis.fetch};
    const layer = getRasterLayer({fetch: fetchTile, loadOptions});
    expect(layer.props.fetch).toBe(fetchTile);
    expect(layer.props.loadOptions).toBe(loadOptions);
    expect(layer.props.getTileData).toBeNull();
    expect(layer.props.updateTriggers.getTileData).toBeNull();
  });

  test('keep the default loading without options', () => {
    const layer = getRasterLayer({});
    expect(layer.props.fetch).toBe(new TileLayer({id: 'default'}).props.fetch);
    expect(layer.props.loadOptions).toBeNull();
    expect(layer.props.getTileData).toBeNull();
  });

  test('load through one loader per source with rejectRasterTile', () => {
    const rejectRasterTile = () => false;
    const loadOptions = {};
    const layer = getRasterLayer({rejectRasterTile, loadOptions});
    const loader = getRasterTileLoader(source as any, {
      sourceId: 'imagery',
      minZoom: 2,
      rejectTile: rejectRasterTile,
      loadOptions
    });
    expect(layer.props.getTileData).toBe(loader.getTileData);
    expect(layer.props.updateTriggers.getTileData).toBe(rejectRasterTile);
    expect(loader.options.tiles).toBe(source.tiles);
    // The next render keeps the loader; another function replaces it.
    expect(getRasterLayer({rejectRasterTile, loadOptions}).props.getTileData).toBe(
      loader.getTileData
    );
    expect(
      getRasterLayer({rejectRasterTile: () => true, loadOptions}).props.getTileData
    ).not.toBe(loader.getTileData);
  });
});
