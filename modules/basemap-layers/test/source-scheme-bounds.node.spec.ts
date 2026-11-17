// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/* eslint-disable import/no-extraneous-dependencies */
import {SharedMVTLayer} from '@deck.gl-community/geo-layers';
import {WebMercatorViewport} from '@deck.gl/core';
import {TileLayer, _getURLFromTemplate as getURLFromTemplate} from '@deck.gl/geo-layers';
import {afterEach, describe, expect, test, vi} from 'vitest';
import {BasemapLayer} from '../src/basemap-layer';
import {createDemTileset, getBasemapLayers} from '../src/globe-layers';
import {getRasterTileLoader} from '../src/raster-tile-loader';
import {getSourceTileBounds, getSourceTileTemplates, isTileInBounds} from '../src/source-tiles';
import {resolveBasemapStyle} from '../src/style-resolver';

afterEach(() => vi.restoreAllMocks());

const TEMPLATE = 'https://tiles.example.com/{z}/{x}/{y}.png';

/** The row of a tile in a TMS service, as MapLibre GL JS writes `{y}` for `scheme: "tms"`. */
function tmsRow(y: number, z: number): number {
  return 2 ** z - y - 1;
}

/** Tile indices at several zooms, with the first and last rows of each. */
const INDICES = [
  {x: 0, y: 0, z: 0},
  {x: 1, y: 0, z: 1},
  {x: 0, y: 1, z: 1},
  {x: 5, y: 2, z: 3},
  {x: 3, y: 7, z: 3},
  {x: 523, y: 351, z: 10},
  {x: 70000, y: 1, z: 17}
];

function expand(templates: string[] | undefined, index: {x: number; y: number; z: number}) {
  return getURLFromTemplate(templates!, {index, id: `${index.x}-${index.y}-${index.z}`});
}

describe('scheme', () => {
  test('"tms" flips the row of every tile, at every zoom, as MapLibre GL JS does', () => {
    const templates = getSourceTileTemplates({type: 'raster', tiles: [TEMPLATE], scheme: 'tms'});
    for (const {x, y, z} of INDICES) {
      expect(expand(templates, {x, y, z}), `${z}/${x}/${y}`).toBe(
        `https://tiles.example.com/${z}/${x}/${tmsRow(y, z)}.png`
      );
    }
  });

  test('"xyz" and no scheme keep the row, and the same templates', () => {
    for (const scheme of ['xyz', undefined]) {
      const tiles = [TEMPLATE];
      const templates = getSourceTileTemplates({type: 'vector', tiles, scheme});
      expect(templates).toBe(tiles);
      for (const {x, y, z} of INDICES) {
        expect(expand(templates, {x, y, z})).toBe(`https://tiles.example.com/${z}/${x}/${y}.png`);
      }
    }
  });

  test('"tms" flips every `{y}` of every template, and only `{y}`', () => {
    const templates = getSourceTileTemplates({
      type: 'vector',
      tiles: ['https://a.example.com/{z}/{x}/{y}.pbf?row={y}', 'https://b.example.com/{y}/{x}'],
      scheme: 'tms'
    });
    expect(templates).toEqual([
      'https://a.example.com/{z}/{x}/{-y}.pbf?row={-y}',
      'https://b.example.com/{-y}/{x}'
    ]);
  });

  test('the flipped templates of a source are the same array while its tiles stay the same', () => {
    const source = {type: 'raster', tiles: [TEMPLATE], scheme: 'tms'};
    const templates = getSourceTileTemplates(source);
    expect(getSourceTileTemplates(source)).toBe(templates);
    source.tiles = ['https://other.example.com/{z}/{x}/{y}.png'];
    expect(getSourceTileTemplates(source)).toEqual(['https://other.example.com/{z}/{x}/{-y}.png']);
  });
});

const TMS_STYLE: any = {
  version: 8,
  sources: {
    vector: {type: 'vector', tiles: ['https://v.example.com/{z}/{x}/{y}.mvt'], scheme: 'tms'},
    raster: {type: 'raster', tiles: ['https://r.example.com/{z}/{x}/{y}.png'], scheme: 'tms'},
    dem: {type: 'raster-dem', tiles: ['https://d.example.com/{z}/{x}/{y}.png'], scheme: 'tms'}
  },
  layers: [
    {id: 'imagery', type: 'raster', source: 'raster'},
    {id: 'water', type: 'fill', source: 'vector', 'source-layer': 'water'}
  ]
};

describe('scheme in the layers', () => {
  const index = {x: 5, y: 2, z: 3};
  const flipped = tmsRow(index.y, index.z);

  test('a vector source loads its tiles from the flipped row', async () => {
    const layers = getBasemapLayers({idPrefix: 't', mode: 'map', zoom: 3, styleDefinition: TMS_STYLE});
    const vector: any = layers.find(layer => layer.id === 't-vector');
    const urls: string[] = [];
    vi.spyOn(SharedMVTLayer.prototype, 'getTileData').mockImplementation(function (
      this: SharedMVTLayer,
      tile
    ) {
      urls.push(getURLFromTemplate(this.props.data as string[], tile)!);
      return Promise.resolve([] as any);
    });
    await vector.props.data.opts.getTileData({index, id: '5-2-3', bbox: {}});
    expect(urls).toEqual([`https://v.example.com/3/5/${flipped}.mvt`]);
  });

  test('a raster source loads its tiles from the flipped row, also through its tile loader', () => {
    const layers = getBasemapLayers({idPrefix: 't', mode: 'map', zoom: 3, styleDefinition: TMS_STYLE});
    const raster: any = layers.find(layer => layer.id === 't-imagery');
    const tile: any = {index, id: '5-2-3'};
    TileLayer.prototype.getTileData.call(
      {props: {...raster.props, getTileData: null, fetch: () => null}} as any,
      tile
    );
    expect(tile.url).toBe(`https://r.example.com/3/5/${flipped}.png`);

    const loader = getRasterTileLoader(TMS_STYLE.sources.raster, {
      sourceId: 'raster',
      rejectTile: () => false
    });
    expect(expand(loader.options.tiles, index)).toBe(`https://r.example.com/3/5/${flipped}.png`);
  });

  test('a raster-dem source loads its tiles from the flipped row', async () => {
    const urls: string[] = [];
    const fetchTile = vi.fn(async (url: string | URL | Request) => {
      urls.push(String(url));
      return new Response(new Blob([]));
    });
    const tileset: any = createDemTileset(TMS_STYLE.sources.dem, {
      fetch: fetchTile as typeof fetch
    });
    await tileset.opts.getTileData({index, id: '5-2-3', bbox: {}} as any);
    expect(urls).toEqual([`https://d.example.com/3/5/${flipped}.png`]);
  });
});

/** MapLibre GL JS's `TileBounds.contains`, written out: the tiles a source with `bounds` loads. */
function mapLibreContains(
  [west, south, east, north]: number[],
  {x, y, z}: {x: number; y: number; z: number}
) {
  const mercatorX = (lng: number) => (180 + lng) / 360;
  const mercatorY = (lat: number) =>
    (180 - (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))) / 360;
  const worldSize = 2 ** z;
  const w = Math.max(-180, west);
  const s = Math.max(-90, south);
  const e = Math.min(180, east);
  const n = Math.min(90, north);
  return (
    x >= Math.floor(mercatorX(w) * worldSize) &&
    x < Math.ceil(mercatorX(e) * worldSize) &&
    y >= Math.floor(mercatorY(n) * worldSize) &&
    y < Math.ceil(mercatorY(s) * worldSize)
  );
}

describe('bounds', () => {
  test('a source without bounds, or with bounds that are not four numbers, has none', () => {
    expect(getSourceTileBounds({type: 'vector'})).toBeNull();
    expect(getSourceTileBounds({type: 'vector', bounds: [1, 2, 3]})).toBeNull();
    expect(getSourceTileBounds({type: 'vector', bounds: 'world'})).toBeNull();
  });

  test('are clamped to the world, as MapLibre GL JS clamps them', () => {
    expect(getSourceTileBounds({type: 'raster', bounds: [-200, -95, 190, 91]})).toEqual([
      -180, -90, 180, 90
    ]);
    expect(getSourceTileBounds({type: 'raster', bounds: [-10, 40, 10, 50]})).toEqual([
      -10, 40, 10, 50
    ]);
  });

  test('of a source are the same array while its bounds stay the same', () => {
    const source: any = {type: 'raster', bounds: [-10, 40, 10, 50]};
    const bounds = getSourceTileBounds(source);
    expect(getSourceTileBounds(source)).toBe(bounds);
    source.bounds = [-20, 40, 10, 50];
    expect(getSourceTileBounds(source)).toEqual([-20, 40, 10, 50]);
  });

  test('keep the tiles that MapLibre GL JS keeps, at every zoom', () => {
    const cases = [
      [-10, 40, 10, 50],
      [0, 0, 22.5, 21.943045533438177], // Exactly on tile edges at zoom 4.
      [139.6, 35.6, 139.8, 35.7],
      [-180, -85.0511, 180, 85.0511],
      [170, -10, 200, 10], // Clamped at the antimeridian.
      [170, -10, -170, 10] // Across the antimeridian.
    ];
    for (const bounds of cases) {
      const clamped = getSourceTileBounds({bounds})!;
      for (let z = 0; z <= 6; z++) {
        for (let x = 0; x < 2 ** z; x++) {
          for (let y = 0; y < 2 ** z; y++) {
            expect(isTileInBounds({x, y, z}, clamped), `${bounds} ${z}/${x}/${y}`).toBe(
              mapLibreContains(bounds, {x, y, z})
            );
          }
        }
      }
    }
  });

  test('a box across the antimeridian (west > east) keeps no tiles past zoom 0, as in MapLibre GL JS', () => {
    // MapLibre GL JS does not support such bounds: its column range is empty once the west edge
    // and the east edge fall in different columns. At zoom 0 both fall in the one column.
    const bounds = getSourceTileBounds({bounds: [170, -10, -170, 10]})!;
    expect(isTileInBounds({x: 0, y: 0, z: 0}, bounds)).toBe(true);
    for (let z = 1; z <= 5; z++) {
      for (let x = 0; x < 2 ** z; x++) {
        for (let y = 0; y < 2 ** z; y++) {
          expect(isTileInBounds({x, y, z}, bounds), `${z}/${x}/${y}`).toBe(false);
        }
      }
    }
  });

  test('apply to every copy of the world', () => {
    const bounds = getSourceTileBounds({bounds: [-10, 40, 10, 50]})!;
    expect(isTileInBounds({x: 7, y: 5, z: 4}, bounds)).toBe(true);
    expect(isTileInBounds({x: 7 + 16, y: 5, z: 4}, bounds)).toBe(true);
    expect(isTileInBounds({x: 7 - 16, y: 5, z: 4}, bounds)).toBe(true);
    expect(isTileInBounds({x: 3 + 16, y: 5, z: 4}, bounds)).toBe(false);
  });
});

/** Western Europe, around 0, 45 degrees. */
const BOUNDS = [-10, 40, 10, 50];

const BOUNDED_STYLE: any = {
  version: 8,
  sources: {
    vector: {type: 'vector', tiles: ['https://v.example.com/{z}/{x}/{y}.mvt'], bounds: BOUNDS},
    raster: {type: 'raster', tiles: ['https://r.example.com/{z}/{x}/{y}.png'], bounds: BOUNDS},
    detail: {
      type: 'vector',
      tiles: ['https://d.example.com/{z}/{x}/{y}.mvt'],
      bounds: BOUNDS,
      minzoom: 4,
      maxzoom: 6
    },
    dem: {type: 'raster-dem', tiles: ['https://e.example.com/{z}/{x}/{y}.png'], bounds: BOUNDS}
  },
  layers: [
    {id: 'imagery', type: 'raster', source: 'raster'},
    {id: 'water', type: 'fill', source: 'vector', 'source-layer': 'water'},
    {id: 'roads', type: 'line', source: 'detail', 'source-layer': 'roads'}
  ]
};

/** A whole-world view at `zoom`, 4096 pixels wide, so that every tile up to zoom 3 shows. */
function getWorldViewport(zoom: number) {
  const size = 512 * 2 ** zoom;
  return new WebMercatorViewport({longitude: 0, latitude: 0, zoom, width: size, height: size});
}

function getSharedTileIndices(tileset: any, viewport: any): {x: number; y: number; z: number}[] {
  return tileset.getTileIndices({
    viewState: viewport,
    minZoom: tileset.minZoom,
    maxZoom: tileset.maxZoom,
    zRange: null
  });
}

function getLayers(zoom: number, style = BOUNDED_STYLE): Record<string, any> {
  const layers = getBasemapLayers({idPrefix: 't', mode: 'map', zoom, styleDefinition: style});
  return Object.fromEntries(layers.map(layer => [layer.id, layer]));
}

/**
 * The tiles that a raster tile layer requests in `viewport`, through its own tileset class, with
 * no limit on concurrent requests.
 */
async function getRasterRequests(layer: any, viewport: any): Promise<string[]> {
  const requests: string[] = [];
  // The options the layer gives its tileset, with a stub loader.
  const tileset = new layer.props.TilesetClass({
    ...layer._getTilesetOptions(),
    getTileData: ({index: {x, y, z}}: any) => {
      requests.push(`${z}/${x}/${y}`);
      return null;
    },
    onTileLoad: () => {},
    onTileError: () => {},
    onTileUnload: () => {},
    maxRequests: 0
  });
  tileset.update(viewport);
  // Tiles request their data once the request scheduler lets them, after a microtask.
  await new Promise(resolve => setTimeout(resolve, 0));
  return requests.sort();
}

describe('bounds in the layers', () => {
  // Zoom 3: the bounds cover the tiles x 3-4, y 2-3 of an 8 x 8 pyramid.
  const viewport = getWorldViewport(3);
  const expected = ['3/3/2', '3/3/3', '3/4/2', '3/4/3'];

  test('the whole-world view selects every tile of the pyramid without bounds', async () => {
    const layers = getLayers(3, {
      ...BOUNDED_STYLE,
      sources: {
        ...BOUNDED_STYLE.sources,
        raster: {...BOUNDED_STYLE.sources.raster, bounds: undefined},
        vector: {...BOUNDED_STYLE.sources.vector, bounds: undefined}
      }
    });
    expect(await getRasterRequests(layers['t-imagery'], viewport)).toHaveLength(64);
    expect(getSharedTileIndices(layers['t-vector'].props.data, viewport)).toHaveLength(64);
  });

  test('a raster source requests only the tiles in its bounds', async () => {
    const layers = getLayers(3);
    expect(await getRasterRequests(layers['t-imagery'], viewport)).toEqual(expected);
  });

  test('a vector source selects only the tiles in its bounds', () => {
    const layers = getLayers(3);
    const indices = getSharedTileIndices(layers['t-vector'].props.data, viewport);
    expect(indices.map(({x, y, z}) => `${z}/${x}/${y}`).sort()).toEqual(expected);
  });

  test('a raster-dem source selects only the tiles in its bounds', () => {
    const tileset = createDemTileset(BOUNDED_STYLE.sources.dem);
    const indices = getSharedTileIndices(tileset, viewport);
    expect(indices.map(({x, y, z}) => `${z}/${x}/${y}`).sort()).toEqual(expected);
  });

  test('a source with bounds keeps its minzoom and maxzoom', () => {
    // Below minzoom 4: nothing, as without bounds.
    const below = getLayers(3);
    expect(getSharedTileIndices(below['t-detail'].props.data, getWorldViewport(3))).toEqual([]);
    // Past maxzoom 6: the zoom 6 tiles in the bounds, overzoomed.
    const view = new WebMercatorViewport({
      longitude: 0,
      latitude: 45,
      zoom: 9,
      width: 1024,
      height: 1024
    });
    const above = getLayers(9);
    const indices = getSharedTileIndices(above['t-detail'].props.data, view);
    expect(indices.length).toBeGreaterThan(0);
    for (const index of indices) {
      expect(index.z).toBe(6);
      expect(mapLibreContains(BOUNDS, index)).toBe(true);
    }
  });

  test('a view outside the bounds requests no tiles', async () => {
    const tokyo = new WebMercatorViewport({
      longitude: 139.7,
      latitude: 35.7,
      zoom: 8,
      width: 1024,
      height: 1024
    });
    const layers = getLayers(8);
    expect(await getRasterRequests(layers['t-imagery'], tokyo)).toEqual([]);
    expect(getSharedTileIndices(layers['t-vector'].props.data, tokyo)).toEqual([]);
  });
});

describe('BasemapLayer source tilesets', () => {
  test('load a vector source from the flipped row, and only in its bounds', async () => {
    const source = {
      type: 'vector',
      tiles: ['https://v.example.com/{z}/{x}/{y}.mvt'],
      scheme: 'tms',
      bounds: BOUNDS
    };
    const style: any = {
      version: 8,
      sources: {vector: source},
      layers: [{id: 'water', type: 'fill', source: 'vector', 'source-layer': 'water'}]
    };
    const layer: any = new BasemapLayer({id: 'basemap', style} as any);
    layer.state = {tilesets: new Map(), tilesetSourceLayers: new Map()};
    layer.context = {};
    layer.updateSourceTilesets(style);
    const tileset = layer.state.tilesets.get(source);

    const indices = getSharedTileIndices(tileset, getWorldViewport(3));
    expect(indices.map(({x, y, z}) => `${z}/${x}/${y}`).sort()).toEqual([
      '3/3/2',
      '3/3/3',
      '3/4/2',
      '3/4/3'
    ]);

    const urls: string[] = [];
    vi.spyOn(SharedMVTLayer.prototype, 'getTileData').mockImplementation(function (
      this: SharedMVTLayer,
      tile
    ) {
      urls.push(getURLFromTemplate(this.props.data as string[], tile)!);
      return Promise.resolve([] as any);
    });
    await tileset.opts.getTileData({index: {x: 3, y: 2, z: 3}, id: '3-2-3', bbox: {}});
    expect(urls).toEqual([`https://v.example.com/3/3/${tmsRow(2, 3)}.mvt`]);
  });
});

describe('scheme and bounds from a TileJSON', () => {
  const tileJson = {
    tilejson: '3.0.0',
    tiles: ['tiles/{z}/{x}/{y}.png'],
    scheme: 'tms',
    bounds: BOUNDS
  };
  const fetchJson = (async () => Response.json(tileJson)) as typeof fetch;

  test('apply to the source, as inline properties do', async () => {
    const style = await resolveBasemapStyle(
      {
        version: 8,
        sources: {raster: {type: 'raster', url: 'https://r.example.com/tiles.json'}},
        layers: [{id: 'imagery', type: 'raster', source: 'raster'}]
      },
      {fetch: fetchJson}
    );
    const raster: any = getBasemapLayers({
      idPrefix: 't',
      mode: 'map',
      zoom: 3,
      styleDefinition: style
    }).find(layer => layer.id === 't-imagery');
    const tile: any = {index: {x: 3, y: 2, z: 3}, id: '3-2-3'};
    TileLayer.prototype.getTileData.call(
      {props: {...raster.props, getTileData: null, fetch: () => null}} as any,
      tile
    );
    expect(tile.url).toBe(`https://r.example.com/tiles/3/3/${tmsRow(2, 3)}.png`);
    expect(await getRasterRequests(raster, getWorldViewport(3))).toEqual([
      '3/3/2',
      '3/3/3',
      '3/4/2',
      '3/4/3'
    ]);
  });

  test("give way to the style's own scheme and bounds", async () => {
    const style = await resolveBasemapStyle(
      {
        version: 8,
        sources: {
          raster: {
            type: 'raster',
            url: 'https://r.example.com/tiles.json',
            scheme: 'xyz',
            bounds: [-180, -85.0511, 180, 85.0511]
          }
        },
        layers: [{id: 'imagery', type: 'raster', source: 'raster'}]
      },
      {fetch: fetchJson}
    );
    const raster: any = getBasemapLayers({
      idPrefix: 't',
      mode: 'map',
      zoom: 3,
      styleDefinition: style
    }).find(layer => layer.id === 't-imagery');
    expect(raster.props.data).toEqual(['https://r.example.com/tiles/{z}/{x}/{y}.png']);
    expect(await getRasterRequests(raster, getWorldViewport(3))).toHaveLength(64);
  });
});
