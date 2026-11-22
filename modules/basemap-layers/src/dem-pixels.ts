// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/** An image whose pixels can be read: a decoded tile, or a canvas. */
export type DemPixelSource = ImageBitmap | HTMLCanvasElement | OffscreenCanvas;

/** Reads the exact RGBA bytes of an image, row by row from the top-left pixel. */
export type DemPixelReader = (image: DemPixelSource) => Promise<Uint8ClampedArray>;

/** How the pixels of a DEM tile are read exactly. */
export type DemPixelReadMethod = 'canvas' | 'video-frame';

/**
 * Thrown when this browser gives no exact pixels of an image. Some browsers add noise to canvas
 * reads to resist fingerprinting (Firefox `privacy.resistFingerprinting`, Brave, Safari), and
 * some of them also turn `VideoFrame` off. One changed byte moves a Terrarium elevation by up to
 * 256 m, so the tile fails instead of drawing wrong heights.
 */
export class DemPixelReadError extends Error {
  constructor(reason: string, options?: {cause?: unknown}) {
    super(
      'This browser changes the pixels that a canvas reads back, so DEM tiles cannot be ' +
        `decoded exactly: ${reason}`,
      options
    );
    this.name = 'DemPixelReadError';
  }
}

/** The side of the square test image. */
const TEST_SIZE = 16;

/**
 * An opaque test image whose color bytes count up 0, 1, 2… and repeat, so every byte value
 * appears three times. Opaque pixels keep their bytes through a premultiplied canvas.
 */
function getTestPixels(): Uint8ClampedArray<ArrayBuffer> {
  const pixels = new Uint8ClampedArray(TEST_SIZE * TEST_SIZE * 4);
  for (let pixel = 0; pixel < TEST_SIZE * TEST_SIZE; pixel++) {
    for (let channel = 0; channel < 3; channel++) {
      pixels[pixel * 4 + channel] = (pixel * 3 + channel) % 256;
    }
    pixels[pixel * 4 + 3] = 255;
  }
  return pixels;
}

function createCanvas(width: number, height: number): HTMLCanvasElement | OffscreenCanvas {
  return typeof OffscreenCanvas === 'undefined'
    ? Object.assign(document.createElement('canvas'), {width, height})
    : new OffscreenCanvas(width, height);
}

function get2DContext(
  canvas: HTMLCanvasElement | OffscreenCanvas
): CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D {
  const context = canvas.getContext('2d', {willReadFrequently: true}) as
    | CanvasRenderingContext2D
    | OffscreenCanvasRenderingContext2D
    | null;
  if (!context) {
    throw new Error('DEM tiles need a 2D canvas context to read their pixels');
  }
  return context;
}

/** Reads the pixels of an image through a 2D canvas. */
export function readPixelsWithCanvas(image: DemPixelSource): Promise<Uint8ClampedArray> {
  const {width, height} = image;
  const context = get2DContext(createCanvas(width, height));
  context.drawImage(image, 0, 0);
  return Promise.resolve(context.getImageData(0, 0, width, height).data);
}

/**
 * Reads the pixels of an image through WebCodecs, which canvas noise does not reach. The frame
 * is copied in its own pixel format, so no color conversion runs; blue-first formats are
 * reordered to RGBA, and formats without alpha (`RGBX`, `BGRX`) get opaque pixels.
 */
export async function readPixelsWithVideoFrame(image: DemPixelSource): Promise<Uint8ClampedArray> {
  const {width, height} = image;
  const frame = new VideoFrame(image, {timestamp: 0, alpha: 'keep'});
  try {
    const {format} = frame;
    if (format !== 'RGBA' && format !== 'RGBX' && format !== 'BGRA' && format !== 'BGRX') {
      throw new Error(`VideoFrame has the pixel format ${format}, not an RGB one`);
    }
    const pixels = new Uint8ClampedArray(width * height * 4);
    await frame.copyTo(pixels, {
      rect: {x: 0, y: 0, width, height},
      layout: [{offset: 0, stride: width * 4}]
    });
    const blueFirst = format.startsWith('B');
    const opaque = format.endsWith('X');
    if (blueFirst || opaque) {
      for (let i = 0; i < pixels.length; i += 4) {
        if (blueFirst) {
          const blue = pixels[i];
          pixels[i] = pixels[i + 2];
          pixels[i + 2] = blue;
        }
        if (opaque) {
          pixels[i + 3] = 255;
        }
      }
    }
    return pixels;
  } finally {
    frame.close();
  }
}

/** Whether `read` gives the test image's bytes back unchanged. */
async function readsExactly(read: DemPixelReader): Promise<boolean> {
  const expected = getTestPixels();
  const canvas = createCanvas(TEST_SIZE, TEST_SIZE);
  get2DContext(canvas).putImageData(new ImageData(expected, TEST_SIZE, TEST_SIZE), 0, 0);
  // Tiles are image bitmaps: test one where the browser can make it without a decode.
  const image = 'transferToImageBitmap' in canvas ? canvas.transferToImageBitmap() : canvas;
  try {
    const actual = await read(image);
    return actual.length === expected.length && actual.every((byte, i) => byte === expected[i]);
  } finally {
    if ('close' in image) {
      image.close();
    }
  }
}

/**
 * Chooses how to read DEM pixels exactly: through a canvas, which is what MapLibre GL JS and most
 * browsers use; through `VideoFrame` where canvas reads are changed; or neither, which rejects
 * with a {@link DemPixelReadError}. Each method is tested on a known image before it is chosen.
 */
export async function chooseDemPixelReadMethod(): Promise<DemPixelReadMethod> {
  if (await readsExactly(readPixelsWithCanvas)) {
    return 'canvas';
  }
  if (typeof VideoFrame === 'undefined') {
    throw new DemPixelReadError('VideoFrame is not available');
  }
  let exact: boolean;
  try {
    exact = await readsExactly(readPixelsWithVideoFrame);
  } catch (error) {
    throw new DemPixelReadError(`VideoFrame failed (${(error as Error).message})`, {
      cause: error
    });
  }
  if (!exact) {
    throw new DemPixelReadError('VideoFrame also changes the pixels');
  }
  return 'video-frame';
}

/**
 * A reader of exact DEM pixels. The read method is chosen on the first read and kept for every
 * later one (see {@link chooseDemPixelReadMethod}).
 */
export function createDemPixelReader(): DemPixelReader {
  let method: Promise<DemPixelReadMethod> | undefined;
  return async image => {
    method ||= chooseDemPixelReadMethod();
    if ((await method) === 'canvas') {
      return readPixelsWithCanvas(image);
    }
    try {
      return await readPixelsWithVideoFrame(image);
    } catch (error) {
      throw new DemPixelReadError(`VideoFrame failed (${(error as Error).message})`, {
        cause: error
      });
    }
  };
}

/** Reads the exact pixels of DEM tiles for the page; the read method is chosen once. */
export const readDemPixels: DemPixelReader = createDemPixelReader();
