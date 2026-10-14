// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test, vi} from 'vitest';
import {Matrix4} from '@math.gl/core';
import HostFrame from '../src/scene/host_frame';
import {getGeographicProjectionProcedure, PROJECTION_CONSTANTS} from '../src/scene/projection_math';
import {layoutProjectedAnnotations} from '../src/labels/projected-pass';
import type {LabelTile} from '../src/labels/main-pass-types';
import {TerrainSurfaceCollection, TerrainMeshSurface} from '../src/selection/terrain_surface';

test('terrain blocks loaded annotation sightlines; holes stay visible and settled/matrix caches are distinct', () => {
    const tile = createTile(1, [0, 0, 0], {collide: false});
    const surface = new TerrainMeshSurface({projection: 'web-mercator', positions: [-2, -2, -0.5, 2, -2, -0.5, 0, 2, -0.5], indices: [0, 1, 2]});
    const collection = new TerrainSurfaceCollection('web-mercator', [{id: 'ridge', surface}]);
    const frame = createFrame('web-mercator');
    const query = vi.spyOn(collection, 'intersectSegment');
    layoutProjectedAnnotations([tile], frame, {terrainSurface: collection});
    expect(isVisible(tile)).toBe(false); expect(query).toHaveBeenCalledOnce();
    layoutProjectedAnnotations([tile], frame, {terrainSurface: collection});
    expect(query).toHaveBeenCalledOnce();
    frame.renderViews[0].camera.projection = new Matrix4().translate([0.25, 0, 0]);
    layoutProjectedAnnotations([tile], frame, {terrainSurface: collection});
    expect(query).toHaveBeenCalledTimes(2);
    layoutProjectedAnnotations([tile], frame, {terrainSurface: new TerrainSurfaceCollection('web-mercator', [])});
    expect(isVisible(tile)).toBe(true);
});

test('two eyes sharing a position never reuse different matrix sightlines; a visible eye keeps the shared candidate', () => {
    const tile = createTile(1, [0, 0, 0], {collide: false});
    const surface = new TerrainSurfaceCollection('web-mercator', []);
    const query = vi.spyOn(surface, 'intersectSegment').mockReturnValueOnce({coordinate: [0, 0, 0], position: [0, 0, -0.5],
        distance: 0.5, normal: [0, 0, 1], triangleIndex: 0, barycentric: [1, 0, 0], surfaceId: 'ridge'}).mockReturnValue(null);
    layoutProjectedAnnotations([tile], createFrame('web-mercator', 0.5), {terrainSurface: surface});
    expect(query).toHaveBeenCalledTimes(2); expect(isVisible(tile)).toBe(true);
});

test('native point height is physical meters, not polygon height packing, and near-plane occluders do not hide it', () => {
    const tile = createTile(1, [0, 0, 8], {collide: false});
    const frame = createFrame('web-mercator');
    frame.renderViews[0].camera.projection = new Matrix4().scale([1, 1, 1 / 16]);
    const surface = new TerrainSurfaceCollection('web-mercator', [{id: 'before-near', surface: new TerrainMeshSurface({
        projection: 'web-mercator', positions: [-2, -2, -20, 2, -2, -20, 0, 2, -20], indices: [0, 1, 2]})}]);
    const query = vi.spyOn(surface, 'intersectSegment');
    layoutProjectedAnnotations([tile], frame, {terrainSurface: surface});
    expect(isVisible(tile)).toBe(true);
    expect(query).toHaveBeenLastCalledWith([0, 0, -16], [0, 0, 8], {startInset: 0.25, endInset: 0.25});
});

test('globe loaded relief can hide a front-hemisphere label without changing the sphere horizon contract', () => {
    const tile = createTile(1, [0, 0, 0], {collide: false});
    const surface = new TerrainSurfaceCollection('globe', [{id: 'ridge', surface: new TerrainMeshSurface({
        projection: 'globe', positions: [-20, -300, -20, 20, -300, -20, 0, -300, 20], indices: [0, 1, 2]})}]);
    layoutProjectedAnnotations([tile], createFrame('globe'), {terrainSurface: surface});
    expect(isVisible(tile)).toBe(false);
    layoutProjectedAnnotations([tile], createFrame('globe'));
    expect(isVisible(tile)).toBe(true);
});

/** Native SHORT tile positions and billboard attributes, not CPU-projected float vertices. */
function createTile(id: number, position: [number, number, number], options: {
    identity?: string; collide?: boolean; priority?: number; curveOffset?: number; curveAngle?: number;
} = {}): LabelTile {
    const vertices = new Uint8Array(44 * 4);
    const data = new DataView(vertices.buffer);
    for (let index = 0; index < 4; index++) {
        const start = index * 44;
        data.setInt16(start + 4, position[2], true);
        data.setInt16(start + 8, (index % 2 ? 10 : -10) * 256, true);
        data.setInt16(start + 10, (index < 2 ? 10 : -10) * 256, true);
        data.setInt16(start + 14, 1, true);
        for (let stop = 0; stop < 4; stop++) {
            data.setUint16(start + 20 + stop * 2, (options.curveOffset ?? 0) * 64, true);
            data.setInt8(start + 28 + stop, 64);
            data.setInt16(start + 32 + stop * 2, (options.curveAngle ?? 0) * 16384 / Math.PI, true);
        }
    }
    return {coords: {z: 0}, style_z: 0, build_id: id, min: {x: position[0], y: position[1]}, span: {x: 1},
        meshes: {points: [{valid: true, vertex_data: vertices,
            vertex_layout: {stride: 44, offset: {a_position: 0, a_shape: 8, a_offset: 16,
                a_offsets: 20, a_pre_angles: 28, a_angles: 32}},
            labels: {[id]: {container: {label: {id, type: 'point', position: [0, 0], layout: {
                collide: false, priority: options.priority ?? id, projected_collide: options.collide ?? true,
                projected_identity: options.identity, buffer: [0, 0]}}}, ranges: [[0, 4]]}}, upload: vi.fn()}]},
        pending_label_meshes: null, isProxy: () => false, swapPendingLabels: vi.fn()};
}

/** Read the same packed mask that GLSL/WGSL and their selection programs consume. */
function isVisible(tile: LabelTile): boolean {
    const vertices = tile.meshes.points[0].vertex_data;
    if (!vertices) throw new Error('Fixture label must retain packed bytes');
    return new DataView(vertices.buffer).getInt16(14, true) === 1;
}

/** Real camera composition conventions with deterministic CSS-pixel extents. */
function createFrame(type: 'web-mercator' | 'globe', secondEyeScale?: number): HostFrame {
    const view = type === 'globe' ? new Matrix4().lookAt({eye: [0, -1000, 0], center: [0, 0, 0], up: [0, 0, 1]}) : new Matrix4();
    const projection = type === 'globe' ? new Matrix4().ortho({left: -256, right: 256, bottom: -256, top: 256, near: 1, far: 2000})
        .multiplyRight(view) : new Matrix4();
    const position: [number, number, number] = type === 'globe' ? [0, -1000, 0] : [0, 0, 1];
    const camera = {view, projection, position};
    return new HostFrame({viewport: {width: 200, height: 200}, geographicAnchor: {longitude: 0, latitude: 0, zoom: 0.5},
        projection: type === 'globe' ? {type, visibleBounds: [-180, -80, 180, 80]} : {type},
        renderViews: [{id: 'left', camera}, ...(secondEyeScale === undefined ? [] : [{id: 'right', camera: {
            ...camera, projection: new Matrix4(projection).scale([secondEyeScale, 1, 1])}}])]});
}

test('Mercator native markers collide after camera projection and share a stable stereo mask', () => {
    const first = createTile(1, [-0.3, 0, 0]), second = createTile(2, [0.3, 0, 0]);
    layoutProjectedAnnotations([first, second], createFrame('web-mercator'));
    expect(isVisible(second)).toBe(true);
    const stereo = createFrame('web-mercator', 0.1);
    layoutProjectedAnnotations([first, second], stereo);
    expect(isVisible(first)).toBe(true);
    expect(isVisible(second)).toBe(false);
    const uploaded = vi.mocked(second.meshes.points[0].upload).mock.calls.length;
    layoutProjectedAnnotations([first, second], stereo);
    expect(second.meshes.points[0].upload).toHaveBeenCalledTimes(uploaded);
    layoutProjectedAnnotations([first, second], createFrame('web-mercator'));
    expect(isVisible(second)).toBe(true);
});

test('curved text bounds include the shader segment offset instead of the geographic anchor alone', () => {
    const curved = createTile(1, [0, 0, 0], {curveOffset: 40});
    const other = createTile(2, [0.4, 0, 0]);
    layoutProjectedAnnotations([curved, other], createFrame('web-mercator'), {clockwiseRotation: true});
    expect(isVisible(curved)).toBe(true);
    expect(isVisible(other)).toBe(false);
});

test.each([true, false])('curved BYTE pre-angles and SHORT segment rotations match clockwise=%s', clockwiseRotation => {
    const curved = createTile(1, [0, 0, 0], {curveOffset: 40, curveAngle: Math.PI / 2});
    const other = createTile(2, [0, clockwiseRotation ? -0.4 : 0.4, 0]);
    layoutProjectedAnnotations([curved, other], createFrame('web-mercator'), {clockwiseRotation});
    expect(isVisible(curved)).toBe(true);
    expect(isVisible(other)).toBe(false);
});

test('Globe candidates use the composed matrix once and back-side labels never block front labels', () => {
    const mercator = getGeographicProjectionProcedure('web-mercator');
    const front = createTile(3, mercator.project([0, 0, 0]));
    const neighbor = createTile(2, mercator.project([1, 0, 0]));
    const back = createTile(1, mercator.project([180, 0, 0]));
    layoutProjectedAnnotations([front, neighbor, back], createFrame('globe'));
    expect(isVisible(back)).toBe(false);
    expect(isVisible(neighbor)).toBe(true);
    expect(isVisible(front)).toBe(false);
    neighbor.meshes.points[0].labels!['2'].container.label.layout.projected_collide = false;
    front.meshes.points[0].labels!['3'].container.label.layout.projected_collide = false;
    layoutProjectedAnnotations([front, neighbor, back], createFrame('globe'));
    expect(isVisible(front)).toBe(true);
});

test('globe wraps deduplicate one geographic feature; Mercator worlds and elevations stay distinct', () => {
    const first = createTile(1, [0, 0, 0], {identity: 'cities/name', collide: false});
    const duplicate = createTile(2, [2 * Math.PI * PROJECTION_CONSTANTS.mercatorRadius, 0, 0], {identity: 'cities/name', collide: false});
    const elevated = createTile(3, [0, 0, 1000], {identity: 'cities/name', collide: false});
    layoutProjectedAnnotations([duplicate, elevated, first], createFrame('globe'));
    expect(isVisible(first)).toBe(true);
    expect(isVisible(duplicate)).toBe(false);
    expect(isVisible(elevated)).toBe(true);
    const mercatorFrame = createFrame('web-mercator');
    mercatorFrame.renderViews[0].camera.projection = new Matrix4().scale([1 / (4 * Math.PI * PROJECTION_CONSTANTS.mercatorRadius), 1, 1]);
    layoutProjectedAnnotations([first, duplicate], mercatorFrame);
    expect(isVisible(first)).toBe(true);
    expect(isVisible(duplicate)).toBe(true);
    const copy = createTile(4, [0.6, 0, 0], {identity: 'cities/name', collide: false});
    // Deliberately distant source anchors must not be merged at high source detail.
    first.coords.z = copy.coords.z = 24;
    layoutProjectedAnnotations([first, copy], createFrame('web-mercator'));
    expect(isVisible(copy)).toBe(true);
});
