// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/** Rotate east/north/up normals into deck-compatible globe common space. */
export const GLOBE_NORMAL_WGSL = `
fn tangramGlobeNormal(mercator_position: vec3<f32>, local_normal: vec3<f32>) -> vec3<f32> {
    let mercator_radius = 6378137.0;
    let half_pi = 1.5707963267948966;
    let longitude = mercator_position.x / mercator_radius;
    let latitude = 2.0 * atan(exp(mercator_position.y / mercator_radius)) - half_pi;
    let east = vec3<f32>(cos(longitude), sin(longitude), 0.0);
    let north = vec3<f32>(-sin(longitude) * sin(latitude), cos(longitude) * sin(latitude), cos(latitude));
    let up = vec3<f32>(sin(longitude) * cos(latitude), -cos(longitude) * cos(latitude), sin(latitude));
    return normalize(mat3x3<f32>(east, north, up) * local_normal);
}
`;
