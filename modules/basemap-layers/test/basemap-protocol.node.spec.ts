// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/* eslint-disable import/no-extraneous-dependencies */
import {Layer} from '@deck.gl/core';
import {afterEach, describe, expect, test, vi} from 'vitest';
import {BasemapLayer, registerBasemapProtocol, unregisterBasemapProtocol} from '../src/index.ts';
import type {BasemapProtocolHandler, BasemapRequestParameters} from '../src/index.ts';
import {
  DEFAULT_MVT_FETCH,
  getBasemapFetch,
  getBasemapLayerFetch
} from '../src/basemap-protocol';
import {GlyphStore} from '../src/glyph-store';
import {loadDemTile} from '../src/hillshade-layer';
import {RasterTileLoader} from '../src/raster-tile-loader';
import {loadSpriteAtlases} from '../src/sprite';
import {resolveBasemapStyle} from '../src/style-resolver';

/** Registers `mem` with a handler that serves `resources` by URL and records each request. */
function registerMemoryProtocol(resources: Record<string, unknown>) {
  const requests: BasemapRequestParameters[] = [];
  const handler = vi.fn<BasemapProtocolHandler>(async requestParameters => {
    requests.push(requestParameters);
    if (!(requestParameters.url in resources)) {
      throw new Error(`Not found: ${requestParameters.url}`);
    }
    return {data: resources[requestParameters.url]};
  });
  registerBasemapProtocol('mem', handler);
  return {handler, requests};
}

/** A handler that never resolves, and the abort controllers it received. */
function registerPendingProtocol() {
  const controllers: AbortController[] = [];
  registerBasemapProtocol('pending', (_, abortController) => {
    controllers.push(abortController);
    return new Promise(() => {});
  });
  return controllers;
}

afterEach(() => {
  unregisterBasemapProtocol('mem');
  unregisterBasemapProtocol('pending');
  unregisterBasemapProtocol('pmtiles');
  vi.restoreAllMocks();
});

describe('registerBasemapProtocol', () => {
  test('rejects a scheme written with "://" and the schemes that load with fetch', () => {
    const handler: BasemapProtocolHandler = async () => ({data: null});
    expect(() => registerBasemapProtocol('mem://', handler)).toThrow(/without ":\/\/"/);
    expect(() => registerBasemapProtocol('https', handler)).toThrow(/always loads with fetch/);
    expect(() => registerBasemapProtocol('mem', null as any)).toThrow(/not a function/);
  });

  test('gives the handler the URL, the resource type and the fetch options', async () => {
    const {requests} = registerMemoryProtocol({'mem://a/style.json': {version: 8}});
    const response = await getBasemapFetch(undefined, 'json')('mem://a/style.json', {
      headers: {Authorization: 'token'},
      credentials: 'include'
    });
    expect(await response.json()).toEqual({version: 8});
    expect(requests).toEqual([
      {
        url: 'mem://a/style.json',
        type: 'json',
        headers: {Authorization: 'token'},
        credentials: 'include'
      }
    ]);
  });

  test('a scheme is case-insensitive, and unregistering it stops its URLs loading', async () => {
    registerMemoryProtocol({'MEM://a/b': 'text'});
    const fetchFn = getBasemapFetch(undefined, 'string');
    expect(await (await fetchFn('MEM://a/b')).text()).toBe('text');
    unregisterBasemapProtocol('MEM');
    await expect(fetchFn('MEM://a/b')).rejects.toThrow(/No basemap protocol is registered/);
  });

  test('an unknown scheme fails with an error that names it and the registration function', async () => {
    const fetchFn = getBasemapFetch(undefined, 'json');
    await expect(fetchFn('foo://tiles/style.json')).rejects.toThrow(
      `No basemap protocol is registered for "foo://" (foo://tiles/style.json). ` +
        `Call registerBasemapProtocol('foo', handler) first.`
    );
  });

  test('a custom fetch still loads an unknown scheme, and http URLs never reach a handler', async () => {
    const {handler} = registerMemoryProtocol({});
    const custom = vi.fn(async () => new Response('custom'));
    const fetchFn = getBasemapFetch(custom as unknown as typeof fetch, 'string');
    expect(await (await fetchFn('foo://a')).text()).toBe('custom');
    expect(await (await fetchFn('https://example.com/mem://a')).text()).toBe('custom');
    expect(handler).not.toHaveBeenCalled();
  });

  test('a handler result that is not bytes, a string or JSON fails with a clear error', async () => {
    registerBasemapProtocol('mem', async () => ({data: 42}));
    await expect(getBasemapFetch(undefined, 'image')('mem://a/tile.png')).rejects.toThrow(
      /returned \[object Number\]; return bytes, a string or, for a json request, a JSON value/
    );
  });

  test('aborting the request aborts the handler and rejects at once', async () => {
    const controllers = registerPendingProtocol();
    const caller = new AbortController();
    const request = getBasemapFetch(undefined, 'arrayBuffer')('pending://tile', {
      signal: caller.signal
    });
    await vi.waitFor(() => expect(controllers).toHaveLength(1));
    expect(controllers[0].signal.aborted).toBe(false);
    caller.abort();
    await expect(request).rejects.toMatchObject({name: 'AbortError'});
    expect(controllers[0].signal.aborted).toBe(true);
  });
});

describe('BasemapLayer resources with a registered scheme', () => {
  test('a style, its TileJSON and its GeoJSON data load from the handler; relative URLs resolve', async () => {
    const {requests} = registerMemoryProtocol({
      'mem://basemap/style.json': {
        version: 8,
        sources: {
          shapes: {type: 'vector', url: 'tiles.json'},
          points: {type: 'geojson', data: 'points.geojson'}
        },
        layers: []
      },
      'mem://basemap/tiles.json': {tiles: ['tiles/{z}/{x}/{y}.pbf'], maxzoom: 3},
      'mem://basemap/points.geojson': {type: 'FeatureCollection', features: []}
    });
    const style = await resolveBasemapStyle('mem://basemap/style.json');
    expect(style.sources.shapes.tiles).toEqual(['mem://basemap/tiles/{z}/{x}/{y}.pbf']);
    expect(style.sources.shapes.maxzoom).toBe(3);
    expect(style.sources.points.data).toEqual({type: 'FeatureCollection', features: []});
    expect(requests.map(({url, type}) => `${type} ${url}`).sort()).toEqual([
      'json mem://basemap/points.geojson',
      'json mem://basemap/style.json',
      'json mem://basemap/tiles.json'
    ]);
  });

  test('a source URL with a registered scheme reaches the handler as written', async () => {
    // The form of MapLibre GL JS's `pmtiles` protocol: the archive URL follows the scheme.
    const url = 'pmtiles://https://example.com/archive.pmtiles';
    const handler = vi.fn<BasemapProtocolHandler>(async ({url: requested}) => ({
      data: {tiles: [`${requested}/{z}/{x}/{y}`]}
    }));
    registerBasemapProtocol('pmtiles', handler);
    const style = await resolveBasemapStyle({
      version: 8,
      sources: {archive: {type: 'vector', url}},
      layers: []
    });
    expect(handler.mock.calls[0][0]).toMatchObject({url, type: 'json'});
    expect(style.sources.archive.tiles).toEqual([`${url}/{z}/{x}/{y}`]);
  });

  test('sprite indexes and glyph ranges load from the handler', async () => {
    const glyphs = new Uint8Array([]);
    const {requests} = registerMemoryProtocol({
      'mem://basemap/sprite.json': {dot: {x: 0, y: 0, width: 4, height: 4, pixelRatio: 1}},
      'mem://basemap/fonts/Noto%20Sans/0-255.pbf': glyphs
    });
    const [atlas] = await loadSpriteAtlases('sprite', {
      baseUrl: 'mem://basemap/style.json',
      pixelRatio: 1
    });
    expect(atlas.mapping.dot).toMatchObject({width: 4, height: 4});
    const store = new GlyphStore({url: 'mem://basemap/fonts/{fontstack}/{range}.pbf'});
    await store.load('Noto Sans', ['a']);
    expect(requests.map(({url, type}) => `${type} ${url}`)).toEqual([
      'json mem://basemap/sprite.json',
      'arrayBuffer mem://basemap/fonts/Noto%20Sans/0-255.pbf'
    ]);
  });

  test('raster and raster-dem tiles load from the handler, and aborting the tile aborts it', async () => {
    const controllers = registerPendingProtocol();
    const loader = new RasterTileLoader({
      tiles: ['pending://raster/{z}/{x}/{y}.png'],
      sourceId: 'raster',
      rejectTile: () => false
    });
    const rasterTile = new AbortController();
    const raster = loader.getTileData({index: {x: 1, y: 2, z: 3}, signal: rasterTile.signal} as any);
    const demTile = new AbortController();
    const dem = loadDemTile('pending://dem/3/1/2.png', [1, 1, 1, 0] as any, {
      signal: demTile.signal
    });
    await vi.waitFor(() => expect(controllers).toHaveLength(2));
    rasterTile.abort();
    demTile.abort();
    await expect(raster).rejects.toMatchObject({name: 'AbortError'});
    await expect(dem).rejects.toMatchObject({name: 'AbortError'});
    expect(controllers.map(controller => controller.signal.aborted)).toEqual([true, true]);
  });

  test('a vector tile that deck.gl cancels aborts the handler', async () => {
    const controllers = registerPendingProtocol();
    const tile = new AbortController();
    const layerFetch = getBasemapLayerFetch(DEFAULT_MVT_FETCH, 'arrayBuffer');
    const request = layerFetch('pending://tiles/0/0/0.pbf', {
      propName: 'data',
      layer: {props: {loaders: []}, getLoadOptions: () => null} as any,
      signal: tile.signal
    });
    await vi.waitFor(() => expect(controllers).toHaveLength(1));
    tile.abort();
    await expect(request).rejects.toMatchObject({name: 'AbortError'});
    expect(controllers[0].signal.aborted).toBe(true);
  });

  test('a tile request carries the headers of fetchOptions; an empty tile has no data', async () => {
    const {requests} = registerMemoryProtocol({'mem://tiles/0/0/0.png': new ArrayBuffer(0)});
    const tile = await getBasemapLayerFetch(DEFAULT_MVT_FETCH, 'image')('mem://tiles/0/0/0.png', {
      propName: 'data',
      layer: {props: {loaders: []}, getLoadOptions: () => ({fetchOptions: {headers: {a: 'b'}}})} as any
    });
    expect(tile).toBeNull();
    expect(requests).toEqual([{url: 'mem://tiles/0/0/0.png', type: 'image', headers: {a: 'b'}}]);
  });

  test('the layer fetch is the same function for the same fetch, so tile layer props stay equal', () => {
    const deckFetch = (Layer.defaultProps as any).fetch.value;
    expect(getBasemapLayerFetch(deckFetch, 'image')).toBe(getBasemapLayerFetch(deckFetch, 'image'));
    expect(getBasemapLayerFetch(DEFAULT_MVT_FETCH, 'arrayBuffer')).toBe(
      getBasemapLayerFetch(DEFAULT_MVT_FETCH, 'arrayBuffer')
    );
    // BasemapLayer passes deck.gl's default fetch on, which cannot load a custom scheme.
    expect(new BasemapLayer({style: null}).props.fetch).toBe(deckFetch);
  });

  test("an unknown scheme fails a tile with deck.gl's default fetch with a clear error", async () => {
    const deckFetch = (Layer.defaultProps as any).fetch.value;
    await expect(
      getBasemapLayerFetch(deckFetch, 'image')('foo://tiles/0/0/0.png', {
        propName: 'data',
        layer: {props: {loaders: []}, getLoadOptions: () => null} as any
      }) as Promise<unknown>
    ).rejects.toThrow(/No basemap protocol is registered for "foo:\/\/"/);
  });

  test('a style URL with an unknown scheme fails the style with a clear error', async () => {
    const onError = vi.fn();
    const layer = new BasemapLayer({style: 'foo://basemap/style.json', onError});
    layer.initializeState();
    layer.setState = (state: object) => Object.assign(layer.state, state);
    layer.loadStyle('foo://basemap/style.json', null);
    await vi.waitFor(() => expect(layer.state.loadError).toBeTruthy());
    expect(layer.state.loadError!.message).toMatch(
      /No basemap protocol is registered for "foo:\/\/" \(foo:\/\/basemap\/style\.json\)/
    );
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({kind: 'style', url: 'foo://basemap/style.json'})
    );
  });
});
