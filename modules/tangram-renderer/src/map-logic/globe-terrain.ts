// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {worldToLngLat} from '@math.gl/web-mercator';
import {sampleTerrainNeighborhood} from './terrain-neighborhood';
import type {TerrainHeightGrid} from './terrain-data';

/** Spherical deck.gl common-space radius and physical reference radius, in meters. */
const GLOBE_RADIUS = 256, EARTH_RADIUS = 6370972, MERCATOR_RADIUS = 6378137;

/** Build an inclusive summed-area mask only when a source actually contains holes. */
function buildMissingTerrainPrefix(grid: TerrainHeightGrid): Uint32Array | null {
    if (grid.valid.every(value => value !== 0)) return null;
    const stride = grid.width + 1, prefix = new Uint32Array(stride * (grid.height + 1));
    for (let row = 0; row < grid.height; row++) {
        let missing = 0;
        for (let column = 0; column < grid.width; column++) {
            missing += Number(grid.valid[row * grid.width + column] === 0);
            prefix[(row + 1) * stride + column + 1] = prefix[row * stride + column + 1] + missing;
        }
    }
    return prefix;
}

/** Conservatively include every sample supporting bilinear interpolation over a cell footprint. */
function hasMissingTerrain(grid: TerrainHeightGrid, prefix: Uint32Array, bounds: readonly [number, number, number, number]): boolean {
    const west = Math.max(grid.bounds[0], bounds[0]), south = Math.max(grid.bounds[1], bounds[1]);
    const east = Math.min(grid.bounds[2], bounds[2]), north = Math.min(grid.bounds[3], bounds[3]);
    if (west > east || south > north) return false;
    const pixelCenter = grid.registration === 'pixel-center';
    const columnScale = (pixelCenter ? grid.width : grid.width - 1) / (grid.bounds[2] - grid.bounds[0]);
    const rowScale = (pixelCenter ? grid.height : grid.height - 1) / (grid.bounds[3] - grid.bounds[1]);
    const offset = pixelCenter ? 0.5 : 0;
    const left = Math.floor(Math.max(0, (west - grid.bounds[0]) * columnScale - offset));
    const right = Math.ceil(Math.min(grid.width - 1, (east - grid.bounds[0]) * columnScale - offset));
    const top = Math.floor(Math.max(0, (grid.bounds[3] - north) * rowScale - offset));
    const bottom = Math.ceil(Math.min(grid.height - 1, (grid.bounds[3] - south) * rowScale - offset));
    const stride = grid.width + 1;
    return prefix[(bottom + 1) * stride + right + 1] - prefix[top * stride + right + 1] - prefix[(bottom + 1) * stride + left] + prefix[top * stride + left] > 0;
}

/** Detached render/query buffers; original height grids are never exaggerated or modified. */
export interface GlobeTerrainMesh {
    /** Longitude/latitude degrees and displayed elevation meters for deck.gl projection. */
    geographicPositions: Float32Array;
    /** Radius-256 spherical XYZ matching those packed geographic vertices. */
    positions: Float64Array;
    /** Physical source elevation per vertex, independent of exaggeration and chord error. */
    physicalHeights: Float32Array;
    /** Outward triangle topology; cells touching no-data samples are omitted. */
    indices: Uint32Array;
    /** RGB relief colors with baked common-space lighting, independent of backend. */
    colors: Float32Array;
}

/** Attenuate exaggerated relief to physical scale; flat and subphysical settings stay fixed. */
export function getGlobeTerrainExaggeration(globeScreenRatio: number, maximum = 100): number {
    if (!Number.isFinite(maximum) || maximum < 0 || maximum > 1000 || !Number.isFinite(globeScreenRatio) || globeScreenRatio < 0) throw new Error('Invalid globe terrain exaggeration or screen ratio');
    if (maximum <= 1) return maximum;
    const progress = Math.max(0, Math.min(1, Math.log2(Math.max(1, globeScreenRatio)) / 2));
    return maximum ** (1 - progress * progress * (3 - 2 * progress));
}

/** Resample a Mercator DEM onto curved triangles; neighbors reconcile matching tile edges. */
export function buildGlobeTerrainMesh(grid: TerrainHeightGrid, options: {
    /** Effective display multiplier, not the zoom-independent maximum. */
    exaggeration?: number;
    /** Cells along each tile axis, bounded to keep allocations predictable; defaults to 64. */
    resolution?: number;
    /** Same-datum neighbors supplying shared edge heights, including world-wrap copies. */
    neighbors?: readonly TerrainHeightGrid[];
} = {}): GlobeTerrainMesh {
    const resolution = options.resolution ?? 64, exaggeration = options.exaggeration ?? 1;
    getGlobeTerrainExaggeration(0, exaggeration);
    if (!Number.isSafeInteger(resolution) || resolution < 2 || resolution > 256) throw new Error('Globe terrain resolution must be an integer in [2, 256]');
    const grids = [grid, ...(options.neighbors ?? [])];
    const halfWorld = Math.PI * MERCATOR_RADIUS;
    for (const candidate of grids) {
        if (!Number.isSafeInteger(candidate.width) || !Number.isSafeInteger(candidate.height) || candidate.width < 2 || candidate.height < 2 || candidate.heights.length !== candidate.width * candidate.height || candidate.valid.length !== candidate.heights.length ||
            candidate.bounds.length !== 4 || !candidate.bounds.every(Number.isFinite) || candidate.bounds[0] >= candidate.bounds[2] || candidate.bounds[1] >= candidate.bounds[3] ||
            candidate.bounds.some(value => Math.abs(value) > halfWorld + 1e-6) ||
            !['grid-node', 'pixel-center'].includes(candidate.registration) || !['ellipsoidal', 'orthometric', 'unknown'].includes(candidate.verticalDatum) || candidate.verticalDatum !== grid.verticalDatum) throw new Error('Invalid globe terrain grid or incompatible vertical datum');
    }
    const circumference = 2 * Math.PI * MERCATOR_RADIUS;
    const samplingGrids = grids.flatMap(candidate => [-1, 0, 1].map((world): TerrainHeightGrid => ({...candidate, bounds: [candidate.bounds[0] + world * circumference, candidate.bounds[1], candidate.bounds[2] + world * circumference, candidate.bounds[3]]})))
        .filter(candidate => candidate.bounds[0] <= grid.bounds[2] && candidate.bounds[2] >= grid.bounds[0] && candidate.bounds[1] <= grid.bounds[3] && candidate.bounds[3] >= grid.bounds[1]);
    const missingRegions = samplingGrids.flatMap(candidate => {
        const prefix = buildMissingTerrainPrefix(candidate);
        return prefix ? [{grid: candidate, prefix}] : [];
    });
    const size = resolution + 1, vertexCount = size * size;
    const geographicPositions = new Float32Array(vertexCount * 3), positions = new Float64Array(vertexCount * 3), physicalHeights = new Float32Array(vertexCount), colors = new Float32Array(vertexCount * 3), valid = new Uint8Array(vertexCount);
    const [west, south, east, north] = grid.bounds;
    if ((east - west) / resolution >= halfWorld - 1e-6) throw new Error('Globe terrain cells must span less than 180 degrees longitude');
    const worldScale = 512 / (2 * Math.PI * MERCATOR_RADIUS);
    for (let row = 0; row < size; row++) for (let column = 0; column < size; column++) {
        const vertex = row * size + column, offset = vertex * 3;
        const x = west + (east - west) * column / resolution, y = north - (north - south) * row / resolution;
        const height = sampleTerrainNeighborhood(samplingGrids, [x, y]);
        if (height !== null && (!Number.isFinite(height) || EARTH_RADIUS + height * exaggeration <= 0)) throw new Error('Invalid globe terrain elevation');
        valid[vertex] = height === null ? 0 : 1;
        physicalHeights[vertex] = height ?? NaN;
        const coordinate = worldToLngLat([x * worldScale + 256, y * worldScale + 256]);
        geographicPositions.set([coordinate[0], coordinate[1], (height ?? 0) * exaggeration], offset);
        if (!Number.isFinite(geographicPositions[offset + 2])) throw new Error('Globe terrain elevation exceeds packed display range');
        // Compute queries from the exact Float32 attributes submitted to deck.gl.
        const longitude = geographicPositions[offset] * Math.PI / 180, latitude = geographicPositions[offset + 1] * Math.PI / 180;
        const radius = GLOBE_RADIUS * (1 + geographicPositions[offset + 2] / EARTH_RADIUS);
        positions.set([Math.sin(longitude) * Math.cos(latitude) * radius, -Math.cos(longitude) * Math.cos(latitude) * radius, Math.sin(latitude) * radius], offset);
    }
    const triangles: number[] = [], normals = new Float64Array(vertexCount * 3);
    for (let row = 0; row < resolution; row++) for (let column = 0; column < resolution; column++) {
        const first = row * size + column, second = first + 1, third = first + size, fourth = third + 1;
        if (![first, second, third, fourth].every(vertex => valid[vertex])) continue;
        const cellBounds: [number, number, number, number] = [west + (east - west) * column / resolution, north - (north - south) * (row + 1) / resolution,
            west + (east - west) * (column + 1) / resolution, north - (north - south) * row / resolution];
        if (missingRegions.some(region => hasMissingTerrain(region.grid, region.prefix, cellBounds))) continue;
        for (const vertices of [[first, third, second], [second, third, fourth]]) {
            const [a, b, c] = vertices.map(vertex => vertex * 3);
            const ab = [positions[b] - positions[a], positions[b + 1] - positions[a + 1], positions[b + 2] - positions[a + 2]], ac = [positions[c] - positions[a], positions[c + 1] - positions[a + 1], positions[c + 2] - positions[a + 2]];
            const normal = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
            if (Math.hypot(...normal) === 0) throw new Error('Globe terrain triangle collapses at packed coordinate precision');
            const sign = normal[0] * positions[a] + normal[1] * positions[a + 1] + normal[2] * positions[a + 2] < 0 ? -1 : 1;
            triangles.push(vertices[0], vertices[sign === 1 ? 1 : 2], vertices[sign === 1 ? 2 : 1]);
            for (const vertex of vertices) for (let axis = 0; axis < 3; axis++) normals[vertex * 3 + axis] += normal[axis] * sign;
        }
    }
    for (let vertex = 0; vertex < vertexCount; vertex++) {
        const offset = vertex * 3, length = Math.hypot(normals[offset], normals[offset + 1], normals[offset + 2]);
        const light = length ? 0.4 + 0.6 * Math.max(0, (normals[offset] - normals[offset + 1] + normals[offset + 2]) / (length * Math.sqrt(3))) : 0.4;
        const height = physicalHeights[vertex], snow = height > 2500;
        colors.set((snow ? [0.9, 0.92, 0.96] : height <= 0 ? [0.12, 0.3, 0.48] : [0.36, 0.58, 0.34]).map(value => value * light), offset);
    }
    return {geographicPositions, positions, physicalHeights, indices: Uint32Array.from(triangles), colors};
}
