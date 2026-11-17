// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import type {Color} from '@deck.gl/core';

export type RendererId = 'style' | 'deck';
export type WeightId = 'count' | 'magnitude';

/** The radius in pixels and the intensity of one heatmap. */
export type KernelSettings = {radius: number; intensity: number};

/** An earthquake of the USGS GeoJSON summary feed. */
export type Earthquake = {
  type: 'Feature';
  geometry: {type: 'Point'; coordinates: number[]};
  properties: {mag: number | null; place: string | null; time: number};
};

export type EarthquakeCollection = {type: 'FeatureCollection'; features: Earthquake[]};

export type StyleLayer = {id: string; type: string; [key: string]: unknown};

export type Style = {sources: Record<string, unknown>; layers: StyleLayer[]; [key: string]: unknown};

export const EARTHQUAKE_SOURCE_ID = 'earthquakes';
export const HEATMAP_STYLE_LAYER_ID = 'earthquake-heatmap';

/**
 * The color of each density, from 0 to 1. The style heatmap uses all stops. The deck.gl
 * `HeatmapLayer` takes the colors without the transparent first stop, and fades the lowest
 * weights itself.
 */
export const COLOR_STOPS: [number, Color][] = [
  [0, [33, 102, 172, 0]],
  [0.2, [103, 169, 207, 255]],
  [0.4, [209, 229, 240, 255]],
  [0.6, [253, 219, 199, 255]],
  [0.8, [239, 138, 98, 255]],
  [1, [178, 24, 43, 255]]
];

/** The magnitude that gets a weight of 1. Weights go linearly from 0 at magnitude 0. */
export const FULL_WEIGHT_MAGNITUDE = 6;

/**
 * The base style with the earthquakes as a GeoJSON source and a `heatmap` layer below the first
 * `symbol` layer, so that the labels stay on top.
 */
export function getStyle(
  baseStyle: Style,
  earthquakes: EarthquakeCollection | null,
  weight: WeightId,
  {radius, intensity}: KernelSettings
): Style {
  if (!earthquakes) {
    return baseStyle;
  }
  const heatmapLayer: StyleLayer = {
    id: HEATMAP_STYLE_LAYER_ID,
    type: 'heatmap',
    source: EARTHQUAKE_SOURCE_ID,
    paint: {
      'heatmap-radius': radius,
      'heatmap-intensity': intensity,
      'heatmap-weight':
        weight === 'magnitude'
          ? [
              'interpolate',
              ['linear'],
              ['to-number', ['get', 'mag'], 0],
              0,
              0,
              FULL_WEIGHT_MAGNITUDE,
              1
            ]
          : 1,
      'heatmap-color': [
        'interpolate',
        ['linear'],
        ['heatmap-density'],
        ...COLOR_STOPS.flatMap(([density, [r, g, b, a = 255]]) => [
          density,
          `rgba(${r}, ${g}, ${b}, ${a / 255})`
        ])
      ]
    }
  };
  const labelIndex = baseStyle.layers.findIndex(layer => layer.type === 'symbol');
  const index = labelIndex === -1 ? baseStyle.layers.length : labelIndex;
  return {
    ...baseStyle,
    sources: {
      ...baseStyle.sources,
      // The data object, not its URL: a new style then does not load the earthquakes again.
      [EARTHQUAKE_SOURCE_ID]: {type: 'geojson', data: earthquakes}
    },
    layers: [...baseStyle.layers.slice(0, index), heatmapLayer, ...baseStyle.layers.slice(index)]
  };
}

/** The weight of an earthquake for the deck.gl layer: the same values as the style expression. */
export function getWeight(feature: Earthquake, weight: WeightId): number {
  if (weight === 'count') {
    return 1;
  }
  const magnitude = feature.properties.mag ?? 0;
  return Math.min(Math.max(magnitude / FULL_WEIGHT_MAGNITUDE, 0), 1);
}

/** The longitude of the same meridian within 180 degrees of `center`. */
export function wrapLongitude(longitude: number, center: number): number {
  return center + ((((longitude - center + 180) % 360) + 360) % 360) - 180;
}

/** The longitude and latitude of an earthquake. The feed adds the depth as a third value. */
export function getLngLat(feature: Earthquake): [number, number] {
  const [longitude, latitude] = feature.geometry.coordinates;
  return [longitude, latitude];
}
