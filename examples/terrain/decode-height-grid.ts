// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {parse} from '@loaders.gl/core';
import {LegacyImageLoader, getImageData, type LegacyImageLoaderOptions} from '@loaders.gl/images';
import {lngLatToWorld} from '@math.gl/geospatial';
import {TERRARIUM_DECODER, decodeTerrainHeightGrid} from '@tangram.gl/tangram-renderer/map-logic';
import {validateTerrainImage, type TerrainGridData, type TerrainNoDataPolicy} from './terrain-payload';

/** Decode one data-preserving bitmap into physical samples, without a second image parse or adaptive tessellation. */
export async function decodeTerrainGrid(bytes: ArrayBuffer, bounds: readonly [number, number, number, number], noData: TerrainNoDataPolicy = 'opaque'): Promise<TerrainGridData> {
    validateTerrainImage(bytes, bounds, noData);
    const imageOptions: LegacyImageLoaderOptions = {core: {worker: false}, image: {type: 'imagebitmap'}, imagebitmap: {colorSpaceConversion: 'none', premultiplyAlpha: 'none'}};
    const bitmap = await parse(bytes, LegacyImageLoader, imageOptions) as ImageBitmap;
    try {
        if (bitmap.width !== bitmap.height || bitmap.width < 2 || bitmap.width > 1024 || (bitmap.width & (bitmap.width - 1)) !== 0) throw new Error('Terrain requires a square power-of-two image of at most 1024 pixels');
        const image = getImageData(bitmap);
        const valid = noData === 'alpha-zero' ? Uint8Array.from({length: image.width * image.height}, (_, index) => Number(image.data[index * 4 + 3] !== 0)) : undefined;
        const southwest = lngLatToWorld([bounds[0], bounds[1]]), northeast = lngLatToWorld([bounds[2], bounds[3]]), scale = 2 * Math.PI * 6378137 / 512;
        return {grid: decodeTerrainHeightGrid({width: image.width, height: image.height, pixels: image.data, valid,
            decoder: TERRARIUM_DECODER, bounds: [(southwest[0] - 256) * scale, (southwest[1] - 256) * scale, (northeast[0] - 256) * scale, (northeast[1] - 256) * scale], registration: 'pixel-center', verticalDatum: 'unknown'})};
    } finally {bitmap.close();}
}
