// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {describe, expect, expectTypeOf, test} from 'vitest';
import {lighting} from '@luma.gl/shadertools';
import type {Light as LumaLight} from '@luma.gl/shadertools';
import {convertLumaLight, mapTangramLight, normalizeSceneLights} from '../src/lights/light-definitions';
import type {ResolvedTangramLight, TangramLight, TangramPointLight, TangramSpotLight} from '../src/lights/light-definitions';
import {TangramStyleSheetSchema} from '../src/styles/style-schema';

const nativeLights: LumaLight[] = [
    {type: 'ambient', color: [51, 102, 153], intensity: 2},
    {type: 'directional', color: [255, 127.5, 0], direction: [1, 0, -1]},
    {type: 'point', color: [64, 128, 255], position: [1, 2, 3], attenuation: [1, 2, 3]},
    {type: 'spot', color: [255, 255, 255], intensity: 0.5, position: [4, 5, 6], direction: [0, 0, -1],
        attenuation: [2, 0, 0.25], innerConeAngle: 0.1, outerConeAngle: 0.4}
];

describe('native luma.gl light conversion', () => {
    test('normalized descriptors expose validated defaults through their discriminants', () => {
        const point = convertLumaLight({type: 'point', position: [1, 2, 3]}).lumaLight;
        expectTypeOf(point.color).toEqualTypeOf<readonly [number, number, number]>();
        expectTypeOf(point.intensity).toEqualTypeOf<number>();
        if (point.type !== 'point') throw new Error('Expected point light');
        expectTypeOf(point.attenuation).toEqualTypeOf<readonly [number, number, number]>();
        expect(point).toMatchObject({color: [0, 0, 0], intensity: 1, attenuation: [1, 0, 0]});
        const spot = convertLumaLight({type: 'spot', position: [0, 0, 1], direction: [0, 0, -1]}).lumaLight;
        if (spot.type !== 'spot') throw new Error('Expected spotlight');
        expectTypeOf(spot.innerConeAngle).toEqualTypeOf<number>();
        expectTypeOf(spot.outerConeAngle).toEqualTypeOf<number>();
        expect(spot).toMatchObject({innerConeAngle: 0, outerConeAngle: Math.PI / 4});
        expectTypeOf<Parameters<typeof convertLumaLight>[0]>().toEqualTypeOf<TangramLight>();
        expect(() => Reflect.apply(convertLumaLight, undefined, [undefined])).toThrow();
    });
    test.each(nativeLights)('$type uses the same color/intensity convention as the actual luma module', input => {
        const converted = convertLumaLight(input);
        const uniforms = lighting.getUniforms({lights: [input]});
        expect(converted[input.type === 'ambient' ? 'ambient' : 'diffuse']).toEqual(
            input.type === 'ambient' ? uniforms.ambientColor : uniforms.lights[0].color);
        expect(converted.specular).toEqual(input.type === 'ambient' ? [0, 0, 0] : uniforms.lights[0].color);
        expect(converted.lumaLight).toMatchObject(input);
        expect(converted.lumaLight).not.toBe(input);
        expect(converted.lumaLight.color).not.toBe(input.color);
    });

    test('matches luma defaults, zero intensity, HDR and byte values of one', () => {
        expect(convertLumaLight({type: 'ambient'}).ambient).toEqual([0, 0, 0]);
        expect(convertLumaLight({type: 'ambient', color: [255, 255, 255], intensity: 0}).ambient).toEqual([0, 0, 0]);
        expect(convertLumaLight({type: 'ambient', color: [255, 255, 255], intensity: 2}).ambient).toEqual([2, 2, 2]);
        expect(convertLumaLight({type: 'ambient', color: [1, 0, 0]}).ambient).toEqual([1 / 255, 0, 0]);
        expect(convertLumaLight({type: 'point', position: [0, 0, 1]}).lumaLight).toMatchObject({attenuation: [1, 0, 0]});
        expect(convertLumaLight({type: 'spot', position: [0, 0, 1], direction: [0, 0, -1]}).lumaLight)
            .toMatchObject({innerConeAngle: 0, outerConeAngle: Math.PI / 4});
    });

    test('copies positions, directions and attenuation; never mutates frozen input', () => {
        const input = Object.freeze({type: 'spot' as const, color: Object.freeze([100, 200, 255] as const),
            position: Object.freeze([1, 2, 3] as const), direction: Object.freeze([0, 0, -1] as const),
            attenuation: Object.freeze([1, 0, 2] as const)});
        const converted = convertLumaLight(input);
        expect(converted.lumaLight).not.toBe(input);
        expect(converted.position).not.toBe(input.position);
        expect(converted.direction).not.toBe(input.direction);
        expect('attenuation' in converted.lumaLight && converted.lumaLight.attenuation).not.toBe(input.attenuation);
    });

    test('accepts optional Tangram fields without overriding luma coefficient/color conventions', () => {
        const input: TangramPointLight = {type: 'point', position: [0, 0, 100], color: [255, 128, 0],
            ambient: [0.2, 0.3, 0.4], diffuse: 0.8, specular: '#ffffff',
            attenuation: [1, 0.01, 0], attenuationExponent: 2, radius: [null, '200m'], origin: 'camera'};
        const converted = convertLumaLight(input);
        expect(converted).toMatchObject({ambient: [0.2, 0.3, 0.4], diffuse: 0.8, specular: '#ffffff',
            attenuation: 2, radius: [null, '200m'], origin: 'camera'});
        expect(converted.lumaLight).toMatchObject({attenuation: [1, 0.01, 0]});
        expect(converted.radius).not.toBe(input.radius);
        expect(converted.ambient).not.toBe(input.ambient);
        expect(TangramStyleSheetSchema.parse({lights: [input]}).lights).toEqual([input]);
        const spot: TangramSpotLight = {type: 'spot', position: [0, 0, 1], direction: [0, 0, -1], spotExponent: 0};
        expect(convertLumaLight(spot).exponent).toBe(0);
        expect(normalizeSceneLights([{type: 'ambient', visible: false}])).toMatchObject({luma_light_0: {luma: {visible: false}}});
    });

    test.each([
        {type: 'unsupported'}, {type: 'ambient', color: [1, 2]},
        {type: 'ambient', color: [1, NaN, 3]}, {type: 'ambient', color: [-1, 0, 0]},
        {type: 'ambient', intensity: Infinity}, {type: 'ambient', intensity: -1},
        {type: 'directional'}, {type: 'directional', direction: [0, 0, 0]},
        {type: 'point'}, {type: 'point', position: [0, 0, 0], attenuation: [0, 0, 0]},
        {type: 'point', position: [0, 0, 0], attenuation: [1, -1, 0]},
        {type: 'spot', position: [0, 0, 0], direction: [0, 0, -1], innerConeAngle: 1, outerConeAngle: 0.5},
        {type: 'spot', position: [0, 0, 0], direction: [0, 0, -1], outerConeAngle: Infinity},
        {type: 'ambient', ambient: [1, NaN, 2]}, {type: 'ambient', visible: 'false'},
        {type: 'point', position: [0, 0, 1], origin: 'invalid'},
        {type: 'point', position: [0, 0, 1], radius: [1, -1]},
        {type: 'point', position: [0, 0, 1], attenuationExponent: Infinity},
        {type: 'spot', position: [0, 0, 1], direction: [0, 0, -1], spotExponent: -1}
    ])('rejects malformed runtime input: %j', input => {
        // Scene files are untrusted runtime values, not type-checked TypeScript.
        expect(() => Reflect.apply(convertLumaLight, undefined, [input])).toThrow();
    });

    test('normalizes arrays without modifying named legacy definitions or adding defaults to an empty array', () => {
        const legacy = {sun: {type: 'directional', ambient: 0.5}};
        expect(normalizeSceneLights(legacy)).toBe(legacy);
        expect(normalizeSceneLights([])).toEqual({});
        expect(normalizeSceneLights(nativeLights)).toMatchObject({
            luma_light_0: {luma: {type: 'ambient'}}, luma_light_3: {luma: {type: 'spot'}}
        });
        expect(TangramStyleSheetSchema.safeParse({lights: nativeLights}).success).toBe(true);
        expect(TangramStyleSheetSchema.safeParse({lights: [{type: 'point'}]}).success).toBe(false);
    });

    test('authored native schema permits globals without accepting arbitrary strings as vectors', () => {
        const native = {type: 'spot', position: 'global.position', color: [255, 'global.green', 0],
            direction: [0, 0, -1], attenuation: 'global.coefficients', intensity: 'global.intensity',
            visible: 'global.visible', innerConeAngle: 'global.inner', outerConeAngle: 'global.outer',
            attenuationExponent: 'global.exponent', origin: 'global.origin'};
        expect(TangramStyleSheetSchema.parse({lights: [native]}).lights).toEqual([native]);
        expect(TangramStyleSheetSchema.safeParse({lights: [{...native, position: 'not a vector'}]}).success).toBe(false);
    });
});

describe('resolved Tangram definitions map to luma.gl without losing legacy semantics', () => {
    const base: ResolvedTangramLight = {type: 'ambient', ambient: [0.2, 0.3, 0.4],
        diffuse: [0.5, 0.6, 0.7], specular: [0.8, 0.9, 1]};

    test('accepts runtime color arrays but still validates exact finite triples', () => {
        const colors: number[] = [0.1, 0.2, 0.3];
        const mapping = mapTangramLight({...base, ambient: colors});
        expect(mapping.tangram.ambient).toEqual(colors);
        expect(mapping.tangram.ambient).not.toBe(colors);
        expect(() => mapTangramLight({...base, ambient: [0.1, 0.2]})).toThrow();
        expect(() => mapTangramLight({...base, ambient: [0.1, NaN, 0.3]})).toThrow();
    });

    test.each(['ambient', 'directional', 'point', 'spotlight'] as const)('%s retains exact shading extensions', type => {
        const resolved: ResolvedTangramLight = {...base, type, position: [1, 2, 3], direction: [0, 0, -1],
            radius: [null, 100], attenuation: 1.5, angle: 30, exponent: 0.4};
        const mapping = mapTangramLight(resolved);
        expect(mapping.tangram).toEqual(resolved);
        expect(mapping.tangram).not.toBe(resolved);
        expect(mapping.tangram.radius).not.toBe(resolved.radius);
        expect(mapping.coordinateSpace).toBe('tangram-lighting');
        expect(mapping.light).toMatchObject({ambient: base.ambient, diffuse: base.diffuse, specular: base.specular});
        if (type === 'point' || type === 'spotlight') {
            expect(mapping.light).toMatchObject({radius: [null, 100], attenuationExponent: 1.5});
        }
        if (type === 'spotlight') expect(mapping.light).toMatchObject({spotExponent: 0.4});
        const uniforms = lighting.getUniforms({lights: [mapping.light]});
        const color = type === 'ambient' ? uniforms.ambientColor : uniforms.lights[0].color;
        const expected = type === 'ambient' ? base.ambient : base.diffuse;
        color.forEach((value, index) => expect(value).toBeCloseTo(expected[index]));
        if (type === 'spotlight') expect(mapping.light).toMatchObject({type: 'spot', outerConeAngle: Math.PI / 6});
    });

    test('requires resolved positions/directions and supplies the legacy default spotlight cutoff', () => {
        expect(() => mapTangramLight({...base, type: 'point'})).toThrow('position');
        expect(() => mapTangramLight({...base, type: 'directional'})).toThrow('direction');
        expect(mapTangramLight({...base, type: 'spotlight', position: [0, 0, 1], direction: [0, 0, -1]}).light)
            .toMatchObject({innerConeAngle: 20 * Math.PI / 180, outerConeAngle: 20 * Math.PI / 180});
    });
});
