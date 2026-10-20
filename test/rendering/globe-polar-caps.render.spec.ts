// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {afterEach, beforeEach, expect, test} from 'vitest';
import {commands} from 'vitest/browser';
import {Deck, _GlobeView as GlobeView} from '@deck.gl/core';
import {TangramLayer} from '@vis.gl/tangram-layers';
import {createBasemapBackground} from '../../examples/deck/basemap-background';
import {createGlobePolarCaps} from '../../examples/deck/globe-polar-caps';
import {RenderingHarness, readCanvasPixels, DEVICE_TYPE} from './harness';

let harness: RenderingHarness | undefined;
let deck: Deck<GlobeView> | undefined;
beforeEach(() => commands.startRenderingDiagnostics());
afterEach(async () => {
  try {expect(harness?.errors ?? []).toEqual([]); expect(await commands.renderingDiagnostics()).toEqual([]);}
  finally {deck?.finalize(); deck = undefined; harness?.destroy(); harness = undefined;}
});

test.each([-80, 80])(`${DEVICE_TYPE}: the %s-degree-facing cap fills the polar hole and hides with the basemap`, async latitude => {
  harness = new RenderingHarness('globe'); await harness.initializeDevice();
  const canvas = harness.canvas;
  let sceneLoaded = false;
  const basemap = new TangramLayer({id: 'polar-basemap', scene: createBasemapBackground('#102030'),
    onSceneLoad: () => {sceneLoaded = true;}, onSceneError: error => harness?.errors.push(error.message)});
  let renderedImage: ImageData | undefined;
  const countCapPixels = async () => {
    const image = await readCanvasPixels(canvas);
    renderedImage = image;
    let count = 0;
    for (let offset = 0; offset < image.data.length; offset += 4) {
      if (image.data[offset] > 220 && image.data[offset + 1] < 30 && image.data[offset + 2] > 220) count++;
    }
    return count;
  };
  deck = new Deck({canvas, device: harness.device, width: 512, height: 320, useDevicePixels: false,
    views: new GlobeView({id: 'polar'}), initialViewState: {longitude: 0, latitude, zoom: 0}, _animate: true,
    onError: error => harness?.errors.push(error.message),
    layers: [basemap, createGlobePolarCaps([255, 0, 255], true)]});
  await expect.poll(() => sceneLoaded, {timeout: 15000}).toBe(true);
  await expect.poll(countCapPixels, {timeout: 15000}).toBeGreaterThan(20);
  const pole = deck.getViewports()[0].project([0, Math.sign(latitude) * 90]);
  // Reuse the successful readback: WebGPU may discard a presented back buffer.
  const image = renderedImage;
  if (!image) throw new Error('Missing cap readback');
  const offset = (Math.floor(pole[1]) * image.width + Math.floor(pole[0])) * 4;
  await commands.saveRenderingArtifact(`polar-${latitude}`, canvas.toDataURL('image/png'));
  expect(Array.from(image.data.slice(offset, offset + 3))).toEqual([255, 0, 255]);
  expect(Array.from(image.data.slice(0, 3))).not.toEqual([255, 0, 255]);
  deck.setProps({layers: [basemap, createGlobePolarCaps([255, 0, 255], false)]});
  await expect.poll(countCapPixels).toBe(0);
});
