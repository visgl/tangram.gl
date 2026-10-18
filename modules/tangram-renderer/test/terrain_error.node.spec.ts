// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test} from 'vitest';
import {measureTerrainError, boundTerrainMeshError, selectTerrainMeshResolution, boundProjectedDisplacement} from '../src/map-logic/terrain-error';
import type {TerrainHeightGrid} from '../src/map-logic/terrain-data';

/** Small registered ridge, independent of network providers or GPU state. */
function grid(registration: TerrainHeightGrid['registration'] = 'grid-node'): TerrainHeightGrid {
    return {width: 3, height: 3, bounds: [0, 0, 100, 100], heights: new Float32Array([0, 20, 0, 0, 80, 0, 0, 20, 0]),
        valid: new Uint8Array(9).fill(1), registration, verticalDatum: 'unknown'};
}

test.each(['grid-node', 'pixel-center'] as const)('error envelopes respect %s registration and immutable source identity', registration => {
    const source = grid(registration), envelope = measureTerrainError(source);
    expect(measureTerrainError(source)).toBe(envelope);
    expect(envelope).toMatchObject({minimumHeight: 0, maximumHeight: 80, complete: true});
    expect(envelope.eastSlope).toBeCloseTo(registration === 'grid-node' ? 1.6 : 2.4);
    let last = Infinity;
    for (const resolution of [2, 4, 8, 16, 32, 64]) {
        const error = boundTerrainMeshError(envelope, resolution);
        expect(error.heightError).toBeLessThanOrEqual(last); expect(error.globeCurvatureError).toBeGreaterThan(0);
        last = error.heightError;
    }
});

test('a flat sphere still needs curvature detail and error targets report hard limits rather than success', () => {
    const flat = {...grid(), bounds: [-20000000, -20000000, 20000000, 20000000] as const, heights: new Float32Array(9)};
    expect(selectTerrainMeshResolution([flat], {pixelsPerMeter: 0}).resolution).toBe(2);
    const globe = selectTerrainMeshResolution([flat], {pixelsPerMeter: 0, pixelsPerGlobeUnit: 100});
    expect(globe.resolution).toBe(64); expect(globe.limited).toBe(true);
    const coarse = selectTerrainMeshResolution([grid()], {pixelsPerMeter: 0.1, targetPixels: 2});
    const fine = selectTerrainMeshResolution([grid()], {pixelsPerMeter: 1, targetPixels: 2});
    expect(fine.resolution).toBeGreaterThan(coarse.resolution);
    expect(selectTerrainMeshResolution([grid()], {pixelsPerMeter: 10000}).limited).toBe(true);
});

test('hysteresis avoids coarsening jitter; missing or invalid data never certifies a complete error bound', () => {
    const source = grid(), envelope = measureTerrainError(source), error = boundTerrainMeshError(envelope, 16).heightError;
    expect(selectTerrainMeshResolution([source], {pixelsPerMeter: 1, targetPixels: error * 1.01, previousResolution: 32}).resolution).toBe(32);
    const missing = grid(); missing.valid[4] = 0;
    expect(selectTerrainMeshResolution([missing], {pixelsPerMeter: 0})).toMatchObject({complete: false, limited: true});
    for (const resolution of [0, 3, 128, NaN]) expect(() => boundTerrainMeshError(envelope, resolution)).toThrow();
    for (const options of [{pixelsPerMeter: -1}, {pixelsPerMeter: NaN}, {pixelsPerMeter: 1, previousResolution: 3}, {pixelsPerMeter: 1, targetPixels: 0}]) expect(() => selectTerrainMeshResolution([source], options)).toThrow();
    expect(measureTerrainError({...source, valid: new Uint8Array(9)})).toMatchObject({complete: false, minimumHeight: 0, maximumHeight: 0});
    expect(() => measureTerrainError({...source, heights: new Float32Array(9).fill(NaN)})).toThrow();
    expect(() => measureTerrainError({...source, width: 1})).toThrow();
});

test('projective error uses the whole box and refuses a box crossing the eye plane', () => {
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    expect(boundProjectedDisplacement(identity, [-1, -1, -1], [1, 1, 1], {width: 100, height: 100})).toBeCloseTo(Math.hypot(50, 50));
    const perspective = [...identity]; perspective[11] = -1; perspective[15] = 0;
    expect(boundProjectedDisplacement(perspective, [-1, -1, -1], [1, 1, 1], {width: 100, height: 100})).toBeNull();
    expect(boundProjectedDisplacement(perspective, [-1, -1, -10], [1, 1, -5], {width: 100, height: 100})).toBeGreaterThan(0);
    expect(() => boundProjectedDisplacement([], [0, 0, 0], [1, 1, 1], {width: 100, height: 100})).toThrow();
    expect(() => boundProjectedDisplacement(identity, [2, 0, 0], [1, 1, 1], {width: 100, height: 100})).toThrow();
});

test('touching-edge reconciliation cannot certify zero error for two different flat heights', () => {
    const west = {...grid(), heights: new Float32Array(9)}, east = {...grid(), heights: new Float32Array(9).fill(100), bounds: [100, 0, 200, 100] as const};
    expect(selectTerrainMeshResolution([west, east], {pixelsPerMeter: 1, targetPixels: 2})).toMatchObject({limited: true, projectedError: 100});
    expect(selectTerrainMeshResolution([west, {...east, bounds: [200, 0, 300, 100]}], {pixelsPerMeter: 1, targetPixels: 2})).toMatchObject({limited: false, projectedError: 0});
});
