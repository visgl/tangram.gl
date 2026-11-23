// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {describe, expect, test, vi} from 'vitest';
import {log, WebMercatorViewport} from '@deck.gl/core';
import {SharedTileset2D} from '@deck.gl-community/geo-layers';
import {BasemapLayer} from '../src/basemap-layer';
import {getGeoJsonTileFeatures} from '../src/geojson-source';

/** A FeatureCollection of one point, with `name` in its properties. */
function points(name: string, longitude = 0) {
  return {
    type: 'FeatureCollection',
    features: [
      {type: 'Feature', properties: {name}, geometry: {type: 'Point', coordinates: [longitude, 0]}}
    ]
  };
}

const STYLE_DATA = points('style');

const style: any = {
  version: 8,
  sources: {
    tiles: {type: 'vector', maxzoom: 0, tiles: ['https://example.com/{z}/{x}/{y}.pbf']},
    places: {type: 'geojson', data: STYLE_DATA},
    terrain: {type: 'raster-dem', maxzoom: 0, tiles: ['https://example.com/{z}/{x}/{y}.png']}
  },
  layers: [
    {id: 'water', type: 'fill', source: 'tiles', 'source-layer': 'water'},
    {id: 'shadow', type: 'hillshade', source: 'terrain'},
    {id: 'places', type: 'circle', source: 'places'}
  ]
};
const viewport = new WebMercatorViewport({width: 128, height: 128, zoom: 0});

function createBasemap(props: Record<string, unknown> = {}): any {
  const basemap: any = new BasemapLayer({id: 'test', style, ...props});
  basemap.initializeState();
  basemap.setState = (state: any) => Object.assign(basemap.state, state);
  basemap.state.resolvedStyle = style;
  basemap.context = {viewport};
  basemap.updateState({props: basemap.props, oldProps: {}, changeFlags: {}});
  return basemap;
}

/** The basemap with new props, as deck.gl updates a layer: same state, then `updateState`. */
function update(basemap: any, props: Record<string, unknown>): any {
  const next: any = basemap.clone(props);
  next.state = basemap.state;
  next.context = basemap.context;
  next.setState = (state: any) => Object.assign(next.state, state);
  next.updateState({props: next.props, oldProps: basemap.props, changeFlags: {}});
  return next;
}

/** The tilesets of the basemap after it renders, by the id of their source in the style. */
function renderTilesets(basemap: any): Record<string, {source: any; tileset: SharedTileset2D}> {
  basemap.renderLayers();
  const sources = basemap.state.styleWithSourceData?.style.sources ?? style.sources;
  const tilesets: Record<string, {source: any; tileset: SharedTileset2D}> = {};
  for (const [source, tileset] of basemap.state.tilesets) {
    const sourceId = Object.keys(sources).find(id => sources[id] === source);
    expect(sourceId).toBeDefined();
    tilesets[sourceId!] = {source, tileset};
  }
  return tilesets;
}

/** The `name` of the features in the zoom 0 tile of a GeoJSON source. */
async function getTileNames(source: any): Promise<unknown[]> {
  const features = await getGeoJsonTileFeatures(source, {x: 0, y: 0, z: 0});
  return features.map(feature => (feature.properties as any)?.name);
}

/** A `fetch` that answers each URL with the JSON of `bodies`, or 404. */
function createFetch(bodies: Record<string, unknown>) {
  return vi.fn(async (url: string) =>
    url in bodies
      ? new Response(JSON.stringify(bodies[url]), {status: 200})
      : new Response('', {status: 404})
  );
}

describe('BasemapLayer sourceData', () => {
  test('a new entry cuts only that source again, with no style load', async () => {
    const basemap = createBasemap();
    const before = renderTilesets(basemap);
    expect(Object.keys(before).sort()).toEqual(['places', 'terrain', 'tiles']);
    expect(await getTileNames(before.places.source)).toEqual(['style']);
    const finalizes = Object.fromEntries(
      Object.entries(before).map(([id, {tileset}]) => [id, vi.spyOn(tileset, 'finalize')])
    );
    const loadStyle = vi.spyOn(BasemapLayer.prototype, 'loadStyle');

    try {
      const moved = points('moved');
      const next = update(basemap, {sourceData: {places: moved}});
      const after = renderTilesets(next);

      expect(loadStyle).not.toHaveBeenCalled();
      expect(next.state.resolvedStyle).toBe(style);
      // The other sources keep their tilesets, and so their tiles.
      expect(after.tiles.tileset).toBe(before.tiles.tileset);
      expect(after.terrain.tileset).toBe(before.terrain.tileset);
      expect(finalizes.tiles).not.toHaveBeenCalled();
      expect(finalizes.terrain).not.toHaveBeenCalled();
      // The changed source has a new tileset over the new data.
      expect(finalizes.places).toHaveBeenCalledTimes(1);
      expect(after.places.tileset).not.toBe(before.places.tileset);
      expect(after.places.source.data).toBe(moved);
      expect(await getTileNames(after.places.source)).toEqual(['moved']);
      // The style itself is not changed.
      expect(style.sources.places.data).toBe(STYLE_DATA);
      next.finalizeState();
    } finally {
      loadStyle.mockRestore();
    }
  });

  test('the same entries in a new object, and a rerender, keep the tileset', () => {
    const moved = points('moved');
    const basemap = createBasemap({sourceData: {places: moved}});
    const {places} = renderTilesets(basemap);
    const finalize = vi.spyOn(places.tileset, 'finalize');
    const next = update(basemap, {sourceData: {places: moved}});
    expect(renderTilesets(next).places.tileset).toBe(places.tileset);
    expect(renderTilesets(next).places.tileset).toBe(places.tileset);
    expect(finalize).not.toHaveBeenCalled();
    next.finalizeState();
  });

  test('deck.gl compares the prop by entry', () => {
    const moved = points('moved');
    const {sourceData} = (BasemapLayer as any)._propTypes;
    expect(sourceData.equal({places: moved}, {places: moved}, sourceData)).toBe(true);
    expect(sourceData.equal({places: moved}, {places: points('moved')}, sourceData)).toBe(false);
    expect(sourceData.equal({places: moved}, {}, sourceData)).toBe(false);
  });

  test('removing the entry, or setting it to null, gives back the data of the style', async () => {
    const basemap = createBasemap({sourceData: {places: points('moved')}});
    expect(await getTileNames(renderTilesets(basemap).places.source)).toEqual(['moved']);
    for (const sourceData of [{places: null}, {}, null]) {
      const next = update(basemap, {sourceData});
      expect(renderTilesets(next).places.source).toBe(style.sources.places);
      expect(next.state.styleWithSourceData).toBeNull();
    }
    basemap.finalizeState();
  });

  test('a URL loads with the fetch of loadOptions, relative to baseUrl, after the previous data', async () => {
    const fetch = createFetch({'https://data.example.com/moved.json': points('fetched')});
    const loadOptions = {baseUrl: 'https://data.example.com/style.json', fetch};
    const inline = points('inline');
    const basemap = createBasemap({loadOptions, sourceData: {places: inline}});
    const next = update(basemap, {loadOptions, sourceData: {places: 'moved.json'}});
    // As MapLibre's `setData`, the source draws its previous data until the URL loads.
    expect(await getTileNames(renderTilesets(next).places.source)).toEqual(['inline']);
    await vi.waitFor(() => expect(next.state.sourceData.get('places').data).not.toBe(inline));
    expect(fetch).toHaveBeenCalledWith('https://data.example.com/moved.json', undefined);
    expect(await getTileNames(renderTilesets(next).places.source)).toEqual(['fetched']);
    next.finalizeState();
  });

  test('a URL loads again, relative to the new style URL, when the style URL changes', async () => {
    const fetch = createFetch({
      'https://a.example.com/data.json': points('a'),
      'https://b.example.com/data.json': points('b')
    });
    const loadOptions = {fetch};
    const sourceData = {places: 'data.json'};
    const loadStyle = vi.spyOn(BasemapLayer.prototype, 'loadStyle').mockImplementation(() => {});
    try {
      const basemap = createBasemap({style: 'https://a.example.com/style.json', loadOptions, sourceData});
      await vi.waitFor(() => expect(basemap.state.sourceData.get('places').data).not.toBeNull());
      expect(await getTileNames(renderTilesets(basemap).places.source)).toEqual(['a']);

      const next = update(basemap, {style: 'https://b.example.com/style.json', loadOptions, sourceData});
      await vi.waitFor(() =>
        expect(fetch).toHaveBeenCalledWith('https://b.example.com/data.json', undefined)
      );
      await vi.waitFor(async () =>
        expect(await getTileNames(renderTilesets(next).places.source)).toEqual(['b'])
      );
      next.finalizeState();
    } finally {
      loadStyle.mockRestore();
    }
  });

  test('a URL loads again with the new loadOptions when they change', async () => {
    const fetchA = createFetch({'https://x.test/data.json': points('a')});
    const fetchB = createFetch({'https://x.test/data.json': points('b')});
    const sourceData = {places: 'https://x.test/data.json'};
    const loadStyle = vi.spyOn(BasemapLayer.prototype, 'loadStyle').mockImplementation(() => {});
    try {
      const basemap = createBasemap({loadOptions: {fetch: fetchA}, sourceData});
      await vi.waitFor(() => expect(basemap.state.sourceData.get('places').data).not.toBeNull());
      expect(await getTileNames(renderTilesets(basemap).places.source)).toEqual(['a']);

      const next = update(basemap, {loadOptions: {fetch: fetchB}, sourceData});
      await vi.waitFor(() => expect(fetchB).toHaveBeenCalledTimes(1));
      await vi.waitFor(async () =>
        expect(await getTileNames(renderTilesets(next).places.source)).toEqual(['b'])
      );
      expect(fetchA).toHaveBeenCalledTimes(1);
      next.finalizeState();
    } finally {
      loadStyle.mockRestore();
    }
  });

  test('a URL with no previous entry draws the data of the style until it loads', async () => {
    const fetch = createFetch({'https://data.example.com/a.json': points('fetched')});
    const basemap = createBasemap({loadOptions: {fetch}, sourceData: {places: 'https://data.example.com/a.json'}});
    expect(renderTilesets(basemap).places.source).toBe(style.sources.places);
    await vi.waitFor(() => expect(basemap.state.sourceData.get('places').data).not.toBeNull());
    expect(await getTileNames(renderTilesets(basemap).places.source)).toEqual(['fetched']);
    basemap.finalizeState();
  });

  test('a URL load that a later entry replaced is dropped', async () => {
    let resolveFirst!: (response: Response) => void;
    const fetch = vi.fn((url: string) =>
      url.endsWith('first.json')
        ? new Promise<Response>(resolve => (resolveFirst = resolve))
        : Promise.resolve(new Response(JSON.stringify(points('second')), {status: 200}))
    );
    const loadOptions = {fetch};
    const basemap = createBasemap({loadOptions, sourceData: {places: 'https://x.test/first.json'}});
    const next = update(basemap, {loadOptions, sourceData: {places: 'https://x.test/second.json'}});
    await vi.waitFor(() => expect(next.state.sourceData.get('places').data).not.toBeNull());
    resolveFirst(new Response(JSON.stringify(points('first')), {status: 200}));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(await getTileNames(renderTilesets(next).places.source)).toEqual(['second']);
    next.finalizeState();
  });

  test('a URL that fails keeps the previous data and logs an error', async () => {
    const error = vi.spyOn(log, 'error');
    try {
      const fetch = createFetch({});
      const loadOptions = {fetch};
      const basemap = createBasemap({loadOptions, sourceData: {places: points('inline')}});
      const next = update(basemap, {loadOptions, sourceData: {places: 'https://x.test/missing.json'}});
      await vi.waitFor(() => expect(error).toHaveBeenCalled());
      expect(String(error.mock.calls[0][0])).toContain('places');
      expect(await getTileNames(renderTilesets(next).places.source)).toEqual(['inline']);
      next.finalizeState();
    } finally {
      error.mockRestore();
    }
  });

  test('the entry applies to a style that loads later, and stays through a style change', async () => {
    const moved = points('moved');
    const basemap = createBasemap({sourceData: {places: moved}});
    renderTilesets(basemap);
    // A new style object resolves to new source objects.
    const reloaded = {...style, sources: {...style.sources, places: {...style.sources.places}}};
    basemap.state.resolvedStyle = reloaded;
    basemap.renderLayers();
    const source = basemap.state.styleWithSourceData.style.sources.places;
    expect(source).not.toBe(reloaded.sources.places);
    expect(source.data).toBe(moved);
    expect(basemap.state.tilesets.has(source)).toBe(true);
    basemap.finalizeState();
  });

  test('an id that is not a geojson source of the style is ignored with a warning', () => {
    const warn = vi.spyOn(log, 'warn');
    try {
      const basemap = createBasemap();
      const before = renderTilesets(basemap);
      const next = update(basemap, {sourceData: {tiles: points('a'), missing: points('b')}});
      const after = renderTilesets(next);
      expect(after.tiles.tileset).toBe(before.tiles.tileset);
      expect(after.places.tileset).toBe(before.places.tileset);
      const messages = warn.mock.calls.map(([message]) => String(message));
      expect(messages.some(message => message.includes('"tiles"'))).toBe(true);
      expect(messages.some(message => message.includes('"missing"'))).toBe(true);
      next.finalizeState();
    } finally {
      warn.mockRestore();
    }
  });
});
