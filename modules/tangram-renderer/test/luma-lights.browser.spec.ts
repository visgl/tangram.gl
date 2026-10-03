// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {afterEach, describe, expect, test, vi} from 'vitest';
import {Matrix4} from '@math.gl/core';
import Light from '../src/lights/light';
import Scene from '../src/scene/scene';
import SceneLoader from '../src/scene/scene_loader';
import ShaderProgram from '../src/gl/shader_program';
import ExternalCamera from '../src/scene/external_camera';

afterEach(() => vi.restoreAllMocks());

/** A hosted camera with deterministic translation, rotation and independent eye origin. */
function createView(globe = false) {
    const view = {zoom: 10, projection: {type: globe ? 'globe' : 'web-mercator'},
        camera: {type: 'external', view_matrix: new Matrix4().translate([10, 20, 30]).rotateZ(Math.PI / 2),
            position_meters: [1, 2, 3], transformVector: (vector: number[]) => vector}};
    view.camera.transformVector = vector => ExternalCamera.prototype.transformVector.call(view.camera, vector);
    Object.assign(view.camera, {view});
    return view;
}

describe('native luma lights drive Tangram uniforms', () => {
    test('binds ambient and directional contributions without the implicit legacy half-ambient', () => {
        const view = createView();
        const ambient = Light.create(view, {name: 'sky', luma: {type: 'ambient', color: [255, 128, 0], intensity: 0.5}});
        expect(ambient.toLumaLight().light).toMatchObject({type: 'ambient', color: [255, 128, 0], intensity: 0.5});
        const sun = Light.create(view, {name: 'sun', luma: {type: 'directional', color: [255, 255, 255], direction: [1, 0, 0]}});
        expect(sun.ambient).toEqual([0, 0, 0]);
        const program = {uniform: vi.fn()};
        sun.setupProgram(program);
        const direction = program.uniform.mock.calls.find(call => call[1] === 'u_sun.direction')![2];
        expect(direction[0]).toBeCloseTo(0);
        expect(direction[1]).toBeCloseTo(1);
        expect(sun.toLumaLight().light.direction).toEqual(direction);
    });

    test.each([false, true])('resolves native positions per active eye; globe=%s', globe => {
        const view = createView(globe);
        const lamp = Light.create(view, {name: 'lamp', luma: {type: 'point', color: [255, 255, 255],
            position: [4, 5, 6], attenuation: [1, 0.1, 0.01]}});
        lamp.update();
        const expected = globe ? [3, 3, 3] : [4, 22, 33];
        expected.forEach((value, index) => expect(lamp.position_eye[index]).toBeCloseTo(value));
        view.camera.position_meters = [2, 3, 4];
        const mapping = lamp.toLumaLight();
        expect(mapping.light.attenuation).toEqual([1, 0.1, 0.01]);
        expected.forEach((value, index) => expect(mapping.light.position[index]).toBeCloseTo(value - 1));
        mapping.light.attenuation[0] = 99;
        expect(lamp.lumaLight.attenuation).toEqual([1, 0.1, 0.01]);
    });

    test('binds native coefficients and radian cones; legacy shaders retain their falloff', () => {
        const view = createView();
        const spot = Light.create(view, {name: 'spot', luma: {type: 'spot', color: [255, 255, 255], position: [1, 2, 3],
            direction: [1, 0, 0], attenuation: [1, 2, 3], innerConeAngle: 0.1, outerConeAngle: 0.5}});
        spot.update();
        const program = {uniform: vi.fn()};
        spot.setupProgram(program);
        expect(program.uniform).toHaveBeenCalledWith('1f', 'u_spot.useLumaAttenuation', 1);
        expect(program.uniform).toHaveBeenCalledWith('3fv', 'u_spot.attenuationCoefficients', [1, 2, 3]);
        expect(program.uniform).toHaveBeenCalledWith('2fv', 'u_spot.lumaConeCos', [Math.cos(0.1), Math.cos(0.5)]);
        expect(program.uniform).toHaveBeenCalledWith('1f', 'u_spot.spotExponent', 0);
        const legacy = Light.create(view, {name: 'legacy', type: 'point', attenuation: 2, radius: [10, 100]});
        legacy.update();
        legacy.setupProgram(program);
        expect(program.uniform).toHaveBeenCalledWith('1f', 'u_legacy.useLumaAttenuation', 0);
        const mapping = legacy.toLumaLight();
        expect(mapping.tangram).toMatchObject({attenuation: 2, radius: [10, 100]});
    });

    test('mixed native/legacy lights retain all legacy shader struct fields, regardless of order', () => {
        const view = createView();
        vi.spyOn(ShaderProgram, 'addBlock').mockImplementation(() => {});
        vi.spyOn(ShaderProgram, 'removeBlock').mockImplementation(() => {});
        const originalDefines = {...ShaderProgram.defines};
        try {
            Light.inject({legacy: Light.create(view, {name: 'legacy', type: 'point', attenuation: 2, radius: [1, 10]}),
                native: Light.create(view, {name: 'native', luma: {type: 'point', position: [1, 2, 3]}})});
            expect(ShaderProgram.defines).toMatchObject({TANGRAM_POINTLIGHT_ATTENUATION_EXPONENT: true,
                TANGRAM_POINTLIGHT_ATTENUATION_INNER_RADIUS: true, TANGRAM_POINTLIGHT_ATTENUATION_OUTER_RADIUS: true});
            const native = Light.create(view, {name: 'native', luma: {type: 'point', position: [1, 2, 3]}});
            const program = {uniform: vi.fn()};
            native.update();
            native.setupProgram(program);
            expect(program.uniform).toHaveBeenCalledWith('1f', 'u_native.attenuationExponent', 0);
            expect(program.uniform).toHaveBeenCalledWith('1f', 'u_native.innerRadius', -1);
            expect(program.uniform).toHaveBeenCalledWith('1f', 'u_native.outerRadius', -1);
        } finally {
            ShaderProgram.defines = originalDefines;
        }
    });

    test('optional Tangram fields bind alongside native coefficients and resolve into mapped descriptors', () => {
        const view = createView();
        const lamp = Light.create(view, {name: 'lamp', luma: {type: 'point', color: [255, 255, 255],
            position: [0, 0, 10], origin: 'camera', ambient: 0.2, diffuse: [0.7, 0.8, 0.9], specular: '#ffffff',
            radius: [2, 10], attenuationExponent: 2, attenuation: [2, 0, 0]}});
        lamp.update();
        const program = {uniform: vi.fn()};
        lamp.setupProgram(program);
        expect(program.uniform).toHaveBeenCalledWith('1f', 'u_lamp.attenuationExponent', 2);
        expect(program.uniform).toHaveBeenCalledWith('1f', 'u_lamp.innerRadius', 2);
        expect(program.uniform).toHaveBeenCalledWith('1f', 'u_lamp.outerRadius', 10);
        expect(program.uniform).toHaveBeenCalledWith('3fv', 'u_lamp.ambient', [0.2, 0.2, 0.2]);
        const mapping = lamp.toLumaLight();
        expect(mapping.light).toMatchObject({ambient: [0.2, 0.2, 0.2], diffuse: [0.7, 0.8, 0.9],
            specular: [1, 1, 1], radius: [2, 10], attenuation: [2, 0, 0], attenuationExponent: 2});
    });
});

describe('scene light integration', () => {
    test('retains historical default lights while allowing an explicitly empty native list', () => {
        expect(SceneLoader.finalize({config: {}, bundle: null}).config.lights.default_light).toEqual({type: 'directional'});
        expect(SceneLoader.finalize({config: {lights: []}, bundle: null}).config.lights).toEqual({});
    });

    test('creates native light arrays and snapshots without mutating the authored array', () => {
        const lights = [{type: 'ambient', color: [255, 128, 0]}];
        const config = SceneLoader.finalize({config: {lights}, bundle: null}).config;
        const scene = Object.create(Scene.prototype);
        scene.config = config;
        scene.view = createView();
        vi.spyOn(Light, 'inject').mockImplementation(() => {});
        scene.createLights();
        expect(scene.getLumaLightDefinitions()[0].light).toMatchObject(lights[0]);
        expect(lights).toEqual([{type: 'ambient', color: [255, 128, 0]}]);
        scene.shader_language = 'wgsl';
        expect(() => scene.createLights()).toThrow('configurable WGSL lighting');
        scene.config.lights = {hidden: {luma: {type: 'ambient', visible: false}}};
        scene.createLights();
        expect(scene.getLumaLightDefinitions()).toEqual([]);
    });
});
