// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test} from 'vitest';
import {TerrainHeightField} from '../src/map-logic/terrain-height-field';
import {guardTerrainMotion} from '../src/map-logic/terrain-navigation';
import type {TerrainHeightGrid} from '../src/map-logic/terrain-data';

/** A narrow ridge can miss the centerline while intersecting the avatar's shoulder. */
function grid(bounds: TerrainHeightGrid['bounds'] = [0, 0, 10, 10]): TerrainHeightGrid {
    return {width: 3, height: 3, bounds, heights: new Float32Array([0, 0, 0, 0, 10, 0, 0, 0, 0]),
        valid: new Uint8Array(9).fill(1), registration: 'grid-node', verticalDatum: 'unknown'};
}

test('swept footprints include intermediate ground and reject unknown gaps even with safe endpoints', () => {
    const field = new TerrainHeightField([grid()]);
    expect(guardTerrainMotion(field, [1, 5, 5], [9, 5, 5], {radius: 0.3, clearance: 1})).toMatchObject({available: true, blocked: true, reason: 'terrain'});
    expect(guardTerrainMotion(field, [1, 5, 12], [9, 5, 12], {radius: 0.3, clearance: 1})).toMatchObject({available: true, blocked: false});
    const gap = new TerrainHeightField([grid([0, 0, 4, 10]), grid([6, 0, 10, 10])]);
    expect(guardTerrainMotion(gap, [1, 5, 100], [9, 5, 100], {radius: 0.2, clearance: 1})).toMatchObject({available: false, blocked: true, reason: 'missing'});
});

test('body edges, missing support and work limits hold translation rather than declaring a safe path', () => {
    const source = grid(), field = new TerrainHeightField([source]);
    expect(guardTerrainMotion(field, [0.1, 2, 100], [0.1, 3, 100], {radius: 0.3, clearance: 1}).reason).toBe('missing');
    const missing = grid(); missing.valid[4] = 0;
    expect(guardTerrainMotion(new TerrainHeightField([missing]), [4, 4, 100], [6, 6, 100], {radius: 0.1, clearance: 1}).reason).toBe('missing');
    expect(guardTerrainMotion(field, [1, 1, 100], [9, 9, 100], {radius: 0, clearance: 1, maxProbes: 1})).toEqual({available: false, blocked: true, reason: 'budget', probes: 0});
    expect(field.getHeightRange([0, 0, 10, 10])).toEqual({minimum: 0, maximum: 10});
    expect(field.getHeightRange([11, 0, 12, 10])).toBeNull();
    for (const options of [{radius: -1, clearance: 0}, {radius: 0, clearance: -1}, {radius: 0, clearance: 0, maxStep: 0}, {radius: 0, clearance: 0, maxProbes: 1025}]) expect(() => guardTerrainMotion(field, [1, 1, 2], [2, 2, 2], options)).toThrow();
});
