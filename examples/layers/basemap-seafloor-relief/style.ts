// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/** The Terrarium tiles of the AWS Terrain Tiles open data set. They hold land and seabed heights. */
export const TERRARIUM_TILES =
  'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';

/** The highest zoom at which the Terrarium tiles hold seabed heights. */
export const TERRARIUM_MAX_ZOOM = 10;

/** The color ramps of the example, by key. */
export type RampKey = 'ocean-land' | 'depth-bands' | 'land-gray';

/** `[elevation in meters, color]` pairs, from low to high. */
type Stops = [number, string][];

/** The sea part of two ramps: dark at depth, pale at the coast. */
const SEA_STOPS: Stops = [
  [-4500, '#071a33'],
  [-3000, '#0c3566'],
  [-1500, '#1b5c99'],
  [-500, '#3787c2'],
  [-100, '#76bde0'],
  [-1, '#c4e8f3']
];

/**
 * The stops of each ramp. Each ramp changes color at 0 m, so the coast is the line between the
 * blues and the land colors.
 */
const RAMPS: Record<RampKey, {label: string; stops: Stops}> = {
  'ocean-land': {
    label: 'Ocean and land',
    stops: [
      ...SEA_STOPS,
      [0, '#4f8a4a'],
      [250, '#97b268'],
      [800, '#c9b37c'],
      [1500, '#9a7856'],
      [2500, '#f2efe9']
    ]
  },
  'depth-bands': {
    // `step` draws nothing in `color-relief`. Two stops 1 m apart make a sharp edge instead.
    label: 'Depth bands',
    stops: [
      [-3001, '#0b2c57'],
      [-3000, '#174a85'],
      [-2001, '#174a85'],
      [-2000, '#2a6aaa'],
      [-1001, '#2a6aaa'],
      [-1000, '#4b91c9'],
      [-201, '#4b91c9'],
      [-200, '#a7dcef'],
      [-1, '#a7dcef'],
      [0, '#e9dfc6']
    ]
  },
  'land-gray': {
    label: 'Sea only (land in gray)',
    stops: [...SEA_STOPS, [0, '#d6d6d2'], [2000, '#6f6f6c']]
  }
};

/** The options of the ramp control. */
export const RAMP_OPTIONS = (Object.keys(RAMPS) as RampKey[]).map(value => ({
  value,
  label: RAMPS[value].label
}));

/** The MapLibre `color-relief-color` expression of a ramp. */
export function getColorReliefColor(ramp: RampKey): unknown[] {
  return ['interpolate', ['linear'], ['elevation'], ...RAMPS[ramp].stops.flat()];
}

/**
 * A style with one `raster-dem` source, a `color-relief` layer and, if `hillshade` is true, a
 * `hillshade` layer above it. Both layers read the same decoded DEM tiles.
 */
export function createSeafloorStyle(ramp: RampKey, hillshade: boolean) {
  return {
    version: 8,
    sources: {
      dem: {
        type: 'raster-dem',
        tiles: [TERRARIUM_TILES],
        tileSize: 256,
        encoding: 'terrarium',
        maxzoom: TERRARIUM_MAX_ZOOM
      }
    },
    layers: [
      // Shows where no layer draws, for example on WebGPU, which draws no color relief.
      {id: 'background', type: 'background', paint: {'background-color': '#8c9196'}},
      {
        id: 'relief',
        type: 'color-relief',
        source: 'dem',
        paint: {'color-relief-color': getColorReliefColor(ramp)}
      },
      ...(hillshade
        ? [
            {
              id: 'hillshade',
              type: 'hillshade',
              source: 'dem',
              paint: {
                'hillshade-exaggeration': 0.6,
                'hillshade-illumination-direction': 315,
                'hillshade-shadow-color': '#06121f',
                'hillshade-highlight-color': '#ffffff',
                'hillshade-accent-color': '#06121f'
              }
            }
          ]
        : [])
    ]
  };
}
