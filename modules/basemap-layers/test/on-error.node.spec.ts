// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/* eslint-disable import/no-extraneous-dependencies */
import {afterEach, describe, expect, test, vi} from 'vitest';
import {load} from '@loaders.gl/core';
import {BasemapLayer} from '../src/basemap-layer.ts';
import {BasemapLoadError} from '../src/index.ts';

const TILES_URL = 'https://tiles.example.com';
const GLYPHS = `${TILES_URL}/fonts/{fontstack}/{range}.pbf`;

/** A fetch that answers `body` for the URLs in `documents` and `status` for anything else. */
function fakeFetch(documents: Record<string, unknown> = {}, status = 404) {
  return vi.fn(async (url: string) =>
    url in documents
      ? new Response(JSON.stringify(documents[url]), {status: 200})
      : new Response('{}', {status})
  ) as unknown as typeof fetch;
}

/**
 * A basemap set up as deck.gl sets up a layer, with an `onError` prop and `props`, in a deck whose
 * `onError` is `deckOnError`.
 */
function basemap(props: Record<string, unknown>) {
  const onError = vi.fn<(error: BasemapLoadError) => boolean | void>();
  const deckOnError = vi.fn();
  const layer: any = new BasemapLayer({id: 'basemap', onError, ...props} as any);
  layer.context = {layerManager: {}, onError: deckOnError};
  layer.internalState = {layer};
  layer.initializeState();
  layer.setState = (partial: Record<string, unknown>) => Object.assign(layer.state, partial);
  layer.updateState({
    props: layer.props,
    oldProps: {style: null},
    changeFlags: {}
  });
  return {layer, onError, deckOnError};
}

/** Waits for the style of `layer` to resolve or fail, and for its sprites. */
async function settled(layer: any) {
  await vi.waitFor(() => {
    expect(layer.state.loadError || layer.state.spriteAtlases).toBeTruthy();
  });
}

function style(overrides: Record<string, unknown>) {
  return {version: 8, sources: {}, layers: [], ...overrides};
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('BasemapLayer onError', () => {
  test('a style URL that fails calls onError once, with kind style', async () => {
    vi.stubGlobal('fetch', fakeFetch({}, 404));
    const styleUrl = `${TILES_URL}/missing-style.json`;
    const {layer, onError} = basemap({style: styleUrl});
    await settled(layer);
    expect(onError).toHaveBeenCalledTimes(1);
    const [event] = onError.mock.calls[0];
    expect(event).toBeInstanceOf(BasemapLoadError);
    expect(event).toMatchObject({kind: 'style', url: styleUrl, status: 404});
    expect(event.cause).toBe(layer.state.loadError);
  });

  test('a style URL loads with the fetch and fetchOptions of loadOptions', async () => {
    const globalFetch = vi.fn(async () => new Response('{}', {status: 500}));
    vi.stubGlobal('fetch', globalFetch);
    const styleUrl = `${TILES_URL}/style.json`;
    const fetchFn = fakeFetch({[styleUrl]: style({})});
    const fetchOptions = {headers: {Authorization: 'Bearer token'}};
    const {layer, onError} = basemap({style: styleUrl, loadOptions: {fetch: fetchFn, fetchOptions}});
    await settled(layer);
    expect(onError).not.toHaveBeenCalled();
    expect(layer.state.resolvedStyle).toBeTruthy();
    expect(globalFetch).not.toHaveBeenCalled();
    expect(fetchFn).toHaveBeenCalledWith(styleUrl, expect.objectContaining(fetchOptions));
  });

  test('a source TileJSON that answers 404 calls onError once, with kind source', async () => {
    const tileJsonUrl = `${TILES_URL}/streets.json`;
    const {layer, onError} = basemap({
      style: style({sources: {streets: {type: 'vector', url: tileJsonUrl}}}),
      loadOptions: {fetch: fakeFetch()}
    });
    await settled(layer);
    expect(layer.state.resolvedStyle).toBeTruthy();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toMatchObject({
      kind: 'source',
      sourceId: 'streets',
      url: tileJsonUrl,
      status: 404
    });
  });

  test('a sprite that answers 404 calls onError once, with kind sprite', async () => {
    const {layer, onError} = basemap({
      style: style({sprite: `${TILES_URL}/sprite`}),
      loadOptions: {fetch: fakeFetch()}
    });
    await settled(layer);
    expect(layer.state.spriteAtlases).toEqual([]);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toMatchObject({
      kind: 'sprite',
      url: `${TILES_URL}/sprite.json`,
      status: 404
    });
  });

  test('a missing glyph range calls onError once, with kind glyphs', async () => {
    const {layer, onError} = basemap({
      style: style({glyphs: GLYPHS}),
      loadOptions: {fetch: fakeFetch()}
    });
    await settled(layer);
    await layer.state.glyphs.load('Noto Sans Regular', ['Paris']);
    // A range that failed is not requested again.
    await layer.state.glyphs.load('Noto Sans Regular', ['Paris']);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toMatchObject({
      kind: 'glyphs',
      url: `${TILES_URL}/fonts/Noto%20Sans%20Regular/0-255.pbf`,
      status: 404
    });
  });

  describe('tiles', () => {
    const SOURCES = {
      streets: {type: 'vector', tiles: [`${TILES_URL}/streets/{z}/{x}/{y}.mvt`]},
      relief: {type: 'raster', tiles: [`${TILES_URL}/relief/{z}/{x}/{y}.png`]}
    };
    const LAYERS = [
      {id: 'water', type: 'fill', source: 'streets', 'source-layer': 'water'},
      {id: 'relief', type: 'raster', source: 'relief'},
      {id: 'roads', type: 'line', source: 'streets', 'source-layer': 'road'}
    ];

    async function renderedBasemap() {
      const result = basemap({style: style({sources: SOURCES, layers: LAYERS})});
      await settled(result.layer);
      return {...result, sublayers: result.layer.renderLayers().flat(Infinity) as any[]};
    }

    /** The error that loaders.gl rejects with for a response of `status`. */
    async function fetchError(url: string, status: number): Promise<Error> {
      const fetchFn = fakeFetch({}, status);
      const loader = {name: 'test', extensions: ['png'], parse: async () => null} as any;
      const options = {fetch: (input: string) => fetchFn(input)} as any;
      return await load(url, loader, options).then(
        () => {
          throw new Error('expected the load to fail');
        },
        (error: Error) => error
      );
    }

    test('a raster tile that answers 500 calls onError once, with kind tile', async () => {
      const {sublayers, onError} = await renderedBasemap();
      const relief = sublayers.find(sublayer => sublayer.id === 'basemap-relief');
      const url = `${TILES_URL}/relief/3/1/2.png`;
      const error = await fetchError(url, 500);
      relief.props.onTileError(error, {index: {x: 1, y: 2, z: 3}});
      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError.mock.calls[0][0]).toMatchObject({
        kind: 'tile',
        sourceId: 'relief',
        url,
        status: 500,
        tile: {x: 1, y: 2, z: 3},
        cause: error
      });
    });

    test('a failed vector tile calls onError once for all the layers of its source', async () => {
      const {sublayers, onError} = await renderedBasemap();
      const vectorLayers = sublayers.filter(sublayer =>
        String(sublayer.id).startsWith('basemap-streets')
      );
      // The source's two runs share one tileset, which reports a failed tile to each of them.
      expect(vectorLayers).toHaveLength(2);
      const error = await fetchError(`${TILES_URL}/streets/3/1/2.mvt`, 500);
      const tile = {index: {x: 1, y: 2, z: 3}};
      for (const vectorLayer of vectorLayers) {
        vectorLayer.props.onTileError(error, tile);
      }
      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError.mock.calls[0][0]).toMatchObject({
        kind: 'tile',
        sourceId: 'streets',
        status: 500,
        tile: {x: 1, y: 2, z: 3}
      });
    });

    test('a vector tile that answers 404 has no data, and does not call onError', async () => {
      // As in MapLibre GL JS. A raster tile that answers 404 is a failure, as there.
      const {sublayers, onError} = await renderedBasemap();
      const streets = sublayers.find(sublayer => String(sublayer.id).startsWith('basemap-streets'));
      const error = await fetchError(`${TILES_URL}/streets/3/1/2.mvt`, 404);
      streets.props.onTileError(error, {index: {x: 1, y: 2, z: 3}});
      expect(onError).not.toHaveBeenCalled();
    });

    test('an aborted tile does not call onError', async () => {
      const {sublayers, onError, deckOnError} = await renderedBasemap();
      const relief = sublayers.find(sublayer => sublayer.id === 'basemap-relief');
      const abort = new AbortController();
      abort.abort();
      relief.props.onTileError(abort.signal.reason, {index: {x: 1, y: 2, z: 3}});
      expect(abort.signal.reason.name).toBe('AbortError');
      expect(onError).not.toHaveBeenCalled();
      expect(deckOnError).not.toHaveBeenCalled();
    });
  });

  test('without a layer onError, the deck onError receives the failure', async () => {
    const {layer, deckOnError} = basemap({
      onError: null,
      style: style({sprite: `${TILES_URL}/sprite`}),
      loadOptions: {fetch: fakeFetch()}
    });
    await settled(layer);
    expect(deckOnError).toHaveBeenCalledTimes(1);
    const [error, source] = deckOnError.mock.calls[0];
    expect(error).toMatchObject({kind: 'sprite', url: `${TILES_URL}/sprite.json`});
    expect(source).toBe(layer);
  });

  test('a layer onError that returns true keeps the failure from the deck onError', async () => {
    const {layer, onError, deckOnError} = basemap({
      style: style({sprite: `${TILES_URL}/sprite`}),
      loadOptions: {fetch: fakeFetch()}
    });
    onError.mockReturnValue(true);
    await settled(layer);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(deckOnError).not.toHaveBeenCalled();
  });
});
