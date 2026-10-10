// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import type {ShaderModule} from '@luma.gl/shadertools';

/** Projection-independent finite-difference normals and directional hillshading. */
const glsl = `
// Heights are west, east, south, north, in the same linear units as spacing.
// Positive local X is east, positive Y is north, and positive Z is up.
vec3 hillshade_getNormal(vec4 heights, vec2 spacing) {
    vec2 safe_spacing = max(abs(spacing), vec2(0.000001));
    vec2 gradient = vec2(heights.x - heights.y, heights.z - heights.w) / (2. * safe_spacing);
    return normalize(vec3(gradient, 1.));
}

// Light direction points from the surface towards the light in the same local frame.
float hillshade_getIntensity(vec3 normal, vec3 light_direction, float ambient) {
    vec3 unit_normal = normal / max(length(normal), 0.000001);
    vec3 unit_light = light_direction / max(length(light_direction), 0.000001);
    float diffuse = clamp(dot(unit_normal, unit_light), 0., 1.);
    float base = clamp(ambient, 0., 1.);
    return base + (1. - base) * diffuse;
}
`;

/** WGSL equivalent of the GLSL helpers, with no bindings or implicit coordinate conversion. */
const wgsl = `
// Heights: west, east, south, north. Local axes: east, north, up.
fn hillshade_getNormal(heights: vec4<f32>, spacing: vec2<f32>) -> vec3<f32> {
    let safe_spacing = max(abs(spacing), vec2<f32>(0.000001));
    let gradient = vec2<f32>(heights.x - heights.y, heights.z - heights.w) / (2.0 * safe_spacing);
    return normalize(vec3<f32>(gradient, 1.0));
}

fn hillshade_getIntensity(normal: vec3<f32>, light_direction: vec3<f32>, ambient: f32) -> f32 {
    let unit_normal = normal / max(length(normal), 0.000001);
    let unit_light = light_direction / max(length(light_direction), 0.000001);
    let diffuse = clamp(dot(unit_normal, unit_light), 0.0, 1.0);
    let base = clamp(ambient, 0.0, 1.0);
    return base + (1.0 - base) * diffuse;
}
`;

/**
 * Experimental luma.gl ShaderModule with provider-independent hillshade functions.
 * Hosts supply decoded, finite heights, positive finite neighbor spacing, and a
 * local-frame light vector. Sampling, no-data handling, seam stitching, coordinate
 * transforms, vertical exaggeration and color composition stay with the host.
 * No uniforms, samplers, injection hooks, or runtime dependencies are introduced.
 */
export const hillshade = {
    name: 'hillshade',
    vs: glsl,
    fs: glsl,
    source: wgsl
} satisfies ShaderModule;
