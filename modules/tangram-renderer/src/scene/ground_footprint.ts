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
    return calculatePlanarVolumeBounds(camera, [0, 0], limits);
}

/**
 * Bounds the finite frustum intersected with a closed elevation slab. Heights
 * are physical meters; XY uses EPSG:3857 meters. This conservative candidate
 * footprint includes elevated-only geometry, not terrain surface intersections.
 * Optional horizontal limits clip the convex footprint, not its bounding box.
 */
export function calculatePlanarVolumeBounds(camera: HostCamera,
    elevationRange: readonly [number, number], limits?: Bounds): Bounds | null {
    const [minimumElevation, maximumElevation] = elevationRange;
    if (elevationRange.length !== 2 || !Number.isFinite(minimumElevation) ||
        !Number.isFinite(maximumElevation) || minimumElevation > maximumElevation) {
        throw new Error('Elevation range requires two finite ordered heights');
    }
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
    const points: Point[] = corners.filter(point => point[2] >= minimumElevation &&
        point[2] <= maximumElevation).map(point => [point[0], point[1]]);
    for (let index = 0; index < corners.length; index++) {
        for (const bit of [1, 2, 4]) {
            const adjacent = index ^ bit;
            if (adjacent < index) continue;
            const start = corners[index];
            const end = corners[adjacent];
            for (const elevation of [minimumElevation, maximumElevation]) {
                if (start[2] === elevation) points.push([start[0], start[1]]);
                if (end[2] === elevation) points.push([end[0], end[1]]);
                if ((start[2] < elevation && end[2] > elevation) ||
                    (start[2] > elevation && end[2] < elevation)) {
                    const parameter = (elevation - start[2]) / (end[2] - start[2]);
                    points.push([start[0] + parameter * (end[0] - start[0]),
                        start[1] + parameter * (end[1] - start[1])]);
                }
            }
        }
    }
    let polygon = convexHull(points);
    if (polygon.length < 3) return null;
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

/** Monotone-chain hull removes duplicate/interior projected frustum corners. */
function convexHull(points: Point[]): Point[] {
    const sorted = points.sort((left, right) => left[0] - right[0] || left[1] - right[1])
        .filter((point, index, list) => index === 0 || point[0] !== list[index - 1][0] || point[1] !== list[index - 1][1]);
    const cross = (origin: Point, first: Point, second: Point): number =>
        (first[0] - origin[0]) * (second[1] - origin[1]) - (first[1] - origin[1]) * (second[0] - origin[0]);
    const half = (list: Point[]): Point[] => {
        const hull: Point[] = [];
        for (const point of list) {
            while (hull.length >= 2 && cross(hull[hull.length - 2], hull[hull.length - 1], point) <= 0) hull.pop();
            hull.push(point);
        }
        return hull;
    };
    const lower = half(sorted), upper = half([...sorted].reverse());
    return [...lower.slice(0, -1), ...upper.slice(0, -1)];
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
