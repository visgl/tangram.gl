// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {LayerExtension} from '@deck.gl/core';
import type {Layer} from '@deck.gl/core';
import {createSegmentAttributeUpdate} from './line-metrics';
import {createShaderInjectionPlugin} from './shader-injection-plugin';

const SHADER_MODULE_NAME = 'linePattern';

const UNIFORMS = `\
layout(std140) uniform linePatternUniforms {
  vec2 textureSize;
  float pixelsPerUnit;
} linePattern;
`;

const VS = `\
${UNIFORMS}
in vec4 instanceLinePatternFrames;
in vec3 instanceLinePatternDistances;
flat out vec4 linePattern_frame;
flat out float linePattern_repeat;
out float linePattern_distance;
out float linePattern_across;
`;

const FS = `\
${UNIFORMS}
uniform sampler2D linePattern_texture;
flat in vec4 linePattern_frame;
flat in float linePattern_repeat;
in float linePattern_distance;
in float linePattern_across;
`;

type LinePatternModuleProps = {
  linePattern_texture: unknown;
  textureSize: [number, number];
  pixelsPerUnit: number;
};

/** An image's rectangle in the pattern atlas, in pixels. */
type PatternFrame = {x: number; y: number; width: number; height: number};

/**
 * Adds `line-pattern` to the `PathLayer`s of a layer, as MapLibre GL JS draws it: the image is
 * stretched across the line's width and repeated along it, at its own aspect ratio. Its height is
 * the line's `line-width` at the integer zoom (`getLinePatternWidth`), and its length is measured
 * from the start of each line in the tile, in pixels at the integer zoom: between integer zooms
 * the pattern scales with the map. Each fragment takes the image's color times the stroke's own
 * color, which should be white with the line's opacity.
 *
 * `linePatternAtlas` holds the images, each with a 1 pixel border copied from its opposite edge
 * (see `getPatternAtlas`), at `linePatternMapping`'s rectangles; `getLinePattern` names a path's
 * image. `linePatternPixelsPerUnit` is 2 to the integer zoom: pixels per common unit at that
 * zoom. WebGL only.
 */
export class LinePatternExtension extends LayerExtension {
  static extensionName = 'LinePatternExtension';
  static defaultProps = {
    linePatternAtlas: {type: 'image', value: null, async: true},
    linePatternMapping: {type: 'object', value: {}, async: true},
    linePatternPixelsPerUnit: 1,
    getLinePattern: {type: 'accessor', value: ''},
    getLinePatternWidth: {type: 'accessor', value: 1}
  };

  isEnabled(layer: Layer): boolean {
    return layer.context.device.type !== 'webgpu' && 'pathTesselator' in (layer.state || {});
  }

  initializeState(this: Layer<any>, context: unknown, extension: this) {
    if (!extension.isEnabled(this)) {
      return;
    }
    this.getAttributeManager()?.addInstanced({
      instanceLinePatternFrames: {
        size: 4,
        accessor: 'getLinePattern',
        transform: (name: string) => {
          const frame = (this.props.linePatternMapping as Record<string, PatternFrame>)?.[name];
          return frame ? [frame.x, frame.y, frame.width, frame.height] : [0, 0, 0, 0];
        }
      },
      // Each segment's distances from its path's start, and the path's width at the integer zoom.
      instanceLinePatternDistances: {
        size: 3,
        accessor: ['getPath', 'getLinePatternWidth'],
        update: createSegmentAttributeUpdate(({start, end}, object, objectInfo) => {
          const width = (this.props as any).getLinePatternWidth;
          return [start, end, typeof width === 'function' ? width(object, objectInfo) : width];
        }),
        noAlloc: false
      }
    });
  }

  updateState(this: Layer<any>, {props, oldProps}: any, extension: this) {
    if (extension.isEnabled(this) && props.linePatternMapping !== oldProps.linePatternMapping) {
      this.getAttributeManager()?.invalidate('getLinePattern');
    }
  }

  draw(this: Layer<any>, params: unknown, extension: this) {
    const texture = this.props.linePatternAtlas;
    if (!extension.isEnabled(this) || !texture) {
      return;
    }
    const linePattern: LinePatternModuleProps = {
      linePattern_texture: texture,
      textureSize: [texture.width, texture.height],
      pixelsPerUnit: Number(this.props.linePatternPixelsPerUnit) || 1
    };
    this.setShaderModuleProps({[SHADER_MODULE_NAME]: linePattern});
  }

  getShaders(this: Layer, extension: this) {
    if (!extension.isEnabled(this)) {
      return {};
    }
    const plugin = createShaderInjectionPlugin({
      name: SHADER_MODULE_NAME,
      vs: VS,
      fs: FS,
      inject: {
        // The distance at this vertex, from its segment's start by PathLayer's `vPathPosition.y`,
        // in the segment's widths. One repeat of the image is its width over its height, in line
        // widths at the integer zoom.
        'vs:#main-end': `
  float linePattern_along = vPathLength > 0.0 ? vPathPosition.y / vPathLength : 0.0;
  linePattern_distance = mix(
    instanceLinePatternDistances.x, instanceLinePatternDistances.y, linePattern_along
  ) * linePattern.pixelsPerUnit;
  linePattern_frame = instanceLinePatternFrames;
  linePattern_repeat = instanceLinePatternFrames.w > 0.0
    ? instanceLinePatternFrames.z / instanceLinePatternFrames.w * instanceLinePatternDistances.z
    : 0.0;
  linePattern_across = vPathPosition.x;
`,
        // As MapLibre samples it: across the image from one edge of the line to the other, and
        // along it from the border pixel before the image to the one after.
        'fs:DECKGL_FILTER_COLOR': `
  if (!bool(picking.isActive)) {
    if (linePattern_repeat <= 0.0) {
      discard;
    }
    vec2 linePattern_position = vec2(
      fract(linePattern_distance / linePattern_repeat),
      clamp(0.5 * linePattern_across + 0.5, 0.0, 1.0)
    );
    vec2 linePattern_texel = 1.0 / linePattern.textureSize;
    vec2 linePattern_uv = mix(
      linePattern_frame.xy * linePattern_texel - linePattern_texel,
      (linePattern_frame.xy + linePattern_frame.zw) * linePattern_texel + linePattern_texel,
      linePattern_position
    );
    color *= texture(linePattern_texture, linePattern_uv);
  }
`
      },
      uniformTypes: {textureSize: 'vec2<f32>', pixelsPerUnit: 'f32'}
    });
    return {plugins: [plugin]};
  }
}
