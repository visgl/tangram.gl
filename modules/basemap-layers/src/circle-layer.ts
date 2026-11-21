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
import {
  FillTranslateExtension,
  type FillTranslateExtensionProps,
  fillTranslateModuleWGSL
} from './fill-style-extensions';
import {createShaderInjectionPlugin} from './shader-injection-plugin';
import {sortFeaturesByKey} from './sort-key';
import type {FeatureStateLookup} from './feature-state';
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
 * The WGSL of `CircleBlurExtension`: the same fade as its GLSL, with the blur passed from the
 * vertex to the fragment stage by luma.gl's shader plugin interface.
 */
const circleBlurPluginWGSL: ShaderPlugin = {
  name: 'circleBlur',
  vertexInputs: {instanceCircleBlur: 'f32'},
  interStageVariables: {circleBlur_blur: {type: 'f32', interpolation: 'flat'}},
  injections: [
    {
      stage: 'vertex',
      target: 'DECKGL_FILTER_GL_POSITION',
      wgsl: /* wgsl */ `
  circleBlur_blur = instanceCircleBlur;
`
    },
    {
      stage: 'fragment',
      target: 'DECKGL_FILTER_COLOR',
      wgsl: /* wgsl */ `
  if (circleBlur_blur > 0.0) {
    (*color).a *= 1.0 - smoothstep(1.0 - circleBlur_blur, 1.0, length(geometry.uv));
  }
`
    }
  ]
};

/**
 * Adds `getBlur` to a `ScatterplotLayer`: per circle, the outer fraction of the circle (stroke
 * included) that fades out, as MapLibre GL JS draws `circle-blur`, on WebGL and WebGPU.
 */
export class CircleBlurExtension extends LayerExtension {
  static extensionName = 'CircleBlurExtension';
  static defaultProps = {getBlur: {type: 'accessor', value: 0}};

  initializeState(this: Layer) {
    this.getAttributeManager()?.addInstanced({
      instanceCircleBlur: {size: 1, accessor: 'getBlur', defaultValue: 0}
    });
  }

  getShaders(this: Layer) {
    if (this.context.device.type === 'webgpu') {
      return {plugins: [circleBlurPluginWGSL]};
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

/** Translates the billboard center while preserving ScatterplotLayer's clip-space corner offset. */
const circleTranslatePluginWGSL: ShaderPlugin = {
  name: 'circleTranslate',
  module: {
    name: 'circleTranslate',
    dependencies: [fillTranslateModuleWGSL],
    source: /* wgsl */ `
var<private> circleTranslate_center: vec4<f32>;
`
  },
  injections: [
    {
      stage: 'vertex',
      target: 'DECKGL_FILTER_SIZE',
      wgsl: /* wgsl */ `
  // Scatterplot's billboard geometry still holds the center at this hook.
  circleTranslate_center = geometry.position;
`
    },
    {
      stage: 'vertex',
      target: 'DECKGL_FILTER_GL_POSITION',
      order: -1,
      wgsl: /* wgsl */ `
  if (any(fillTranslate.offset != vec2<f32>(0.0))) {
    if (scatterplot.billboard == 0) {
      *position = project_common_position_to_clipspace(fillTranslate_getPosition(geometry.position));
    } else if (!project_globe_is_occluded(circleTranslate_center.xyz)) {
      let center = circleTranslate_center;
      let centerClip = project_globe_billboard_clipspace(
        project_common_position_to_clipspace(center), center.xyz
      );
      let corner = *position - centerClip;
      let moved = fillTranslate_getPosition(center);
      *position = project_globe_billboard_clipspace(
        project_common_position_to_clipspace(moved), moved.xyz
      ) + corner;
    }
  }
`
    }
  ]
};

/**
 * `circle-translate` and `circle-translate-anchor` for a `ScatterplotLayer`: the offset of
 * `FillTranslateExtension`, which moves a circle's center on the ground, turned with the map or
 * with the viewport, as MapLibre GL JS moves it in tile units, on WebGL and WebGPU.
 */
export class CircleTranslateExtension extends FillTranslateExtension {
  static extensionName = 'CircleTranslateExtension';

  getShaders(this: Layer) {
    if (this.context.device.type === 'webgpu') {
      return {plugins: [circleTranslatePluginWGSL]};
    }
    const {plugins} = FillTranslateExtension.prototype.getShaders.call(this);
    return {plugins: [...plugins, circleTranslateGlobeModule]};
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
  featureState,
  globe,
  translate = null,
  parameters
}: {
  baseProps: any;
  id: string;
  styleLayer: BasemapStyleLayer;
  features: any[];
  zoom: number;
  /** The feature states the style layer's paint reads, if it reads any. */
  featureState?: FeatureStateLookup;
  /**
   * On a globe, circles always face the viewer: `circle-pitch-alignment: map` is not verified
   * there.
   */
  globe: boolean;
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
      Math.max(0, Number(width ?? DEFAULT_STROKE_WIDTH)) / 2,
    featureState
  );
  const lineWidth = getStyleAccessor(
    styleLayer,
    ['circle-stroke-width'],
    zoom,
    ([width]) => Math.max(0, Number(width ?? DEFAULT_STROKE_WIDTH)),
    featureState
  );
  const fillColor = getStyleAccessor(
    styleLayer,
    ['circle-color', 'circle-opacity'],
    zoom,
    ([color, opacity]) => withOpacity(color ?? DEFAULT_COLOR, opacity ?? DEFAULT_OPACITY),
    featureState
  );
  const lineColor = getStyleAccessor(
    styleLayer,
    ['circle-stroke-color', 'circle-stroke-opacity'],
    zoom,
    ([color, opacity]) =>
      withOpacity(color ?? DEFAULT_STROKE_COLOR, opacity ?? DEFAULT_STROKE_OPACITY),
    featureState
  );
  const blur = getStyleAccessor(
    styleLayer,
    ['circle-blur'],
    zoom,
    ([value]) => Math.min(1, Math.max(0, Number(value ?? DEFAULT_BLUR) || 0)),
    featureState
  );
  const alignment = getStyleAccessor(styleLayer, ['circle-pitch-alignment'], zoom, ([v]) => v);
  const billboard = globe || alignment.value !== 'map';

  const hasBlur = styleLayer.paint?.['circle-blur'] !== undefined;

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
      ...(translate ? [CIRCLE_TRANSLATE_EXTENSION] : [])
    ],
    ...(hasBlur ? {getBlur: blur.value} : {}),
    ...translate,
    billboard,
    stroked: styleLayer.paint?.['circle-stroke-width'] !== undefined && lineWidth.value !== 0,
    updateTriggers: {
      getRadius: radius.updateTrigger,
      getLineWidth: lineWidth.updateTrigger,
      getFillColor: fillColor.updateTrigger,
      getLineColor: lineColor.updateTrigger,
      getBlur: hasBlur ? blur.updateTrigger : undefined
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
