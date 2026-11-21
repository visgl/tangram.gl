// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {LayerExtension, project32} from '@deck.gl/core';
import type {FirstPersonViewport, Layer} from '@deck.gl/core';
import type {ShaderPlugin} from '@luma.gl/shaders';
import {createShaderInjectionPlugin} from './shader-injection-plugin';

/**
 * Turns a billboard drawn along a line on a globe from the line's direction at the anchor (the
 * instance angle, counter-clockwise from east) to that direction as the view draws it, so the label
 * follows its line on every frame, at any bearing, anywhere on the globe, without updating any
 * attribute. The direction on screen is the line's tangent at the anchor, east and north on the
 * globe's surface (the derivatives of `project_globe_`), through the view-projection matrix: exact,
 * with no difference of nearby positions to lose precision.
 *
 * With `keepUpright`, a billboard that would read upside down there is turned by another half turn,
 * as `getUprightAngle` turns it from the bearing alone: away from the middle of the view the bearing
 * does not tell which way the view draws a line.
 *
 * With `pixelOffset`, the name of the layer's pixel offset attribute, that offset is not turned
 * around with the billboard: it is a direction along and across the line (see
 * `withLineDirection`), and stays on the same side of the line.
 *
 * The instance angle and pixel offset are only declared in the layer's own shader source, after the
 * hook functions, so they are copied into globals at the start of `main`.
 */
const getGlobeLineAngleModule = (keepUpright: boolean, pixelOffset?: string, mercator = false) => createShaderInjectionPlugin({
  name: `${mercator ? 'mercator' : 'globe'}LineAngle${keepUpright ? 'Upright' : ''}${pixelOffset ? `_${pixelOffset}` : ''}`,
  dependencies: [project32],
  inject: {
    'vs:#decl': /* glsl */ `
float globeLineAngle_angle;
vec2 globeLineAngle_pixelOffset;
`,
    'vs:#main-start': /* glsl */ `
  globeLineAngle_angle = radians(instanceAngles);
  // As the layer adds it to the billboard's offset, y down.
  globeLineAngle_pixelOffset = ${pixelOffset ? `vec2(${pixelOffset}.x, -${pixelOffset}.y)` : 'vec2(0.0)'};
`,
    'vs:DECKGL_FILTER_SIZE': /* glsl */ `
  if (${mercator ? 'true' : 'project.projectionMode == PROJECTION_MODE_GLOBE'}) {
    ${mercator ? `
    vec3 globeLineAngle_tangent = vec3(cos(globeLineAngle_angle), sin(globeLineAngle_angle), 0.0);
    vec4 globeLineAngle_clip = project_common_position_to_clipspace(geometry.position);
    ` : `
    float globeLineAngle_lambda = radians(geometry.worldPosition.x);
    float globeLineAngle_phi = radians(geometry.worldPosition.y);
    vec3 globeLineAngle_east = vec3(cos(globeLineAngle_lambda), sin(globeLineAngle_lambda), 0.0);
    vec3 globeLineAngle_north = vec3(
      -sin(globeLineAngle_lambda) * sin(globeLineAngle_phi),
      cos(globeLineAngle_lambda) * sin(globeLineAngle_phi),
      cos(globeLineAngle_phi)
    );
    vec3 globeLineAngle_tangent = cos(globeLineAngle_angle) * globeLineAngle_east +
      sin(globeLineAngle_angle) * globeLineAngle_north;
    vec4 globeLineAngle_clip = project_common_position_to_clipspace(
      vec4(project_position(geometry.worldPosition), 1.0)
    );
    `}
    vec4 globeLineAngle_clipTangent = project.viewProjectionMatrix * vec4(globeLineAngle_tangent, 0.0);
    // The derivative of the anchor's normalized device coordinates, times w squared, in pixels.
    vec2 globeLineAngle_screen = (globeLineAngle_clipTangent.xy * globeLineAngle_clip.w -
      globeLineAngle_clip.xy * globeLineAngle_clipTangent.w) * project.viewportSize;
    float globeLineAngle_turn =
      atan(globeLineAngle_screen.y, globeLineAngle_screen.x) - globeLineAngle_angle;
    float globeLineAngle_cos = cos(globeLineAngle_turn);
    float globeLineAngle_sin = sin(globeLineAngle_turn);
    mat2 globeLineAngle_rotation =
      mat2(globeLineAngle_cos, globeLineAngle_sin, -globeLineAngle_sin, globeLineAngle_cos);
${
  keepUpright
    ? `    if (globeLineAngle_screen.x < 0.0) {
      // Turned around, but for the pixel offset: -(size - offset) + offset.
      size.xy = 2.0 * globeLineAngle_pixelOffset - size.xy;
    }
`
    : ''
}    size.xy = globeLineAngle_rotation * size.xy;
  }
`
  }
});

const GLOBE_LINE_ANGLE_MODULES = {
  free: getGlobeLineAngleModule(false),
  upright: getGlobeLineAngleModule(true),
  // The pixel offset attributes of `IconLayer` (and the glyphs of `TextLayer`) and of
  // `TextLayer`'s backgrounds.
  instancePixelOffset: getGlobeLineAngleModule(true, 'instancePixelOffset'),
  instancePixelOffsets: getGlobeLineAngleModule(true, 'instancePixelOffsets')
};

/** Apply the same screen-space rotation to Mercator billboards on WebGPU. */
function getMercatorLineAnglePluginWGSL(pixelOffset: string, keepUpright: boolean): ShaderPlugin {
  // Glyphs and text backgrounds both expose these attributes in their vertex entry point.
  const input = pixelOffset === 'instancePixelOffsets' ? 'attributes' : 'inp';
  return {
    name: `mercatorLineAngle${keepUpright ? 'Upright' : ''}_${pixelOffset}`,
    injections: [
      {stage: 'vertex', target: '#decl', wgsl: `
var<private> mercatorLineAngle: f32;
var<private> mercatorLinePixelOffset: vec2<f32>;
`},
      {stage: 'vertex', target: '#main-start', wgsl: `
mercatorLineAngle = radians(${input}.instanceAngles);
${keepUpright ? `mercatorLinePixelOffset = vec2<f32>(${input}.${pixelOffset}.x, -${input}.${pixelOffset}.y);` : ''}
`},
      {
      stage: 'vertex',
      target: 'DECKGL_FILTER_SIZE',
      wgsl: /* wgsl */ `
  {
    let angle = mercatorLineAngle;
    let direction = vec2<f32>(cos(angle), sin(angle));
    let clip = project_common_position_to_clipspace(geometry.position);
    let tangent = project.viewProjectionMatrix * vec4<f32>(direction, 0.0, 0.0);
    let screen = (tangent.xy * clip.w - clip.xy * tangent.w) * project.viewportSize;
    let turn = atan2(screen.y, screen.x) - angle;
    var offset = (*size).xy;
    ${keepUpright ? `
    if (screen.x < 0.0) {
      offset = 2.0 * mercatorLinePixelOffset - offset;
    }
    ` : ''}
    let rotation = mat2x2<f32>(cos(turn), sin(turn), -sin(turn), cos(turn));
    *size = vec3<f32>(rotation * offset, (*size).z);
  }
`
      }
    ]
  };
}

const MERCATOR_LINE_ANGLE_MODULES = {
  free: getGlobeLineAngleModule(false, undefined, true),
  instancePixelOffset: getGlobeLineAngleModule(true, 'instancePixelOffset', true),
  instancePixelOffsets: getGlobeLineAngleModule(true, 'instancePixelOffsets', true)
};

const MERCATOR_LINE_ANGLE_WGSL = {
  instancePixelOffset: {
    free: getMercatorLineAnglePluginWGSL('instancePixelOffset', false),
    upright: getMercatorLineAnglePluginWGSL('instancePixelOffset', true)
  },
  instancePixelOffsets: {
    free: getMercatorLineAnglePluginWGSL('instancePixelOffsets', false),
    upright: getMercatorLineAnglePluginWGSL('instancePixelOffsets', true)
  }
};

/**
 * Turns camera-facing labels along the projected line, upright with `keepUpright`. The globe
 * uses this on WebGL. With `mercator`, viewport-pitched road text uses it on both backends.
 *
 * Added to a composite layer such as `TextLayer`, it reaches the character and background
 * sublayers. With `keepOffsetSide`, text kept upright is turned around without its pixel offset,
 * which must then be a direction along and across the line, as `text-offset` is.
 */
export class GlobeLineAngleExtension extends LayerExtension<{
  keepUpright: boolean;
  keepOffsetSide?: boolean;
  mercator?: boolean;
}> {
  static extensionName = 'GlobeLineAngleExtension';

  constructor(opts: {keepUpright: boolean; keepOffsetSide?: boolean; mercator?: boolean}) {
    super(opts);
  }

  getShaders(this: Layer, extension: GlobeLineAngleExtension) {
    const {keepUpright, keepOffsetSide, mercator} = extension.opts;
    // `TextLayer`'s backgrounds name the attribute in the plural.
    const attributes = (this.getAttributeManager() as any)?.attributes || {};
    const pixelOffset = attributes.instancePixelOffsets ? 'instancePixelOffsets' : 'instancePixelOffset';
    if (mercator) {
      const plugin = this.context.device.type === 'webgpu'
        ? MERCATOR_LINE_ANGLE_WGSL[pixelOffset][keepUpright ? 'upright' : 'free']
        : MERCATOR_LINE_ANGLE_MODULES[keepUpright ? pixelOffset : 'free'];
      return {plugins: [plugin]};
    }
    if (this.context.device.type === 'webgpu') {
      return {};
    }
    if (!keepUpright) {
      return {plugins: [GLOBE_LINE_ANGLE_MODULES.free]};
    }
    if (!keepOffsetSide) {
      return {plugins: [GLOBE_LINE_ANGLE_MODULES.upright]};
    }
    return {plugins: [GLOBE_LINE_ANGLE_MODULES[pixelOffset]]};
  }
}

/** Forward distance to the ground at the view center, limited to the far plane at the horizon. */
export function getFirstPersonLabelReferenceDepth(viewport: FirstPersonViewport): number {
  const {cameraPosition, viewMatrixInverse, projectionMatrix} = viewport;
  const groundDepth = cameraPosition[2] / viewMatrixInverse[10];
  const farDepth = projectionMatrix[14] / (projectionMatrix[10] + 1);
  const hasFarDepth = Number.isFinite(farDepth) && farDepth > 0;
  if (Number.isFinite(groundDepth) && groundDepth > 0) {
    return hasFarDepth ? Math.min(groundDepth, farDepth) : groundDepth;
  }
  return hasFarDepth ? farDepth : 0;
}

/** MapLibre's viewport-pitched symbol size, shared with placement. */
export function getFirstPersonLabelPerspective(referenceDepth: number, anchorDepth: number): number {
  return referenceDepth > 0 && anchorDepth > 0
    ? Math.min(4, 0.5 + 0.5 * referenceDepth / anchorDepth)
    : 1;
}

const firstPersonLabelSizeUniforms = {referenceDepth: 'f32'} as const;

const firstPersonLabelSizeGLSL = createShaderInjectionPlugin({
  name: 'firstPersonLabelSize',
  dependencies: [project32],
  vs: /* glsl */ `
layout(std140) uniform firstPersonLabelSizeUniforms {
  float referenceDepth;
} firstPersonLabelSize;
`,
  uniformTypes: firstPersonLabelSizeUniforms,
  inject: {
    'vs:DECKGL_FILTER_SIZE': {
      order: 1,
      injection: `
  vec4 firstPersonLabelClip = project_common_position_to_clipspace(geometry.position);
  float anchorDepth = firstPersonLabelClip.w;
  float referenceDepth = firstPersonLabelSize.referenceDepth;
  float perspective = referenceDepth > 0.0 && anchorDepth > 0.0
    ? min(4.0, 0.5 + 0.5 * referenceDepth / anchorDepth) : 1.0;
  size.xy *= perspective * max(0.0, anchorDepth) / project.focalDistance;
`
    }
  }
});

const firstPersonLabelSizeWGSL: ShaderPlugin = {
  name: 'firstPersonLabelSize',
  module: {
    name: 'firstPersonLabelSize',
    source: /* wgsl */ `
struct FirstPersonLabelSizeUniforms {
  referenceDepth: f32,
};
@group(1) @binding(auto) var<uniform> firstPersonLabelSize: FirstPersonLabelSizeUniforms;
`,
    uniformTypes: firstPersonLabelSizeUniforms
  },
  injections: [{
    stage: 'vertex',
    target: 'DECKGL_FILTER_SIZE',
    order: 1,
    wgsl: `
  let firstPersonLabelClip = project_common_position_to_clipspace(geometry.position);
  let anchorDepth = firstPersonLabelClip.w;
  let referenceDepth = firstPersonLabelSize.referenceDepth;
  var perspective = 1.0;
  if (referenceDepth > 0.0 && anchorDepth > 0.0) {
    perspective = min(4.0, 0.5 + 0.5 * referenceDepth / anchorDepth);
  }
  let firstPersonLabelScale = perspective * max(0.0, anchorDepth) / project.focalDistance;
  *size = vec3<f32>((*size).xy * firstPersonLabelScale, (*size).z);
`
  }]
};

/** Size first-person text in screen pixels with MapLibre's distance falloff. */
export class FirstPersonLabelSizeExtension extends LayerExtension {
  static extensionName = 'FirstPersonLabelSizeExtension';

  getShaders(this: Layer) {
    return {plugins: [this.context.device.type === 'webgpu' ? firstPersonLabelSizeWGSL : firstPersonLabelSizeGLSL]};
  }

  draw(this: Layer) {
    const viewport = this.context.viewport as FirstPersonViewport;
    this.setShaderModuleProps({
      firstPersonLabelSize: {referenceDepth: getFirstPersonLabelReferenceDepth(viewport)}
    });
  }
}
