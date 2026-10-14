// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {worldToLngLat} from '@math.gl/web-mercator';
import {TerrainHeightField} from './terrain-height-field';
import type {TerrainHeightGrid} from './terrain-data';

/** Spherical deck.gl common-space radius and physical reference radius, in meters. */
const GLOBE_RADIUS = 256, EARTH_RADIUS = 6370972, MERCATOR_RADIUS = 6378137;

/** Build an inclusive summed-area mask only when a source actually contains holes. */
function* buildMissingTerrainPrefix(grid: TerrainHeightGrid): Generator<void, Uint32Array | null, void> {
    let missingSample = false;
    for (let offset = 0; offset < grid.valid.length && !missingSample; offset += 4096) {
        for (let index = offset; index < Math.min(grid.valid.length, offset + 4096); index++) if (grid.valid[index] === 0) {missingSample = true; break;}
        yield;
    }
    if (!missingSample) return null;
    const stride = grid.width + 1, prefix = new Uint32Array(stride * (grid.height + 1));
    for (let row = 0; row < grid.height; row++) {
        let missing = 0;
        for (let column = 0; column < grid.width; column++) {
            missing += Number(grid.valid[row * grid.width + column] === 0);
            prefix[(row + 1) * stride + column + 1] = prefix[row * stride + column + 1] + missing;
        }
        if (row % 8 === 7) yield;
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

/** Opaque immutable sampling/topology snapshot; keep it to rescale without reading source grids again. */
export interface GlobeTerrainMeshTemplate {
    /** Number of regular and stitched vertices in this snapshot. */
    readonly vertexCount: number;
    /** Number of outward triangles, excluding no-data cells. */
    readonly triangleCount: number;
    /** Owned typed-array backing storage; excludes source grids and temporary JavaScript arrays. */
    readonly byteLength: number;
}

/** Private backing arrays cannot be modified through the public template handle. */
const terrainTemplates = new WeakMap<GlobeTerrainMeshTemplate, {
    coordinates: Float32Array;
    heights: Float64Array;
    gradients: Float64Array;
    frame: Float64Array;
    physicalHeights: Float32Array;
    indices: Uint32Array;
}>();

/** Attenuate exaggerated relief to flat after one diameter doubling; explicit physical/subphysical settings stay fixed. */
export function getGlobeTerrainExaggeration(globeScreenRatio: number, maximum = 100): number {
    if (!Number.isFinite(maximum) || maximum < 0 || maximum > 1000 || !Number.isFinite(globeScreenRatio) || globeScreenRatio < 0) throw new Error('Invalid globe terrain exaggeration or screen ratio');
    if (maximum <= 1) return maximum;
    const progress = Math.max(0, Math.min(1, Math.log2(Math.max(1, globeScreenRatio))));
    return (maximum + 1) ** (1 - progress * progress * (3 - 2 * progress)) - 1;
}

/** Resample a Mercator DEM onto curved triangles; neighbors reconcile matching tile edges. */
export function buildGlobeTerrainMesh(grid: TerrainHeightGrid, options: {
    /** Effective display multiplier, not the zoom-independent maximum. */
    exaggeration?: number;
    /** Cells along each tile axis, bounded to keep allocations predictable; defaults to 64. */
    resolution?: number;
    /** Same-datum, non-overlapping neighbors with balanced 2:1 edges and the same cell resolution. */
    neighbors?: readonly TerrainHeightGrid[];
} = {}): GlobeTerrainMesh {
    getGlobeTerrainExaggeration(0, options.exaggeration ?? 1);
    return scaleGlobeTerrainMesh(prepareGlobeTerrainMesh(grid, options), options.exaggeration ?? 1);
}

/** Snapshot source sampling, no-data, edge stitching and physical slopes once per immutable neighborhood. */
export function prepareGlobeTerrainMesh(grid: TerrainHeightGrid, options: {
    /** Uniform cells per tile axis, integer [2, 256]; defaults to 64. */
    resolution?: number;
    /** Same-datum non-overlapping neighbors with balanced 2:1 edges. */
    neighbors?: readonly TerrainHeightGrid[];
} = {}): GlobeTerrainMeshTemplate {
    const steps = prepareGlobeTerrainMeshSteps(grid, options);
    let result = steps.next();
    while (!result.done) result = steps.next();
    return result.value;
}

/** Cooperatively prepare identical topology; each yield releases control between bounded sampling chunks. */
export function* prepareGlobeTerrainMeshSteps(grid: TerrainHeightGrid, options: {
    /** Uniform cells per tile axis, integer [2, 256]; defaults to 64. */
    resolution?: number;
    /** Same-datum non-overlapping neighbors with balanced 2:1 edges. */
    neighbors?: readonly TerrainHeightGrid[];
} = {}): Generator<void, GlobeTerrainMeshTemplate, void> {
    const resolution = options.resolution ?? 64;
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
    const heightField = new TerrainHeightField(samplingGrids);
    const missingRegions: {grid: TerrainHeightGrid; prefix: Uint32Array}[] = [];
    for (const candidate of samplingGrids) {
        const prefix = yield* buildMissingTerrainPrefix(candidate);
        if (prefix) missingRegions.push({grid: candidate, prefix});
    }
    const [west, south, east, north] = grid.bounds;
    const tolerance = Math.max(east - west, north - south) * 1e-10;
    for (const candidate of samplingGrids) {
        const horizontal = Math.min(east, candidate.bounds[2]) - Math.max(west, candidate.bounds[0]);
        const vertical = Math.min(north, candidate.bounds[3]) - Math.max(south, candidate.bounds[1]);
        const identical = candidate.bounds.every((value, index) => Math.abs(value - grid.bounds[index]) <= tolerance);
        if (!identical && horizontal > tolerance && vertical > tolerance) throw new Error('Globe terrain neighbors must not overlap');
        if (!identical && (horizontal > tolerance || vertical > tolerance)) {
            const ratio = (candidate.bounds[2] - candidate.bounds[0]) / (east - west);
            if (![0.5, 1, 2].some(value => Math.abs(ratio - value) < 1e-8) || Math.abs((candidate.bounds[3] - candidate.bounds[1]) / (north - south) - ratio) > 1e-8) throw new Error('Globe terrain edges require balanced 2:1 footprints');
        }
    }
    const size = resolution + 1;
    const geographicPositions: number[] = [], positions: number[] = [], physicalHeights: number[] = [], samplePositions: [number, number][] = [], valid: boolean[] = [];
    const nodes = new Map<string, number>();
    if ((east - west) / resolution >= halfWorld - 1e-6) throw new Error('Globe terrain cells must span less than 180 degrees longitude');
    const worldScale = 512 / (2 * Math.PI * MERCATOR_RADIUS);
    /** Shared nodes use the same packed geographic coordinates for drawing and queries. */
    function vertex(column: number, row: number): number {
        column = Math.round(column * 1e8) / 1e8; row = Math.round(row * 1e8) / 1e8;
        const key = `${column},${row}`, retained = nodes.get(key);
        if (retained !== undefined) return retained;
        const index = physicalHeights.length; nodes.set(key, index);
        const x = west + (east - west) * column / resolution, y = north - (north - south) * row / resolution;
        const height = heightField.sampleHeight([x, y]);
        if (height !== null && !Number.isFinite(height)) throw new Error('Invalid globe terrain elevation');
        valid.push(height !== null); physicalHeights.push(height ?? NaN); samplePositions.push([x, y]);
        const coordinate = worldToLngLat([x * worldScale + 256, y * worldScale + 256]);
        const packed = [Math.fround(coordinate[0]), Math.fround(coordinate[1]), 0];
        geographicPositions.push(...packed);
        // Compute queries from the exact Float32 attributes submitted to deck.gl.
        const longitude = packed[0] * Math.PI / 180, latitude = packed[1] * Math.PI / 180;
        const radius = GLOBE_RADIUS;
        positions.push(Math.sin(longitude) * Math.cos(latitude) * radius, -Math.cos(longitude) * Math.cos(latitude) * radius, Math.sin(latitude) * radius);
        return index;
    }
    // Retain regular node ordering; additional nodes are confined to stitched boundary rings.
    for (let row = 0; row < size; row++) {
        for (let column = 0; column < size; column++) vertex(column, row);
        yield;
    }
    const triangles: number[] = [];
    /** Add one outward non-degenerate triangle to the shared render/query topology. */
    function triangle(vertices: readonly number[]): void {
        if (!vertices.every(index => valid[index])) return;
        const [a, b, c] = vertices.map(index => index * 3);
        const ab = [positions[b] - positions[a], positions[b + 1] - positions[a + 1], positions[b + 2] - positions[a + 2]], ac = [positions[c] - positions[a], positions[c + 1] - positions[a + 1], positions[c + 2] - positions[a + 2]];
        const normal = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
        if (Math.hypot(...normal) === 0) throw new Error('Globe terrain triangle collapses at packed coordinate precision');
        const sign = normal[0] * positions[a] + normal[1] * positions[a + 1] + normal[2] * positions[a + 2] < 0 ? -1 : 1;
        triangles.push(vertices[0], vertices[sign === 1 ? 1 : 2], vertices[sign === 1 ? 2 : 1]);
    }
    /** Include neighbor edge nodes so fine half-steps also exist on the coarse mesh. */
    function edgeNodes(start: readonly number[], end: readonly number[]): number[] {
        const vertical = start[0] === end[0], axis = vertical ? 1 : 0;
        if (!(vertical && (start[0] === 0 || start[0] === resolution) || start[1] === end[1] && (start[1] === 0 || start[1] === resolution))) return [];
        const fixed = vertical ? west + start[0] / resolution * (east - west) : north - start[1] / resolution * (north - south), values = new Set<number>();
        for (const candidate of samplingGrids) {
            const bounds = candidate.bounds;
            if (vertical ? Math.min(Math.abs(fixed - bounds[0]), Math.abs(fixed - bounds[2])) > tolerance : Math.min(Math.abs(fixed - bounds[1]), Math.abs(fixed - bounds[3])) > tolerance) continue;
            for (let step = 0; step <= resolution; step++) {
                const value = vertical ? (north - (bounds[3] - step / resolution * (bounds[3] - bounds[1]))) / (north - south) * resolution : (bounds[0] + step / resolution * (bounds[2] - bounds[0]) - west) / (east - west) * resolution;
                if (value > Math.min(start[axis], end[axis]) + 1e-8 && value < Math.max(start[axis], end[axis]) - 1e-8) values.add(Math.round(value * 1e8) / 1e8);
            }
        }
        return [...values].sort((first, second) => (first - second) * Math.sign(end[axis] - start[axis])).map(value => vertical ? vertex(start[0], value) : vertex(value, start[1]));
    }
    /** Only boundary triangles with extra edge nodes need a center fan. */
    function reconstruct(corners: readonly number[][]): void {
        const ring: number[] = [];
        for (let edge = 0; edge < 3; edge++) {
            const start = corners[edge], end = corners[(edge + 1) % 3];
            ring.push(vertex(start[0], start[1]), ...edgeNodes(start, end));
        }
        if (!ring.every(index => valid[index])) return;
        if (ring.length === 3) triangle(ring);
        else {
            const center = vertex(corners.reduce((sum, point) => sum + point[0] / 3, 0), corners.reduce((sum, point) => sum + point[1] / 3, 0));
            for (let edge = 0; edge < ring.length; edge++) triangle([center, ring[edge], ring[(edge + 1) % ring.length]]);
        }
    }
    for (let row = 0; row < resolution; row++) {
      for (let column = 0; column < resolution; column++) {
        const first = row * size + column, second = first + 1, third = first + size, fourth = third + 1;
        if (![first, second, third, fourth].every(vertex => valid[vertex])) continue;
        const cellBounds: [number, number, number, number] = [west + (east - west) * column / resolution, north - (north - south) * (row + 1) / resolution,
            west + (east - west) * (column + 1) / resolution, north - (north - south) * row / resolution];
        if (missingRegions.some(region => hasMissingTerrain(region.grid, region.prefix, cellBounds))) continue;
        reconstruct([[column, row], [column, row + 1], [column + 1, row]]);
        reconstruct([[column + 1, row], [column, row + 1], [column + 1, row + 1]]);
      }
      yield;
    }
    const gradients = new Float64Array(physicalHeights.length * 2), frame = new Float64Array(physicalHeights.length * 4);
    /** Identical edge sample neighborhoods yield identical spherical lighting at either LOD. */
    function slope(negative: number | null, positive: number | null, center: number, distance: number): number {
        return negative !== null && positive !== null ? (positive - negative) / (2 * distance) : positive !== null ? (positive - center) / distance : negative !== null ? (center - negative) / distance : 0;
    }
    for (let index = 0; index < physicalHeights.length; index++) {
        const offset = index * 3, [x, y] = samplePositions[index], height = physicalHeights[index];
        const longitude = geographicPositions[offset] * Math.PI / 180, latitude = geographicPositions[offset + 1] * Math.PI / 180;
        frame.set([Math.sin(longitude), Math.cos(longitude), Math.sin(latitude), Math.cos(latitude)], index * 4);
        const touching = samplingGrids.filter(candidate => x >= candidate.bounds[0] - tolerance && x <= candidate.bounds[2] + tolerance && y >= candidate.bounds[1] - tolerance && y <= candidate.bounds[3] + tolerance);
        const distanceX = Math.min(...touching.map(candidate => (candidate.bounds[2] - candidate.bounds[0]) / (candidate.registration === 'pixel-center' ? candidate.width : candidate.width - 1)));
        const distanceY = Math.min(...touching.map(candidate => (candidate.bounds[3] - candidate.bounds[1]) / (candidate.registration === 'pixel-center' ? candidate.height : candidate.height - 1)));
        const physicalScale = Math.cos(latitude) * EARTH_RADIUS / MERCATOR_RADIUS;
        gradients[index * 2] = !valid[index] ? 0 : slope(heightField.sampleHeight([x - distanceX, y]), heightField.sampleHeight([x + distanceX, y]), height, distanceX * physicalScale);
        gradients[index * 2 + 1] = !valid[index] ? 0 : slope(heightField.sampleHeight([x, y - distanceY]), heightField.sampleHeight([x, y + distanceY]), height, distanceY * physicalScale);
        if (index % 128 === 127) yield;
    }
    const buffers = {
        coordinates: Float32Array.from(geographicPositions.filter((_, index) => index % 3 !== 2)),
        heights: Float64Array.from(physicalHeights), gradients, frame,
        physicalHeights: Float32Array.from(physicalHeights), indices: Uint32Array.from(triangles)
    };
    const byteLength = Object.values(buffers).reduce((sum, values) => sum + values.byteLength, 0);
    const template = Object.freeze({vertexCount: physicalHeights.length, triangleCount: triangles.length / 3, byteLength});
    terrainTemplates.set(template, buffers);
    return template;
}

/** Rebuild detached display/query buffers without resampling or restitching the immutable template. */
export function scaleGlobeTerrainMesh(template: GlobeTerrainMeshTemplate, exaggeration = 1): GlobeTerrainMesh {
    const steps = scaleGlobeTerrainMeshSteps(template, exaggeration);
    let result = steps.next();
    while (!result.done) result = steps.next();
    return result.value;
}

/** Cooperatively rescale identical packed vertices/lighting; yields every 128 vertices without resampling. */
export function* scaleGlobeTerrainMeshSteps(template: GlobeTerrainMeshTemplate, exaggeration = 1): Generator<void, GlobeTerrainMesh, void> {
    getGlobeTerrainExaggeration(0, exaggeration);
    const prepared = terrainTemplates.get(template);
    if (!prepared) throw new Error('Globe terrain template must come from prepareGlobeTerrainMesh');
    const geographicPositions = new Float32Array(template.vertexCount * 3), positions = new Float64Array(template.vertexCount * 3), colors = new Float32Array(template.vertexCount * 3);
    for (let index = 0; index < template.vertexCount; index++) {
        const offset = index * 3, height = prepared.heights[index];
        const valid = !Number.isNaN(height);
        if (valid && EARTH_RADIUS + height * exaggeration <= 0) throw new Error('Invalid globe terrain elevation');
        geographicPositions[offset] = prepared.coordinates[index * 2];
        geographicPositions[offset + 1] = prepared.coordinates[index * 2 + 1];
        geographicPositions[offset + 2] = (valid ? height : 0) * exaggeration;
        if (!Number.isFinite(geographicPositions[offset + 2])) throw new Error('Globe terrain elevation exceeds packed display range');
        const radiusScale = 1 + geographicPositions[offset + 2] / EARTH_RADIUS;
        const gradientX = prepared.gradients[index * 2] * exaggeration / radiusScale, gradientY = prepared.gradients[index * 2 + 1] * exaggeration / radiusScale;
        const sinLongitude = prepared.frame[index * 4], cosLongitude = prepared.frame[index * 4 + 1], sinLatitude = prepared.frame[index * 4 + 2], cosLatitude = prepared.frame[index * 4 + 3];
        const radialX = sinLongitude * cosLatitude, radialY = -cosLongitude * cosLatitude;
        const radius = GLOBE_RADIUS * radiusScale;
        positions[offset] = radialX * radius; positions[offset + 1] = radialY * radius; positions[offset + 2] = sinLatitude * radius;
        const normalX = radialX - gradientX * cosLongitude - gradientY * (-sinLongitude * sinLatitude);
        const normalY = radialY - gradientX * sinLongitude - gradientY * (cosLongitude * sinLatitude);
        const normalZ = sinLatitude - gradientX * 0 - gradientY * cosLatitude;
        if (![normalX, normalY, normalZ].every(Number.isFinite)) throw new Error('Invalid globe terrain slope');
        const light = 0.4 + 0.6 * Math.max(0, (normalX - normalY + normalZ) / (Math.hypot(normalX, normalY, normalZ) * Math.sqrt(3)));
        colors[offset] = (height > 2500 ? 0.9 : height <= 0 ? 0.12 : 0.36) * light;
        colors[offset + 1] = (height > 2500 ? 0.92 : height <= 0 ? 0.3 : 0.58) * light;
        colors[offset + 2] = (height > 2500 ? 0.96 : height <= 0 ? 0.48 : 0.34) * light;
        if (index % 128 === 127) yield;
    }
    return {geographicPositions, positions, physicalHeights: prepared.physicalHeights.slice(), indices: prepared.indices.slice(), colors};
}
