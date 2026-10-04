// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/** Polynomial attenuation shared by GLSL/WGSL, matching luma.gl's native point-light denominator. */
const DISTANCE_DENOMINATOR = 'coefficients.x + coefficients.y * distance + coefficients.z * distance * distance';

/** Shared native cone transition; Tangram defines the otherwise undefined equal-cone limit explicitly. */
const CONE_TRANSITION = 'smoothstep(cone.y, cone.x, cosine)';

/**
 * Native light calculations, independent of Tangram's color/material accumulators.
 * The 0.0001 floor and outside-cone contribution retain the existing luma-compatible behavior.
 * Legacy radius/exponent falloff remains a separate multiplier, not a substitute for native attenuation.
 */
export function buildNativeFalloff(language: 'glsl' | 'wgsl'): string {
    if (language === 'glsl') return `
float tangramNativeDistanceDenominator(vec3 coefficients, float distance) {
    return max(${DISTANCE_DENOMINATOR}, 0.0001);
}
float tangramNativeConeFactor(vec2 cone, float cosine) {
    float factor = cone.x == cone.y ? step(cone.y, cosine) : ${CONE_TRANSITION};
    return max(factor, 0.0001);
}
`;
    return `
fn tangramNativeDistanceDenominator(coefficients: vec3<f32>, distance: f32) -> f32 {
    return max(${DISTANCE_DENOMINATOR}, 0.0001);
}
fn tangramNativeConeFactor(cone: vec2<f32>, cosine: f32) -> f32 {
    var factor: f32;
    if (cone.x == cone.y) { factor = step(cone.y, cosine); }
    else { factor = ${CONE_TRANSITION}; }
    return max(factor, 0.0001);
}
`;
}
