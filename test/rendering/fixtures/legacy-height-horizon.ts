// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/** Frozen pre-adoption Tangram GLSL; never derive the reference from the new implementation. */
export const LEGACY_HORIZON_GLSL = `
bool tangramGlobeOccluded(vec3 position, float altitude, vec3 eye) {
    vec3 sphere_eye = eye / 256.;
    if (dot(sphere_eye, sphere_eye) <= 1.) { return false; }
    vec3 sphere_position = normalize(position) * (1. + altitude / 6370972.);
    vec3 segment = sphere_position - sphere_eye;
    float segment_length_squared = dot(segment, segment);
    if (segment_length_squared == 0.) { return false; }
    float closest_amount = clamp(-dot(sphere_eye, segment) / segment_length_squared, 0., 1.);
    vec3 closest = mix(sphere_eye, sphere_position, closest_amount);
    return dot(closest, closest) < 1. - 0.000001;
}
`;

/** Frozen pre-adoption Tangram WGSL with the same expression order and tolerance. */
export const LEGACY_HORIZON_WGSL = `
fn tangramGlobeOccluded(position: vec3<f32>, altitude: f32, eye: vec3<f32>) -> bool {
    let sphere_eye = eye / 256.0;
    if (dot(sphere_eye, sphere_eye) <= 1.0) { return false; }
    let sphere_position = normalize(position) * (1.0 + altitude / 6370972.0);
    let segment = sphere_position - sphere_eye;
    let segment_length_squared = dot(segment, segment);
    if (segment_length_squared == 0.0) { return false; }
    let closest_amount = clamp(-dot(sphere_eye, segment) / segment_length_squared, 0.0, 1.0);
    let closest = mix(sphere_eye, sphere_position, closest_amount);
    return dot(closest, closest) < 1.0 - 0.000001;
}
`;

/** Frozen Mapterhorn GLSL decoder; its f32 regrouping is the only permitted height delta. */
export const LEGACY_HEIGHT_GLSL = `
float legacyMapterhornHeight(vec3 rgb) {
    return dot(rgb * 255., vec3(256., 1., 1. / 256.)) - 32768.;
}
`;
