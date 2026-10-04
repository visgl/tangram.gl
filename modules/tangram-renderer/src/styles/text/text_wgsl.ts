// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {GLOBE_PROJECTION_WGSL} from '../../scene/projection_shaders';
import {GLOBE_VISIBILITY_WGSL} from '../globe_visibility_wgsl';

const PI = Math.PI;

/**
 * Build the portable standalone-text shader used by the luma.gl WebGPU renderer.
 *
 * Text quads retain Tangram's CPU collision, atlas, and curved-label geometry.
 * The shader applies the buffered screen-space shape and samples the luma-owned
 * atlas texture without reading a backend texture handle.
 *
 * @returns {string} Complete WGSL source for Tangram's text style.
 */
export function buildTextWGSL() {
    return `
@group(0) @binding(3) var u_texture: texture_2d<f32>;
@group(0) @binding(4) var u_textureSampler: sampler;
${GLOBE_PROJECTION_WGSL}
${GLOBE_VISIBILITY_WGSL}

struct TextAttributes {
    @location(0) a_position: vec4<i32>,
    @location(1) a_shape: vec4<i32>,
    @location(2) a_texcoord: vec2<f32>,
    @location(3) a_offset: vec2<i32>,
    @location(4) a_color: vec4<f32>,
    @location(6) a_pre_angles: vec4<i32>,
    @location(7) a_angles: vec4<i32>,
    @location(8) a_offsets: vec4<u32>,
};

struct TextVaryings {
    @builtin(position) position: vec4<f32>,
    @location(0) texcoord: vec2<f32>,
    @location(1) color: vec4<f32>,
};

fn rotate2D(point: vec2<f32>, angle: f32) -> vec2<f32> {
    let cosine = cos(angle);
    let sine = sin(angle);
    return vec2<f32>(
        cosine * point.x - sine * point.y,
        sine * point.x + cosine * point.y
    );
}

fn mix4Linear(values: vec4<f32>, amount: f32) -> f32 {
    let clamped_amount = clamp(amount, 0.0, 1.0);
    let first_segment = mix(values.x, values.y, 3.0 * clamped_amount);
    let last_segment = mix(
        values.z,
        values.w,
        3.0 * (max(clamped_amount, 0.66) - 0.66)
    );
    let remaining_segments = mix(
        values.y,
        last_segment,
        3.0 * (clamp(clamped_amount, 0.33, 0.66) - 0.33)
    );
    return select(first_segment, remaining_segments, clamped_amount >= 0.33);
}

@vertex
fn vertexMain(attributes: TextAttributes) -> TextVaryings {
    var output: TextVaryings;
    output.texcoord = vec2<f32>(
        attributes.a_texcoord.x,
        1.0 - attributes.a_texcoord.y
    );
    output.color = attributes.a_color;

    if (attributes.a_shape.w == 0) {
        output.position = vec4<f32>(2.0, 2.0, 2.0, 1.0);
        return output;
    }

    var shape = vec2<f32>(attributes.a_shape.xy) / 256.0;
    let offset = vec2<f32>(
        f32(attributes.a_offset.x),
        -f32(attributes.a_offset.y)
    );
    let theta = f32(attributes.a_shape.z) / 4096.0;

    if (attributes.a_offsets.x != 0u) {
        let zoom = clamp(
            TangramView.u_map_position.z - TangramTile.u_tile_origin.z,
            0.0,
            1.0
        );
        let pre_angle = mix4Linear(
            vec4<f32>(attributes.a_pre_angles) * (${PI} / 128.0),
            zoom
        );
        let curve_angle = mix4Linear(
            vec4<f32>(attributes.a_angles) * (${PI} / 16384.0),
            zoom
        );
        let curve_offset = mix4Linear(
            vec4<f32>(attributes.a_offsets) / 64.0,
            zoom
        );
        shape = rotate2D(shape, pre_angle);
        shape = vec2<f32>(shape.x + curve_offset, shape.y);
        shape = rotate2D(shape, curve_angle);
        shape += rotate2D(offset, theta);
    }
    else {
        shape = rotate2D(shape + offset, theta);
    }

    let local_position = vec4<f32>(
        f32(attributes.a_position.x),
        f32(attributes.a_position.y),
        f32(attributes.a_position.z),
        1.0
    );
    let projected_position = tangramModelView(local_position);
    if (TangramView.u_projection_mode == 1 && tangramGlobeOccluded(projected_position.xyz,
        (TangramTile.u_model * local_position).z, TangramCamera.u_eye)) {
        output.position = vec4<f32>(2.0, 2.0, 2.0, 1.0);
        return output;
    }
    var clip_position = TangramCamera.u_projection * projected_position;
    let screen_offset = shape * clip_position.w * 2.0 *
        TangramView.u_device_pixel_ratio / TangramView.u_resolution;
    clip_position = vec4<f32>(
        clip_position.xy + screen_offset,
        clip_position.zw
    );

    output.position = clip_position;
    return output;
}

@fragment
fn fragmentMain(input: TextVaryings) -> @location(0) vec4<f32> {
    var atlas_color = textureSample(u_texture, u_textureSampler, input.texcoord);
    return vec4<f32>(
        atlas_color.rgb / max(atlas_color.a, 0.001),
        atlas_color.a
    );
}
`;
}
