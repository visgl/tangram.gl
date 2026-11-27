// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

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
  ripple: '#5d7f76'
};

/** The sprite images that the style draws as patterns. */
export const PATTERN_NAMES = ['paper', 'hatch', 'furrows', 'orchard', 'wood', 'meadow'] as const;

/** The font stacks of the style's glyphs. */
export const FONT_ROMAN = 'Antique Serif Roman';
export const FONT_ITALIC = 'Antique Serif Italic';

/** The URLs that the style loads its sprite and glyphs from; see `antique-assets.ts`. */
export type AntiqueStyleAssets = {sprite: string; glyphs: string};

/** OpenFreeMap's vector tiles, in the OpenMapTiles schema. No key is needed. */
export const OPENMAPTILES_URL = 'https://tiles.openfreemap.org/planet';

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

/** A landcover or landuse fill with a pattern drawn over it. */
function patternedFill(
  id: string,
  sourceLayer: string,
  filter: ExpressionSpecification,
  color: string,
  pattern: (typeof PATTERN_NAMES)[number],
  minzoom = 0
): LayerSpecification[] {
  return [
    {
      id,
      type: 'fill',
      source: 'openmaptiles',
      'source-layer': sourceLayer,
      filter,
      minzoom,
      paint: {'fill-color': color}
    },
    {
      id: `${id}-pattern`,
      type: 'fill',
      source: 'openmaptiles',
      'source-layer': sourceLayer,
      filter,
      minzoom: Math.max(minzoom, 11),
      paint: {'fill-pattern': pattern}
    }
  ];
}

const FARMLAND: ExpressionSpecification = [
  'all',
  ['==', ['get', 'class'], 'farmland'],
  ['!', ['in', ['get', 'subclass'], ['literal', ['orchard', 'vineyard', 'plant_nursery']]]]
];
const ORCHARD: ExpressionSpecification = [
  'in',
  ['get', 'subclass'],
  ['literal', ['orchard', 'vineyard', 'plant_nursery']]
];
const GRASS: ExpressionSpecification = ['==', ['get', 'class'], 'grass'];
const WOOD: ExpressionSpecification = ['==', ['get', 'class'], 'wood'];
const TOWN: ExpressionSpecification = [
  'in',
  ['get', 'class'],
  ['literal', ['residential', 'commercial', 'retail', 'industrial', 'neighbourhood', 'quarter']]
];

/** Road classes with their width at zoom 12 and zoom 18, in pixels. */
const ROADS: Array<{id: string; classes: string[]; z12: number; z18: number; minzoom: number}> = [
  {id: 'minor', classes: ['minor', 'service'], z12: 0.6, z18: 14, minzoom: 13},
  {id: 'secondary', classes: ['secondary', 'tertiary'], z12: 1.2, z18: 20, minzoom: 10},
  {id: 'major', classes: ['motorway', 'trunk', 'primary'], z12: 1.8, z18: 26, minzoom: 6}
];

/**
 * Returns the antique style: a parchment ground, brick-red city blocks, cream streets, sage
 * water with ripple lines, patterned fields and woods, and serif labels in brown ink. Written
 * for the OpenMapTiles schema.
 */
export function getAntiqueStyle(
  palette: AntiquePalette,
  assets: AntiqueStyleAssets
): StyleSpecification {
  const roadFilter = (classes: string[]): ExpressionSpecification => [
    'all',
    ['in', ['get', 'class'], ['literal', classes]],
    ['!=', ['get', 'brunnel'], 'tunnel']
  ];
  const roads: LayerSpecification[] = [
    ...ROADS.map(
      (road): LayerSpecification => ({
        id: `road-${road.id}-casing`,
        type: 'line',
        source: 'openmaptiles',
        'source-layer': 'transportation',
        filter: roadFilter(road.classes),
        minzoom: road.minzoom,
        layout: {'line-cap': 'butt', 'line-join': 'round'},
        paint: {
          'line-color': palette.ink,
          'line-opacity': 0.75,
          'line-width': byZoom(12, road.z12 + 0.8, 18, road.z18 + 2)
        }
      })
    ),
    ...ROADS.map(
      (road): LayerSpecification => ({
        id: `road-${road.id}`,
        type: 'line',
        source: 'openmaptiles',
        'source-layer': 'transportation',
        filter: roadFilter(road.classes),
        minzoom: road.minzoom,
        layout: {'line-cap': 'round', 'line-join': 'round'},
        paint: {'line-color': palette.street, 'line-width': byZoom(12, road.z12, 18, road.z18)}
      })
    ),
    {
      id: 'path',
      type: 'line',
      source: 'openmaptiles',
      'source-layer': 'transportation',
      filter: ['in', ['get', 'class'], ['literal', ['path', 'track']]],
      minzoom: 14,
      paint: {'line-color': palette.inkSoft, 'line-width': 0.8, 'line-dasharray': [3, 2]}
    },
    {
      id: 'rail',
      type: 'line',
      source: 'openmaptiles',
      'source-layer': 'transportation',
      filter: ['==', ['get', 'class'], 'rail'],
      minzoom: 11,
      paint: {'line-color': palette.ink, 'line-width': 1.2, 'line-dasharray': [4, 3]}
    }
  ];

  const layers: LayerSpecification[] = [
    {id: 'background', type: 'background', paint: {'background-color': palette.paper}},
    // `background-pattern` is not drawn by BasemapLayer yet, so a world polygon carries the
    // paper texture in both renderers.
    {id: 'paper', type: 'fill', source: 'paper-sheet', paint: {'fill-pattern': 'paper'}},
    ...patternedFill('farmland', 'landcover', FARMLAND, palette.field, 'furrows'),
    ...patternedFill('orchard', 'landcover', ORCHARD, palette.field, 'orchard'),
    ...patternedFill('grass', 'landcover', GRASS, palette.meadow, 'meadow'),
    {
      id: 'park',
      type: 'fill',
      source: 'openmaptiles',
      'source-layer': 'park',
      paint: {'fill-color': palette.meadow, 'fill-opacity': 0.7}
    },
    {
      id: 'field-outline',
      type: 'line',
      source: 'openmaptiles',
      'source-layer': 'landcover',
      filter: ['any', FARMLAND, ORCHARD, GRASS],
      minzoom: 12,
      paint: {
        'line-color': palette.inkSoft,
        'line-width': 0.6,
        'line-opacity': 0.8,
        'line-dasharray': [2, 2]
      }
    },
    ...patternedFill('wood', 'landcover', WOOD, palette.wood, 'wood'),
    {
      id: 'sand',
      type: 'fill',
      source: 'openmaptiles',
      'source-layer': 'landcover',
      filter: ['==', ['get', 'class'], 'sand'],
      paint: {'fill-color': palette.sand}
    },
    ...patternedFill('town', 'landuse', TOWN, palette.block, 'hatch', 10),
    {
      id: 'town-outline',
      type: 'line',
      source: 'openmaptiles',
      'source-layer': 'landuse',
      filter: TOWN,
      minzoom: 12,
      paint: {'line-color': palette.blockEdge, 'line-width': 0.8, 'line-opacity': 0.8}
    },
    {
      id: 'waterway',
      type: 'line',
      source: 'openmaptiles',
      'source-layer': 'waterway',
      filter: ['!=', ['get', 'brunnel'], 'tunnel'],
      layout: {'line-cap': 'round', 'line-join': 'round'},
      paint: {
        'line-color': palette.waterFill,
        'line-width': [
          'interpolate',
          ['exponential', 1.6],
          ['zoom'],
          10,
          ['match', ['get', 'class'], 'river', 1.5, 0.3],
          18,
          ['match', ['get', 'class'], 'river', 24, 6]
        ]
      }
    },
    {
      id: 'water',
      type: 'fill',
      source: 'openmaptiles',
      'source-layer': 'water',
      paint: {'fill-color': palette.waterFill}
    },
    // Ripple lines, the engraved coast: thin lines inside the shore, lighter away from it.
    ...[2.5, 4.5, 6.5].map(
      (offset, index): LayerSpecification => ({
        id: `water-ripple-${index + 1}`,
        type: 'line',
        source: 'openmaptiles',
        'source-layer': 'water',
        // Ponds and pools are too small for ripples.
        filter: ['in', ['get', 'class'], ['literal', ['ocean', 'lake', 'river']]],
        minzoom: 10,
        paint: {
          'line-color': palette.ripple,
          'line-width': 0.7,
          'line-offset': -offset,
          'line-opacity': [0.75, 0.5, 0.3][index]
        }
      })
    ),
    {
      id: 'water-edge',
      type: 'line',
      source: 'openmaptiles',
      'source-layer': 'water',
      paint: {'line-color': palette.waterEdge, 'line-width': byZoom(10, 0.8, 18, 2.2)}
    },
    ...roads,
    {
      id: 'building',
      type: 'fill',
      source: 'openmaptiles',
      'source-layer': 'building',
      minzoom: 13,
      paint: {'fill-color': palette.building}
    },
    {
      id: 'building-pattern',
      type: 'fill',
      source: 'openmaptiles',
      'source-layer': 'building',
      minzoom: 14,
      paint: {'fill-pattern': 'hatch'}
    },
    {
      id: 'building-outline',
      type: 'line',
      source: 'openmaptiles',
      'source-layer': 'building',
      minzoom: 14,
      paint: {'line-color': palette.blockEdge, 'line-width': 0.7}
    },
    {
      id: 'waterway-name',
      type: 'symbol',
      source: 'openmaptiles',
      'source-layer': 'waterway',
      minzoom: 12,
      layout: {
        'symbol-placement': 'line',
        'text-field': NAME,
        'text-font': [FONT_ROMAN],
        'text-size': 13,
        'text-transform': 'uppercase',
        'text-letter-spacing': 0.3
      },
      paint: {'text-color': palette.ink, 'text-halo-color': palette.waterFill, 'text-halo-width': 1}
    },
    {
      id: 'water-name',
      type: 'symbol',
      source: 'openmaptiles',
      'source-layer': 'water_name',
      layout: {
        'text-field': NAME,
        'text-font': [FONT_ROMAN],
        'text-size': byZoom(10, 13, 16, 20),
        'text-transform': 'uppercase',
        'text-letter-spacing': 0.45,
        'text-max-width': 12
      },
      paint: {'text-color': palette.ink, 'text-halo-color': palette.waterFill, 'text-halo-width': 1}
    },
    {
      id: 'street-name',
      type: 'symbol',
      source: 'openmaptiles',
      'source-layer': 'transportation_name',
      minzoom: 15,
      layout: {
        'symbol-placement': 'line',
        'text-field': NAME,
        'text-font': [FONT_ITALIC],
        'text-size': 12
      },
      paint: {'text-color': palette.ink, 'text-halo-color': palette.street, 'text-halo-width': 1.2}
    },
    {
      id: 'place-minor',
      type: 'symbol',
      source: 'openmaptiles',
      'source-layer': 'place',
      filter: ['in', ['get', 'class'], ['literal', ['suburb', 'neighbourhood', 'quarter', 'village', 'hamlet']]],
      minzoom: 11,
      layout: {
        'text-field': NAME,
        'text-font': [FONT_ITALIC],
        'text-size': byZoom(11, 12, 16, 16),
        'text-max-width': 8
      },
      paint: {'text-color': palette.ink, 'text-halo-color': palette.paper, 'text-halo-width': 1.5}
    },
    {
      id: 'place-major',
      type: 'symbol',
      source: 'openmaptiles',
      'source-layer': 'place',
      filter: ['in', ['get', 'class'], ['literal', ['city', 'town']]],
      layout: {
        'text-field': NAME,
        'text-font': [FONT_ROMAN],
        'text-size': byZoom(8, 14, 15, 24),
        'text-transform': 'uppercase',
        'text-letter-spacing': 0.2,
        'text-max-width': 10
      },
      paint: {'text-color': palette.ink, 'text-halo-color': palette.paper, 'text-halo-width': 2}
    }
  ];

  return {
    version: 8,
    name: 'Antique',
    sprite: assets.sprite,
    glyphs: assets.glyphs,
    sources: {
      openmaptiles: {
        type: 'vector',
        url: OPENMAPTILES_URL,
        attribution:
          '<a href="https://openfreemap.org" target="_blank">OpenFreeMap</a> <a href="https://www.openmaptiles.org/" target="_blank">&copy; OpenMapTiles</a> Data from <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a>'
      },
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
