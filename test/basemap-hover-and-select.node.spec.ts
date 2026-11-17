// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {describe, expect, test} from 'vitest';
import type {BasemapPickedFeature} from '@tangram.gl/basemap-layers';
import {
  fetchStyle,
  getFeatureKey,
  getFeatureState,
  getHighlightLayerIds,
  isSameFeature,
  withHoverAndSelect,
  type StyleDocument,
  type StyleLayer
} from '../examples/layers/basemap-hover-and-select/feature-highlight';
import {compileStylePropertyValue} from '../modules/basemap-layers/src/style-expression';

// The helpers of the hover and select example: the paint that reads the feature states, the
// outline layers, the `featureState` prop and the comparison of two picks.

const COLORS = {
  hover: '#00ff00',
  selected: '#0000ff',
  hoverOutline: '#008000',
  selectedOutline: '#000080'
};
const HOVER_RGBA = [0, 255, 0, 1];
const SELECTED_RGBA = [0, 0, 255, 1];
const FEATURE = {type: 'Feature', id: 1, properties: {}, geometry: {type: 'Point', coordinates: [0, 0]}};

function createStyle(layers: StyleLayer[]): StyleDocument {
  return {
    version: 8,
    sources: {tiles: {type: 'vector', url: 'https://example.com/tiles.json'}},
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

function toUnitRgba(color: unknown): number[] {
  return (color as number[]).map(channel => Math.round(channel * 1000) / 1000);
}

function picked(overrides: Partial<BasemapPickedFeature> = {}): BasemapPickedFeature {
  return {
    id: 7,
    source: 'tiles',
    sourceLayer: 'building',
    styleLayerId: 'building',
    properties: {},
    ...overrides
  };
}

const STYLE = createStyle([
  {id: 'background', type: 'background'},
  {id: 'park', type: 'fill', source: 'tiles', 'source-layer': 'park', paint: {'fill-color': '#ff0000'}},
  {id: 'park-line', type: 'line', source: 'tiles', 'source-layer': 'park'},
  {id: 'pitch', type: 'fill', source: 'tiles', 'source-layer': 'landuse', paint: {'fill-color': '#ff0000'}},
  {id: 'school', type: 'fill', source: 'tiles', 'source-layer': 'landuse', paint: {'fill-color': '#ff0000'}},
  {
    id: 'building',
    type: 'fill',
    source: 'tiles',
    'source-layer': 'building',
    minzoom: 13,
    paint: {'fill-color': ['interpolate', ['linear'], ['zoom'], 13, '#ff0000', 16, '#ffffff']}
  },
  {
    id: 'building-3d',
    type: 'fill-extrusion',
    source: 'tiles',
    'source-layer': 'building',
    paint: {'fill-extrusion-color': '#ff0000'}
  },
  {id: 'label', type: 'symbol', source: 'tiles', 'source-layer': 'place'}
]);
const NAMED = ['park', 'pitch', 'school', 'building', 'building-3d'];

describe('withHoverAndSelect', () => {
  const style = withHoverAndSelect(STYLE, NAMED, COLORS);
  const layer = (id: string) => style.layers.find(candidate => candidate.id === id)!;

  test('adds one outline after the last named fill of each source layer', () => {
    expect(style.layers.map(({id}) => id)).toEqual([
      'background',
      'park',
      'highlight-outline-park',
      'park-line',
      'pitch',
      'school',
      'highlight-outline-landuse',
      'building',
      'highlight-outline-building',
      'building-3d',
      'label'
    ]);
    expect(layer('highlight-outline-building')).toMatchObject({
      type: 'line',
      source: 'tiles',
      'source-layer': 'building',
      minzoom: 13
    });
  });

  test('the fill color reads hover and selected, and selected wins', () => {
    const color = layer('park').paint!['fill-color'];
    expect(toUnitRgba(evaluate('fill-color', color, 14, {}))).toEqual([255, 0, 0, 1]);
    expect(toUnitRgba(evaluate('fill-color', color, 14, {hover: true}))).toEqual(HOVER_RGBA);
    expect(toUnitRgba(evaluate('fill-color', color, 14, {selected: true}))).toEqual(SELECTED_RGBA);
    expect(toUnitRgba(evaluate('fill-color', color, 14, {hover: true, selected: true}))).toEqual(
      SELECTED_RGBA
    );
  });

  test('a zoom curve keeps its shape, and each output reads the states', () => {
    const color = layer('building').paint!['fill-color'] as unknown[];
    expect(color.slice(0, 3)).toEqual(['interpolate', ['linear'], ['zoom']]);
    expect(toUnitRgba(evaluate('fill-color', color, 16, {}))).toEqual([255, 255, 255, 1]);
    expect(toUnitRgba(evaluate('fill-color', color, 14, {hover: true}))).toEqual(HOVER_RGBA);
  });

  test('the extrusion color reads the states', () => {
    const color = layer('building-3d').paint!['fill-extrusion-color'];
    expect(toUnitRgba(evaluate('fill-extrusion-color', color, 16, {selected: true}))).toEqual(
      SELECTED_RGBA
    );
  });

  test('the outline width is 0 without a state', () => {
    const width = layer('highlight-outline-park').paint!['line-width'];
    expect(evaluate('line-width', width, 14, {})).toBe(0);
    expect(evaluate('line-width', width, 14, {hover: true})).toBe(2);
    expect(evaluate('line-width', width, 14, {selected: true})).toBe(3);
  });

  test('the other layers do not change', () => {
    expect(layer('park-line')).toBe(STYLE.layers[2]);
    expect(layer('label')).toBe(STYLE.layers[7]);
  });

  test('throws for a layer that is missing or that has no fill color', () => {
    expect(() => withHoverAndSelect(STYLE, ['missing'], COLORS)).toThrow(/no layer "missing"/);
    expect(() => withHoverAndSelect(STYLE, ['park-line'], COLORS)).toThrow(/line layer/);
  });

  test('getHighlightLayerIds has the named layers and the outlines', () => {
    expect([...getHighlightLayerIds(style, NAMED)].sort()).toEqual(
      [...NAMED, 'highlight-outline-building', 'highlight-outline-landuse', 'highlight-outline-park'].sort()
    );
  });
});

describe('getFeatureState', () => {
  test('is null without a feature', () => {
    expect(getFeatureState(null, null, null)).toBeNull();
  });

  test('addresses the features by source, source layer and id', () => {
    expect(getFeatureState(picked({id: 1}), picked({id: 2, sourceLayer: 'park'}), null)).toEqual({
      tiles: {building: {1: {hover: true}}, park: {2: {selected: true}}}
    });
  });

  test('one feature can be hovered and selected', () => {
    expect(getFeatureState(picked(), picked({styleLayerId: 'building-3d'}), null)).toEqual({
      tiles: {building: {7: {hover: true, selected: true}}}
    });
  });

  test('a feature without an id has no state', () => {
    expect(getFeatureState(picked({id: undefined}), null, null)).toBeNull();
  });

  test('returns the previous object for the same states', () => {
    const previous = getFeatureState(picked(), null, null);
    expect(getFeatureState(picked(), null, previous)).toBe(previous);
    expect(getFeatureState(picked({id: 8}), null, previous)).not.toBe(previous);
  });
});

describe('isSameFeature', () => {
  test('two picks of one feature in two style layers are the same feature', () => {
    expect(isSameFeature(picked(), picked({styleLayerId: 'building-3d'}))).toBe(true);
    expect(isSameFeature(picked(), picked({id: 8}))).toBe(false);
    expect(isSameFeature(picked(), picked({sourceLayer: 'park'}))).toBe(false);
    expect(isSameFeature(null, null)).toBe(true);
    expect(getFeatureKey(null)).toBe('');
  });
});

describe('fetchStyle', () => {
  const respond = (response: Partial<Response>) =>
    (async () => response as Response) as unknown as typeof fetch;

  test('returns the style document', async () => {
    const style = await fetchStyle('style.json', respond({ok: true, json: async () => STYLE}));
    expect(style).toBe(STYLE);
  });

  test('rejects with the status of a response that is not OK', async () => {
    await expect(
      fetchStyle('style.json', respond({ok: false, status: 503, statusText: 'Service Unavailable'}))
    ).rejects.toThrow('style.json failed: 503 Service Unavailable');
  });
});
