// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {Deck, MapView} from '@deck.gl/core';
import {webgl2Adapter} from '@luma.gl/core/webgl';
import {afterEach, describe, expect, test} from 'vitest';
import {BasemapLayer} from '../src/basemap-layer';

// `querySourceFeatures` reads the features of the tiles a deck draws, as MapLibre GL JS's
// `Map#querySourceFeatures` reads those it renders.

const SIZE = 256;

let deck: Deck<any> | null = null;
let parent: HTMLDivElement | null = null;

afterEach(() => {
  deck?.finalize();
  deck = null;
  parent?.remove();
  parent = null;
});

/** Each tile holds one square, in tile-local coordinates, that names its tile. */
const fetchTile = async (url: string) => {
  const [z, x, y] = url
    .match(/(\d+)\/(\d+)\/(\d+)\.mvt/)!
    .slice(1)
    .map(Number);
  const square = [
    [0.25, 0.25],
    [0.75, 0.25],
    [0.75, 0.75],
    [0.25, 0.75],
    [0.25, 0.25]
  ];
  return [
    {
      type: 'Feature',
      id: x + 10 * y,
      properties: {layerName: 'area', tile: `${z}/${x}/${y}`},
      geometry: {type: 'Polygon', coordinates: [square]}
    }
  ];
};

const POINTS = {
  type: 'FeatureCollection',
  features: [
    {type: 'Feature', properties: {name: 'east', rank: 1}, geometry: {type: 'Point', coordinates: [10, 20]}},
    {type: 'Feature', properties: {name: 'west', rank: 2}, geometry: {type: 'Point', coordinates: [-30, -10]}}
  ]
};

const STYLE = {
  version: 8,
  sources: {
    tiles: {type: 'vector', tiles: ['https://tiles.example.com/{z}/{x}/{y}.mvt']},
    points: {type: 'geojson', data: POINTS}
  },
  layers: [
    {id: 'background', type: 'background', paint: {'background-color': '#ffffff'}},
    {id: 'area', type: 'fill', source: 'tiles', 'source-layer': 'area', paint: {'fill-color': '#ff0000'}},
    {id: 'points', type: 'circle', source: 'points', paint: {'circle-color': '#0000ff'}}
  ]
} as any;

type ViewState = {longitude: number; latitude: number; zoom: number};

function getBasemap(): BasemapLayer {
  return (deck as any).layerManager.getLayers().find((layer: any) => layer.id === 'basemap');
}

/** Resolves once every sublayer of the basemap has loaded, and its tiles drawn. */
function whenLoaded(predicate: () => boolean = () => true): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error('Timed out loading')), 30_000);
    const check = () => {
      const layers = (deck as any)?.layerManager?.getLayers() || [];
      if (layers.length > 2 && layers.every((layer: any) => layer.isLoaded) && predicate()) {
        window.clearTimeout(timeout);
        resolve();
        return;
      }
      window.setTimeout(() => window.requestAnimationFrame(() => deck?.redraw('load')), 20);
    };
    deck!.setProps({onAfterRender: check});
    window.requestAnimationFrame(() => deck?.redraw('load'));
  });
}

function createDeck(viewState: ViewState): Promise<void> {
  parent = document.createElement('div');
  document.body.append(parent);
  deck = new Deck({
    parent,
    width: SIZE,
    height: SIZE,
    useDevicePixels: false,
    deviceProps: {adapters: [webgl2Adapter]},
    views: new MapView({id: 'map'}),
    viewState: viewState as any,
    layers: [new BasemapLayer({id: 'basemap', mode: 'map', fetch: fetchTile, style: STYLE} as any)],
    onError: error => {
      throw error;
    }
  });
  return whenLoaded(() => getBasemap().querySourceFeatures('points').length > 0);
}

/** The bounds of tile `z/x/y` in longitude and latitude. */
function getTileBounds(z: number, x: number, y: number) {
  const size = 2 ** z;
  const lat = (row: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * row) / size))) * 180) / Math.PI;
  return {west: (x / size) * 360 - 180, east: ((x + 1) / size) * 360 - 180, north: lat(y), south: lat(y + 1)};
}

describe('BasemapLayer.querySourceFeatures', () => {
  test('reads the square of every drawn vector tile, in longitude and latitude', async () => {
    await createDeck({longitude: 0, latitude: 0, zoom: 1.4});
    const features = getBasemap().querySourceFeatures('tiles', {sourceLayer: 'area'});
    // A 256 pixel view at zoom 1.4 draws the four zoom 1 tiles.
    expect(features.map(feature => feature.properties.tile).sort()).toEqual([
      '1/0/0',
      '1/0/1',
      '1/1/0',
      '1/1/1'
    ]);
    for (const feature of features) {
      const {x, y, z} = feature.tile;
      expect(feature.properties.tile).toBe(`${z}/${x}/${y}`);
      expect(feature.id).toBe(x + 10 * y);
      expect(feature.sourceLayer).toBe('area');
      const bounds = getTileBounds(z, x, y);
      const ring = (feature.geometry.coordinates as number[][][])[0];
      // The square's corners are a quarter of the tile in from its edges.
      expect(ring[0][0]).toBeCloseTo(bounds.west + (bounds.east - bounds.west) / 4, 6);
      for (const [lng, lat] of ring) {
        expect(lng).toBeGreaterThan(bounds.west);
        expect(lng).toBeLessThan(bounds.east);
        expect(lat).toBeGreaterThan(bounds.south);
        expect(lat).toBeLessThan(bounds.north);
      }
    }
    expect(getBasemap().querySourceFeatures('tiles', {sourceLayer: 'area', filter: ['==', ['get', 'tile'], '1/1/0']})).toHaveLength(1);
  });

  test('reads a geojson source at the positions of its data, with a filter', async () => {
    await createDeck({longitude: 0, latitude: 0, zoom: 1.4});
    const basemap = getBasemap();
    const east = basemap.querySourceFeatures('points', {filter: ['==', ['get', 'name'], 'east']});
    expect(east.length).toBeGreaterThan(0);
    for (const feature of east) {
      expect(feature.source).toBe('points');
      expect(feature.properties).toEqual({name: 'east', rank: 1});
      const [lng, lat] = feature.geometry.coordinates as number[];
      // geojson-vt rounds positions to 1/8192 of a tile.
      expect(lng).toBeCloseTo(10, 1);
      expect(lat).toBeCloseTo(20, 1);
    }
    const names = new Set(basemap.querySourceFeatures('points').map(f => f.properties.name));
    expect([...names].sort()).toEqual(['east', 'west']);
  });

  test('does not read the tiles that are kept but not drawn', async () => {
    await createDeck({longitude: 0, latitude: 0, zoom: 4.2});
    const before = getBasemap().querySourceFeatures('tiles', {sourceLayer: 'area'});
    expect(before.length).toBeGreaterThan(0);
    const away = before.map(feature => feature.properties.tile);
    deck!.setProps({viewState: {longitude: 120, latitude: 0, zoom: 4.2}});
    await whenLoaded(() =>
      getBasemap()
        .querySourceFeatures('tiles', {sourceLayer: 'area'})
        .some(feature => (feature.tile.x / 16) * 360 - 180 > 90)
    );
    const after = getBasemap().querySourceFeatures('tiles', {sourceLayer: 'area'});
    expect(after.length).toBeGreaterThan(0);
    expect(after.filter(feature => away.includes(feature.properties.tile))).toEqual([]);
  });
});
