// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {beforeAll, expect, test, vi} from 'vitest';
import {decodeTerrainGrid} from '../examples/terrain/decode-height-grid';
import {createTerrainFixture} from './terrain-fixture';

// A grid-only import and request must never initialize the adaptive terrain parser.
vi.mock('@loaders.gl/raster/terrain', () => {throw new Error('Grid decoder imported the unused adaptive terrain parser');});
let bytes: ArrayBuffer;
beforeAll(async () => {bytes = (await createTerrainFixture()).bytes;});

test('grid-only decoding uses physical samples without importing the terrain mesh parser', async () => {
    const original = bytes.slice(0), data = await decodeTerrainGrid(bytes, [0, 0, 0.01, 0.01]);
    expect(Object.keys(data)).toEqual(['grid']); expect(data.grid.heights).toHaveLength(16);
    expect(Math.max(...data.grid.heights)).toBe(2400.25); expect(Math.min(...data.grid.heights)).toBe(800.25);
    expect(data.grid).toMatchObject({width: 4, height: 4, registration: 'pixel-center', verticalDatum: 'unknown'});
    expect(data.grid.bounds[1]).toBeCloseTo(0); expect(data.grid.bounds[3]).toBeGreaterThan(1000);
    expect(bytes).toEqual(original);
});

test.each([[2, 4], [3, 3], [2048, 2]])('invalid %s×%s bitmap dimensions reject before pixel extraction', async (width, height) => {
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('PNG encoding failed')), 'image/png'));
    await expect(decodeTerrainGrid(await blob.arrayBuffer(), [0, 0, 1, 1])).rejects.toThrow('power-of-two');
});
