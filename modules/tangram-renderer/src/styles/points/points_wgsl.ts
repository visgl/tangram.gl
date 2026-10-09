// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {GLOBE_PROJECTION_WGSL} from '../../scene/projection_shaders';
import {GLOBE_VISIBILITY_WGSL} from '../globe_visibility_wgsl';

/**
 * Build the portable point shader used by the luma.gl WebGPU renderer.
 *
 * One buffered point-type attribute selects sprite, attached-label, or shader
 * circle rendering without scalar WebGL uniforms. All point variants share an
 * all-buffered vertex layout so WebGPU never depends on constant attributes.
 *
 * @param cpuProjection Use preprojected ground anchors while retaining screen-space billboard shapes.
 * @returns {string} Complete WGSL source for Tangram's point style.
 */
export function buildPointsWGSL(cpuProjection = false) {
    return `
@group(0) @binding(3) var u_texture: texture_2d<f32>;
@group(0) @binding(4) var u_textureSampler: sampler;
${GLOBE_PROJECTION_WGSL}
${GLOBE_VISIBILITY_WGSL}

struct PointAttributes {
    @location(0) a_position: vec4<i32>,
    @location(1) a_shape: vec4<i32>,
    @location(2) a_texcoord: vec2<f32>,
    @location(3) a_offset: vec2<i32>,
    @location(4) a_color: vec4<f32>,
    @location(6) a_outline_color: vec4<f32>,
    @location(7) a_outline_edge: f32,
    @location(8) a_point_type: f32,
    ${cpuProjection ? '@location(9) a_projected_position: vec3<f32>,' : ''}
};

struct PointVaryings {
    @builtin(position) position: vec4<f32>,
    @location(0) texcoord: vec2<f32>,
    @location(1) color: vec4<f32>,
    @location(2) outline_color: vec4<f32>,
    @location(3) outline_edge: f32,
    @location(4) aa_offset: f32,
    @location(5) @interpolate(flat) point_type: u32,
};

fn rotate2D(point: vec2<f32>, angle: f32) -> vec2<f32> {
    let cosine = cos(angle);
    let sine = sin(angle);
    return vec2<f32>(
        cosine * point.x - sine * point.y,
        sine * point.x + cosine * point.y
    );
}

fn antialiasCircle(distance: f32, radius: f32, offset: f32) -> f32 {
    return 1.0 - smoothstep(radius - offset, radius + offset, distance);
}

@vertex
fn vertexMain(attributes: PointAttributes) -> PointVaryings {
    var output: PointVaryings;
    output.color = attributes.a_color;
    output.outline_color = attributes.a_outline_color;
    output.outline_edge = attributes.a_outline_edge;
    output.point_type = u32(round(attributes.a_point_type));
    output.aa_offset = 0.0;
    output.texcoord = vec2<f32>(
        attributes.a_texcoord.x,
        1.0 - attributes.a_texcoord.y
    );

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

    if (output.point_type == 3u) {
        let point_size = max(abs(f32(attributes.a_shape.x)) / 128.0, 1.0);
        output.texcoord = sign(vec2<f32>(attributes.a_shape.xy)) *
            ((point_size + 1.0) / point_size);
        output.aa_offset = 2.0 / (point_size + 2.0);
    }

    shape = rotate2D(shape + offset, theta);
    let local_position = vec4<f32>(
        f32(attributes.a_position.x),
        f32(attributes.a_position.y),
        f32(attributes.a_position.z),
        1.0
    );
    let projected_position = ${cpuProjection ? 'vec4<f32>(attributes.a_projected_position, 1.0)' : 'tangramModelView(local_position)'};
    if (TangramView.u_projection_mode == 1 && tangramGlobeOccluded(projected_position.xyz,
        (TangramTile.u_model * local_position).z, TangramCamera.u_eye)) {
        output.position = vec4<f32>(2.0, 2.0, 2.0, 1.0);
        return output;
    }
    var clip_position = TangramCamera.u_projection * projected_position;
    ${cpuProjection ? 'clip_position.z = (clip_position.z + clip_position.w) * 0.5;' : ''}
    let screen_offset = shape * clip_position.w * 2.0 *
        TangramView.u_device_pixel_ratio / TangramView.u_resolution;
    clip_position = vec4<f32>(
        clip_position.xy + screen_offset,
        clip_position.zw
    );

    if (output.point_type == 3u) {
        let antialias_offset = sign(shape) * clip_position.w *
            TangramView.u_device_pixel_ratio / TangramView.u_resolution;
        clip_position = vec4<f32>(
            clip_position.xy + antialias_offset,
            clip_position.zw
        );
    }

    output.position = clip_position;
    return output;
}

@fragment
fn fragmentMain(input: PointVaryings) -> @location(0) vec4<f32> {
    var color = input.color;

    if (input.point_type == 1u) {
        color *= textureSampleLevel(
            u_texture,
            u_textureSampler,
            input.texcoord,
            0.0
        );
    }
    else if (input.point_type == 2u) {
        let atlas_color = textureSampleLevel(
            u_texture,
            u_textureSampler,
            input.texcoord,
            0.0
        );
        color = vec4<f32>(
            atlas_color.rgb / max(atlas_color.a, 0.001),
            atlas_color.a
        );
    }
    else {
        let distance = length(input.texcoord);
        let outer_alpha = antialiasCircle(distance, 1.0, input.aa_offset);
        let fill_alpha = antialiasCircle(
            distance,
            1.0 - input.outline_edge * 0.5,
            input.aa_offset
        ) * color.a;
        let stroke_alpha = max(
            outer_alpha - antialiasCircle(
                distance,
                1.0 - input.outline_edge,
                input.aa_offset
            ),
            0.0
        ) * input.outline_color.a;
        let composed_alpha = stroke_alpha + fill_alpha * (1.0 - stroke_alpha);
        let composed_rgb = mix(
            color.rgb * fill_alpha,
            input.outline_color.rgb,
            stroke_alpha
        ) / max(composed_alpha, 0.001);
        color = vec4<f32>(composed_rgb, composed_alpha);
    }

    if (color.a < 0.001) {
        discard;
    }
    return color;
}
`;
}
