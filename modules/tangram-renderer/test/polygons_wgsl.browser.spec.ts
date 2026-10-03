// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {describe, expect, it} from 'vitest';
import { buildPolygonsWGSL } from '../src/styles/polygons/polygons_wgsl';

describe('Polygon WGSL', function () {
    it('builds a vector-color shader with Tangram camera and tile blocks', function () {
        const source = buildPolygonsWGSL();

        expect(source).toContain('@location(0) a_position: vec4<i32>');
        expect(source).toContain('@location(1) a_normal: vec4<f32>');
        expect(source).toContain('@location(2) a_color: vec4<f32>');
        expect(source).toContain('TangramCamera.u_projection');
        expect(source).toContain('TangramTile.u_modelView * local_position');
        expect(source).toContain('TangramView.u_projection_mode == 1');
        expect(source).toContain('tangramGlobePosition');
        expect(source).toContain('var surface_normal = normalize(attributes.a_normal.xyz)');
        expect(source).toContain('surface_normal = tangramGlobeNormal(world_position.xyz, surface_normal)');
        expect(source).toContain('abs(normalize(attributes.a_normal.xyz).z)');
        expect(source).toContain('let side_amount = 1.0 - smoothstep');
        expect(source).toContain('var color = input.color;');
        expect(source).toContain('return color;');
        expect(source).not.toContain('tangramCalculateLighting');
        expect(source).not.toContain('var u_rasters: texture_2d<f32>');
    });

    it('builds a raster shader with portable texture and sampler bindings', function () {
        const source = buildPolygonsWGSL({ raster: true });

        expect(source).toContain('@binding(3) var u_rasters: texture_2d<f32>');
        expect(source).toContain('@binding(4) var u_rastersSampler: sampler');
        expect(source).toContain('textureSample(u_rasters, u_rastersSampler, input.raster_uv)');
        expect(source).toContain('-f32(attributes.a_position.y)');
    });
});
