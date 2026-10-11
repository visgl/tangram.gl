// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {parse} from '@loaders.gl/core';
import {ImageBitmapLoader, getImageData} from '@loaders.gl/images';
import {TerrainLoader, type TerrainLoaderOptions} from '@loaders.gl/terrain';
import type {Mesh} from '@loaders.gl/schema';
import {lngLatToWorld, worldToLngLat} from '@math.gl/web-mercator';
import {TERRARIUM_DECODER, decodeTerrainHeightGrid, type TerrainHeightGrid} from '@vis.gl/tangram-renderer/map-logic';
import {TerrainMeshSurface, projectGeographicPosition} from '@vis.gl/tangram-renderer/core';

/** A single tile's unexaggerated data and the exact triangulation used for drawing. */
export interface LoadedTerrain {
    /** loaders.gl mesh, with longitude/latitude XY and physical-meter Z. */
    mesh: Mesh;
    /** Physical elevation samples; independent of camera and mesh simplification. */
    grid: TerrainHeightGrid;
    /** Triangle query surface derived from the same mesh, in EPSG:3857 meters. */
    surface: TerrainMeshSurface;
}

/** Validate the untyped published loader result before it crosses the example boundary. */
function isTerrainMesh(value: unknown): value is Mesh {
    if (!value || typeof value !== 'object' || !('attributes' in value) || !value.attributes || typeof value.attributes !== 'object' ||
        !('POSITION' in value.attributes) || !('indices' in value) || !value.indices || typeof value.indices !== 'object' ||
        !('topology' in value) || value.topology !== 'triangle-list' || !('mode' in value) || typeof value.mode !== 'number' ||
        !('schema' in value) || !value.schema || typeof value.schema !== 'object') return false;
    const positions = value.attributes.POSITION;
    const indices = value.indices;
    return Boolean(positions && typeof positions === 'object' && 'size' in positions && positions.size === 3 &&
        'value' in positions && positions.value instanceof Float32Array && positions.value.length % 3 === 0 &&
        'size' in indices && indices.size === 1 && 'value' in indices &&
        (indices.value instanceof Uint32Array || indices.value instanceof Uint16Array) && indices.value.length % 3 === 0 &&
        'fields' in value.schema && Array.isArray(value.schema.fields) && 'metadata' in value.schema &&
        value.schema.metadata && typeof value.schema.metadata === 'object');
}

/** Compute longitude/latitude bounds for a finite XYZ elevation tile. */
export function getTerrainTileBounds(zoom: number, column: number, row: number): [number, number, number, number] {
    const count = 2 ** zoom;
    if (!Number.isSafeInteger(zoom) || zoom < 0 || zoom > 22 || !Number.isInteger(column) || !Number.isInteger(row) || column < 0 || row < 0 || column >= count || row >= count) throw new Error('Invalid terrain XYZ tile');
    const latitude = (tileRow: number) => Math.atan(Math.sinh(Math.PI * (1 - 2 * tileRow / count))) * 180 / Math.PI;
    return [column / count * 360 - 180, latitude(row + 1), (column + 1) / count * 360 - 180, latitude(row)];
}

/** Build a query surface from exactly the loaded triangles, not a separate bilinear grid. */
export function createTerrainQuerySurface(mesh: Mesh): TerrainMeshSurface {
    const source = mesh.attributes.POSITION;
    if (!source || source.size !== 3 || !mesh.indices || mesh.indices.size !== 1 || mesh.topology !== 'triangle-list') throw new Error('Terrain requires indexed XYZ triangles');
    const positions = new Float64Array(source.value.length);
    for (let index = 0; index < positions.length; index += 3) {
        positions.set(projectGeographicPosition([source.value[index], source.value[index + 1], source.value[index + 2]], 'web-mercator'), index);
    }
    return new TerrainMeshSurface({projection: 'web-mercator', positions, indices: mesh.indices.value});
}

/** Decode one RGB elevation image and mesh it through the published loaders.gl pipeline. */
export async function parseTerrainTile(bytes: ArrayBuffer, bounds: readonly [number, number, number, number], meshMaxError = 20): Promise<LoadedTerrain> {
    if (bounds.length !== 4 || !bounds.every(Number.isFinite) || bounds[0] >= bounds[2] || bounds[1] >= bounds[3] || bounds[0] < -180 || bounds[2] > 180 || bounds[1] < -85.0511287798066 || bounds[3] > 85.0511287798066) throw new Error('Terrain tile requires ordered Mercator-domain geographic bounds');
    if (!Number.isFinite(meshMaxError) || meshMaxError < 0) throw new Error('Terrain mesh error must be non-negative meters');
    const imageOptions = {imagebitmap: {colorSpaceConversion: 'none' as const, premultiplyAlpha: 'none' as const}};
    const bitmap = await parse(bytes, ImageBitmapLoader, imageOptions);
    let grid: TerrainHeightGrid;
    try {
        const image = getImageData(bitmap);
        const southwest = projectGeographicPosition([bounds[0], bounds[1], 0], 'web-mercator');
        const northeast = projectGeographicPosition([bounds[2], bounds[3], 0], 'web-mercator');
        grid = decodeTerrainHeightGrid({width: image.width, height: image.height, pixels: image.data,
            decoder: TERRARIUM_DECODER, bounds: [southwest[0], southwest[1], northeast[0], northeast[1]],
            registration: 'pixel-center', verticalDatum: 'unknown'});
    } finally {
        bitmap.close();
    }
    const options: TerrainLoaderOptions = {...imageOptions, core: {worker: false}, terrain: {
        shape: 'mesh', bounds: [0, 0, 1, 1],
        elevationDecoder: TERRARIUM_DECODER, meshMaxError, skirtHeight: 0, tesselator: 'auto'}};
    const result: unknown = await parse(bytes, TerrainLoader, options);
    if (!isTerrainMesh(result)) throw new Error('TerrainLoader must return indexed XYZ mesh output');
    // XYZ images are linear in Mercator Y, not latitude. Mesh in a small local
    // domain first, then unproject each vertex for TerrainLayer's LNGLAT path.
    const southwest = lngLatToWorld([bounds[0], bounds[1]]);
    const northeast = lngLatToWorld([bounds[2], bounds[3]]);
    const source = result.attributes.POSITION;
    const positions = new Float32Array(source.value.length);
    let minimumHeight = Infinity, maximumHeight = -Infinity;
    for (let index = 0; index < positions.length; index += 3) {
        const location = worldToLngLat([
            southwest[0] + source.value[index] * (northeast[0] - southwest[0]),
            southwest[1] + source.value[index + 1] * (northeast[1] - southwest[1])
        ]);
        const height = source.value[index + 2];
        positions.set([location[0], location[1], height], index);
        minimumHeight = Math.min(minimumHeight, height);
        maximumHeight = Math.max(maximumHeight, height);
    }
    const boundingBox: [number[], number[]] = [[bounds[0], bounds[1], minimumHeight], [bounds[2], bounds[3], maximumHeight]];
    const mesh: Mesh = {...result, attributes: {...result.attributes, POSITION: {...source, value: positions}},
        header: {...result.header, vertexCount: positions.length / 3, boundingBox},
        schema: {...result.schema, metadata: {...result.schema.metadata, boundingBox: JSON.stringify(boundingBox)}}};
    return {mesh, grid, surface: createTerrainQuerySurface(mesh)};
}
