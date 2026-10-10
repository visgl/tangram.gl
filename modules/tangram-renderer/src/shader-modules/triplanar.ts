// Tangram
// SPDX-License-Identifier: MIT
// Copyright (c) 2013-2016 Brett Camper and Mapzen
// Copyright (c) 2026 vis.gl contributors

import type {ShaderModule} from '@luma.gl/shadertools';

/** Binding-free helpers extracted from lights/material.glsl; axis scales are UV frequencies. */
const glsl = `
vec3 triplanar_getWeights(vec3 normal) {
    vec3 weights = normalize(max(abs(normal), vec3(0.00001)));
    return weights / (weights.x + weights.y + weights.z);
}
vec2 triplanar_getUVX(vec3 position, vec3 scale) { return fract(position.yz * scale.x); }
vec2 triplanar_getUVY(vec3 position, vec3 scale) { return fract(position.xz * scale.y); }
vec2 triplanar_getUVZ(vec3 position, vec3 scale) { return fract(position.xy * scale.z); }
vec4 triplanar_blend(vec4 sample_x, vec4 sample_y, vec4 sample_z, vec3 weights) {
    return sample_x * weights.x + sample_y * weights.y + sample_z * weights.z;
}
`;

/** WGSL equivalent; callers sample their own textures before blending. */
const wgsl = `
fn triplanar_getWeights(normal: vec3<f32>) -> vec3<f32> {
    let weights = normalize(max(abs(normal), vec3<f32>(0.00001)));
    return weights / (weights.x + weights.y + weights.z);
}
fn triplanar_getUVX(position: vec3<f32>, scale: vec3<f32>) -> vec2<f32> { return fract(position.yz * scale.x); }
fn triplanar_getUVY(position: vec3<f32>, scale: vec3<f32>) -> vec2<f32> { return fract(position.xz * scale.y); }
fn triplanar_getUVZ(position: vec3<f32>, scale: vec3<f32>) -> vec2<f32> { return fract(position.xy * scale.z); }
fn triplanar_blend(sample_x: vec4<f32>, sample_y: vec4<f32>, sample_z: vec4<f32>, weights: vec3<f32>) -> vec4<f32> {
    return sample_x * weights.x + sample_y * weights.y + sample_z * weights.z;
}
`;

/**
 * Experimental Tangram-compatible triplanar UVs and RGBA blending for luma assemblers.
 * Inputs must be finite and small enough for f32 normalization and UV precision.
 * Normal components have a 1e-5 floor; a zero normal gives equal weights.
 * Position and normal share a coordinate frame. Each scale component multiplies
 * both UV coordinates of its projection plane, including negative frequencies.
 * No sign-dependent UV mirroring or tangent-space normal reorientation is applied.
 * Hosts own texture bindings, sampling, derivatives, color space and normal maps.
 */
export const triplanar = {name: 'triplanar', vs: glsl, fs: glsl, source: wgsl} satisfies ShaderModule;
