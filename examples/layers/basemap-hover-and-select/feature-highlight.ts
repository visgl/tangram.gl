// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import type {BasemapFeatureState, BasemapPickedFeature} from '@tangram.gl/basemap-layers';

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

/** The fill colors and the outline colors of a hovered and of a selected feature. */
export type HighlightColors = {
  hover: string;
  selected: string;
  hoverOutline: string;
  selectedOutline: string;
};

/** The two feature states of this example. */
export type HighlightState = 'hover' | 'selected';

/** The paint property that holds the color of each layer type that this example highlights. */
const COLOR_PROPERTIES: Record<string, string> = {
  fill: 'fill-color',
  'fill-extrusion': 'fill-extrusion-color'
};

/** The prefix of the outline layers that this example adds to the style. */
const OUTLINE_PREFIX = 'highlight-outline-';

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

/**
 * `["case", selected, selectedValue, hover, hoverValue, otherValue]`: the paint value that reads
 * the two feature states. A selected feature that is also hovered shows as selected.
 */
export function byFeatureState<T>(selected: T, hover: T, other: unknown): unknown[] {
  return [
    'case',
    ['boolean', ['feature-state', 'selected'], false],
    selected,
    ['boolean', ['feature-state', 'hover'], false],
    hover,
    other
  ];
}

/**
 * Returns a copy of the style in which the features of the named style layers draw in a highlight
 * color when they have the state `hover` or `selected`:
 *
 * - the `fill-color` or `fill-extrusion-color` of each named layer reads the states;
 * - after the last named layer of each source layer that is a `fill`, a new `line` layer draws the
 *   outline of the highlighted features. Its `line-width` reads the states: 0 for a feature
 *   without a state.
 *
 * The other layers do not change. Throws for a named layer that the style does not have, or that is
 * not a `fill` or `fill-extrusion` layer, so that a changed style does not silently lose the
 * highlight.
 */
export function withHoverAndSelect(
  style: StyleDocument,
  layerIds: readonly string[],
  colors: HighlightColors
): StyleDocument {
  const named = new Set(layerIds);
  for (const id of named) {
    const layer = style.layers.find(candidate => candidate.id === id);
    if (!layer) {
      throw new Error(`The style has no layer "${id}"`);
    }
    if (!COLOR_PROPERTIES[layer.type]) {
      throw new Error(`The layer "${id}" is a ${layer.type} layer, not a fill or fill-extrusion layer`);
    }
  }

  // The outline of a source layer draws after the last fill layer of that source layer.
  const lastFillOfSourceLayer = new Map<string, number>();
  style.layers.forEach((layer, index) => {
    if (named.has(layer.id) && layer.type === 'fill' && layer['source-layer']) {
      lastFillOfSourceLayer.set(layer['source-layer'], index);
    }
  });

  const layers: StyleLayer[] = [];
  style.layers.forEach((layer, index) => {
    if (!named.has(layer.id)) {
      layers.push(layer);
      return;
    }
    const colorProperty = COLOR_PROPERTIES[layer.type];
    const color = withHighlight(layer.paint?.[colorProperty] ?? '#000000', colors);
    layers.push({...layer, paint: {...layer.paint, [colorProperty]: color}});

    const sourceLayer = layer['source-layer'];
    if (sourceLayer && lastFillOfSourceLayer.get(sourceLayer) === index) {
      layers.push({
        id: `${OUTLINE_PREFIX}${sourceLayer}`,
        type: 'line',
        source: layer.source,
        'source-layer': sourceLayer,
        ...(layer.minzoom === undefined ? {} : {minzoom: layer.minzoom}),
        layout: {'line-join': 'round'},
        paint: {
          'line-color': byFeatureState(colors.selectedOutline, colors.hoverOutline, 'rgba(0, 0, 0, 0)'),
          'line-width': byFeatureState(3, 2, 0)
        }
      });
    }
  });
  return {...style, layers};
}

/**
 * The ids of the style layers whose features this example highlights: the named layers and the
 * outline layers that `withHoverAndSelect` adds.
 */
export function getHighlightLayerIds(style: StyleDocument, layerIds: readonly string[]): Set<string> {
  const ids = new Set(layerIds);
  for (const layer of style.layers) {
    if (layer.id.startsWith(OUTLINE_PREFIX)) {
      ids.add(layer.id);
    }
  }
  return ids;
}

/**
 * A color value with the two states in front of it. The style specification allows `["zoom"]`
 * only as the input of a top-level `interpolate` or `step`, so a zoom curve keeps its shape and
 * each of its outputs reads the states.
 */
function withHighlight(color: unknown, colors: HighlightColors): unknown {
  if (Array.isArray(color) && (color[0] === 'interpolate' || color[0] === 'step')) {
    const isStep = color[0] === 'step';
    const input = color[isStep ? 1 : 2];
    if (Array.isArray(input) && input[0] === 'zoom') {
      // `step` has its outputs at 2, 4, ...; `interpolate` has them at 4, 6, ....
      const firstOutput = isStep ? 2 : 4;
      return color.map((item, index) =>
        index >= firstOutput && (index - firstOutput) % 2 === 0
          ? byFeatureState(colors.selected, colors.hover, item)
          : item
      );
    }
  }
  return byFeatureState(colors.selected, colors.hover, color);
}

/**
 * A key that is the same for each pick of one feature. Each pick gives a new object, and the
 * style layers `building` and `building-3d` draw the same feature, so the key leaves out the
 * style layer.
 */
export function getFeatureKey(feature: BasemapPickedFeature | null): string {
  if (!feature) {
    return '';
  }
  return `${feature.source}/${feature.sourceLayer ?? ''}/${String(feature.id)}`;
}

/** Whether two picks are of the same feature. */
export function isSameFeature(
  a: BasemapPickedFeature | null,
  b: BasemapPickedFeature | null
): boolean {
  return getFeatureKey(a) === getFeatureKey(b);
}

/**
 * The `featureState` prop of `BasemapLayer` for a hovered and a selected feature: by source, then
 * by source layer, then by feature id, as `map.setFeatureState()` of MapLibre GL JS addresses a
 * feature of a vector source. A feature without an id or without a source layer cannot have a
 * state. Returns `previous` when it already holds the same states, because `BasemapLayer`
 * compares the prop by identity.
 */
export function getFeatureState(
  hovered: BasemapPickedFeature | null,
  selected: BasemapPickedFeature | null,
  previous: BasemapFeatureState | null
): BasemapFeatureState | null {
  const states: Record<string, Record<string, Record<string, Record<string, boolean>>>> = {};
  const add = (feature: BasemapPickedFeature | null, key: HighlightState) => {
    if (!feature || feature.id === undefined || feature.sourceLayer === undefined) {
      return;
    }
    const sourceStates = (states[feature.source] ??= {});
    const layerStates = (sourceStates[feature.sourceLayer] ??= {});
    (layerStates[feature.id] ??= {})[key] = true;
  };
  add(hovered, 'hover');
  add(selected, 'selected');
  if (Object.keys(states).length === 0) {
    return null;
  }
  return JSON.stringify(states) === JSON.stringify(previous) ? previous : states;
}
