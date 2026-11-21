// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {LayerExtension} from '@deck.gl/core';
import type {Layer, UpdateParameters} from '@deck.gl/core';
import {createShaderInjectionPlugin} from './shader-injection-plugin';

type LineShapeProps = {lineCapSquare?: boolean};

const UNIFORMS = /* glsl */ `
layout(std140) uniform lineShapeUniforms {
  float squareCap;
} lineShape;
`;

/**
 * How far the line is cut beyond a joint, in half widths along the joint's outward miter
 * direction, as MapLibre GL JS draws it. A miter within the limit is not cut. Beyond the limit,
 * a miter becomes a bevel: the chord between the two outer corners, `sinHalfAngle` from the
 * vertex. Past a miter of two half widths MapLibre draws its "flip bevel", whose edge passes
 * through the vertex.
 */
const GET_JOINT_CUT = /* glsl */ `
vec3 lineShape_getJoint(vec2 deltaA, vec2 deltaB, bool isCap, bool isRound, float miterLimit) {
  float lenA = length(deltaA);
  float lenB = length(deltaB);
  if (isCap || isRound || lenA == 0.0 || lenB == 0.0) {
    return vec3(0.0, 0.0, 1e6);
  }
  vec2 dirA = deltaA / lenA;
  vec2 dirB = deltaB / lenB;
  float sinHalfAngle = sqrt(max(0.5 + 0.5 * dot(dirA, dirB), 0.0));
  float miterSize = 1.0 / max(sinHalfAngle, 0.001);
  vec2 outward = dirA - dirB;
  if (miterSize <= miterLimit || length(outward) == 0.0) {
    return vec3(0.0, 0.0, 1e6);
  }
  return vec3(normalize(outward), miterSize > 2.0 ? 0.0 : sinHalfAngle);
}
`;

const LINE_SHAPE_PLUGIN = createShaderInjectionPlugin({
  name: 'lineShape',
  vs: /* glsl */ `
${UNIFORMS}
${GET_JOINT_CUT}
// Per joint: how far this vertex is beyond the joint, and where the joint is cut.
out vec2 lineShape_beyond;
out vec2 lineShape_cut;
`,
  fs: /* glsl */ `
in vec2 lineShape_beyond;
in vec2 lineShape_cut;
`,
  uniformTypes: {squareCap: 'f32'},
  inject: {
    'vs:#main-end': {
      order: 1,
      injection: /* glsl */ `
  lineShape_beyond = vec2(0.0);
  lineShape_cut = vec2(1e6);
  if (!path.billboard) {
    bool endVertex = positions.x > 0.0;
    // PathLayer has the previous, current and next points of this vertex. The segment's other
    // joint takes the point beyond the segment's other end.
    vec3 otherPosition = endVertex
      ? project_position(instanceLeftPositions, instanceLeftPositions64Low)
      : project_position(instanceRightPositions, instanceRightPositions64Low);
    vec3 left = endVertex ? otherPosition : prevPosition;
    vec3 start = endVertex ? prevPosition : currPosition;
    vec3 end = endVertex ? currPosition : nextPosition;
    vec3 right = endVertex ? nextPosition : otherPosition;
    mat3 rotationMatrix;
    bool needsRotation = project_needs_rotation(currPosition, rotationMatrix);
    mat3 rotation = needsRotation ? rotationMatrix : mat3(1.0);
    vec2 segment = ((end - start) * rotation).xy;
    vec2 beforeStart = ((start - left) * rotation).xy;
    vec2 afterEnd = ((right - end) * rotation).xy;
    bool isPathStart = instanceTypes == 1.0 || instanceTypes == 3.0;
    bool isPathEnd = instanceTypes == 2.0 || instanceTypes == 3.0;

    if (lineShape.squareCap > 0.5 && length(segment) > 0.0) {
      // MapLibre extends the cap's vertices beyond the endpoint and keeps the endpoint's line
      // distance on them, so the dashes of the first and last segments stretch over the caps.
      float capDirection = 0.0;
      if (!endVertex && (isPathStart || length(beforeStart) == 0.0)) {
        capDirection = -1.0;
      } else if (endVertex && (isPathEnd || length(afterEnd) == 0.0)) {
        capDirection = 1.0;
      }
      float capHalfWidth = width.x;
#ifdef PATH_STYLE_OFFSET
      capHalfWidth /= abs(instanceOffsets * 2.0) + 1.0;
#endif
      vec3 shift = vec3(normalize(segment) * capDirection * capHalfWidth, 0.0);
      if (needsRotation) {
        shift = rotationMatrix * shift;
      }
      geometry.position.xyz += shift;
      gl_Position += project.viewProjectionMatrix * vec4(shift, 0.0);
    }

#ifndef PATH_STYLE_OFFSET
    // Offset lines turn their corners away from the path: their joints keep PathLayer's cut.
    if (width.x > 0.0) {
      vec3 startJoint = lineShape_getJoint(
        beforeStart, segment, isPathStart, path.jointType > 0.5, path.miterLimit + 1.0
      );
      vec3 endJoint = lineShape_getJoint(
        segment, afterEnd, isPathEnd, path.jointType > 0.5, path.miterLimit + 1.0
      );
      vec2 fromStart = ((geometry.position.xyz - start) * rotation).xy / width.x;
      vec2 fromEnd = ((geometry.position.xyz - end) * rotation).xy / width.x;
      lineShape_beyond = vec2(dot(fromStart, startJoint.xy), dot(fromEnd, endJoint.xy));
      lineShape_cut = vec2(startJoint.z, endJoint.z);
    }
#endif
  }
`
    },
    'fs:#main-end': {
      order: 1,
      injection: /* glsl */ `
  // Both are affine in the fragment's position, so they interpolate exactly.
  if (lineShape_beyond.x > lineShape_cut.x || lineShape_beyond.y > lineShape_cut.y) {
    discard;
  }
`
    }
  }
});

function isPathLayer(layer: Layer): boolean {
  return layer.context.device.type === 'webgl' && 'pathTesselator' in (layer.state || {});
}

/**
 * Draws a `PathLayer`'s caps and joins as MapLibre GL JS draws `line-cap` and `line-join`, which
 * deck.gl does not: with `lineCapSquare`, each end of a path extends half the line's width past
 * its endpoint, and a join whose miter exceeds `miterLimit + 1` half widths is bevelled (see
 * `GET_JOINT_CUT`). Set `capRounded: false` for a square cap. Adds no vertex attribute. WebGL
 * only, and not on billboard paths; joins of paths with `PathStyleExtension`'s offsets keep
 * deck.gl's flat cut.
 */
export class LineShapeExtension extends LayerExtension {
  static extensionName = 'LineShapeExtension';
  static defaultProps = {lineCapSquare: false};

  /** Forward the cap choice to the shader. */
  updateState(this: Layer<LineShapeProps>, {props}: UpdateParameters<Layer<LineShapeProps>>) {
    if (isPathLayer(this)) {
      this.setShaderModuleProps({lineShape: {squareCap: props.lineCapSquare ? 1 : 0}});
    }
  }

  /** Install the shape shader on supported PathLayers. */
  getShaders(this: Layer) {
    return isPathLayer(this) ? {plugins: [LINE_SHAPE_PLUGIN]} : {};
  }
}
