// Tangram
// SPDX-License-Identifier: MIT
// Copyright (c) 2013-2016 Brett Camper and Mapzen
// Copyright (c) 2026 vis.gl contributors

import type {ShaderModule} from '@luma.gl/shadertools';

/** Reflection-map coordinates, not geographic sphere coordinates. */
const glsl = `
vec2 sphereMap_getUV(vec3 eye_to_point, vec3 normal, vec2 skew) {
    vec3 eye = normalize(eye_to_point);
    eye.xy -= skew;
    eye = normalize(eye);
    vec3 reflected = reflect(eye, normal);
    reflected.z += 1.0;
    return reflected.xy / (2.0 * length(reflected)) + 0.5;
}
`;

/** WGSL equivalent retaining camera-skew and reflection order. */
const wgsl = `
fn sphereMap_getUV(eye_to_point: vec3<f32>, normal: vec3<f32>, skew: vec2<f32>) -> vec2<f32> {
    var eye = normalize(eye_to_point);
    eye = normalize(vec3<f32>(eye.xy - skew, eye.z));
    var reflected = reflect(eye, normal);
    reflected.z += 1.0;
    return reflected.xy / (2.0 * length(reflected)) + 0.5;
}
`;

/**
 * Experimental binding-free sphere-map reflection UVs for luma assemblers.
 * Supply a nonzero camera-to-surface vector and unit surface normal in one frame.
 * Inputs, their intermediate lengths and UVs must be finite. The back-facing
 * reflection pole (0, 0, -1) and a zero post-skew eye are undefined, as in Tangram.
 * This is environment mapping, not equirectangular mapping or GlobeView projection.
 */
export const sphereMap = {name: 'sphereMap', vs: glsl, fs: glsl, source: wgsl} satisfies ShaderModule;
