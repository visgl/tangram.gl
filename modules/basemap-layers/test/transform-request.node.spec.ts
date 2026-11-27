// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/* eslint-disable import/no-extraneous-dependencies */
import {afterEach, describe, expect, test, vi} from 'vitest';
import {BasemapLayer} from '../src/basemap-layer';
import {
  getBasemapLayerFetch,
  getBasemapRequestFetch,
  transformBasemapRequest,
  type BasemapResourceType,
  type BasemapTransformRequest
} from '../src/basemap-request';
import {getBasemapLayers} from '../src/globe-layers';
import {resolveBasemapStyle} from '../src/style-resolver';

const STYLE_URL = 'https://style.example.com/style.json';

const STYLE = {
  version: 8,
  sprite: 'sprite',
  glyphs: 'fonts/{fontstack}/{range}.pbf',
  sources: {
    shapes: {type: 'vector', url: 'tiles.json'},
    points: {type: 'geojson', data: 'points.geojson'},
    relief: {type: 'raster', tiles: ['https://raster.example.com/{z}/{x}/{y}.png']},
    dem: {type: 'raster-dem', tiles: ['https://dem.example.com/{z}/{x}/{y}.png']}
  },
  layers: [
    {id: 'relief', type: 'raster', source: 'relief'},
    {id: 'shade', type: 'hillshade', source: 'dem'},
    {id: 'water', type: 'fill', source: 'shapes', 'source-layer': 'water'},
    {id: 'points', type: 'circle', source: 'points'}
  ]
};

/** The JSON resources of the style, by URL path. Every other URL responds with no bytes. */
const RESOURCES: Record<string, unknown> = {
  '/style.json': STYLE,
  '/tiles.json': {tiles: ['https://vector.example.com/{z}/{x}/{y}.mvt']},
  '/points.geojson': {type: 'FeatureCollection', features: []},
  '/sprite.json': {}
};

type Request = {url: string; init: RequestInit | undefined};

/** A `fetch` that records each request and answers it from `RESOURCES`. */
function createFetch(requests: Request[]): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push({url, init});
    const resource = RESOURCES[new URL(url).pathname];
    return resource === undefined
      ? new Response(new ArrayBuffer(0), {status: 200})
      : new Response(JSON.stringify(resource), {status: 200});
  }) as unknown as typeof fetch;
}

/** Adds a key to each URL and an authorization header and credentials to each request. */
const transformRequest = vi.fn<BasemapTransformRequest>(url => ({
  url: `${url}${url.includes('?') ? '&' : '?'}key=abc`,
  headers: {Authorization: 'Bearer token'},
  credentials: 'include'
}));

/** Asserts that `request` is the transformed request of `url`. */
function expectTransformed(request: Request | undefined, url: string): void {
  expect(request?.url).toBe(`${url}?key=abc`);
  expect(new Headers(request?.init?.headers).get('Authorization')).toBe('Bearer token');
  expect(request?.init?.credentials).toBe('include');
}

/** The request whose URL starts with `url`. */
function findRequest(requests: Request[], url: string): Request | undefined {
  return requests.find(request => request.url.startsWith(url));
}

/** A layer whose state updates in place, without a deck. */
function createLayer(props: Record<string, unknown>): any {
  const layer: any = new BasemapLayer({id: 'basemap', ...props} as any);
  layer.initializeState();
  layer.setState = (partial: Record<string, unknown>) => Object.assign(layer.state, partial);
  // deck.gl's default `fetch` reads the resource manager when the tiles have load options.
  layer.context = {resourceManager: {contains: () => false}};
  return layer;
}

/** Loads the layer's style and waits until it is resolved or has failed. */
async function loadStyle(layer: any): Promise<void> {
  layer.loadStyle(layer.props.style, layer.props.loadOptions, layer.props.transformRequest);
  await vi.waitFor(() => {
    if (!layer.state.resolvedStyle && !layer.state.loadError) {
      throw new Error('The style is still loading');
    }
  });
}

afterEach(() => {
  transformRequest.mockClear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the style request', () => {
  test('uses loadOptions.fetch and loadOptions.fetchOptions', async () => {
    const globalFetch = vi.fn(() => Promise.reject(new Error('global fetch')));
    vi.stubGlobal('fetch', globalFetch);
    const requests: Request[] = [];
    const layer = createLayer({
      style: STYLE_URL,
      loadOptions: {
        fetch: createFetch(requests),
        fetchOptions: {headers: {Authorization: 'Bearer key'}}
      }
    });

    await loadStyle(layer);

    expect(layer.state.loadError).toBeNull();
    expect(globalFetch).not.toHaveBeenCalled();
    expect(requests[0].url).toBe(STYLE_URL);
    expect(new Headers(requests[0].init?.headers).get('Authorization')).toBe('Bearer key');
    // Relative URLs in the style resolve against the style URL.
    expect(findRequest(requests, 'https://style.example.com/tiles.json')).toBeDefined();
  });
});

describe('transformRequest', () => {
  test('changes the style, TileJSON, GeoJSON and sprite requests, with their resource types', async () => {
    // Sprite images are fetched where they can be decoded.
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => ({width: 1, height: 1}))
    );
    const requests: Request[] = [];
    const layer = createLayer({
      style: STYLE_URL,
      loadOptions: {fetch: createFetch(requests)},
      transformRequest
    });

    await loadStyle(layer);
    await vi.waitFor(() => expect(layer.state.spriteAtlases).not.toBeNull());

    expect(layer.state.loadError).toBeNull();
    const calls = transformRequest.mock.calls;
    expect(calls).toContainEqual([STYLE_URL, 'Style']);
    expect(calls).toContainEqual(['https://style.example.com/tiles.json', 'Source']);
    expect(calls).toContainEqual(['https://style.example.com/points.geojson', 'Source']);
    expect(calls).toContainEqual(['https://style.example.com/sprite.json', 'SpriteJSON']);
    expect(calls).toContainEqual(['https://style.example.com/sprite.png', 'SpriteImage']);
    for (const url of [
      STYLE_URL,
      'https://style.example.com/tiles.json',
      'https://style.example.com/points.geojson',
      'https://style.example.com/sprite.json',
      'https://style.example.com/sprite.png'
    ]) {
      expectTransformed(findRequest(requests, url), url);
    }
    // The tile URLs of a TileJSON resolve against its original URL, not the transformed one.
    expect(layer.state.resolvedStyle.sources.shapes.tiles).toEqual([
      'https://vector.example.com/{z}/{x}/{y}.mvt'
    ]);
  });

  test('changes the glyph range requests', async () => {
    const requests: Request[] = [];
    const layer = createLayer({
      style: STYLE_URL,
      loadOptions: {fetch: createFetch(requests)},
      transformRequest
    });
    await loadStyle(layer);

    await layer.state.glyphs.load('Open Sans', ['a']);

    const url = 'https://style.example.com/fonts/Open%20Sans/0-255.pbf';
    expect(transformRequest).toHaveBeenCalledWith(url, 'Glyphs');
    expectTransformed(findRequest(requests, url), url);
  });

  test('changes the vector and raster-dem tile requests of the layer', async () => {
    const requests: Request[] = [];
    const layer = createLayer({
      style: STYLE_URL,
      loadOptions: {fetch: createFetch(requests)},
      transformRequest
    });
    await loadStyle(layer);
    const {resolvedStyle} = layer.state;
    layer.updateSourceTilesets(resolvedStyle);

    const signal = new AbortController().signal;
    const vectorTileset = layer.state.tilesets.get(resolvedStyle.sources.shapes);
    await vectorTileset.opts
      .getTileData({index: {x: 0, y: 0, z: 1}, id: '0-0-1', signal})
      .catch(() => null);
    const vectorUrl = 'https://vector.example.com/1/0/0.mvt';
    expect(transformRequest).toHaveBeenCalledWith(vectorUrl, 'Tile');
    expectTransformed(findRequest(requests, vectorUrl), vectorUrl);
    // The tile request keeps the tile's abort signal.
    expect(findRequest(requests, vectorUrl)?.init?.signal).toBe(signal);

    const demTileset = layer.state.tilesets.get(resolvedStyle.sources.dem);
    const demUrl = 'https://dem.example.com/1/0/0.png';
    await demTileset.opts.getTileData({index: {x: 0, y: 0, z: 1}, id: '0-0-1', signal});
    expect(transformRequest).toHaveBeenCalledWith(demUrl, 'Tile');
    expectTransformed(findRequest(requests, demUrl), demUrl);
  });

  test('changes the raster tile requests, also with rejectRasterTile', async () => {
    const requests: Request[] = [];
    const loadOptions = {fetch: createFetch(requests)};
    const styleDefinition = await resolveBasemapStyle(STYLE_URL, loadOptions);
    const rasterUrl = 'https://raster.example.com/1/0/0.png';
    const getRasterLayer = (props: Record<string, unknown>) =>
      getBasemapLayers({
        idPrefix: 'map',
        zoom: 1,
        styleDefinition,
        loadOptions,
        transformRequest,
        ...props
      }).find(layer => layer.id === 'map-relief');

    // Through the `fetch` prop of the tile layer.
    const raster = getRasterLayer({});
    const tileLayer = {
      context: {resourceManager: {contains: () => false}},
      props: {loaders: []},
      getLoadOptions: () => null
    };
    await Promise.resolve(
      raster.props.fetch(rasterUrl, {propName: 'data', layer: tileLayer, loadOptions})
    ).catch(() => null);
    expectTransformed(findRequest(requests, rasterUrl), rasterUrl);

    // Through the raster tile loader of `rejectRasterTile`.
    requests.length = 0;
    const rejecting = getRasterLayer({rejectRasterTile: () => false});
    await rejecting.props.getTileData({index: {x: 0, y: 0, z: 1}});
    expectTransformed(findRequest(requests, rasterUrl), rasterUrl);
  });

  test('changes the image source request and keeps its abort signal', async () => {
    const url = 'https://images.example.com/overlay.png';
    const requests: Request[] = [];
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({url: String(input), init});
      return new Response(null, {status: 204});
    });
    const styleDefinition = await resolveBasemapStyle({
      version: 8,
      sources: {overlay: {type: 'image', url, coordinates: [[0, 1], [1, 1], [1, 0], [0, 0]]}},
      layers: [{id: 'overlay', type: 'raster', source: 'overlay'}]
    });
    const [image] = getBasemapLayers({styleDefinition, loadOptions: {fetch}, transformRequest});
    image.internalState = {};
    const bitmap = image.renderLayers();
    bitmap.context = {resourceManager: {contains: () => false}};
    const signal = new AbortController().signal;

    await bitmap.props.fetch(image.props.image, {propName: 'image', layer: bitmap, signal});

    expectTransformed(requests[0], url);
    expect(requests[0].init?.signal).toBe(signal);
    expect(transformRequest).toHaveBeenCalledWith(url, 'Image');
  });

  test('changes the tile requests of the tilesets that getBasemapLayers creates', async () => {
    const requests: Request[] = [];
    const loadOptions = {fetch: createFetch(requests)};
    const styleDefinition = await resolveBasemapStyle(STYLE_URL, loadOptions);
    const layers = getBasemapLayers({
      idPrefix: 'map',
      zoom: 1,
      styleDefinition,
      loadOptions,
      transformRequest
    });
    const tile = {index: {x: 0, y: 0, z: 1}, id: '0-0-1'};

    const vector = layers.find(layer => layer.id === 'map-shapes');
    await vector.props.data.opts.getTileData(tile).catch(() => null);
    expectTransformed(
      findRequest(requests, 'https://vector.example.com/1/0/0.mvt'),
      'https://vector.example.com/1/0/0.mvt'
    );

    const hillshade = layers.find(layer => layer.id === 'map-shade');
    await hillshade.props.data.opts.getTileData(tile);
    expectTransformed(
      findRequest(requests, 'https://dem.example.com/1/0/0.png'),
      'https://dem.example.com/1/0/0.png'
    );
  });

  test('loads the style and its tiles again when it changes', async () => {
    const requests: Request[] = [];
    const props = {style: STYLE_URL, loadOptions: {fetch: createFetch(requests)}, transformRequest};
    const layer = createLayer(props);
    await loadStyle(layer);
    layer.updateSourceTilesets(layer.state.resolvedStyle);
    const tileset = layer.state.tilesets.get(layer.state.resolvedStyle.sources.shapes);

    const loadStyleSpy = vi.spyOn(layer, 'loadStyle');
    vi.spyOn(layer, 'updateLabelPlacement').mockImplementation(() => {});
    const nextTransformRequest: BasemapTransformRequest = url => ({url});
    layer.updateState({
      props: {...layer.props, transformRequest: nextTransformRequest},
      oldProps: layer.props,
      changeFlags: {}
    });
    expect(loadStyleSpy).toHaveBeenCalledWith(STYLE_URL, props.loadOptions, nextTransformRequest);

    const nextLayer = createLayer({...props, transformRequest: nextTransformRequest});
    nextLayer.state = layer.state;
    nextLayer.updateSourceTilesets(layer.state.resolvedStyle);
    expect(layer.state.tilesets.get(layer.state.resolvedStyle.sources.shapes)).not.toBe(tileset);
  });
});

describe('transformBasemapRequest', () => {
  test('returns the request as it is without a transformRequest, or when it returns nothing', () => {
    const init = {headers: {A: '1'}};
    expect(transformBasemapRequest(null, 'https://a.example.com/', 'Tile', init)).toEqual({
      url: 'https://a.example.com/',
      init
    });
    const result = transformBasemapRequest(() => undefined, 'https://a.example.com/', 'Tile', init);
    expect(result.url).toBe('https://a.example.com/');
    expect(result.init).toBe(init);
  });

  test('replaces the fields it returns, merges headers by name and keeps the signal', () => {
    const signal = new AbortController().signal;
    const {url, init} = transformBasemapRequest(
      () => ({
        url: 'https://b.example.com/',
        headers: {B: '3', C: '4'},
        credentials: 'include',
        method: 'POST',
        type: 'json',
        collectResourceTiming: true
      }),
      'https://a.example.com/',
      'Style',
      {headers: {A: '1', B: '2'}, credentials: 'omit', signal}
    );
    expect(url).toBe('https://b.example.com/');
    const headers = new Headers(init?.headers);
    expect([...headers.entries()]).toEqual([
      ['a', '1'],
      ['b', '3'],
      ['c', '4']
    ]);
    expect(init?.credentials).toBe('include');
    expect(init?.method).toBe('POST');
    expect(init?.signal).toBe(signal);
    // The MapLibre fields that are not request fields are not passed on.
    expect(init).not.toHaveProperty('type');
    expect(init).not.toHaveProperty('collectResourceTiming');
  });

  test('keeps the URL when the transformed request has none', () => {
    const transform = (() => ({headers: {A: '1'}})) as unknown as BasemapTransformRequest;
    expect(transformBasemapRequest(transform, 'https://a.example.com/', 'Tile').url).toBe(
      'https://a.example.com/'
    );
  });
});

describe('getBasemapRequestFetch', () => {
  test('sends the transformed request with the given fetch', async () => {
    const requests: Request[] = [];
    const fetchFn = getBasemapRequestFetch('Glyphs', {fetch: createFetch(requests), transformRequest});
    await fetchFn('https://a.example.com/0-255.pbf', {headers: {A: '1'}});
    expect(transformRequest).toHaveBeenCalledWith('https://a.example.com/0-255.pbf', 'Glyphs');
    expectTransformed(requests[0], 'https://a.example.com/0-255.pbf');
    expect(new Headers(requests[0].init?.headers).get('A')).toBe('1');
  });

  test('is the given fetch, or the global fetch, without a transformRequest', async () => {
    const fetchFn = createFetch([]);
    expect(getBasemapRequestFetch('Tile', {fetch: fetchFn})).toBe(fetchFn);
    const requests: Request[] = [];
    vi.stubGlobal('fetch', createFetch(requests));
    await getBasemapRequestFetch('Tile')('https://a.example.com/');
    expect(requests[0].url).toBe('https://a.example.com/');
  });
});

describe('getBasemapLayerFetch', () => {
  const resourceTypes: BasemapResourceType[] = [];
  const recordType: BasemapTransformRequest = (url, resourceType) => {
    resourceTypes.push(resourceType);
    return {url: `${url}?key=abc`, headers: {Authorization: 'Bearer token'}};
  };

  test('is the next fetch without a transformRequest, and the same function for the same arguments', () => {
    const nextFetch = vi.fn();
    expect(getBasemapLayerFetch(nextFetch, null)).toBe(nextFetch);
    expect(getBasemapLayerFetch(nextFetch, recordType)).toBe(
      getBasemapLayerFetch(nextFetch, recordType)
    );
    expect(getBasemapLayerFetch(nextFetch, recordType)).not.toBe(
      getBasemapLayerFetch(nextFetch, transformRequest)
    );
  });

  test('loads the transformed tile URL, with a loader fetch that adds the request fields', async () => {
    const nextFetch = vi.fn((_url: string, _context: any) => null);
    const requests: Request[] = [];
    const baseFetch = createFetch(requests);
    const signal = new AbortController().signal;
    const context: any = {propName: 'data', layer: {}, loadOptions: {fetch: baseFetch}, signal};

    getBasemapLayerFetch(nextFetch, recordType)('https://a.example.com/1/0/0.mvt', context);

    expect(resourceTypes).toContain('Tile');
    const [url, nextContext] = nextFetch.mock.calls[0];
    expect(url).toBe('https://a.example.com/1/0/0.mvt?key=abc');
    expect(nextContext.signal).toBe(signal);
    // The loader options' own fetch sends the request, with the headers and the tile's signal.
    await nextContext.loadOptions.fetch(url, {headers: {A: '1'}});
    expect(requests[0].url).toBe(url);
    const headers = new Headers(requests[0].init?.headers);
    expect(headers.get('A')).toBe('1');
    expect(headers.get('Authorization')).toBe('Bearer token');
    expect(requests[0].init?.signal).toBe(signal);
  });

  test('sends with the global fetch and the request options of an object loader fetch', async () => {
    const requests: Request[] = [];
    vi.stubGlobal('fetch', createFetch(requests));
    const nextFetch = vi.fn((_url: string, _context: any) => null);
    const context: any = {
      propName: 'data',
      layer: {getLoadOptions: () => ({fetch: {cache: 'no-store'}})}
    };

    getBasemapLayerFetch(nextFetch, recordType)('https://a.example.com/1/0/0.png', context);
    const [url, nextContext] = nextFetch.mock.calls[0];
    await nextContext.loadOptions.fetch(url);

    expect(requests[0].init?.cache).toBe('no-store');
    expect(new Headers(requests[0].init?.headers).get('Authorization')).toBe('Bearer token');
  });

  test('keeps the context when the transformed request only changes the URL', () => {
    const nextFetch = vi.fn();
    const context: any = {propName: 'data', layer: {}, loadOptions: {a: 1}};
    getBasemapLayerFetch(nextFetch, url => ({url: `${url}?v=2`}))(
      'https://a.example.com/1/0/0.png',
      context
    );
    expect(nextFetch).toHaveBeenCalledWith('https://a.example.com/1/0/0.png?v=2', context);
  });
});
