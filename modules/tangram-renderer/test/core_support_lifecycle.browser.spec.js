// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {afterEach, describe, expect, test, vi} from 'vitest';
import Tangram from '../src/index';
import {
    applyGlobalProperties,
    flattenGlobalProperties,
    isGlobalReference,
    isGlobalSubstitution
} from '../src/scene/globals';
import FontManager from '../src/styles/text/font_manager';
import Light from '../src/lights/light';
import ShaderProgram from '../src/gl/shader_program';
import Collision from '../src/labels/collision';
import LabelPoint from '../src/labels/label_point';
import mainThreadLabelCollisionPass from '../src/labels/main_pass';

afterEach(() => {
    vi.restoreAllMocks();
    Light.enabled = true;
});

describe('renderer core entry', () => {
    test('exports host-independent renderer APIs without Leaflet', () => {
        expect(Tangram).toMatchObject({
            ClassicWebGLRenderer: expect.any(Function),
            HostFrame: expect.any(Function),
            LumaDeviceRenderer: expect.any(Function),
            Scene: expect.any(Function),
            debug: expect.any(Object),
            version: expect.any(String)
        });
        expect(Tangram.leafletLayer).toBeUndefined();
    });
});

describe('scene globals', () => {
    test('flattens nested globals and detects references', () => {
        const globals = flattenGlobalProperties({colors: {road: '#fff'}, widths: [1, 2], zoom: 4});
        expect(globals).toMatchObject({
            'global.colors': {road: '#fff'},
            'global.colors.road': '#fff',
            'global.widths': [1, 2],
            'global.zoom': 4
        });
        expect(isGlobalReference('global.colors.road')).toBe(true);
        expect(isGlobalReference('colors.road')).toBe(false);
        expect(isGlobalReference(null)).toBe(false);
    });

    test('applies, reapplies, overrides, and detects substitutions', () => {
        const globals = {
            'global.alias': 'global.color',
            'global.color': '#f00',
            'global.width': 3
        };
        const target = {nested: {color: 'global.alias'}, values: ['global.width', 2]};
        applyGlobalProperties(globals, target, {value: target}, 'value');
        expect(target.nested.color).toBe('#f00');
        expect(target.values[0]).toBe(3);
        expect(isGlobalSubstitution(target.nested, 'color')).toBe(true);
        expect(isGlobalSubstitution(target, ['nested', 'color'])).toBe(true);

        target.nested.color = '#0f0';
        expect(target.nested.color).toBe('#0f0');
        expect(isGlobalSubstitution(target.nested, 'color')).toBe(false);

        const holder = {color: 'global.color'};
        applyGlobalProperties(globals, holder.color, holder, 'color');
        globals['global.color'] = '#00f';
        applyGlobalProperties(globals, holder.color, holder, 'color');
        expect(holder.color).toBe('#00f');
    });

    test('breaks cyclical global references', () => {
        const globals = {'global.a': 'global.b', 'global.b': 'global.a'};
        const target = {value: 'global.a'};
        applyGlobalProperties(globals, target.value, target, 'value');
        expect(target.value).toBeNull();
    });
});

describe('font loading compatibility', () => {
    test('deduplicates font sets and ignores invalid faces', async () => {
        const manager = Object.create(FontManager);
        manager.fonts_loaded = Promise.resolve();
        manager.last_loaded = null;
        manager.loadFontFace = vi.fn().mockResolvedValue(undefined);
        const fonts = {Inter: [{url: 'inter.woff2', weight: 400}, 'external'], Invalid: null};
        await manager.loadFonts(fonts);
        expect(manager.loadFontFace).toHaveBeenCalledTimes(3);
        manager.loadFonts(fonts);
        expect(manager.loadFontFace).toHaveBeenCalledTimes(3);
        await expect(FontManager.loadFontFace('Ignored', 3)).resolves.toBeUndefined();
    });

    test('injects native and CSS font faces', async () => {
        const manager = Object.create(FontManager);
        const originalFontFace = window.FontFace;
        const add = vi.fn();
        const NativeFontFace = vi.fn(function (family, source, options) {
            return {family, options, source};
        });
        window.FontFace = NativeFontFace;
        Object.defineProperty(document, 'fonts', {configurable: true, value: {add}});
        manager.supports_native_font_loading = true;
        await manager.injectFontFace({family: 'Inter', style: 'normal', url: 'inter.woff2', weight: 400});
        expect(NativeFontFace).toHaveBeenCalled();
        expect(add).toHaveBeenCalled();

        manager.supports_native_font_loading = false;
        await manager.injectFontFace({family: 'Fallback', style: 'italic', url: 'fallback.woff2', weight: 700});
        expect([...document.styleSheets].some(sheet => [...sheet.cssRules].some(rule => rule.cssText.includes('Fallback')))).toBe(true);
        window.FontFace = originalFontFace;
    });
});

describe('light variants', () => {
    const view = {
        camera: {
            position_meters: [10, 20, 30],
            transformVector: vi.fn(vector => vector.map(value => value * 2))
        },
        zoom: 10
    };

    test('creates every light type and ignores unknown types', () => {
        expect(Light.create(view, {name: 'ambient', type: 'ambient'}).type).toBe('ambient');
        expect(Light.create(view, {name: 'sun', type: 'directional'}).type).toBe('directional');
        expect(Light.create(view, {name: 'lamp', type: 'point'}).type).toBe('point');
        expect(Light.create(view, {name: 'spot', type: 'spotlight'}).type).toBe('spotlight');
        expect(Light.create(view, {name: 'none', type: 'unknown'})).toBeUndefined();
    });

    test('sets lighting modes and injects type and instance shader blocks', () => {
        const style = {defines: {}};
        Light.setMode(true, style);
        expect(style.defines.TANGRAM_LIGHTING_FRAGMENT).toBe(true);
        Light.setMode('vertex', style);
        expect(style.defines.TANGRAM_LIGHTING_VERTEX).toBe(true);
        Light.enabled = false;
        Light.setMode('fragment', style);
        expect(style.defines.TANGRAM_LIGHTING_FRAGMENT).toBe(false);

        const addBlock = vi.spyOn(ShaderProgram, 'addBlock').mockImplementation(() => {});
        const removeBlock = vi.spyOn(ShaderProgram, 'removeBlock').mockImplementation(() => {});
        Light.enabled = true;
        const lights = {
            ambient: Light.create(view, {ambient: '#336699', name: 'ambient', type: 'ambient'}),
            sun: Light.create(view, {name: 'sun', type: 'directional'})
        };
        Light.inject(lights);
        expect(removeBlock).toHaveBeenCalledWith('lighting');
        expect(addBlock).toHaveBeenCalledWith('lighting', expect.stringContaining('calculateLighting'));
        expect(addBlock).toHaveBeenCalledWith('setup', expect.stringContaining('u_sun'));
    });

    test('updates and binds directional, point, and spot uniforms', () => {
        const program = {uniform: vi.fn()};
        const directional = Light.create(view, {direction: [1, 0, -1], name: 'sun', type: 'directional'});
        expect(directional.direction[0]).toBeCloseTo(Math.SQRT1_2);
        expect(directional.direction[1]).toBe(0);
        expect(directional.direction[2]).toBeCloseTo(-Math.SQRT1_2);
        directional.setupProgram(program);
        expect(view.camera.transformVector).toHaveBeenCalled();
        const directionCall = program.uniform.mock.calls.find(call => call[1] === 'u_sun.direction');
        expect(directionCall[2][0]).toBeCloseTo(Math.SQRT2);
        expect(directionCall[2][1]).toBe(0);
        expect(directionCall[2][2]).toBeCloseTo(-Math.SQRT2);

        const point = Light.create(view, {
            attenuation: 2,
            name: 'lamp',
            origin: 'world',
            position: [-74, 40, '100px'],
            radius: ['10px', '100px'],
            type: 'point'
        });
        point.inject();
        point.update();
        point.setupProgram(program);
        expect(point.position_eye).toHaveLength(4);
        expect(program.uniform).toHaveBeenCalledWith('1f', 'u_lamp.attenuationExponent', 2);
        expect(program.uniform).toHaveBeenCalledWith('1f', 'u_lamp.innerRadius', expect.any(Number));

        const spot = Light.create(view, {
            angle: 30,
            direction: [0, 1, -1],
            exponent: 2,
            name: 'spot',
            radius: ['10px', '100px'],
            type: 'spotlight'
        });
        spot.update();
        spot.setupProgram(program);
        expect(program.uniform).toHaveBeenCalledWith('1f', 'u_spot.spotExponent', 2);
        expect(program.uniform).toHaveBeenCalledWith('3fv', 'u_spot.direction', expect.any(Array));
    });
});

describe('main-thread label pass', () => {
    test('rebuilds label instances, updates visibility bytes, and uploads meshes', async () => {
        const point = new LabelPoint([100, -100], [20, 10], {
            anchor: 'center',
            buffer: [0, 0],
            collide: true,
            offset: [0, 0],
            priority: 0,
            units_per_pixel: 1
        });
        const vertexData = new Uint8Array(64);
        const mesh = {
            labels: {[point.id]: {
                container: {label: point.toJSON(), linked: null},
                ranges: [[0, 4]]
            }},
            upload: vi.fn(),
            valid: true,
            vertex_data: vertexData,
            vertex_layout: {offset: {a_shape: 0}, stride: 8}
        };
        const tile = {
            build_id: 1,
            coords: {z: 10},
            isProxy: () => false,
            meshes: {points: [mesh]},
            min: {x: 0, y: 0},
            pending_label_meshes: null,
            span: {x: 1000},
            style_z: 10,
            swapPendingLabels: vi.fn()
        };
        vi.spyOn(Collision, 'startTile').mockImplementation(() => {});
        vi.spyOn(Collision, 'addStyle').mockImplementation(() => {});
        vi.spyOn(Collision, 'initGrid').mockImplementation(() => {});
        vi.spyOn(Collision, 'collide').mockImplementation(async containers => {
            containers.forEach(container => { container.show = true; });
            return containers;
        });
        const result = await mainThreadLabelCollisionPass([tile], 10);
        expect(result.labels).toHaveLength(1);
        expect(result.containers[0].label).toBeInstanceOf(Object);
        expect(mesh.upload).toHaveBeenCalled();
        expect(tile.swapPendingLabels).toHaveBeenCalled();

        await mainThreadLabelCollisionPass([tile], 10, true);
        expect(tile.swapPendingLabels).toHaveBeenCalledTimes(2);
    });
});
