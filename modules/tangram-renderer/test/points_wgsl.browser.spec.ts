// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {describe, expect, it} from 'vitest';
import {buildPointsWGSL} from '../src/styles/points/points_wgsl';

describe('Point WGSL', function () {
    it('occludes globe anchors per eye before applying screen offsets', function () {
        const source = buildPointsWGSL();
        const condition = 'TangramView.u_projection_mode == 1 && tangramGlobeOccluded(projected_position.xyz,';
        expect(source).toContain(condition);
        expect(source).toContain('(TangramTile.u_model * local_position).z, TangramCamera.u_eye');
        expect(source.indexOf(condition)).toBeLessThan(source.indexOf('let screen_offset'));
        expect(source).toContain('mix(sphere_eye, sphere_position, closest_amount)');
    });

    it('selects point rendering through a buffered attribute', function () {
        const source = buildPointsWGSL();

        expect(source).toContain('@location(8) a_point_type: f32');
        expect(source).toContain('@interpolate(flat) point_type: u32');
        expect(source).toContain('input.point_type == 1u');
        expect(source).toContain('input.point_type == 2u');
        expect(source).toContain('output.point_type == 3u');
        expect(source).not.toContain('u_point_type');
    });

    it('renders textures, atlas labels, and antialiased shader circles', function () {
        const source = buildPointsWGSL();

        expect(source).toContain('@binding(3) var u_texture: texture_2d<f32>');
        expect(source).toContain('textureSampleLevel');
        expect(source).toContain('input.texcoord');
        expect(source).toContain('1.0 - attributes.a_texcoord.y');
        expect(source).toContain('fn antialiasCircle');
        expect(source).toContain('input.outline_edge');
        expect(source).toContain('discard');
    });
});
