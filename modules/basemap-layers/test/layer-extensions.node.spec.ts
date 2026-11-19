// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {DataFilterExtension, MaskExtension} from '@deck.gl/extensions';
import {describe, expect, test} from 'vitest';
import {BasemapLayer} from '../src/basemap-layer.ts';
import {getBasemapLayers} from '../src/index.ts';

const STYLE = {
  version: 8,
  sources: {tiles: {type: 'vector', tiles: ['https://tiles.example.com/{z}/{x}/{y}.mvt']}},
  layers: [
    {id: 'background', type: 'background', paint: {'background-color': '#ffffff'}},
    {id: 'land', type: 'fill', source: 'tiles', 'source-layer': 'land'},
    {id: 'road', type: 'line', source: 'tiles', 'source-layer': 'road'},
    {
      id: 'place',
      type: 'symbol',
      source: 'tiles',
      'source-layer': 'place',
      layout: {'text-field': ['get', 'name']}
    }
  ]
} as any;

const FEATURES = [
  {
    type: 'Feature',
    properties: {layerName: 'land'},
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 0]
        ]
      ]
    }
  },
  {
    type: 'Feature',
    properties: {layerName: 'road'},
    geometry: {
      type: 'LineString',
      coordinates: [
        [0, 0],
        [1, 1]
      ]
    }
  },
  {
    type: 'Feature',
    properties: {layerName: 'place', name: 'A'},
    geometry: {type: 'Point', coordinates: [0.5, 0.5]}
  }
];

/** The layers that the vector tile layer of `STYLE` renders for one tile. */
function renderTile(tileProps: Record<string, unknown>): any[] {
  const layers = getBasemapLayers({idPrefix: 'test', mode: 'map', zoom: 4, styleDefinition: STYLE});
  const tileLayer: any = layers.find(layer => layer.id === 'test-tiles');
  return tileLayer.props
    .renderSubLayers({
      id: 'test-tiles-tile',
      data: FEATURES,
      tile: {index: {x: 0, y: 0, z: 4}},
      ...tileProps
    })
    .flat(Infinity)
    .filter(Boolean);
}

/** A basemap with a resolved style, set up as deck.gl sets up a layer. */
function basemap(props: Record<string, unknown>): any {
  const layer: any = new BasemapLayer({id: 'basemap', style: null, ...props} as any);
  layer.context = {viewport: {zoom: 4, id: 'map'}, layerManager: {}};
  layer.initializeState();
  layer.state.resolvedStyle = STYLE;
  return layer;
}

describe('the extensions of a BasemapLayer', () => {
  test('the sublayers of a tile take the props of the tile layer extensions', () => {
    const mask = new MaskExtension();
    const filter = new DataFilterExtension({filterSize: 1});
    const getFilterValue = () => 1;
    const sublayers = renderTile({
      extensions: [mask, filter],
      maskId: 'mask',
      maskInverted: true,
      getFilterValue,
      filterRange: [0, 2]
    });
    // A fill, a line and a label layer.
    expect(sublayers.length).toBeGreaterThanOrEqual(3);
    for (const sublayer of sublayers) {
      expect(sublayer.props.extensions.slice(0, 2), sublayer.id).toEqual([mask, filter]);
      expect(sublayer.props.maskId, sublayer.id).toBe('mask');
      expect(sublayer.props.maskInverted, sublayer.id).toBe(true);
      expect(sublayer.props.getFilterValue, sublayer.id).toBe(getFilterValue);
      expect(sublayer.props.filterRange, sublayer.id).toEqual([0, 2]);
    }
  });

  test('the sublayers of a tile take no props without extensions', () => {
    for (const sublayer of renderTile({maskId: 'mask'})) {
      expect(sublayer.props.maskId, sublayer.id).toBeUndefined();
    }
  });

  test('a BasemapLayer gives its sublayers its extensions and their props', () => {
    const mask = new MaskExtension();
    const sublayers = basemap({extensions: [mask], maskId: 'mask'}).renderLayers();
    expect(sublayers.map((sublayer: any) => sublayer.id)).toEqual([
      'basemap-background',
      'basemap-tiles'
    ]);
    for (const sublayer of sublayers) {
      expect(sublayer.props.extensions.at(-1), sublayer.id).toBe(mask);
      expect(sublayer.props.maskId, sublayer.id).toBe('mask');
    }
  });

  test('a BasemapLayer without extensions renders its sublayers unchanged', () => {
    const sublayers = basemap({maskId: 'mask'}).renderLayers();
    expect(sublayers.length).toBe(2);
    for (const sublayer of sublayers) {
      expect(sublayer.props.maskId, sublayer.id).toBeUndefined();
    }
  });
});
