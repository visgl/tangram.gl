// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {intersectBounds, type Bounds} from './grid';

/** One resolution level of a raster: the full image or an overview. */
export type RasterLevel = {
  /** The index of the level in the file. 0 is the full image. */
  index: number;
  /** The width of the level in pixels. */
  width: number;
  /** The height of the level in pixels. */
  height: number;
  /** The size of one pixel, in the units of the coordinate reference system of the raster. */
  resolution: number;
};

/** A block of whole pixels of one raster level. */
export type RasterWindow = {
  /** The bounds of the block, on pixel edges of the level. */
  bounds: Bounds;
  /** The width of the block in pixels. */
  width: number;
  /** The height of the block in pixels. */
  height: number;
};

/**
 * Returns the coarsest level that has a pixel no larger than `slack` screen pixels, or the full
 * image when the view shows more detail than the raster has.
 */
export function selectRasterLevel(
  levels: RasterLevel[],
  unitsPerPixel: number,
  slack = 1.5
): RasterLevel {
  const sorted = [...levels].sort((a, b) => b.resolution - a.resolution);
  return sorted.find(level => level.resolution <= unitsPerPixel * slack) || sorted[sorted.length - 1];
}

/**
 * Returns the block of whole pixels of `level` that covers `bounds`, or `null` when `bounds` is
 * outside the raster. The pixels of the block are pixels of the file: a read of the block does not
 * resample them.
 */
export function getRasterWindow(
  rasterBounds: Bounds,
  level: RasterLevel,
  bounds: Bounds
): RasterWindow | null {
  const visible = intersectBounds(bounds, rasterBounds);
  if (!visible) {
    return null;
  }
  const [originX, , , originY] = rasterBounds;
  // Columns count from the west edge and rows from the north edge, as in the file.
  const pixelX = (rasterBounds[2] - rasterBounds[0]) / level.width;
  const pixelY = (rasterBounds[3] - rasterBounds[1]) / level.height;
  const column0 = Math.max(0, Math.floor((visible[0] - originX) / pixelX));
  const column1 = Math.min(level.width, Math.ceil((visible[2] - originX) / pixelX));
  const row0 = Math.max(0, Math.floor((originY - visible[3]) / pixelY));
  const row1 = Math.min(level.height, Math.ceil((originY - visible[1]) / pixelY));
  if (column1 <= column0 || row1 <= row0) {
    return null;
  }
  return {
    bounds: [
      originX + column0 * pixelX,
      originY - row1 * pixelY,
      originX + column1 * pixelX,
      originY - row0 * pixelY
    ],
    width: column1 - column0,
    height: row1 - row0
  };
}

/** Returns whether `outer` contains `inner`, with a tolerance for rounding. */
export function containsBounds(outer: Bounds, inner: Bounds, tolerance = 1e-6): boolean {
  return (
    outer[0] <= inner[0] + tolerance &&
    outer[1] <= inner[1] + tolerance &&
    outer[2] >= inner[2] - tolerance &&
    outer[3] >= inner[3] - tolerance
  );
}

/** Grows bounds by a fraction of their size on each side. */
export function expandBounds(bounds: Bounds, fraction: number): Bounds {
  const marginX = (bounds[2] - bounds[0]) * fraction;
  const marginY = (bounds[3] - bounds[1]) * fraction;
  return [bounds[0] - marginX, bounds[1] - marginY, bounds[2] + marginX, bounds[3] + marginY];
}

/** A two-color ramp for a single-band raster: `[dark, light]`, each `[r, g, b]`. */
export type RasterTint = [dark: [number, number, number], light: [number, number, number]];

/**
 * Converts interleaved 8-bit samples of one band (gray) or three bands (RGB) to RGBA. A pixel with
 * the no-data value in each band is transparent.
 */
export function toRGBA(
  samples: ArrayLike<number>,
  bandCount: number,
  noData: number | null | undefined,
  tint?: RasterTint
): Uint8ClampedArray<ArrayBuffer> {
  const pixelCount = samples.length / bandCount;
  const rgba = new Uint8ClampedArray(pixelCount * 4);
  const [dark, light] = tint || [
    [0, 0, 0],
    [255, 255, 255]
  ];
  for (let pixel = 0; pixel < pixelCount; pixel++) {
    const source = pixel * bandCount;
    const target = pixel * 4;
    let empty = noData !== null && noData !== undefined;
    for (let band = 0; band < bandCount; band++) {
      empty &&= samples[source + band] === noData;
    }
    if (empty) {
      continue;
    }
    if (bandCount >= 3) {
      rgba[target] = samples[source];
      rgba[target + 1] = samples[source + 1];
      rgba[target + 2] = samples[source + 2];
    } else {
      const value = samples[source] / 255;
      rgba[target] = dark[0] + (light[0] - dark[0]) * value;
      rgba[target + 1] = dark[1] + (light[1] - dark[1]) * value;
      rgba[target + 2] = dark[2] + (light[2] - dark[2]) * value;
    }
    rgba[target + 3] = 255;
  }
  return rgba;
}
