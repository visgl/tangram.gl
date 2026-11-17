// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {describe, expect, test} from 'vitest';
import {
  EARTHQUAKE_SOURCE_ID,
  HEATMAP_STYLE_LAYER_ID,
  getStyle,
  getWeight,
  wrapLongitude,
  type Earthquake,
  type EarthquakeCollection,
  type Style
} from '../examples/layers/basemap-heatmap/heatmap-data';
import {compileStylePropertyValue} from '../modules/basemap-layers/src/style-expression';

function createEarthquake(mag: number | null): Earthquake {
  return {
    type: 'Feature',
    geometry: {type: 'Point', coordinates: [0, 0, 10]},
    properties: {mag, place: null, time: 0}
  };
}

const EARTHQUAKES: EarthquakeCollection = {
  type: 'FeatureCollection',
  features: [createEarthquake(4.2)]
};

const BASE_STYLE: Style = {
  version: 8,
  sources: {tiles: {type: 'vector', tiles: ['https://example.com/{z}/{x}/{y}.pbf']}},
  layers: [
    {id: 'background', type: 'background'},
    {id: 'water', type: 'fill', source: 'tiles', 'source-layer': 'water'},
    {id: 'place', type: 'symbol', source: 'tiles', 'source-layer': 'place'},
    {id: 'road-label', type: 'symbol', source: 'tiles', 'source-layer': 'road'}
  ]
};

const KERNEL = {radius: 14, intensity: 0.4};

describe('getStyle', () => {
  test('adds the heatmap layer below the first symbol layer', () => {
    const style = getStyle(BASE_STYLE, EARTHQUAKES, 'magnitude', KERNEL);
    expect(style.layers.map(layer => layer.id)).toEqual([
      'background',
      'water',
      HEATMAP_STYLE_LAYER_ID,
      'place',
      'road-label'
    ]);
    expect(style.sources[EARTHQUAKE_SOURCE_ID]).toEqual({type: 'geojson', data: EARTHQUAKES});
    expect(BASE_STYLE.layers).toHaveLength(4);
  });

  test('adds the heatmap layer on top when the style has no symbol layer', () => {
    const style = getStyle(
      {...BASE_STYLE, layers: BASE_STYLE.layers.slice(0, 2)},
      EARTHQUAKES,
      'count',
      KERNEL
    );
    expect(style.layers.at(-1)?.id).toBe(HEATMAP_STYLE_LAYER_ID);
  });

  test('returns the base style until the earthquakes load', () => {
    expect(getStyle(BASE_STYLE, null, 'count', KERNEL)).toBe(BASE_STYLE);
  });

  test('gives valid paint properties', () => {
    const style = getStyle(BASE_STYLE, EARTHQUAKES, 'magnitude', KERNEL);
    const paint = style.layers.find(layer => layer.id === HEATMAP_STYLE_LAYER_ID)?.paint as Record<
      string,
      unknown
    >;
    expect(paint['heatmap-radius']).toBe(14);
    expect(paint['heatmap-intensity']).toBe(0.4);
    for (const [name, value] of Object.entries(paint)) {
      expect(compileStylePropertyValue(name, value), name).not.toBeNull();
    }
  });
});

describe('getWeight', () => {
  test('gives the deck.gl layer the weights of the style expression', () => {
    const style = getStyle(BASE_STYLE, EARTHQUAKES, 'magnitude', KERNEL);
    const paint = style.layers.find(layer => layer.id === HEATMAP_STYLE_LAYER_ID)?.paint as Record<
      string,
      unknown
    >;
    const weight = compileStylePropertyValue('heatmap-weight', paint['heatmap-weight'])!;
    for (const mag of [null, 0, 2.5, 4.2, 6, 7.8]) {
      const feature = createEarthquake(mag);
      expect(getWeight(feature, 'magnitude')).toBeCloseTo(
        weight.evaluate(0, {properties: feature.properties}) as number,
        6
      );
    }
  });

  test('counts each earthquake as 1', () => {
    expect(getWeight(createEarthquake(7), 'count')).toBe(1);
  });
});

describe('wrapLongitude', () => {
  test('places the longitude within 180 degrees of the center', () => {
    expect(wrapLongitude(-160, 180)).toBe(200);
    expect(wrapLongitude(170, -170)).toBe(-190);
    expect(wrapLongitude(30, 0)).toBe(30);
    expect(wrapLongitude(-150, 30)).toBe(-150);
    expect(wrapLongitude(-151, 30)).toBe(209);
  });
});
