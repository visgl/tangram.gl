// Tangram
// SPDX-License-Identifier: MIT
// Copyright (c) 2013-2016 Brett Camper and Mapzen
// Copyright (c) 2026 vis.gl contributors

import {PROJECTION_CONSTANTS} from './projection_math';

/** Optional physical heights/slopes; identical displacement for color and selection. */
export const TERRAIN_DRAPING_GLSL = `
#ifdef TANGRAM_TERRAIN_DRAPED
attribute vec4 a_terrain;
attribute vec4 a_terrain_previous;
uniform float u_terrain_blend;
uniform float u_terrain_exaggeration;
float tangramTerrainHeight() {
    return mix(a_terrain_previous.x, a_terrain.x, u_terrain_blend) * u_terrain_exaggeration;
}
float tangramTerrainRibbonOffset(vec2 local_offset, vec2 local_position) {
    float northing = u_tile_origin.y + local_position.y * u_model[1][1];
    float latitude_cosine = 2. / (exp(northing / 6378137.) + exp(-northing / 6378137.));
    vec2 slope = mix(a_terrain_previous.yz, a_terrain.yz, u_terrain_blend) * u_terrain_exaggeration;
    return dot(slope, local_offset * vec2(u_model[0][0], u_model[1][1]) * latitude_cosine);
}
vec3 tangramTerrainNormal(vec3 normal) {
    vec2 slope = mix(a_terrain_previous.yz, a_terrain.yz, u_terrain_blend) * u_terrain_exaggeration;
    if (u_projection_mode != 1) {
        float northing = u_tile_origin.y + a_position.y * u_model[1][1];
        float latitude_cosine = 2. / (exp(northing / 6378137.) + exp(-northing / 6378137.));
        // Planar normals are subsequently transformed by the tile normal matrix;
        // globe normals instead consume ENU directly. Do not apply tile scale twice.
        slope *= vec2(u_model[0][0], u_model[1][1]) * latitude_cosine;
    }
    return normalize(vec3(normal.xy - slope * normal.z, normal.z));
}
#endif
`;

/** Portable counterpart with per-mesh temporal interpolation and a GPU-only multiplier. */
export const TERRAIN_DRAPING_WGSL = `
fn tangramTerrainHeight(current: vec4<f32>, previous: vec4<f32>) -> f32 {
    return mix(previous.x, current.x, TangramTile.u_terrain_blend) * TangramTile.u_terrain_exaggeration;
}
fn tangramTerrainRibbonOffset(local_offset: vec2<f32>, local_position: vec2<f32>, current: vec4<f32>, previous: vec4<f32>) -> f32 {
    let northing = TangramTile.u_tile_origin.y + local_position.y * TangramTile.u_model[1][1];
    let latitude_cosine = 2.0 / (exp(northing / 6378137.0) + exp(-northing / 6378137.0));
    let slope = mix(previous.yz, current.yz, TangramTile.u_terrain_blend) * TangramTile.u_terrain_exaggeration;
    return dot(slope, local_offset * vec2<f32>(TangramTile.u_model[0][0], TangramTile.u_model[1][1]) * latitude_cosine);
}
fn tangramTerrainNormal(normal: vec3<f32>, current: vec4<f32>, previous: vec4<f32>, local_position: vec2<f32>) -> vec3<f32> {
    var slope = mix(previous.yz, current.yz, TangramTile.u_terrain_blend) * TangramTile.u_terrain_exaggeration;
    if (TangramView.u_projection_mode != 1) {
        let northing = TangramTile.u_tile_origin.y + local_position.y * TangramTile.u_model[1][1];
        let latitude_cosine = 2.0 / (exp(northing / 6378137.0) + exp(-northing / 6378137.0));
        slope *= vec2<f32>(TangramTile.u_model[0][0], TangramTile.u_model[1][1]) * latitude_cosine;
    }
    return normalize(vec3<f32>(normal.xy - slope * normal.z, normal.z));
}
`;

/** Shared GLSL positions, ENU normals and camera-relative tile path; preserves Tangram block ordering. */
export const GLOBE_PROJECTION_GLSL = `
vec3 tangramGlobePosition(vec3 mercator_position) {
    const float TANGRAM_MERCATOR_RADIUS = ${PROJECTION_CONSTANTS.mercatorRadius}.0;
    const float TANGRAM_GLOBE_EARTH_RADIUS = ${PROJECTION_CONSTANTS.earthRadius}.0;
    const float TANGRAM_GLOBE_RADIUS = ${PROJECTION_CONSTANTS.globeRadius}.0;
    const float TANGRAM_GLOBE_HALF_PI = 1.5707963;
    float longitude = mercator_position.x / TANGRAM_MERCATOR_RADIUS;
    float latitude = 2. * atan(exp(mercator_position.y / TANGRAM_MERCATOR_RADIUS)) - TANGRAM_GLOBE_HALF_PI;
    float radius = (mercator_position.z / TANGRAM_GLOBE_EARTH_RADIUS + 1.) * TANGRAM_GLOBE_RADIUS;
    float latitude_cosine = cos(latitude);
    return vec3(
        sin(longitude) * latitude_cosine,
        -cos(longitude) * latitude_cosine,
        sin(latitude)
    ) * radius;
}

// Rotate east/north/up surface normals into the same globe common space used
// by positions and the host eye. No tile scale or camera is applied.
vec3 tangramGlobeNormal(vec3 mercator_position, vec3 local_normal) {
    const float TANGRAM_NORMAL_MERCATOR_RADIUS = ${PROJECTION_CONSTANTS.mercatorRadius}.0;
    const float TANGRAM_NORMAL_HALF_PI = 1.5707963;
    float longitude = mercator_position.x / TANGRAM_NORMAL_MERCATOR_RADIUS;
    float latitude = 2. * atan(exp(mercator_position.y / TANGRAM_NORMAL_MERCATOR_RADIUS)) - TANGRAM_NORMAL_HALF_PI;
    vec3 east = vec3(cos(longitude), sin(longitude), 0.);
    vec3 north = vec3(-sin(longitude) * sin(latitude), cos(longitude) * sin(latitude), cos(latitude));
    vec3 up = vec3(sin(longitude) * cos(latitude), -cos(longitude) * cos(latitude), sin(latitude));
    return normalize(mat3(east, north, up) * local_normal);
}

vec4 tangramModelView(vec4 local_position, out vec4 world_position) {
    world_position = u_model * local_position;
    if (u_projection_mode == 1) {
        return vec4(tangramGlobePosition(world_position.xyz), 1.);
    }
    return u_modelView * local_position;
}

`;

/** Shared host-projection functions for Tangram's portable WGSL styles. */
export const GLOBE_PROJECTION_WGSL = `
fn tangramGlobePosition(mercator_position: vec3<f32>) -> vec3<f32> {
    let mercator_radius = ${PROJECTION_CONSTANTS.mercatorRadius}.0;
    let earth_radius = ${PROJECTION_CONSTANTS.earthRadius}.0;
    let globe_radius = ${PROJECTION_CONSTANTS.globeRadius}.0;
    let half_pi = 1.5707963267948966;
    let longitude = mercator_position.x / mercator_radius;
    let latitude = 2.0 * atan(exp(mercator_position.y / mercator_radius)) - half_pi;
    let radius = (mercator_position.z / earth_radius + 1.0) * globe_radius;
    let latitude_cosine = cos(latitude);
    return vec3<f32>(
        sin(longitude) * latitude_cosine,
        -cos(longitude) * latitude_cosine,
        sin(latitude)
    ) * radius;
}

fn tangramModelView(local_position: vec4<f32>) -> vec4<f32> {
    if (TangramView.u_projection_mode == 1) {
        let world_position = TangramTile.u_model * local_position;
        return vec4<f32>(
            tangramGlobePosition(world_position.xyz),
            1.0
        );
    }
    return TangramTile.u_modelView * local_position;
}
`;

/** Rotate east/north/up normals into deck-compatible globe common space. */
export const GLOBE_NORMAL_WGSL = `
fn tangramGlobeNormal(mercator_position: vec3<f32>, local_normal: vec3<f32>) -> vec3<f32> {
    let mercator_radius = ${PROJECTION_CONSTANTS.mercatorRadius}.0;
    let half_pi = 1.5707963267948966;
    let longitude = mercator_position.x / mercator_radius;
    let latitude = 2.0 * atan(exp(mercator_position.y / mercator_radius)) - half_pi;
    let east = vec3<f32>(cos(longitude), sin(longitude), 0.0);
    let north = vec3<f32>(-sin(longitude) * sin(latitude), cos(longitude) * sin(latitude), cos(latitude));
    let up = vec3<f32>(sin(longitude) * cos(latitude), -cos(longitude) * cos(latitude), sin(latitude));
    return normalize(mat3x3<f32>(east, north, up) * local_normal);
}
`;
