// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import type {ShaderModule} from '@luma.gl/shadertools';

/** Decode linear normalized RGB samples; coefficients and offsets define output units. */
const glsl = `
float heightDecode_getHeight(vec3 rgb, vec3 coefficients, float offset) {
    return dot(rgb * 255., coefficients) + offset;
}
float heightDecode_getTerrarium(vec3 rgb) {
    // Subtract the red-channel offset before adding fractional blue elevation.
    return (rgb.r * 255. - 128.) * 256. + rgb.g * 255. + rgb.b * (255. / 256.);
}
float heightDecode_getTerrainRGB(vec3 rgb) {
    return heightDecode_getHeight(rgb, vec3(65536., 256., 1.), 0.) * 0.1 - 10000.;
}
`;

/** WGSL counterpart; sampling, sRGB conversion and no-data policy remain host-owned. */
const wgsl = `
fn heightDecode_getHeight(rgb: vec3<f32>, coefficients: vec3<f32>, offset: f32) -> f32 {
    return dot(rgb * 255.0, coefficients) + offset;
}
fn heightDecode_getTerrarium(rgb: vec3<f32>) -> f32 {
    return (rgb.r * 255.0 - 128.0) * 256.0 + rgb.g * 255.0 + rgb.b * (255.0 / 256.0);
}
fn heightDecode_getTerrainRGB(rgb: vec3<f32>) -> f32 {
    return heightDecode_getHeight(rgb, vec3<f32>(65536.0, 256.0, 1.0), 0.0) * 0.1 - 10000.0;
}
`;

/**
 * Experimental binding-free RGB elevation decoding for normalized linear samples.
 * Terrarium and Terrain-RGB return meters. Custom coefficients apply to byte-valued
 * channels (normalized RGB multiplied by 255); custom output units are host-defined.
 * No rounding, clamping, alpha/no-data interpretation or sampling is performed.
 * Finite inputs are required; f32 precision limits apply, especially at large heights.
 */
export const heightDecode = {name: 'heightDecode', vs: glsl, fs: glsl, source: wgsl} satisfies ShaderModule;
