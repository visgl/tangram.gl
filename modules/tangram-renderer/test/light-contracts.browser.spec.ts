// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {afterEach, describe, expect, test, vi} from 'vitest';
import {Matrix4} from '@math.gl/core';
import Light from '../src/lights/light';
import type {LightConfig, LightView} from '../src/lights/light';
import Geo from '../src/utils/geo';
import ShaderProgram from '../src/gl/shader_program';

/** Minimal camera contract; lighting does not require a scene or deck viewport. */
function createView(): LightView {
    return {zoom: 10, camera: {view_matrix: new Matrix4(), position_meters: [10, 20, 30]}};
}

const originalEnabled = Light.enabled;
afterEach(() => {
    Light.enabled = originalEnabled;
    vi.restoreAllMocks();
});

describe('checked lighting runtime preserves legacy contracts', () => {
    test.each([
        [undefined, true, true, false],
        [null, true, true, false],
        [true, true, true, false],
        ['fragment', true, true, false],
        ['vertex', true, false, true],
        [false, true, false, false],
        ['unknown', true, false, false],
        ['vertex', false, false, false],
        ['fragment', false, false, false]
    ] as const)('mode=%s enabled=%s keeps shader selection', (mode, enabled, fragment, vertex) => {
        Light.enabled = enabled;
        const style = {defines: {}};
        Light.setMode(mode, style);
        expect(style.defines).toEqual({TANGRAM_LIGHTING_FRAGMENT: fragment, TANGRAM_LIGHTING_VERTEX: vertex});
    });

    test('unknown factories stay optional and custom constructors remain registrable', () => {
        expect(Light.create(createView(), {name: 'missing', type: 'missing'})).toBeUndefined();
        /** A checked third-party shader kind must remain assignable to the registry. */
        class CustomLight extends Light {
            /** Retain a custom discriminator for shader composition, not luma conversion. */
            constructor(view: LightView, config: LightConfig) {
                super(view, config);
                this.type = 'custom';
                this.struct_name = 'CustomLight';
            }
            /** Supply the custom shader struct through the normal registration hook. */
            static inject() {}
        }
        const original = Light.types.custom;
        const originalDefines = {...ShaderProgram.defines};
        const inject = vi.spyOn(CustomLight, 'inject');
        vi.spyOn(ShaderProgram, 'removeBlock').mockImplementation(() => {});
        const addBlock = vi.spyOn(ShaderProgram, 'addBlock').mockImplementation(() => {});
        Light.types.custom = CustomLight;
        try {
            const custom = Light.create(createView(), {name: 'custom', type: 'custom'});
            if (!custom) throw new Error('Expected registered custom light');
            expect(custom).toBeInstanceOf(CustomLight);
            expect(custom.type).toBe('custom');
            Light.inject({custom});
            expect(inject).toHaveBeenCalledOnce();
            expect(addBlock.mock.calls.map(call => call[1]).join('\n')).toContain('uniform CustomLight u_custom;');
            expect(() => custom.toLumaLight()).toThrow('Unsupported Tangram light type: custom');
        }
        finally {
            if (original) Light.types.custom = original;
            else delete Light.types.custom;
            ShaderProgram.defines = originalDefines;
        }
    });

    test('untrusted scene definitions still reject an explicitly absent native descriptor', () => {
        expect(() => Light.create(createView(), {name: 'missing', luma: undefined})).toThrow('Expected a luma.gl');
    });

    test('scalar, CSS and RGBA contributions retain their normalization', () => {
        const light = Light.create(createView(), {name: 'colors', type: 'ambient',
            ambient: 0.25, diffuse: '#ff8000', specular: [0.1, 0.2, 0.3, 0.4]});
        expect(light.ambient).toEqual([0.25, 0.25, 0.25]);
        expect(light.diffuse).toEqual([1, 128 / 255, 0]);
        expect(light.specular).toEqual([0.1, 0.2, 0.3]);
        const program = {uniform: vi.fn()};
        light.setupProgram(program);
        expect(program.uniform.mock.calls).toEqual([['3fv', 'u_colors.ambient', [0.25, 0.25, 0.25]]]);
    });

    test('default directional light retains half ambient while authored strings normalize', () => {
        const defaultLight = Light.create(createView(), {name: 'default', type: 'directional'});
        expect(defaultLight.ambient).toEqual([0.5, 0.5, 0.5]);
        expect(defaultLight.direction?.[2]).toBeCloseTo(-0.5);
        const authored = Light.create(createView(), {name: 'authored', type: 'directional', direction: ['3', '0', '-4']});
        expect(authored.ambient).toEqual([0, 0, 0]);
        expect(authored.direction?.[0]).toBeCloseTo(0.6);
        expect(authored.direction?.[2]).toBeCloseTo(-0.8);
        expect(authored.toLumaLight().tangram.direction).toEqual(authored.direction);
    });

    test.each(['ground', 'camera'] as const)('%s positions and radius units update with style zoom', origin => {
        const view = createView();
        const light = Light.create(view, {name: 'lamp', type: 'point', origin,
            position: ['2px', '3m', '4px'], radius: [null, '5px'], attenuation: '1.5'});
        for (const zoom of [10, 12]) {
            view.zoom = zoom;
            const metersPerPixel = Geo.metersPerPixel(zoom);
            const snapshot = light.toLumaLight();
            if (!snapshot.tangram.position) throw new Error('Expected resolved position');
            expect(snapshot.tangram.position).toEqual([2 * metersPerPixel, 3,
                4 * metersPerPixel - (origin === 'ground' ? 30 : 0)]);
            expect(snapshot.tangram.radius).toEqual([null, 5 * metersPerPixel]);
            const program = {uniform: vi.fn()};
            light.setupProgram(program);
            expect(program.uniform).toHaveBeenCalledWith('4fv', 'u_lamp.position', [...snapshot.tangram.position, 1]);
            expect(program.uniform).toHaveBeenCalledWith('1f', 'u_lamp.innerRadius', -1);
            expect(program.uniform).toHaveBeenCalledWith('1f', 'u_lamp.outerRadius', 5 * metersPerPixel);
            expect(program.uniform).toHaveBeenCalledWith('1f', 'u_lamp.attenuationExponent', 1.5);
        }
    });

    test('world positions retain longitude/latitude meters and pixel altitude', () => {
        const view = createView();
        const light = Light.create(view, {name: 'world', type: 'point', origin: 'world', position: [1, 2, '10px']});
        const projected = Geo.latLngToMeters([1, 2]);
        expect(light.toLumaLight().tangram.position).toEqual([
            projected[0] - 10, projected[1] - 20, 10 * Geo.metersPerPixel(view.zoom) - 30
        ]);
    });

    test('scalar radius expands to an outer bound and missing radius binds sentinels', () => {
        const scalar = Light.create(createView(), {name: 'scalar', type: 'point', radius: '25m', attenuation: 'invalid'});
        expect(scalar.toLumaLight().tangram).toMatchObject({radius: [null, 25], attenuation: 0});
        const program = {uniform: vi.fn()};
        const unbounded = Light.create(createView(), {name: 'unbounded', type: 'point'});
        unbounded.update();
        unbounded.setupProgram(program);
        expect(program.uniform).toHaveBeenCalledWith('1f', 'u_unbounded.innerRadius', -1);
        expect(program.uniform).toHaveBeenCalledWith('1f', 'u_unbounded.outerRadius', -1);
        expect(program.uniform).toHaveBeenCalledWith('3fv', 'u_unbounded.attenuationCoefficients', [1, 0, 0]);
    });

    test('legacy zero spotlight controls keep historical defaults; native zero exponent stays zero', () => {
        const legacy = Light.create(createView(), {name: 'legacy', type: 'spotlight', angle: 0, exponent: 0});
        expect(legacy.toLumaLight().tangram).toMatchObject({angle: 20, exponent: 0.2, direction: [0, 0, -1]});
        const native = Light.create(createView(), {name: 'native', luma: {
            type: 'spot', position: [0, 0, 1], direction: [0, 0, -1], spotExponent: 0
        }});
        expect(native.toLumaLight().tangram.exponent).toBe(0);
        const authored = Light.create(createView(), {name: 'authored', type: 'spotlight', angle: '30', exponent: '2'});
        expect(authored.toLumaLight().tangram).toMatchObject({angle: 30, exponent: 2});
    });

    test('global disable clears prior lighting and injects no replacement', () => {
        const removeBlock = vi.spyOn(ShaderProgram, 'removeBlock').mockImplementation(() => {});
        const addBlock = vi.spyOn(ShaderProgram, 'addBlock').mockImplementation(() => {});
        Light.enabled = false;
        Light.inject({sky: Light.create(createView(), {name: 'sky', type: 'ambient'})});
        expect(removeBlock).toHaveBeenCalledWith('lighting');
        expect(addBlock).not.toHaveBeenCalled();
    });
});
