// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {describe, expect, test} from 'vitest';
import {
  getStylePositions,
  splitStyleAt,
  withFeatureStateHighlight,
  type StyleDocument,
  type StyleLayer
} from '../examples/layers/basemap-interleaved-picking/style-layers';
import {compileStylePropertyValue} from '../modules/basemap-layers/src/style-expression';

// The style helpers of the interleaved picking example: the split of a style at a layer, the
// highlight paint that reads feature state, and the positions that a style offers.

const COLORS = {hover: '#00ff00', selected: '#0000ff'};
const HOVER_RGBA = [0, 255, 0, 1];
const SELECTED_RGBA = [0, 0, 255, 1];
const FEATURE = {type: 'Feature', id: 1, properties: {}, geometry: {type: 'Point', coordinates: [0, 0]}};

function createStyle(layers: StyleLayer[]): StyleDocument {
  return {
    version: 8,
    sources: {tiles: {type: 'vector', url: 'https://example.com/tiles.json'}},
    sprite: 'https://example.com/sprite',
    layers
  };
}

function evaluate(
  propertyName: string,
  value: unknown,
  zoom: number,
  state: Record<string, unknown>
): unknown {
  const compiled = compileStylePropertyValue(propertyName, value);
  expect(compiled, `${propertyName} must be a valid style value`).not.toBeNull();
  return compiled!.evaluate(zoom, FEATURE as never, undefined, state);
}

describe('splitStyleAt', () => {
  const style = createStyle([
    {id: 'background', type: 'background'},
    {id: 'water', type: 'fill', source: 'tiles', 'source-layer': 'water'},
    {id: 'road', type: 'line', source: 'tiles', 'source-layer': 'transportation'},
    {id: 'label', type: 'symbol', source: 'tiles', 'source-layer': 'place'}
  ]);

  test('puts the named layer and the layers after it above', () => {
    const {below, above} = splitStyleAt(style, 'road');
    expect(below.layers.map(layer => layer.id)).toEqual(['background', 'water']);
    expect(above?.layers.map(layer => layer.id)).toEqual(['road', 'label']);
  });

  test('keeps the sources and the sprite in both parts', () => {
    const {below, above} = splitStyleAt(style, 'road');
    for (const part of [below, above!]) {
      // The same source objects: a part does not copy what it does not change.
      expect(part.sources).toBe(style.sources);
      expect(part.sprite).toBe(style.sprite);
      expect(part.version).toBe(8);
    }
  });

  test('puts every layer above when the first layer is named', () => {
    const {below, above} = splitStyleAt(style, 'background');
    expect(below.layers).toEqual([]);
    expect(above?.layers).toHaveLength(4);
  });

  test('keeps the whole style below without a layer, or with an unknown one', () => {
    expect(splitStyleAt(style, null)).toEqual({below: style, above: null});
    expect(splitStyleAt(style, 'missing')).toEqual({below: style, above: null});
  });
});

describe('withFeatureStateHighlight', () => {
  const ZOOM_CURVE = ['interpolate', ['linear'], ['zoom'], 5, '#ff0000', 15, '#ffff00'];
  const ZOOM_STEP = ['step', ['zoom'], '#ff0000', 10, '#ffff00'];
  const LEGACY_ZOOM_FUNCTION = {
    base: 1.4,
    stops: [
      [5, '#ff0000'],
      [15, '#ffff00']
    ]
  };
  const DATA_COLOR = ['match', ['get', 'class'], 'park', '#00aa00', '#888888'];

  const CASES: [name: string, type: string, property: string, value: unknown][] = [
    ['a constant fill color', 'fill', 'fill-color', 'hsl(35,8%,85%)'],
    ['a zoom curve of a line color', 'line', 'line-color', ZOOM_CURVE],
    ['a zoom step of a fill color', 'fill', 'fill-color', ZOOM_STEP],
    ['a legacy zoom function', 'fill', 'fill-color', LEGACY_ZOOM_FUNCTION],
    ['a data expression', 'fill', 'fill-color', DATA_COLOR],
    ['an extrusion color', 'fill-extrusion', 'fill-extrusion-color', '#aaaaaa'],
    ['a circle color', 'circle', 'circle-color', '#123456']
  ];

  test.each(CASES)('%s keeps its value without a state', (_name, type, property, value) => {
    const style = createStyle([{id: 'layer', type, source: 'tiles', paint: {[property]: value}}]);
    const highlighted = withFeatureStateHighlight(style, COLORS).layers[0].paint![property];
    expect(highlighted).not.toEqual(value);
    expect(compileStylePropertyValue(property, highlighted)?.isStateDependent).toBe(true);
    for (const zoom of [3, 8.5, 10, 12.25, 18]) {
      expect(evaluate(property, highlighted, zoom, {})).toEqual(evaluate(property, value, zoom, {}));
    }
  });

  test.each(CASES)('%s takes the highlight colors', (_name, type, property, value) => {
    const style = createStyle([{id: 'layer', type, source: 'tiles', paint: {[property]: value}}]);
    const highlighted = withFeatureStateHighlight(style, COLORS).layers[0].paint![property];
    for (const zoom of [3, 8.5, 18]) {
      expect(evaluate(property, highlighted, zoom, {hover: true})).toEqual(HOVER_RGBA);
      expect(evaluate(property, highlighted, zoom, {selected: true})).toEqual(SELECTED_RGBA);
      // A selected feature keeps its color under the cursor.
      expect(evaluate(property, highlighted, zoom, {hover: true, selected: true})).toEqual(
        SELECTED_RGBA
      );
    }
  });

  test('highlights a layer that has the default color', () => {
    const style = createStyle([{id: 'layer', type: 'line', source: 'tiles'}]);
    const color = withFeatureStateHighlight(style, COLORS).layers[0].paint!['line-color'];
    expect(evaluate('line-color', color, 10, {})).toEqual([0, 0, 0, 1]);
    expect(evaluate('line-color', color, 10, {hover: true})).toEqual(HOVER_RGBA);
  });

  test('keeps the other paint properties, and the style it is given', () => {
    const paint = {'fill-color': '#ff0000', 'fill-opacity': 0.5};
    const style = createStyle([{id: 'layer', type: 'fill', source: 'tiles', paint}]);
    const highlighted = withFeatureStateHighlight(style, COLORS);
    expect(highlighted.layers[0].paint!['fill-opacity']).toBe(0.5);
    expect(highlighted.sources).toBe(style.sources);
    expect(style.layers[0].paint).toEqual({'fill-color': '#ff0000', 'fill-opacity': 0.5});
  });

  test('leaves layers whose color it cannot highlight', () => {
    const layers: StyleLayer[] = [
      {id: 'background', type: 'background', paint: {'background-color': '#ffffff'}},
      {id: 'label', type: 'symbol', source: 'tiles', paint: {'text-color': '#000000'}},
      {id: 'raster', type: 'raster', source: 'raster'},
      // A pattern replaces the color.
      {id: 'pattern', type: 'fill', source: 'tiles', paint: {'fill-pattern': 'wetland'}},
      // A legacy property function has no expression that holds the highlight.
      {
        id: 'legacy',
        type: 'fill',
        source: 'tiles',
        paint: {'fill-color': {property: 'height', stops: [[0, '#000000'], [9, '#ffffff']]}}
      }
    ];
    const highlighted = withFeatureStateHighlight(createStyle(layers), COLORS);
    expect(highlighted.layers).toEqual(layers);
  });
});

describe('getStylePositions', () => {
  test('names the first road, building and closing label layer, from the bottom', () => {
    const style = createStyle([
      {id: 'background', type: 'background'},
      {id: 'building', type: 'fill', source: 'tiles', 'source-layer': 'building'},
      {id: 'road-casing', type: 'line', source: 'tiles', 'source-layer': 'transportation'},
      {id: 'road', type: 'line', source: 'tiles', 'source-layer': 'transportation'},
      {id: 'road-arrow', type: 'symbol', source: 'tiles', 'source-layer': 'transportation'},
      {id: 'building-3d', type: 'fill-extrusion', source: 'tiles', 'source-layer': 'building'},
      {id: 'road-name', type: 'symbol', source: 'tiles', 'source-layer': 'transportation_name'},
      {id: 'place', type: 'symbol', source: 'tiles', 'source-layer': 'place'}
    ]);
    expect(getStylePositions(style)).toEqual([
      {label: 'Below buildings', beforeId: 'building'},
      {label: 'Below roads', beforeId: 'road-casing'},
      // The arrow is a symbol layer, but a layer that is not one follows it.
      {label: 'Below labels', beforeId: 'road-name'}
    ]);
  });

  test('leaves out the positions that a style does not have', () => {
    const style = createStyle([
      {id: 'background', type: 'background'},
      {id: 'water', type: 'fill', source: 'tiles', 'source-layer': 'water'}
    ]);
    expect(getStylePositions(style)).toEqual([]);
  });
});
