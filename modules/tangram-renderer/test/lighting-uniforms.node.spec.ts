// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {describe, expect, test} from 'vitest';
import {convertLumaLight, mapTangramLight} from '../src/lights/light-definitions';
import {getPortableLightUniforms, getPortableMaterialUniforms, MAX_PORTABLE_LIGHTS, PORTABLE_LIGHT_UNIFORMS} from '../src/lights/lighting-uniforms';
import {buildLightingWGSL} from '../src/lights/lighting-wgsl';
import {buildLinesWGSL} from '../src/styles/lines/lines_wgsl';
import {buildPolygonsWGSL} from '../src/styles/polygons/polygons_wgsl';

describe('bounded portable lighting uniforms', () => {
    test.each(['ambient', 'directional', 'point', 'spotlight'] as const)('packs legacy %s independently from native falloff', type => {
        const mapping = mapTangramLight({type, ambient: [0.1, 0.2, 0.3], diffuse: [1, 0, 0], specular: [0, 1, 0],
            position: [1, 2, 3], direction: [0, 0, -1], attenuation: 2, radius: [null, 100], angle: 30, exponent: 0.5});
        const uniforms = getPortableLightUniforms([mapping]);
        expect(uniforms.u_light_count).toBe(1);
        expect(uniforms.u_light_0_ambient).toEqual([0.1, 0.2, 0.3, 0]);
        expect(uniforms.u_light_0_position).toEqual([1, 2, 3, ['ambient', 'directional', 'point', 'spotlight'].indexOf(type)]);
        expect(uniforms.u_light_0_falloff).toEqual([2, -1, 100, 0.5]);
        expect(uniforms.u_light_0_coefficients).toEqual([1, 0, 0, 0]);
        for (const name of Object.keys(uniforms)) expect(PORTABLE_LIGHT_UNIFORMS).toHaveProperty(name);
    });

    test('native coefficients and cones survive mixed mappings without changing legacy flags', () => {
        const converted = convertLumaLight({type: 'spot', position: [1, 2, 3], direction: [0, 0, -1],
            color: [255, 255, 255], attenuation: [1, 2, 3], innerConeAngle: 0.1, outerConeAngle: 0.4});
        const mapping = mapTangramLight({type: 'spotlight', ambient: [0, 0, 0], diffuse: [1, 1, 1], specular: [0, 0, 0],
            position: [1, 2, 3], direction: [0, 0, -1]});
        mapping.light = converted.lumaLight;
        const uniforms = getPortableLightUniforms([mapping]);
        expect(uniforms.u_light_0_coefficients).toEqual([1, 2, 3, 1]);
        expect(uniforms.u_light_0_cone).toEqual([Math.cos(0.1), Math.cos(0.4), Math.cos(20 * 3.14159 / 180), 0]);
        expect(uniforms.u_light_0_falloff).toEqual([0, -1, -1, 0]);
    });

    test('empty lists reset count; overflow is rejected without truncation', () => {
        expect(getPortableLightUniforms([])).toEqual({u_light_count: 0});
        const light = mapTangramLight({type: 'ambient', ambient: [1, 1, 1], diffuse: [0, 0, 0], specular: [0, 0, 0]});
        expect(getPortableLightUniforms(Array(MAX_PORTABLE_LIGHTS).fill(light)).u_light_count).toBe(MAX_PORTABLE_LIGHTS);
        expect(() => getPortableLightUniforms(Array(MAX_PORTABLE_LIGHTS + 1).fill(light))).toThrow('at most 16');
        const source = buildLightingWGSL();
        for (let index = 0; index < MAX_PORTABLE_LIGHTS; index++) expect(source).toContain(`case ${index}:`);
    });

    test('specializes compilation to active lights without shrinking the fixed resource layout', () => {
        expect(buildLightingWGSL(1)).toContain('case 0:');
        expect(buildLightingWGSL(1)).not.toContain('case 1:');
        expect(buildLightingWGSL(0)).not.toContain('case 0:');
        for (const count of [-1, 0.5, 17, NaN]) expect(() => buildLightingWGSL(count)).toThrow('visible lights');
    });

    test.each(['vertex', 'fragment', false] as const)('surface builders share configured lighting mode: %s', lighting => {
        for (const source of [buildLinesWGSL({lighting, lightCount: 2}),
            buildPolygonsWGSL({lighting, lightCount: 2}), buildPolygonsWGSL({lighting, lightCount: 2, raster: true})]) {
            if (lighting === false) {
                expect(source).not.toContain('tangramCalculateLighting');
            } else {
                expect(source).toContain('case 1:');
                expect(source).not.toContain('case 2:');
                expect(source).toContain(lighting === 'vertex' ? 'color *= input.lighting' :
                    'tangramCalculateLighting(input.eye_position, normalize(input.normal), color)');
            }
        }
    });
});

describe('portable constant material semantics', () => {
    test('keeps independent RGBA contributions, flags and shininess, without sharing arrays', () => {
        const amount = [0.1, 0.2, 0.3, 0.4];
        const uniforms = getPortableMaterialUniforms({emission: {amount}, ambient: {amount},
            diffuse: {amount}, specular: {amount, shininess: 32}});
        expect(uniforms.u_material_flags).toEqual([1, 1, 1, 1]);
        expect(uniforms.u_material_shininess).toBe(32);
        expect(uniforms.u_material_emission).toEqual(amount);
        expect(uniforms.u_material_emission).not.toBe(amount);
        expect(getPortableMaterialUniforms({}).u_material_flags).toEqual([0, 0, 0, 0]);
        expect(getPortableMaterialUniforms({diffuse: {amount}}).u_material_flags).toEqual([0, 0, 1, 0]);
    });
    test.each(['emission', 'ambient', 'diffuse', 'specular', 'normal'])('rejects unsupported %s textures instead of ignoring them', property => {
        expect(() => getPortableMaterialUniforms({[property]: {texture: 'texture'}})).toThrow('constant materials');
    });
});
