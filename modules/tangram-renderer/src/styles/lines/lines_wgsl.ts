// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import Geo from '../../utils/geo';
import {GLOBE_PROJECTION_WGSL, GLOBE_NORMAL_WGSL} from '../../scene/projection_shaders';
import {buildLightingWGSL} from '../../lights/lighting-wgsl';

const LAYER_DELTA = 1 / (1 << 14);
const ATTRIBUTE_SCALE = 1024;

/**
 * Build the portable base-line shader used by the luma.gl WebGPU renderer.
 *
 * Tangram's line builder emits expanded triangle geometry. The extrusion
 * vector and its fractional-zoom scaling are therefore applied before the
 * host-provided tile and camera matrices. Buffered offsets and elevation use
 * the same zoom interpolation and height packing as Tangram's GLSL renderer.
 * Textured and dashed styles sample luma-owned textures using per-mesh state
 * from a std140 uniform block. Animated styles reuse the generated line
 * texture coordinates and Tangram's frame time to produce portable compact
 * repeating vehicles without additive blending. Arbitrary custom shader
 * blocks and selection remain follow-up tranches.
 *
 * @param {object} options Shader options.
 * @param {boolean} options.animated Enables the portable traffic vehicles.
 * @returns {string} Complete WGSL source for the line style.
 */
export function buildLinesWGSL({ animated = false, lighting, lightCount, cpuProjection = false }: {
    /** Enable the existing portable traffic animation. */
    animated?: boolean;
    /** Opt into constant-material surface lighting. */
    lighting?: 'vertex' | 'fragment' | false;
    /** Active scene light count, used to specialize shader compilation. */
    lightCount?: number;
    /** Use worker-projected fixed-meter ribbons; normal line shaders retain dynamic extrusion. */
    cpuProjection?: boolean;
} = {}) {
    const configured = lighting === 'vertex' || lighting === 'fragment';
    const animated_fragment = animated ? `

    let direction = select(-1.0, 1.0, input.texcoord.x < 0.5);
    let lane_phase = select(0.0, 2.75, direction > 0.0);
    // Keep the pattern continuous along the buffered road distance. The
    // derivative-aware body below remains a few pixels long at every zoom
    // instead of collapsing to a sub-pixel flash or stretching into a trail.
    let traffic_coordinate = input.texcoord.y * 0.125 -
        TangramView.u_time * 1.8 * direction + lane_phase;
    let vehicle_position = fract(traffic_coordinate / 6.0);
    let longitudinal_distance = abs(vehicle_position - 0.5);
    let longitudinal_derivative = max(fwidth(vehicle_position), 0.001);
    let vehicle_half_length = max(0.022, longitudinal_derivative * 1.35);
    let vehicle_body = 1.0 - smoothstep(
        vehicle_half_length,
        vehicle_half_length + longitudinal_derivative,
        longitudinal_distance
    );
    let vehicle_halo = 1.0 - smoothstep(
        vehicle_half_length + longitudinal_derivative,
        vehicle_half_length + longitudinal_derivative * 2.5,
        longitudinal_distance
    );
    let lane_center = select(0.72, 0.28, direction > 0.0);
    let lane_distance = abs(input.texcoord.x - lane_center);
    let lane_derivative = max(fwidth(input.texcoord.x), 0.01);
    let lane_half_width = clamp(lane_derivative * 0.45, 0.10, 0.22);
    let lane_edge = clamp(lane_derivative * 0.35, 0.02, 0.18);
    let lane_mask = 1.0 - smoothstep(
        lane_half_width,
        lane_half_width + lane_edge,
        lane_distance
    );
    let vehicle = max(vehicle_body, vehicle_halo * 0.35) * lane_mask;
    let vehicle_color = vec3<f32>(0.62, 1.0, 0.98);
    let animated_color = mix(
        color.rgb,
        vehicle_color,
        vehicle * 0.98
    );
    color = vec4<f32>(animated_color, color.a);
` : '';

    return `
@group(0) @binding(3) var u_texture: texture_2d<f32>;
@group(0) @binding(4) var u_textureSampler: sampler;
${GLOBE_PROJECTION_WGSL}
${configured ? `${GLOBE_NORMAL_WGSL}\n${buildLightingWGSL(lightCount)}` : ''}

struct LineAttributes {
    @location(0) a_position: vec4<i32>,
    @location(1) a_extrude: vec2<i32>,
    @location(2) a_offset: vec2<i32>,
    @location(3) a_z_and_offset_scale: vec2<i32>,
    @location(4) a_texcoord: vec2<f32>,
    @location(5) a_color: vec4<f32>,
    ${cpuProjection ? '@location(6) a_projected_position: vec3<f32>, @location(7) a_projected_stroke: vec4<f32>,' : ''}
};

struct LineVaryings {
    @builtin(position) position: vec4<f32>,
    @location(0) color: vec4<f32>,
    @location(1) texcoord: vec2<f32>,
    @location(5) tile_position: vec2<f32>,
    ${configured ? '@location(2) normal: vec3<f32>, @location(3) eye_position: vec3<f32>, @location(4) lighting: vec4<f32>,' : ''}
};

@vertex
fn vertexMain(attributes: LineAttributes) -> LineVaryings {
    var output: LineVaryings;
    var extrusion = vec2<f32>(attributes.a_extrude);
    var offset = vec2<f32>(attributes.a_offset);

    var zoom_delta = clamp(
        TangramView.u_map_position.z - TangramTile.u_tile_origin.z,
        0.0,
        4.0
    );
    zoom_delta += step(1.0, zoom_delta) * (1.0 - zoom_delta) +
        mix(0.0, 2.0, clamp((zoom_delta - 2.0) / 2.0, 0.0, 1.0));

    let midpoint_zoom_delta = (zoom_delta - 0.5) * 2.0;
    let width_scale = f32(attributes.a_position.z) / ${ATTRIBUTE_SCALE}.0;
    extrusion -= extrusion * width_scale * midpoint_zoom_delta;

    let offset_width_scale =
        f32(attributes.a_z_and_offset_scale.y) / ${ATTRIBUTE_SCALE}.0;
    let offset_scale_direction = sign(step(0.0, offset_width_scale) - 0.5);
    offset -= offset * abs(offset_width_scale) * (
        (1.0 - step(0.0, offset_scale_direction)) -
        (zoom_delta * -offset_scale_direction)
    );

    let screen_space_scale = exp2(
        -zoom_delta - (TangramTile.u_tile_origin.z - TangramTile.u_tile_origin.w)
    );
    extrusion *= screen_space_scale;
    offset *= screen_space_scale;

    let local_position = vec4<f32>(
        vec2<f32>(attributes.a_position.xy) + extrusion + offset,
        f32(attributes.a_z_and_offset_scale.x) / ${Geo.height_scale}.0,
        1.0
    );
    let eye_position = ${cpuProjection ? 'vec4<f32>(attributes.a_projected_position, 1.0)' : 'tangramModelView(local_position)'};
    var clip_position = TangramCamera.u_projection * eye_position;
    ${cpuProjection ? 'clip_position.z = (clip_position.z + clip_position.w) * 0.5;' : ''}
    ${cpuProjection ? `
    if (attributes.a_projected_stroke.w > 0.0) {
        let center = TangramCamera.u_projection * vec4<f32>(attributes.a_projected_stroke.xy, 0.0, 1.0);
        let direction = (clip_position.xy / clip_position.w - center.xy / center.w) * TangramView.u_resolution;
        let magnitude = length(direction);
        let normalized_direction = direction / max(magnitude, 0.000001);
        clip_position.x = center.x + normalized_direction.x * attributes.a_projected_stroke.z *
            TangramView.u_device_pixel_ratio * 2.0 / TangramView.u_resolution.x * center.w;
        clip_position.y = center.y + normalized_direction.y * attributes.a_projected_stroke.z *
            TangramView.u_device_pixel_ratio * 2.0 / TangramView.u_resolution.y * center.w;
    }
    ` : ''}
    let layer = f32(attributes.a_position.w) +
        TangramTile.u_tile_proxy_order_offset + 1.0;
    clip_position.z -= layer * ${cpuProjection ? LAYER_DELTA * 0.5 : LAYER_DELTA} * clip_position.w;

    output.position = clip_position;
    output.tile_position = local_position.xy;
    output.color = attributes.a_color;
    output.texcoord = attributes.a_texcoord / 65535.0;
    output.texcoord.y *= TangramLine.u_v_scale_adjust;
    ${configured ? `
    var normal = normalize(TangramTile.u_normalMatrix * vec3<f32>(0.0, 0.0, 1.0));
    if (TangramView.u_projection_mode == 1) {
        normal = tangramGlobeNormal((TangramTile.u_model * local_position).xyz, vec3<f32>(0.0, 0.0, 1.0));
    }
    output.normal = normal;
    output.eye_position = eye_position.xyz - TangramCamera.u_eye;
    output.lighting = ${lighting === 'vertex' ? 'tangramCalculateLighting(output.eye_position, normal, vec4<f32>(1.0))' : 'vec4<f32>(1.0)'};
    ` : ''}
    return output;
}

@fragment
fn fragmentMain(input: LineVaryings) -> @location(0) vec4<f32> {
    if (TangramTile.u_tile_clip_bounds.z > TangramTile.u_tile_clip_bounds.x &&
        (any(input.tile_position < TangramTile.u_tile_clip_bounds.xy) ||
         any(input.tile_position >= TangramTile.u_tile_clip_bounds.zw))) { discard; }
    var color = input.color;
    if (TangramLine.u_has_line_texture != 0u) {
        let line_texcoord = vec2<f32>(
            input.texcoord.x,
            fract(input.texcoord.y / TangramLine.u_texture_ratio)
        );
        let line_color = textureSample(u_texture, u_textureSampler, line_texcoord);
        let textured_color = color * line_color;
        let dashed_color = mix(
            TangramLine.u_dash_background_color,
            color,
            line_color.a
        );
        color = mix(
            textured_color,
            dashed_color,
            clamp(TangramLine.u_has_dash, 0.0, 1.0)
        );
        if (color.a < 0.001) {
            discard;
        }
    }
${animated_fragment}
    ${lighting === 'fragment' ? 'color = tangramCalculateLighting(input.eye_position, normalize(input.normal), color);' : lighting === 'vertex' ? 'color *= input.lighting;' : ''}
    return color;
}
`;
}
