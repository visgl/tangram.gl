// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {describe, expect, test} from 'vitest';
import {_GlobeViewport as GlobeViewport} from '@deck.gl/core';
import {projectGeographicDirection, projectGeographicLight} from '../src/lights/geographic-lights';
import {convertLumaLight} from '../src/lights/light-definitions';
import {TangramStyleSheetSchema} from '../src/styles/style-schema';

describe('geographic light placement', () => {
    test.each([[0, 0, 0], [90, 0, 1000], [-90, -60, 10], [180, 45, 1], [-180, 45, 1], [37, 90, 0]] as const)(
        'matches deck.gl globe common coordinates for %j', (longitude, latitude, altitude) => {
            const expected = new GlobeViewport({width: 512, height: 320}).projectPosition([longitude, latitude, altitude]);
            projectGeographicLight([longitude, latitude, altitude], true).forEach((value, index) => expect(value).toBeCloseTo(expected[index], 6));
        });

    test('uses EPSG:3857 meters and chooses the nearest antimeridian copy', () => {
        expect(projectGeographicLight([0, 0, 123], false)[2]).toBe(123);
        const nearEast = projectGeographicLight([-179, 0, 10], false, 179);
        const unwrapped = projectGeographicLight([181, 0, 10], false);
        expect(nearEast).toEqual(unwrapped);
        expect(projectGeographicLight([179, 0, 10], false, -179)).toEqual(projectGeographicLight([-181, 0, 10], false));
        expect(projectGeographicLight([0, 90, 0], false)[1]).toBeCloseTo(Math.PI * 6378137, 5);
    });

    test.each([[0, 91, 0], [0, 0, Infinity], [NaN, 0, 0]] as const)('rejects invalid geographic coordinates: %j', (longitude, latitude, altitude) => {
        expect(() => projectGeographicLight([longitude, latitude, altitude], true)).toThrow('Geographic lights');
    });

    test('ENU spot orientation follows the globe tangent basis while planar axes remain ENU', () => {
        const position = [0, 0, 100] as const;
        expect(projectGeographicDirection(position, [1, 0, 0], true)).toEqual([1, 0, 0]);
        expect(projectGeographicDirection(position, [0, 1, 0], true)).toEqual([0, 0, 1]);
        expect(projectGeographicDirection(position, [0, 0, -1], true)).toEqual([0, 1, 0]);
        expect(projectGeographicDirection([90, 0, 0], [0, 0, 1], true)[0]).toBeCloseTo(1);
        expect(projectGeographicDirection([37, 65, 0], [1, 2, 3], false)).toEqual([1, 2, 3]);
    });

    test('native descriptors opt into geography and schema/editor options remain compatible', () => {
        const native = {type: 'spot' as const, position: [0, 0, 100] as const, direction: [0, 0, -1] as const,
            positionSpace: 'geographic' as const, directionSpace: 'enu' as const};
        expect(convertLumaLight(native).lumaLight).toMatchObject(native);
        expect(TangramStyleSheetSchema.parse({lights: [native]}).lights).toEqual([native]);
        expect(() => convertLumaLight({...native, origin: 'world'})).toThrow('legacy origin');
        expect(() => convertLumaLight({...native, position: [0, 100, 0]})).toThrow('latitude');
        expect(() => convertLumaLight({...native, positionSpace: 'common'})).toThrow('ENU');
        expect(() => Reflect.apply(convertLumaLight, null, [{...native, positionSpace: 'invalid'}])).toThrow('positionSpace');
        expect(() => Reflect.apply(convertLumaLight, null, [{...native, directionSpace: 'invalid'}])).toThrow('directionSpace');
    });
});
