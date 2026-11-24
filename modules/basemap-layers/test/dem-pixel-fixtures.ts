// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {vi} from 'vitest';
import type {DemUnpackVector} from '../src/hillshade-layer';

/** The unpack vectors of the two encodings that MapLibre GL JS names. */
export const TERRARIUM: DemUnpackVector = [256, 1, 1 / 256, 32768];
export const MAPBOX: DemUnpackVector = [6553.6, 25.6, 0.1, 10000];

export const KNOWN_TILE_SIZE = 256;

/**
 * The RGBA bytes of an opaque DEM tile in which each channel takes every byte value: red is the
 * row, green the column, and blue a mix of both. Each pixel is a known elevation in either
 * encoding, from -32768 m to 32767 m in Terrarium and -10000 m to 1667721.5 m in Mapbox.
 */
export function getKnownTileBytes(): Uint8ClampedArray<ArrayBuffer> {
  const size = KNOWN_TILE_SIZE;
  const bytes = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      bytes[i] = y;
      bytes[i + 1] = x;
      bytes[i + 2] = (x * 7 + y * 13) % 256;
      bytes[i + 3] = 255;
    }
  }
  return bytes;
}

/** A lossless PNG of `bytes`, which must be opaque. */
export async function encodePng(
  bytes: Uint8ClampedArray<ArrayBuffer>,
  size: number
): Promise<Blob> {
  const canvas = new OffscreenCanvas(size, size);
  canvas.getContext('2d')!.putImageData(new ImageData(bytes, size, size), 0, 0);
  return await canvas.convertToBlob({type: 'image/png'});
}

/** A `fetch` that answers every URL with `blob`. */
export function fetchBlob(blob: Blob): typeof fetch {
  return (async () => new Response(blob, {headers: {'Content-Type': 'image/png'}})) as typeof fetch;
}

/**
 * The number of bytes that differ between two pixel arrays, or `Infinity` for different lengths.
 * A count keeps a failure message short where a diff of a full tile would not be.
 */
export function countChangedBytes(actual: ArrayLike<number>, expected: ArrayLike<number>): number {
  if (actual.length !== expected.length) {
    return Infinity;
  }
  let changed = 0;
  for (let i = 0; i < actual.length; i++) {
    changed += actual[i] === expected[i] ? 0 : 1;
  }
  return changed;
}

/** The largest absolute difference between two elevation grids, in meters. */
export function getMaxError(actual: ArrayLike<number>, expected: ArrayLike<number>): number {
  if (actual.length !== expected.length) {
    return Infinity;
  }
  let max = 0;
  for (let i = 0; i < actual.length; i++) {
    max = Math.max(max, Math.abs(actual[i] - expected[i]));
  }
  return max;
}

/**
 * Makes `getImageData` add noise as fingerprinting protection does: about one pixel in four gets
 * one color byte moved by one, from a fixed seed. Returns how many bytes it changed so far.
 */
export function installCanvasNoise(): {changedBytes: () => number} {
  let changed = 0;
  let seed = 0x2545f491;
  const random = () => {
    // mulberry32
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (const prototype of [
    CanvasRenderingContext2D.prototype,
    OffscreenCanvasRenderingContext2D.prototype
  ]) {
    const getImageData = prototype.getImageData;
    vi.spyOn(prototype, 'getImageData').mockImplementation(function (
      this: CanvasRenderingContext2D,
      ...args: Parameters<typeof getImageData>
    ) {
      const image = getImageData.apply(this, args);
      const {data} = image;
      for (let i = 0; i < data.length; i += 4) {
        if (random() < 0.25) {
          const byte = i + Math.floor(random() * 3);
          const before = data[byte];
          data[byte] = before === 255 ? 254 : before + 1;
          changed++;
        }
      }
      return image;
    } as typeof getImageData);
  }
  return {changedBytes: () => changed};
}

/** Counts the `VideoFrame`s made from now on. */
export function countVideoFrames(): {count: () => number} {
  const NativeVideoFrame = globalThis.VideoFrame;
  let count = 0;
  class CountedVideoFrame extends NativeVideoFrame {
    constructor(...args: ConstructorParameters<typeof VideoFrame>) {
      super(...args);
      count++;
    }
  }
  vi.stubGlobal('VideoFrame', CountedVideoFrame);
  return {count: () => count};
}

/** The URL of a recorded Terrarium tile of Mount Rainier (see `reference-render/fixtures.ts`). */
export const RAINIER_TILE_PATH =
  'modules/basemap-layers/test/reference-render/fixtures/s3.amazonaws.com/elevation-tiles-prod/terrarium/11/330/721.png';
