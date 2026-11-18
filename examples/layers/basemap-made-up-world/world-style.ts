// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

// The antique style of the antique map style example, changed for the generated world: the same
// palette and patterns, no roads or buildings, and large sea names, curved river names, peaks and
// towns.

import type {
  ExpressionSpecification,
  LayerSpecification,
  StyleSpecification
} from 'maplibre-gl';

/**
 * The color roles of the antique style. The style is generated from these values, so a muted
 * or a more vivid map is a change of the roles, not a second style.
 */
export type AntiquePalette = {
  /** The parchment ground. */
  paper: string;
  /** Dark-brown ink for labels, casings and outlines. */
  ink: string;
  /** Softer ink for minor lines and dashed outlines. */
  inkSoft: string;
  /** Streets, drawn in the color of a lighter parchment so that blocks read as islands. */
  street: string;
  /** Residential and commercial land, and the fill under buildings. */
  block: string;
  /** Buildings, a little darker than blocks. */
  building: string;
  /** The outline of blocks and buildings. */
  blockEdge: string;
  /** Farmland. */
  field: string;
  /** Grass, meadows and parks. */
  meadow: string;
  /** Woods and forests, under the crown pattern. */
  wood: string;
  /** Sand and beaches. */
  sand: string;
  /** Open water, paler than the edge so that the color reads as distance from shore. */
  waterFill: string;
  /** The line along every shore. */
  waterEdge: string;
  /** The ripple lines inside the shore. */
  ripple: string;
  /** Glaciers and polar ice. */
  ice: string;
  /** Bare rock and high mountains. */
  rock: string;
  /** Marsh. */
  wetland: string;
};

/** The palette at saturation 1, read from an engraved and hand-colored city map. */
export const ANTIQUE_PALETTE: AntiquePalette = {
  paper: '#d9c9a0',
  ink: '#4e3b28',
  inkSoft: '#7a6247',
  street: '#ece0bf',
  block: '#9e4a35',
  building: '#8b3e2b',
  blockEdge: '#5e2a1c',
  field: '#cdc68f',
  meadow: '#bcc08a',
  wood: '#9eab78',
  sand: '#e2cf9f',
  waterFill: '#8fb0a5',
  waterEdge: '#6f958b',
  ripple: '#5d7f76',
  ice: '#ece6d2',
  rock: '#b8a585',
  wetland: '#a9b89a'
};

/** The sprite images that the style draws as patterns. */
export const PATTERN_NAMES = ['paper', 'hatch', 'furrows', 'orchard', 'wood', 'meadow'] as const;

/** The font stacks of the style's glyphs. */
export const FONT_ROMAN = 'Antique Serif Roman';
export const FONT_ITALIC = 'Antique Serif Italic';

/** The URLs that the style loads its sprite and glyphs from; see `style-assets.ts`. */
export type AntiqueStyleAssets = {sprite: string; glyphs: string};


const parseHex = (color: string): [number, number, number] => [
  parseInt(color.slice(1, 3), 16),
  parseInt(color.slice(3, 5), 16),
  parseInt(color.slice(5, 7), 16)
];

const toHex = (rgb: number[]): string =>
  `#${rgb
    .map(value => Math.round(Math.min(255, Math.max(0, value))).toString(16).padStart(2, '0'))
    .join('')}`;

/**
 * Changes the saturation of a color. At 1 the color does not change. Below 1 it moves toward a
 * sepia tone of the same lightness, as old hand coloring fades; at 0 it is that tone. Above 1
 * it moves away from gray.
 */
export function saturateColor(color: string, saturation: number): string {
  const rgb = parseHex(color);
  const luminance = 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2];
  if (saturation >= 1) {
    return toHex(rgb.map(value => luminance + (value - luminance) * saturation));
  }
  const sepia = [luminance * 1.07, luminance * 0.98, luminance * 0.82];
  return toHex(rgb.map((value, index) => sepia[index] + (value - sepia[index]) * saturation));
}

/** The palette with each role at the given saturation. */
export function getAntiquePalette(saturation: number, base = ANTIQUE_PALETTE): AntiquePalette {
  return Object.fromEntries(
    Object.entries(base).map(([role, color]) => [role, saturateColor(color, saturation)])
  ) as AntiquePalette;
}


const NAME: ExpressionSpecification = ['coalesce', ['get', 'name:latin'], ['get', 'name']];

const byZoom = (...stops: number[]): ExpressionSpecification =>
  ['interpolate', ['exponential', 1.6], ['zoom'], ...stops] as ExpressionSpecification;
const linear = (...stops: number[]): ExpressionSpecification =>
  ['interpolate', ['linear'], ['zoom'], ...stops] as ExpressionSpecification;

const SOURCE = 'world';
const isClass = (...classes: string[]): ExpressionSpecification =>
  classes.length === 1
    ? ['==', ['get', 'class'], classes[0]]
    : ['in', ['get', 'class'], ['literal', classes]];

/** A landcover fill with a pattern over it from `patternZoom`. */
function patternedFill(
  id: string,
  filter: ExpressionSpecification,
  color: string,
  pattern: (typeof PATTERN_NAMES)[number] | null,
  patternZoom = 6
): LayerSpecification[] {
  const fill: LayerSpecification = {
    id,
    type: 'fill',
    source: SOURCE,
    'source-layer': 'landcover',
    filter,
    paint: {'fill-color': color}
  };
  return pattern
    ? [
        fill,
        {
          id: `${id}-pattern`,
          type: 'fill',
          source: SOURCE,
          'source-layer': 'landcover',
          filter,
          minzoom: patternZoom,
          paint: {'fill-pattern': pattern}
        }
      ]
    : [fill];
}

/**
 * The antique style for the generated world. `sourceUrl` is the TileJSON URL of the world
 * source, such as `world://42/tilejson?sea=0`; a new seed is a new URL, so a new source.
 */
export function getWorldStyle(
  palette: AntiquePalette,
  assets: AntiqueStyleAssets,
  sourceUrl: string
): StyleSpecification {
  const layers: LayerSpecification[] = [
    {id: 'background', type: 'background', paint: {'background-color': palette.paper}},
    {id: 'paper', type: 'fill', source: 'paper-sheet', paint: {'fill-pattern': 'paper'}},
    ...patternedFill('farmland', isClass('farmland'), palette.field, 'furrows', 7),
    ...patternedFill('grass', isClass('grass'), palette.meadow, 'meadow', 7),
    ...patternedFill('wood', isClass('wood'), palette.wood, 'wood', 5),
    ...patternedFill('wetland', isClass('wetland'), palette.wetland, 'meadow', 7),
    ...patternedFill('sand', isClass('sand'), palette.sand, null),
    ...patternedFill('rock', isClass('rock'), palette.rock, 'hatch', 6),
    ...patternedFill('ice', isClass('ice'), palette.ice, null),
    {
      id: 'landcover-outline',
      type: 'line',
      source: SOURCE,
      'source-layer': 'landcover',
      minzoom: 7,
      paint: {
        'line-color': palette.inkSoft,
        'line-width': 0.5,
        'line-opacity': 0.6,
        'line-dasharray': [2, 2]
      }
    },
    {
      id: 'town',
      type: 'fill',
      source: SOURCE,
      'source-layer': 'landuse',
      filter: isClass('residential'),
      paint: {'fill-color': palette.block, 'fill-opacity': 0.85}
    },
    {
      id: 'town-pattern',
      type: 'fill',
      source: SOURCE,
      'source-layer': 'landuse',
      filter: isClass('residential'),
      minzoom: 9,
      paint: {'fill-pattern': 'hatch'}
    },
    {
      id: 'town-outline',
      type: 'line',
      source: SOURCE,
      'source-layer': 'landuse',
      filter: isClass('residential'),
      paint: {'line-color': palette.blockEdge, 'line-width': 0.8, 'line-opacity': 0.8}
    },
    {
      id: 'waterway',
      type: 'line',
      source: SOURCE,
      'source-layer': 'waterway',
      layout: {'line-cap': 'round', 'line-join': 'round'},
      paint: {
        'line-color': palette.waterEdge,
        'line-width': [
          'interpolate',
          ['exponential', 1.4],
          ['zoom'],
          2,
          ['match', ['get', 'class'], 'river', 1, 0.5],
          8,
          ['match', ['get', 'class'], 'river', 2.6, 1.1],
          12,
          ['match', ['get', 'class'], 'river', 7, 2.5]
        ]
      }
    },
    {
      id: 'water',
      type: 'fill',
      source: SOURCE,
      'source-layer': 'water',
      paint: {'fill-color': palette.waterFill}
    },
    // Ripple lines, the engraved coast: thin lines inside the shore, lighter away from it.
    ...[2.5, 4.5, 6.5, 9].map(
      (offset, index): LayerSpecification => ({
        id: `water-ripple-${index + 1}`,
        type: 'line',
        source: SOURCE,
        'source-layer': 'water',
        minzoom: 3,
        paint: {
          'line-color': palette.ripple,
          'line-width': 0.7,
          'line-offset': -offset,
          'line-opacity': [0.75, 0.5, 0.3, 0.18][index]
        }
      })
    ),
    {
      id: 'water-edge',
      type: 'line',
      source: SOURCE,
      'source-layer': 'water',
      paint: {'line-color': palette.ink, 'line-width': byZoom(2, 0.6, 12, 1.8), 'line-opacity': 0.8}
    },
    {
      id: 'peak-dot',
      type: 'circle',
      source: SOURCE,
      'source-layer': 'mountain_peak',
      paint: {
        'circle-radius': 3.5,
        'circle-color': palette.ink,
        'circle-stroke-color': palette.paper,
        'circle-stroke-width': 1
      }
    },
    {
      id: 'peak-name',
      type: 'symbol',
      source: SOURCE,
      'source-layer': 'mountain_peak',
      layout: {
        'text-field': ['concat', NAME, '\n', ['to-string', ['get', 'ele']], ' m'],
        'text-font': [FONT_ITALIC],
        'text-size': linear(4, 12, 10, 16),
        'text-anchor': 'top',
        'text-offset': [0, 0.5]
      },
      paint: {'text-color': palette.ink, 'text-halo-color': palette.paper, 'text-halo-width': 2}
    },
    {
      id: 'waterway-name',
      type: 'symbol',
      source: SOURCE,
      'source-layer': 'waterway',
      filter: ['has', 'name'],
      minzoom: 5,
      layout: {
        'symbol-placement': 'line',
        'symbol-spacing': 350,
        'text-field': NAME,
        'text-font': [FONT_ITALIC],
        'text-size': linear(5, 11, 12, 15),
        'text-letter-spacing': 0.25,
        'text-offset': [0, -0.6]
      },
      paint: {'text-color': palette.ripple, 'text-halo-color': palette.paper, 'text-halo-width': 1.2}
    },
    {
      id: 'ocean-name',
      type: 'symbol',
      source: SOURCE,
      'source-layer': 'water_name',
      filter: isClass('ocean'),
      layout: {
        'text-field': NAME,
        'text-font': [FONT_ITALIC],
        'text-size': linear(0, 13, 2, 20, 5, 34),
        'text-transform': 'uppercase',
        'text-letter-spacing': 0.6,
        'text-max-width': 6
      },
      paint: {'text-color': palette.ripple, 'text-halo-color': palette.waterFill, 'text-halo-width': 1}
    },
    {
      id: 'sea-name',
      type: 'symbol',
      source: SOURCE,
      'source-layer': 'water_name',
      filter: isClass('sea'),
      layout: {
        'text-field': NAME,
        'text-font': [FONT_ITALIC],
        'text-size': linear(2, 12, 6, 22),
        'text-transform': 'uppercase',
        'text-letter-spacing': 0.4,
        'text-max-width': 6
      },
      paint: {'text-color': palette.ripple, 'text-halo-color': palette.waterFill, 'text-halo-width': 1}
    },
    {
      id: 'lake-name',
      type: 'symbol',
      source: SOURCE,
      'source-layer': 'water_name',
      filter: isClass('lake'),
      layout: {'text-field': NAME, 'text-font': [FONT_ITALIC], 'text-size': 13},
      paint: {'text-color': palette.ink, 'text-halo-color': palette.waterFill, 'text-halo-width': 1}
    },
    {
      id: 'place-dot',
      type: 'circle',
      source: SOURCE,
      'source-layer': 'place',
      paint: {
        'circle-radius': ['match', ['get', 'class'], 'city', 4, 'town', 3, 2],
        'circle-color': palette.paper,
        'circle-stroke-color': palette.ink,
        'circle-stroke-width': ['match', ['get', 'class'], 'city', 2, 1.2]
      }
    },
    {
      id: 'place-village',
      type: 'symbol',
      source: SOURCE,
      'source-layer': 'place',
      filter: isClass('village'),
      layout: {
        'text-field': NAME,
        'text-font': [FONT_ITALIC],
        'text-size': linear(7, 11, 12, 14),
        'text-anchor': 'left',
        'text-offset': [0.6, 0]
      },
      paint: {'text-color': palette.ink, 'text-halo-color': palette.paper, 'text-halo-width': 1.5}
    },
    {
      id: 'place-town',
      type: 'symbol',
      source: SOURCE,
      'source-layer': 'place',
      filter: isClass('town'),
      layout: {
        'text-field': NAME,
        'text-font': [FONT_ROMAN],
        'text-size': linear(5, 12, 12, 17),
        'text-anchor': 'left',
        'text-offset': [0.7, 0]
      },
      paint: {'text-color': palette.ink, 'text-halo-color': palette.paper, 'text-halo-width': 1.8}
    },
    {
      id: 'place-city',
      type: 'symbol',
      source: SOURCE,
      'source-layer': 'place',
      filter: isClass('city'),
      layout: {
        'text-field': NAME,
        'text-font': [FONT_ROMAN],
        'text-size': linear(2, 12, 8, 20, 12, 24),
        'text-transform': 'uppercase',
        'text-letter-spacing': 0.15,
        'text-anchor': 'left',
        'text-offset': [0.8, 0]
      },
      paint: {'text-color': palette.ink, 'text-halo-color': palette.paper, 'text-halo-width': 2}
    }
  ];

  return {
    version: 8,
    name: 'Antique world',
    sprite: assets.sprite,
    glyphs: assets.glyphs,
    sources: {
      [SOURCE]: {type: 'vector', url: sourceUrl, attribution: 'Generated world'},
      'paper-sheet': {
        type: 'geojson',
        data: {
          type: 'Polygon',
          coordinates: [
            [
              [-180, -85.06],
              [180, -85.06],
              [180, 85.06],
              [-180, 85.06],
              [-180, -85.06]
            ]
          ]
        }
      }
    },
    layers
  };
}
