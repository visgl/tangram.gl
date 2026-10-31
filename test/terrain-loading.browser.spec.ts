// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {beforeAll, expect, test} from 'vitest';
import {parseTerrainTile, createTerrainQuerySurface, type LoadedTerrain} from '../examples/terrain/load-terrain';
import {getTerrainTileBounds} from '../examples/terrain/tile-selection';
import {createTerrainFixture} from './terrain-fixture';
import {projectGeographicPosition} from '@tangram.gl/tangram-renderer/core';
import {lngLatToWorld, worldToLngLat} from '@math.gl/geospatial';
import {decodeTerrainTile} from '../examples/terrain/decode-terrain';
import {buildTerrainRenderMesh} from '../examples/terrain/terrain-mesh';

let loaded: LoadedTerrain;
beforeAll(async () => {loaded = await parseTerrainTile((await createTerrainFixture()).bytes, [0, 0, 0.01, 0.01], 0);});

test('published loaders.gl mesh heights match the shared CPU grid including edge replication', () => {
    const positions = loaded.mesh.attributes.POSITION.value;
    expect(loaded.mesh.topology).toBe('triangle-list');
    expect(loaded.mesh.indices!.value.length).toBeGreaterThan(0);
    const values = new Set(loaded.grid.heights);
    for (let index = 2; index < positions.length; index += 3) expect(values.has(positions[index])).toBe(true);
    expect(Math.max(...loaded.grid.heights)).toBe(2400.25);
    expect(Math.min(...loaded.grid.heights)).toBe(800.25);
    expect(loaded.grid.registration).toBe('pixel-center');
    expect(loaded.grid.verticalDatum).toBe('unknown');
});

test('math.gl world Y and decoded EPSG:3857 bounds remain north-positive', () => {
    expect(lngLatToWorld([0, -10])[1]).toBeLessThan(256);
    expect(lngLatToWorld([0, 10])[1]).toBeGreaterThan(256);
    expect(loaded.grid.bounds[1]).toBeCloseTo(0, 6);
    expect(loaded.grid.bounds[3]).toBeGreaterThan(1000);
    expect(loaded.grid.bounds[1]).toBeLessThan(loaded.grid.bounds[3]);
});

test('queries the same loaded indexed triangles without substituting bilinear heights', () => {
    const positions = loaded.mesh.attributes.POSITION.value, indices = loaded.mesh.indices!.value;
    const vertex = (offset: number) => indices[offset] * 3;
    const points = [0, 1, 2].map(offset => projectGeographicPosition([positions[vertex(offset)], positions[vertex(offset) + 1], positions[vertex(offset) + 2]], 'web-mercator'));
    const x = points.reduce((sum, point) => sum + point[0] / 3, 0);
    const y = points.reduce((sum, point) => sum + point[1] / 3, 0);
    const z = [0, 1, 2].reduce((sum, offset) => sum + positions[vertex(offset) + 2] / 3, 0);
    const hit = loaded.surface.intersectRay({origin: [x, y, 10000], direction: [0, 0, -1]});
    expect(hit).not.toBeNull();
    expect(hit!.position[2]).toBeCloseTo(z, 4);
    expect(hit!.coordinate[2]).toBeCloseTo(z, 4);
    expect(loaded.surface.intersectRay({origin: [-1000, -1000, 10000], direction: [0, 0, -1]})).toBeNull();
});

test('mesh simplification keeps data bytes, physical units and query surfaces independent', async () => {
    const fixture = await createTerrainFixture();
    const coarse = await parseTerrainTile(fixture.bytes, [0, 0, 0.01, 0.01], 1000);
    expect(coarse.grid.heights).toEqual(loaded.grid.heights);
    expect(coarse.mesh.indices!.value.length).toBeLessThan(loaded.mesh.indices!.value.length);
    expect(coarse.surface.projection).toBe('web-mercator');
    expect(() => createTerrainQuerySurface({...loaded.mesh, topology: 'point-list'})).toThrow();
    await expect(parseTerrainTile(fixture.bytes, [0, 0, 0.01, 0.01], -1)).rejects.toThrow();
    await expect(parseTerrainTile(fixture.bytes, [0, 0, 0.01, 90])).rejects.toThrow();
});

test('XYZ bounds preserve north-down row indexing and reject out-of-world requests', () => {
    expect(getTerrainTileBounds(1, 0, 0).slice(0, 3)).toEqual([-180, 0, 0]);
    expect(getTerrainTileBounds(1, 0, 0)[3]).toBeCloseTo(85.0511287798066, 12);
    const southern = getTerrainTileBounds(1, 1, 1);
    expect([southern[0], southern[2], southern[3]]).toEqual([0, 180, 0]);
    expect(southern[1]).toBeCloseTo(-85.0511287798066, 12);
    for (const value of [[-1, 0, 0], [23, 0, 0], [1, 2, 0], [1, 0, -1], [1, 0.5, 0]]) expect(() => getTerrainTileBounds(...value as [number, number, number])).toThrow();
});

test('high-latitude image rows follow Mercator Y rather than linear latitude', async () => {
    const bounds: [number, number, number, number] = [0, 40, 10, 80];
    const terrain = await parseTerrainTile((await createTerrainFixture()).bytes, bounds, 0);
    const positions = terrain.mesh.attributes.POSITION.value;
    const textureCoordinates = terrain.mesh.attributes.TEXCOORD_0.value;
    const southwest = lngLatToWorld([bounds[0], bounds[1]]);
    const northeast = lngLatToWorld([bounds[2], bounds[3]]);
    let checkedInterior = false;
    for (let index = 0; index < positions.length / 3; index++) {
        const column = textureCoordinates[index * 2];
        const row = textureCoordinates[index * 2 + 1];
        const expected = worldToLngLat([
            southwest[0] + column * (northeast[0] - southwest[0]),
            northeast[1] - row * (northeast[1] - southwest[1])
        ]);
        expect(positions[index * 3]).toBeCloseTo(expected[0], 5);
        expect(positions[index * 3 + 1]).toBeCloseTo(expected[1], 4);
        if (row > 0 && row < 1) {
            checkedInterior = true;
            expect(Math.abs(positions[index * 3 + 1] - (80 - row * 40))).toBeGreaterThan(1);
        }
    }
    expect(checkedInterior).toBe(true);
    expect(terrain.mesh.header?.boundingBox).toEqual([[0, 40, 800.25], [10, 80, 2400.25]]);
    expect(JSON.parse(terrain.mesh.schema.metadata.boundingBox)).toEqual(terrain.mesh.header?.boundingBox);
});

test('transparent samples are holes only under an explicitly selected validity policy', async () => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 4;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Missing image context');
    context.fillStyle = 'rgb(128, 1, 0)'; context.fillRect(0, 0, 4, 4); context.clearRect(1, 1, 1, 1);
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('PNG failed')), 'image/png'));
    const bytes = await blob.arrayBuffer();
    const opaque = await decodeTerrainTile(bytes, [0, 0, 0.01, 0.01]);
    const masked = await decodeTerrainTile(bytes, [0, 0, 0.01, 0.01], 20, 'alpha-zero');
    expect(opaque.grid.valid[5]).toBe(1); expect(masked.grid.valid[5]).toBe(0); expect(masked.grid.heights[5]).toBeNaN();
    expect(buildTerrainRenderMesh(masked, [], 0).loaded.mesh.indices!.value.length).toBeGreaterThan(0);
    await expect(decodeTerrainTile(new ArrayBuffer(8 * 1024 * 1024 + 1), [0, 0, 1, 1])).rejects.toThrow('byte limit');
});
