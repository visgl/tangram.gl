// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import type {ShaderModule} from '@luma.gl/shadertools';

/** Adapt Tangram's globe anchor and segment test to an explicit sphere radius. */
const glsl = `
vec3 globeHorizon_getAnchor(vec3 direction, float altitude, float radius, float earthRadius) {
    return normalize(direction) * radius * (1. + altitude / earthRadius);
}
bool globeHorizon_isOccluded(vec3 position, vec3 eye, float radius) {
    vec3 sphere_eye = eye / radius;
    if (dot(sphere_eye, sphere_eye) <= 1.) { return false; }
    vec3 sphere_position = position / radius;
    vec3 segment = sphere_position - sphere_eye;
    float segment_length_squared = dot(segment, segment);
    if (segment_length_squared == 0.) { return false; }
    float closest_amount = clamp(-dot(sphere_eye, segment) / segment_length_squared, 0., 1.);
    vec3 closest = mix(sphere_eye, sphere_position, closest_amount);
    return dot(closest, closest) < 1. - 0.000001;
}
`;

/** Same radius-normalized segment test and surface tolerance as Tangram's WGSL. */
const wgsl = `
fn globeHorizon_getAnchor(direction: vec3<f32>, altitude: f32, radius: f32, earthRadius: f32) -> vec3<f32> {
    return normalize(direction) * radius * (1.0 + altitude / earthRadius);
}
fn globeHorizon_isOccluded(position: vec3<f32>, eye: vec3<f32>, radius: f32) -> bool {
    let sphere_eye = eye / radius;
    if (dot(sphere_eye, sphere_eye) <= 1.0) { return false; }
    let sphere_position = position / radius;
    let segment = sphere_position - sphere_eye;
    let segment_length_squared = dot(segment, segment);
    if (segment_length_squared == 0.0) { return false; }
    let closest_amount = clamp(-dot(sphere_eye, segment) / segment_length_squared, 0.0, 1.0);
    let closest = mix(sphere_eye, sphere_position, closest_amount);
    return dot(closest, closest) < 1.0 - 0.000001;
}
`;

/**
 * Experimental binding-free sphere horizon occlusion adapted from Tangram label shaders.
 * Position and eye are center-relative in the same orthonormal frame and linear units;
 * radius must be positive. Missing/interior eyes have no exterior horizon (false).
 * The finite eye-to-position segment, not an infinite ray, must enter the sphere by
 * more than the squared-unit-radius 1e-6 tolerance. Elevated anchors are supported.
 * getAnchor restores a nonzero direction's geographic radius using altitude and a
 * positive earthRadius in identical units. Finite, f32-representable inputs required.
 */
export const globeHorizon = {name: 'globeHorizon', vs: glsl, fs: glsl, source: wgsl} satisfies ShaderModule;
