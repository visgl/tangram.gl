// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/* eslint-disable import/no-extraneous-dependencies */
import {afterEach, describe, expect, test, vi} from 'vitest';
import {LayerManager, WebMercatorViewport} from '@deck.gl/core';
import {NullDevice} from '@luma.gl/core/test-utils';
import {BasemapLayer} from '../src/basemap-layer';
import {BasemapLoadError} from '../src/basemap-error';

const TILEJSON_URL = 'https://tiles.example.com/streets.json';
const TILES = ['https://tiles.example.com/{z}/{x}/{y}.mvt'];

/** A promise and the function that resolves it. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return {promise, resolve};
}

/** A tile `fetch` (the deck.gl prop) whose requests answer, with no features, on `release`. */
function deferredTileFetch() {
  const pending: (() => void)[] = [];
  const requested: string[] = [];
  const fetch = vi.fn((url: string) => {
    requested.push(url);
    return new Promise<unknown[]>(resolve => pending.push(() => resolve([])));
  });
  return {
    fetch,
    requested,
    release() {
      for (const resolve of pending.splice(0)) resolve();
    }
  };
}

function viewportAt(zoom: number) {
  return new WebMercatorViewport({width: 128, height: 128, longitude: 0, latitude: 0, zoom});
}

let manager: LayerManager | null = null;

afterEach(() => {
  manager?.setLayers([]);
  manager?.finalize();
  manager = null;
});

function mount(layer: BasemapLayer, zoom = 0) {
  manager = new LayerManager(new NullDevice({}), {viewport: viewportAt(zoom)});
  manager.setProps({
    onError: (error: Error) => {
      throw error;
    }
  });
  manager.setLayers([layer]);
  return manager;
}

/** Lets pending promises settle, then applies the updates they asked for. */
async function settle() {
  for (let i = 0; i < 20; i++) {
    await new Promise(resolve => setTimeout(resolve, 0));
    while (manager!.needsUpdate()) {
      manager!.updateLayers();
    }
  }
}

/** Moves the view, as a deck.gl draw pass gives each layer its viewport. */
function moveTo(layerManager: LayerManager, viewport: WebMercatorViewport) {
  layerManager.activateViewport(viewport);
  for (const layer of layerManager.getLayers()) layer.activateViewport(viewport);
}

function isLoaded(): boolean {
  return manager!.getLayers({layerIds: ['basemap']})[0].isLoaded;
}

describe('BasemapLayer isLoaded and lifecycle callbacks', () => {
  test('is not loaded while the style loads, nor while its tiles load', async () => {
    const tileJson = deferred<unknown>();
    const tiles = deferredTileFetch();
    const onStyleLoad = vi.fn();
    const onTileLoad = vi.fn();
    const onViewportLoad = vi.fn();
    const style = {
      version: 8,
      sources: {streets: {type: 'vector', url: TILEJSON_URL}},
      layers: [
        {id: 'water', type: 'fill', source: 'streets', 'source-layer': 'water'},
        // Splits the source's style layers into two tile sublayers that share its tiles.
        {id: 'land', type: 'background', paint: {'background-color': '#ffffff'}},
        {id: 'roads', type: 'line', source: 'streets', 'source-layer': 'roads'}
      ]
    };
    const fetchJson = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: () => tileJson.promise
    }));
    mount(
      new BasemapLayer({
        id: 'basemap',
        style: style as any,
        loadOptions: {fetch: fetchJson},
        fetch: tiles.fetch,
        onStyleLoad,
        onTileLoad,
        onViewportLoad
      } as any)
    );

    await settle();
    expect(fetchJson).toHaveBeenCalledWith(TILEJSON_URL, undefined);
    expect(isLoaded()).toBe(false);
    expect(onStyleLoad).not.toHaveBeenCalled();

    tileJson.resolve({tiles: TILES, maxzoom: 0});
    await settle();
    expect(onStyleLoad).toHaveBeenCalledTimes(1);
    expect(onStyleLoad.mock.calls[0][0].sources.streets.tiles).toEqual(TILES);
    expect(tiles.requested.length).toBeGreaterThan(0);
    expect(isLoaded()).toBe(false);
    expect(onViewportLoad).not.toHaveBeenCalled();

    const basemap = manager!.getLayers({layerIds: ['basemap']})[0] as BasemapLayer;
    expect(basemap.getSubLayers().map(layer => layer.id)).toEqual([
      'basemap-streets',
      'basemap-land',
      'basemap-streets-"roads"'
    ]);

    tiles.release();
    await settle();
    expect(isLoaded()).toBe(true);
    // The two style layers share the tiles of their source: each tile is reported once.
    expect(onTileLoad).toHaveBeenCalledTimes(tiles.requested.length);
    expect(onViewportLoad).toHaveBeenCalledTimes(1);
    expect(onViewportLoad.mock.calls[0][0]).toHaveLength(tiles.requested.length);
  });

  test('is not loaded before the sublayers of the style exist, or while sprites load', async () => {
    const sprite = deferred<void>();
    const onError = vi.fn((_error: BasemapLoadError) => true);
    const fetchSprite = vi.fn(async () => {
      await sprite.promise;
      return {ok: false, status: 404, json: async () => ({})};
    });
    const background = {id: 'land', type: 'background', paint: {'background-color': '#ffffff'}};
    const layerManager = mount(
      new BasemapLayer({
        id: 'basemap',
        style: {version: 8, sources: {}, layers: [background]} as any,
        loadOptions: {fetch: fetchSprite}
      } as any)
    );
    // The style resolves, but its sublayers are generated in the next update.
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(isLoaded()).toBe(false);
    await settle();
    expect(isLoaded()).toBe(true);

    layerManager.setLayers([
      new BasemapLayer({
        id: 'basemap',
        style: {
          version: 8,
          sprite: 'https://sprites.example.com/sprite',
          sources: {},
          layers: [background]
        } as any,
        onError,
        loadOptions: {fetch: fetchSprite}
      } as any)
    ]);
    await settle();
    expect(fetchSprite).toHaveBeenCalled();
    expect(isLoaded()).toBe(false);
    // A sprite that fails to load counts as loaded.
    sprite.resolve();
    await settle();
    expect(isLoaded()).toBe(true);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toBeInstanceOf(BasemapLoadError);
    expect(onError.mock.calls[0][0]).toMatchObject({kind: 'sprite'});
  });

  test('an error in onStyleLoad keeps the style and goes to onError', async () => {
    const error = new Error('app callback');
    const onError = vi.fn(() => true);
    const background = {id: 'land', type: 'background', paint: {'background-color': '#ffffff'}};
    mount(
      new BasemapLayer({
        id: 'basemap',
        style: {version: 8, sources: {}, layers: [background]} as any,
        onStyleLoad: () => {
          throw error;
        },
        onError
      } as any)
    );
    await settle();
    const basemap = manager!.getLayers({layerIds: ['basemap']})[0] as BasemapLayer;
    expect(basemap.state.resolvedStyle).not.toBe(null);
    expect(basemap.getSubLayers().map(layer => layer.id)).toEqual(['basemap-land']);
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0] as unknown[])[0]).toMatchObject({cause: error});
  });

  test('does not report a viewport that selects no tiles', async () => {
    const tiles = deferredTileFetch();
    const onViewportLoad = vi.fn();
    const style = {
      version: 8,
      // No tile exists below zoom 4, and the source has no extent: zoom 0 selects no tiles.
      sources: {streets: {type: 'vector', tiles: TILES, minzoom: 4, maxzoom: 4}},
      layers: [{id: 'roads', type: 'line', source: 'streets', 'source-layer': 'roads'}]
    };
    const layerManager = mount(
      new BasemapLayer({
        id: 'basemap',
        style: style as any,
        fetch: tiles.fetch,
        onViewportLoad
      } as any)
    );
    await settle();
    expect(tiles.requested).toEqual([]);
    expect(isLoaded()).toBe(true);
    expect(onViewportLoad).not.toHaveBeenCalled();

    moveTo(layerManager, viewportAt(4.5));
    await settle();
    tiles.release();
    await settle();
    expect(tiles.requested.length).toBeGreaterThan(0);
    expect(onViewportLoad).toHaveBeenCalledTimes(1);
    expect(onViewportLoad.mock.calls[0][0].length).toBeGreaterThan(0);
  });
});

describe('BasemapLayer onAttributionChange', () => {
  /** Tiles that never load: the attributions do not wait for tiles. */
  const neverFetch = () => new Promise(() => {});

  function styleWith(sources: Record<string, unknown>, layers: unknown[]) {
    return {version: 8, sources, layers} as any;
  }

  test('reports the attribution of the drawn sources, again when the style changes', async () => {
    const onAttributionChange = vi.fn();
    const first = styleWith(
      {
        streets: {type: 'vector', tiles: TILES, attribution: '© Streets'},
        // Each attribution is reported once, and one that another contains is not.
        roads: {type: 'vector', tiles: TILES, attribution: '© Streets'},
        partial: {type: 'vector', tiles: TILES, attribution: 'Streets'},
        // A source that no shown layer draws is not reported.
        hidden: {type: 'vector', tiles: TILES, attribution: '© Hidden'},
        unused: {type: 'vector', tiles: TILES, attribution: '© Unused'}
      },
      [
        {id: 'a', type: 'line', source: 'streets', 'source-layer': 'roads'},
        {id: 'b', type: 'line', source: 'roads', 'source-layer': 'roads'},
        {id: 'c', type: 'line', source: 'partial', 'source-layer': 'roads'},
        {
          id: 'd',
          type: 'line',
          source: 'hidden',
          'source-layer': 'roads',
          layout: {visibility: 'none'}
        }
      ]
    );
    const second = styleWith(
      {terrain: {type: 'raster', tiles: TILES, attribution: '© Terrain'}},
      [{id: 'terrain', type: 'raster', source: 'terrain'}]
    );
    const layerManager = mount(
      new BasemapLayer({id: 'basemap', style: first, fetch: neverFetch, onAttributionChange} as any)
    );
    await settle();
    expect(onAttributionChange.mock.calls).toEqual([[['© Streets']]]);

    layerManager.setLayers([
      new BasemapLayer({
        id: 'basemap',
        style: second,
        fetch: neverFetch,
        onAttributionChange
      } as any)
    ]);
    await settle();
    expect(onAttributionChange.mock.calls).toEqual([[['© Streets']], [['© Terrain']]]);

    // With labels off, a source that only symbol layers draw is not drawn.
    const labelled = styleWith(
      {
        terrain: {type: 'raster', tiles: TILES, attribution: '© Terrain'},
        places: {type: 'vector', tiles: TILES, attribution: '© Places'},
        // A source drawn only by hidden layers is not reported.
        heat: {type: 'geojson', data: {type: 'FeatureCollection', features: []}, attribution: '© Heat'}
      },
      [
        {id: 'terrain', type: 'raster', source: 'terrain'},
        {id: 'places', type: 'symbol', source: 'places', 'source-layer': 'places'},
        {id: 'heat', type: 'heatmap', source: 'heat', layout: {visibility: 'none'}}
      ]
    );
    const props = {id: 'basemap', style: labelled, fetch: neverFetch, onAttributionChange};
    layerManager.setLayers([new BasemapLayer(props as any)]);
    await settle();
    expect(onAttributionChange.mock.calls.at(-1)).toEqual([['© Terrain', '© Places']]);
    layerManager.setLayers([
      new BasemapLayer({...props, globe: {config: {labels: false}}} as any)
    ]);
    await settle();
    expect(onAttributionChange.mock.calls.at(-1)).toEqual([['© Terrain']]);
    onAttributionChange.mockClear();

    layerManager.setLayers([
      new BasemapLayer({id: 'basemap', style: null, onAttributionChange} as any)
    ]);
    await settle();
    expect(onAttributionChange.mock.calls).toEqual([[[]]]);
  });
});
