// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {LayerExtension, log} from '@deck.gl/core';
import type {Accessor, CompositeLayer, Layer} from '@deck.gl/core';
import type {Device, Texture} from '@luma.gl/core';
import {createShaderInjectionPlugin} from './shader-injection-plugin';

/** The most dash intervals a pattern can store before it falls back to one dash and gap. */
export const MAX_DASH_INTERVALS = 32;
const MAX_DASH_ROWS = 4096;
const TEXTURE_WIDTH = 1 + MAX_DASH_INTERVALS / 2;

type DashArray = readonly [number, number];
type DashPattern = {
  intervals: readonly DashArray[];
  period: number;
  dashLength: number;
  merged: DashArray;
};

const patternRows = new Map<string, number>();
const patterns: DashPattern[] = [];
const patternTextures = new WeakMap<Device, {texture: Texture; rows: number}>();
let warnedAboutFullAtlas = false;

/**
 * Registers normalized lengths in line widths and returns their stable row, or -1 if the
 * pattern exceeds the atlas limits. Intervals use half widths to match PathLayer's coordinates.
 */
export function getDashPatternRow(pattern: number[]): number {
  if (Math.ceil(pattern.length / 2) > MAX_DASH_INTERVALS) {
    return -1;
  }
  const key = pattern.join(',');
  const existing = patternRows.get(key);
  if (existing !== undefined) {
    return existing;
  }
  if (patterns.length >= MAX_DASH_ROWS) {
    if (!warnedAboutFullAtlas) {
      warnedAboutFullAtlas = true;
      log.warn(
        `[BasemapLayer] The dash atlas holds ${MAX_DASH_ROWS} patterns. New line-dasharray patterns draw as one dash and one gap per period.`
      )();
    }
    return -1;
  }

  const intervals: DashArray[] = [];
  let period = 0;
  let dashLength = 0;
  let gapLength = 0;
  for (const [index, length] of pattern.entries()) {
    const end = period + 2 * length;
    if (index % 2 === 0) {
      intervals.push([period, end]);
      dashLength += 2 * length;
    } else {
      gapLength += 2 * length;
    }
    period = end;
  }
  const row = patterns.length;
  patterns.push({intervals, period, dashLength, merged: [dashLength, gapLength]});
  patternRows.set(key, row);
  return row;
}

/** The pattern stored in an atlas row, in half line widths. */
export function getDashPattern(row: number): DashPattern | undefined {
  return patterns[row];
}

function decodeDashArray(array: DashArray): DashArray {
  const [period, marker] = array;
  const pattern = marker < 0 ? getDashPattern(-marker - 1) : undefined;
  if (!pattern) {
    return array;
  }
  const scale = period / pattern.period;
  return [pattern.merged[0] * scale, pattern.merged[1] * scale];
}

function getPatternTexture(device: Device): Texture {
  const previous = patternTextures.get(device);
  const rows = patterns.length;
  if (previous?.rows === rows) {
    return previous.texture;
  }

  const height = 2 ** Math.ceil(Math.log2(Math.max(rows, 1)));
  const data = new Float32Array(TEXTURE_WIDTH * height * 4);
  patterns.forEach(({intervals, period, dashLength}, row) => {
    const start = row * TEXTURE_WIDTH * 4;
    data.set([intervals.length, period, dashLength, 0], start);
    intervals.forEach((interval, index) => data.set(interval, start + 4 + index * 2));
  });
  const texture = device.createTexture({
    format: 'rgba32float',
    width: TEXTURE_WIDTH,
    height,
    mipLevels: 1,
    sampler: {minFilter: 'nearest', magFilter: 'nearest'}
  });
  texture.writeData(data);
  previous?.texture.destroy();
  patternTextures.set(device, {texture, rows});
  return texture;
}

const LINE_DASH_PLUGIN = createShaderInjectionPlugin({
  name: 'lineDash',
  vs: /* glsl */ `
#ifdef HIGH_PRECISION_DASH
flat out float lineDash_row;
flat out float lineDash_period;
flat out float lineDash_offset;
#endif
`,
  fs: /* glsl */ `
#ifdef HIGH_PRECISION_DASH
uniform highp sampler2D lineDash_patterns;
flat in float lineDash_row;
flat in float lineDash_period;
flat in float lineDash_offset;
#endif
`,
  inject: {
    'vs:#main-end': {
      order: 1,
      injection: /* glsl */ `
#ifdef HIGH_PRECISION_DASH
  // Deck has converted the period into path coordinates and LineBlurExtension has rescaled it.
  lineDash_row = instanceDashArrays.y < 0.0 ? -instanceDashArrays.y - 1.0 : -1.0;
  lineDash_period = pathStyle_dashArray.x;
  lineDash_offset = lineDash_period > 0.0 ? mod(dashOffsetAndLength.x, lineDash_period) : 0.0;
#endif
`
    },
    'fs:#main-start': {
      order: 1,
      injection: /* glsl */ `
#ifdef HIGH_PRECISION_DASH
  float lineDash_coverage = 1.0;
  bool lineDash_discard = false;
  bool lineDash_valid = lineDash_row >= 0.0 && lineDash_period > 0.0;
  // Use the vertex phase on the geometry outside the segment's endpoints, including caps.
  float lineDash_along = clamp(vPathPosition.y, vPathBounds.x, vPathBounds.y) + lineDash_offset;
  float lineDash_filterWidth = max(fwidth(lineDash_along), 1e-4);
  bool lineDash_round = path.capType > 0.5;
  float lineDash_nearest = 0.0;
  float lineDash_duty = 1.0;
  float lineDash_subPixelBlend = 0.0;
  if (lineDash_valid) {
    int row = int(lineDash_row);
    vec3 header = texelFetch(lineDash_patterns, ivec2(0, row), 0).xyz;
    float scale = lineDash_period / header.y;
    float position = mod(lineDash_along, lineDash_period);
    float low = position - 0.5 * lineDash_filterWidth;
    float high = position + 0.5 * lineDash_filterWidth;
    float lowCycle = floor(low / lineDash_period);
    float highCycle = floor(high / lineDash_period);
    low = mod(low, lineDash_period);
    high = mod(high, lineDash_period);
    // F(x) counts complete periods plus the covered length inside the current period.
    // Evaluate F(high) - F(low) in one loop, with the filter centered in the first period.
    float covered = (highCycle - lowCycle) * header.z * scale;
    bool inDash = false;
    lineDash_nearest = lineDash_period;
    float capSpan = 2.0 * sqrt(max(1.0 - vPathPosition.x * vPathPosition.x, 0.0));
    float previousEnd = 0.0;
    float capLength = 0.0;
    for (int i = 0; i < ${MAX_DASH_INTERVALS}; i++) {
      if (i >= int(header.x)) {
        break;
      }
      vec4 pair = texelFetch(lineDash_patterns, ivec2(1 + i / 2, row), 0);
      vec2 interval = (i % 2 == 0 ? pair.xy : pair.zw) * scale;
      float intervalLength = interval.y - interval.x;
      if (lineDash_round) {
        // The nearest interval can be across the seam of the period, including a zero-length dot.
        float forward = interval.x - position;
        float backward = position - interval.y;
        float distanceAlong = max(max(forward, backward), 0.0);
        distanceAlong = min(distanceAlong, min(forward + lineDash_period, backward + lineDash_period));
        lineDash_nearest = min(lineDash_nearest, distanceAlong);
        capLength += min(interval.x - previousEnd, capSpan);
        previousEnd = interval.y;
      } else {
        covered += clamp(high - interval.x, 0.0, intervalLength) -
          clamp(low - interval.x, 0.0, intervalLength);
        inDash = inDash || (intervalLength > 0.0 && position >= interval.x && position <= interval.y);
      }
    }
    if (lineDash_round) {
      capLength += min(max(lineDash_period - previousEnd, 0.0), capSpan);
      lineDash_duty = clamp((header.z * scale + capLength) / lineDash_period, 0.0, 1.0);
    } else if (bool(picking.isActive)) {
      lineDash_discard = !inDash;
    } else {
      lineDash_coverage = clamp(covered / lineDash_filterWidth, 0.0, 1.0);
    }
  }

  // Evaluate the derivative before PathLayer or a neighboring fragment can discard.
  float lineDash_distance = length(vec2(lineDash_nearest, vPathPosition.x));
  float lineDash_edgePixels = (1.0 - lineDash_distance) / max(fwidth(lineDash_distance), 1e-6);
  if (lineDash_valid && lineDash_round) {
    if (bool(picking.isActive)) {
      lineDash_discard = lineDash_distance > 1.0;
    } else {
      lineDash_coverage = lineDash_nearest > 0.0 ? smoothedge(0.0, lineDash_edgePixels) : 1.0;
      lineDash_subPixelBlend = smoothstep(lineDash_period, 2.0 * lineDash_period, lineDash_filterWidth);
    }
  }
#endif
`
    },
    'fs:#main-end': {
      order: 1,
      injection: /* glsl */ `
#ifdef HIGH_PRECISION_DASH
  if (lineDash_valid) {
    if (lineDash_round && !bool(picking.isActive)) {
#ifdef ANTIALIASING
      // The resolved cap and stroke bound the same silhouette. Replace the stroke's coverage
      // with their intersection while preserving the line's opacity and color.
      float strokeCoverage = smoothedge(0.0, edgePixels);
#ifdef LINE_BLUR_ENABLED
      strokeCoverage = lineBlur_fade;
#endif
      if (strokeCoverage > 0.0) {
        lineDash_coverage = min(strokeCoverage, lineDash_coverage) / strokeCoverage;
      }
#endif
      // Unresolved periods still scale the stroke by the dash duty cycle.
      lineDash_coverage = mix(lineDash_coverage, lineDash_duty, lineDash_subPixelBlend);
    }
    if (lineDash_discard || lineDash_coverage <= 0.0) {
      discard;
    }
    fragColor.a *= lineDash_coverage;
  }
#endif
`
    }
  }
});

/**
 * Draws every dash and gap of a `line-dasharray`, as MapLibre GL JS does, on the `PathLayer`s of
 * a layer that also has `PathStyleExtension({dash: true, dashMode: 'path'})`, listed after it.
 * `getDashArray` returns `[period, -(row + 1)]` (see `getDashPatternRow`): it takes no vertex
 * attribute of its own, as a dashed path with offsets has none left. The negative gap turns
 * deck.gl's own dash test off; the pattern's dashes come from a data texture shared by the
 * device's layers. Dashes are box-filtered along the path, and end in semicircles with round
 * caps, so a zero-length dash draws a dot. A gap of 0 or more is drawn by deck.gl as before. WebGL
 * only: on WebGPU, `getDashArray` is replaced by the pattern's total dash and gap lengths.
 */
export class LineDashExtension extends LayerExtension {
  static extensionName = 'LineDashExtension';
  static defaultProps = {
    getDashArray: {type: 'accessor', value: [0, 0]}
  };

  /** Whether this layer can run the pattern shader. */
  isEnabled(layer: Layer): boolean {
    return layer.context.device.type === 'webgl' && 'pathTesselator' in (layer.state || {});
  }

  /** On WebGPU, forward the merged dash and gap to PathStyleExtension. */
  getSubLayerProps(this: CompositeLayer, extension: this) {
    const props: {
      getDashArray?: Accessor<unknown, DashArray>;
      updateTriggers: Record<string, unknown>;
    } = LayerExtension.prototype.getSubLayerProps.call(this, extension);
    const {getDashArray} = props;
    if (this.context.device.type !== 'webgpu' || !getDashArray) {
      return props;
    }
    const decoded: Accessor<unknown, DashArray> =
      typeof getDashArray === 'function'
        ? (object, info) => decodeDashArray(getDashArray(object, info))
        : decodeDashArray(getDashArray);
    return {...props, getDashArray: decoded};
  }

  /** Bind the current device atlas, including rows registered since the last draw. */
  draw(this: Layer, params: unknown, extension: this) {
    if (extension.isEnabled(this)) {
      this.setShaderModuleProps({
        lineDash: {lineDash_patterns: getPatternTexture(this.context.device)}
      });
    }
  }

  /** Install the ordered dash calculations on supported PathLayers. */
  getShaders(this: Layer, extension: this) {
    return extension.isEnabled(this) ? {plugins: [LINE_DASH_PLUGIN]} : {};
  }
}
