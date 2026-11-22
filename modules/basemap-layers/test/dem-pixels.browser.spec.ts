// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {afterEach, describe, expect, test, vi} from 'vitest';
import {
  DemPixelReadError,
  chooseDemPixelReadMethod,
  createDemPixelReader,
  readPixelsWithVideoFrame
} from '../src/dem-pixels';
import {
  KNOWN_TILE_SIZE,
  countChangedBytes,
  countVideoFrames,
  getKnownTileBytes,
  installCanvasNoise
} from './dem-pixel-fixtures';

// Some browsers add noise to canvas reads to resist fingerprinting. DEM pixels are read through
// a canvas where its reads are exact, through VideoFrame where they are not, and never inexactly.

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** An image bitmap of the known DEM tile, made without a canvas read. */
async function getKnownImage(): Promise<ImageBitmap> {
  return await createImageBitmap(
    new ImageData(getKnownTileBytes(), KNOWN_TILE_SIZE, KNOWN_TILE_SIZE),
    {premultiplyAlpha: 'none', colorSpaceConversion: 'none'}
  );
}

/** A `VideoFrame` stand-in with a given pixel format, holding the RGBA bytes of `source`. */
function fakeVideoFrame(format: string, source: Uint8ClampedArray, alpha = 255) {
  return class FakeVideoFrame {
    readonly format = format;
    close = vi.fn();
    async copyTo(destination: Uint8ClampedArray) {
      for (let i = 0; i < source.length; i += 4) {
        const [r, g, b] = [source[i], source[i + 1], source[i + 2]];
        destination.set(format.startsWith('B') ? [b, g, r, alpha] : [r, g, b, alpha], i);
      }
      return [];
    }
  };
}

describe('DEM pixel reads', () => {
  test('use the canvas, and no VideoFrame, where canvas reads are exact', async () => {
    const frames = countVideoFrames();
    const read = createDemPixelReader();
    const image = await getKnownImage();

    expect(await chooseDemPixelReadMethod()).toBe('canvas');
    expect(countChangedBytes(await read(image), getKnownTileBytes())).toBe(0);
    expect(frames.count()).toBe(0);
  });

  test('use VideoFrame, with exact bytes, where canvas reads have noise', async () => {
    const noise = installCanvasNoise();
    const frames = countVideoFrames();
    const read = createDemPixelReader();
    const image = await getKnownImage();

    expect(await chooseDemPixelReadMethod()).toBe('video-frame');
    expect(countChangedBytes(await read(image), getKnownTileBytes())).toBe(0);
    // The noise reached the canvas test read.
    expect(noise.changedBytes()).toBeGreaterThan(0);
    // One frame for the test image of each choice, one for the tile.
    expect(frames.count()).toBe(3);
  });

  test('choose the read method once per reader', async () => {
    installCanvasNoise();
    const frames = countVideoFrames();
    const read = createDemPixelReader();
    const image = await getKnownImage();

    await read(image);
    await read(image);
    await read(image);
    // One frame for the test image, one per tile.
    expect(frames.count()).toBe(4);
  });

  test('fail where canvas reads have noise and VideoFrame is missing', async () => {
    installCanvasNoise();
    vi.stubGlobal('VideoFrame', undefined);
    const read = createDemPixelReader();
    const image = await getKnownImage();

    const error = await read(image).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DemPixelReadError);
    expect((error as Error).message).toMatch(/VideoFrame is not available/);
  });

  test('fail where canvas reads have noise and VideoFrame throws', async () => {
    installCanvasNoise();
    const failure = new Error('WebCodecs is off');
    vi.stubGlobal(
      'VideoFrame',
      class {
        constructor() {
          throw failure;
        }
      }
    );
    const read = createDemPixelReader();

    const error = await read(await getKnownImage()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DemPixelReadError);
    expect((error as Error).cause).toBe(failure);
  });

  test('fail where VideoFrame also changes the pixels', async () => {
    installCanvasNoise();
    const NativeVideoFrame = globalThis.VideoFrame;
    vi.stubGlobal(
      'VideoFrame',
      class extends NativeVideoFrame {
        async copyTo(destination: AllowSharedBufferSource, options?: VideoFrameCopyToOptions) {
          const layout = await super.copyTo(destination, options);
          (destination as Uint8ClampedArray)[0] ^= 1;
          return layout;
        }
      }
    );
    const read = createDemPixelReader();

    const error = await read(await getKnownImage()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DemPixelReadError);
    expect((error as Error).message).toMatch(/VideoFrame also changes the pixels/);
  });

  test('fail a tile whose VideoFrame read throws after the choice', async () => {
    installCanvasNoise();
    const NativeVideoFrame = globalThis.VideoFrame;
    let frames = 0;
    const failure = new Error('frame lost');
    vi.stubGlobal(
      'VideoFrame',
      class extends NativeVideoFrame {
        constructor(...args: ConstructorParameters<typeof VideoFrame>) {
          super(...args);
          if (++frames > 1) {
            throw failure;
          }
        }
      }
    );
    const read = createDemPixelReader();

    const error = await read(await getKnownImage()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DemPixelReadError);
    expect((error as Error).cause).toBe(failure);
  });

  test.each(['RGBA', 'RGBX', 'BGRA', 'BGRX'])('read %s video frames as RGBA', async format => {
    const expected = getKnownTileBytes();
    // Formats without alpha leave the alpha bytes undefined.
    vi.stubGlobal('VideoFrame', fakeVideoFrame(format, expected, format.endsWith('X') ? 7 : 255));

    const pixels = await readPixelsWithVideoFrame(await getKnownImage());
    expect(countChangedBytes(pixels, expected)).toBe(0);
  });

  test('reject video frames that are not RGB', async () => {
    vi.stubGlobal('VideoFrame', fakeVideoFrame('I420', getKnownTileBytes()));

    await expect(readPixelsWithVideoFrame(await getKnownImage())).rejects.toThrow(/I420/);
  });
});
