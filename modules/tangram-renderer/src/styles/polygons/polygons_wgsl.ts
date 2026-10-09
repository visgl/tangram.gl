// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import Geo from '../../utils/geo';
import {GLOBE_PROJECTION_WGSL, GLOBE_NORMAL_WGSL} from '../../scene/projection_shaders';
import {buildLightingWGSL} from '../../lights/lighting-wgsl';

const LAYER_DELTA = 1 / (1 << 14);

/**
 * Build the portable polygon shader used by the luma.gl WebGPU renderer.
 *
 * Tangram's existing GLSL shader composer remains authoritative for WebGL.
 * This deliberately small WGSL program establishes the native-device path for
 * flat polygons and raster tiles before the remaining style features are ported.
 */
export function buildPolygonsWGSL({ raster = false, lighting, lightCount, cpuProjection = false, selection = false }: {
    /** Emit the worker selection key without lighting or color blending. */
    selection?: boolean;
    /** Include raster color sampling. */
    raster?: boolean;
    /** Opt into configured lights; undefined retains historical portable wall shading. */
    lighting?: 'vertex' | 'fragment' | false;
    /** Active scene light count, used to specialize shader compilation. */
    lightCount?: number;
    /** Use worker-projected common positions while retaining tile-local UVs. */
    cpuProjection?: boolean;
} = {}) {
    const raster_declarations = raster ? `
@group(0) @binding(3) var u_rasters: texture_2d<f32>;
@group(0) @binding(4) var u_rastersSampler: sampler;
` : '';
    const raster_fragment = raster ? `
    // Tangram's raster images are uploaded without a WebGL Y flip on WebGPU,
    // so use top-left texture coordinates for the tile-local geometry.
    let raster_color = textureSample(u_rasters, u_rastersSampler, input.raster_uv);
    var color = input.color * raster_color;
` : '    var color = input.color;\n';
    const configured = lighting === 'vertex' || lighting === 'fragment';
    const shade = lighting === 'fragment' ? 'color = tangramCalculateLighting(input.eye_position, normalize(input.normal), color);' :
        lighting === 'vertex' ? 'color *= input.lighting;' : '';

    return `
${raster_declarations}
${GLOBE_PROJECTION_WGSL}
${GLOBE_NORMAL_WGSL}
${configured ? buildLightingWGSL(lightCount) : ''}
struct PolygonAttributes {
    @location(0) a_position: vec4<i32>,
    @location(1) a_normal: vec4<f32>,
    @location(2) a_color: vec4<f32>,
    ${selection ? '@location(5) a_selection_color: vec4<f32>,' : ''}
    ${cpuProjection ? '@location(3) a_projected_position: vec3<f32>, @location(4) a_projected_normal: vec3<f32>,' : ''}
};

struct PolygonVaryings {
    @builtin(position) position: vec4<f32>,
    @location(0) color: vec4<f32>,
    @location(1) raster_uv: vec2<f32>,
    @location(2) normal: vec3<f32>,
    @location(3) eye_position: vec3<f32>,
    @location(4) lighting: vec4<f32>,
    @location(5) tile_position: vec2<f32>,
    ${selection ? '@location(6) @interpolate(flat) selection_color: vec4<f32>,' : ''}
};

@vertex
fn vertexMain(attributes: PolygonAttributes) -> PolygonVaryings {
    var output: PolygonVaryings;
    ${selection ? 'output.selection_color = attributes.a_selection_color;' : ''}
    let local_position = vec4<f32>(
        f32(attributes.a_position.x),
        f32(attributes.a_position.y),
        f32(attributes.a_position.z) / ${Geo.height_scale}.0,
        1.0
    );
    let eye_position = ${cpuProjection ? 'vec4<f32>(attributes.a_projected_position, 1.0)' : 'tangramModelView(local_position)'};
    var clip_position = TangramCamera.u_projection * eye_position;
    ${cpuProjection ? '// deck orthographic matrices use WebGL [-w, w] depth; WebGPU requires [0, w].\n    clip_position.z = (clip_position.z + clip_position.w) * 0.5;' : ''}
    let layer = f32(attributes.a_position.w) +
        TangramTile.u_tile_proxy_order_offset + 1.0;
    clip_position.z -= layer * ${cpuProjection ? LAYER_DELTA * 0.5 : LAYER_DELTA} * clip_position.w;

    var surface_normal = normalize(attributes.a_normal.xyz);
    if (TangramView.u_projection_mode == 1) {
        let world_position = TangramTile.u_model * local_position;
        surface_normal = tangramGlobeNormal(world_position.xyz, surface_normal);
    }
    ${configured ? `else { surface_normal = normalize(TangramTile.u_normalMatrix * surface_normal); }` : ''}
    ${cpuProjection ? 'surface_normal = normalize(attributes.a_projected_normal);' : ''}
    let light_direction = normalize(vec3<f32>(0.35, -0.45, 0.82));
    let diffuse = max(dot(surface_normal, light_direction), 0.0);
    // Roof/wall classification stays local; geographic north is not surface up.
    let side_amount = 1.0 - smoothstep(0.8, 0.98, abs(normalize(attributes.a_normal.xyz).z));
    let light = mix(1.0, 0.58 + 0.52 * diffuse, side_amount);

    output.position = clip_position;
    output.tile_position = local_position.xy;
    output.normal = surface_normal;
    output.eye_position = eye_position.xyz - TangramCamera.u_eye;
    output.lighting = ${lighting === 'vertex' ? 'tangramCalculateLighting(output.eye_position, surface_normal, vec4<f32>(1.0))' : 'vec4<f32>(1.0)'};
    output.color = ${lighting === undefined ? 'vec4<f32>(attributes.a_color.rgb * light, attributes.a_color.a)' : 'attributes.a_color'};
    output.raster_uv = vec2<f32>(
        f32(attributes.a_position.x) / ${Geo.tile_scale}.0,
        -f32(attributes.a_position.y) / ${Geo.tile_scale}.0
    );
    return output;
}

@fragment
fn fragmentMain(input: PolygonVaryings) -> @location(0) vec4<f32> {
    if (TangramTile.u_tile_clip_bounds.z > TangramTile.u_tile_clip_bounds.x &&
        (any(input.tile_position < TangramTile.u_tile_clip_bounds.xy) ||
         any(input.tile_position >= TangramTile.u_tile_clip_bounds.zw))) { discard; }
${raster_fragment}
    ${shade}
    return ${selection ? 'input.selection_color' : 'color'};
}
`;
}
