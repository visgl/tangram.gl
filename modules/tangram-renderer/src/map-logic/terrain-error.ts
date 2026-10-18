// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import type {TerrainHeightGrid} from './terrain-data';

/** Immutable DEM-derived envelope; it says nothing about unloaded finer source detail. */
export interface TerrainErrorEnvelope {
    /** Lowest and highest valid physical source elevations. */
    readonly minimumHeight: number;
    readonly maximumHeight: number;
    /** Conservative directional bilinear gradient bounds per Mercator meter. */
    readonly eastSlope: number;
    readonly northSlope: number;
    /** Mercator footprint width and height. */
    readonly width: number;
    readonly height: number;
    /** Invalid samples prevent certification of the complete footprint. */
    readonly complete: boolean;
}

/** Cache by immutable grid identity; camera movement must not rescan decoded samples. */
const envelopes = new WeakMap<TerrainHeightGrid, TerrainErrorEnvelope>();

/**
 * Conservative CSS-pixel Lipschitz bound for a projective transform over an
 * absolute XYZ box. Null means the box crosses the eye plane: never substitute
 * a center-only derivative and call it a bounded screen error.
 */
export function boundProjectedDisplacement(matrix: readonly number[], minimum: readonly [number, number, number], maximum: readonly [number, number, number],
    viewport: {width: number; height: number}): number | null {
    if (matrix.length !== 16 || ![...matrix, ...minimum, ...maximum, viewport.width, viewport.height].every(Number.isFinite) ||
        minimum.some((value, axis) => value > maximum[axis]) || viewport.width <= 0 || viewport.height <= 0) throw new Error('Invalid terrain projection bound');
    let minimumW = Infinity, horizontal = 0, vertical = 0;
    for (let corner = 0; corner < 8; corner++) {
        const position = minimum.map((value, axis) => corner & 1 << axis ? maximum[axis] : value);
        const component = (row: number) => matrix[row] * position[0] + matrix[row + 4] * position[1] + matrix[row + 8] * position[2] + matrix[row + 12];
        minimumW = Math.min(minimumW, component(3));
        horizontal = Math.max(horizontal, Math.abs(component(0))); vertical = Math.max(vertical, Math.abs(component(1)));
    }
    if (minimumW <= 0) return null;
    const norm = (row: number) => Math.hypot(matrix[row], matrix[row + 4], matrix[row + 8]);
    const result = Math.hypot(viewport.width / 2 * (norm(0) / minimumW + horizontal / minimumW * norm(3) / minimumW),
        viewport.height / 2 * (norm(1) / minimumW + vertical / minimumW * norm(3) / minimumW));
    return Number.isFinite(result) ? result : null;
}

/** Measure source extrema and adjacent gradients once, retaining no additional sample arrays. */
export function measureTerrainError(grid: TerrainHeightGrid): TerrainErrorEnvelope {
    const cached = envelopes.get(grid);
    if (cached) return cached;
    const width = grid.bounds[2] - grid.bounds[0], height = grid.bounds[3] - grid.bounds[1];
    if (!Number.isSafeInteger(grid.width) || !Number.isSafeInteger(grid.height) || grid.width < 2 || grid.height < 2 ||
        grid.heights.length !== grid.width * grid.height || grid.valid.length !== grid.heights.length || grid.bounds.length !== 4 || !grid.bounds.every(Number.isFinite) ||
        !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 || !['grid-node', 'pixel-center'].includes(grid.registration)) throw new Error('Invalid terrain error grid');
    const horizontalSpacing = width / (grid.registration === 'pixel-center' ? grid.width : grid.width - 1);
    const verticalSpacing = height / (grid.registration === 'pixel-center' ? grid.height : grid.height - 1);
    let minimumHeight = Infinity, maximumHeight = -Infinity, eastSlope = 0, northSlope = 0, complete = true;
    for (let index = 0; index < grid.heights.length; index++) {
        if (!grid.valid[index]) {complete = false; continue;}
        if (!Number.isFinite(grid.heights[index])) throw new Error('Terrain error envelope requires finite valid heights');
        const value = grid.heights[index];
        minimumHeight = Math.min(minimumHeight, value); maximumHeight = Math.max(maximumHeight, value);
        if (index % grid.width && grid.valid[index - 1]) eastSlope = Math.max(eastSlope, Math.abs(value - grid.heights[index - 1]) / horizontalSpacing);
        if (index >= grid.width && grid.valid[index - grid.width]) northSlope = Math.max(northSlope, Math.abs(value - grid.heights[index - grid.width]) / verticalSpacing);
    }
    if (minimumHeight === Infinity) {minimumHeight = 0; maximumHeight = 0;}
    if (![minimumHeight, maximumHeight, eastSlope, northSlope].every(Number.isFinite)) throw new Error('Terrain error envelope exceeds finite range');
    const envelope = Object.freeze({minimumHeight, maximumHeight, eastSlope, northSlope, width, height, complete});
    envelopes.set(grid, envelope); return envelope;
}

/**
 * Bound vertical interpolation error by the bilinear field's Lipschitz envelope.
 * Deliberately conservative on ramps: this is not a fitted/sample-only RMSE.
 * A separate spherical sagitta covers surface curvature, in globe-radius units.
 */
export function boundTerrainMeshError(envelope: TerrainErrorEnvelope, resolution: number): {heightError: number; globeCurvatureError: number} {
    if (!Number.isSafeInteger(resolution) || resolution < 2 || resolution > 64 || (resolution & (resolution - 1)) ||
        ![envelope.width, envelope.height, envelope.minimumHeight, envelope.maximumHeight, envelope.eastSlope, envelope.northSlope].every(Number.isFinite) ||
        envelope.width <= 0 || envelope.height <= 0 || envelope.maximumHeight < envelope.minimumHeight || envelope.eastSlope < 0 || envelope.northSlope < 0) throw new Error('Invalid terrain error policy');
    const heightError = Math.min(envelope.maximumHeight - envelope.minimumHeight,
        (envelope.eastSlope * envelope.width + envelope.northSlope * envelope.height) / resolution);
    // Mercator's inverse derivative bounds angular change by Mercator distance/R.
    const angularDiameter = Math.min(Math.PI, (envelope.width + envelope.height) / (6378137 * resolution));
    // Any chord point is within R*(1-cos(diameter)) of the corresponding radial sphere.
    const globeCurvatureError = 256 * 2 * Math.sin(angularDiameter / 2) ** 2;
    return {heightError, globeCurvatureError};
}

/** Select a dyadic resolution with hysteresis from a caller's conservative pixels-per-unit bounds. */
export function selectTerrainMeshResolution(grids: readonly TerrainHeightGrid[], options: {
    /** Maximum acceptable interpolation-plus-curvature error, CSS pixels; default 2. */
    targetPixels?: number;
    /** Upper bound on projected displacement per physical vertical meter, including exaggeration. */
    pixelsPerMeter: number;
    /** Upper bound on projected displacement per radius-256 globe unit; zero for a planar view. */
    pixelsPerGlobeUnit?: number;
    /** Prior dyadic resolution supplies a 20% coarsening deadband. */
    previousResolution?: number;
}): {resolution: number; projectedError: number; limited: boolean; complete: boolean} {
    const target = options.targetPixels ?? 2, globeScale = options.pixelsPerGlobeUnit ?? 0;
    if (![target, options.pixelsPerMeter, globeScale].every(Number.isFinite) || target <= 0 || options.pixelsPerMeter < 0 || globeScale < 0) throw new Error('Invalid projected terrain error scale');
    const envelopes = grids.map(measureTerrainError);
    // Canonical terrain averages touching-edge samples. Independent flat tiles
    // with different heights therefore cannot claim zero reconstruction error.
    // A range envelope is conservative until tighter edge-conformance metadata
    // is available; never hide that uncertainty behind a smaller mesh cell.
    const seamErrors = grids.map((grid, index) => {
        let error = 0;
        for (let other = 0; other < grids.length; other++) {
            if (other === index) continue;
            const neighbor = grids[other], circumference = 2 * Math.PI * 6378137;
            const tolerance = Math.max(envelopes[index].width, envelopes[other].width) * 1e-10;
            if ([-circumference, 0, circumference].some(shift => {
                const horizontal = Math.min(grid.bounds[2], neighbor.bounds[2] + shift) - Math.max(grid.bounds[0], neighbor.bounds[0] + shift);
                const vertical = Math.min(grid.bounds[3], neighbor.bounds[3]) - Math.max(grid.bounds[1], neighbor.bounds[1]);
                return horizontal >= -tolerance && vertical >= -tolerance;
            })) error = Math.max(error, Math.abs(envelopes[index].maximumHeight - envelopes[other].minimumHeight), Math.abs(envelopes[other].maximumHeight - envelopes[index].minimumHeight));
        }
        return error;
    });
    const errorAt = (resolution: number, includeSeams = false) => Math.max(0, ...envelopes.map((envelope, index) => {
        const error = boundTerrainMeshError(envelope, resolution);
        return Math.max(error.heightError, includeSeams ? seamErrors[index] : 0) * options.pixelsPerMeter + error.globeCurvatureError * globeScale;
    }));
    let resolution = options.previousResolution ?? 2;
    boundTerrainMeshError({minimumHeight: 0, maximumHeight: 0, eastSlope: 0, northSlope: 0, width: 1, height: 1, complete: true}, resolution);
    while (resolution < 64 && errorAt(resolution) > target) resolution *= 2;
    while (resolution > 2 && errorAt(resolution / 2) < target * 0.8) resolution /= 2;
    // More vertices cannot reduce a conservative shared-edge uncertainty bound.
    const projectedError = errorAt(resolution, true), complete = envelopes.every(envelope => envelope.complete);
    return {resolution, projectedError, limited: projectedError > target || !complete, complete};
}
