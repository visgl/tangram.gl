// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import type {TerrainHeightGrid} from './terrain-data';
import type {TerrainFieldBounds} from './terrain-height-field';

const CIRCUMFERENCE = 2 * Math.PI * 6378137;
/** Immutable field identities own one validated periodic patch neighborhood, not generated mesh buffers. */
const patchPlans = new WeakMap<readonly TerrainHeightGrid[], readonly TerrainFieldBounds[]>();

/** Source-independent triangles; tile ownership is clipped after projection, never by moving boundary nodes. */
export interface TerrainGroundTopology {
    /** Absolute unwrapped EPSG:3857 XY, two components per vertex. */
    positions: Float64Array;
    /** Exact periodic sampling XY before whole-world translation; may share the positions array in world zero. */
    samplePositions: Float64Array;
    /** Counterclockwise top triangles, including conforming coarse/fine edge nodes. */
    indices: Uint32Array;
    /** Subtract this whole-world X offset before sampling the periodic DEM neighborhood. */
    sampleOffset: number;
}

/** Include every touching neighbor's edge knots on a patch boundary, preserving traversal order. */
export function getTerrainEdgeNodes(bounds: TerrainFieldBounds, neighbors: readonly TerrainFieldBounds[], resolution: number,
    start: readonly [number, number], end: readonly [number, number]): [number, number][] {
    const [west, south, east, north] = bounds;
    const vertical = start[0] === end[0], axis = vertical ? 1 : 0;
    if (!(vertical && (start[0] === 0 || start[0] === resolution) || start[1] === end[1] && (start[1] === 0 || start[1] === resolution))) return [];
    const tolerance = Math.max(east - west, north - south) * 1e-10;
    const fixed = vertical ? west + start[0] / resolution * (east - west) : north - start[1] / resolution * (north - south);
    const values = new Set<number>();
    for (const candidate of neighbors) {
        if (vertical ? Math.min(Math.abs(fixed - candidate[0]), Math.abs(fixed - candidate[2])) > tolerance : Math.min(Math.abs(fixed - candidate[1]), Math.abs(fixed - candidate[3])) > tolerance) continue;
        for (let step = 0; step <= resolution; step++) {
            const value = vertical ? (north - (candidate[3] - step / resolution * (candidate[3] - candidate[1]))) / (north - south) * resolution :
                (candidate[0] + step / resolution * (candidate[2] - candidate[0]) - west) / (east - west) * resolution;
            if (value > Math.min(start[axis], end[axis]) + 1e-8 && value < Math.max(start[axis], end[axis]) - 1e-8) values.add(Math.round(value * 1e8) / 1e8);
        }
    }
    return [...values].sort((first, second) => (first - second) * Math.sign(end[axis] - start[axis])).map(value => vertical ? [start[0], value] : [value, start[1]]);
}

/** Snap a decoded tile footprint to one world lattice; opt-in ground topology requires square quadtree tiles. */
function snapTileBounds(bounds: TerrainFieldBounds): TerrainFieldBounds {
    if (bounds.length !== 4) throw new Error('Canonical terrain ground requires quadtree DEM footprints');
    const edge = bounds[2] - bounds[0], zoom = Math.round(Math.log2(CIRCUMFERENCE / edge));
    if (!Number.isSafeInteger(zoom) || zoom < 0 || zoom > 30) throw new Error('Canonical terrain ground requires quadtree DEM footprints');
    const span = CIRCUMFERENCE / 2 ** zoom;
    const column = Math.round((bounds[0] + CIRCUMFERENCE / 2) / span), row = Math.round((CIRCUMFERENCE / 2 - bounds[3]) / span);
    const snapped: TerrainFieldBounds = [column * span - CIRCUMFERENCE / 2, CIRCUMFERENCE / 2 - (row + 1) * span,
        (column + 1) * span - CIRCUMFERENCE / 2, CIRCUMFERENCE / 2 - row * span];
    if (row < 0 || row >= 2 ** zoom || bounds.some((value, index) => !Number.isFinite(value) || Math.abs(value - snapped[index]) > Math.max(1e-6, span * 1e-8))) throw new Error('Canonical terrain ground requires quadtree DEM footprints');
    return snapped;
}

/** Retain every neighbor, including those outside a source clip whose knots affect an intersecting cell. */
function getPatchPlan(grids: readonly TerrainHeightGrid[]): readonly TerrainFieldBounds[] {
    const cached = patchPlans.get(grids);
    if (cached) return cached;
    const patches = grids.flatMap(grid => {
        const bounds = snapTileBounds(grid.bounds);
        const offset = Math.floor(((bounds[0] + bounds[2]) / 2 + CIRCUMFERENCE / 2) / CIRCUMFERENCE) * CIRCUMFERENCE;
        return [-1, 0, 1].map(world => [bounds[0] - offset + world * CIRCUMFERENCE, bounds[1], bounds[2] - offset + world * CIRCUMFERENCE, bounds[3]] as const);
    });
    for (let index = 0; index < patches.length; index++) for (let previous = 0; previous < index; previous++) {
        const patch = patches[index], other = patches[previous], tolerance = Math.max(patch[2] - patch[0], other[2] - other[0]) * 1e-10;
        const horizontal = Math.min(patch[2], other[2]) - Math.max(patch[0], other[0]);
        const vertical = Math.min(patch[3], other[3]) - Math.max(patch[1], other[1]);
        if (horizontal > tolerance && vertical > tolerance) throw new Error('Canonical terrain ground footprints overlap');
        if (horizontal > tolerance && vertical >= -tolerance || vertical > tolerance && horizontal >= -tolerance) {
            const ratio = (patch[2] - patch[0]) / (other[2] - other[0]);
            if (![0.5, 1, 2].some(value => Math.abs(value - ratio) < 1e-8)) throw new Error('Canonical terrain ground requires balanced 2:1 edges');
        }
    }
    patchPlans.set(grids, patches);
    return patches;
}

/** Periodic sample references match canonical topology at the antimeridian; arrays remain immutable and shared. */
export function wrapTerrainGroundGrids(grids: readonly TerrainHeightGrid[]): TerrainHeightGrid[] {
    return grids.flatMap(grid => {
        const bounds = snapTileBounds(grid.bounds);
        const offset = Math.floor(((bounds[0] + bounds[2]) / 2 + CIRCUMFERENCE / 2) / CIRCUMFERENCE) * CIRCUMFERENCE;
        return [-1, 0, 1].map(world => ({...grid, bounds: [bounds[0] - offset + world * CIRCUMFERENCE, bounds[1], bounds[2] - offset + world * CIRCUMFERENCE, bounds[3]] as const}));
    });
}

/**
 * Build complete DEM-owned cells intersecting a source tile. Do not clip triangles
 * at source/fallback edges: both owners must submit the same curved triangle there.
 * Fragment/query half-open clips select ownership. Current fields must have balanced
 * 2:1 quadtree edges; unsupported fields and exhausted budgets reject, never truncate.
 */
export function createTerrainGroundTopology(grids: readonly TerrainHeightGrid[], bounds: TerrainFieldBounds,
    resolution = 32, maxVertices = 131072): TerrainGroundTopology {
    if (grids.length > 96 || !Number.isSafeInteger(resolution) || resolution < 2 || resolution > 64 || (resolution & (resolution - 1)) !== 0 ||
        !Number.isSafeInteger(maxVertices) || maxVertices < 0 || bounds.length !== 4 || !bounds.every(Number.isFinite) || bounds[0] >= bounds[2] || bounds[1] >= bounds[3] ||
        bounds[2] - bounds[0] > CIRCUMFERENCE * (1 + 1e-10)) throw new Error('Invalid canonical terrain ground limits or bounds');
    const sampleOffset = Math.floor(((bounds[0] + bounds[2]) / 2 + CIRCUMFERENCE / 2) / CIRCUMFERENCE) * CIRCUMFERENCE;
    const localBounds: TerrainFieldBounds = [bounds[0] - sampleOffset, bounds[1], bounds[2] - sampleOffset, bounds[3]];
    const patches = getPatchPlan(grids);
    const positions: number[] = [], indices: number[] = [], nodes = new Map<string, number>();
    /** Reuse lattice nodes across DEM patch boundaries and independent source-tile builds. */
    function vertex(patch: TerrainFieldBounds, column: number, row: number): number {
        const zoom = Math.round(Math.log2(CIRCUMFERENCE / (patch[2] - patch[0]))), span = CIRCUMFERENCE / 2 ** zoom;
        const worldColumn = Math.round((patch[0] + CIRCUMFERENCE / 2) / span), worldRow = Math.round((CIRCUMFERENCE / 2 - patch[3]) / span);
        const x = span / resolution * (worldColumn * resolution + column) - CIRCUMFERENCE / 2;
        const y = CIRCUMFERENCE / 2 - span / resolution * (worldRow * resolution + row);
        const key = `${x},${y}`;
        let index = nodes.get(key);
        if (index === undefined) {
            if (nodes.size >= maxVertices) throw new Error('Canonical terrain ground vertex budget exceeded');
            index = nodes.size; nodes.set(key, index); positions.push(x, y);
        }
        return index;
    }
    /** Preserve the same DEM triangles on both sides of a source ownership boundary. */
    function triangle(patch: TerrainFieldBounds, corners: readonly [number, number][]): void {
        const ring: number[] = [];
        for (let edge = 0; edge < 3; edge++) {
            const start = corners[edge], end = corners[(edge + 1) % 3];
            ring.push(vertex(patch, ...start), ...getTerrainEdgeNodes(patch, patches, resolution, start, end).map(point => vertex(patch, ...point)));
        }
        if (ring.length === 3) indices.push(...ring);
        else {
            const center = vertex(patch, corners.reduce((sum, point) => sum + point[0] / 3, 0), corners.reduce((sum, point) => sum + point[1] / 3, 0));
            for (let edge = 0; edge < ring.length; edge++) indices.push(center, ring[edge], ring[(edge + 1) % ring.length]);
        }
    }
    for (const patch of patches) {
        const west = Math.max(localBounds[0], patch[0]), east = Math.min(localBounds[2], patch[2]);
        const south = Math.max(localBounds[1], patch[1]), north = Math.min(localBounds[3], patch[3]);
        if (west >= east || south >= north) continue;
        const cellSpan = (patch[2] - patch[0]) / resolution;
        // Whole-world translation can shift an exact ownership edge by a few
        // double ulps. Snap only within representational error, not a fixed
        // fraction that could erase tiny high-zoom ownership windows.
        const tolerance = Math.max(CIRCUMFERENCE, ...patch.map(Math.abs)) / cellSpan * Number.EPSILON * 4;
        const cell = (value: number) => Math.abs(value - Math.round(value)) <= tolerance ? Math.round(value) : value;
        const firstColumn = Math.max(0, Math.floor(cell((west - patch[0]) / (patch[2] - patch[0]) * resolution)));
        const lastColumn = Math.min(resolution, Math.ceil(cell((east - patch[0]) / (patch[2] - patch[0]) * resolution)));
        const firstRow = Math.max(0, Math.floor(cell((patch[3] - north) / (patch[3] - patch[1]) * resolution)));
        const lastRow = Math.min(resolution, Math.ceil(cell((patch[3] - south) / (patch[3] - patch[1]) * resolution)));
        for (let row = firstRow; row < lastRow; row++) for (let column = firstColumn; column < lastColumn; column++) {
            triangle(patch, [[column, row], [column, row + 1], [column + 1, row]]);
            triangle(patch, [[column + 1, row], [column, row + 1], [column + 1, row + 1]]);
        }
    }
    const samplePositions = Float64Array.from(positions);
    return {positions: sampleOffset ? Float64Array.from(samplePositions, (value, index) => index % 2 ? value : value + sampleOffset) : samplePositions,
        samplePositions, indices: Uint32Array.from(indices), sampleOffset};
}
