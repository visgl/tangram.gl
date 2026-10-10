// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test, vi} from 'vitest';
import {Matrix4} from '@math.gl/core';
import HostFrame from '../src/scene/host_frame';
import {layoutProjectedAnnotations} from '../src/labels/projected-pass';
import type {LabelTile, LabelMesh} from '../src/labels/main-pass-types';

/** Hermetic projected point quad and its worker snapshot; no canvas or service is needed. */
function tile(id: number, x = 0, properties: {identity?: string; priority?: number; collide?: boolean;
    linked?: number; projectedX?: number; domain?: boolean; buffer?: [number, number]; rotation?: number} = {}): LabelTile {
    const vertices = new Uint8Array(24 * 4);
    const data = new DataView(vertices.buffer);
    for (let index = 0; index < 4; index++) {
        const offset = index * 24;
        data.setFloat32(offset, properties.projectedX ?? x, true);
        data.setInt16(offset + 12, (index % 2 ? 10 : -10) * 256, true);
        data.setInt16(offset + 14, (index < 2 ? 10 : -10) * 256, true);
        data.setInt16(offset + 16, (properties.rotation ?? 0) * 4096, true);
        data.setInt16(offset + 18, properties.domain === false ? 0 : 1, true);
    }
    const mesh: LabelMesh = {valid: true, vertex_data: vertices,
        vertex_layout: {stride: 24, offset: {a_projected_position: 0, a_shape: 12, a_offset: 20}},
        labels: {[id]: {container: {label: {id, type: 'point', position: [x, 0],
            layout: {collide: false, projected_collide: properties.collide ?? true,
                projected_identity: properties.identity, priority: properties.priority ?? id,
                buffer: properties.buffer ?? [0, 0]}}, linked: properties.linked}, ranges: [[0, 4]]}},
        upload: vi.fn()};
    return {coords: {z: 2}, style_z: 6, build_id: id, min: {x: 0, y: 0}, span: {x: 1},
        meshes: {points: [mesh]}, pending_label_meshes: null, isProxy: () => false, swapPendingLabels: vi.fn()};
}
/** Ordinary ortho frame, optionally with a differently scaled second eye. */
function frame(rightScale?: number, translation = 0): HostFrame {
    const camera = {view: new Matrix4().translate([translation, 0, 0]), projection: new Matrix4(), position: [0, 0, 1] as const};
    return new HostFrame({viewport: {width: 200, height: 200}, geographicAnchor: {longitude: 0, latitude: 0, zoom: 6},
        projection: {type: 'projected', visibleBounds: [-180, -80, 180, 80]}, tileZoom: 2,
        renderViews: [{id: 'left', camera}, ...(rightScale === undefined ? [] : [{id: 'right', camera: {
            ...camera, projection: new Matrix4().scale([rightScale, 1, 1])}}])]});
}
/** Inspect the entire signed-short mask, not only its low byte. */
function mask(value: LabelTile): number[] {
    const mesh = value.meshes.points[0];
    const data = new DataView(mesh.vertex_data.buffer);
    return Array.from({length: 4}, (_, index) => data.getInt16(index * 24 + 18, true));
}

test('priority, rotation and padding resolve in screen space, independent of tile/style zoom', () => {
    const low = tile(1, 0, {priority: 10, rotation: Math.PI / 4});
    const high = tile(2, 0.18, {priority: 1, buffer: [4, 4]});
    const snapshot = structuredClone(low.meshes.points[0].labels);
    layoutProjectedAnnotations([low, high], frame());
    expect(mask(low)).toEqual([0, 0, 0, 0]);
    expect(mask(high)).toEqual([1, 1, 1, 1]);
    expect(low.meshes.points[0].labels).toEqual(snapshot);
    expect(low.meshes.points[0].upload).toHaveBeenCalledOnce();
    layoutProjectedAnnotations([high, low], frame());
    expect(low.meshes.points[0].upload).toHaveBeenCalledOnce();
});

test('camera movement restores hidden candidates but never resurrects out-of-domain symbols', () => {
    const visible = tile(1), domain = tile(2, 0.5, {domain: false});
    layoutProjectedAnnotations([visible, domain], frame(undefined, 4));
    expect(mask(visible)).toEqual([0, 0, 0, 0]);
    layoutProjectedAnnotations([visible, domain], frame());
    expect(mask(visible)).toEqual([1, 1, 1, 1]);
    expect(mask(domain)).toEqual([0, 0, 0, 0]);
});

test('a single shared mask rejects collisions in either eye, even if the first eye does not collide', () => {
    const left = tile(1, -0.3), right = tile(2, 0.3);
    layoutProjectedAnnotations([left, right], frame());
    expect(mask(right)).toEqual([1, 1, 1, 1]);
    layoutProjectedAnnotations([left, right], frame(0.1));
    expect(mask(left)).toEqual([1, 1, 1, 1]);
    expect(mask(right)).toEqual([0, 0, 0, 0]);
});

test('authored repeat distance applies in CSS pixels even when collision is disabled', () => {
    const first = tile(1, -0.3, {collide: false}), second = tile(2, 0.3, {collide: false});
    for (const value of [first, second]) Object.assign(value.meshes.points[0].labels![value.build_id].container.label.layout,
        {repeat_group: 'city/name', repeat_distance: 80});
    layoutProjectedAnnotations([first, second], frame());
    expect(mask(second)).toEqual([0, 0, 0, 0]);
    second.meshes.points[0].labels!['2'].container.label.layout.repeat_group = 'other/name';
    layoutProjectedAnnotations([first, second], frame());
    expect(mask(second)).toEqual([1, 1, 1, 1]);
});

test('buffered cross-tile copies deduplicate even with collide false; unrelated IDs and multipoints survive', () => {
    const first = tile(1, 0, {identity: 'source/style/feature', collide: false});
    const duplicate = tile(2, 0, {identity: 'source/style/feature', collide: false});
    const distant = tile(3, 100, {identity: 'source/style/feature', projectedX: 0.5, collide: false});
    const other = tile(4, 0, {identity: 'other-source/style/feature', collide: false});
    const anonymous = tile(5, 0, {collide: false});
    layoutProjectedAnnotations([duplicate, distant, other, anonymous, first], frame());
    expect(mask(first)).toEqual([1, 1, 1, 1]);
    expect(mask(duplicate)).toEqual([0, 0, 0, 0]);
    for (const value of [distant, other, anonymous]) expect(mask(value)).toEqual([1, 1, 1, 1]);
});

test('required point/text pairs are atomic; optional text may hide without suppressing its parent', () => {
    const blocker = tile(1, 0.2);
    const point = tile(2, -0.2, {linked: 3});
    const text = tile(3, 0.2, {linked: 2});
    layoutProjectedAnnotations([blocker, point, text], frame());
    expect(mask(point)).toEqual([0, 0, 0, 0]);
    expect(mask(text)).toEqual([0, 0, 0, 0]);
    point.meshes.points[0].labels!['2'].container.linked = null;
    layoutProjectedAnnotations([blocker, point, text], frame());
    expect(mask(point)).toEqual([1, 1, 1, 1]);
    expect(mask(text)).toEqual([0, 0, 0, 0]);
    const optionalPoint = tile(4);
    const overlappingText = tile(5, 0, {linked: 4});
    layoutProjectedAnnotations([optionalPoint, overlappingText], frame());
    expect(mask(optionalPoint)).toEqual([1, 1, 1, 1]);
    expect(mask(overlappingText)).toEqual([1, 1, 1, 1]);
});

test('pending atlases, multiple ranges and invalid/empty meshes are handled without changing topology', () => {
    const value = tile(1);
    value.pending_label_meshes = value.meshes;
    value.meshes = {};
    layoutProjectedAnnotations([value], frame());
    expect(value.swapPendingLabels).toHaveBeenCalledOnce();
    const mesh = value.pending_label_meshes.points[0];
    mesh.labels!['1'].ranges = [];
    layoutProjectedAnnotations([value], frame());
    mesh.valid = false;
    layoutProjectedAnnotations([value], frame());
    layoutProjectedAnnotations([], frame());
});

test('large authored padding indexes only visible cells while retaining conservative collisions', () => {
    const padded = tile(1, 0, {buffer: [1e8, 1e8]});
    const other = tile(2, 0.5);
    layoutProjectedAnnotations([padded, other], frame());
    expect(mask(other)).toEqual([0, 0, 0, 0]);
});
