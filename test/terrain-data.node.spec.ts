// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test} from 'vitest';
import {decodeTerrainHeightGrid, sampleTerrainHeight, TERRARIUM_DECODER, TERRAIN_RGB_DECODER,
    type TerrainGridOptions} from '../modules/tangram-renderer/src/map-logic/terrain-data';

/** Small asymmetric RGBA corpus, including fractional, negative and zero heights. */
function options(): TerrainGridOptions {
    return {width: 2, height: 2, pixels: new Uint8Array([128, 0, 0, 255, 128, 2, 0, 255, 127, 255, 128, 255, 128, 4, 64, 255]),
        decoder: TERRARIUM_DECODER, bounds: [0, 0, 2, 2], verticalDatum: 'unknown', registration: 'grid-node'};
}

test('decodes detached row-major physical heights without changing alpha or datum', () => {
    const input = options();
    const grid = decodeTerrainHeightGrid(input);
    expect([...grid.heights]).toEqual([0, 2, -0.5, 4.25]);
    expect([...grid.valid]).toEqual([1, 1, 1, 1]);
    input.pixels.fill(0);
    expect([...grid.heights]).toEqual([0, 2, -0.5, 4.25]);
    expect(grid.bounds).not.toBe(input.bounds);
    expect(grid.verticalDatum).toBe('unknown');
    expect(decodeTerrainHeightGrid({...options(), pixels: new Uint8ClampedArray(options().pixels)}).heights).toEqual(grid.heights);
    expect(decodeTerrainHeightGrid({...options(), pixels: options().pixels.map((value, index) => index % 4 === 3 ? 0 : value)}).heights).toEqual(grid.heights);
});

test.each([TERRARIUM_DECODER, TERRAIN_RGB_DECODER, {rScaler: -2, gScaler: 3, bScaler: 0.5, offset: 42}])('decoder coefficients match byte arithmetic: %j', decoder => {
    const input = {...options(), decoder};
    const grid = decodeTerrainHeightGrid(input);
    for (let index = 0; index < 4; index++) expect(grid.heights[index]).toBe(Math.fround(input.pixels[index * 4] * decoder.rScaler + input.pixels[index * 4 + 1] * decoder.gScaler + input.pixels[index * 4 + 2] * decoder.bScaler + decoder.offset));
    expect(Object.isFrozen(TERRARIUM_DECODER)).toBe(true);
    expect(Object.isFrozen(TERRAIN_RGB_DECODER)).toBe(true);
});

test.each([
    [[0, 2], 0], [[2, 2], 2], [[0, 0], -0.5], [[2, 0], 4.25], [[1, 1], 1.4375],
    [[1, 2], 1], [[0, 1], -0.25], [[-1, 1], null], [[3, 1], null], [[1, -1], null], [[1, 3], null], [[NaN, 0], null]
] as const)('node-grid sampling at %j gives %s', (position, expected) => {
    expect(sampleTerrainHeight(decodeTerrainHeightGrid(options()), position)).toBe(expected);
});

test('pixel-center registration clamps footprint edges, not interior samples', () => {
    const grid = decodeTerrainHeightGrid({...options(), registration: 'pixel-center'});
    expect(sampleTerrainHeight(grid, [0.5, 1.5])).toBe(0);
    expect(sampleTerrainHeight(grid, [1.5, 0.5])).toBe(4.25);
    expect(sampleTerrainHeight(grid, [0, 2])).toBe(0);
    expect(sampleTerrainHeight(grid, [2, 0])).toBe(4.25);
    expect(sampleTerrainHeight(grid, [1, 1])).toBe(1.4375);
});

test('holes remain invalid and exact valid nodes do not depend on zero-weight neighbors', () => {
    const valid = new Uint8Array([1, 0, 1, 1]);
    const grid = decodeTerrainHeightGrid({...options(), valid});
    valid.fill(0);
    expect(grid.valid[0]).toBe(1);
    expect(grid.heights[1]).toBeNaN();
    expect(sampleTerrainHeight(grid, [2, 2])).toBeNull();
    expect(sampleTerrainHeight(grid, [1, 1])).toBeNull();
    expect(sampleTerrainHeight(grid, [0, 2])).toBe(0);
    expect(sampleTerrainHeight(grid, [0, 1])).toBe(-0.25);
});

test.each([
    {width: 1}, {height: 1}, {width: 2.5}, {height: Infinity}, {pixels: new Uint8Array(15)},
    {bounds: [0, 0, 0, 2]}, {bounds: [0, 2, 2, 1]}, {bounds: [0, NaN, 2, 3]},
    {decoder: {...TERRARIUM_DECODER, offset: Infinity}},
    {decoder: {...TERRARIUM_DECODER, rScaler: 1e100}}, {valid: new Uint8Array(1)}
])('rejects invalid grid metadata: %j', invalid => {
    expect(() => decodeTerrainHeightGrid({...options(), ...invalid} as TerrainGridOptions)).toThrow();
});

test('vertical datum is carried explicitly rather than converted', () => {
    for (const verticalDatum of ['ellipsoidal', 'orthometric', 'unknown'] as const) {
        const grid = decodeTerrainHeightGrid({...options(), verticalDatum});
        expect(grid.verticalDatum).toBe(verticalDatum);
        expect(grid.heights[3]).toBe(4.25);
    }
});
