// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/* eslint-disable import/no-extraneous-dependencies */
import {describe, expect, test} from 'vitest';
import {FillTranslateExtension} from '../src/fill-style-extensions';
import {getBasemapLayers} from '../src/globe-layers';

const LINE = {
  type: 'Feature',
  geometry: {
    type: 'LineString',
    coordinates: [
      [0, 0],
      [1, 1]
    ]
  },
  properties: {}
};

const POLYGON = {
  type: 'Feature',
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
  },
  properties: {}
};

/** Renders the style layers for one tile and returns the sublayers that draw them. */
function render(layers: any[], features: unknown[], zoom = 12): any[] {
  const vectorLayer: any = getBasemapLayers({
    idPrefix: 'test',
    mode: 'map',
    zoom,
    styleDefinition: {
      version: 8,
      sources: {tiles: {type: 'vector', tiles: ['https://tiles.example.com/{z}/{x}/{y}.mvt']}},
      layers: layers.map(layer => ({source: 'tiles', ...layer}))
    } as any
  }).find(layer => layer.id === 'test-tiles');
  return [
    vectorLayer.props.renderSubLayers({
      id: 'test-tile',
      data: features,
      tile: {index: {x: 0, y: 0, z: Math.floor(zoom)}}
    })
  ]
    .flat(2)
    .filter(Boolean);
}

const translates = (layer: any) =>
  (layer.props.extensions || []).some((ext: unknown) => ext instanceof FillTranslateExtension);

describe('line-translate', () => {
  test('passes the offset and its anchor to the line', () => {
    const [layer] = render(
      [{id: 'road', type: 'line', paint: {'line-color': '#000000', 'line-translate': [4, -2]}}],
      [LINE]
    );
    expect(translates(layer)).toBe(true);
    expect(layer.props.fillTranslate).toEqual([4, -2]);
    expect(layer.props.fillTranslateAnchor).toBe('map');
    const [viewport] = render(
      [
        {
          id: 'road',
          type: 'line',
          paint: {'line-translate': [1, 1], 'line-translate-anchor': 'viewport'}
        }
      ],
      [LINE]
    );
    expect(viewport.props.fillTranslateAnchor).toBe('viewport');
  });

  test('is evaluated at the zoom', () => {
    const paint = {
      'line-translate': ['interpolate', ['linear'], ['zoom'], 14, ['literal', [0, 0]], 16, ['literal', [6, 2]]]
    };
    const [layer] = render([{id: 'road', type: 'line', paint}], [LINE], 15);
    expect(layer.props.fillTranslate).toEqual([3, 1]);
  });

  test('a line without line-translate has no translation', () => {
    const [layer] = render([{id: 'road', type: 'line', paint: {'line-color': '#000000'}}], [LINE]);
    expect(translates(layer)).toBe(false);
    expect(layer.props.fillTranslate).toBeUndefined();
  });

  test('a translated line draws alone, not batched with the lines around it', () => {
    const line = (id: string, paint = {}) => ({id, type: 'line', paint});
    const plain = render([line('a'), line('b')], [LINE]);
    expect(plain).toHaveLength(1);
    const layers = render([line('a'), line('b', {'line-translate': [2, 0]}), line('c')], [LINE]);
    expect(layers.map(layer => translates(layer))).toEqual([false, true, false]);
  });

  test('a gap draws both of its lines translated', () => {
    const layers = render(
      [{id: 'road', type: 'line', paint: {'line-gap-width': 4, 'line-translate': [2, 0]}}],
      [LINE]
    );
    expect(layers).toHaveLength(2);
    for (const layer of layers) {
      expect(translates(layer)).toBe(true);
      expect(layer.props.fillTranslate).toEqual([2, 0]);
    }
  });
});

describe('fill-extrusion-translate', () => {
  const extrusion = (paint: Record<string, unknown>) => ({
    id: 'buildings',
    type: 'fill-extrusion',
    paint: {'fill-extrusion-height': 10, ...paint}
  });

  test('passes the offset and its anchor to the extrusion, with its lighting', () => {
    const [layer] = render(
      [
        extrusion({
          'fill-extrusion-translate': [5, 6],
          'fill-extrusion-translate-anchor': 'viewport'
        })
      ],
      [POLYGON]
    );
    expect(layer.props.extruded).toBe(true);
    expect(layer.props.extensions.map((ext: object) => ext.constructor.name)).toEqual([
      'FillExtrusionLightingExtension',
      'FillTranslateExtension'
    ]);
    expect(layer.props.fillTranslate).toEqual([5, 6]);
    expect(layer.props.fillTranslateAnchor).toBe('viewport');
  });

  test('an extrusion without fill-extrusion-translate has no translation', () => {
    const [layer] = render([extrusion({})], [POLYGON]);
    expect(translates(layer)).toBe(false);
    expect(layer.props.fillTranslate).toBeUndefined();
  });
});
