// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {describe, expect, it} from 'vitest';
import {buildTextWGSL} from '../src/styles/text/text_wgsl';

describe('Text WGSL', function () {
    it('occludes globe anchors per eye without changing planar text offsets', function () {
        const source = buildTextWGSL();
        const condition = 'TangramView.u_projection_mode == 1 && tangramGlobeOccluded(projected_position.xyz,';
        expect(source).toContain(condition);
        expect(source).toContain('(TangramTile.u_model * local_position).z, TangramCamera.u_eye');
        expect(source.indexOf(condition)).toBeLessThan(source.indexOf('var clip_position'));
        expect(source).toContain('dot(sphere_eye, sphere_eye) <= 1.0');
    });

    it('builds screen-space text quads with a portable atlas binding', function () {
        const source = buildTextWGSL();

        expect(source).toContain('@location(0) a_position: vec4<i32>');
        expect(source).toContain('@location(1) a_shape: vec4<i32>');
        expect(source).toContain('@location(2) a_texcoord: vec2<f32>');
        expect(source).toContain('@location(6) a_pre_angles: vec4<i32>');
        expect(source).toContain('TangramView.u_device_pixel_ratio');
        expect(source).toContain('TangramTile.u_modelView * local_position');
        expect(source).toContain('@binding(3) var u_texture: texture_2d<f32>');
        expect(source).toContain('textureSample(u_texture, u_textureSampler');
        expect(source).toContain('1.0 - attributes.a_texcoord.y');
        expect(source).not.toContain('clip_position.xy +=');
        expect(source).not.toContain('atlas_color.rgb /=');
    });

    it('keeps curved label interpolation in the portable shader', function () {
        const source = buildTextWGSL();

        expect(source).toContain('fn mix4Linear');
        expect(source).toContain('attributes.a_offsets.x != 0u');
        expect(source).toContain('TangramView.u_map_position.z');
        expect(source).toContain('curve_offset');
    });
});
