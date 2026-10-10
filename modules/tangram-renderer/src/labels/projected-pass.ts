// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {Matrix4} from '@math.gl/core';
import type HostFrame from '../scene/host_frame';
import type {LabelMesh, LabelTile, MeshLabel} from './main-pass-types';
import {getGeographicProjectionProcedure, PROJECTION_CONSTANTS, projectGeographicPosition} from '../scene/projection_math';

type Bounds = [number, number, number, number];
/** One worker identity may have multiple atlas/outline mesh ranges. */
interface Candidate {
    id: string;
    label: MeshLabel;
    tile: LabelTile;
    parts: {mesh: LabelMesh; label: MeshLabel}[];
    boxes: Map<string, Bounds>;
    anchor: [number, number];
    height: number;
    shown?: boolean;
}

/** Immutable domain eligibility must survive later hide/show writes. */
const eligible = new WeakMap<LabelMesh, Map<MeshLabel, boolean>>();

/**
 * Lay out projected billboard candidates in CSS pixels before either eye draws.
 * One shared mask is collision-free in every eye, avoiding GPU buffer mutations
 * between queued stereo draws. Worker snapshots and source geometry stay immutable.
 * @returns Whether masks changed or pending label meshes were activated.
 */
export function layoutProjectedAnnotations(tiles: readonly LabelTile[], frame: HostFrame,
    {clockwiseRotation = false}: {clockwiseRotation?: boolean} = {}): boolean {
    const cameras = frame.renderViews.map(eye => ({eye,
        matrix: frame.projection.type === 'globe' ? new Matrix4(Array.from(eye.camera.projection)) :
            new Matrix4(Array.from(eye.camera.projection)).multiplyRight(Array.from(eye.camera.view))}));
    const candidates = new Map<string, Candidate>();
    for (const tile of tiles) {
        const meshes = {...tile.meshes, ...tile.pending_label_meshes};
        for (const [style, parts] of Object.entries(meshes)) {
            // A resident proxy may no longer draw this style once its child labels are ready.
            if (tile.isProxy() && tile.shouldProxyForStyle?.(style) === false) continue;
            for (const mesh of parts) {
                if (!mesh.valid || !mesh.labels || mesh.vertex_layout.offset.a_shape === undefined ||
                    (mesh.vertex_layout.offset.a_projected_position === undefined && mesh.vertex_layout.offset.a_position === undefined)) continue;
                for (const label of Object.values(mesh.labels)) {
                    const id = String(label.container.label.id);
                    let candidate = candidates.get(id);
                    if (!candidate) {
                        const position = label.container.label.position;
                        const unitsPerMeter = 4096 * 2 ** tile.coords.z / (2 * Math.PI * 6378137);
                        const first = label.ranges[0]?.[0];
                        const data = new DataView(mesh.vertex_data.buffer, mesh.vertex_data.byteOffset, mesh.vertex_data.byteLength);
                        const height = label.container.label.layout.projected_height ?? (first === undefined ||
                            mesh.vertex_layout.offset.a_position === undefined ? 0 : data.getInt16(first + mesh.vertex_layout.offset.a_position + 4, true));
                        candidate = {id, label, tile, parts: [], boxes: new Map(), height, anchor: [
                            tile.min.x + position[0] / unitsPerMeter, tile.min.y + position[1] / unitsPerMeter]};
                        candidates.set(id, candidate);
                    }
                    candidate.parts.push({mesh, label});
                    for (const {eye, matrix} of cameras) {
                        const box = getScreenBounds(mesh, label, tile, frame, eye.camera.position, matrix,
                            eye.viewport.width, eye.viewport.height, clockwiseRotation);
                        if (box) candidate.boxes.set(eye.id, unionBounds(candidate.boxes.get(eye.id), box));
                    }
                }
            }
        }
    }
    const sorted = [...candidates.values()].sort((left, right) =>
        left.label.container.label.layout.priority - right.label.container.label.layout.priority ||
        left.tile.build_id - right.tile.build_id || Number(left.id) - Number(right.id));
    const identities = new Map<string, Candidate[]>();
    const repeatGroups = new Map<string, Candidate[]>();
    const grids = new Map<string, Map<string, Set<Candidate>>>();
    const placing = new Set<Candidate>();
    function place(candidate: Candidate): boolean {
        if (candidate.shown !== undefined) return candidate.shown;
        if (placing.has(candidate)) return false;
        placing.add(candidate);
        const linked = candidates.get(String(candidate.label.container.linked));
        const required = linked && String(linked.label.container.linked) === candidate.id;
        const group = required ? [candidate, linked] : [candidate];
        if (linked && !required && !place(linked)) {
            candidate.shown = false;
            placing.delete(candidate);
            return false;
        }
        const show = group.every(member => {
            const layout = member.label.container.label.layout;
            return member.boxes.size > 0 &&
                !(identities.get(layout.projected_identity ?? '') ?? []).some(previous => isDuplicate(member, previous, frame.projection.type === 'globe')) &&
                !(repeatGroups.get(layout.repeat_group ?? '') ?? []).some(previous => repeats(member, previous));
        }) &&
            group.every(member => member.label.container.label.layout.projected_collide === false ||
                [...member.boxes].every(([eye, box]) => {
                    const grid = grids.get(eye);
                    if (!grid) return true;
                    const nearby = new Set<Candidate>();
                    for (const cell of cells(box, frame.getRenderView(eye).viewport)) for (const previous of grid.get(cell) ?? []) nearby.add(previous);
                    return [...nearby].every(previous => {
                        if (previous === linked) return true; // Optional text may overlap its own marker.
                        const other = previous.boxes.get(eye)!;
                        return !intersects(box, other);
                    });
                }));
        for (const member of group) {
            member.shown = show;
            if (!show) continue;
            const layout = member.label.container.label.layout;
            if (layout.projected_identity) {
                const copies = identities.get(layout.projected_identity) ?? [];
                copies.push(member);
                identities.set(layout.projected_identity, copies);
            }
            if (layout.repeat_group && layout.repeat_distance) {
                const repeated = repeatGroups.get(layout.repeat_group) ?? [];
                repeated.push(member);
                repeatGroups.set(layout.repeat_group, repeated);
            }
            for (const [eye, box] of member.boxes) {
                let grid = grids.get(eye);
                if (!grid) grids.set(eye, grid = new Map());
                for (const cell of cells(box, frame.getRenderView(eye).viewport)) {
                    let bucket = grid.get(cell);
                    if (!bucket) grid.set(cell, bucket = new Set());
                    bucket.add(member);
                }
            }
        }
        placing.delete(candidate);
        return show;
    }
    sorted.forEach(place);
    const uploads = new Set<LabelMesh>();
    for (const candidate of sorted) for (const {mesh, label} of candidate.parts) {
        const view = new DataView(mesh.vertex_data.buffer, mesh.vertex_data.byteOffset, mesh.vertex_data.byteLength);
        for (const [start, count] of label.ranges) for (let index = 0; index < count; index++) {
            const offset = start + index * mesh.vertex_layout.stride + mesh.vertex_layout.offset.a_shape + 6;
            const shown = candidate.shown && eligible.get(mesh)?.get(label) ? 1 : 0;
            if (view.getInt16(offset, true) !== shown) {
                view.setInt16(offset, shown, true);
                uploads.add(mesh);
            }
        }
    }
    uploads.forEach(mesh => mesh.upload());
    const pending = tiles.some(tile => tile.pending_label_meshes !== null);
    tiles.forEach(tile => tile.swapPendingLabels());
    return uploads.size > 0 || pending;
}

/** Compare only matching source/style identities at the same quantized geographic anchor. */
function isDuplicate(candidate: Candidate, previous: Candidate, globe: boolean): boolean {
    const identity = candidate.label.container.label.layout.projected_identity;
    if (!identity || identity !== previous.label.container.label.layout.projected_identity || candidate.tile === previous.tile) return false;
    if (candidate.height !== previous.height) return false;
    // At most two source quantization units tolerate independently encoded buffered points.
    const tolerance = 2 * 2 * Math.PI * 6378137 / (4096 * 2 ** Math.min(candidate.tile.coords.z, previous.tile.coords.z));
    const circumference = 2 * Math.PI * PROJECTION_CONSTANTS.mercatorRadius;
    const horizontal = candidate.anchor[0] - previous.anchor[0];
    // Wrapped Mercator worlds draw separately; all globe copies project to one surface.
    const difference = globe ? horizontal - Math.round(horizontal / circumference) * circumference : horizontal;
    return Math.hypot(difference, candidate.anchor[1] - previous.anchor[1]) <= tolerance;
}

/** Authored repeat groups retain their CSS-pixel spacing in each projected eye. */
function repeats(candidate: Candidate, previous: Candidate): boolean {
    const layout = candidate.label.container.label.layout;
    if (!layout.repeat_distance || !layout.repeat_group || layout.repeat_group !== previous.label.container.label.layout.repeat_group) return false;
    return [...candidate.boxes].some(([eye, box]) => {
        const other = previous.boxes.get(eye);
        return other !== undefined && Math.hypot((box[0] + box[2] - other[0] - other[2]) / 2,
            (box[1] + box[3] - other[1] - other[3]) / 2) < layout.repeat_distance!;
    });
}

/** Reconstruct the shader's rotated pixel quad from retained packed geometry, including atlas ranges. */
function getScreenBounds(mesh: LabelMesh, label: MeshLabel, tile: LabelTile, frame: HostFrame,
    eye: readonly number[], matrix: Matrix4, width: number, height: number,
    clockwiseRotation: boolean): Bounds | null {
    let eligibility = eligible.get(mesh);
    if (!eligibility) eligible.set(mesh, eligibility = new Map());
    const data = new DataView(mesh.vertex_data.buffer, mesh.vertex_data.byteOffset, mesh.vertex_data.byteLength);
    const {stride, offset} = mesh.vertex_layout;
    const first = label.ranges[0]?.[0];
    if (first === undefined) return null;
    if (!eligibility.has(label)) eligibility.set(label, data.getInt16(first + offset.a_shape + 6, true) !== 0);
    if (!eligibility.get(label)) return null;
    let bounds: Bounds | undefined;
    for (const [start, count] of label.ranges) for (let index = 0; index < count; index++) {
        const base = start + index * stride;
        let anchor: [number, number, number];
        if (offset.a_projected_position !== undefined) {
            anchor = [data.getFloat32(base + offset.a_projected_position, true),
                data.getFloat32(base + offset.a_projected_position + 4, true),
                data.getFloat32(base + offset.a_projected_position + 8, true)];
        } else {
            const scale = 2 * Math.PI * PROJECTION_CONSTANTS.mercatorRadius / (4096 * 2 ** tile.coords.z);
            anchor = [tile.min.x + data.getInt16(base + offset.a_position, true) * scale,
                tile.min.y + data.getInt16(base + offset.a_position + 2, true) * scale,
                data.getInt16(base + offset.a_position + 4, true)];
            if (frame.projection.type === 'globe') {
                anchor = projectGeographicPosition(getGeographicProjectionProcedure('web-mercator').unproject(anchor), 'globe');
                if (isGlobeOccluded(anchor, eye)) return null;
            }
        }
        const position = matrix.transform([...anchor, 1]);
        if (position[3] <= 0 || position[2] < -position[3] || position[2] > position[3]) return null;
        const shape = base + offset.a_shape;
        // Retain the existing GLSL clockwise and WGSL counter-clockwise sprite conventions.
        const angle = data.getInt16(shape + 4, true) / 4096 * (clockwiseRotation ? -1 : 1);
        let point: [number, number] = [data.getInt16(shape, true) / 256, data.getInt16(shape + 2, true) / 256];
        const displacement: [number, number] = offset.a_offset === undefined ? [0, 0] :
            [data.getInt16(base + offset.a_offset, true), -data.getInt16(base + offset.a_offset + 2, true)];
        if (offset.a_offsets !== undefined && data.getUint16(base + offset.a_offsets, true) !== 0) {
            const zoom = Math.max(0, Math.min(1, frame.geographicAnchor.zoom - tile.style_z));
            const preAngle = mixCurve(Array.from({length: 4}, (_, index) =>
                data.getInt8(base + offset.a_pre_angles + index) * Math.PI / 128), zoom);
            const curveAngle = mixCurve(Array.from({length: 4}, (_, index) =>
                data.getInt16(base + offset.a_angles + index * 2, true) * Math.PI / 16384), zoom);
            point = rotate(point, preAngle * (clockwiseRotation ? -1 : 1));
            point[0] += mixCurve(Array.from({length: 4}, (_, index) => data.getUint16(base + offset.a_offsets + index * 2, true) / 64), zoom);
            point = rotate(point, curveAngle * (clockwiseRotation ? -1 : 1));
            const rotatedOffset = rotate(displacement, angle);
            point = [point[0] + rotatedOffset[0], point[1] + rotatedOffset[1]];
        } else point = rotate([point[0] + displacement[0], point[1] + displacement[1]], angle);
        const screenX = (position[0] / position[3] + 1) * width / 2 + point[0];
        const screenY = (1 - position[1] / position[3]) * height / 2 - point[1];
        bounds = unionBounds(bounds, [screenX, screenY, screenX, screenY]);
    }
    if (!bounds) return null;
    const buffer = label.container.label.layout.buffer ?? [0, 0];
    bounds = [bounds[0] - buffer[0] - 1, bounds[1] - buffer[1] - 1,
        bounds[2] + buffer[0] + 1, bounds[3] + buffer[1] + 1];
    return bounds[2] < 0 || bounds[0] > width || bounds[3] < 0 || bounds[1] > height ? null : bounds;
}

/** Mirror the production shader's finite eye-to-anchor sphere segment and f32 tolerance. */
function isGlobeOccluded(position: readonly number[], eye: readonly number[]): boolean {
    const radius = PROJECTION_CONSTANTS.globeRadius;
    if (Math.hypot(...eye) <= radius) return false;
    const segment = position.map((value, index) => value - eye[index]);
    const squaredLength = segment.reduce((sum, value) => sum + value * value, 0);
    if (squaredLength === 0) return false;
    const amount = Math.max(0, Math.min(1, -eye.reduce((sum, value, index) => sum + value * segment[index], 0) / squaredLength));
    const closest = eye.map((value, index) => value * (1 - amount) + position[index] * amount);
    return closest.reduce((sum, value) => sum + value * value, 0) / radius ** 2 < 1 - 1e-6;
}
/** Apply the same clockwise GLSL or counterclockwise WGSL billboard convention. */
function rotate(point: readonly [number, number], angle: number): [number, number] {
    return [point[0] * Math.cos(angle) - point[1] * Math.sin(angle), point[0] * Math.sin(angle) + point[1] * Math.cos(angle)];
}
/** Preserve the shader's 0/.33/.66/.99 piecewise interpolation, including its last interval. */
function mixCurve(values: readonly number[], zoom: number): number {
    const mix = (left: number, right: number, amount: number) => left * (1 - amount) + right * amount;
    return zoom < 0.33 ? mix(values[0], values[1], 3 * zoom) : mix(values[1],
        mix(values[2], values[3], 3 * (Math.max(zoom, 0.66) - 0.66)), 3 * (Math.max(0.33, Math.min(0.66, zoom)) - 0.33));
}

/** Conservative rotated-quad broad-phase; touching padded edges do not collide. */
function intersects(left: Bounds, right: Bounds): boolean {
    return left[0] < right[2] && left[2] > right[0] && left[1] < right[3] && left[3] > right[1];
}
/** Join ranges belonging to one atlas/outline annotation. */
function unionBounds(left: Bounds | undefined, right: Bounds): Bounds {
    return left ? [Math.min(left[0], right[0]), Math.min(left[1], right[1]),
        Math.max(left[2], right[2]), Math.max(left[3], right[3])] : right;
}
/** Screen-cell membership avoids comparing every label against every previous label. */
function* cells(box: Bounds, viewport: {width: number; height: number}): Generator<string> {
    // Padding and offsets can greatly exceed a viewport; index only visible cells.
    for (let x = Math.floor(Math.max(0, box[0]) / 64); x <= Math.floor(Math.min(viewport.width, box[2]) / 64); x++) {
        for (let y = Math.floor(Math.max(0, box[1]) / 64); y <= Math.floor(Math.min(viewport.height, box[3]) / 64); y++) yield `${x},${y}`;
    }
}
