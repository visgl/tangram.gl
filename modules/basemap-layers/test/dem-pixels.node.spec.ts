// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import {DemPixelReadError, createDemPixelReader} from '../src/dem-pixels';
import * as basemap from '../src/index';

class TestImageData {
  constructor(
    readonly data: Uint8ClampedArray,
    readonly width: number,
    readonly height: number
  ) {}

  close() {}
}

const getContext = vi.fn();
const createBitmap = vi.fn(async (image: TestImageData, _options: ImageBitmapOptions) => image);

class TestCanvas {
  private image?: TestImageData;

  getContext() {
    return getContext(this);
  }

  setImage(image: TestImageData) {
    this.image = image;
  }

  transferToImageBitmap() {
    return this.image;
  }

  getImageData() {
    const {data, width, height} = this.image!;
    return new TestImageData(data.slice(), width, height);
  }
}

const tile = new TestImageData(new Uint8ClampedArray([128, 0, 0, 255]), 1, 1);

function changeCanvasByte(byte: number) {
  const getImageData = TestCanvas.prototype.getImageData;
  vi.spyOn(TestCanvas.prototype, 'getImageData').mockImplementation(function (this: TestCanvas) {
    const image = getImageData.call(this);
    if (byte < image.data.length) {
      image.data[byte] ^= 1;
    }
    return image;
  });
}

function stubVideoFrame() {
  const copyTo = vi.fn(async (source: TestImageData, destination: Uint8ClampedArray) => {
    destination.set(source.data);
  });
  vi.stubGlobal(
    'VideoFrame',
    class {
      readonly format = 'RGBA';

      constructor(private readonly source: TestImageData) {}

      copyTo(destination: Uint8ClampedArray) {
        return copyTo(this.source, destination);
      }

      close() {}
    }
  );
  return copyTo;
}

beforeEach(() => {
  getContext.mockImplementation((canvas: TestCanvas) => ({
    putImageData: canvas.setImage.bind(canvas),
    drawImage: canvas.setImage.bind(canvas),
    getImageData: canvas.getImageData.bind(canvas)
  }));
  vi.stubGlobal('ImageData', TestImageData);
  vi.stubGlobal('OffscreenCanvas', TestCanvas);
  vi.stubGlobal('createImageBitmap', createBitmap);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('DEM reader method selection', () => {
  test('retries after concurrent reads share a failed canvas probe', async () => {
    getContext.mockReturnValueOnce(null);
    const read = createDemPixelReader();
    await Promise.all([
      expect(read(tile)).rejects.toThrow(/need a 2D canvas context/),
      expect(read(tile)).rejects.toThrow(/need a 2D canvas context/)
    ]);
    expect(getContext).toHaveBeenCalledTimes(1);

    await expect(read(tile)).resolves.toEqual(new Uint8ClampedArray([128, 0, 0, 255]));
  });

  test('retries after a temporary VideoFrame probe failure', async () => {
    changeCanvasByte(0);
    const failure = new Error('GPU reset');
    stubVideoFrame().mockRejectedValueOnce(failure);
    const read = createDemPixelReader();

    await expect(read(tile)).rejects.toBe(failure);
    await expect(read(tile)).resolves.toEqual(new Uint8ClampedArray([128, 0, 0, 255]));
  });

  test('detects sparse noise with a tile-sized bitmap using DEM decode options', async () => {
    // A changed byte beyond the first 256 pixels is invisible to a 16×16 probe.
    changeCanvasByte(512 * 4);
    const copyTo = stubVideoFrame();
    const read = createDemPixelReader();

    await read(tile);
    await read(tile);

    expect(copyTo).toHaveBeenCalledTimes(3);
    expect(createBitmap).toHaveBeenCalledTimes(1);
    expect(createBitmap).toHaveBeenCalledWith(expect.objectContaining({width: 256, height: 256}), {
      premultiplyAlpha: 'none',
      colorSpaceConversion: 'none'
    });
  });

  test('preserves the original error when a tile VideoFrame copy fails', async () => {
    changeCanvasByte(0);
    const failure = new Error('frame lost');
    const copyTo = stubVideoFrame();
    const read = createDemPixelReader();
    await read(tile);

    copyTo.mockRejectedValueOnce(failure);
    await expect(read(tile)).rejects.toBe(failure);
    await expect(read(tile)).resolves.toEqual(new Uint8ClampedArray([128, 0, 0, 255]));
    expect(copyTo).toHaveBeenCalledTimes(4);
  });

  test('keeps the probe failure when the browser has no exact reader', async () => {
    changeCanvasByte(0);
    vi.stubGlobal('VideoFrame', undefined);
    const read = createDemPixelReader();

    await expect(read(tile)).rejects.toBeInstanceOf(DemPixelReadError);
    const probeCalls = getContext.mock.calls.length;
    await expect(read(tile)).rejects.toBeInstanceOf(DemPixelReadError);
    expect(getContext).toHaveBeenCalledTimes(probeCalls);
  });

  test('exports the DEM exactness error from the public entry point', () => {
    expect(Reflect.get(basemap, 'DemPixelReadError')).toBe(DemPixelReadError);
  });
});
