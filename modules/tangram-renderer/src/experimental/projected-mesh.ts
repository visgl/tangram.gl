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
import type {MeshProjectionRequest, ProjectedMesh, ProjectedBasemapOptions} from '../procedures/mesh-projector';

const SPHERE_RADIUS = 6378137;
const transforms = new Map<ProjectedBasemapOptions['type'], ProjectionTransform>();

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
    return prepareProjectedMesh(request, position => projectBasemapPosition(position, request.projection.type));
}

/** Batch all refined vertices through the injected host engine, never one RPC per vertex. */
export async function projectBasemapMeshWithEngine(request: MeshProjectionRequest): Promise<ProjectedMesh> {
    if (!request.projectPositions) throw new Error('Injected projection requires a host batch callback');
    const coordinates: number[] = [];
    const result = prepareProjectedMesh(request, position => {
        coordinates.push(position[0], position[1]);
        return [0, 0, 0];
    });
    const projected = await request.projectPositions(new Float64Array(coordinates));
    if (!(projected instanceof Float64Array) || projected.length !== coordinates.length ||
        !projected.every(value => Number.isFinite(value) && Math.abs(value) <= 3.4028234663852886e38)) {
        throw new Error('Projection engine returned an invalid common-position batch');
    }
    const projectedAttribute = request.layout.dynamic_attribs.find(attribute => attribute.name === 'a_projected_position');
    if (projectedAttribute?.offset === undefined) throw new Error('Missing projected position layout');
    const output = new DataView(result.vertices.buffer, result.vertices.byteOffset, result.vertices.byteLength);
    for (let vertex = 0; vertex < projected.length / 2; vertex++) {
        const offset = vertex * request.layout.stride + projectedAttribute.offset;
        output.setFloat32(offset, projected[vertex * 2], true);
        output.setFloat32(offset + 4, projected[vertex * 2 + 1], true);
        output.setFloat32(offset + 8, 0, true);
    }
    return result;
}

/** Share refinement and tile conventions between worker-local and host-injected transforms. */
function prepareProjectedMesh(request: MeshProjectionRequest,
    projectPosition: (position: readonly [number, number]) => readonly [number, number, number]): ProjectedMesh {
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
    const source = new DataView(request.vertices.buffer, request.vertices.byteOffset, request.vertices.byteLength);
    for (let offset = 0; offset < source.byteLength; offset += layout.stride) {
        if (source.getInt16(offset + position.offset + 4, true) !== 0) throw new Error('CPU projection does not support elevation or extrusion');
        if (optionalLineOffsets.some(attributeOffset =>
            source.getInt16(offset + attributeOffset, true) !== 0 || source.getInt16(offset + attributeOffset + 2, true) !== 0)) {
            throw new Error('CPU projected lines require fixed-width ground ribbons without offset');
        }
    }
    // A ribbon's real corners are centerline + packed extrusion. Refine those
    // edges (including width and round joins), not only the collapsed centerline.
    const positionOffset = position.offset;
    const extrusionOffset = extrusion?.offset ?? 0;
    const readPosition = (vertex: DataView): [number, number] => [
        vertex.getInt16(positionOffset, true) + (line ? vertex.getInt16(extrusionOffset, true) / overzoom : 0),
        vertex.getInt16(positionOffset + 2, true) + (line ? vertex.getInt16(extrusionOffset + 2, true) / overzoom : 0)
    ];
    const result = refineGlobeMesh(request.vertices, request.indices, layout, {
        tileZoom: tile.coords.z, maxAngularSpan: projection.maxAngularSpan,
        maxAdditionalVertices: projection.maxAdditionalVertices,
        ...(line ? {getPosition: readPosition} : {})
    });
    const output = new DataView(result.vertices.buffer, result.vertices.byteOffset, result.vertices.byteLength);
    const projectedOffset = projected.offset;
    for (let offset = 0; offset < output.byteLength; offset += layout.stride) {
        const [localX, localY] = readPosition(new DataView(output.buffer, output.byteOffset + offset, layout.stride));
        const x = tile.min.x + localX / unitsPerMeter;
        const y = tile.min.y + localY / unitsPerMeter;
        // Clamp world-border padding instead of wrapping seam vertices to the opposite side.
        const longitude = Math.max(-180, Math.min(180, x / SPHERE_RADIUS * 180 / Math.PI));
        const latitude = Math.max(-85.0511287798066, Math.min(85.0511287798066,
            (2 * Math.atan(Math.exp(y / SPHERE_RADIUS)) - Math.PI / 2) * 180 / Math.PI));
        const point = projectPosition([longitude, latitude]);
        point.forEach((value, index) => output.setFloat32(offset + projectedOffset + index * 4, value, true));
    }
    return result;
}
