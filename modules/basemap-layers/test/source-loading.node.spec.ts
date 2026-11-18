// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/* eslint-disable import/no-extraneous-dependencies */
import {afterEach, describe, expect, test, vi} from 'vitest';
import {log} from '@deck.gl/core';
import {getBasemapLayers} from '../src/index.ts';
import {BasemapLayer} from '../src/basemap-layer';
import {load} from '@loaders.gl/core';
import {MapStyleLoader} from '../src/map-style-loader';
import {resolveBasemapStyle} from '../src/style-resolver';

/** A fetch that serves TileJSON documents by URL and answers 404 for anything else. */
function fakeFetch(documents: Record<string, unknown>) {
  const requested: string[] = [];
  const fetch = (async (url: string) => {
    requested.push(url);
    const document = documents[url];
    return document
      ? {ok: true, status: 200, json: async () => document}
      : {
          ok: false,
          status: 404,
          json: async () => {
            throw new Error('not JSON');
          }
        };
  }) as unknown as typeof globalThis.fetch;
  return {fetch, requested};
}

const TILEJSON_URL = 'https://tiles.example.com/streets.json';
const TILEJSON = {tiles: ['https://tiles.example.com/{z}/{x}/{y}.mvt'], maxzoom: 14};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('source loading', () => {
  test('an image source does not fetch its url as TileJSON, and the style loads', async () => {
    const {fetch, requested} = fakeFetch({[TILEJSON_URL]: TILEJSON});
    const style = await resolveBasemapStyle(
      {
        version: 8,
        sources: {
          streets: {type: 'vector', url: TILEJSON_URL},
          overlay: {
            type: 'image',
            url: 'https://images.example.com/overlay.png',
            coordinates: [
              [0, 1],
              [1, 1],
              [1, 0],
              [0, 0]
            ]
          }
        },
        layers: []
      } as any,
      {fetch}
    );

    expect(requested).toEqual([TILEJSON_URL]);
    expect(style.sources.overlay.url).toBe('https://images.example.com/overlay.png');
    expect(style.sources.streets.tiles).toEqual(TILEJSON.tiles);
  });

  test('a TileJSON that cannot be fetched skips that source, not the style', async () => {
    const warn = vi.spyOn(log, 'warn');
    const {fetch} = fakeFetch({[TILEJSON_URL]: TILEJSON});
    const style = await resolveBasemapStyle(
      {
        version: 8,
        sources: {
          streets: {type: 'vector', url: TILEJSON_URL},
          missing: {type: 'vector', url: 'https://tiles.example.com/missing.json'}
        },
        layers: [
          {id: 'roads', type: 'line', source: 'streets', 'source-layer': 'roads'},
          {id: 'other', type: 'line', source: 'missing', 'source-layer': 'roads'}
        ]
      } as any,
      {fetch}
    );

    expect(style.sources.streets.tiles).toEqual(TILEJSON.tiles);
    expect(style.sources.missing.tiles).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Source "missing"'));

    const layers = getBasemapLayers({
      idPrefix: 'test',
      mode: 'map',
      zoom: 5,
      styleDefinition: style
    });
    const ids = layers.map(layer => layer.id);
    expect(ids).toContain('test-streets');
    expect(ids).not.toContain('test-missing');
  });

  test('a source keeps its inline tiles when its TileJSON cannot be fetched', async () => {
    const warn = vi.spyOn(log, 'warn');
    const {fetch} = fakeFetch({});
    const inlineTiles = ['https://tiles.example.com/inline/{z}/{x}/{y}.mvt'];
    const style = await resolveBasemapStyle(
      {
        version: 8,
        sources: {
          streets: {
            type: 'vector',
            url: 'https://tiles.example.com/missing.json',
            tiles: inlineTiles
          }
        },
        layers: [{id: 'roads', type: 'line', source: 'streets', 'source-layer': 'roads'}]
      } as any,
      {fetch}
    );

    expect(style.sources.streets.tiles).toEqual(inlineTiles);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('using its inline tiles'));
    const ids = getBasemapLayers({
      idPrefix: 'test',
      mode: 'map',
      zoom: 5,
      styleDefinition: style
    }).map(layer => layer.id);
    expect(ids).toContain('test-streets');
  });

  test('an aborted TileJSON fetch rejects the style', async () => {
    const fetch = (async () => {
      const error = new Error('The operation was aborted.');
      error.name = 'AbortError';
      throw error;
    }) as unknown as typeof globalThis.fetch;
    await expect(
      resolveBasemapStyle(
        {
          version: 8,
          sources: {streets: {type: 'vector', url: TILEJSON_URL}},
          layers: [{id: 'roads', type: 'line', source: 'streets', 'source-layer': 'roads'}]
        } as any,
        {fetch}
      )
    ).rejects.toMatchObject({name: 'AbortError'});
  });

  test('an aborted caller signal rejects the style, with the default and a custom reason', async () => {
    for (const reason of [undefined, new Error('superseded')]) {
      const controller = new AbortController();
      const fetch = (async (_url: string, init?: RequestInit) => {
        controller.abort(reason);
        throw init?.signal?.reason ?? new Error('aborted');
      }) as unknown as typeof globalThis.fetch;
      const load = resolveBasemapStyle(
        {
          version: 8,
          sources: {streets: {type: 'vector', url: TILEJSON_URL}},
          layers: []
        } as any,
        {fetch, fetchOptions: {signal: controller.signal}}
      );
      await expect(load).rejects.toBe(controller.signal.reason);
    }
  });

  test('a timeout inside fetch, without an aborted caller signal, only skips the source', async () => {
    vi.spyOn(log, 'warn');
    const fetch = (async () => {
      const error = new Error('timed out');
      error.name = 'TimeoutError';
      throw error;
    }) as unknown as typeof globalThis.fetch;
    const style = await resolveBasemapStyle(
      {version: 8, sources: {streets: {type: 'vector', url: TILEJSON_URL}}, layers: []} as any,
      {fetch}
    );
    expect(style.sources.streets.tiles).toBeUndefined();
  });

  test('a malformed TileJSON skips that source instead of failing the style', async () => {
    const warn = vi.spyOn(log, 'warn');
    const {fetch} = fakeFetch({
      'https://tiles.example.com/null-maxzoom.json': {tiles: TILEJSON.tiles, maxzoom: null},
      'https://tiles.example.com/string-tiles.json': {
        tiles: 'https://tiles.example.com/{z}/{x}/{y}.mvt'
      },
      [TILEJSON_URL]: TILEJSON
    });
    const style = await resolveBasemapStyle(
      {
        version: 8,
        sources: {
          streets: {type: 'vector', url: TILEJSON_URL},
          nullMaxzoom: {type: 'vector', url: 'https://tiles.example.com/null-maxzoom.json'},
          stringTiles: {type: 'vector', url: 'https://tiles.example.com/string-tiles.json'}
        },
        layers: []
      } as any,
      {fetch}
    );
    expect(style.sources.streets.tiles).toEqual(TILEJSON.tiles);
    expect(style.sources.nullMaxzoom.tiles).toBeUndefined();
    expect(style.sources.stringTiles.tiles).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Source "nullMaxzoom"'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Source "stringTiles"'));
  });

  test("the style's own source properties take precedence over the TileJSON", async () => {
    const {fetch} = fakeFetch({
      [TILEJSON_URL]: {tiles: TILEJSON.tiles, minzoom: 2, maxzoom: 14, attribution: 'TileJSON'}
    });
    const inlineTiles = ['https://cdn.example.com/{z}/{x}/{y}.mvt'];
    const style = await resolveBasemapStyle(
      {
        version: 8,
        sources: {streets: {type: 'vector', url: TILEJSON_URL, tiles: inlineTiles, maxzoom: 12}},
        layers: []
      } as any,
      {fetch}
    );
    expect(style.sources.streets.tiles).toEqual(inlineTiles);
    expect(style.sources.streets.maxzoom).toBe(12);
    // Fields the style leaves out still come from the TileJSON.
    expect(style.sources.streets.minzoom).toBe(2);
    expect(style.sources.streets.attribution).toBe('TileJSON');
  });

  test('TileJSON fields other than the source fields are ignored', async () => {
    const tileJson = JSON.parse(
      `{"type": "baselayer", "url": "https://elsewhere.example.com/", "name": "x", "__proto__": {"polluted": true}, "tiles": ${JSON.stringify(TILEJSON.tiles)}}`
    );
    const {fetch} = fakeFetch({[TILEJSON_URL]: tileJson});
    const style = await resolveBasemapStyle(
      {
        version: 8,
        sources: {streets: {type: 'vector', url: TILEJSON_URL}},
        layers: [{id: 'roads', type: 'line', source: 'streets', 'source-layer': 'roads'}]
      } as any,
      {fetch}
    );
    const source = style.sources.streets;
    expect(source.type).toBe('vector');
    expect(source.url).toBe(TILEJSON_URL);
    expect(source.name).toBeUndefined();
    expect(Object.getPrototypeOf(source)).toBe(Object.prototype);
    expect((source as any).polluted).toBeUndefined();
    const ids = getBasemapLayers({
      idPrefix: 'test',
      mode: 'map',
      zoom: 5,
      styleDefinition: style
    }).map(layer => layer.id);
    expect(ids).toContain('test-streets');
  });

  test('image and video sources are not fetched', async () => {
    const {fetch, requested} = fakeFetch({});
    await resolveBasemapStyle(
      {
        version: 8,
        sources: {
          photo: {
            type: 'image',
            url: 'https://media.example.com/photo.png',
            coordinates: [
              [0, 1],
              [1, 1],
              [1, 0],
              [0, 0]
            ]
          },
          clip: {type: 'video', url: 'https://media.example.com/clip.mp4'}
        },
        layers: []
      } as any,
      {fetch}
    );
    expect(requested).toEqual([]);
  });

  test("a raster-dem source's TileJSON is fetched, with its encoding", async () => {
    const {fetch, requested} = fakeFetch({
      'https://tiles.example.com/terrain.json': {
        tiles: ['https://tiles.example.com/terrain/{z}/{x}/{y}.png'],
        encoding: 'terrarium',
        maxzoom: 12
      }
    });
    const style = await resolveBasemapStyle(
      {
        version: 8,
        sources: {terrain: {type: 'raster-dem', url: 'https://tiles.example.com/terrain.json'}},
        layers: []
      } as any,
      {fetch}
    );
    expect(requested).toEqual(['https://tiles.example.com/terrain.json']);
    expect(style.sources.terrain).toMatchObject({
      type: 'raster-dem',
      tiles: ['https://tiles.example.com/terrain/{z}/{x}/{y}.png'],
      encoding: 'terrarium',
      maxzoom: 12
    });
  });

  test('relative inline tiles resolve against the style URL whether or not the TileJSON loads', async () => {
    const style = {
      version: 8,
      sources: {
        streets: {
          type: 'vector',
          url: 'https://b.example.com/tiles.json',
          tiles: ['tiles/{z}/{x}/{y}.mvt']
        }
      },
      layers: []
    } as any;
    const expected = ['https://a.example.com/styles/tiles/{z}/{x}/{y}.mvt'];
    const options = {baseUrl: 'https://a.example.com/styles/style.json'};

    const loaded = await resolveBasemapStyle(style, {
      ...options,
      fetch: fakeFetch({'https://b.example.com/tiles.json': {minzoom: 0}}).fetch
    });
    expect(loaded.sources.streets.tiles).toEqual(expected);

    vi.spyOn(log, 'warn');
    const failed = await resolveBasemapStyle(style, {...options, fetch: fakeFetch({}).fetch});
    expect(failed.sources.streets.tiles).toEqual(expected);
  });

  test('a raster source whose TileJSON fails skips its raster layer', async () => {
    vi.spyOn(log, 'warn');
    const style = await resolveBasemapStyle(
      {
        version: 8,
        sources: {imagery: {type: 'raster', url: 'https://tiles.example.com/imagery.json'}},
        layers: [{id: 'satellite', type: 'raster', source: 'imagery'}]
      } as any,
      {fetch: fakeFetch({}).fetch}
    );
    const ids = getBasemapLayers({
      idPrefix: 'test',
      mode: 'map',
      zoom: 5,
      styleDefinition: style
    }).map(layer => layer.id);
    expect(ids).not.toContain('test-satellite');
  });

  test('a fetch that rejects with no error still skips only that source', async () => {
    vi.spyOn(log, 'warn');
    const fetch = (async () => Promise.reject()) as unknown as typeof globalThis.fetch;
    const style = await resolveBasemapStyle(
      {version: 8, sources: {streets: {type: 'vector', url: TILEJSON_URL}}, layers: []} as any,
      {fetch}
    );
    expect(style.sources.streets.tiles).toBeUndefined();
  });
});

describe('relative TileJSON tile templates', () => {
  /** Resolves one vector source whose TileJSON at `tileJsonUrl` lists `tiles`. */
  async function resolveTiles(tileJsonUrl: string, tiles: string[]) {
    const {fetch} = fakeFetch({[tileJsonUrl]: {tiles}});
    const style = await resolveBasemapStyle(
      {version: 8, sources: {streets: {type: 'vector', url: tileJsonUrl}}, layers: []} as any,
      {fetch}
    );
    return style.sources.streets.tiles;
  }

  test('resolve against a service URL without a trailing slash as a directory', async () => {
    expect(
      await resolveTiles('https://tiles.example.com/rest/services/Streets/VectorTileServer', [
        'tile/{z}/{y}/{x}.pbf'
      ])
    ).toEqual(['https://tiles.example.com/rest/services/Streets/VectorTileServer/tile/{z}/{y}/{x}.pbf']);
  });

  test('resolve against a service URL with a trailing slash', async () => {
    expect(
      await resolveTiles('https://tiles.example.com/rest/services/Streets/VectorTileServer/', [
        'tile/{z}/{y}/{x}.pbf'
      ])
    ).toEqual(['https://tiles.example.com/rest/services/Streets/VectorTileServer/tile/{z}/{y}/{x}.pbf']);
  });

  test('resolve against a map service URL without a trailing slash as a directory', async () => {
    expect(
      await resolveTiles('https://tiles.example.com/rest/services/Imagery/MapServer', [
        'tile/{z}/{y}/{x}'
      ])
    ).toEqual(['https://tiles.example.com/rest/services/Imagery/MapServer/tile/{z}/{y}/{x}']);
  });

  test('resolve against the folder of an extensionless TileJSON URL that is not a service root', async () => {
    expect(
      await resolveTiles('https://example.com/maps/tilejson', ['tiles/{z}/{x}/{y}.pbf'])
    ).toEqual(['https://example.com/maps/tiles/{z}/{x}/{y}.pbf']);
  });

  test('resolve against the folder of a TileJSON URL that names a file', async () => {
    expect(
      await resolveTiles('https://tiles.example.com/v3/tiles.json', ['{z}/{x}/{y}.pbf'])
    ).toEqual(['https://tiles.example.com/v3/{z}/{x}/{y}.pbf']);
    expect(
      await resolveTiles('https://tiles.example.com/v3/tiles.json?key=abc', ['{z}/{x}/{y}.pbf'])
    ).toEqual(['https://tiles.example.com/v3/{z}/{x}/{y}.pbf']);
  });

  test('keep absolute and root-relative templates', async () => {
    const serviceUrl = 'https://tiles.example.com/rest/services/Streets/VectorTileServer';
    expect(
      await resolveTiles(serviceUrl, ['https://cdn.example.com/tiles/{z}/{x}/{y}.pbf'])
    ).toEqual(['https://cdn.example.com/tiles/{z}/{x}/{y}.pbf']);
    expect(await resolveTiles(serviceUrl, ['/tiles/{z}/{x}/{y}.pbf'])).toEqual([
      'https://tiles.example.com/tiles/{z}/{x}/{y}.pbf'
    ]);
  });

  test('keep the query of the template, not the query of the TileJSON URL', async () => {
    expect(
      await resolveTiles('https://tiles.example.com/rest/services/Streets/VectorTileServer?f=json', [
        'tile/{z}/{y}/{x}.pbf?token=abc'
      ])
    ).toEqual([
      'https://tiles.example.com/rest/services/Streets/VectorTileServer/tile/{z}/{y}/{x}.pbf?token=abc'
    ]);
  });

  test('resolve a service URL from a style URL the same way', async () => {
    const styleUrl = 'https://tiles.example.com/rest/services/Streets/VectorTileServer/resources/styles/root.json';
    const serviceUrl = 'https://tiles.example.com/rest/services/Streets/VectorTileServer';
    const {fetch} = fakeFetch({
      [styleUrl]: {version: 8, sources: {esri: {type: 'vector', url: serviceUrl}}, layers: []},
      [serviceUrl]: {tiles: ['tile/{z}/{y}/{x}.pbf']}
    });
    const style = await resolveBasemapStyle(styleUrl, {fetch});
    expect(style.sources.esri.tiles).toEqual([`${serviceUrl}/tile/{z}/{y}/{x}.pbf`]);
  });
});

describe('the source cache', () => {
  const STYLE_URL = 'https://styles.example.com/style.json';
  const style = (url: string) => ({
    version: 8,
    sources: {streets: {type: 'vector', url}},
    layers: []
  });

  test('keeps the TileJSON of a source that did not change, and only the last sources', async () => {
    const otherUrl = 'https://tiles.example.com/other.json';
    const {fetch, requested} = fakeFetch({[TILEJSON_URL]: TILEJSON, [otherUrl]: TILEJSON});
    const sourceCache = new Map();
    await resolveBasemapStyle(style(TILEJSON_URL) as any, {fetch, sourceCache});
    const second = await resolveBasemapStyle(style(TILEJSON_URL) as any, {fetch, sourceCache});
    expect(requested).toEqual([TILEJSON_URL]);
    expect(second.sources.streets.tiles).toEqual(TILEJSON.tiles);

    await resolveBasemapStyle(style(otherUrl) as any, {fetch, sourceCache});
    await resolveBasemapStyle(style(TILEJSON_URL) as any, {fetch, sourceCache});
    expect(requested).toEqual([TILEJSON_URL, otherUrl, TILEJSON_URL]);
    expect(sourceCache.size).toBe(1);
  });

  test('keeps no source that failed to load', async () => {
    const {fetch, requested} = fakeFetch({});
    const sourceCache = new Map();
    vi.spyOn(log, 'warn').mockReturnValue(() => {});
    await resolveBasemapStyle(style(TILEJSON_URL) as any, {fetch, sourceCache});
    await resolveBasemapStyle(style(TILEJSON_URL) as any, {fetch, sourceCache});
    expect(requested).toEqual([TILEJSON_URL, TILEJSON_URL]);
  });

  test('passes through the map style loader for a style URL', async () => {
    const {fetch, requested} = fakeFetch({[TILEJSON_URL]: TILEJSON});
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () => new Response(JSON.stringify(style(TILEJSON_URL)))
    );
    const sourceCache = new Map();
    await load(STYLE_URL, MapStyleLoader, {mapStyle: {fetch, sourceCache}});
    await load(STYLE_URL, MapStyleLoader, {mapStyle: {fetch, sourceCache}});
    expect(requested.filter(url => url === TILEJSON_URL)).toEqual([TILEJSON_URL]);
  });
});

describe('BasemapLayer style loads', () => {
  const TILEJSON = 'https://tiles.example.com/tiles.json';

  /** A style of one vector source, with a new object for each call. */
  const createStyle = (extra: Record<string, unknown> = {}): any => ({
    version: 8,
    sources: {tiles: {type: 'vector', url: TILEJSON}},
    layers: [],
    ...extra
  });

  /** A BasemapLayer whose state updates without a deck. */
  function createLayer(): any {
    const layer: any = new BasemapLayer({id: 'basemap', style: null} as any);
    layer.initializeState();
    layer.setState = (state: any) => Object.assign(layer.state, state);
    return layer;
  }

  /** Loads `style` and waits until it resolves. */
  async function load(layer: any, style: unknown, loadOptions: unknown): Promise<any> {
    const previous = layer.state.resolvedStyle;
    layer.loadStyle(style, loadOptions);
    await vi.waitFor(() => {
      expect(layer.state.resolvedStyle).not.toBe(previous);
      expect(layer.state.resolvedStyle?.sources.tiles.tiles).toBeTruthy();
    });
    return layer.state.resolvedStyle;
  }

  /** `loadOptions` whose TileJSON lists tiles at `host`, served when `ready` resolves. */
  function createOptions(host: string, ready: Promise<void> = Promise.resolve()) {
    const requests: string[] = [];
    const fetch = (async (url: string) => {
      requests.push(url);
      await ready;
      if (url === TILEJSON) {
        return new Response(JSON.stringify({tiles: [`https://${host}/{z}/{x}/{y}.mvt`]}));
      }
      return new Response('', {status: 404});
    }) as typeof globalThis.fetch;
    return {options: {fetch}, requests};
  }

  test('a load superseded by other loadOptions does not fill the cache of the next', async () => {
    const layer = createLayer();
    const a = createOptions('a.example.com');
    let release!: () => void;
    const b = createOptions('b.example.com', new Promise(resolve => (release = resolve)));
    await load(layer, createStyle(), a.options);

    // A slow load with B, then back to A before it ends.
    layer.loadStyle(createStyle(), b.options);
    const style = await load(layer, createStyle(), a.options);
    expect(style.sources.tiles.tiles).toEqual(['https://a.example.com/{z}/{x}/{y}.mvt']);
    release();
    await new Promise(resolve => setTimeout(resolve, 10));

    // The next style with A reads only what A loaded.
    const next = await load(layer, createStyle({metadata: {edit: 1}}), a.options);
    expect(next.sources.tiles.tiles).toEqual(['https://a.example.com/{z}/{x}/{y}.mvt']);
  });

  test('a sprite that failed to load loads again with the next style', async () => {
    vi.spyOn(log, 'warn').mockReturnValue(() => {});
    const layer = createLayer();
    const {options, requests} = createOptions('a.example.com');
    const sprite = {sprite: 'https://assets.example.com/sprite'};
    await load(layer, createStyle(sprite), options);
    await vi.waitFor(() => expect(layer.state.spriteAtlases).toEqual([]));
    await load(layer, createStyle({...sprite, metadata: {edit: 1}}), options);
    await vi.waitFor(() => expect(layer.state.spriteAtlases).toEqual([]));
    const spriteRequests = requests.filter(url => url.includes('sprite'));
    expect(spriteRequests).toEqual([
      'https://assets.example.com/sprite.json',
      'https://assets.example.com/sprite.json'
    ]);
  });

  test('a glyph store with a range that failed is made again for the next style', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const layer = createLayer();
    const {options} = createOptions('a.example.com');
    const glyphs = {glyphs: 'https://assets.example.com/{fontstack}/{range}.pbf'};
    await load(layer, createStyle(glyphs), options);
    const store = layer.state.glyphs;
    await load(layer, createStyle({...glyphs, metadata: {edit: 1}}), options);
    expect(layer.state.glyphs).toBe(store);

    await store.load('Noto Sans Regular', ['a']);
    expect(store.failed).toBe(true);
    await load(layer, createStyle({...glyphs, metadata: {edit: 2}}), options);
    expect(layer.state.glyphs).not.toBe(store);
  });
});
