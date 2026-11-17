// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {afterEach, beforeEach, expect, test} from 'vitest';
import {commands} from 'vitest/browser';
import {Deck, OrthographicView} from '@deck.gl/core';
import {StretchIconLayer} from '../../modules/basemap-layers/src/stretch-icon-layer';
import {RenderingHarness, readCanvasPixels, DEVICE_TYPE} from './harness';

let harness: RenderingHarness | undefined;
let deck: Deck<OrthographicView> | undefined;
beforeEach(() => commands.startRenderingDiagnostics());
afterEach(async () => {
  try {
    expect(harness?.errors || []).toEqual([]);
    expect(await commands.renderingDiagnostics()).toEqual([]);
  } finally {
    try {
      if (harness) await commands.saveRenderingArtifact(expect.getState().currentTestName || 'stretch-icon',
        harness.canvas.toDataURL('image/png'));
    } finally {
      deck?.finalize();
      deck = undefined;
      harness?.destroy();
      harness = undefined;
    }
  }
});

/** An 8 by 4 pixel image: red on the left half, blue on the right. */
function createAtlas(): string {
  const canvas = document.createElement('canvas');
  canvas.width = 8;
  canvas.height = 4;
  const context = canvas.getContext('2d')!;
  context.fillStyle = '#ff0000';
  context.fillRect(0, 0, 4, 4);
  context.fillStyle = '#0000ff';
  context.fillRect(4, 0, 4, 4);
  return canvas.toDataURL('image/png');
}

/** The bounds of the red and blue pixels in columns `[start, end)`, or null where there are none. */
function getColorBounds(image: ImageData, start: number, end: number) {
  const bounds = {red: null as number[] | null, blue: null as number[] | null};
  for (let y = 0; y < image.height; y++) {
    for (let x = start; x < end; x++) {
      const offset = (y * image.width + x) * 4;
      const [r, g, b] = image.data.subarray(offset, offset + 3);
      const color = r > 200 && g < 60 && b < 60 ? 'red' : b > 200 && r < 60 && g < 60 ? 'blue' : null;
      if (color) {
        const box = bounds[color] || [x, y, x, y];
        bounds[color] = [Math.min(box[0], x), Math.min(box[1], y), Math.max(box[2], x), Math.max(box[3], y)];
      }
    }
  }
  return bounds;
}

test(`${DEVICE_TYPE}: StretchIconLayer stretches each icon before turning it`, async () => {
  harness = new RenderingHarness('flat');
  await harness.initializeDevice();
  const errors = harness.errors;
  const canvas = harness.canvas;
  // At size 20 the 8 by 4 image is 40 by 20 pixels; stretched 3 times across, 120 by 20.
  const data: {position: [number, number]; angle: number}[] = [
    {position: [-150, 0], angle: 0},
    {position: [100, 0], angle: 90}
  ];
  deck = new Deck({
    canvas, device: harness.device, width: 512, height: 320, useDevicePixels: false,
    views: new OrthographicView({id: 'flat'}),
    initialViewState: {target: [0, 0, 0], zoom: 0},
    onError: error => {errors.push(error.message);},
    layers: [new StretchIconLayer<{position: [number, number]; angle: number}>({
      id: 'stretched', data, iconAtlas: createAtlas(),
      iconMapping: {bar: {x: 0, y: 0, width: 8, height: 4}},
      getIcon: () => 'bar', getPosition: d => d.position, getAngle: d => d.angle,
      getSize: 20, sizeUnits: 'pixels', getIconStretch: [3, 1]
    })]
  });
  let bounds: ReturnType<typeof getColorBounds>[] = [];
  await expect.poll(async () => {
    expect(errors).toEqual([]);
    const image = await readCanvasPixels(canvas);
    bounds = [getColorBounds(image, 0, 256), getColorBounds(image, 256, 512)];
    return bounds.every(({red, blue}) => red && blue);
  }, {timeout: 15000, interval: 100}).toBe(true);
  const size = (box: number[] | null) => [box![2] - box![0] + 1, box![3] - box![1] + 1];
  const [flat, turned] = bounds;
  // Unturned, centred at x 106: red is the left 60 pixels, blue the right 60, 20 high.
  for (const [value, expected] of [...size(flat.red), ...size(flat.blue)].map((v, i) => [v, [60, 20, 60, 20][i]])) {
    expect(Math.abs(value - expected)).toBeLessThanOrEqual(2);
  }
  expect(Math.abs(flat.red![0] - 46)).toBeLessThanOrEqual(2);
  // Turned a quarter, counter-clockwise: 20 wide and 120 high, red below blue.
  for (const [value, expected] of [...size(turned.red), ...size(turned.blue)].map((v, i) => [v, [20, 60, 20, 60][i]])) {
    expect(Math.abs(value - expected)).toBeLessThanOrEqual(2);
  }
  expect(turned.red![1]).toBeGreaterThan(turned.blue![1]);
});
