// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/* eslint-disable import/no-extraneous-dependencies */
import {MaskExtension} from '@deck.gl/extensions';
import {describe, expect, test, vi} from 'vitest';
import {BasemapLayer} from '../src/basemap-layer';
import {getBasemapLayers, getStyleLayerPropsMap} from '../src/globe-layers';

const FILL_PAINT = {'fill-color': '#00ff00', 'fill-antialias': false};

const STYLE: any = {
  version: 8,
  sources: {
    tiles: {type: 'vector', tiles: ['https://tiles.example.com/{z}/{x}/{y}.mvt']},
    relief: {type: 'raster', tiles: ['https://relief.example.com/{z}/{x}/{y}.png']}
  },
  layers: [
    {id: 'background', type: 'background', paint: {'background-color': '#ffffff'}},
    // Without antialiasing, so that the two fills share a sublayer (see `getBatchKey`).
    {id: 'land', type: 'fill', source: 'tiles', 'source-layer': 'land', paint: FILL_PAINT},
    {id: 'park', type: 'fill', source: 'tiles', 'source-layer': 'land', paint: FILL_PAINT},
    {
      id: 'road',
      type: 'line',
      source: 'tiles',
      'source-layer': 'road',
      paint: {'line-color': ['get', 'color']}
    },
    {id: 'place', type: 'symbol', source: 'tiles', 'source-layer': 'place', layout: {}},
    {id: 'relief', type: 'raster', source: 'relief'}
  ]
};

const square = [
  [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 0]
  ]
];
const FEATURES = [
  {
    type: 'Feature',
    properties: {layerName: 'land'},
    geometry: {type: 'Polygon', coordinates: square}
  },
  {
    type: 'Feature',
    properties: {layerName: 'road', color: '#ff0000'},
    geometry: {type: 'LineString', coordinates: square[0]}
  },
  {
    type: 'Feature',
    properties: {layerName: 'place', name: 'A'},
    geometry: {type: 'Point', coordinates: [0.5, 0.5]}
  }
];

const mask = new MaskExtension();

/** The layers of `STYLE`, and the sublayers of one tile, with `getProps` for the style layers. */
function render(getProps: ((styleLayer: any) => any) | null) {
  const styleLayerProps = getStyleLayerPropsMap(STYLE, getProps);
  const layers: any[] = getBasemapLayers({
    idPrefix: 'test',
    mode: 'map',
    zoom: 8,
    styleDefinition: STYLE,
    styleLayerProps
  });
  const vector = layers.find(layer => layer.id === 'test-tiles');
  const sublayers: any[] = vector.props
    .renderSubLayers({id: 'tile', data: FEATURES, tile: {index: {x: 0, y: 0, z: 8}}})
    .flat()
    .filter(Boolean);
  return {layers, vector, sublayers};
}

/** The sublayers drawn for the style layer `id` (a batch is named after all of its layers). */
function sublayersOf(sublayers: any[], id: string): any[] {
  return sublayers.filter(layer => layer.id.includes(JSON.stringify(id)) || layer.id.includes(id));
}

describe('per-style-layer sublayer props', () => {
  test('without extra props, the two fills share one sublayer', () => {
    const {sublayers} = render(null);
    expect(sublayers.map(layer => layer.id)).toEqual([
      'tile-["land","park"]',
      'tile-"road"',
      'tile-"place"'
    ]);
    expect(sublayers.every(layer => !(layer.props.extensions || []).includes(mask))).toBe(true);
  });

  test('the sublayers of a style layer take its extensions and their props, and only its', () => {
    const {sublayers} = render(styleLayer =>
      styleLayer.id === 'road' ? {extensions: [mask], maskId: 'data'} : null
    );
    const [road] = sublayersOf(sublayers, 'road');
    expect(road.props.extensions).toContain(mask);
    expect(road.props.maskId).toBe('data');
    for (const layer of sublayers.filter(sublayer => sublayer !== road)) {
      expect(layer.props.extensions || []).not.toContain(mask);
      expect(layer.props.maskId).not.toBe('data');
    }
  });

  test('a fill with extra props draws alone, not batched with its neighbor', () => {
    const {sublayers} = render(styleLayer =>
      styleLayer.id === 'park' ? {extensions: [mask], maskId: 'data'} : null
    );
    expect(sublayers.map(layer => layer.id)).toEqual([
      'tile-"land"',
      'tile-"park"',
      'tile-"road"',
      'tile-"place"'
    ]);
    expect(sublayers.map(layer => layer.props.maskId)).toEqual([undefined, 'data', undefined, undefined]);
  });

  test('extensions follow the own extensions of the sublayer, and updateTriggers merge', () => {
    const {sublayers} = render(styleLayer =>
      styleLayer.id === 'road'
        ? {extensions: [mask], updateTriggers: {getFilterValue: 1}, id: 'ignored', data: []}
        : null
    );
    const [road] = sublayersOf(sublayers, 'road');
    const {sublayers: plain} = render(null);
    const [plainRoad] = sublayersOf(plain, 'road');
    expect(road.props.extensions).toEqual([...(plainRoad.props.extensions || []), mask]);
    // The sublayer keeps its own triggers (`toEqual` alone would not see a missing key whose
    // value is undefined).
    expect(Object.keys(plainRoad.props.updateTriggers).length).toBeGreaterThan(0);
    expect(Object.keys(road.props.updateTriggers)).toEqual([
      ...Object.keys(plainRoad.props.updateTriggers),
      'getFilterValue'
    ]);
    expect(road.props.updateTriggers).toEqual({...plainRoad.props.updateTriggers, getFilterValue: 1});
    // `id` and `data` stay the sublayer's own.
    expect(road.id).toBe(plainRoad.id);
    expect(road.props.data).toBe(plainRoad.props.data);
  });

  test('labels take the props of their style layer', () => {
    const {sublayers} = render(styleLayer =>
      styleLayer.type === 'symbol' ? {extensions: [mask], maskId: 'labels'} : null
    );
    const labels = sublayers.filter(layer => layer.props.maskId === 'labels');
    expect(labels).toHaveLength(1);
    expect(labels[0].constructor.layerName).toBe('MVTLabelLayer');
  });

  test('labels drawn across tiles take the props of their style layer', () => {
    const {vector} = render(styleLayer =>
      styleLayer.type === 'symbol' ? {extensions: [mask], maskId: 'labels'} : null
    );
    const placeIndex = 3;
    const tiles = [{index: {x: 0, y: 0, z: 8}, features: [FEATURES[2]]}];
    const [labels] = vector.props.renderLabelLayers(
      new Map([[placeIndex, tiles]]),
      (id: string) => ({id}),
      new Set()
    );
    expect(labels.constructor.layerName).toBe('MVTLabelLayer');
    expect(labels.props.maskId).toBe('labels');
    expect(labels.props.extensions).toContain(mask);
  });

  test('background and raster layers take the props of their style layer', () => {
    const {layers} = render(styleLayer =>
      styleLayer.type === 'background' || styleLayer.type === 'raster'
        ? {extensions: [mask], maskId: styleLayer.id}
        : null
    );
    expect(layers.find(layer => layer.id.includes('background')).props.maskId).toBe('background');
    expect(layers.find(layer => layer.id.includes('relief')).props.maskId).toBe('relief');
    expect(layers.find(layer => layer.id === 'test-tiles').props.maskId).toBeUndefined();
  });

  test('a change of the props regenerates the tiles', () => {
    const {vector: first} = render(() => ({maskId: 'a'}));
    const {vector: second} = render(() => ({maskId: 'b'}));
    expect(second.props.updateTriggers.renderSubLayers).not.toEqual(
      first.props.updateTriggers.renderSubLayers
    );
  });

  test('getStyleLayerPropsMap keeps only the style layers with props', () => {
    expect(getStyleLayerPropsMap(STYLE, () => null)).toBeNull();
    expect(getStyleLayerPropsMap(STYLE, null)).toBeNull();
    const map = getStyleLayerPropsMap(STYLE, layer => (layer.id === 'road' ? {maskId: 'x'} : null));
    expect([...map!.keys()].map(layer => layer.id)).toEqual(['road']);
  });
});

describe('BasemapLayer getStyleLayerProps', () => {
  /** A basemap with `props` and the resolved `STYLE`. */
  function basemap(props: Record<string, unknown>): any {
    const layer: any = new BasemapLayer({id: 'basemap', style: STYLE, ...props} as any);
    layer.initializeState();
    return layer;
  }

  test('is called once per style layer for a style and a function, not per render', () => {
    const getStyleLayerProps = vi.fn((styleLayer: any) =>
      styleLayer.id === 'road' ? {maskId: 'data'} : null
    );
    const layer = basemap({getStyleLayerProps});
    const map = layer.getStyleLayerPropsMap(STYLE);
    expect(getStyleLayerProps).toHaveBeenCalledTimes(STYLE.layers.length);
    expect(layer.getStyleLayerPropsMap(STYLE)).toBe(map);
    expect(getStyleLayerProps).toHaveBeenCalledTimes(STYLE.layers.length);

    // A new style calls it again.
    const restyled = {...STYLE, layers: [...STYLE.layers]};
    expect(layer.getStyleLayerPropsMap(restyled)).not.toBe(map);
    expect(getStyleLayerProps).toHaveBeenCalledTimes(2 * STYLE.layers.length);
  });

  test('a new function calls it again; without one there are no extra props', () => {
    const layer = basemap({getStyleLayerProps: () => ({maskId: 'a'})});
    const first = layer.getStyleLayerPropsMap(STYLE);
    layer.props = {...layer.props, getStyleLayerProps: () => ({maskId: 'b'})};
    const second = layer.getStyleLayerPropsMap(STYLE);
    expect(second).not.toBe(first);
    expect([...second.values()][0].maskId).toBe('b');
    expect(basemap({}).getStyleLayerPropsMap(STYLE)).toBeNull();
  });
});
