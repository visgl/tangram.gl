// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {sampleTerrainNeighborhood} from '../map-logic/terrain-neighborhood';
import type {TerrainHeightGrid} from '../map-logic/terrain-data';
import {PROJECTION_CONSTANTS} from '../scene/projection_math';
import {refineGlobeMesh} from '../gl/globe_mesh';
import VertexLayout from '../gl/vertex_layout';

/** Opt-in physical-height basemap displacement, independent of deck, providers and GPU ownership. */
export interface TerrainDrapingOptions {
    /** Non-overlapping loaded EPSG:3857 height grids; missing coverage hides geometry. */
    grids: readonly TerrainHeightGrid[];
    /** Previous admitted grids, sampled at the new vertices for temporal height morphing. */
    previousGrids?: readonly TerrainHeightGrid[];
    /** Horizontal edge target in Mercator meters; default 250, constrained by per-tile detail and vertex budgets. */
    maxSegmentLength?: number;
    /** Maximum additional vertices in one worker mesh; default 131072. */
    maxAdditionalVertices?: number;
    /** Completed interleaved vertex/index bytes per mesh; default 16 MiB. */
    maxMeshBytes?: number;
    /** Owned current/previous grid arrays per scene/worker, default 32 MiB. */
    maxGridBytes?: number;
    /** Height and slope interpolation duration per newly displayed mesh, default 200 ms. */
    transitionDuration?: number;
}

/** Validated, detached physical input; typed-array contents are immutable by contract. */
export interface TerrainDrapingSnapshot extends Required<TerrainDrapingOptions> {
    /** Exact owned height/mask array bytes; excludes structured-clone and scratch allocations. */
    byteLength: number;
    /** Lowest valid current/previous height for safe spherical exaggeration. */
    minimumHeight: number;
}

/** Completed worker preparation cost; does not claim a total GPU/transient memory budget. */
export interface TerrainMeshPreparation {
    /** Original packed vertex count. */
    inputVertices: number;
    /** Prepared vertices, including retained originals. */
    vertices: number;
    /** Admitted triangle count. */
    triangles: number;
    /** Refined triangles conservatively removed for missing coverage. */
    suppressedTriangles: number;
    /** Completed interleaved vertex and index bytes. */
    meshBytes: number;
    /** Monotonic worker wall time for topology, sampling and mask admission. */
    preparationMs: number;
    /** Effective Mercator edge target, not a certified terrain error. */
    edgeTarget: number;
    /** The per-tile detail floor prevented the requested edge target. */
    detailLimited: boolean;
}

/** Resident preparation counters useful to compare detail policies on a real host. */
export interface TerrainDrapingStatistics {
    /** Whether displacement attributes were enabled at construction. */
    enabled: boolean;
    /** Owned current/previous height-array bytes per scene/worker copy. */
    gridBytes: number;
    /** Resident completed draped meshes, including off-screen retained tiles. */
    meshes: number;
    /** Resident prepared vertex count. */
    vertices: number;
    /** Resident admitted triangles. */
    triangles: number;
    /** Resident rejected no-data triangles. */
    suppressedTriangles: number;
    /** Resident completed worker output bytes; excludes GPU copies and scratch. */
    meshBytes: number;
    /** Slowest resident worker mesh preparation. */
    maximumPreparationMs: number;
    /** Resident meshes constrained by the per-tile detail floor. */
    detailLimitedMeshes: number;
}

/** Validate and snapshot terrain before changing a scene or rebuilding workers. */
export function normalizeTerrainDraping(options: TerrainDrapingOptions): TerrainDrapingSnapshot {
    const maximum = options.maxGridBytes ?? 32 * 1024 * 1024;
    const segment = options.maxSegmentLength ?? 250;
    const vertices = options.maxAdditionalVertices ?? 131072;
    const meshBytes = options.maxMeshBytes ?? 16 * 1024 * 1024;
    const duration = options.transitionDuration ?? 200;
    if (!Number.isSafeInteger(maximum) || maximum < 0 || !Number.isFinite(segment) || segment < 1 ||
        !Number.isSafeInteger(vertices) || vertices < 0 || vertices > 262144 || !Number.isSafeInteger(meshBytes) || meshBytes < 0 ||
        !Number.isFinite(duration) || duration < 0 || duration > 5000) throw new Error('Invalid terrain draping limits');
    const previous = options.previousGrids ?? [];
    let bytes = 0;
    let minimumHeight = 0;
    const datum = [...options.grids, ...previous][0]?.verticalDatum;
    for (const grids of [options.grids, previous]) {
        if (grids.length > 96) throw new Error('Terrain draping accepts at most 96 grids per generation');
        for (const [index, grid] of grids.entries()) {
            const [west, south, east, north] = grid.bounds;
            if (!Number.isSafeInteger(grid.width) || !Number.isSafeInteger(grid.height) || grid.width < 2 || grid.height < 2 ||
                grid.width * grid.height !== grid.heights.length || grid.valid.length !== grid.heights.length ||
                grid.bounds.length !== 4 || !grid.bounds.every(Number.isFinite) || west >= east || south >= north ||
                Math.max(Math.abs(south), Math.abs(north)) > Math.PI * PROJECTION_CONSTANTS.mercatorRadius ||
                !['grid-node', 'pixel-center'].includes(grid.registration) ||
                !['unknown', 'ellipsoidal', 'orthometric'].includes(grid.verticalDatum) || grid.verticalDatum !== datum ||
                grid.valid.some((valid, position) => valid !== 0 && (valid !== 1 || !Number.isFinite(Math.fround(grid.heights[position])) || Math.abs(grid.heights[position]) > PROJECTION_CONSTANTS.earthRadius))) throw new Error('Invalid terrain draping height grid or datum');
            for (const other of grids.slice(0, index)) if (Math.min(east, other.bounds[2]) > Math.max(west, other.bounds[0]) && Math.min(north, other.bounds[3]) > Math.max(south, other.bounds[1])) throw new Error('Terrain draping grids must not overlap');
            for (let position = 0; position < grid.heights.length; position++) if (grid.valid[position]) minimumHeight = Math.min(minimumHeight, grid.heights[position]);
            bytes += grid.heights.length * 5;
        }
    }
    if (bytes > maximum) throw new Error('Terrain draping grid-byte budget exceeded');
    if (minimumHeight <= -PROJECTION_CONSTANTS.earthRadius) throw new Error('Terrain height would invert the globe radius');
    const copy = (grids: readonly TerrainHeightGrid[]): TerrainHeightGrid[] => grids.map(grid => ({...grid, bounds: [...grid.bounds], heights: Float32Array.from(grid.heights), valid: Uint8Array.from(grid.valid)}));
    return {grids: copy(options.grids), previousGrids: copy(previous), maxSegmentLength: segment, maxAdditionalVertices: vertices,
        maxGridBytes: maximum, maxMeshBytes: meshBytes, transitionDuration: duration, byteLength: bytes, minimumHeight};
}

const layouts = new WeakMap<VertexLayout, VertexLayout>();
/** Admit source work only where current physical heights can produce drawable geometry. */
export function hasTerrainTileCoverage(grids: readonly TerrainHeightGrid[], coordinates: {x: number; y: number; z: number}): boolean {
    const circumference = 2 * Math.PI * PROJECTION_CONSTANTS.mercatorRadius;
    const edge = circumference / 2 ** coordinates.z;
    const west = coordinates.x * edge - circumference / 2;
    const north = circumference / 2 - coordinates.y * edge;
    return grids.some(grid => west < grid.bounds[2] && west + edge > grid.bounds[0] && north > grid.bounds[1] && north - edge < grid.bounds[3]);
}
const baseLayouts = new WeakMap<VertexLayout, VertexLayout>();
/** Preserve packed identity channels, but refine terrain positions and ribbon corners without integer rounding. */
function getTerrainBaseLayout(original: VertexLayout): VertexLayout {
    let layout = baseLayouts.get(original);
    if (!layout) {
        const ribbon = original.offset.a_extrude !== undefined;
        layout = new VertexLayout(original.attribs.map(attribute => ({...attribute,
            type: attribute.static == null && attribute.type === 5122 &&
                (attribute.name === 'a_position' || ribbon && ['a_extrude', 'a_offset'].includes(attribute.name)) ? 5126 : attribute.type})));
        baseLayouts.set(original, layout);
    }
    return layout;
}
/** Add terrain data only after the original packed mesh has been completed. */
export function getTerrainVertexLayout(original: VertexLayout): VertexLayout {
    let layout = layouts.get(original);
    if (!layout) {
        layout = new VertexLayout([...getTerrainBaseLayout(original).attribs.map(attribute => ({...attribute})),
            {name: 'a_terrain', size: 4, type: 0x1406, normalized: false},
            {name: 'a_terrain_previous', size: 4, type: 0x1406, normalized: false}]);
        layouts.set(original, layout);
    }
    return layout;
}

/** Worker-side topology and samples; retains original feature/label vertex identities. */
export function drapeTerrainMesh(options: {
    /** Completed original packed vertices. */
    vertices: Uint8Array;
    /** Triangle topology, or an implicit non-indexed triangle list. */
    indices: Uint16Array | Uint32Array | false;
    /** Original layout before appending height/slope data. */
    layout: VertexLayout;
    /** Absolute Mercator origin of tile-local coordinates. */
    origin: readonly [number, number];
    /** Source tile zoom and its packed XY edge size. */
    tileZoom: number;
    /** Styling zoom, independent of source detail; bounds possible screen-space ribbon expansion. */
    styleZoom?: number;
    /** Do not refine screen-space annotation quads. */
    annotations?: boolean;
    /** Validated immutable current/previous heights and resource policy. */
    terrain: TerrainDrapingSnapshot;
}): {vertices: Uint8Array; indices: Uint16Array | Uint32Array; byteLength: number; statistics: TerrainMeshPreparation} {
    const started = performance.now();
    const statistics: TerrainMeshPreparation = {inputVertices: 0, vertices: 0, triangles: 0, suppressedTriangles: 0, meshBytes: 0, preparationMs: 0, edgeTarget: 0, detailLimited: false};
    const {terrain, layout, origin} = options;
    if (!Number.isInteger(options.tileZoom) || options.tileZoom < 0 || options.tileZoom > 30 || !origin.every(Number.isFinite)) throw new Error('Invalid terrain draping tile');
    const styleZoom = options.styleZoom ?? options.tileZoom;
    if (!Number.isFinite(styleZoom) || styleZoom < 0 || styleZoom > 30) throw new Error('Invalid terrain draping style zoom');
    const ribbonScale = 2 ** Math.max(0, options.tileZoom - styleZoom);
    const metersPerUnit = 2 * Math.PI * PROJECTION_CONSTANTS.mercatorRadius / (4096 * 2 ** options.tileZoom);
    const positionOffset = layout.offset.a_position;
    const positionAttribute = layout.attribs.find(attribute => attribute.name === 'a_position');
    const originalCount = options.vertices.byteLength / layout.stride;
    statistics.inputVertices = originalCount;
    if (positionOffset === undefined || positionAttribute?.type !== 5122 || positionAttribute.size < 2 || !Number.isInteger(originalCount)) throw new Error('Terrain draping requires aligned packed XY vertices');
    const originalIndices = options.indices || Uint32Array.from({length: originalCount}, (_, index) => index);
    if (originalIndices.length % 3 || originalIndices.some(index => index >= originalCount)) throw new Error('Terrain draping requires valid triangle indices');
    if (!originalCount || !terrain.grids.length) return {vertices: new Uint8Array(), indices: new Uint16Array(), byteLength: 0, statistics};
    const requestedCell = Math.min(terrain.maxSegmentLength, ...terrain.grids.flatMap(grid => [
        (grid.bounds[2] - grid.bounds[0]) / (grid.registration === 'pixel-center' ? grid.width : grid.width - 1) / 2,
        (grid.bounds[3] - grid.bounds[1]) / (grid.registration === 'pixel-center' ? grid.height : grid.height - 1) / 2]));
    // Bound full-tile refinement independently of provider resolution. Floating
    // positions retain skinny source triangles; this floor is a detail policy,
    // not a packed-precision workaround or a certified terrain error bound.
    const cell = Math.max(requestedCell, 64 * metersPerUnit);
    statistics.edgeTarget = cell; statistics.detailLimited = cell > requestedCell;
    const outputLayout = getTerrainVertexLayout(layout);
    const baseLayout = getTerrainBaseLayout(layout);
    const extrusionOffset = layout.offset.a_extrude;
    // Ribbon topology is not its collapsed centerline. Keep dynamic extrusion
    // attributes intact while using their nominal corners for refinement.
    const readPosition = (vertex: DataView): [number, number] => [
        vertex.getFloat32(baseLayout.offset.a_position, true) + (extrusionOffset === undefined ? 0 : vertex.getFloat32(baseLayout.offset.a_extrude, true) * ribbonScale),
        vertex.getFloat32(baseLayout.offset.a_position + 4, true) + (extrusionOffset === undefined ? 0 : vertex.getFloat32(baseLayout.offset.a_extrude + 4, true) * ribbonScale)
    ];
    const bounds = [Infinity, Infinity, -Infinity, -Infinity];
    const source = new DataView(options.vertices.buffer, options.vertices.byteOffset, options.vertices.byteLength);
    for (let index = 0; index < originalCount; index++) {
        const offset = index * layout.stride;
        const coordinate = [origin[0] + source.getInt16(offset + positionOffset, true) * metersPerUnit, origin[1] + source.getInt16(offset + positionOffset + 2, true) * metersPerUnit];
        for (let axis = 0; axis < 2; axis++) {
            const ribbonOffset = layout.offset.a_offset;
            const extent = extrusionOffset === undefined ? 0 : 2 * ribbonScale * (Math.abs(source.getInt16(offset + extrusionOffset + axis * 2, true)) + (ribbonOffset === undefined ? 0 : Math.abs(source.getInt16(offset + ribbonOffset + axis * 2, true)))) * metersPerUnit;
            bounds[axis] = Math.min(bounds[axis], coordinate[axis] - extent);
            bounds[axis + 2] = Math.max(bounds[axis + 2], coordinate[axis] + extent);
        }
    }
    if (!terrain.grids.some(grid => bounds[0] <= grid.bounds[2] && bounds[2] >= grid.bounds[0] && bounds[1] <= grid.bounds[3] && bounds[3] >= grid.bounds[1])) {
        statistics.suppressedTriangles = originalIndices.length / 3;
        statistics.preparationMs = performance.now() - started;
        return {vertices: new Uint8Array(), indices: new Uint16Array(), byteLength: 0, statistics};
    }
    if (options.vertices.byteLength / layout.stride * outputLayout.stride > terrain.maxMeshBytes) throw new Error('Terrain draping mesh-byte budget exceeded');
    const floating = new Uint8Array(originalCount * baseLayout.stride);
    const floatingView = new DataView(floating.buffer);
    for (let index = 0; index < originalCount; index++) for (const attribute of layout.dynamic_attribs) {
        const from = index * layout.stride + layout.offset[attribute.name];
        const to = index * baseLayout.stride + baseLayout.offset[attribute.name];
        const promoted = attribute.type !== baseLayout.dynamic_attribs.find(candidate => candidate.name === attribute.name)?.type;
        if (promoted) for (let component = 0; component < attribute.size; component++) floatingView.setFloat32(to + component * 4, source.getInt16(from + component * 2, true), true);
        else floating.set(options.vertices.subarray(from, from + attribute.byte_size!), to);
    }
    const refined = options.annotations ? {vertices: floating, indices: originalIndices} : refineGlobeMesh(floating, originalIndices, baseLayout,
        {tileZoom: options.tileZoom, maxAngularSpan: Math.min(180, cell / PROJECTION_CONSTANTS.mercatorRadius * 180 / Math.PI), maxAdditionalVertices: terrain.maxAdditionalVertices, splitRemainderShortest: true, getPosition: readPosition});
    const count = refined.vertices.byteLength / baseLayout.stride;
    const required = count * outputLayout.stride + refined.indices.byteLength;
    if (required > terrain.maxMeshBytes) throw new Error('Terrain draping mesh-byte budget exceeded');
    const vertices = new Uint8Array(count * outputLayout.stride);
    const view = new DataView(vertices.buffer);
    const valid = new Uint8Array(count);
    const coordinates: [number, number][] = [];
    const ribbonBounds: [number, number][][] = [];
    for (let index = 0; index < count; index++) {
        const input = new DataView(refined.vertices.buffer, refined.vertices.byteOffset + index * baseLayout.stride, baseLayout.stride);
        vertices.set(refined.vertices.subarray(index * baseLayout.stride, (index + 1) * baseLayout.stride), index * outputLayout.stride);
        const coordinate: [number, number] = [origin[0] + input.getFloat32(baseLayout.offset.a_position, true) * metersPerUnit, origin[1] + input.getFloat32(baseLayout.offset.a_position + 4, true) * metersPerUnit];
        coordinates.push(coordinate);
        if (extrusionOffset !== undefined) {
            const offset = baseLayout.offset.a_offset;
            const extrude = baseLayout.offset.a_extrude;
            const horizontal = 2 * ribbonScale * (Math.abs(input.getFloat32(extrude, true)) + (offset === undefined ? 0 : Math.abs(input.getFloat32(offset, true)))) * metersPerUnit;
            const vertical = 2 * ribbonScale * (Math.abs(input.getFloat32(extrude + 4, true)) + (offset === undefined ? 0 : Math.abs(input.getFloat32(offset + 4, true)))) * metersPerUnit;
            ribbonBounds.push([[coordinate[0] - horizontal, coordinate[1] - vertical], [coordinate[0] + horizontal, coordinate[1] + vertical]]);
        }
        const current = sampleTerrainNeighborhood(terrain.grids, coordinate);
        valid[index] = Number(current !== null);
        const previousSample = sampleTerrainNeighborhood(terrain.previousGrids, coordinate);
        const previous = previousSample ?? current;
        const latitudeCosine = 1 / Math.cosh(coordinate[1] / PROJECTION_CONSTANTS.mercatorRadius);
        for (const [grids, height, attribute] of [[terrain.grids, current, 'a_terrain'], [previousSample === null ? terrain.grids : terrain.previousGrids, previous, 'a_terrain_previous']] as const) {
            const slope = [0, 1].map(axis => {
                const negative: [number, number] = [...coordinate], positive: [number, number] = [...coordinate];
                negative[axis] -= cell; positive[axis] += cell;
                const before = sampleTerrainNeighborhood(grids, negative), after = sampleTerrainNeighborhood(grids, positive);
                return height === null ? 0 : before !== null && after !== null ? (after - before) / (2 * cell * latitudeCosine) : after !== null ? (after - height) / (cell * latitudeCosine) : before !== null ? (height - before) / (cell * latitudeCosine) : 0;
            });
            const offset = index * outputLayout.stride + outputLayout.offset[attribute];
            [height ?? 0, slope[0], slope[1], Number(height !== null)].forEach((value, component) => {
                if (!Number.isFinite(Math.fround(value))) throw new Error('Terrain draping sample exceeds packed range');
                view.setFloat32(offset + component * 4, value, true);
            });
        }
    }
    const indices: number[] = [];
    const coverage = createCoverageTest(terrain.grids);
    for (let index = 0; index < refined.indices.length; index += 3) {
        const triangle = [refined.indices[index], refined.indices[index + 1], refined.indices[index + 2]];
        if (triangle.every(vertex => valid[vertex]) && (options.annotations || coverage(extrusionOffset === undefined ? triangle.map(vertex => coordinates[vertex]) : triangle.flatMap(vertex => ribbonBounds[vertex])))) indices.push(...triangle);
    }
    const elements = count > 65535 ? Uint32Array.from(indices) : Uint16Array.from(indices);
    const byteLength = vertices.byteLength + elements.byteLength;
    Object.assign(statistics, {vertices: count, triangles: elements.length / 3, suppressedTriangles: (refined.indices.length - elements.length) / 3, meshBytes: byteLength, preparationMs: performance.now() - started});
    return {vertices, indices: elements, byteLength, statistics};
}

/** Conservative footprint/mask admission: no triangle may bridge an unloaded or invalid cell. */
function createCoverageTest(grids: readonly TerrainHeightGrid[]): (positions: readonly (readonly [number, number])[]) => boolean {
    // Prefix sums make sparse no-data checks independent of triangle size. Scratch is
    // at most four bytes per height sample, plus one border row/column per grid.
    const masks = grids.map(grid => {
        if (grid.valid.every(Boolean)) return null;
        const stride = grid.width + 1;
        const sums = new Uint32Array(stride * (grid.height + 1));
        for (let row = 0; row < grid.height; row++) for (let column = 0; column < grid.width; column++) {
            const index = (row + 1) * stride + column + 1;
            sums[index] = Number(!grid.valid[row * grid.width + column]) + sums[index - 1] + sums[index - stride] - sums[index - stride - 1];
        }
        return sums;
    });
    return positions => {
        const west = Math.min(...positions.map(position => position[0])), east = Math.max(...positions.map(position => position[0]));
        const south = Math.min(...positions.map(position => position[1])), north = Math.max(...positions.map(position => position[1]));
        const width = east - west, height = north - south;
        if (!width && !height) return true; // All anchor samples were already validated.
        const total = width && height ? width * height : width || height;
        let covered = 0;
        for (const [index, grid] of grids.entries()) {
            const left = Math.max(west, grid.bounds[0]), right = Math.min(east, grid.bounds[2]);
            const bottom = Math.max(south, grid.bounds[1]), top = Math.min(north, grid.bounds[3]);
            if (left > right || bottom > top || width && left === right || height && bottom === top) continue;
            const mask = masks[index];
            if (mask) {
                const pixel = grid.registration === 'pixel-center';
                const column = (x: number) => Math.max(0, Math.min(grid.width - 1, (x - grid.bounds[0]) / (grid.bounds[2] - grid.bounds[0]) * (pixel ? grid.width : grid.width - 1) - (pixel ? 0.5 : 0)));
                const row = (y: number) => Math.max(0, Math.min(grid.height - 1, (grid.bounds[3] - y) / (grid.bounds[3] - grid.bounds[1]) * (pixel ? grid.height : grid.height - 1) - (pixel ? 0.5 : 0)));
                const firstColumn = Math.floor(column(left)), lastColumn = Math.ceil(column(right)) + 1;
                const firstRow = Math.floor(row(top)), lastRow = Math.ceil(row(bottom)) + 1;
                const stride = grid.width + 1;
                if (mask[lastRow * stride + lastColumn] - mask[firstRow * stride + lastColumn] - mask[lastRow * stride + firstColumn] + mask[firstRow * stride + firstColumn]) return false;
            }
            covered += width && height ? (right - left) * (top - bottom) : width ? right - left : top - bottom;
        }
        // Non-overlap is validated on admission; additive footprint area is safe.
        return covered >= total * (1 - 1e-10);
    };
}
