// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {parse} from '@loaders.gl/core';
import {TerrainLoader, type TerrainLoaderOptions} from '@loaders.gl/terrain';
import {lngLatToWorld, worldToLngLat} from '@math.gl/web-mercator';
import {TERRARIUM_DECODER} from '@tangram.gl/tangram-renderer/map-logic';
import {decodeTerrainGrid} from './decode-height-grid';
import {isTerrainMesh, validateTerrainImage, type TerrainTileData, type TerrainNoDataPolicy} from './terrain-payload';

/** Decode data-preserving image bytes and adaptive topology in a browser or local worker. */
export async function decodeTerrainTile(bytes: ArrayBuffer, bounds: readonly [number, number, number, number], meshMaxError = 20, noData: TerrainNoDataPolicy = 'opaque'): Promise<TerrainTileData> {
    validateTerrainImage(bytes, bounds, noData);
    if (!Number.isFinite(meshMaxError) || meshMaxError < 0) throw new Error('Terrain mesh error must be non-negative meters');
    const imageOptions = {imagebitmap: {colorSpaceConversion: 'none' as const, premultiplyAlpha: 'none' as const}};
    // math.gl common world Y is north-positive; only XYZ tile row indexing is south-positive.
    const southwest = lngLatToWorld([bounds[0], bounds[1]]), northeast = lngLatToWorld([bounds[2], bounds[3]]);
    const {grid} = await decodeTerrainGrid(bytes, bounds, noData);
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
