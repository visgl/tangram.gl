// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import type {Mesh} from '@loaders.gl/schema';
import {TerrainMeshSurface, projectGeographicPosition} from '@tangram.gl/tangram-renderer/core';
import {decodeTerrainTile} from './decode-terrain';
import type {TerrainTileData, TerrainNoDataPolicy} from './terrain-payload';

/** Drawn top triangles and their physical query geometry; queries never contain skirts. */
export interface LoadedTerrain extends TerrainTileData {
    /** Exact top triangles in EPSG:3857 meters. */
    surface: TerrainMeshSurface;
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
