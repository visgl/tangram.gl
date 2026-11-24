// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {commands} from 'vitest/browser';
import {expect, test} from 'vitest';
import {Deck, FirstPersonView} from '@deck.gl/core';
import {webgl2Adapter} from '@luma.gl/core/webgl';
import {webgpuAdapter} from '@luma.gl/core/webgpu';
import {BasemapLayer} from '@tangram.gl/basemap-layers';
import {defineBackendPaintTests} from '../../modules/basemap-layers/test/backend-paint-tests';
import {defineFillStyleTests} from '../../modules/basemap-layers/test/fill-style-tests';
import {defineTranslateTests} from '../../modules/basemap-layers/test/translate-tests';
import {RenderingHarness, readCanvasPixels} from './harness';

declare const __TEST_DEVICE__: 'webgl' | 'webgpu';

// The paint properties that `BasemapLayer` draws with its own shader code, on the backend of the
// test lane (see `vitest.rendering.config.ts`), against MapLibre GL JS's formulas.
const options = {
  deviceType: __TEST_DEVICE__,
  adapters: [webgl2Adapter, webgpuAdapter],
  saveFrame: (name: string, image: string) => commands.saveRenderingArtifact(name, image)
};
defineBackendPaintTests(options);
defineFillStyleTests(options);
defineTranslateTests(options);

test(`${__TEST_DEVICE__}: viewport-pitched road text billboards and follows the line in FirstPersonView`, async () => {
  const harness = new RenderingHarness('first-person');
  await harness.initializeDevice();
  const {canvas, device, errors} = harness;
  const camera = {longitude: -122.4194, latitude: 37.7749, bearing: 0};
  const atPitch = (pitch: number) => {
    const radians = pitch * Math.PI / 180;
    return {...camera, pitch, position: [0, -600 * Math.cos(radians), 600 * Math.sin(radians)] as [number, number, number]};
  };
  const geometry = {type: 'FeatureCollection' as const, features: [{
    type: 'Feature' as const, properties: {},
    geometry: {type: 'LineString' as const, coordinates: [
      [camera.longitude - 0.001, camera.latitude],
      [camera.longitude + 0.001, camera.latitude]
    ]}
  }]};
  const deck = new Deck({
    canvas, device, width: 512, height: 320, useDevicePixels: false,
    views: new FirstPersonView({fovy: 45, near: 0.1, far: 20000}),
    viewState: atPitch(28),
    layers: [new BasemapLayer({id: 'road-label', fontFamily: 'sans-serif', labelFadeDuration: 0, style: {
      version: 8, sources: {road: {type: 'geojson', data: geometry}}, layers: [{
        id: 'label', type: 'symbol', source: 'road',
        layout: {'symbol-placement': 'line-center', 'text-field': 'ROAD', 'text-size': 32,
          'text-rotation-alignment': 'map', 'text-pitch-alignment': 'viewport',
          'text-allow-overlap': true},
        paint: {'text-color': '#ffffff'}
      }]
    }})],
    onError: error => {errors.push(error.message);}
  });
  const readBounds = async () => {
    const {data, width, height} = await readCanvasPixels(canvas);
    let left = width, right = -1, top = height, bottom = -1;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const index = (y * width + x) * 4;
      if (data[index] > 180 && data[index + 3] > 180) {
        left = Math.min(left, x); right = Math.max(right, x);
        top = Math.min(top, y); bottom = Math.max(bottom, y);
      }
    }
    return {width: right - left + 1, height: bottom - top + 1};
  };
  try {
    await expect.poll(async () => {expect(errors).toEqual([]); return (await readBounds()).height;}, {timeout: 8000}).toBeGreaterThan(17);
    const tilted = await readBounds();
    expect(tilted.width).toBeGreaterThan(tilted.height * 2);
    const {position} = atPitch(28);
    deck.setProps({viewState: {...atPitch(28), position: [position[0], position[1] + 220, position[2]]}});
    await expect.poll(async () => (await readBounds()).height, {timeout: 6000}).toBeGreaterThan(tilted.height * 1.12);
    deck.setProps({viewState: {...atPitch(28), position: [position[0], position[1] - 220, position[2]]}});
    await expect.poll(async () => {
      const {height} = await readBounds();
      return height > 12 && height < tilted.height * 0.96;
    }, {timeout: 6000}).toBe(true);
    deck.setProps({viewState: atPitch(75)});
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    await expect.poll(async () => Math.abs((await readBounds()).height - tilted.height), {timeout: 6000}).toBeLessThanOrEqual(2);
    deck.setProps({viewState: {...atPitch(75), bearing: 40}});
    await expect.poll(async () => (await readBounds()).height, {timeout: 6000}).toBeGreaterThan(tilted.height * 1.6);
    expect(errors).toEqual([]);
  } finally {
    deck.finalize();
    harness.destroy();
  }
});
