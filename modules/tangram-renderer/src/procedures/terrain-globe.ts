// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {getProjectionSurface, PROJECTION_CONSTANTS} from '../scene/projection_math';

/** Zero-relief globe point followed by the common-space displacement per unit exaggeration. */
export function createTerrainGlobePoint(coordinate: readonly [number, number], height: number, normalized?: readonly [number, number]): Float64Array {
    const circumference = 2 * Math.PI * PROJECTION_CONSTANTS.mercatorRadius;
    const x = normalized ? (normalized[0] - Math.floor(normalized[0]) - 0.5) * circumference : coordinate[0];
    const y = normalized ? (0.5 - normalized[1]) * circumference : coordinate[1];
    const base = getProjectionSurface(x, y, 'globe').position;
    return Float64Array.from([...base, ...base.map(component => component * height / PROJECTION_CONSTANTS.earthRadius)]);
}

/** Preserve a canonical face's affine globe plane rather than projecting a new cut back onto the sphere. */
export function interpolateTerrainGlobePoints(points: readonly Float64Array[], weights: ArrayLike<number>): Float64Array {
    return Float64Array.from({length: points[0].length}, (_value, channel) =>
        points.reduce((sum, point, corner) => sum + point[channel] * weights[corner], 0));
}

/** Evaluate the same current/previous affine surface as the shader, with independent authored physical altitude. */
export function projectTerrainGlobeVertex(channels: ArrayLike<number>, vertex: number, blend: number, exaggeration: number,
    coordinate: readonly [number, number, number]): [number, number, number] {
    const offset = vertex * 12;
    const direction = coordinate[2] ? getProjectionSurface(coordinate[0], coordinate[1], 'globe').position : [0, 0, 0];
    const component = (axis: number) =>
        channels[offset + 6 + axis] * (1 - blend) + channels[offset + axis] * blend +
        (channels[offset + 9 + axis] * (1 - blend) + channels[offset + 3 + axis] * blend) * exaggeration +
        direction[axis] * coordinate[2] / PROJECTION_CONSTANTS.earthRadius;
    return [component(0), component(1), component(2)];
}
