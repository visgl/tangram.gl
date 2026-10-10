// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test} from 'vitest';
import {Matrix4} from '@math.gl/core';
import HostFrame from '../src/scene/host_frame';
import {TerrainMeshSurface, pickTerrainAt} from '../src/selection/terrain_surface';
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
