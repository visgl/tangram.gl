// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test} from 'vitest';
import {Matrix4} from '@math.gl/core';
import HostFrame from '../src/scene/host_frame';
import {TerrainMeshSurface, pickTerrainAt} from '../src/selection/terrain_surface';
import {TriangleQueryIndex} from '../src/map-logic/triangle-query-index';

test('terrain validates detached physical heights against owned topology, reading caller values once', () => {
    const indices = [0, 1, 2], physicalHeights = [123, 123, 123];
    let indexReads = 0, heightReads = 0;
    Object.defineProperty(indices, 0, {get: () => indexReads++ === 0 ? 0 : NaN});
    Object.defineProperty(physicalHeights, 0, {get: () => heightReads++ === 0 ? 123 : NaN});
    const surface = new TerrainMeshSurface({projection: 'web-mercator', positions: [0, 0, 2, 2, 0, 2, 0, 2, 2], indices, physicalHeights});
    expect(indexReads).toBe(1); expect(heightReads).toBe(1);
    expect(surface.intersectRay({origin: [0.5, 0.5, 10], direction: [0, 0, -1]})?.coordinate[2]).toBe(123);
});

test('terrain owns geometry once and zero-budget linear queries preserve indexed physical/backface results', () => {
    const options = {projection: 'globe', positions: [-2, -256, -2, 2, -256, -2, 0, -256, 2], indices: [0, 1, 2], physicalHeights: [123, 123, 123], cullBackfaces: true} as const;
    const accelerated = new TerrainMeshSurface(options), linear = new TerrainMeshSurface({...options, maxQueryIndexBytes: 0});
    const ray = {origin: [0, -300, 0], direction: [0, 1, 0]} as const;
    expect(linear.getStatistics()).toMatchObject({geometryBytes: 9 * 8 + 3 * 4 + 3 * 8, queryIndexBytes: 0});
    expect(linear.intersectRay(ray)).toEqual(accelerated.intersectRay(ray));
    expect(linear.intersectRay(ray)?.coordinate[2]).toBeCloseTo(123);
    expect(linear.intersectRay({origin: [0, -200, 0], direction: [0, -1, 0]})).toBeNull();
    expect(linear.getStatistics().queryIndexBytes).toBe(0);
    expect(accelerated.getStatistics().geometryBytes).toBe(linear.getStatistics().geometryBytes);
    expect(accelerated.getStatistics().queryIndexBytes).toBe(68);
    for (const limit of [-1, NaN, Infinity, 1.5]) expect(() => new TerrainMeshSurface({...options, maxQueryIndexBytes: limit})).toThrow('byte limit');
});

test.each([1, 8, 9, 17, 32, 65])('packed hierarchy accounts exactly for %s triangles and matches budget fallback', count => {
    const positions = [0, 0, 2, 2, 0, 2, 0, 2, 2], indices = Array.from({length: count}, () => [0, 1, 2]).flat();
    const lazy = new TriangleQueryIndex(positions, indices, 8, {lazy: true});
    const linear = new TriangleQueryIndex(positions, indices, 8, {maxHierarchyBytes: lazy.requiredHierarchyBytes - 1});
    const exact = new TriangleQueryIndex(positions, indices, 8, {maxHierarchyBytes: lazy.requiredHierarchyBytes});
    const geometryBytes = positions.length * 8 + indices.length * 4;
    expect(lazy.arrayBytes).toBe(geometryBytes);
    expect(lazy.queryRay([10, 10, 10], [0, 0, -1]).hit).toBeNull(); expect(lazy.hierarchyBytes).toBe(0);
    const accepted = (hit: {triangleIndex: number}) => hit.triangleIndex === count - 1;
    const acceleratedHit = lazy.queryRay([0.5, 0.5, 10], [0, 0, -2], 4, accepted).hit;
    expect(acceleratedHit?.triangleIndex).toBe(count - 1);
    expect(linear.queryRay([0.5, 0.5, 10], [0, 0, -2], 4, accepted).hit).toEqual(acceleratedHit);
    expect(exact.queryRay([0.5, 0.5, 10], [0, 0, -2], 4, accepted).hit).toEqual(acceleratedHit);
    expect(lazy.hierarchyBytes).toBe(lazy.requiredHierarchyBytes);
    expect(lazy.arrayBytes).toBe(geometryBytes + lazy.requiredHierarchyBytes);
    expect(linear.hierarchyBytes).toBe(0);
    const vertex = lazy.getTriangleVertex(0, 0); vertex.position.fill(99);
    expect(lazy.getTriangleVertex(0, 0)).toEqual({index: 0, position: [0, 0, 2]});
    for (const pair of [[-1, 0], [count, 0], [0, 3], [0, NaN]]) expect(() => lazy.getTriangleVertex(pair[0], pair[1])).toThrow('out of range');
});

test('bounds rejection keeps unrelated terrain query indexes unallocated', () => {
    const surface = new TerrainMeshSurface({projection: 'web-mercator', positions: [-1, -1, 2, 1, -1, 2, 0, 1, 2], indices: [0, 1, 2]});
    const initial = surface.getStatistics(); expect(initial.queryIndexBytes).toBe(0);
    expect(surface.intersectRay({origin: [100, 100, 10], direction: [0, 0, -1]})).toBeNull();
    expect(surface.intersectRay({origin: [0, 0, 10], direction: [0, 0, -1]}, 7.9)).toBeNull();
    expect(surface.getStatistics()).toEqual(initial);
    expect(surface.intersectRay({origin: [0, 0, 10], direction: [0, 0, -10]}, 8)?.distance).toBe(8);
    const indexed = surface.getStatistics(); expect(indexed.queryIndexBytes).toBe(indexed.requiredQueryIndexBytes);
    expect(surface.intersectRay({origin: [0, 0, 2], direction: [0, 0, 1]}, 0)?.distance).toBe(0);
    expect(surface.getStatistics()).toEqual(indexed);
});
import type {TerrainRay} from '../src/selection/terrain_surface';

/** Deterministic sloped patch: altitude is 2 + x/2 meters. */
function terrain() {
    return new TerrainMeshSurface({projection: 'web-mercator',
        positions: [-2, -2, 1, 2, -2, 3, 2, 2, 3, -2, 2, 1], indices: [0, 1, 2, 0, 2, 3]});
}

/** One logical screen with two different finite camera rays. */
function frame() {
    const projection = new Matrix4().ortho({left: -5, right: 5, bottom: -5, top: 5, near: 0, far: 20});
    return new HostFrame({viewport: {width: 200, height: 100},
        geographicAnchor: {longitude: 0, latitude: 0, zoom: 5}, projection: {type: 'web-mercator'},
        renderViews: [
            {id: 'left', viewport: {x: 0, y: 0, width: 100, height: 100},
                camera: {view: new Matrix4().translate([1, 0, -10]), projection, position: [0, 0, 0]}},
            {id: 'right', viewport: {x: 100, y: 0, width: 100, height: 100},
                camera: {view: new Matrix4().translate([-1, 0, -10]), projection, position: [0, 0, 0]}}
        ]});
}

test.each([0.1, 1, 100])('terrain hits use physical altitude and normalized distance for direction length %s', scale => {
    const hit = terrain().intersectRay({origin: [0, 0, 10], direction: [0, 0, -scale]});
    expect(hit).toMatchObject({position: [0, 0, 2], coordinate: [0, 0, 2], distance: 8, triangleIndex: 0});
    expect(hit?.barycentric.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1);
    expect(hit?.normal).toEqual([expect.closeTo(-1 / Math.sqrt(5)), 0, expect.closeTo(2 / Math.sqrt(5))]);
});

test('nearest triangle wins independently of index order and winding; input buffers are copied', () => {
    const positions = [0, 0, 0, 2, 0, 0, 0, 2, 0, 0, 0, 4, 2, 0, 4, 0, 2, 4];
    const indices = [0, 1, 2, 5, 4, 3];
    const surface = new TerrainMeshSurface({projection: 'web-mercator', positions, indices});
    positions.fill(100); indices.fill(0);
    const hit = surface.intersectRay({origin: [0.5, 0.5, 10], direction: [0, 0, -1]});
    expect(hit).toMatchObject({position: [0.5, 0.5, 4], distance: 6, triangleIndex: 1});
    expect(hit?.normal[2]).toBe(-1);
    expect(surface.intersectRay({origin: [0.5, 0.5, -1], direction: [0, 0, 1]})?.position[2]).toBe(0);
});

test('a ray misses holes, parallel triangles, degenerates and surfaces beyond its finite segment', () => {
    const surface = terrain();
    expect(surface.intersectRay({origin: [5, 0, 10], direction: [0, 0, -1]})).toBeNull();
    expect(surface.intersectRay({origin: [0, 0, 10], direction: [1, 0, 0]})).toBeNull();
    expect(surface.intersectRay({origin: [0, 0, 10], direction: [0, 0, 1]})).toBeNull();
    expect(surface.intersectRay({origin: [0, 0, 10], direction: [0, 0, -1]}, 7.9)).toBeNull();
    expect(surface.intersectRay({origin: [0, 0, 10], direction: [0, 0, -1]}, 8)?.distance).toBe(8);
    expect(surface.intersectRay({origin: [0, 0, 2], direction: [0, 0, 1]}, 0)?.distance).toBe(0);
    expect(new TerrainMeshSurface({projection: 'web-mercator', positions: [], indices: []})
        .intersectRay({origin: [0, 0, 0], direction: [0, 0, 1]})).toBeNull();
    expect(new TerrainMeshSurface({projection: 'web-mercator', positions: [0, 0, 0], indices: [0, 0, 0]})
        .intersectRay({origin: [0, 0, 1], direction: [0, 0, -1]})).toBeNull();
});

test.each([
    {origin: [NaN, 0, 0], direction: [0, 0, 1]},
    {origin: [0, 0, 0], direction: [0, Infinity, 1]},
    {origin: [0, 0, 0], direction: [0, 0, 0]}
] satisfies TerrainRay[])('invalid ray has no terrain hit: %j', ray => {
    expect(terrain().intersectRay(ray)).toBeNull();
});

test.each([
    {positions: [0, 0], indices: []},
    {positions: [0, 0, 0], indices: [0]},
    {positions: [0, NaN, 0], indices: [0, 0, 0]},
    {positions: [0, 0, 0], indices: [0, 0, 1]},
    {positions: [0, 0, 0], indices: [0, -1, 0]},
    {positions: [0, 0, 0], indices: [0, 0.5, 0]}
])('invalid meshes are rejected before publishing a terrain surface: %j', mesh => {
    expect(() => new TerrainMeshSurface({projection: 'web-mercator', ...mesh})).toThrow(/Terrain/);
});

test('negative ray limits and NaN fail explicitly rather than relaxing clipping', () => {
    for (const distance of [-1, NaN]) expect(() => terrain().intersectRay({origin: [0, 0, 10], direction: [0, 0, -1]}, distance)).toThrow();
});

test('unsupported projections and the undefined globe center cannot publish a terrain hit', () => {
    expect(() => Reflect.construct(TerrainMeshSurface, [{projection: 'projected', positions: [], indices: []}])).toThrow(/projection/);
    const surface = new TerrainMeshSurface({projection: 'globe', positions: [-1, -1, 0, 1, -1, 0, 0, 1, 0], indices: [0, 1, 2]});
    expect(surface.intersectRay({origin: [0, 0, 1], direction: [0, 0, -1]})).toBeNull();
    const behindCenter = new TerrainMeshSurface({projection: 'globe', positions: [-1, -1, 0, 1, -1, 0, 0, 1, 0, -1, -1, -1, 1, -1, -1, 0, 1, -1], indices: [0, 1, 2, 3, 4, 5]});
    expect(behindCenter.intersectRay({origin: [0, 0, 1], direction: [0, 0, -1]})?.triangleIndex).toBe(1);
});

test('either stereo half routes to its own terrain ray, while named views use local pixels', () => {
    const current = frame();
    const left = pickTerrainAt(current, {x: 50, y: 50}, terrain(), {coordinateSpace: 'canvas'});
    const right = pickTerrainAt(current, {x: 150, y: 50}, terrain(), {coordinateSpace: 'canvas'});
    expect(left).toMatchObject({position: [-1, 0, 1.5], renderViewId: 'left'});
    expect(right).toMatchObject({position: [1, 0, 2.5], renderViewId: 'right'});
    expect(pickTerrainAt(current, {x: 50, y: 50}, terrain(), {renderViewId: 'right'})).toEqual(right);
    expect(pickTerrainAt(current, {x: 50, y: 50}, terrain(), {}, 'right')).toEqual(right);
    expect(pickTerrainAt(current, {x: 200, y: 50}, terrain(), {coordinateSpace: 'canvas'})).toBeNull();
    expect(pickTerrainAt(current, {x: 100, y: 50}, terrain(), {renderViewId: 'left'})).toBeNull();
});

test('terrain routing rejects invalid query policies and never intersects outside near/far', () => {
    expect(() => pickTerrainAt(frame(), {x: NaN, y: 0}, terrain())).toThrow(/finite/);
    expect(() => pickTerrainAt(frame(), {x: 0, y: 0}, terrain(), {radius: 5})).toThrow(/ray/);
    expect(() => pickTerrainAt(frame(), {x: 0, y: 0}, terrain(), {renderViewId: 'missing'})).toThrow();
    const surface = new TerrainMeshSurface({projection: 'web-mercator', positions: [-2, -2, 11, 2, -2, 11, 0, 2, 11], indices: [0, 1, 2]});
    expect(pickTerrainAt(frame(), {x: 50, y: 50}, surface)).toBeNull();
    const current = frame();
    current.renderViews[0].camera.projection = new Matrix4().scale([0, 0, 0]);
    expect(pickTerrainAt(current, {x: 50, y: 50}, terrain())).toBeNull();
    current.renderViews[0].camera.projection = new Matrix4().perspective({fovy: Math.PI / 3, aspect: 1, near: 1, far: Infinity});
    expect(pickTerrainAt(current, {x: 50, y: 50}, terrain())).toBeNull();
    const belowFar = new TerrainMeshSurface({projection: 'web-mercator', positions: [-2, -2, -11, 2, -2, -11, 0, 2, -11], indices: [0, 1, 2]});
    expect(pickTerrainAt(frame(), {x: 50, y: 50}, belowFar)).toBeNull();
});

test('globe terrain preserves altitude and uses the composed globe camera exactly once', () => {
    const surface = new TerrainMeshSurface({projection: 'globe', positions: [-2, -256, -2, 2, -256, -2, 0, -256, 2], indices: [0, 1, 2]});
    const view = new Matrix4().lookAt({eye: [0, -300, 0], center: [0, 0, 0], up: [0, 0, 1]});
    const projection = new Matrix4().ortho({left: -2, right: 2, bottom: -2, top: 2, near: 1, far: 100}).multiplyRight(view);
    const current = new HostFrame({viewport: {width: 100, height: 100}, geographicAnchor: {longitude: 0, latitude: 0, zoom: 0},
        projection: {type: 'globe', visibleBounds: [-180, -80, 180, 80]}, renderViews: [{id: 'globe', camera: {view, projection, position: [0, -300, 0]}}]});
    expect(pickTerrainAt(current, {x: 50, y: 50}, surface)).toMatchObject({position: [0, -256, 0], coordinate: [0, 0, 0], renderViewId: 'globe'});
    expect(surface.intersectRay({origin: [0, -300, 1], direction: [0, 1, 0]})?.coordinate[2]).toBeGreaterThan(0);
    expect(() => pickTerrainAt(frame(), {x: 50, y: 50}, surface)).toThrow(/projection/);
});
