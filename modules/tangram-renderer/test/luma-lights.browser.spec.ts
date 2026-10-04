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
import {Style} from '../src/styles/style';
import {StyleManager} from '../src/styles/style_manager';

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
    test('rebuilding derived styles releases each material and program exactly once, preserving base resources', () => {
        const manager = new StyleManager();
        const definitions = {surface: {base: 'polygons', lighting: 'fragment'},
            road: {base: 'lines', lighting: 'vertex'}, terrain: {base: 'raster', lighting: 'fragment'}};
        const buffers: {destroy: ReturnType<typeof vi.fn>}[] = [];
        const factory = vi.fn(() => {
            const buffer = {destroy: vi.fn()};
            buffers.push(buffer);
            return buffer;
        });
        const programs: {destroy: ReturnType<typeof vi.fn>}[] = [];
        const resourceContext = {};
        const options = {portableLighting: true, portableLightCount: 1,
            uniformBlockFactory: factory, maxTextureSize: 1024, resourceContext};
        let styles = manager.build(definitions);
        manager.initStyles({generation: 1});
        const base = styles.polygons;
        const baseBuffer = {destroy: vi.fn()};
        const baseProgram = {destroy: vi.fn()};
        base.portable_material_buffer = baseBuffer;
        base.program = baseProgram;
        base.resource_context = resourceContext;
        for (let generation = 1; generation <= 3; generation++) {
            for (const name of Object.keys(definitions)) {
                const style = styles[name];
                style.setGL(null, {}, options);
                style.program = {destroy: vi.fn()};
                style.selection_program = {destroy: vi.fn()};
                programs.push(style.program, style.selection_program);
            }
            styles = manager.build(definitions);
            expect(styles.polygons).toBe(base);
            expect(baseBuffer.destroy).not.toHaveBeenCalled();
            expect(baseProgram.destroy).not.toHaveBeenCalled();
            for (const buffer of buffers) expect(buffer.destroy).toHaveBeenCalledTimes(1);
            for (const program of programs) expect(program.destroy).toHaveBeenCalledTimes(1);
            // These newly constructed styles have not been initialized: they
            // inherit base resources, but do not own them and must not free them.
        }
        manager.destroy(resourceContext);
        expect(baseBuffer.destroy).toHaveBeenCalledTimes(1);
        expect(baseProgram.destroy).toHaveBeenCalledTimes(1);
        for (const buffer of buffers) expect(buffer.destroy).toHaveBeenCalledTimes(1);
        for (const program of programs) expect(program.destroy).toHaveBeenCalledTimes(1);
    });

    test('rejects light overflow before creating a GPU lighting resource', () => {
        const scene = Object.create(Scene.prototype);
        scene.config = {scene: {}, lights: Array.from({length: 17}, () => ({type: 'ambient', color: [255, 255, 255]}))};
        scene.shader_language = 'wgsl';
        scene.view = createView();
        scene.createUniformBuffer = vi.fn();
        expect(() => scene.createLights()).toThrow('at most 16');
        expect(scene.createUniformBuffer).not.toHaveBeenCalled();
    });

    test('portable style materials are private, refreshed and destroyed when lighting is disabled', () => {
        const style = Object.assign(Object.create(Style), {base: 'polygons',
            defines: {TANGRAM_LIGHTING_FRAGMENT: true}, material: {diffuse: {amount: [1, 1, 1, 1]}}});
        const first = {destroy: vi.fn(), setUniforms: vi.fn()};
        const second = {destroy: vi.fn(), setUniforms: vi.fn()};
        const factory = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
        const shared = {TangramLighting: {}};
        const options = {portableLighting: true, portableLightCount: 2,
            uniformBlockFactory: factory, maxTextureSize: 1024};
        style.setGL(null, shared, options);
        expect(style.portable_lighting_mode).toBe('fragment');
        expect(style.portable_light_count).toBe(2);
        expect(shared).not.toHaveProperty('TangramMaterial');
        expect(style.uniform_blocks.TangramMaterial).toBe(first);
        style.setup();
        expect(first.setUniforms).toHaveBeenCalledWith(expect.objectContaining({u_material_flags: [0, 0, 1, 0]}));
        style.setGL(null, shared, options);
        expect(first.destroy).toHaveBeenCalledTimes(1);
        style.setGL(null, shared, {...options, portableLighting: false});
        expect(second.destroy).toHaveBeenCalledTimes(1);
        expect(style.portable_material_buffer).toBeNull();
        expect(style.portable_lighting_mode).toBeUndefined();
        expect(style.uniform_blocks).toBe(shared);
    });
    test('derived styles never destroy an inherited material buffer', () => {
        const parentBuffer = {destroy: vi.fn()};
        const parent = Object.assign(Object.create(Style), {base: 'polygons',
            portable_material_buffer: parentBuffer});
        const configuredChild = Object.create(parent);
        configuredChild.setGL(null, {}, {maxTextureSize: 1024});
        configuredChild.destroy();
        const unconfiguredChild = Object.create(parent);
        unconfiguredChild.destroy();
        expect(parentBuffer.destroy).not.toHaveBeenCalled();
        expect(parent.portable_material_buffer).toBe(parentBuffer);
        expect(configuredChild.portable_material_buffer).toBeNull();
        expect(unconfiguredChild.portable_material_buffer).toBeNull();
    });

    test.each(['array', 'named'])('resolves and refreshes native %s light globals before conversion', shape => {
        const native = {type: 'point', position: 'global.lamp_position', color: 'global.lamp_color',
            attenuation: 'global.lamp_attenuation', visible: 'global.lamp_visible'};
        const config = SceneLoader.finalize({config: {
            global: {lamp_position: [1, 2, 3], lamp_color: [255, 0, 0],
                lamp_attenuation: [1, 2, 3], lamp_visible: true},
            lights: shape === 'array' ? [native] : {lamp: {luma: native}}
        }, bundle: null}).config;
        const scene = Object.create(Scene.prototype);
        scene.config = SceneLoader.applyGlobalProperties(config);
        scene.view = createView();
        vi.spyOn(Light, 'inject').mockImplementation(() => {});
        scene.createLights();
        const lamp = scene.lights[Object.keys(scene.lights)[0]];
        expect(lamp.lumaLight).toMatchObject({position: [1, 2, 3], color: [255, 0, 0], attenuation: [1, 2, 3]});
        config.global.lamp_position = [4, 5, 6];
        config.global.lamp_color = [0, 255, 0];
        config.global.lamp_visible = false;
        SceneLoader.applyGlobalProperties(config);
        scene.createLights();
        expect(scene.getLumaLightDefinitions()).toEqual([]);
        config.global.lamp_visible = true;
        SceneLoader.applyGlobalProperties(config);
        scene.createLights();
        expect(scene.lights[Object.keys(scene.lights)[0]].lumaLight).toMatchObject({position: [4, 5, 6], color: [0, 255, 0]});
    });

    test.each([null, {type: 'point'}, {type: 'unsupported'}])('rejects invalid array entries when creating lights: %j', native => {
        const scene = Object.create(Scene.prototype);
        scene.config = SceneLoader.finalize({config: {lights: [native]}, bundle: null}).config;
        scene.view = createView();
        expect(() => scene.createLights()).toThrow();
    });

    test('retains historical default lights while allowing an explicitly empty native list', () => {
        expect(SceneLoader.finalize({config: {}, bundle: null}).config.lights.default_light).toEqual({type: 'directional'});
        expect(SceneLoader.finalize({config: {lights: []}, bundle: null}).config.lights).toEqual({});
        expect(SceneLoader.finalize({config: {lights: []}, bundle: null}).config.scene.lighting).toBe('configured');
    });

    test('configured legacy lighting and empty native arrays keep a bounded block through config updates', () => {
        const scene = Object.create(Scene.prototype);
        scene.config = SceneLoader.finalize({config: {scene: {lighting: 'configured'}, lights: {}}, bundle: null}).config;
        scene.shader_language = 'wgsl';
        scene.view = createView();
        const buffer = {destroy: vi.fn()};
        scene.createUniformBuffer = vi.fn(() => buffer);
        vi.spyOn(Light, 'inject').mockImplementation(() => {});
        scene.createLights();
        expect(scene.uniform_buffers.TangramLighting).toBe(buffer);
        scene.config.lights = [];
        scene.createLights();
        expect(scene.getLumaLightDefinitions()).toEqual([]);
        expect(scene.createUniformBuffer).toHaveBeenCalledTimes(1);
        scene.config.lights = {sun: {type: 'directional'}};
        scene.config.scene.lighting = 'legacy';
        scene.createLights();
        expect(buffer.destroy).toHaveBeenCalledTimes(1);
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
        const buffer = {setUniforms: vi.fn(), destroy: vi.fn()};
        scene.createUniformBuffer = vi.fn(() => buffer);
        scene.createLights();
        expect(scene.createUniformBuffer).toHaveBeenCalledWith(expect.objectContaining({name: 'TangramLighting', binding: 6, snapshotPerMesh: true}));
        scene.config.lights = {hidden: {luma: {type: 'ambient', visible: false}}};
        scene.createLights();
        expect(scene.getLumaLightDefinitions()).toEqual([]);
        scene.config.lights = {sun: {type: 'directional'}};
        scene.createLights();
        expect(buffer.destroy).toHaveBeenCalled();
        expect(scene.uniform_buffers.TangramLighting).toBeUndefined();
    });

    test('geographic spots project position and ENU direction for the active eye without rewriting authored coordinates', () => {
        const view = createView(true);
        const native = {type: 'spot', position: [0, 0, 0], positionSpace: 'geographic', direction: [0, 0, -1]};
        const lamp = Light.create(view, {name: 'lamp', luma: native});
        const snapshot = lamp.toLumaLight();
        expect(snapshot.tangram.position).toEqual([-1, -258, -3]);
        expect(snapshot.tangram.direction).toEqual([0, 1, 0]);
        expect(native.position).toEqual([0, 0, 0]);
        view.camera.position_meters = [2, 3, 4];
        expect(lamp.toLumaLight().tangram.position).toEqual([-2, -259, -4]);
    });
});
