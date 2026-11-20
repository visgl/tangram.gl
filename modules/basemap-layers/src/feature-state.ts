// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {getCompiledStyleProperty, type StyleFeature} from './style-expression';
import type {BasemapSource, ResolvedBasemapStyleLayer} from './style-resolver';

/** The state of one feature, which `["feature-state", key]` reads. */
export type FeatureState = Readonly<Record<string, unknown>>;

/** The states of features, by feature id. */
export type FeatureStates = Readonly<Record<string, FeatureState>>;

/**
 * The states of a style's features, by source id. A `vector` source's states are by source layer
 * and then by feature id; a `geojson` source's are by feature id, as MapLibre GL JS's
 * `setFeatureState` addresses them. Pass a new object to change a state: objects are compared by
 * identity.
 */
export type BasemapFeatureState = Readonly<
  Record<string, FeatureStates | Readonly<Record<string, FeatureStates>>>
>;

/** The state of a feature of one style layer, for its paint accessors. */
export type FeatureStateLookup = {
  /** The feature's state, or undefined for a feature without one. */
  get: (feature: StyleFeature) => FeatureState | undefined;
  /** Changes when the states of the style layer's features change. */
  token: number;
};

/**
 * The id a feature's state is kept under, as MapLibre GL JS reads it: the `promoteId` property of a
 * vector source (none for a source layer that an object `promoteId` does not name), or the
 * feature's id. A GeoJSON source's `promoteId` is already the id of its tile features.
 */
export function getFeatureStateId(
  feature: StyleFeature,
  source: BasemapSource | undefined,
  sourceLayer: string | undefined
): string | number | undefined {
  const promoteId = source?.type === 'vector' ? source.promoteId : undefined;
  let id: unknown = feature.id;
  if (promoteId !== undefined && promoteId !== null) {
    const property =
      typeof promoteId === 'string'
        ? promoteId
        : sourceLayer && typeof promoteId === 'object'
          ? (promoteId as Record<string, unknown>)[sourceLayer]
          : undefined;
    id = typeof property === 'string' ? feature.properties?.[property] : undefined;
  }
  if (typeof id === 'boolean') {
    id = Number(id);
  }
  return typeof id === 'string' || typeof id === 'number' ? id : undefined;
}

/** The states of the features of a style layer's source and source layer. */
export function getStyleLayerFeatureStates(
  featureState: BasemapFeatureState | null | undefined,
  sourceId: string,
  source: BasemapSource | undefined,
  styleLayer: ResolvedBasemapStyleLayer
): FeatureStates | undefined {
  const sourceStates = featureState?.[sourceId];
  if (!sourceStates) {
    return undefined;
  }
  if (source?.type === 'vector') {
    const sourceLayer = styleLayer['source-layer'];
    return typeof sourceLayer === 'string'
      ? (sourceStates as Readonly<Record<string, FeatureStates>>)[sourceLayer]
      : undefined;
  }
  return sourceStates as FeatureStates;
}

/** Whether a style layer's paint reads `["feature-state", ...]`. */
export function isStyleLayerStateDependent(styleLayer: ResolvedBasemapStyleLayer): boolean {
  return Object.keys(styleLayer.paint || {}).some(
    name => getCompiledStyleProperty(styleLayer, name)?.isStateDependent
  );
}

const stateTokens = new WeakMap<object, number>();
let nextStateToken = 1;

/** A number per states object, 0 for none: a new object, a new number. */
export function getFeatureStatesToken(states: FeatureStates | undefined): number {
  if (!states) {
    return 0;
  }
  let token = stateTokens.get(states);
  if (token === undefined) {
    token = nextStateToken++;
    stateTokens.set(states, token);
  }
  return token;
}

/**
 * The feature states of a style layer whose paint reads them, or undefined for a style layer whose
 * paint does not: its accessors and update triggers then stay as they are.
 */
export function getFeatureStateLookup(
  featureState: BasemapFeatureState | null | undefined,
  sourceId: string,
  source: BasemapSource | undefined,
  styleLayer: ResolvedBasemapStyleLayer
): FeatureStateLookup | undefined {
  if (!isStyleLayerStateDependent(styleLayer)) {
    return undefined;
  }
  const states = getStyleLayerFeatureStates(featureState, sourceId, source, styleLayer);
  const sourceLayer = styleLayer['source-layer'];
  return {
    get: feature => {
      if (!states) {
        return undefined;
      }
      const id = getFeatureStateId(feature, source, sourceLayer);
      return id === undefined ? undefined : states[id];
    },
    token: getFeatureStatesToken(states)
  };
}

/**
 * A picked feature of a vector or GeoJSON source, named as MapLibre GL JS's `queryRenderedFeatures`
 * names it. `BasemapLayer` adds it to deck.gl's picking info as `basemapFeature`.
 */
export type BasemapPickedFeature = {
  /** The feature's id (a vector source's `promoteId` property), or undefined without one. */
  id: string | number | undefined;
  /** The id of the feature's source in the style. */
  source: string;
  /** The feature's source layer, for a vector source. */
  sourceLayer: string | undefined;
  /** The id of the style layer that drew the feature. */
  styleLayerId: string;
  /** The feature's properties. */
  properties: Record<string, unknown>;
};

/** The picked feature of a style layer, for a feature of `source`. */
export function getPickedFeature(
  feature: StyleFeature,
  sourceId: string,
  source: BasemapSource | undefined,
  styleLayerId: string
): BasemapPickedFeature {
  const {layerName, ...vectorProperties} = feature.properties || {};
  // Vector tile features carry their source layer as `layerName` (see `getSourceLayerFeatures`).
  const isVector = source?.type === 'vector';
  const sourceLayer = isVector && typeof layerName === 'string' ? layerName : undefined;
  return {
    id: getFeatureStateId(feature, source, sourceLayer),
    source: sourceId,
    sourceLayer,
    styleLayerId,
    properties: isVector ? vectorProperties : feature.properties || {}
  };
}
