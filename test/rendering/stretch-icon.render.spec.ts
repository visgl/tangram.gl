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

/**
 * The bounds `[x1, y1, x2, y2]` of the icon pixels (red, blue, or a blend of the two) in columns
 * `[start, end)`, or null where there are none.
 */
function getIconBounds(image: ImageData, start: number, end: number): number[] | null {
  let box: number[] | null = null;
  for (let y = 0; y < image.height; y++) {
    for (let x = start; x < end; x++) {
      const offset = (y * image.width + x) * 4;
      const [r, g, b] = image.data.subarray(offset, offset + 3);
      if (r + b > 200 && g < 60) {
        box = box ? [Math.min(box[0], x), Math.min(box[1], y), Math.max(box[2], x), Math.max(box[3], y)]
          : [x, y, x, y];
      }
    }
  }
  return box;
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
  let bounds: (number[] | null)[] = [];
  await expect.poll(async () => {
    expect(errors).toEqual([]);
    const image = await readCanvasPixels(canvas);
    bounds = [getIconBounds(image, 0, 256), getIconBounds(image, 256, 512)];
    return bounds.every(Boolean);
  }, {timeout: 15000, interval: 100}).toBe(true);
  const [flat, turned] = bounds as number[][];
  const expectBox = (box: number[], [x1, y1, x2, y2]: number[]) =>
    box.forEach((value, index) => expect(Math.abs(value - [x1, y1, x2, y2][index])).toBeLessThanOrEqual(1));
  // Unturned, centred on (106, 160): 120 by 20 pixels. Unstretched, it would be 40 by 20.
  expectBox(flat, [46, 150, 165, 169]);
  // Turned a quarter, centred on (356, 160): 20 by 120 pixels, the stretch turned with it.
  expectBox(turned, [346, 100, 365, 219]);
});
