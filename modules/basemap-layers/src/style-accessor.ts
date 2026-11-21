// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import type {FeatureStateLookup} from './feature-state';
import {type CompiledStyleProperty, getCompiledStyleProperty, type StyleFeature} from './style-expression';

type StyleLayerLike = {
  paint?: Record<string, unknown>;
  layout?: Record<string, unknown>;
};

/**
 * Zoom step at which style values are evaluated. Layout, stepped paint and the endpoints of
 * composite paint attributes step every `STYLE_ZOOM_STEP` zoom levels.
 */
export const STYLE_ZOOM_STEP = 0.25;

/**
 * Zoom at which stepped paint and layout values are evaluated: the zoom rounded down to a
 * `STYLE_ZOOM_STEP`.
 *
 * On WebGL, supported zoom-only paint is evaluated at the viewport zoom, and composite paint
 * blends attributes evaluated at the enclosing style zoom steps on the GPU. Stepping keeps every
 * tile on the same evaluation zoom, so neighbouring tiles agree at their seams.
 */
export function getZoomBucket(zoom: number): number {
  return Math.floor(zoom / STYLE_ZOOM_STEP) * STYLE_ZOOM_STEP;
}

/** Zoom at which filters are evaluated: the integer zoom, as the style spec specifies. */
export function getFilterZoom(zoom: number): number {
  return Math.floor(zoom);
}

/**
 * A key that changes whenever style evaluation or layer visibility changes: at every
 * `STYLE_ZOOM_STEP` (which includes every integer zoom, where filters change), and at every
 * fractional `minzoom`/`maxzoom` in `zoomLimits`. Layer visibility uses the exact zoom, as in
 * MapLibre, so crossing a fractional limit must regenerate sublayers too.
 */
export function getStyleZoomKey(zoom: number, zoomLimits: readonly (number | undefined)[]): string {
  const crossed = zoomLimits.filter(
    limit => limit !== undefined && !Number.isInteger(limit) && zoom >= limit
  ).length;
  return `${getZoomBucket(zoom)}:${crossed}`;
}

/** The style inputs and conversion for one paint value. */
export type PaintProperty<T> = {
  /** The style properties passed to the conversion in order. */
  names: string[];
  /** Combines the evaluated style properties into a width or color. */
  combine: (values: any[]) => T;
};

/** A paint property that supplies a layer-wide value or the curve for blending feature values. */
type ZoomPaintProperty<T> = {
  /** Evaluates the layer-wide value, or returns undefined for per-feature paint. */
  evaluate: (zoom: number) => T | undefined;
  /** Whether any of the inputs reads zoom. */
  isZoomDependent: boolean;
  /** Whether any of the inputs reads the feature or its state. */
  isFeatureDependent: boolean;
  /** The curve used to blend the lower and upper per-feature samples. */
  interpolation: CompiledStyleProperty['zoomInterpolation'];
};

/**
 * Compiles the properties that supply a layer-wide value or a composite blend factor.
 * When the inputs use different zoom curves, the composite values blend linearly between
 * their sampled zooms.
 */
export function compileZoomPaintProperty<T>(
  styleLayer: StyleLayerLike,
  definition: PaintProperty<T>
): ZoomPaintProperty<T> {
  const properties = definition.names.map(name => getCompiledStyleProperty(styleLayer, name));
  const zoomProperties = properties.filter(property => property?.isZoomDependent);
  const perFeature = properties.some(property => property?.isFeatureDependent);
  const curve = zoomProperties[0]?.zoomInterpolation ?? null;
  const curveKey = JSON.stringify(curve);
  const matchesCurve = zoomProperties.every(property => JSON.stringify(property?.zoomInterpolation) === curveKey);
  const constants = perFeature
    ? []
    : properties.map(property => property?.isZoomDependent ? undefined : property?.evaluate(0));
  const constant = !perFeature && !zoomProperties.length ? definition.combine(constants) : undefined;
  const evaluate = perFeature
    ? () => undefined
    : zoomProperties.length
      ? (zoom: number) =>
          definition.combine(
            properties.map((property, index) =>
              property?.isZoomDependent ? property.evaluate(zoom) : constants[index]
            )
          )
      : () => constant;
  return {
    evaluate,
    isZoomDependent: zoomProperties.length > 0,
    isFeatureDependent: perFeature,
    interpolation: perFeature ? (matchesCurve ? curve : {name: 'linear'}) : null
  };
}

/** A deck.gl accessor built from one or more style properties. */
export type StyleAccessor<T> = {
  /** A constant when no property depends on feature data, otherwise a per-feature function. */
  value: T | ((feature: StyleFeature) => T);
  /**
   * Set to the evaluation zoom (`getZoomBucket`) when a per-feature value also depends on zoom.
   * A value that reads feature state takes a string instead, which also changes with the states.
   */
  updateTrigger?: number | string;
};

/**
 * Builds a deck.gl accessor from style properties, evaluated at the stepped zoom
 * (`getZoomBucket`). Feature-independent values become constants. Data-driven values become
 * per-feature functions, with an update trigger when they also depend on zoom. With
 * `featureState`, `["feature-state", ...]` reads each feature's state from it, and the update
 * trigger of a value that reads it changes with the states: only that attribute is computed
 * again, and the geometry is kept.
 *
 * With `exactZoom`, the accessor evaluates the properties at the supplied zoom.
 */
export function getStyleAccessor<T>(
  styleLayer: StyleLayerLike,
  propertyNames: string[],
  zoom: number,
  combine: (values: any[]) => T,
  featureState?: FeatureStateLookup,
  {exactZoom = false}: {exactZoom?: boolean} = {}
): StyleAccessor<T> {
  const properties = propertyNames.map(name => getCompiledStyleProperty(styleLayer, name));
  const isFeatureDependent = properties.some(property => property?.isFeatureDependent);
  const zoomBucket = exactZoom ? zoom : getZoomBucket(zoom);

  if (!isFeatureDependent) {
    return {value: combine(properties.map(property => property?.evaluate(zoomBucket)))};
  }

  const isZoomDependent = properties.some(property => property?.isZoomDependent);
  const state = properties.some(property => property?.isStateDependent) ? featureState : undefined;
  if (state) {
    return {
      value: (feature: StyleFeature) => {
        const featureValues = state.get(feature);
        return combine(
          properties.map(property =>
            property?.evaluate(zoomBucket, feature, undefined, featureValues)
          )
        );
      },
      updateTrigger: `${isZoomDependent ? zoomBucket : ''}:state-${state.token}`
    };
  }
  return {
    value: (feature: StyleFeature) =>
      combine(properties.map(property => property?.evaluate(zoomBucket, feature))),
    updateTrigger: isZoomDependent ? zoomBucket : undefined
  };
}

/** Converts a style color (alpha 0-1 or 0-255) and opacity into a deck.gl RGBA color. */
export function withOpacity(
  color: number[] | null | undefined,
  opacity = 1
): [number, number, number, number] {
  if (!color) {
    return [0, 0, 0, 0];
  }

  const alpha = color.length > 3 ? (color[3] <= 1 ? color[3] * 255 : color[3]) : 255;
  return [color[0], color[1], color[2], Math.round(alpha * opacity)];
}
