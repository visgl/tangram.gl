// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/** Globe surface occlusion for screen-facing anchors, in radius-256 common space. */
export const GLOBE_VISIBILITY_WGSL = `
fn tangramGlobeOccluded(position: vec3<f32>, altitude: f32, eye: vec3<f32>) -> bool {
    // Normalize by the sphere radius to keep the f32 tolerance scale-independent.
    let sphere_eye = eye / 256.0;
    // A missing eye (zero), or an eye inside the sphere, provides no exterior horizon.
    if (dot(sphere_eye, sphere_eye) <= 1.0) {
        return false;
    }
    // Runtime sin/cos approximations can shorten a projected surface vector.
    // Restore its geographic radius instead of interpreting that as burial.
    let sphere_position = normalize(position) * (1.0 + altitude / 6370972.0);
    let segment = sphere_position - sphere_eye;
    let segment_length_squared = dot(segment, segment);
    if (segment_length_squared == 0.0) {
        return false;
    }
    let closest_amount = clamp(-dot(sphere_eye, segment) / segment_length_squared, 0.0, 1.0);
    // Preserve endpoint precision when the camera is far from the sphere.
    let closest = mix(sphere_eye, sphere_position, closest_amount);
    // Only a segment entering the sphere is hidden. Keep tangent/surface anchors
    // visible within a small f32 tolerance; elevated anchors need no height bound.
    return dot(closest, closest) < 1.0 - 0.000001;
}
`;
