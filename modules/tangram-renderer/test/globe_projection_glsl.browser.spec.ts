// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {describe, expect, it} from 'vitest';
import pointsVertexShader from '../src/styles/points/points_vertex.glsl';
import polygonsVertexShader from '../src/styles/polygons/polygons_vertex.glsl';
import {GLOBE_PROJECTION_GLSL} from '../src/scene/projection_shaders';
import {Polygons} from '../src/styles/polygons/polygons';
import {Points} from '../src/styles/points/points';
import {Lines} from '../src/styles/lines/lines';
import {TextStyle} from '../src/styles/text/text';
import {GLOBE_VISIBILITY_GLSL} from '../src/styles/globe_visibility_wgsl';
import {globeHorizon} from '../src/shader-modules/globe-horizon';

describe('Globe projection GLSL', function () {
    it('shares horizon helpers once in point, text and inherited selection vertices', () => {
        for (const style of [Points, TextStyle]) {
            const source: unknown = Reflect.get(style, 'vertex_shader_src');
            if (typeof source !== 'string') throw new Error('Missing annotation vertex shader');
            expect(source).toContain(GLOBE_VISIBILITY_GLSL);
            expect(source).toContain(globeHorizon.vs);
            expect(source).not.toContain('#pragma tangram: globe_visibility');
            expect(source.match(/bool globeHorizon_isOccluded\(/g)).toHaveLength(1);
            expect(source.match(/bool tangramGlobeOccluded\(/g)).toHaveLength(1);
        }
    });
    it('assembles projection for polygon, line and point consumers before compiling', () => {
        for (const style of [Polygons, Lines, Points]) {
            expect(style.vertex_shader_src).toContain(GLOBE_PROJECTION_GLSL);
            expect(style.vertex_shader_src).not.toContain('#pragma tangram: projection');
            expect(style.vertex_shader_src.match(/vec3 tangramGlobePosition\(/g)).toHaveLength(1);
        }
    });
    it('names helper constants defensively against scene-global macros', function () {
        for (const source of [pointsVertexShader, polygonsVertexShader]) {
            expect(source).not.toMatch(/\bconst float HALF_PI\b/);
            expect(source).toContain('#pragma tangram: projection');
        }
        expect(GLOBE_PROJECTION_GLSL).toContain('const float TANGRAM_GLOBE_HALF_PI');
        expect(GLOBE_PROJECTION_GLSL).toContain('const float TANGRAM_MERCATOR_RADIUS');
        expect(GLOBE_PROJECTION_GLSL).not.toMatch(/\bconst float HALF_PI\b/);
    });
});
