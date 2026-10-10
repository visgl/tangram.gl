// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {getProjectedSourceDomain} from './projected-mesh-domain';
import {PACKED_HEIGHT_SCALE} from '../gl/vertex-constants';
import {PROJECTED_COMMON_SCALE} from '../procedures/projected-coordinate-transform';
import type {MeshProjectionRequest, ProjectedMesh} from '../procedures/mesh-projector';

/** Project billboard anchors without subdividing, reordering or clipping atlas quads or label byte ranges. */
export function* projectSymbolMesh(request: MeshProjectionRequest): Generator<Float64Array, ProjectedMesh, Float64Array> {
    const {layout, tile} = request;
    const position = layout.dynamic_attribs.find(attribute => attribute.name === 'a_position');
    const projected = layout.dynamic_attribs.find(attribute => attribute.name === 'a_projected_position');
    const shape = layout.dynamic_attribs.find(attribute => attribute.name === 'a_shape');
    if (!Number.isSafeInteger(layout.stride) || layout.stride <= 0 || request.vertices.byteLength % layout.stride ||
        !position || position.type !== 5122 || position.size !== 4 || position.offset === undefined ||
        position.offset < 0 || position.offset + 8 > layout.stride ||
        !shape || shape.type !== 5122 || shape.size !== 4 || shape.offset === undefined ||
        shape.offset < 0 || shape.offset + 8 > layout.stride ||
        !projected || projected.type !== 5126 || projected.size !== 3 || projected.offset === undefined ||
        projected.offset < 0 || projected.offset + 12 > layout.stride ||
        ![tile.min.x, tile.min.y].every(Number.isFinite) || !Number.isSafeInteger(tile.coords.z) ||
        tile.coords.z < 0 || tile.coords.z > 22) throw new Error('Projected symbols require a packed billboard layout and finite tile metadata');
    const projectedOffset = projected.offset;
    const positionOffset = position.offset;
    const count = request.vertices.byteLength / layout.stride;
    const indices = request.indices === false ? new Uint32Array(Array.from({length: count}, (_, index) => index)) : request.indices.slice();
    if (indices.length % 3 || indices.some(index => index >= count)) throw new Error('Projected symbols require valid triangle indices');
    const vertices = request.vertices.slice();
    const view = new DataView(vertices.buffer, vertices.byteOffset, vertices.byteLength);
    const unitsPerMeter = 4096 * 2 ** tile.coords.z / (2 * Math.PI * 6378137);
    const domain = getProjectedSourceDomain(request.projection.type);
    const coordinates: number[] = [];
    const anchors = new Map<string, number>();
    const anchorIndices: number[] = [];
    for (let index = 0; index < count; index++) {
        const offset = index * layout.stride;
        if (view.getInt16(offset + position.offset + 4, true) !== 0 && !request.projection.allowElevation) {
            throw new Error('Projected symbols require ground anchors unless allowElevation is enabled');
        }
        const x = tile.min.x + view.getInt16(offset + position.offset, true) / unitsPerMeter;
        const y = tile.min.y + view.getInt16(offset + position.offset + 2, true) / unitsPerMeter;
        if (x < domain[0] || x > domain[2] || y < domain[1] || y > domain[3]) {
            view.setInt16(offset + shape.offset + 6, 0, true);
            for (let component = 0; component < 3; component++) view.setFloat32(offset + projected.offset + component * 4, 0, true);
            anchorIndices.push(-1);
            continue;
        }
        const key = `${x},${y}`;
        let anchor = anchors.get(key);
        if (anchor === undefined) {
            anchor = coordinates.length / 2;
            anchors.set(key, anchor);
            coordinates.push(x / 6378137 * 180 / Math.PI,
                (2 * Math.atan(Math.exp(y / 6378137)) - Math.PI / 2) * 180 / Math.PI);
        }
        anchorIndices.push(anchor);
    }
    const positions = coordinates.length ? yield new Float64Array(coordinates) : new Float64Array();
    if (!(positions instanceof Float64Array) || positions.length !== coordinates.length ||
        !positions.every(value => Number.isFinite(value) && Math.abs(value) <= 3.4028234663852886e38)) {
        throw new Error('Projection engine returned an invalid symbol-position batch');
    }
    anchorIndices.forEach((anchor, index) => {
        if (anchor < 0) return;
        const offset = index * layout.stride + projectedOffset;
        view.setFloat32(offset, positions[anchor * 2], true);
        view.setFloat32(offset + 4, positions[anchor * 2 + 1], true);
        const height = view.getInt16(index * layout.stride + positionOffset + 4, true) / PACKED_HEIGHT_SCALE;
        view.setFloat32(offset + 8, height * PROJECTED_COMMON_SCALE, true);
    });
    return {vertices, indices};
}
