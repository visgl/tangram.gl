// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {parse} from '@loaders.gl/core';
import {ImageBitmapLoader, getImageData} from '@loaders.gl/images';
import {TerrainLoader, type TerrainLoaderOptions} from '@loaders.gl/terrain';
import type {Mesh} from '@loaders.gl/schema';
import {lngLatToWorld, worldToLngLat} from '@math.gl/web-mercator';
import {TERRARIUM_DECODER, decodeTerrainHeightGrid, type TerrainHeightGrid} from '@vis.gl/tangram-renderer/map-logic';

/** Serializable worker output, without scene, Deck or query-surface instances. */
export interface TerrainTileData {
    /** Original adaptive mesh, in geographic XY and physical-meter Z. */
    mesh: Mesh;
    /** Physical samples with explicit registration and validity. */
    grid: TerrainHeightGrid;
}

/** Alpha has no no-data meaning unless explicitly requested. */
export type TerrainNoDataPolicy = 'opaque' | 'alpha-zero';

/** Validate loader and worker geometry before using its typed attributes. */
export function isTerrainMesh(value: unknown): value is Mesh {
    if (!value || typeof value !== 'object' || !('attributes' in value) || !value.attributes || typeof value.attributes !== 'object' ||
        !('POSITION' in value.attributes) || !('indices' in value) || !value.indices || typeof value.indices !== 'object' ||
        !('topology' in value) || value.topology !== 'triangle-list' || !('mode' in value) || typeof value.mode !== 'number' ||
        !('schema' in value) || !value.schema || typeof value.schema !== 'object') return false;
    const positions = value.attributes.POSITION, indices = value.indices;
    if (!positions || typeof positions !== 'object' || !('size' in positions) || positions.size !== 3 || !('value' in positions) ||
        !(positions.value instanceof Float32Array) || positions.value.length % 3 !== 0 || !('size' in indices) || indices.size !== 1 ||
        !('value' in indices) || !(indices.value instanceof Uint32Array || indices.value instanceof Uint16Array) || indices.value.length % 3 !== 0 ||
        !('fields' in value.schema) || !Array.isArray(value.schema.fields) || !('metadata' in value.schema) || !value.schema.metadata || typeof value.schema.metadata !== 'object') return false;
    const positionValues = positions.value;
    return positionValues.every(Number.isFinite) && indices.value.every(index => index < positionValues.length / 3);
}

/** Decode data-preserving image bytes and adaptive topology in a browser or local worker. */
export async function decodeTerrainTile(bytes: ArrayBuffer, bounds: readonly [number, number, number, number], meshMaxError = 20, noData: TerrainNoDataPolicy = 'opaque'): Promise<TerrainTileData> {
    if (bounds.length !== 4 || !bounds.every(Number.isFinite) || bounds[0] >= bounds[2] || bounds[1] >= bounds[3] || bounds[0] < -180 || bounds[2] > 180 || bounds[1] < -85.0511287798066 || bounds[3] > 85.0511287798066) throw new Error('Terrain tile requires ordered Mercator-domain geographic bounds');
    if (!Number.isFinite(meshMaxError) || meshMaxError < 0) throw new Error('Terrain mesh error must be non-negative meters');
    if (noData !== 'opaque' && noData !== 'alpha-zero') throw new Error('Unknown terrain no-data policy');
    if (bytes.byteLength > 8 * 1024 * 1024) throw new Error('Terrain image exceeds compressed byte limit');
    const imageOptions = {imagebitmap: {colorSpaceConversion: 'none' as const, premultiplyAlpha: 'none' as const}};
    // math.gl common world Y is north-positive; only XYZ tile row indexing is south-positive.
    const southwest = lngLatToWorld([bounds[0], bounds[1]]), northeast = lngLatToWorld([bounds[2], bounds[3]]);
    const bitmap = await parse(bytes, ImageBitmapLoader, imageOptions);
    let grid: TerrainHeightGrid;
    try {
        const image = getImageData(bitmap);
        if (image.width !== image.height || image.width < 2 || image.width > 1024 || (image.width & (image.width - 1)) !== 0) throw new Error('Terrain requires a square power-of-two image of at most 1024 pixels');
        const valid = noData === 'alpha-zero' ? Uint8Array.from({length: image.width * image.height}, (_, index) => Number(image.data[index * 4 + 3] !== 0)) : undefined;
        const scale = 2 * Math.PI * 6378137 / 512;
        grid = decodeTerrainHeightGrid({width: image.width, height: image.height, pixels: image.data, valid,
            decoder: TERRARIUM_DECODER, bounds: [(southwest[0] - 256) * scale, (southwest[1] - 256) * scale, (northeast[0] - 256) * scale, (northeast[1] - 256) * scale],
            registration: 'pixel-center', verticalDatum: 'unknown'});
    } finally {bitmap.close();}
    const options: TerrainLoaderOptions = {...imageOptions, core: {worker: false}, terrain: {
        shape: 'mesh', bounds: [0, 0, 1, 1], elevationDecoder: TERRARIUM_DECODER, meshMaxError, skirtHeight: 0, tesselator: 'auto'}};
    const result: unknown = await parse(bytes, TerrainLoader, options);
    if (!isTerrainMesh(result)) throw new Error('TerrainLoader must return indexed XYZ mesh output');
    const source = result.attributes.POSITION;
    const positions = new Float32Array(source.value.length);
    let minimumHeight = Infinity, maximumHeight = -Infinity;
    for (let index = 0; index < positions.length; index += 3) {
        const location = worldToLngLat([southwest[0] + source.value[index] * (northeast[0] - southwest[0]), southwest[1] + source.value[index + 1] * (northeast[1] - southwest[1])]);
        const height = source.value[index + 2];
        positions.set([location[0], location[1], height], index);
        minimumHeight = Math.min(minimumHeight, height); maximumHeight = Math.max(maximumHeight, height);
    }
    const boundingBox: [number[], number[]] = [[bounds[0], bounds[1], minimumHeight], [bounds[2], bounds[3], maximumHeight]];
    return {grid, mesh: {...result, attributes: {...result.attributes, POSITION: {...source, value: positions}},
        header: {...result.header, vertexCount: positions.length / 3, boundingBox},
        schema: {...result.schema, metadata: {...result.schema.metadata, boundingBox: JSON.stringify(boundingBox)}}}};
}
