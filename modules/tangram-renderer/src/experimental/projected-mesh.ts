// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {ProjectionEngine} from '@math.gl/projection/core';
import {equalEarth} from '@math.gl/projection/projections/eqearth';
import {albersEqualArea} from '@math.gl/projection/projections/aea';
import {equidistantCylindrical} from '@math.gl/projection/projections/eqc';
import {refineGlobeMesh} from '../gl/globe_mesh';
import {normalizeProjectedBasemapOptions} from '../procedures/mesh-projector';
import type {MeshProjectionRequest, MeshProjector, ProjectedBasemapOptions} from '../procedures/mesh-projector';

const SPHERE_RADIUS = 6378137;
const COMMON_SCALE = 256 / SPHERE_RADIUS;
const transforms = new Map<ProjectedBasemapOptions['type'], ProjectionEngine>();

/** Project ground degrees to north-positive common coordinates (256 units per sphere radius). */
export function projectBasemapPosition(position: readonly [number, number], type: ProjectedBasemapOptions['type']): [number, number, number] {
    if (!position.every(Number.isFinite) || Math.abs(position[0]) > 180 || Math.abs(position[1]) > 85.0511287798066) {
        throw new Error('Projected basemap position is outside the finite tile domain');
    }
    normalizeProjectedBasemapOptions({type});
    let transform = transforms.get(type);
    if (!transform) {
        const parameters = type === 'equal-earth' ? '+proj=eqearth +lon_0=0' :
            type === 'albers' ? '+proj=aea +lon_0=-96 +lat_0=37.5 +lat_1=29.5 +lat_2=45.5' :
                '+proj=eqc +lon_0=0 +lat_0=0 +lat_ts=0';
        transform = new ProjectionEngine({projections: [equalEarth, albersEqualArea, equidistantCylindrical], from: `+proj=longlat +R=${SPHERE_RADIUS}`,
            to: `${parameters} +R=${SPHERE_RADIUS} +units=m`});
        transforms.set(type, transform);
    }
    const projected = transform.projectSync([position[0], position[1]]);
    if (!projected.every(Number.isFinite)) throw new Error('Projected basemap produced a nonfinite position');
    return [projected[0] * COMMON_SCALE, projected[1] * COMMON_SCALE, 0];
}

/** Refine in packed tile space, then write separate projected positions, preserving UVs and feature IDs. */
export const projectBasemapMesh: MeshProjector = (request: MeshProjectionRequest) => {
    const projection = normalizeProjectedBasemapOptions(request.projection);
    const {tile, layout} = request;
    const unitsPerMeter = 4096 * 2 ** tile.coords.z / (2 * Math.PI * SPHERE_RADIUS);
    const position = layout.dynamic_attribs.find(attribute => attribute.name === 'a_position');
    const projected = layout.dynamic_attribs.find(attribute => attribute.name === 'a_projected_position');
    if (!position || position.type !== 5122 || position.size !== 4 || position.offset === undefined ||
        !projected || projected.type !== 5126 || projected.size !== 3 || projected.offset === undefined ||
        !Number.isSafeInteger(layout.stride) || layout.stride <= 0 ||
        request.vertices.byteLength % layout.stride !== 0 ||
        position.offset < 0 || position.offset + 8 > layout.stride ||
        projected.offset < 0 || projected.offset + 12 > layout.stride ||
        ![tile.min.x, tile.min.y, unitsPerMeter].every(Number.isFinite) || unitsPerMeter <= 0) {
        throw new Error('CPU projection requires a flat polygon layout and finite tile metadata');
    }
    const source = new DataView(request.vertices.buffer, request.vertices.byteOffset, request.vertices.byteLength);
    for (let offset = 0; offset < source.byteLength; offset += layout.stride) {
        if (source.getInt16(offset + position.offset + 4, true) !== 0) throw new Error('CPU projection does not support elevation or extrusion');
    }
    const result = refineGlobeMesh(request.vertices, request.indices, layout, {
        tileZoom: tile.coords.z, maxAngularSpan: projection.maxAngularSpan,
        maxAdditionalVertices: projection.maxAdditionalVertices
    });
    const output = new DataView(result.vertices.buffer, result.vertices.byteOffset, result.vertices.byteLength);
    const projectedOffset = projected.offset;
    for (let offset = 0; offset < output.byteLength; offset += layout.stride) {
        const x = tile.min.x + output.getInt16(offset + position.offset, true) / unitsPerMeter;
        const y = tile.min.y + output.getInt16(offset + position.offset + 2, true) / unitsPerMeter;
        // Clamp world-border padding instead of wrapping seam vertices to the opposite side.
        const longitude = Math.max(-180, Math.min(180, x / SPHERE_RADIUS * 180 / Math.PI));
        const latitude = Math.max(-85.0511287798066, Math.min(85.0511287798066,
            (2 * Math.atan(Math.exp(y / SPHERE_RADIUS)) - Math.PI / 2) * 180 / Math.PI));
        const point = projectBasemapPosition([longitude, latitude], projection.type);
        point.forEach((value, index) => output.setFloat32(offset + projectedOffset + index * 4, value, true));
    }
    return result;
};
