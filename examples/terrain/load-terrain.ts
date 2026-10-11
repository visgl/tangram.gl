// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import type {Mesh} from '@loaders.gl/schema';
import {TerrainMeshSurface, projectGeographicPosition} from '@vis.gl/tangram-renderer/core';
import {decodeTerrainTile, type TerrainTileData, type TerrainNoDataPolicy} from './decode-terrain';

/** Drawn top triangles and their physical query geometry; queries never contain skirts. */
export interface LoadedTerrain extends TerrainTileData {
    /** Exact top triangles in EPSG:3857 meters. */
    surface: TerrainMeshSurface;
}

/** Compute longitude/latitude bounds for a finite XYZ elevation tile. */
export function getTerrainTileBounds(zoom: number, column: number, row: number): [number, number, number, number] {
    const count = 2 ** zoom;
    if (!Number.isSafeInteger(zoom) || zoom < 0 || zoom > 22 || !Number.isInteger(column) || !Number.isInteger(row) || column < 0 || row < 0 || column >= count || row >= count) throw new Error('Invalid terrain XYZ tile');
    const latitude = (tileRow: number) => Math.atan(Math.sinh(Math.PI * (1 - 2 * tileRow / count))) * 180 / Math.PI;
    return [column / count * 360 - 180, latitude(row + 1), (column + 1) / count * 360 - 180, latitude(row)];
}

/** Build a query surface from the exact triangles, not a separate bilinear grid. */
export function createTerrainQuerySurface(mesh: Mesh): TerrainMeshSurface {
    const source = mesh.attributes.POSITION;
    if (!source || source.size !== 3 || !mesh.indices || mesh.indices.size !== 1 || mesh.topology !== 'triangle-list') throw new Error('Terrain requires indexed XYZ triangles');
    const positions = new Float64Array(source.value.length);
    for (let index = 0; index < positions.length; index += 3) positions.set(projectGeographicPosition([source.value[index], source.value[index + 1], source.value[index + 2]], 'web-mercator'), index);
    return new TerrainMeshSurface({projection: 'web-mercator', positions, indices: mesh.indices.value});
}

/** Main-thread conformance entry; interactive streaming uses this decoder in local workers. */
export async function parseTerrainTile(bytes: ArrayBuffer, bounds: readonly [number, number, number, number], meshMaxError = 20, noData: TerrainNoDataPolicy = 'opaque'): Promise<LoadedTerrain> {
    const data = await decodeTerrainTile(bytes, bounds, meshMaxError, noData);
    return {...data, surface: createTerrainQuerySurface(data.mesh)};
}
