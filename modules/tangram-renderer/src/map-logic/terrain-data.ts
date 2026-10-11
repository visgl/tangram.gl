// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/** Affine coefficients applied to byte-valued linear RGB, with output in meters. */
export interface ElevationDecoder {
    /** Red channel multiplier. */
    readonly rScaler: number;
    /** Green channel multiplier. */
    readonly gScaler: number;
    /** Blue channel multiplier. */
    readonly bScaler: number;
    /** Meter offset after channel scaling. */
    readonly offset: number;
}

/** Terrarium encoding used by Mapterhorn; compatible with loaders.gl terrain options. */
export const TERRARIUM_DECODER: ElevationDecoder = Object.freeze({rScaler: 256, gScaler: 1, bScaler: 1 / 256, offset: -32768});
/** Mapbox Terrain-RGB encoding, independent of the tile service. */
export const TERRAIN_RGB_DECODER: ElevationDecoder = Object.freeze({rScaler: 6553.6, gScaler: 25.6, bScaler: 0.1, offset: -10000});

/** Explicit raster georeferencing; row zero is north and column zero is west. */
export interface TerrainGridOptions {
    /** Number of columns, at least two. */
    width: number;
    /** Number of rows, at least two. */
    height: number;
    /** Interleaved RGBA bytes, not sRGB-converted samples. */
    pixels: Uint8Array | Uint8ClampedArray;
    /** Decoder shared with loaders.gl. */
    decoder: ElevationDecoder;
    /** [west, south, east, north] in absolute EPSG:3857 meters. */
    bounds: readonly [number, number, number, number];
    /** Explicit vertical reference; do not infer a datum from the provider name. */
    verticalDatum: 'ellipsoidal' | 'orthometric' | 'unknown';
    /** Pixel-aligned validity mask; zero means no data. Alpha is not implicitly interpreted. */
    valid?: Uint8Array;
    /** Raster pixel centers, or samples including both grid edges. */
    registration: 'pixel-center' | 'grid-node';
}

/** Detached decoded elevation data; meters are physical heights, never exaggerated. */
export interface TerrainHeightGrid {
    /** Number of columns. */
    readonly width: number;
    /** Number of rows. */
    readonly height: number;
    /** North-to-south, west-to-east row-major elevation values in meters. */
    readonly heights: Float32Array;
    /** Detached validity mask; invalid heights are NaN. */
    readonly valid: Uint8Array;
    /** Absolute Mercator footprint in meters. */
    readonly bounds: readonly [number, number, number, number];
    /** Vertical reference, without implicit conversions. */
    readonly verticalDatum: TerrainGridOptions['verticalDatum'];
    /** Sampling convention of the decoded pixels. */
    readonly registration: TerrainGridOptions['registration'];
}

/** Decode identical byte coefficients to loaders.gl; preserve no-data explicitly. */
export function decodeTerrainHeightGrid(options: TerrainGridOptions): TerrainHeightGrid {
    const {width, height, pixels, decoder, bounds, verticalDatum, registration} = options;
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 2 || height < 2 || pixels.length !== width * height * 4) {
        throw new Error('Terrain requires a complete RGBA grid of at least 2 by 2');
    }
    if (bounds.length !== 4 || !bounds.every(Number.isFinite) || bounds[0] >= bounds[2] || bounds[1] >= bounds[3]) throw new Error('Terrain bounds must have finite positive extent');
    if (![decoder.rScaler, decoder.gScaler, decoder.bScaler, decoder.offset].every(Number.isFinite)) throw new Error('Terrain decoder must be finite');
    if (!['ellipsoidal', 'orthometric', 'unknown'].includes(verticalDatum) || !['pixel-center', 'grid-node'].includes(registration)) throw new Error('Terrain datum and registration must be explicit');
    if (options.valid && options.valid.length !== width * height) throw new Error('Terrain validity mask must match the pixels');
    const heights = new Float32Array(width * height);
    const valid = new Uint8Array(width * height);
    for (let index = 0; index < heights.length; index++) {
        valid[index] = options.valid ? Number(options.valid[index] !== 0) : 1;
        const offset = index * 4;
        heights[index] = valid[index] ? pixels[offset] * decoder.rScaler + pixels[offset + 1] * decoder.gScaler + pixels[offset + 2] * decoder.bScaler + decoder.offset : NaN;
        if (valid[index] && !Number.isFinite(heights[index])) throw new Error('Terrain elevation exceeds the finite Float32 range');
    }
    return {width, height, heights, valid, bounds: [bounds[0], bounds[1], bounds[2], bounds[3]], verticalDatum, registration};
}

/** Bilinear height lookup; outside footprints and no-data neighborhoods return null. */
export function sampleTerrainHeight(grid: TerrainHeightGrid, position: readonly [number, number]): number | null {
    const [west, south, east, north] = grid.bounds;
    if (!position.every(Number.isFinite) || position[0] < west || position[0] > east || position[1] < south || position[1] > north) return null;
    const pixelCenter = grid.registration === 'pixel-center';
    const column = Math.max(0, Math.min(grid.width - 1, (position[0] - west) / (east - west) * (pixelCenter ? grid.width : grid.width - 1) - (pixelCenter ? 0.5 : 0)));
    const row = Math.max(0, Math.min(grid.height - 1, (north - position[1]) / (north - south) * (pixelCenter ? grid.height : grid.height - 1) - (pixelCenter ? 0.5 : 0)));
    const left = Math.floor(column), top = Math.floor(row);
    const horizontal = column - left, vertical = row - top;
    const samples = [top * grid.width + left, top * grid.width + Math.min(left + 1, grid.width - 1),
        Math.min(top + 1, grid.height - 1) * grid.width + left, Math.min(top + 1, grid.height - 1) * grid.width + Math.min(left + 1, grid.width - 1)];
    const weights = [(1 - horizontal) * (1 - vertical), horizontal * (1 - vertical), (1 - horizontal) * vertical, horizontal * vertical];
    let height = 0;
    for (let index = 0; index < samples.length; index++) {
        if (weights[index] === 0) continue;
        if (!grid.valid[samples[index]]) return null;
        height += grid.heights[samples[index]] * weights[index];
    }
    return height;
}
