// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test} from 'vitest';
import {createTerrainGlobePoint, interpolateTerrainGlobePoints, projectTerrainGlobeVertex} from '../src/procedures/terrain-globe';
import {getProjectionSurface, PROJECTION_CONSTANTS} from '../src/scene/projection_math';

test.each([0, 1, 100])('affine relief preserves the canonical globe face at exaggeration %s', exaggeration => {
    const coordinates = [[-4000000, 1000000], [0, 1000000], [0, 5000000]] as const;
    const current = coordinates.map((coordinate, index) => createTerrainGlobePoint(coordinate, [200, 1000, -20][index]));
    const previous = coordinates.map((coordinate, index) => createTerrainGlobePoint(coordinate, [0, 300, 100][index]));
    const weights = [0.25, 0.35, 0.4];
    const point = interpolateTerrainGlobePoints(current, weights), before = interpolateTerrainGlobePoints(previous, weights);
    const vertex = Float64Array.from([...point, ...before]);
    for (const blend of [0, 0.3, 1]) {
        const actual = projectTerrainGlobeVertex(vertex, 0, blend, exaggeration, [0, 0, 0]);
        for (const axis of [0, 1, 2]) expect(actual[axis]).toBeCloseTo(weights.reduce((sum, weight, index) => sum + weight * (
            current[index][axis] + (previous[index][axis] - current[index][axis]) * (1 - blend) +
            (current[index][axis + 3] * blend + previous[index][axis + 3] * (1 - blend)) * exaggeration), 0), 12);
    }
    const curved = getProjectionSurface(weights.reduce((sum, weight, index) => sum + weight * coordinates[index][0], 0),
        weights.reduce((sum, weight, index) => sum + weight * coordinates[index][1], 0), 'globe').position;
    expect(Math.hypot(...curved.map((value, axis) => value - point[axis]))).toBeGreaterThan(1);
});

test('authored physical altitude remains independent of terrain relief exaggeration', () => {
    const point = createTerrainGlobePoint([1000000, 2000000], 500), channels = Float64Array.from([...point, ...point]);
    const ground = projectTerrainGlobeVertex(channels, 0, 0.5, 100, [1000000, 2000000, 0]);
    const roof = projectTerrainGlobeVertex(channels, 0, 0.5, 100, [1000000, 2000000, 80]);
    expect(Math.hypot(...roof.map((value, axis) => value - ground[axis]))).toBeCloseTo(80 * PROJECTION_CONSTANTS.globeRadius / PROJECTION_CONSTANTS.earthRadius, 12);
});

test('dyadic globe nodes have bit-identical endpoints at repeated worlds and the antimeridian', () => {
    const reference = createTerrainGlobePoint([0, 0], 123, [0.25, 0.375]);
    for (const world of [-2, -1, 1, 2]) expect(createTerrainGlobePoint([world * 40075016, 0], 123, [0.25 + world, 0.375])).toEqual(reference);
    expect(createTerrainGlobePoint([0, 0], 0, [0, 0.5])).toEqual(createTerrainGlobePoint([0, 0], 0, [1, 0.5]));
});
