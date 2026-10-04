// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test} from 'vitest';
import {Texture} from '@luma.gl/core';
import {readDevicePixels} from '../../modules/tangram-renderer/src/gpu/pixel_readback';
import {DEVICE_TYPE, RenderingHarness} from './harness';

test(`${DEVICE_TYPE}: public texture copy preserves RGBA, subrectangles and native row order`, async () => {
  const harness = new RenderingHarness();
  await harness.initializeDevice();
  const bytes = Uint8Array.from({length: 24}, (_, index) => index + 1);
  const texture = harness.device.createTexture({width: 3, height: 2, format: 'rgba8unorm',
    usage: Texture.COPY_SRC | Texture.COPY_DST | Texture.SAMPLE, data: bytes});
  try {
    expect(await readDevicePixels(harness.device, texture, {x: 0, y: 0, width: 3, height: 2})).toEqual(bytes);
    expect(await readDevicePixels(harness.device, texture, {x: 1, y: 1, width: 2, height: 1})).toEqual(bytes.slice(16));
    expect(harness.errors).toEqual([]);
  } finally {
    texture.destroy();
    harness.destroy();
  }
});

test(`${DEVICE_TYPE}: reads a rendered attachment without accessing native handles`, async () => {
  const harness = new RenderingHarness();
  await harness.initializeDevice();
  const texture = harness.device.createTexture({width: 3, height: 2, format: 'rgba8unorm',
    usage: Texture.COPY_SRC | Texture.RENDER_ATTACHMENT});
  const framebuffer = harness.device.createFramebuffer({width: 3, height: 2, colorAttachments: [texture]});
  try {
    const pass = harness.device.beginRenderPass({framebuffer, clearColor: [17 / 255, 34 / 255, 51 / 255, 1]});
    pass.end();
    harness.device.submit();
    const pixels = await readDevicePixels(harness.device, texture, {x: 0, y: 0, width: 3, height: 2});
    expect([...pixels]).toEqual(Array.from({length: 6}, () => [17, 34, 51, 255]).flat());
    expect(harness.errors).toEqual([]);
  } finally {
    framebuffer.destroy();
    texture.destroy();
    harness.destroy();
  }
});
