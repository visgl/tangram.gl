// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

// deck.gl-community
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {LayerExtension, project} from '@deck.gl/core';
import type {Layer} from '@deck.gl/core';
import {ScatterplotLayer} from '@deck.gl/layers';
import type {ShaderPlugin} from '@luma.gl/shaders';
import {FillTranslateExtension, type FillTranslateExtensionProps} from './fill-style-extensions';
import {createShaderInjectionPlugin} from './shader-injection-plugin';
import {sortFeaturesByKey} from './sort-key';
import {getStyleAccessor, withOpacity} from './style-accessor';
import {getStylePropertyDefault} from './style-expression';
import type {ResolvedBasemapStyleLayer as BasemapStyleLayer} from './style-resolver';

const DEFAULT_RADIUS = getStylePropertyDefault('circle-radius') as number;
const DEFAULT_COLOR = getStylePropertyDefault('circle-color') as number[];
const DEFAULT_OPACITY = getStylePropertyDefault('circle-opacity') as number;
const DEFAULT_STROKE_WIDTH = getStylePropertyDefault('circle-stroke-width') as number;
const DEFAULT_STROKE_COLOR = getStylePropertyDefault('circle-stroke-color') as number[];
const DEFAULT_STROKE_OPACITY = getStylePropertyDefault('circle-stroke-opacity') as number;
const DEFAULT_BLUR = getStylePropertyDefault('circle-blur') as number;

/**
 * Adds `getBlur` to a `ScatterplotLayer`: per circle, the outer fraction of the circle (stroke
 * included) that fades out, as MapLibre GL JS draws `circle-blur`. WebGL only; on WebGPU circles
 * draw without blur.
 */
export class CircleBlurExtension extends LayerExtension {
  static extensionName = 'CircleBlurExtension';
  static defaultProps = {getBlur: {type: 'accessor', value: 0}};

  initializeState(this: Layer) {
    if (this.context.device.type === 'webgpu') {
      return;
    }
    this.getAttributeManager()?.addInstanced({
      instanceCircleBlur: {size: 1, accessor: 'getBlur', defaultValue: 0}
    });
  }

  getShaders(this: Layer) {
    if (this.context.device.type === 'webgpu') {
      return {};
    }
    // deck.gl appends these to the layer's and other extensions' code for the same hooks.
    return {
      inject: {
        'vs:#decl': 'in float instanceCircleBlur;\nout float circleBlur_blur;',
        'vs:#main-end': 'circleBlur_blur = instanceCircleBlur;',
        'fs:#decl': 'in float circleBlur_blur;',
        'fs:DECKGL_FILTER_COLOR': `
  if (circleBlur_blur > 0.0) {
    color.a *= 1.0 - smoothstep(1.0 - circleBlur_blur, 1.0, length(geometry.uv));
  }
`
      }
    };
  }
}

/** Shared by every blurred circle sublayer, so deck.gl does not see their extensions change. */
const CIRCLE_BLUR_EXTENSION = new CircleBlurExtension();

/**
 * Moves a billboard circle that `FillTranslateExtension` has moved toward the camera on a globe,
 * as `ScatterplotLayer` does before the extension runs (see deck.gl's
 * `project_globe_billboard_clipspace`), so that the curve of the globe does not clip it.
 */
const circleTranslateGlobeModule = createShaderInjectionPlugin({
  name: 'circleTranslateGlobe',
  dependencies: [project],
  inject: {
    'vs:DECKGL_FILTER_GL_POSITION': /* glsl */ `
  if (fillTranslate.offset != vec2(0.0) && scatterplot.billboard) {
    position = project_globe_billboard_clipspace(position, geometry.position.xyz);
  }
`
  }
});

/**
 * `circle-translate` and `circle-translate-anchor` for a `ScatterplotLayer`: the offset of
 * `FillTranslateExtension`, which moves a circle's center on the ground, turned with the map or
 * with the viewport, as MapLibre GL JS moves it in tile units. WebGL only.
 */
export class CircleTranslateExtension extends FillTranslateExtension {
  static extensionName = 'CircleTranslateExtension';

  getShaders(this: Layer) {
    const {plugins} = FillTranslateExtension.prototype.getShaders.call(this) as {
      plugins?: ShaderPlugin[];
    };
    return plugins ? {plugins: [...plugins, circleTranslateGlobeModule]} : {};
  }
}

const CIRCLE_TRANSLATE_EXTENSION = new CircleTranslateExtension();

const pointFeatureCache = new WeakMap<any[], any[]>();

function getPointFeatures(features: any[]): any[] {
  const cached = pointFeatureCache.get(features);
  if (cached) {
    return cached;
  }
  const points = features.every(feature => feature.geometry?.type === 'Point')
    ? features
    : features.flatMap(feature => {
        if (feature.geometry?.type === 'Point') {
          return [feature];
        }
        if (feature.geometry?.type === 'MultiPoint') {
          return feature.geometry.coordinates.map((position: number[]) => ({...feature, position}));
        }
        return [];
      });
  pointFeatureCache.set(features, points);
  return points;
}

/**
 * Draws a `circle` style layer's points (and each point of a multipoint) with MapLibre's circle
 * paint: the stroke is drawn outside `circle-radius`. Under pitch, circles shrink with distance,
 * as with the default `circle-pitch-scale` of `map`; `viewport` is not applied.
 * `circle-translate` moves the circles on the ground, as in MapLibre, turned with the map, or with
 * the viewport for a `circle-translate-anchor` of `viewport`.
 */
export function createCircleSubLayer({
  baseProps,
  id,
  styleLayer,
  features,
  zoom,
  globe,
  webgpu = false,
  translate = null,
  parameters
}: {
  baseProps: any;
  id: string;
  styleLayer: BasemapStyleLayer;
  features: any[];
  zoom: number;
  /**
   * On a globe, circles always face the viewer: `circle-pitch-alignment: map` is not verified
   * there.
   */
  globe: boolean;
  /** Whether the circles draw on WebGPU, where `circle-translate-anchor` is not applied. */
  webgpu?: boolean;
  /** `circle-translate` and its anchor, when the layer sets them, as `FillTranslateExtension` takes them. */
  translate?: FillTranslateExtensionProps | null;
  parameters: any;
}) {
  const points = getPointFeatures(features);
  if (points.length === 0) {
    return null;
  }
  const radius = getStyleAccessor(
    styleLayer,
    ['circle-radius', 'circle-stroke-width'],
    zoom,
    ([value, width]) =>
      Math.max(0, Number(value ?? DEFAULT_RADIUS)) +
      Math.max(0, Number(width ?? DEFAULT_STROKE_WIDTH)) / 2
  );
  const lineWidth = getStyleAccessor(styleLayer, ['circle-stroke-width'], zoom, ([width]) =>
    Math.max(0, Number(width ?? DEFAULT_STROKE_WIDTH))
  );
  const fillColor = getStyleAccessor(
    styleLayer,
    ['circle-color', 'circle-opacity'],
    zoom,
    ([color, opacity]) => withOpacity(color ?? DEFAULT_COLOR, opacity ?? DEFAULT_OPACITY)
  );
  const lineColor = getStyleAccessor(
    styleLayer,
    ['circle-stroke-color', 'circle-stroke-opacity'],
    zoom,
    ([color, opacity]) =>
      withOpacity(color ?? DEFAULT_STROKE_COLOR, opacity ?? DEFAULT_STROKE_OPACITY)
  );
  const blur = getStyleAccessor(styleLayer, ['circle-blur'], zoom, ([value]) =>
    Math.min(1, Math.max(0, Number(value ?? DEFAULT_BLUR) || 0))
  );
  const alignment = getStyleAccessor(styleLayer, ['circle-pitch-alignment'], zoom, ([v]) => v);
  const billboard = globe || alignment.value !== 'map';

  const hasBlur = styleLayer.paint?.['circle-blur'] !== undefined;
  // On WebGL, `circle-translate` moves the circles on the ground, turned with the map or with the
  // viewport by `circle-translate-anchor`, as in MapLibre (see `CircleTranslateExtension`). On
  // WebGPU, where its GLSL does not run, the offset is deck.gl's pixel offset: on the screen for
  // circles that face the viewer, on the map for those that lie on it, whatever the anchor.
  const translatesOnGround = Boolean(translate) && !webgpu;
  const pixelOffset = getStyleAccessor<[number, number]>(
    styleLayer,
    ['circle-translate'],
    zoom,
    ([value]) => {
      const [x, y] = webgpu ? (value ?? [0, 0]) : [0, 0];
      // Scatterplot adds offsets in clip space (billboard) or common space (map), both y-up.
      return [x, y === 0 ? 0 : -y];
    }
  );

  return new ScatterplotLayer({
    ...baseProps,
    id,
    data: sortFeaturesByKey(points, styleLayer, 'circle-sort-key', zoom),
    getPosition: d => d.position ?? d.geometry.coordinates,
    getRadius: radius.value,
    getLineWidth: lineWidth.value,
    getFillColor: fillColor.value,
    getLineColor: lineColor.value,
    extensions: [
      ...(baseProps.extensions || []),
      ...(hasBlur ? [CIRCLE_BLUR_EXTENSION] : []),
      ...(translatesOnGround ? [CIRCLE_TRANSLATE_EXTENSION] : [])
    ],
    ...(hasBlur ? {getBlur: blur.value} : {}),
    ...(translatesOnGround ? translate : {}),
    getPixelOffset: pixelOffset.value,
    billboard,
    stroked: styleLayer.paint?.['circle-stroke-width'] !== undefined && lineWidth.value !== 0,
    updateTriggers: {
      getRadius: radius.updateTrigger,
      getLineWidth: lineWidth.updateTrigger,
      getFillColor: fillColor.updateTrigger,
      getLineColor: lineColor.updateTrigger,
      getBlur: hasBlur ? blur.updateTrigger : undefined,
      getPixelOffset: pixelOffset.updateTrigger
    },
    radiusUnits: 'pixels',
    lineWidthUnits: 'pixels',
    radiusMinPixels: 0,
    lineWidthMinPixels: 0,
    filled: true,
    antialiasing: true,
    parameters
  });
}
