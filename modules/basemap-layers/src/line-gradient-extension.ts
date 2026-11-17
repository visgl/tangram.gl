// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {LayerExtension} from '@deck.gl/core';
import type {Layer} from '@deck.gl/core';
import {createSegmentAttributeUpdate} from './line-metrics';
import {createShaderInjectionPlugin} from './shader-injection-plugin';
import {getCompiledStyleProperty} from './style-expression';

/** `geojson-vt`'s properties for a line's part in a tile, with `lineMetrics`. */
export const LINE_CLIP_START = 'geojsonvt_clip_start';
export const LINE_CLIP_END = 'geojsonvt_clip_end';

/** The ramp's width for an interpolated gradient, as MapLibre GL JS draws it. */
const RAMP_WIDTH = 256;
/**
 * The ramp's width for a `step` gradient, drawn without filtering. MapLibre widens it with the
 * longest line in the tile, up to the device's texture size; this width is that of a line about
 * as long as the tile is wide, near the source's highest zoom.
 */
const STEP_RAMP_WIDTH = 2048;

/** A `line-gradient` ramp, and the sampler parameters to draw it with. */
export type LineGradientRamp = {
  image: ImageData | {data: Uint8ClampedArray; width: number; height: number};
  textureParameters: Record<string, string>;
};

const rampCache = new WeakMap<object, {value: unknown; ramp: LineGradientRamp | null}>();

/**
 * The `line-gradient` of a style layer as a one-row RGBA ramp, from `line-progress` 0 at its first
 * pixel to 1 at its last, unpremultiplied, as MapLibre GL JS renders it (`renderColorRamp`). A
 * `step` gradient is sampled with the nearest pixel, as MapLibre does, the others linearly. Null
 * without a valid `line-gradient`. Cached per style layer while its value is unchanged.
 */
export function getLineGradientRamp(styleLayer: {
  paint?: Record<string, unknown>;
}): LineGradientRamp | null {
  const value = styleLayer.paint?.['line-gradient'];
  const cached = rampCache.get(styleLayer);
  if (cached && cached.value === value) {
    return cached.ramp;
  }
  const property =
    value === undefined ? null : getCompiledStyleProperty(styleLayer, 'line-gradient');
  let ramp: LineGradientRamp | null = null;
  if (property) {
    const step = Array.isArray(value) && value[0] === 'step';
    const width = step ? STEP_RAMP_WIDTH : RAMP_WIDTH;
    const data = new Uint8ClampedArray(width * 4);
    for (let i = 0; i < width; i++) {
      const color = property.evaluateWithGlobals({zoom: 0, lineProgress: i / (width - 1)}) as
        | number[]
        | null;
      if (color) {
        data.set([color[0], color[1], color[2], Math.round(color[3] * 255)], i * 4);
      }
    }
    ramp = {
      image:
        typeof ImageData === 'undefined'
          ? {data, width, height: 1}
          : new ImageData(data, width, 1),
      textureParameters: {
        minFilter: step ? 'nearest' : 'linear',
        magFilter: step ? 'nearest' : 'linear',
        mipmapFilter: 'none'
      }
    };
  }
  rampCache.set(styleLayer, {value, ramp});
  return ramp;
}

/** A tiled line's part of its whole line, `[start, end]`, from its `lineMetrics` properties. */
export function getLineClip(feature: {properties?: Record<string, unknown>}): [number, number] {
  const properties = feature?.properties;
  const start = Number(properties?.[LINE_CLIP_START]);
  const end = Number(properties?.[LINE_CLIP_END]);
  return Number.isFinite(start) && Number.isFinite(end) ? [start, end] : [0, 1];
}

const SHADER_MODULE_NAME = 'lineGradient';

const VS = `\
in vec2 instanceLineProgress;
out float lineGradient_progress;
`;

const FS = `\
uniform sampler2D lineGradient_texture;
in float lineGradient_progress;
`;

/**
 * Adds `line-gradient` to the `PathLayer`s of a layer: each fragment takes the color of
 * `lineGradientImage`, a ramp of `line-gradient` from progress 0 at its left edge to 1 at its
 * right, at the fragment's `line-progress`, times the stroke's own color, as MapLibre GL JS
 * multiplies the ramp by `line-opacity`. The stroke color should be white with the opacity.
 *
 * `getLineClip` gives a path's part of its whole line, `[start, end]` in 0 to 1, as geojson-vt
 * records it for a source with `lineMetrics` (`geojsonvt_clip_start`, `geojsonvt_clip_end`). The
 * progress runs from `start` to `end` along the path, by distance, as in MapLibre. WebGL only.
 */
export class LineGradientExtension extends LayerExtension {
  static extensionName = 'LineGradientExtension';
  static defaultProps = {
    lineGradientImage: {type: 'image', value: null, async: true},
    getLineClip: {type: 'accessor', value: [0, 1]}
  };

  isEnabled(layer: Layer): boolean {
    return layer.context.device.type !== 'webgpu' && 'pathTesselator' in (layer.state || {});
  }

  initializeState(this: Layer, context: unknown, extension: this) {
    if (!extension.isEnabled(this)) {
      return;
    }
    const getProgress = (distance: number, length: number, [start, end]: number[]) =>
      start + (end - start) * (length > 0 ? distance / length : 0);
    this.getAttributeManager()?.addInstanced({
      // The `line-progress` at each segment's start and end.
      instanceLineProgress: {
        size: 2,
        accessor: ['getPath', 'getLineClip'],
        update: createSegmentAttributeUpdate(({start, end, length}, object, objectInfo) => {
          const clip = (this.props as any).getLineClip;
          const lineClip = typeof clip === 'function' ? clip(object, objectInfo) : clip;
          return [getProgress(start, length, lineClip), getProgress(end, length, lineClip)];
        }),
        noAlloc: false
      }
    });
  }

  draw(this: Layer<any>, params: unknown, extension: this) {
    if (!extension.isEnabled(this) || !this.props.lineGradientImage) {
      return;
    }
    this.setShaderModuleProps({
      [SHADER_MODULE_NAME]: {lineGradient_texture: this.props.lineGradientImage}
    });
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
        // The progress at this vertex: along its segment, from the segment's start, as PathLayer
        // measures `vPathPosition.y` in the segment's widths. Vertices of joins and caps lie
        // before or after the segment: the ramp's edge pixels color them.
        'vs:#main-end': `
  float lineGradient_along = vPathLength > 0.0 ? vPathPosition.y / vPathLength : 0.0;
  lineGradient_progress = mix(instanceLineProgress.x, instanceLineProgress.y, lineGradient_along);
`,
        'fs:DECKGL_FILTER_COLOR': `
  if (!bool(picking.isActive)) {
    color *= texture(lineGradient_texture, vec2(lineGradient_progress, 0.5));
  }
`
      }
    });
    return {plugins: [plugin]};
  }
}
