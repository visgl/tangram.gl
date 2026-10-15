// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test, vi} from 'vitest';
import {adaptTerrainQuerySource, type TerrainQuerySource} from '../src/map-logic/terrain-query';
import {TerrainMeshSurface, TerrainSurfaceCollection} from '../src/selection/terrain_surface';
import {TerrainHeightField} from '../src/map-logic/terrain-height-field';
import {sampleTerrainHeight, type TerrainHeightGrid} from '../src/map-logic/terrain-data';

test('a loaders.gl-shaped physical grid enters the existing field without decoding or exaggeration', () => {
    const grid: TerrainHeightGrid = {width: 2, height: 2, heights: new Float32Array([0, 10, 20, 30]), valid: new Uint8Array([1, 1, 1, 1]),
        bounds: [0, 0, 2, 2], registration: 'grid-node', verticalDatum: 'unknown'};
    const field = new TerrainHeightField([grid]);
    for (const position of [[0, 2], [2, 0], [1, 1], [0.5, 1.5], [-1, 0]] as const) expect(field.sampleHeight(position)).toBe(sampleTerrainHeight(grid, position));
    const missing = new TerrainHeightField([{...grid, valid: new Uint8Array([1, 0, 1, 1])}]);
    expect(missing.sampleHeight([1, 1])).toBeNull();
    expect(missing.sampleHeight([0, 2])).toBe(0);
});

test.each(['pixel-center', 'grid-node'] as const)('exact %s samples survive world-coordinate roundoff near missing neighbors', registration => {
    const halfWorld = Math.PI * 6378137, heights = new Float32Array(512), valid = new Uint8Array(512);
    heights[0] = 42; valid[0] = 1;
    const grid: TerrainHeightGrid = {width: 256, height: 2, heights, valid, bounds: [-halfWorld, -halfWorld, halfWorld, halfWorld], registration, verticalDatum: 'unknown'};
    const horizontal = -halfWorld + (registration === 'pixel-center' ? halfWorld / 256 : 0);
    const vertical = halfWorld - (registration === 'pixel-center' ? halfWorld / 2 : 0);
    expect(sampleTerrainHeight(grid, [horizontal, vertical])).toBe(42);
    expect(new TerrainHeightField([grid]).sampleHeight([horizontal, vertical])).toBe(42);
    expect(sampleTerrainHeight(grid, [horizontal + halfWorld / 256 * 1e-5, vertical])).toBeNull();
});

test('read-only providers retain physical height, finite clipping, receiver identity and caller ownership', () => {
    const hit = Object.freeze({position: [0, 0, 100] as const, coordinate: [0, 0, 10] as const,
        distance: 100, normal: [0, 0, 1] as const, triangleIndex: 0, barycentric: [1, 0, 0] as const});
    const source: TerrainQuerySource = {projection: 'web-mercator', intersectRay: vi.fn(function (this: TerrainQuerySource, _ray, maxDistance = Infinity) {
        expect(this).toBe(source); return maxDistance >= 100 ? hit : null;
    }), getBounds: () => ({minimum: [0, 0, 100] as const, maximum: [2, 2, 100] as const})};
    const adapter = adaptTerrainQuerySource(source);
    const ray = {origin: [0, 0, 200] as const, direction: [0, 0, -2] as const};
    const result = adapter.intersectRay(ray, 100)!;
    expect(result.coordinate[2]).toBe(10); expect(result.position[2]).toBe(100);
    result.position[2] = 999; expect(hit.position[2]).toBe(100);
    expect(adapter.intersectRay(ray, 99)).toBeNull();
    expect(source.intersectRay).toHaveBeenCalledWith(ray, 99);
    expect(adapter.getBounds?.()).toEqual({minimum: [0, 0, 100], maximum: [2, 2, 100]});
});

test('an external source composes with the existing nearest-surface router', () => {
    const mesh = new TerrainMeshSurface({projection: 'web-mercator', positions: [0, 0, 100, 2, 0, 100, 0, 2, 100], indices: [0, 1, 2], physicalHeights: [10, 20, 30]});
    const external = adaptTerrainQuerySource(mesh);
    const collection = new TerrainSurfaceCollection('web-mercator', [{id: 'shared-source', surface: external}]);
    const hit = collection.intersectRay({origin: [0.5, 0.5, 200], direction: [0, 0, -2]}, 100);
    expect(hit?.surfaceId).toBe('shared-source'); expect(hit?.distance).toBe(100);
    expect(hit?.coordinate[2]).toBe(17.5); expect(hit?.position[2]).toBe(100);
    expect(hit?.barycentric).toEqual([0.5, 0.25, 0.25]);
});

test('unknown and empty bounds remain distinct, and the provider may publish a new generation', () => {
    const noBounds = adaptTerrainQuerySource({projection: 'globe', intersectRay: () => null});
    expect(noBounds.getBounds).toBeUndefined();
    const empty = adaptTerrainQuerySource({projection: 'globe', intersectRay: () => null, getBounds: () => null});
    expect(empty.getBounds?.()).toBeNull();
    expect(noBounds.intersectRay({origin: [0, 0, 300], direction: [0, 0, -1]})).toBeNull();
});

test('rejects an invalid provider projection before borrowing it', () => {
    expect(() => Reflect.apply(adaptTerrainQuerySource, null, [{projection: 'screen', intersectRay: () => null}])).toThrow(/projection/);
});
