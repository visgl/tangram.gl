// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/** A layer of a MapLibre style document, as far as this example reads it. */
export type StyleLayer = {
  id: string;
  type: string;
  source?: string;
  'source-layer'?: string;
  paint?: Record<string, unknown>;
  [key: string]: unknown;
};

/** A MapLibre style document, as far as this example reads it. */
export type StyleDocument = {
  version: 8;
  sources: Record<string, Record<string, unknown>>;
  layers: StyleLayer[];
  [key: string]: unknown;
};

/**
 * Fetches a style document. Rejects with the URL and the HTTP status when the response is not OK,
 * and with the error of `fetch` or of the JSON parser.
 */
export async function fetchStyle(
  url: string,
  fetchFunction: typeof fetch = fetch
): Promise<StyleDocument> {
  const response = await fetchFunction(url);
  if (!response.ok) {
    throw new Error(`${url} failed: ${response.status} ${response.statusText}`.trim());
  }
  return (await response.json()) as StyleDocument;
}

/** The colors of a hovered and of a selected basemap feature. */
export type HighlightColors = {hover: string; selected: string};

/** The paint property that holds the color of each layer type that reads feature state. */
const COLOR_PROPERTIES: Record<string, string> = {
  fill: 'fill-color',
  line: 'line-color',
  circle: 'circle-color',
  'fill-extrusion': 'fill-extrusion-color'
};

/** The paint property that disables the color of a layer type, when it is set. */
const PATTERN_PROPERTIES: Record<string, string> = {
  fill: 'fill-pattern',
  line: 'line-pattern',
  'fill-extrusion': 'fill-extrusion-pattern'
};

/** The style specification's default of every color property in `COLOR_PROPERTIES`. */
const DEFAULT_COLOR = '#000000';

const ZOOM_CURVES = new Set(['interpolate', 'interpolate-hcl', 'interpolate-lab', 'step']);

/**
 * Splits a style at one of its layers. `below` has the layers that draw before `beforeId`, and
 * `above` has `beforeId` and the layers after it. Each part is a complete style: it keeps the
 * sources, the sprite and the glyphs. Without `beforeId`, or with an id the style does not have,
 * all layers are in `below`.
 */
export function splitStyleAt(
  style: StyleDocument,
  beforeId: string | null
): {below: StyleDocument; above: StyleDocument | null} {
  const index = beforeId === null ? -1 : style.layers.findIndex(layer => layer.id === beforeId);
  if (index < 0) {
    return {below: style, above: null};
  }
  return {
    below: {...style, layers: style.layers.slice(0, index)},
    above: {...style, layers: style.layers.slice(index)}
  };
}

/**
 * Returns a copy of the style in which a feature with the state `hover` or `selected` draws in a
 * highlight color. Only the color of `fill`, `line`, `circle` and `fill-extrusion` layers reads
 * the state. Layers with a pattern keep their paint, because a pattern replaces the color.
 */
export function withFeatureStateHighlight(
  style: StyleDocument,
  colors: HighlightColors
): StyleDocument {
  return {
    ...style,
    layers: style.layers.map(layer => {
      const colorProperty = COLOR_PROPERTIES[layer.type];
      const patternProperty = PATTERN_PROPERTIES[layer.type];
      if (!colorProperty || (patternProperty && layer.paint?.[patternProperty] !== undefined)) {
        return layer;
      }
      const color = highlightColor(layer.paint?.[colorProperty] ?? DEFAULT_COLOR, colors);
      return color === null ? layer : {...layer, paint: {...layer.paint, [colorProperty]: color}};
    })
  };
}

/**
 * A color value with the highlight in front of it, or null for a value this example cannot wrap.
 * The style specification allows `["zoom"]` only as the input of a top-level `interpolate` or
 * `step`, so a zoom curve keeps its shape and each of its outputs gets the highlight.
 */
function highlightColor(value: unknown, colors: HighlightColors): unknown {
  if (isLegacyFunction(value)) {
    // A legacy zoom function becomes the equivalent expression. A property function is left.
    if (value.property !== undefined || value.type === 'interval') {
      return null;
    }
    return highlightColor(
      ['interpolate', ['exponential', value.base ?? 1], ['zoom'], ...value.stops.flat()],
      colors
    );
  }
  if (Array.isArray(value) && ZOOM_CURVES.has(value[0])) {
    const isStep = value[0] === 'step';
    const input = value[isStep ? 1 : 2];
    if (Array.isArray(input) && input[0] === 'zoom') {
      // `step` has its outputs at 2, 4, ...; `interpolate` has them at 4, 6, ....
      const firstOutput = isStep ? 2 : 4;
      return value.map((item, index) =>
        index >= firstOutput && (index - firstOutput) % 2 === 0 ? withHighlight(item, colors) : item
      );
    }
  }
  return withHighlight(value, colors);
}

function withHighlight(color: unknown, colors: HighlightColors): unknown[] {
  return [
    'case',
    ['boolean', ['feature-state', 'selected'], false],
    colors.selected,
    ['boolean', ['feature-state', 'hover'], false],
    colors.hover,
    color
  ];
}

function isLegacyFunction(
  value: unknown
): value is {stops: unknown[][]; base?: number; property?: string; type?: string} {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Array.isArray((value as {stops?: unknown}).stops)
  );
}

/** A position of a data layer in a style: the id of the style layer that draws next above it. */
export type StylePosition = {label: string; beforeId: string};

/**
 * Positions for a data layer that most styles of the OpenMapTiles schema have, from the bottom to
 * the top: below the first road layer, below the first building layer, and below the labels that
 * end the style. A style without one of them does not get that position.
 */
export function getStylePositions(style: StyleDocument): StylePosition[] {
  const {layers} = style;
  const firstOf = (sourceLayer: string) =>
    layers.findIndex(layer => layer['source-layer'] === sourceLayer);
  // The labels that end the style: the layers after the last layer that is not a symbol layer.
  let firstLabel = layers.length;
  while (firstLabel > 0 && layers[firstLabel - 1].type === 'symbol') {
    firstLabel--;
  }
  return [
    {label: 'Below roads', index: firstOf('transportation')},
    {label: 'Below buildings', index: firstOf('building')},
    {label: 'Below labels', index: firstLabel < layers.length ? firstLabel : -1}
  ]
    .filter(({index}) => index >= 0)
    .sort((a, b) => a.index - b.index)
    .map(({label, index}) => ({label, beforeId: layers[index].id}));
}
