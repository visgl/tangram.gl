// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import type {ShaderPass} from '@luma.gl/shaders';

/** The settings of the paper effect. */
export type AntiquePaperProps = {
  /** The amplitude of the per-pixel paper grain, 0 to about 0.1. */
  grain?: number;
  /** The amount of large, soft stains, 0 to about 0.2. */
  stain?: number;
  /** How far colors move toward a sepia tone, 0 to 1. */
  sepia?: number;
  /** How much the corners darken toward brown, 0 to 1. */
  vignette?: number;
};

const fs = /* glsl */ `\
layout(std140) uniform antiquePaperUniforms {
  float grain;
  float stain;
  float sepia;
  float vignette;
} antiquePaper;

float antiquePaper_hash(vec2 p) {
  p = fract(p * vec2(443.897, 441.423));
  p += dot(p, p.yx + 19.19);
  return fract((p.x + p.y) * p.x);
}

float antiquePaper_noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = antiquePaper_hash(i);
  float b = antiquePaper_hash(i + vec2(1.0, 0.0));
  float c = antiquePaper_hash(i + vec2(0.0, 1.0));
  float d = antiquePaper_hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

vec4 antiquePaper_filterColor_ext(vec4 color, vec2 texSize, vec2 texCoord) {
  float luminance = dot(color.rgb, vec3(0.299, 0.587, 0.114));
  vec3 rgb = mix(color.rgb, luminance * vec3(1.07, 0.98, 0.82), antiquePaper.sepia);

  // Stains: soft blotches a few hundred pixels across, fixed to the screen like a printed sheet.
  vec2 sheet = texCoord * texSize / 260.0;
  float blotch = 0.6 * antiquePaper_noise(sheet) + 0.4 * antiquePaper_noise(sheet * 2.3 + 7.0);
  rgb *= 1.0 - antiquePaper.stain * smoothstep(0.45, 0.85, blotch) * vec3(0.8, 1.0, 1.4);

  // Grain: a different value for each pixel.
  rgb += (antiquePaper_hash(floor(texCoord * texSize)) - 0.5) * 2.0 * antiquePaper.grain;

  // Vignette: the corners darken toward a brown tone.
  float edge = smoothstep(0.35, 0.8, distance(texCoord, vec2(0.5)));
  rgb = mix(rgb, rgb * vec3(0.62, 0.5, 0.36), edge * antiquePaper.vignette);
  return vec4(clamp(rgb, 0.0, 1.0), color.a);
}
`;

/**
 * A post-process shader pass for deck.gl's `PostProcessEffect`: a sepia tone, paper grain, soft
 * stains and a vignette over the whole view. WebGL only.
 */
export const antiquePaper = {
  name: 'antiquePaper',
  fs,
  props: {} as AntiquePaperProps,
  uniforms: {} as Required<AntiquePaperProps>,
  uniformTypes: {
    grain: 'f32',
    stain: 'f32',
    sepia: 'f32',
    vignette: 'f32'
  },
  defaultUniforms: {
    grain: 0.02,
    stain: 0.08,
    sepia: 0.25,
    vignette: 0.45
  },
  passes: [{filter: true}]
} as const satisfies ShaderPass<AntiquePaperProps, AntiquePaperProps>;

/** The default settings: light, as the old look comes mostly from the palette. */
export const DEFAULT_PAPER_PROPS: Required<AntiquePaperProps> = {...antiquePaper.defaultUniforms};
