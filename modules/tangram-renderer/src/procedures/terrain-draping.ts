// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {TerrainHeightField} from '../map-logic/terrain-height-field';
import type {TerrainHeightGrid} from '../map-logic/terrain-data';
import {PROJECTION_CONSTANTS} from '../scene/projection_math';
import {refineGlobeMesh} from '../gl/globe_mesh';
import VertexLayout from '../gl/vertex_layout';
import type {DrapedTerrainQueryMesh} from '../selection/draped-terrain-surface';
import {summarizeDrapedTerrainBounds} from '../map-logic/draped-terrain-bounds';
import {PACKED_HEIGHT_SCALE} from '../gl/vertex-constants';
import {createTerrainGroundTopology, wrapTerrainGroundGrids, type TerrainGroundTopology} from '../map-logic/terrain-ground-topology';
import {conformTerrainStyledMesh, type TerrainStyledTopology} from './terrain-styled-topology';

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
    /** Shared height/slope interpolation duration per admitted terrain field, default 200 ms. */
    transitionDuration?: number;
    /** Ground style names whose exact final triangles are retained for physical queries; default empty. */
    querySurfaceStyles?: readonly string[];
    /** Opt-in DEM-owned ground cells per tile axis (2, 4, 8, 16, 32, 64), also conforming polygons/roads; zero keeps legacy refinement. */
    groundMeshResolution?: number;
    /** Retained query channels per mesh, default 8 MiB; separate from completed draw bytes. */
    maxQueryMeshBytes?: number;
    /** Additional staged draw/query buffers across a replacement generation; default 64 MiB, excluding GPU overhead. */
    maxStagedMeshBytes?: number;
    /** Aggregate acceleration reservation for the current draped query snapshot; default 16 MiB. */
    maxQueryIndexBytes?: number;
    /** Retained projected picking geometry per snapshot; default 32 MiB, with exact streaming fallback. */
    maxProjectedQueryBytes?: number;
    /** Cooperative query-index warming target per host frame in milliseconds; default 2. */
    queryPreparationBudgetMs?: number;
    /** Test annotation fragments against rendered terrain and omit fully blocked collision candidates; default false. */
    occludeAnnotations?: boolean;
}

/** Validated, detached physical input; typed-array contents are immutable by contract. */
export interface TerrainDrapingSnapshot extends Required<TerrainDrapingOptions> {
    /** Renderer-owned field epoch; unrelated scene/source rebuilds preserve this identity. */
    transitionGeneration: number;
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
    /** Effective Mercator edge target; canonical ground reports its maximum admitted edge, not a certified error. */
    edgeTarget: number;
    /** The per-tile detail floor prevented the requested edge target. */
    detailLimited: boolean;
    /** Explicit source-independent ground resolution; absent on legacy polygons/ribbons/annotations. */
    canonicalGroundResolution?: number;
    /** Canonical cell resolution used to cut authored polygons or nominal expanded road faces. */
    canonicalStyledResolution?: number;
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
    /** Retained exact ground topology and height channels, excluding lazy projected query copies. */
    queryBytes: number;
    /** New draw/query buffers waiting for all worker batches to complete. */
    stagedMeshBytes: number;
    /** Snapshot-local annotation query costs; excludes separately retained host snapshots. */
    annotationQueries?: import('../selection/draped-terrain-surface').DrapedTerrainQueryStatistics;
}

/** Validate and snapshot terrain before changing a scene or rebuilding workers. */
export function normalizeTerrainDraping(options: TerrainDrapingOptions): TerrainDrapingSnapshot {
    const maximum = options.maxGridBytes ?? 32 * 1024 * 1024;
    const segment = options.maxSegmentLength ?? 250;
    const vertices = options.maxAdditionalVertices ?? 131072;
    const meshBytes = options.maxMeshBytes ?? 16 * 1024 * 1024;
    const duration = options.transitionDuration ?? 200;
    const querySurfaceStyles = options.querySurfaceStyles ?? [];
    const groundMeshResolution = options.groundMeshResolution ?? 0;
    const maxQueryMeshBytes = options.maxQueryMeshBytes ?? 8 * 1024 * 1024;
    const maxStagedMeshBytes = options.maxStagedMeshBytes ?? 64 * 1024 * 1024;
    const maxQueryIndexBytes = options.maxQueryIndexBytes ?? 16 * 1024 * 1024;
    const maxProjectedQueryBytes = options.maxProjectedQueryBytes ?? 32 * 1024 * 1024;
    const queryPreparationBudgetMs = options.queryPreparationBudgetMs ?? 2;
    const occludeAnnotations = options.occludeAnnotations ?? false;
    if (!Number.isSafeInteger(maximum) || maximum < 0 || !Number.isFinite(segment) || segment < 1 ||
        !Number.isSafeInteger(vertices) || vertices < 0 || vertices > 262144 || !Number.isSafeInteger(meshBytes) || meshBytes < 0 ||
        !Number.isFinite(duration) || duration < 0 || duration > 5000 ||
        ![maxQueryMeshBytes, maxStagedMeshBytes, maxQueryIndexBytes, maxProjectedQueryBytes].every(value => Number.isSafeInteger(value) && value >= 0) ||
        !Number.isFinite(queryPreparationBudgetMs) || queryPreparationBudgetMs < 0 || queryPreparationBudgetMs > 20 ||
        typeof occludeAnnotations !== 'boolean' ||
        !Number.isSafeInteger(groundMeshResolution) || groundMeshResolution !== 0 && (groundMeshResolution < 2 || groundMeshResolution > 64 || (groundMeshResolution & (groundMeshResolution - 1)) !== 0) ||
        querySurfaceStyles.some(name => typeof name !== 'string' || !name.length) || new Set(querySurfaceStyles).size !== querySurfaceStyles.length) throw new Error('Invalid terrain draping limits');
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
        maxGridBytes: maximum, maxMeshBytes: meshBytes, transitionDuration: duration, transitionGeneration: 0, byteLength: bytes, minimumHeight,
        querySurfaceStyles: [...querySurfaceStyles], groundMeshResolution, maxQueryMeshBytes, maxStagedMeshBytes, maxQueryIndexBytes, maxProjectedQueryBytes, queryPreparationBudgetMs, occludeAnnotations};
}

/**
 * Retain the final draw's ground channels and topology, never another DEM mesh.
 * @param canonicalPositions - Optional exact lattice XY, avoiding source-origin reconstruction ulps at terminal bounds.
 */
export function extractDrapedTerrainQueryMesh(vertices: Uint8Array, indices: Uint16Array | Uint32Array, layout: VertexLayout,
    origin: readonly [number, number], tileZoom: number, byteLimit: number, canonicalPositions?: Float64Array): DrapedTerrainQueryMesh {
    const count = vertices.byteLength / layout.stride;
    if (!Number.isInteger(count) || count * 32 + indices.byteLength > byteLimit) throw new Error('Terrain query mesh-byte budget exceeded');
    if (canonicalPositions && (canonicalPositions.length !== count * 2 || !canonicalPositions.every(Number.isFinite))) throw new Error('Invalid canonical terrain query positions');
    const positions = new Float64Array(count * 3), heights = new Float32Array(count * 2);
    const data = new DataView(vertices.buffer, vertices.byteOffset, vertices.byteLength);
    const scale = 2 * Math.PI * PROJECTION_CONSTANTS.mercatorRadius / (4096 * 2 ** tileZoom);
    for (let vertex = 0; vertex < count; vertex++) {
        const position = vertex * layout.stride + layout.offset.a_position;
        positions.set([canonicalPositions?.[vertex * 2] ?? origin[0] + data.getFloat32(position, true) * scale,
            canonicalPositions?.[vertex * 2 + 1] ?? origin[1] + data.getFloat32(position + 4, true) * scale,
            data.getFloat32(position + 8, true) / PACKED_HEIGHT_SCALE], vertex * 3);
        heights.set([data.getFloat32(vertex * layout.stride + layout.offset.a_terrain, true), data.getFloat32(vertex * layout.stride + layout.offset.a_terrain_previous, true)], vertex * 2);
    }
    const bounds: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const vertex of indices) {
        bounds[0] = Math.min(bounds[0], positions[vertex * 3]); bounds[1] = Math.min(bounds[1], positions[vertex * 3 + 1]);
        bounds[2] = Math.max(bounds[2], positions[vertex * 3]); bounds[3] = Math.max(bounds[3], positions[vertex * 3 + 1]);
    }
    const mesh = {positions, heights, indices: indices.slice(), bounds};
    return {...mesh, boundsSummary: summarizeDrapedTerrainBounds(mesh)};
}

const layouts = new WeakMap<VertexLayout, VertexLayout>();
/** One immutable current/previous sampling index per worker field, shared by every style mesh. */
const heightFields = new WeakMap<TerrainDrapingSnapshot, {current: TerrainHeightField; previous: TerrainHeightField}>();
/** One periodic current field and at most three absolute-world previous indexes; source arrays remain shared. */
const groundHeightFields = new WeakMap<TerrainDrapingSnapshot, {current: TerrainHeightField; previous: Map<number, TerrainHeightField>}>();

/** Reuse bounded masks and spatial lookup across styles; replaced field identities release the cache. */
function getHeightFields(terrain: TerrainDrapingSnapshot, ground = false, samplingWorldOffset = 0): {current: TerrainHeightField; previous: TerrainHeightField} {
    if (ground) {
        let fields = groundHeightFields.get(terrain);
        if (!fields) {
            fields = {current: new TerrainHeightField(wrapTerrainGroundGrids(terrain.grids)), previous: new Map()};
            groundHeightFields.set(terrain, fields);
        }
        let previous = fields.previous.get(samplingWorldOffset);
        if (!previous) {
            // All previous samples share one absolute domain, retaining generic/
            // quadtree boundary averaging. Previous fields need no mask prefixes.
            previous = new TerrainHeightField(wrapTerrainGroundGrids(terrain.previousGrids, false, samplingWorldOffset), {maxMaskBytes: 0});
            fields.previous.set(samplingWorldOffset, previous);
            while (fields.previous.size > 3) fields.previous.delete(fields.previous.keys().next().value!);
        }
        return {current: fields.current, previous};
    }
    let fields = heightFields.get(terrain);
    if (!fields) {
        fields = {current: new TerrainHeightField(terrain.grids), previous: new TerrainHeightField(terrain.previousGrids)};
        heightFields.set(terrain, fields);
    }
    return fields;
}
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
    /** Explicit full-tile raster ground owner; source clipping, not triangle cropping, partitions cells. */
    ground?: boolean;
    /** Cut polygon/line style faces against the canonical surface when groundMeshResolution is enabled. */
    styled?: boolean;
    /** Validated immutable current/previous heights and resource policy. */
    terrain: TerrainDrapingSnapshot;
}): {vertices: Uint8Array; indices: Uint16Array | Uint32Array; byteLength: number; statistics: TerrainMeshPreparation; groundClip?: boolean; groundPositions?: Float64Array} {
    const started = performance.now();
    const statistics: TerrainMeshPreparation = {inputVertices: 0, vertices: 0, triangles: 0, suppressedTriangles: 0, meshBytes: 0, preparationMs: 0, edgeTarget: 0, detailLimited: false};
    const {terrain, layout, origin} = options;
    const canonicalGround = Boolean(options.ground && terrain.groundMeshResolution);
    const canonicalStyled = Boolean(options.styled && !options.annotations && terrain.groundMeshResolution);
    if (canonicalGround && canonicalStyled) throw new Error('Terrain mesh cannot be both ground and styled');
    if (!Number.isInteger(options.tileZoom) || options.tileZoom < 0 || options.tileZoom > 30 || !origin.every(Number.isFinite)) throw new Error('Invalid terrain draping tile');
    const styleZoom = options.styleZoom ?? options.tileZoom;
    if (!Number.isFinite(styleZoom) || styleZoom < 0 || styleZoom > 30) throw new Error('Invalid terrain draping style zoom');
    const ribbonScale = 2 ** (options.tileZoom - styleZoom);
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
    const cell = canonicalGround || canonicalStyled ? requestedCell : Math.max(requestedCell, 64 * metersPerUnit);
    statistics.edgeTarget = cell; statistics.detailLimited = cell > requestedCell;
    const outputLayout = getTerrainVertexLayout(layout);
    const baseLayout = getTerrainBaseLayout(layout);
    const extrusionOffset = layout.offset.a_extrude;
    // Match the built-in ribbon at its authored style zoom (zoom_delta = 0).
    // Other zoom fractions retain the shader's local tangent correction.
    const getNominalOffset = (vertex: DataView, axis: number): number => {
        if (extrusionOffset === undefined) return 0;
        const widthScale = positionAttribute.size > 2 ? vertex.getFloat32(baseLayout.offset.a_position + 8, true) / 1024 : 0;
        const offsetScaleOffset = baseLayout.offset.a_z_and_offset_scale;
        const offsetWidthScale = offsetScaleOffset === undefined ? 0 : vertex.getInt16(offsetScaleOffset + 2, true) / 1024;
        const extrusion = vertex.getFloat32(baseLayout.offset.a_extrude + axis * 4, true) * (1 + widthScale);
        const offset = baseLayout.offset.a_offset === undefined ? 0 : vertex.getFloat32(baseLayout.offset.a_offset + axis * 4, true) * (1 - Math.max(0, -offsetWidthScale));
        return (extrusion + offset) * ribbonScale;
    };
    // Ribbon topology is not its collapsed centerline. Keep dynamic extrusion
    // attributes intact while using their nominal corners for refinement.
    const readPosition = (vertex: DataView): [number, number] => [
        vertex.getFloat32(baseLayout.offset.a_position, true) + getNominalOffset(vertex, 0),
        vertex.getFloat32(baseLayout.offset.a_position + 4, true) + getNominalOffset(vertex, 1)
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
    if (!canonicalGround && !canonicalStyled && !terrain.grids.some(grid => bounds[0] <= grid.bounds[2] && bounds[2] >= grid.bounds[0] && bounds[1] <= grid.bounds[3] && bounds[3] >= grid.bounds[1])) {
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
    let groundTopology: TerrainGroundTopology | undefined;
    if (canonicalGround) {
        const corners = new Set<string>();
        for (let index = 0; index < originalCount; index++) {
            const point = new DataView(floating.buffer, index * baseLayout.stride, baseLayout.stride);
            const x = point.getFloat32(baseLayout.offset.a_position, true), y = point.getFloat32(baseLayout.offset.a_position + 4, true);
            if (![0, 4096].includes(x) || ![0, -4096].includes(y)) throw new Error('Canonical terrain ground requires a full tile raster quad');
            corners.add(`${x},${y}`);
            for (const attribute of baseLayout.dynamic_attribs) {
                const offset = attribute.offset ?? 0, start = attribute.name === 'a_position' ? 8 : 0;
                for (let byte = start; byte < (attribute.byte_size ?? 0); byte++) if (floating[index * baseLayout.stride + offset + byte] !== floating[offset + byte]) throw new Error('Canonical terrain ground requires uniform quad attributes');
            }
        }
        if (corners.size !== 4 || originalIndices.length !== 6 || extrusionOffset !== undefined || options.annotations) throw new Error('Canonical terrain ground requires a full tile raster quad');
        groundTopology = createTerrainGroundTopology(terrain.grids, [origin[0], origin[1] - 4096 * metersPerUnit, origin[0] + 4096 * metersPerUnit, origin[1]],
            terrain.groundMeshResolution, Math.min(originalCount + terrain.maxAdditionalVertices, Math.floor(terrain.maxMeshBytes / outputLayout.stride)));
        validateCanonicalSourceLOD(terrain, options.tileZoom, [origin[0], origin[1] - 4096 * metersPerUnit, origin[0] + 4096 * metersPerUnit, origin[1]], groundTopology.sampleOffset);
        statistics.canonicalGroundResolution = terrain.groundMeshResolution;
    }
    let styledTopology: TerrainStyledTopology | undefined;
    if (canonicalStyled) {
        for (let index = 0; index < originalCount; index++) {
            const position = readPosition(new DataView(floating.buffer, index * baseLayout.stride, baseLayout.stride));
            for (let axis = 0; axis < 2; axis++) {
                const value = origin[axis] + position[axis] * metersPerUnit;
                bounds[axis] = Math.min(bounds[axis], value); bounds[axis + 2] = Math.max(bounds[axis + 2], value);
            }
        }
        const topologyBounds = [Math.min(bounds[0], origin[0]), Math.min(bounds[1], origin[1] - 4096 * metersPerUnit),
            Math.max(bounds[2], origin[0] + 4096 * metersPerUnit), Math.max(bounds[3], origin[1])] as const;
        groundTopology = createStyledGroundTopology(terrain.grids, topologyBounds, terrain.groundMeshResolution,
            Math.min(originalCount + terrain.maxAdditionalVertices, Math.floor(terrain.maxMeshBytes / outputLayout.stride)));
        validateCanonicalSourceLOD(terrain, options.tileZoom, topologyBounds, groundTopology.sampleOffset);
        const canonical = createCanonicalGroundVertices(groundTopology, floating, baseLayout, origin, options.tileZoom);
        const canonicalView = new DataView(canonical.buffer), surfacePositions = new Float64Array(groundTopology.positions.length);
        for (let index = 0; index < surfacePositions.length / 2; index++) for (let axis = 0; axis < 2; axis++) surfacePositions[index * 2 + axis] = canonicalView.getFloat32(index * baseLayout.stride + baseLayout.offset.a_position + axis * 4, true);
        styledTopology = conformTerrainStyledMesh({vertices: floating, indices: originalIndices, layout: baseLayout,
            surfacePositions, surfaceIndices: groundTopology.indices, getPosition: readPosition,
            getElevation: record => extrusionOffset === undefined ? positionAttribute.size > 2 ? record.getFloat32(baseLayout.offset.a_position + 8, true) : 0 :
                baseLayout.offset.a_z_and_offset_scale === undefined ? 0 : record.getInt16(baseLayout.offset.a_z_and_offset_scale, true),
            maxVertices: Math.min(originalCount + terrain.maxAdditionalVertices, Math.floor(terrain.maxMeshBytes / (outputLayout.stride + 12)))});
        statistics.canonicalStyledResolution = terrain.groundMeshResolution;
    }
    const refined = styledTopology ?? (groundTopology ? {vertices: createCanonicalGroundVertices(groundTopology, floating, baseLayout, origin, options.tileZoom), indices: groundTopology.indices} :
        options.annotations ? {vertices: floating, indices: originalIndices} : refineGlobeMesh(floating, originalIndices, baseLayout,
        {tileZoom: options.tileZoom, maxAngularSpan: Math.min(180, cell / PROJECTION_CONSTANTS.mercatorRadius * 180 / Math.PI), maxAdditionalVertices: terrain.maxAdditionalVertices, splitRemainderShortest: true, getPosition: readPosition}));
    const count = refined.vertices.byteLength / baseLayout.stride;
    const required = count * outputLayout.stride + refined.indices.byteLength;
    if (required > terrain.maxMeshBytes) throw new Error('Terrain draping mesh-byte budget exceeded');
    const vertices = new Uint8Array(count * outputLayout.stride);
    const fields = getHeightFields(terrain, canonicalGround || canonicalStyled, groundTopology?.sampleOffset);
    const canonicalSamples = new Map<number, ReturnType<typeof sampleTerrainChannels>>();
    const canonicalCoverage = new Map<string, boolean>();
    const getCanonicalSample = (index: number) => {
        let sample = canonicalSamples.get(index);
        if (!sample) {
            sample = sampleTerrainChannels(fields, [groundTopology!.samplePositions[index * 2], groundTopology!.samplePositions[index * 2 + 1]],
                [groundTopology!.positions[index * 2], groundTopology!.positions[index * 2 + 1]], cell);
            sample.channels = sample.channels.map(Math.fround);
            canonicalSamples.set(index, sample);
        }
        return sample;
    };
    const view = new DataView(vertices.buffer);
    const valid = new Uint8Array(count);
    const coordinates: [number, number][] = [];
    const ribbonBounds: [number, number][][] = [];
    for (let index = 0; index < count; index++) {
        const input = new DataView(refined.vertices.buffer, refined.vertices.byteOffset + index * baseLayout.stride, baseLayout.stride);
        vertices.set(refined.vertices.subarray(index * baseLayout.stride, (index + 1) * baseLayout.stride), index * outputLayout.stride);
        const coordinate: [number, number] = groundTopology && !styledTopology ? [groundTopology.samplePositions[index * 2], groundTopology.samplePositions[index * 2 + 1]] :
            [origin[0] + input.getFloat32(baseLayout.offset.a_position, true) * metersPerUnit, origin[1] + input.getFloat32(baseLayout.offset.a_position + 4, true) * metersPerUnit];
        if (styledTopology) coordinate[0] -= groundTopology!.sampleOffset;
        coordinates.push(coordinate);
        const nominalOffset: [number, number] = [getNominalOffset(input, 0), getNominalOffset(input, 1)];
        const sampleCoordinate: [number, number] = [coordinate[0] + nominalOffset[0] * metersPerUnit, coordinate[1] + nominalOffset[1] * metersPerUnit];
        if (extrusionOffset !== undefined) {
            const offset = baseLayout.offset.a_offset;
            const extrude = baseLayout.offset.a_extrude;
            const horizontal = 2 * ribbonScale * (Math.abs(input.getFloat32(extrude, true)) + (offset === undefined ? 0 : Math.abs(input.getFloat32(offset, true)))) * metersPerUnit;
            const vertical = 2 * ribbonScale * (Math.abs(input.getFloat32(extrude + 4, true)) + (offset === undefined ? 0 : Math.abs(input.getFloat32(offset + 4, true)))) * metersPerUnit;
            ribbonBounds.push([[coordinate[0] - horizontal, coordinate[1] - vertical], [coordinate[0] + horizontal, coordinate[1] + vertical]]);
        }
        const previousCoordinate: [number, number] = groundTopology ? [sampleCoordinate[0] + groundTopology.sampleOffset, sampleCoordinate[1]] : sampleCoordinate;
        let samples: ReturnType<typeof sampleTerrainChannels>;
        if (styledTopology) {
            const nodes = Array.from(styledTopology.surfaceIndices.subarray(index * 3, index * 3 + 3));
            const endpoints = nodes.map(getCanonicalSample), weights = styledTopology.surfaceWeights.subarray(index * 3, index * 3 + 3);
            const key = nodes.join(',');
            let covered = canonicalCoverage.get(key);
            if (covered === undefined) {
                covered = fields.current.coversBounds([Math.min(...nodes.map(node => groundTopology!.samplePositions[node * 2])), Math.min(...nodes.map(node => groundTopology!.samplePositions[node * 2 + 1])),
                    Math.max(...nodes.map(node => groundTopology!.samplePositions[node * 2])), Math.max(...nodes.map(node => groundTopology!.samplePositions[node * 2 + 1]))]);
                canonicalCoverage.set(key, covered);
            }
            samples = {valid: covered && endpoints.every(endpoint => endpoint.valid), channels: Array.from({length: 6}, (_value, channel) =>
                endpoints.reduce((sum, endpoint, corner) => sum + endpoint.channels[channel] * weights[corner], 0))};
        }
        else samples = sampleTerrainChannels(fields, sampleCoordinate, previousCoordinate, cell);
        valid[index] = Number(samples.valid);
        for (const [channel, attribute] of [[0, 'a_terrain'], [3, 'a_terrain_previous']] as const) {
            const offset = index * outputLayout.stride + outputLayout.offset[attribute];
            // Ribbon triangles already passed validity admission. Their unused
            // fourth channels carry the exact nominal corner (current X/previous Y),
            // avoiding another attribute slot on devices limited to 16 attributes.
            [...samples.channels.slice(channel, channel + 3), extrusionOffset === undefined ? Number(samples.valid) : nominalOffset[attribute === 'a_terrain' ? 0 : 1]].forEach((value, component) => {
                if (!Number.isFinite(Math.fround(value))) throw new Error('Terrain draping sample exceeds packed range');
                view.setFloat32(offset + component * 4, value, true);
            });
        }
    }
    const indices: number[] = [];
    const coverage = (positions: readonly (readonly [number, number])[]) => fields.current.coversBounds([
        Math.min(...positions.map(position => position[0])), Math.min(...positions.map(position => position[1])),
        Math.max(...positions.map(position => position[0])), Math.max(...positions.map(position => position[1]))]);
    for (let index = 0; index < refined.indices.length; index += 3) {
        const triangle = [refined.indices[index], refined.indices[index + 1], refined.indices[index + 2]];
        if (triangle.every(vertex => valid[vertex]) && (options.annotations || coverage(extrusionOffset === undefined ? triangle.map(vertex => coordinates[vertex]) : triangle.flatMap(vertex => ribbonBounds[vertex])))) indices.push(...triangle);
    }
    const elements = count > 65535 ? Uint32Array.from(indices) : Uint16Array.from(indices);
    const byteLength = vertices.byteLength + elements.byteLength;
    if (groundTopology) {
        let maximum = 0;
        for (let index = 0; index < elements.length; index += 3) for (let edge = 0; edge < 3; edge++) {
            const first = elements[index + edge], second = elements[index + (edge + 1) % 3];
            if (styledTopology) {
                const start = readPosition(new DataView(refined.vertices.buffer, first * baseLayout.stride, baseLayout.stride));
                const end = readPosition(new DataView(refined.vertices.buffer, second * baseLayout.stride, baseLayout.stride));
                maximum = Math.max(maximum, Math.hypot(start[0] - end[0], start[1] - end[1]) * metersPerUnit);
            }
            else maximum = Math.max(maximum, Math.hypot(groundTopology.positions[first * 2] - groundTopology.positions[second * 2], groundTopology.positions[first * 2 + 1] - groundTopology.positions[second * 2 + 1]));
        }
        statistics.edgeTarget = maximum; statistics.detailLimited = maximum > requestedCell;
    }
    Object.assign(statistics, {vertices: count, triangles: elements.length / 3, suppressedTriangles: (refined.indices.length - elements.length) / 3, meshBytes: byteLength, preparationMs: performance.now() - started});
    return {vertices, indices: elements, byteLength, statistics, ...(groundTopology && !styledTopology ? {groundClip: true, groundPositions: groundTopology.positions} : {})};
}

/** Preserve world-tile buffers without broadening the public one-world topology contract.
 * Split only at world/DEM boundaries; complete cells and shared lattice nodes remain unchanged.
 * The existing periodic sampler owns three worlds, so larger envelopes reject explicitly.
 */
function createStyledGroundTopology(grids: readonly TerrainHeightGrid[], bounds: readonly [number, number, number, number], resolution: number, maxVertices: number): TerrainGroundTopology {
    const circumference = 2 * Math.PI * PROJECTION_CONSTANTS.mercatorRadius;
    if (bounds[2] - bounds[0] <= circumference) return createTerrainGroundTopology(grids, bounds, resolution, maxVertices);
    const firstWorld = Math.floor(bounds[0] / circumference + 0.5), lastWorld = Math.ceil(bounds[2] / circumference + 0.5) - 1;
    if (!Number.isSafeInteger(firstWorld) || !Number.isSafeInteger(lastWorld) || lastWorld - firstWorld > 2) throw new Error('Canonical styled terrain exceeds the three-world sampling envelope');
    const sampleOffset = Math.floor((bounds[0] + bounds[2]) / (2 * circumference) + 0.5) * circumference;
    const positions: number[] = [], normalized: number[] = [], samples: number[] = [], indices: number[] = [], nodes = new Map<string, number>();
    for (let world = firstWorld; world <= lastWorld; world++) {
        const part = createTerrainGroundTopology(grids, [Math.max(bounds[0], (world - 0.5) * circumference), bounds[1],
            Math.min(bounds[2], (world + 0.5) * circumference), bounds[3]], resolution, maxVertices);
        const remapping = new Uint32Array(part.positions.length / 2);
        for (let vertex = 0; vertex < remapping.length; vertex++) {
            const x = part.normalizedPositions[vertex * 2], y = part.normalizedPositions[vertex * 2 + 1], key = `${x},${y}`;
            let index = nodes.get(key);
            if (index === undefined) {
                if (nodes.size >= maxVertices) throw new Error('Canonical styled terrain vertex budget exceeded');
                const sampleX = part.samplePositions[vertex * 2] + (Math.round(part.sampleOffset / circumference) - Math.round(sampleOffset / circumference)) * circumference;
                if (Math.abs(sampleX) > 1.5 * circumference) throw new Error('Canonical styled terrain exceeds the three-world sampling envelope');
                index = nodes.size; nodes.set(key, index);
                positions.push(part.positions[vertex * 2], part.positions[vertex * 2 + 1]);
                normalized.push(x, y); samples.push(sampleX, part.samplePositions[vertex * 2 + 1]);
            }
            remapping[vertex] = index;
        }
        for (const vertex of part.indices) indices.push(remapping[vertex]);
    }
    return {positions: Float64Array.from(positions), normalizedPositions: Float64Array.from(normalized), samplePositions: Float64Array.from(samples), indices: Uint32Array.from(indices), sampleOffset};
}

/** Apply the same explicit source/cell precision envelope to primary and repeated-world owners. */
function validateCanonicalSourceLOD(terrain: TerrainDrapingSnapshot, tileZoom: number, bounds: readonly number[], sampleOffset: number): void {
    for (const grid of wrapTerrainGroundGrids(terrain.grids)) {
        if (grid.bounds[2] <= bounds[0] - sampleOffset || grid.bounds[0] >= bounds[2] - sampleOffset || grid.bounds[3] <= bounds[1] || grid.bounds[1] >= bounds[3]) continue;
        const cellZoom = Math.round(Math.log2(2 * Math.PI * PROJECTION_CONSTANTS.mercatorRadius / (grid.bounds[2] - grid.bounds[0]))) + Math.log2(terrain.groundMeshResolution);
        const gap = tileZoom - cellZoom;
        if (gap > 10 || gap < -18) throw new Error('Canonical terrain ground source/DEM LOD gap exceeds Float32 precision limits');
    }
}

/** Sample one current/previous physical endpoint and its existing finite-difference normal channels. */
function sampleTerrainChannels(fields: {current: TerrainHeightField; previous: TerrainHeightField}, coordinate: readonly [number, number],
    previousCoordinate: readonly [number, number], cell: number): {valid: boolean; channels: number[]} {
    const current = fields.current.sampleHeight(coordinate), previousSample = fields.previous.sampleHeight(previousCoordinate);
    const channels: number[] = [], latitudeCosine = 1 / Math.cosh(coordinate[1] / PROJECTION_CONSTANTS.mercatorRadius);
    for (const [field, height, position] of [[fields.current, current, coordinate],
        [previousSample === null ? fields.current : fields.previous, previousSample ?? current, previousSample === null ? coordinate : previousCoordinate]] as const) {
        const slopes = [0, 1].map(axis => {
            const negative: [number, number] = [...position], positive: [number, number] = [...position];
            negative[axis] -= cell; positive[axis] += cell;
            const before = field.sampleHeight(negative), after = field.sampleHeight(positive);
            return height === null ? 0 : before !== null && after !== null ? (after - before) / (2 * cell * latitudeCosine) : after !== null ? (after - height) / (cell * latitudeCosine) : before !== null ? (height - before) / (cell * latitudeCosine) : 0;
        });
        channels.push(height ?? 0, ...slopes);
    }
    return {valid: current !== null, channels};
}

/** Copy constant raster style channels; UVs and ownership use the original source tile coordinate system. */
function createCanonicalGroundVertices(topology: TerrainGroundTopology, template: Uint8Array, layout: VertexLayout,
    origin: readonly [number, number], tileZoom: number): Uint8Array {
    const vertices = new Uint8Array(topology.positions.length / 2 * layout.stride), view = new DataView(vertices.buffer);
    const circumference = 2 * Math.PI * PROJECTION_CONSTANTS.mercatorRadius, tiles = 2 ** tileZoom;
    const column = Math.round((origin[0] / circumference + 0.5) * tiles), row = Math.round((0.5 - origin[1] / circumference) * tiles);
    for (let index = 0; index < topology.positions.length / 2; index++) {
        vertices.set(template.subarray(0, layout.stride), index * layout.stride);
        const offset = index * layout.stride + layout.offset.a_position;
        const x = (topology.normalizedPositions[index * 2] * tiles - column) * 4096;
        const y = (row - topology.normalizedPositions[index * 2 + 1] * tiles) * 4096;
        if (Math.fround(x) !== x || Math.fround(y) !== y) throw new Error('Canonical terrain ground positions exceed Float32 precision limits');
        view.setFloat32(offset, x, true);
        view.setFloat32(offset + 4, y, true);
    }
    return vertices;
}
