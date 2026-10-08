// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {ProjectionTransform} from '@math.gl/projection/core';
import {equalEarth} from '@math.gl/projection/projections/eqearth';
import {albersEqualArea} from '@math.gl/projection/projections/aea';
import {equidistantCylindrical} from '@math.gl/projection/projections/eqc';
import {mercator} from '@math.gl/projection/projections/merc';
import {refineGlobeMesh} from '../gl/globe_mesh';
import {normalizeProjectedBasemapOptions} from '../procedures/mesh-projector';
import {getProjectedCoordinateOptions, PROJECTED_COMMON_SCALE} from '../procedures/projected-coordinate-transform';
import type {MeshProjectionRequest, ProjectedMesh, ProjectedBasemapOptions, MeshProjectionStatistics} from '../procedures/mesh-projector';
import {ProjectedMeshPreparationCache} from './projected-mesh-cache';
import {clipProjectedMesh, getProjectedSourceDomain} from './projected-mesh-domain';
import {refineProjectedMesh} from './projected-mesh-refinement';
import type {ProjectedRefinementWork} from './projected-mesh-refinement';

const SPHERE_RADIUS = 6378137;
const transforms = new Map<ProjectedBasemapOptions['type'], ProjectionTransform>();
const preparationCache = new ProjectedMeshPreparationCache();
let projectionStatistics = createProjectionStatistics();

/** Start a new worker-lifecycle snapshot; pending requests retain their old accounting epoch. */
function createProjectionStatistics(): MeshProjectionStatistics {
    return {completedMeshes: 0, failedMeshes: 0, sourceVertices: 0, outputVertices: 0,
        outputTriangles: 0, projectionBatches: 0, projectedPositions: 0, edgeRounds: 0, interiorRounds: 0};
}

/** Release optional worker-owned preparation and compiled local transforms on worker reset. */
export function clearProjectedMeshPreparation(): void {
    preparationCache.clear();
    transforms.clear();
    projectionStatistics = createProjectionStatistics();
}

/** Detached cumulative projection/refinement work, never mutable mesh or cache records. */
export function getProjectedMeshWorkStatistics(): MeshProjectionStatistics {
    return {...projectionStatistics};
}

/** Internal worker diagnostics for verifying warm source topology independently of target projection. */
export function getProjectedMeshPreparationStatistics(): ReturnType<ProjectedMeshPreparationCache['getStatistics']> {
    return preparationCache.getStatistics();
}

/** Project ground degrees to north-positive common coordinates (256 units per sphere radius). */
export function projectBasemapPosition(position: readonly [number, number], type: ProjectedBasemapOptions['type']): [number, number, number] {
    if (!position.every(Number.isFinite) || Math.abs(position[0]) > 180 || Math.abs(position[1]) > 85.0511287798066) {
        throw new Error('Projected basemap position is outside the finite tile domain');
    }
    normalizeProjectedBasemapOptions({type});
    let transform = transforms.get(type);
    if (!transform) {
        // EPSG:3395 uses the WGS84 ellipsoid; EPSG:3857 uses the same major radius as a sphere.
        // Use matching geographic CRS geometry so this is projection, not a datum conversion.
        transform = new ProjectionTransform({projections: [equalEarth, albersEqualArea, equidistantCylindrical, mercator],
            ...getProjectedCoordinateOptions(type)});
        transforms.set(type, transform);
    }
    const projected = transform.projectSync([position[0], position[1]]);
    if (!projected.every(Number.isFinite)) throw new Error('Projected basemap produced a nonfinite position');
    return [projected[0] * PROJECTED_COMMON_SCALE, projected[1] * PROJECTED_COMMON_SCALE, 0];
}

/** Refine in packed tile space, then write separate projected positions, preserving UVs and feature IDs. */
export function projectBasemapMesh(request: MeshProjectionRequest): ProjectedMesh {
    const work = {edgeRounds: 0, interiorRounds: 0};
    const statistics = projectionStatistics;
    try {
        const refinement = prepareProjectedMesh(request, work);
        let step = refinement.next();
        while (!step.done) {
            countProjectionBatch(step.value, statistics);
            const positions = step.value.slice();
            for (let index = 0; index < positions.length; index += 2) {
                const point = projectBasemapPosition([positions[index], positions[index + 1]], request.projection.type);
                positions[index] = point[0]; positions[index + 1] = point[1];
            }
            step = refinement.next(positions);
        }
        recordCompletedProjection(request, step.value, work, statistics);
        return step.value;
    } catch (error) {
        statistics.failedMeshes++;
        throw error;
    }
}

/** Batch all refined vertices through the injected host engine, never one RPC per vertex. */
export async function projectBasemapMeshWithEngine(request: MeshProjectionRequest): Promise<ProjectedMesh> {
    const work = {edgeRounds: 0, interiorRounds: 0};
    const statistics = projectionStatistics;
    try {
        if (!request.projectPositions) throw new Error('Injected projection requires a host batch callback');
        const refinement = prepareProjectedMesh(request, work);
        let step = refinement.next();
        while (!step.done) {
            countProjectionBatch(step.value, statistics);
            step = refinement.next(await request.projectPositions(step.value));
        }
        recordCompletedProjection(request, step.value, work, statistics);
        return step.value;
    } catch (error) {
        statistics.failedMeshes++;
        throw error;
    }
}

/** Account submitted work even if its engine rejects the request. */
function countProjectionBatch(coordinates: Float64Array, statistics: MeshProjectionStatistics): void {
    statistics.projectionBatches++;
    statistics.projectedPositions += coordinates.length / 2;
}

/** Count returned meshes only, not partially refined or failed output. */
function recordCompletedProjection(request: MeshProjectionRequest, result: ProjectedMesh, work: ProjectedRefinementWork,
    statistics: MeshProjectionStatistics): void {
    statistics.completedMeshes++;
    statistics.sourceVertices += request.vertices.byteLength / request.layout.stride;
    statistics.outputVertices += result.vertices.byteLength / request.layout.stride;
    statistics.outputTriangles += result.indices.length / 3;
    statistics.edgeRounds += work.edgeRounds;
    statistics.interiorRounds += work.interiorRounds;
}

/** Share refinement and tile conventions between worker-local and host-injected transforms. */
function* prepareProjectedMesh(request: MeshProjectionRequest, work: ProjectedRefinementWork): Generator<Float64Array, ProjectedMesh, Float64Array> {
    const projection = normalizeProjectedBasemapOptions(request.projection);
    const {tile, layout} = request;
    const unitsPerMeter = 4096 * 2 ** tile.coords.z / (2 * Math.PI * SPHERE_RADIUS);
    const position = layout.dynamic_attribs.find(attribute => attribute.name === 'a_position');
    const projected = layout.dynamic_attribs.find(attribute => attribute.name === 'a_projected_position');
    const extrusion = layout.dynamic_attribs.find(attribute => attribute.name === 'a_extrude');
    const line = request.geometry === 'lines';
    const overzoom = tile.overzoom2 ?? 1;
    if (!position || position.type !== 5122 || position.size !== 4 || position.offset === undefined ||
        !projected || projected.type !== 5126 || projected.size !== 3 || projected.offset === undefined ||
        !Number.isSafeInteger(layout.stride) || layout.stride <= 0 ||
        request.vertices.byteLength % layout.stride !== 0 ||
        position.offset < 0 || position.offset + 8 > layout.stride ||
        projected.offset < 0 || projected.offset + 12 > layout.stride ||
        ![tile.min.x, tile.min.y, unitsPerMeter].every(Number.isFinite) || unitsPerMeter <= 0) {
        throw new Error('CPU projection requires a packed ground layout and finite tile metadata');
    }
    if (line && (!extrusion || extrusion.type !== 5122 || extrusion.size !== 2 ||
        extrusion.offset === undefined || extrusion.offset < 0 || extrusion.offset + 4 > layout.stride ||
        !Number.isFinite(overzoom) || overzoom < 1)) {
        throw new Error('CPU projected lines require packed extrusion and finite overzoom');
    }
    const optionalLineOffsets = line ? layout.dynamic_attribs.filter(attribute =>
        ['a_offset', 'a_z_and_offset_scale'].includes(attribute.name)).map(attribute => {
        if (attribute.type !== 5122 || attribute.size !== 2 || attribute.offset === undefined ||
            attribute.offset < 0 || attribute.offset + 4 > layout.stride) {
            throw new Error('CPU projected lines require packed ground attributes');
        }
        return attribute.offset;
    }) : [];
    for (const [name, size] of [['a_projected_stroke', 4], ['a_projected_normals', 4], ['a_projected_widths', 2]] as const) {
        const attribute = layout.dynamic_attribs.find(attribute => attribute.name === name);
        if (attribute && (attribute.type !== 5126 || attribute.size !== size || attribute.offset === undefined ||
            attribute.offset < 0 || attribute.offset + size * 4 > layout.stride)) {
            throw new Error('CPU projected stroke attributes require a valid float layout');
        }
    }
    const source = new DataView(request.vertices.buffer, request.vertices.byteOffset, request.vertices.byteLength);
    for (let offset = 0; offset < source.byteLength; offset += layout.stride) {
        const heightOffset = line ? layout.dynamic_attribs.find(attribute => attribute.name === 'a_z_and_offset_scale')?.offset : position.offset + 4;
        if (heightOffset !== undefined && source.getInt16(offset + heightOffset, true) !== 0) throw new Error('CPU projection does not support elevation or extrusion');
    }
    // A ribbon's real corners are centerline + packed extrusion. Refine those
    // edges (including width and round joins), not only the collapsed centerline.
    const positionOffset = position.offset;
    const extrusionOffset = extrusion?.offset ?? 0;
    const offsetAttribute = layout.dynamic_attribs.find(attribute => attribute.name === 'a_offset');
    let delta = Math.max(0, Math.min(4, (tile.style_z ?? tile.coords.z) - tile.coords.z));
    delta += (delta >= 1 ? 1 - delta : 0) + 2 * Math.max(0, Math.min(1, (delta - 2) / 2));
    const widthFactor = (vertex: DataView): number => 1 - vertex.getInt16(positionOffset + 4, true) / 1024 * (delta - 0.5) * 2;
    const readPosition = (vertex: DataView): [number, number] => [
        vertex.getInt16(positionOffset, true) + (line ? (vertex.getInt16(extrusionOffset, true) * widthFactor(vertex) +
            (offsetAttribute?.offset === undefined ? 0 : vertex.getInt16(offsetAttribute.offset, true))) / overzoom : 0),
        vertex.getInt16(positionOffset + 2, true) + (line ? (vertex.getInt16(extrusionOffset + 2, true) * widthFactor(vertex) +
            (offsetAttribute?.offset === undefined ? 0 : vertex.getInt16(offsetAttribute.offset + 2, true))) / overzoom : 0)
    ];
    const metadata = JSON.stringify({geometry: request.geometry, tileZoom: tile.coords.z, min: tile.min, overzoom, styleZoom: tile.style_z,
        stride: layout.stride, attributes: layout.dynamic_attribs.map(attribute =>
            [attribute.name, attribute.type, attribute.size, attribute.offset, attribute.normalized]),
        maxAngularSpan: projection.maxAngularSpan, maxAdditionalVertices: projection.maxAdditionalVertices});
    const prepared = preparationCache.getOrCreate(metadata, request.vertices, request.indices, () =>
        refineGlobeMesh(request.vertices, request.indices, layout, {
            tileZoom: tile.coords.z, maxAngularSpan: projection.maxAngularSpan,
            maxAdditionalVertices: projection.maxAdditionalVertices,
            ...(line ? {getPosition: readPosition} : {})
        }));
    const clipped = clipProjectedMesh(prepared, request, readPosition, projection.maxAdditionalVertices! -
        (prepared.vertices.byteLength - request.vertices.byteLength) / layout.stride);
    // Never mutate or transfer cached/source buffers, even when refinement adds no vertices.
    const domain = getProjectedSourceDomain(projection.type);
    const geographicPosition = (vertex: DataView, center = false, displacement: readonly [number, number] = [0, 0]): [number, number] => {
        let [localX, localY] = center ? [vertex.getInt16(positionOffset, true), vertex.getInt16(positionOffset + 2, true)] : readPosition(vertex);
        localX += displacement[0]; localY += displacement[1];
        // Clipping handled whole triangles. Clamp only packed-coordinate rounding at cut intersections.
        const x = Math.max(domain[0], Math.min(domain[2], tile.min.x + localX / unitsPerMeter));
        const y = Math.max(domain[1], Math.min(domain[3], tile.min.y + localY / unitsPerMeter));
        const longitude = Math.max(-180, Math.min(180, x / SPHERE_RADIUS * 180 / Math.PI));
        const latitude = Math.max(-85.0511287798066, Math.min(85.0511287798066,
            (2 * Math.atan(Math.exp(y / SPHERE_RADIUS)) - Math.PI / 2) * 180 / Math.PI));
        return [longitude, latitude];
    };
    const refined = yield* refineProjectedMesh(clipped, request,
        (vertex, displacement) => geographicPosition(vertex, false, displacement), readPosition, work);
    const result = {vertices: refined.vertices.slice(), indices: refined.indices.slice()};
    const coordinates: number[] = [];
    for (let offset = 0; offset < result.vertices.byteLength; offset += layout.stride) {
        coordinates.push(...geographicPosition(new DataView(result.vertices.buffer, result.vertices.byteOffset + offset, layout.stride)));
    }
    const stroke = layout.dynamic_attribs.find(attribute => attribute.name === 'a_projected_stroke');
    const normals = layout.dynamic_attribs.find(attribute => attribute.name === 'a_projected_normals');
    const widths = layout.dynamic_attribs.find(attribute => attribute.name === 'a_projected_widths');
    const vertexCount = result.vertices.byteLength / layout.stride;
    if (line && stroke?.offset !== undefined) for (let offset = 0; offset < result.vertices.byteLength; offset += layout.stride) {
        coordinates.push(...geographicPosition(new DataView(result.vertices.buffer, result.vertices.byteOffset + offset, layout.stride), true));
    }
    // Project adjacent road tangents, not source normals. Their perpendiculars
    // define CSS widths even under anisotropic high-latitude projections.
    if (line && stroke?.offset !== undefined && normals?.offset !== undefined && widths?.offset !== undefined) {
        for (let offset = 0; offset < result.vertices.byteLength; offset += layout.stride) {
            const vertex = new DataView(result.vertices.buffer, result.vertices.byteOffset + offset, layout.stride);
            for (let normal = 0; normal < 2; normal++) {
                const normalX = vertex.getFloat32(normals.offset + normal * 8, true);
                const normalY = vertex.getFloat32(normals.offset + normal * 8 + 4, true);
                for (const direction of [-8, 8]) coordinates.push(...geographicPosition(vertex, true,
                    [normalY * direction, -normalX * direction]));
            }
        }
    }
    const positions = yield new Float64Array(coordinates);
    if (!(positions instanceof Float64Array) || positions.length !== coordinates.length ||
        !positions.every(value => Number.isFinite(value) && Math.abs(value) <= 3.4028234663852886e38)) {
        throw new Error('Projection engine returned an invalid common-position batch');
    }
    const output = new DataView(result.vertices.buffer, result.vertices.byteOffset, result.vertices.byteLength);
    for (let index = 0; index < vertexCount; index++) {
        const offset = index * layout.stride + projected.offset;
        output.setFloat32(offset, positions[index * 2], true);
        output.setFloat32(offset + 4, positions[index * 2 + 1], true);
        output.setFloat32(offset + 8, 0, true);
        if (line && stroke?.offset !== undefined) {
            const vertex = new DataView(result.vertices.buffer, result.vertices.byteOffset + index * layout.stride, layout.stride);
            const pixelScale = vertex.getFloat32(stroke.offset + 12, true);
            let radius = Math.hypot(readPosition(vertex)[0] - vertex.getInt16(positionOffset, true),
                readPosition(vertex)[1] - vertex.getInt16(positionOffset + 2, true)) * overzoom * pixelScale;
            if (pixelScale > 0 && normals?.offset !== undefined && widths?.offset !== undefined) {
                const normalsOffset = normals.offset;
                const sourceNormals = [0, 1].map(normal => [vertex.getFloat32(normalsOffset + normal * 8, true),
                    vertex.getFloat32(normalsOffset + normal * 8 + 4, true)]);
                const projectedNormals = [0, 1].map(normal => {
                    const sample = (2 * vertexCount + index * 4 + normal * 2) * 2;
                    const tangentX = positions[sample + 2] - positions[sample];
                    const tangentY = positions[sample + 3] - positions[sample + 1];
                    const length = Math.hypot(tangentX, tangentY);
                    return length === 0 ? [0, 0] : [-tangentY / length, tangentX / length];
                });
                const halfWidth = vertex.getFloat32(widths.offset, true);
                const offsetWidth = vertex.getFloat32(widths.offset + 4, true);
                const extrusion = [vertex.getInt16(extrusionOffset, true), vertex.getInt16(extrusionOffset + 2, true)];
                const shape = reorientProjectedStroke(extrusion, halfWidth, sourceNormals, projectedNormals);
                const offsetShape = reorientProjectedStroke([
                    (offsetAttribute?.offset === undefined ? 0 : vertex.getInt16(offsetAttribute.offset, true)),
                    (offsetAttribute?.offset === undefined ? 0 : vertex.getInt16(offsetAttribute.offset + 2, true))],
                Math.abs(offsetWidth), sourceNormals, projectedNormals);
                const displacement = shape.map((value, component) =>
                    (value * widthFactor(vertex) + offsetShape[component]) * pixelScale);
                const centerOffset = (vertexCount + index) * 2;
                output.setFloat32(offset, positions[centerOffset] + displacement[0], true);
                output.setFloat32(offset + 4, positions[centerOffset + 1] + displacement[1], true);
                radius = Math.hypot(...displacement);
            }
            output.setFloat32(index * layout.stride + stroke.offset, positions[(vertexCount + index) * 2], true);
            output.setFloat32(index * layout.stride + stroke.offset + 4, positions[(vertexCount + index) * 2 + 1], true);
            output.setFloat32(index * layout.stride + stroke.offset + 8, radius, true);
        }
    }
    return result;
}

/** Retain cap/fan shape and Tangram's miter convention around projected segment perpendiculars. */
function reorientProjectedStroke(vector: number[], halfWidth: number, sourceNormals: number[][],
    projectedNormals: number[][]): number[] {
    const length = Math.hypot(...vector);
    if (length === 0 || halfWidth === 0) return [0, 0];
    const normalize = (normal: number[]) => {
        const magnitude = Math.hypot(...normal);
        return magnitude === 0 ? [0, 0] : normal.map(value => value / magnitude);
    };
    const [first, second] = sourceNormals.map(normalize);
    const [projectedFirst, projectedSecond] = projectedNormals;
    const cross = (first: number[], second: number[]) => first[0] * second[1] - first[1] * second[0];
    const dot = (first: number[], second: number[]) => first[0] * second[0] + first[1] * second[1];
    const angle = Math.atan2(cross(first, second), dot(first, second));
    if (Math.abs(angle) < 0.0001) {
        // Restore authored radii at the packed edge, rather than carrying a
        // direction-dependent integer-rounding loss into CSS-pixel widths.
        const snap = (distance: number) => Math.abs(Math.abs(distance) - halfWidth) <= 1 ?
            Math.sign(distance) * halfWidth : Math.abs(distance) <= 1 ? 0 : distance;
        const normalDistance = snap(dot(vector, first));
        const tangentDistance = snap(vector[0] * first[1] - vector[1] * first[0]);
        return [projectedFirst[0] * normalDistance + projectedFirst[1] * tangentDistance,
            projectedFirst[1] * normalDistance - projectedFirst[0] * tangentDistance];
    }
    const side = Math.sign(dot(vector, [first[0] + second[0], first[1] + second[1]]));
    if (length > halfWidth * 1.01) {
        const bisector = normalize([projectedFirst[0] + projectedSecond[0], projectedFirst[1] + projectedSecond[1]]);
        const scale = 2 / (1 + Math.abs(dot(projectedFirst, bisector)));
        return bisector.map(value => value * scale ** 2 * halfWidth * side);
    }
    const direction = vector.map(value => value * side / length);
    const fraction = Math.max(0, Math.min(1, Math.atan2(cross(first, direction), dot(first, direction)) / angle));
    const projectedAngle = Math.atan2(cross(projectedFirst, projectedSecond), dot(projectedFirst, projectedSecond)) * fraction;
    const cosine = Math.cos(projectedAngle), sine = Math.sin(projectedAngle);
    return [(projectedFirst[0] * cosine - projectedFirst[1] * sine) * length * side,
        (projectedFirst[0] * sine + projectedFirst[1] * cosine) * length * side];
}
