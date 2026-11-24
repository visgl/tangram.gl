// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

// deck.gl-community
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {LayerExtension, project} from '@deck.gl/core';
import type {Accessor, DefaultProps, Layer, UpdateParameters} from '@deck.gl/core';
import {ScatterplotLayer, type ScatterplotLayerProps} from '@deck.gl/layers';
import type {ShaderPlugin} from '@luma.gl/shaders';
import {
  FillTranslateExtension,
  type FillTranslateExtensionProps,
  fillTranslateModuleWGSL
} from './fill-style-extensions';
import {createShaderInjectionPlugin} from './shader-injection-plugin';
import {sortFeaturesByKey} from './sort-key';
import type {FeatureStateLookup} from './feature-state';
import {getStyleZoom} from './projected-viewport';
import {
  type PaintProperty,
  STYLE_ZOOM_STEP,
  compileZoomPaintProperty,
  getStyleAccessor,
  getZoomBucket,
  getZoomPaintZoom,
  withOpacity
} from './style-accessor';
import {getStylePropertyDefault, getZoomInterpolationFactor} from './style-expression';
import type {ResolvedBasemapStyleLayer as BasemapStyleLayer} from './style-resolver';

const DEFAULT_RADIUS = getStylePropertyDefault('circle-radius') as number;
const DEFAULT_COLOR = getStylePropertyDefault('circle-color') as number[];
const DEFAULT_OPACITY = getStylePropertyDefault('circle-opacity') as number;
const DEFAULT_STROKE_WIDTH = getStylePropertyDefault('circle-stroke-width') as number;
const DEFAULT_STROKE_COLOR = getStylePropertyDefault('circle-stroke-color') as number[];
const DEFAULT_STROKE_OPACITY = getStylePropertyDefault('circle-stroke-opacity') as number;
const DEFAULT_BLUR = getStylePropertyDefault('circle-blur') as number;

/** The inner radius of the circle, in pixels. */
const CIRCLE_RADIUS: PaintProperty<number> = {
  names: ['circle-radius'],
  combine: ([radius]) => Math.max(0, Number(radius ?? DEFAULT_RADIUS))
};

/** The width of the stroke drawn outside the circle. */
const CIRCLE_STROKE_WIDTH: PaintProperty<number> = {
  names: ['circle-stroke-width'],
  combine: ([width]) => Math.max(0, Number(width ?? DEFAULT_STROKE_WIDTH))
};

/** The fill color with its opacity applied. */
const CIRCLE_FILL_COLOR: PaintProperty<number[]> = {
  names: ['circle-color', 'circle-opacity'],
  combine: ([color, opacity]) => withOpacity(color ?? DEFAULT_COLOR, opacity ?? DEFAULT_OPACITY)
};

/** The stroke color with its opacity applied. */
const CIRCLE_STROKE_COLOR: PaintProperty<number[]> = {
  names: ['circle-stroke-color', 'circle-stroke-opacity'],
  combine: ([color, opacity]) =>
    withOpacity(color ?? DEFAULT_STROKE_COLOR, opacity ?? DEFAULT_STROKE_OPACITY)
};

/** Explicit paint accessors and column data bypass the style's circle paint attributes. */
const CIRCLE_PAINT_OVERRIDES = [
  'getRadius', 'getLineWidth', 'getFillColor', 'getLineColor', 'getColor',
  'positions', 'radii', 'lineWidths', 'fillColors', 'lineColors'
];

/** Uniforms of the circle paint at the viewport zoom. */
type CircleZoomPaint = {
  /** Inner radius and stroke width, each negative when it comes from an attribute. */
  size: number[];
  /** RGBA fill, with a negative alpha when it comes from an attribute. */
  fillColor: number[];
  /** RGBA stroke, with a negative alpha when it comes from an attribute. */
  lineColor: number[];
  /** Blend factors for the radius, stroke width, fill and stroke color, in that order. */
  blend: number[];
};

/** Circle paint supplied to the WebGL shader. */
type CircleZoomPaintProps = {
  /** The uniform values at the current zoom, or null for ordinary stepped attributes. */
  circleZoomPaint?: ((zoom: number) => CircleZoomPaint) | null;
  /** Inner radius and stroke width at the next style zoom step. */
  getNextCircleSize?: Accessor<any, [number, number]>;
  /** Fill RGBA at the next style zoom step. */
  getNextCircleFillColor?: Accessor<any, number[]>;
  /** Stroke RGBA at the next style zoom step. */
  getNextCircleLineColor?: Accessor<any, number[]>;
};

/**
 * Substitutes paint before the vertex shader clamps its radius and stroke width and computes
 * the padded quad and the stroke's inner edge. The size hook receives the vertex offset after
 * those calculations, including any pixel offset.
 */
const circleZoomPaintPlugin = createShaderInjectionPlugin({
  name: 'circleZoomPaint',
  vs: /* glsl */ `
layout(std140) uniform circleZoomPaintUniforms {
  vec2 size;
  vec4 fillColor;
  vec4 lineColor;
  vec4 blend;
} circleZoomPaint;
`,
  uniformTypes: {
    size: 'vec2<f32>',
    fillColor: 'vec4<f32>',
    lineColor: 'vec4<f32>',
    blend: 'vec4<f32>'
  },
  inject: {
    'vs:#decl': /* glsl */ `
in vec2 instanceNextCircleSize;
in vec4 instanceNextCircleFillColors;
in vec4 instanceNextCircleLineColors;

vec4 circleZoomPaint_color(vec4 currentColor, vec4 nextColor, vec4 uniformColor, float blend) {
  return uniformColor.a < 0.0 ? mix(currentColor, nextColor, blend) : uniformColor;
}
`,
    'vs:#main-start': /* glsl */ `
  // Locals shadow the input attributes for the rest of main. The size is in pixels.
  vec2 circleZoomPaint_size = mix(
    vec2(instanceRadius, instanceLineWidths), instanceNextCircleSize, circleZoomPaint.blend.xy
  );
  vec4 circleZoomPaint_fill = circleZoomPaint_color(
    instanceFillColors, instanceNextCircleFillColors, circleZoomPaint.fillColor, circleZoomPaint.blend.z
  );
  vec4 circleZoomPaint_line = circleZoomPaint_color(
    instanceLineColors, instanceNextCircleLineColors, circleZoomPaint.lineColor, circleZoomPaint.blend.w
  );
  vec2 resolvedSize = mix(circleZoomPaint_size, circleZoomPaint.size, greaterThanEqual(circleZoomPaint.size, vec2(0.0)));
  float instanceLineWidths = resolvedSize.y;
  float instanceRadius = resolvedSize.x + instanceLineWidths / 2.0;
  vec4 instanceFillColors = circleZoomPaint_fill;
  vec4 instanceLineColors = circleZoomPaint_line;
`,
    'vs:#main-end': /* glsl */ `
  if (outerRadiusPixels <= 0.0) {
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
  } else if (instanceLineWidths == 0.0 && scatterplot.lineWidthMinPixels == 0.0) {
    // A zoom-dependent stroke can have width zero while the layer is still marked stroked.
    // Move its inner edge beyond the antialiasing padding so only the fill draws.
    innerUnitRadius = 1.0 + 2.0 * SMOOTH_EDGE_RADIUS / outerRadiusPixels;
  }
`
  }
});

/** The upper zoom endpoints read by the circle paint shader. */
const CIRCLE_ZOOM_ATTRIBUTES = {
  instanceNextCircleSize: {size: 2, accessor: 'getNextCircleSize'},
  instanceNextCircleFillColors: {size: 4, type: 'unorm8', accessor: 'getNextCircleFillColor'},
  instanceNextCircleLineColors: {size: 4, type: 'unorm8', accessor: 'getNextCircleLineColor'}
} as const;

/** Draws the installed scatterplot shader with continuous paint when the style needs it. */
class ZoomPaintScatterplotLayer extends ScatterplotLayer<any, CircleZoomPaintProps> {
  static layerName = 'ZoomPaintScatterplotLayer';
  static defaultProps: DefaultProps<ScatterplotLayerProps & CircleZoomPaintProps> = {
    ...ScatterplotLayer.defaultProps,
    circleZoomPaint: {type: 'function', value: null, optional: true, ignore: false},
    getNextCircleSize: {type: 'accessor', value: [0, 0]},
    getNextCircleFillColor: {type: 'accessor', value: [0, 0, 0, 0]},
    getNextCircleLineColor: {type: 'accessor', value: [0, 0, 0, 0]}
  };

  /** Adds the paint plugin alongside all of the inherited extension shaders. */
  getShaders() {
    const shaders = super.getShaders();
    if (this.props.circleZoomPaint && this.context.device.type !== 'webgpu') {
      shaders.plugins = [...(shaders.plugins || []), circleZoomPaintPlugin];
    }
    return shaders;
  }

  /** Updates the attribute layout before a style edit switches the model's shader. */
  updateState(params: UpdateParameters<this>): void {
    const enabled = Boolean(params.props.circleZoomPaint) && this.context.device.type !== 'webgpu';
    const manager = this.getAttributeManager();
    const hadAttributes = Boolean(manager?.getAttributes().instanceNextCircleSize);
    if (enabled !== hadAttributes) {
      if (enabled) {
        manager?.addInstanced(CIRCLE_ZOOM_ATTRIBUTES);
      } else {
        manager?.remove(Object.keys(CIRCLE_ZOOM_ATTRIBUTES));
      }
      params = {...params, changeFlags: {...params.changeFlags, extensionsChanged: true}};
    }
    super.updateState(params);
  }

  /** Evaluates layer-wide paint and composite factors for the viewport being drawn. */
  draw(options: Parameters<ScatterplotLayer['draw']>[0]): void {
    if (this.props.circleZoomPaint && this.context.device.type !== 'webgpu') {
      this.setShaderModuleProps({
        circleZoomPaint: this.props.circleZoomPaint(getStyleZoom(this.context.viewport))
      });
    }
    super.draw(options);
  }
}

/** Compiles the draw-time values and upper endpoint accessors of one circle style layer. */
function getCircleZoomPaint(
  styleLayer: BasemapStyleLayer,
  zoom: number,
  featureState?: FeatureStateLookup
) {
  const radius = compileZoomPaintProperty(styleLayer, CIRCLE_RADIUS);
  const width = compileZoomPaintProperty(styleLayer, CIRCLE_STROKE_WIDTH);
  const fill = compileZoomPaintProperty(styleLayer, CIRCLE_FILL_COLOR);
  const line = compileZoomPaintProperty(styleLayer, CIRCLE_STROKE_COLOR);
  const properties = [radius, width, fill, line];
  if (properties.every(property => !property.isZoomDependent)) {
    return null;
  }

  const bucket = getZoomBucket(zoom);
  const upper = bucket + STYLE_ZOOM_STEP;
  /** Converts an evaluated color to normalized RGBA, or selects the attributes. */
  const normalize = (color?: number[]) => color?.map(channel => channel / 255) ?? [0, 0, 0, -1];
  /** Only composite values need another attribute sample. */
  const composite = (property: (typeof properties)[number]) =>
    property.isZoomDependent && property.isFeatureDependent;
  /** Unchanged paint stays in its original attribute. */
  const atZoom = <T>(property: ReturnType<typeof compileZoomPaintProperty<T>>, viewportZoom: number) =>
    property.isZoomDependent ? property.evaluate(viewportZoom) : undefined;
  /** Evaluates the paint uniforms at the viewport zoom, relative to this sublayer's attributes. */
  // The color, picking and highlight passes of a frame draw at the same zoom: evaluate once.
  let last: {zoom: number; paint: CircleZoomPaint} | null = null;
  const evaluate = (viewportZoom: number): CircleZoomPaint => {
    const paintZoom = getZoomPaintZoom(viewportZoom, zoom);
    if (last?.zoom !== paintZoom) {
      last = {
        zoom: paintZoom,
        paint: {
          size: [atZoom(radius, paintZoom) ?? -1, atZoom(width, paintZoom) ?? -1],
          fillColor: normalize(atZoom(fill, paintZoom)),
          lineColor: normalize(atZoom(line, paintZoom)),
          blend: properties.map(property =>
            getZoomInterpolationFactor(property.interpolation, paintZoom, bucket, upper)
          )
        }
      };
    }
    return last.paint;
  };
  /** Builds a per-feature accessor at the upper endpoint. */
  const next = <T>(property: PaintProperty<T>) =>
    getStyleAccessor(styleLayer, property.names, upper, property.combine, featureState, {
      exactZoom: true,
      stepZoom: bucket
    });

  return {
    evaluate,
    widthChangesWithZoom: width.isZoomDependent,
    size: composite(radius) || composite(width)
      ? next({
          names: [...CIRCLE_RADIUS.names, ...CIRCLE_STROKE_WIDTH.names],
          combine: ([r, w]): [number, number] =>
            [CIRCLE_RADIUS.combine([r]), CIRCLE_STROKE_WIDTH.combine([w])]
        })
      : null,
    fill: composite(fill) ? next(CIRCLE_FILL_COLOR) : null,
    line: composite(line) ? next(CIRCLE_STROKE_COLOR) : null
  };
}

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
 * Checks globe visibility and applies deck.gl's billboard depth adjustment at the translated
 * center. ScatterplotLayer still checks visibility at the original center.
 */
const circleTranslateGlobeModule = createShaderInjectionPlugin({
  name: 'circleTranslateGlobe',
  dependencies: [project],
  inject: {
    'vs:DECKGL_FILTER_GL_POSITION': /* glsl */ `
  if (fillTranslate.offset != vec2(0.0) && scatterplot.billboard) {
    vec4 moved = fillTranslate_getPosition(geometry.position);
    if (project_globe_is_occluded(moved.xyz)) {
      position = vec4(0.0, 0.0, 2.0, 1.0);
    } else {
      position = project_globe_billboard_clipspace(position, moved.xyz);
    }
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
      let moved = fillTranslate_getPosition(center);
      if (project_globe_is_occluded(moved.xyz)) {
        *position = vec4<f32>(0.0, 0.0, 2.0, 1.0);
      } else {
        let centerClip = project_globe_billboard_clipspace(
          project_common_position_to_clipspace(center), center.xyz
        );
        let corner = *position - centerClip;
        *position = project_globe_billboard_clipspace(
          project_common_position_to_clipspace(moved), moved.xyz
        ) + corner;
      }
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
  webgpu = false,
  styleProps,
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
  /** Whether the circles draw on WebGPU, where zoom-dependent paint is not interpolated on the GPU. */
  webgpu?: boolean;
  /** Extra sublayer props that may supply their own paint accessors or columns. */
  styleProps?: Record<string, unknown>;
  /** `circle-translate` and its anchor, when the layer sets them, as `FillTranslateExtension` takes them. */
  translate?: FillTranslateExtensionProps | null;
  parameters: any;
}) {
  const points = getPointFeatures(features);
  if (points.length === 0) {
    return null;
  }
  const hasPaintOverrides = CIRCLE_PAINT_OVERRIDES.some(name => styleProps?.[name] != null);
  const zoomPaint =
    webgpu || hasPaintOverrides ? null : getCircleZoomPaint(styleLayer, zoom, featureState);
  /** Evaluates a circle paint attribute at the lower endpoint. */
  const accessor = <T>(property: PaintProperty<T>) =>
    getStyleAccessor(styleLayer, property.names, zoom, property.combine, featureState);
  // The scatterplot shader adds the other half of the stroke to put the full stroke outside
  // the circle. With continuous paint the first half is also added in the shader.
  const radius = zoomPaint
    ? accessor(CIRCLE_RADIUS)
    : accessor({
        names: [...CIRCLE_RADIUS.names, ...CIRCLE_STROKE_WIDTH.names],
        combine: ([r, w]) => CIRCLE_RADIUS.combine([r]) + CIRCLE_STROKE_WIDTH.combine([w]) / 2
      });
  const lineWidth = accessor(CIRCLE_STROKE_WIDTH);
  const fillColor = accessor(CIRCLE_FILL_COLOR);
  const lineColor = accessor(CIRCLE_STROKE_COLOR);
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

  return new ZoomPaintScatterplotLayer({
    ...baseProps,
    id,
    data: sortFeaturesByKey(points, styleLayer, 'circle-sort-key', zoom),
    getPosition: d => d.position ?? d.geometry.coordinates,
    getRadius: radius.value,
    getLineWidth: lineWidth.value,
    getFillColor: fillColor.value,
    getLineColor: lineColor.value,
    circleZoomPaint: zoomPaint?.evaluate ?? null,
    ...(zoomPaint?.size ? {getNextCircleSize: zoomPaint.size.value} : {}),
    ...(zoomPaint?.fill ? {getNextCircleFillColor: zoomPaint.fill.value} : {}),
    ...(zoomPaint?.line ? {getNextCircleLineColor: zoomPaint.line.value} : {}),
    extensions: [
      ...(baseProps.extensions || []),
      ...(hasBlur ? [CIRCLE_BLUR_EXTENSION] : []),
      ...(translate ? [CIRCLE_TRANSLATE_EXTENSION] : [])
    ],
    ...(hasBlur ? {getBlur: blur.value} : {}),
    ...translate,
    billboard,
    stroked: styleLayer.paint?.['circle-stroke-width'] !== undefined &&
      (lineWidth.value !== 0 || Boolean(zoomPaint?.widthChangesWithZoom)),
    updateTriggers: {
      getRadius: radius.updateTrigger,
      getLineWidth: lineWidth.updateTrigger,
      getFillColor: fillColor.updateTrigger,
      getLineColor: lineColor.updateTrigger,
      getNextCircleSize: zoomPaint?.size?.updateTrigger,
      getNextCircleFillColor: zoomPaint?.fill?.updateTrigger,
      getNextCircleLineColor: zoomPaint?.line?.updateTrigger,
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
