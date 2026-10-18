// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test} from 'vitest';
import {refineTerrainTransitionTopology} from '../src/map-logic/terrain-transition-topology';
import type {TerrainGroundTopology} from '../src/map-logic/terrain-ground-topology';

/** Unit-square topologies differ only in the visible diagonal. */
function topology(reverse = false): TerrainGroundTopology {
    const positions = new Float64Array([0, 0, 1, 0, 1, 1, 0, 1]);
    return {positions, samplePositions: positions, normalizedPositions: positions, sampleOffset: 0,
        indices: new Uint32Array(reverse ? [0, 1, 3, 1, 2, 3] : [0, 1, 2, 0, 2, 3])};
}

test('different endpoint diagonals form a common refinement without changing either endpoint plane', () => {
    const current = topology(), previous = topology(true);
    const result = refineTerrainTransitionTopology(current, previous, 100);
    expect(result).not.toBeNull();
    if (!result) throw new Error('Expected common terrain refinement');
    expect(result.topology.indices.length / 3).toBe(4);
    let area = 0;
    for (let offset = 0; offset < result.topology.indices.length; offset += 3) {
        const positions = Array.from(result.topology.indices.subarray(offset, offset + 3), index => result.topology.positions.subarray(index * 2, index * 2 + 2));
        area += ((positions[1][0] - positions[0][0]) * (positions[2][1] - positions[0][1]) - (positions[1][1] - positions[0][1]) * (positions[2][0] - positions[0][0])) / 2;
    }
    expect(area).toBe(1);
    const middle = Array.from(result.topology.positions).findIndex((value, index, values) => index % 2 === 0 && value === 0.5 && values[index + 1] === 0.5) / 2;
    const interpolate = (reference: typeof result.current[number], heights: number[]) => reference.indices.reduce((sum, index, corner) => sum + heights[index] * reference.weights[corner], 0);
    expect(interpolate(result.current[middle], [0, 0, 100, 0])).toBe(50);
    expect(interpolate(result.previous[middle]!, [0, 10, 0, 10])).toBe(10);
    expect(current.indices).toEqual(new Uint32Array([0, 1, 2, 0, 2, 3]));
});

test('unchanged topology is allocation-free and new coverage is not discarded to match old footprints', () => {
    expect(refineTerrainTransitionTopology(topology(), topology(), 100)).toBeNull();
    const previous = topology(); previous.indices = new Uint32Array([0, 1, 2]);
    const result = refineTerrainTransitionTopology(topology(), previous, 100);
    expect(result?.topology.indices).toHaveLength(6);
    expect(result?.previous.some(reference => reference === null)).toBe(true);
    expect(() => refineTerrainTransitionTopology(topology(), topology(true), 2)).toThrow(/budget/);
    expect(() => refineTerrainTransitionTopology(topology(), topology(true), 100, 0)).toThrow(/work budget/);
    expect(() => refineTerrainTransitionTopology(topology(), {...topology(true), sampleOffset: 1}, 100)).toThrow(/sampling world/);
    expect(() => refineTerrainTransitionTopology(topology(), topology(true), -1)).toThrow();
});
