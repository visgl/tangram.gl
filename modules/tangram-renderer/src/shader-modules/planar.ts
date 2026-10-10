// Tangram
// SPDX-License-Identifier: MIT
// Copyright (c) 2013-2016 Brett Camper and Mapzen
// Copyright (c) 2026 vis.gl contributors

import type {ShaderModule} from '@luma.gl/shadertools';

/** Tangram uses one frequency for both world XY coordinates, not anisotropic XY scaling. */
const glsl = `
vec2 planar_getUV(vec3 position, float frequency) { return fract(position.xy * frequency); }
`;

/** WGSL equivalent with explicit wrapping, including negative positions and frequencies. */
const wgsl = `
fn planar_getUV(position: vec3<f32>, frequency: f32) -> vec2<f32> { return fract(position.xy * frequency); }
`;

/**
 * Experimental binding-free planar mapping extracted from Tangram material GLSL.
 * Frequency is repeats per position unit; finite inputs must retain f32 UV precision.
 * Tangram's legacy vec2 scale uses only scale.x: pass that component here.
 * The host owns textures, sampling, filtering and coordinate transforms.
 */
export const planar = {name: 'planar', vs: glsl, fs: glsl, source: wgsl} satisfies ShaderModule;
