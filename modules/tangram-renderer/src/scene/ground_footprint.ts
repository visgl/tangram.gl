// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {Matrix4} from '@math.gl/core';
import type {HostCamera} from '../types';
import type {Bounds} from '../utils/geo';

type Point = [number, number];

/**
 * Intersects all twelve edges of a finite host frustum with EPSG:3857 ground.
 * Optional meter-space limits clip the resulting convex polygon before bounds
 * are calculated. Null means no ground area, not an unknown footprint.
 * Matrices use column-major OpenGL clip coordinates, also on the WebGPU path.
 */
export function calculatePlanarGroundBounds(camera: HostCamera, limits?: Bounds): Bounds | null {
    if (camera.view.length !== 16 || camera.projection.length !== 16 ||
        !Array.from(camera.view).every(Number.isFinite) || !Array.from(camera.projection).every(Number.isFinite)) {
        throw new Error('Ground footprint requires finite camera matrices');
    }
    if (limits && (![limits.sw.x, limits.sw.y, limits.ne.x, limits.ne.y].every(Number.isFinite) ||
        limits.sw.x > limits.ne.x || limits.sw.y > limits.ne.y)) {
        throw new Error('Ground footprint limits must be finite ordered bounds');
    }
    const inverse = new Matrix4().copy(camera.projection).multiplyRight(camera.view);
    if (!Number.isFinite(inverse.determinant()) || inverse.determinant() === 0) {
        throw new Error('Ground footprint camera is singular');
    }
    inverse.invert();
    const corners: number[][] = [];
    for (const depth of [-1, 1]) {
        for (const vertical of [-1, 1]) {
            for (const horizontal of [-1, 1]) {
                const homogeneous = inverse.transform([horizontal, vertical, depth, 1]);
                const point = Array.from(homogeneous).slice(0, 3).map(value => value / homogeneous[3]);
                if (!point.every(Number.isFinite) || homogeneous[3] <= 0) {
                    throw new Error('Ground footprint requires a finite near and far frustum');
                }
                corners.push(point);
            }
        }
    }
    let polygon: Point[] = [];
    for (let index = 0; index < corners.length; index++) {
        for (const bit of [1, 2, 4]) {
            const adjacent = index ^ bit;
            if (adjacent < index) continue;
            const start = corners[index];
            const end = corners[adjacent];
            if (start[2] === 0) polygon.push([start[0], start[1]]);
            if (end[2] === 0) polygon.push([end[0], end[1]]);
            if ((start[2] < 0 && end[2] > 0) || (start[2] > 0 && end[2] < 0)) {
                const parameter = start[2] / (start[2] - end[2]);
                polygon.push([start[0] + parameter * (end[0] - start[0]),
                    start[1] + parameter * (end[1] - start[1])]);
            }
        }
    }
    if (polygon.length < 3) return null;
    const center = polygon.reduce((sum, point) => [sum[0] + point[0] / polygon.length,
        sum[1] + point[1] / polygon.length], [0, 0]);
    polygon.sort((left, right) => Math.atan2(left[1] - center[1], left[0] - center[0]) -
        Math.atan2(right[1] - center[1], right[0] - center[0]));
    if (limits) {
        polygon = clipPolygon(polygon, 0, limits.sw.x, true);
        polygon = clipPolygon(polygon, 0, limits.ne.x, false);
        polygon = clipPolygon(polygon, 1, limits.sw.y, true);
        polygon = clipPolygon(polygon, 1, limits.ne.y, false);
    }
    if (polygon.length < 3) return null;
    // Use a local origin to avoid cancellation for meter coordinates near the antimeridian.
    const origin = polygon[0];
    const twiceArea = polygon.reduce((area, point, index) => {
        const next = polygon[(index + 1) % polygon.length];
        return area + (point[0] - origin[0]) * (next[1] - origin[1]) -
            (point[1] - origin[1]) * (next[0] - origin[0]);
    }, 0);
    if (twiceArea === 0) return null;
    const bounds = {
        sw: {x: Math.min(...polygon.map(point => point[0])), y: Math.min(...polygon.map(point => point[1]))},
        ne: {x: Math.max(...polygon.map(point => point[0])), y: Math.max(...polygon.map(point => point[1]))}
    };
    return bounds.ne.x > bounds.sw.x && bounds.ne.y > bounds.sw.y ? bounds : null;
}

/** Clips a convex ground polygon against one axis-aligned half-plane. */
function clipPolygon(polygon: Point[], axis: 0 | 1, boundary: number, keepGreater: boolean): Point[] {
    const result: Point[] = [];
    const inside = (point: Point) => keepGreater ? point[axis] >= boundary : point[axis] <= boundary;
    for (let index = 0; index < polygon.length; index++) {
        const start = polygon[index];
        const end = polygon[(index + 1) % polygon.length];
        if (inside(start)) result.push(start);
        if (inside(start) !== inside(end)) {
            const parameter = (boundary - start[axis]) / (end[axis] - start[axis]);
            const point: Point = [start[0] + parameter * (end[0] - start[0]),
                start[1] + parameter * (end[1] - start[1])];
            point[axis] = boundary;
            result.push(point);
        }
    }
    return result;
}
