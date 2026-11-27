// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {createGeoTIFFSource, type GeoTIFFRasterSource} from '@loaders.gl/raster/geotiff';

import type {Bounds} from './grid';
import {toRGBA, type RasterLevel, type RasterTint, type RasterWindow} from './raster-window';

/** The georeference of a raster, read from the header of the file. */
export type RasterInfo = {
  /** The bounds of the raster in its own coordinate reference system. */
  bounds: Bounds;
  /** The full image and the overviews, finest first. */
  levels: RasterLevel[];
};

/** A block of pixels of a raster, ready to draw. */
export type RasterImage = {
  /** The pixels, as RGBA. */
  image: ImageData;
  /** The bounds of the block in the coordinate reference system of the raster. */
  bounds: Bounds;
  /** The level that the block was read from. */
  level: RasterLevel;
};

/** Reads blocks of pixels from a Cloud Optimized GeoTIFF with HTTP range requests. */
export class NativeRaster {
  /** The URL of the GeoTIFF. */
  readonly url: string;
  private readonly source: GeoTIFFRasterSource;
  private readonly tint: RasterTint | undefined;
  private crs: string | undefined;

  constructor(url: string, tint?: RasterTint) {
    this.url = url;
    this.tint = tint;
    this.source = createGeoTIFFSource(url, {
      // Keep the compressed blocks of the file that the view goes back to.
      geotiff: {rangeCacheProps: {maxEntries: 512, maxBytes: 96 * 1024 * 1024}}
    });
  }

  /** Reads the header of the file. */
  async open(signal?: AbortSignal): Promise<RasterInfo> {
    const metadata = await this.source.getMetadata({signal});
    const {boundingBox, crs, overviews} = metadata;
    if (!boundingBox || typeof crs !== 'string') {
      throw new Error(`${this.url} has no georeference`);
    }
    this.crs = crs;
    const bounds: Bounds = [boundingBox[0][0], boundingBox[0][1], boundingBox[1][0], boundingBox[1][1]];
    const levels = (overviews || [{index: 0, width: metadata.width, height: metadata.height}]).map(
      ({index, width, height}) => ({index, width, height, resolution: (bounds[2] - bounds[0]) / width})
    );
    return {bounds, levels};
  }

  /** Reads one block of whole pixels. The file's pixels are not resampled. */
  async read(window: RasterWindow, level: RasterLevel, signal?: AbortSignal): Promise<RasterImage> {
    if (!this.crs) {
      throw new Error('Call open() before read()');
    }
    const {bounds, width, height} = window;
    const raster = await this.source.getRasterForRegion({
      bounds: [
        [bounds[0], bounds[1]],
        [bounds[2], bounds[3]]
      ],
      crs: this.crs,
      width,
      height,
      interleaved: true,
      resampleMethod: 'nearest',
      signal
    });
    if (raster.dtype !== 'uint8' || Array.isArray(raster.data)) {
      throw new Error(`${this.url} is not an 8-bit image`);
    }
    const rgba = toRGBA(raster.data as Uint8Array, raster.bandCount, raster.noData, this.tint);
    return {image: new ImageData(rgba, raster.width, raster.height), bounds, level};
  }

  /** Stops the requests of the source. */
  finalize(): void {
    this.source.finalize();
  }
}
