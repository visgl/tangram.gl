// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test, vi} from 'vitest';
import {Buffer, type Device, type Texture} from '@luma.gl/core';
import {readDevicePixels} from '../src/gpu/pixel_readback';
import {findSelectionKey, readSelectionPixels} from '../src/selection/selection_pixels';

/** Minimal public-resource doubles, with no native handles or GL context. */
function createReadback(type = 'webgl', bytes = new Uint8Array([7, 0, 0, 1])) {
  const staging = {readAsync: vi.fn(async () => bytes), destroy: vi.fn()};
  const commands = {};
  const encoder = {copyTextureToBuffer: vi.fn(), finish: vi.fn(() => commands), destroy: vi.fn()};
  const device = {type, createBuffer: vi.fn(() => staging),
    createCommandEncoder: vi.fn(() => encoder), submit: vi.fn()};
  const texture = {format: 'rgba8unorm', dimension: '2d', samples: 1, width: 4, height: 4};
  return {device: device as unknown as Device, texture: texture as unknown as Texture,
    staging, encoder, commands, mocks: device};
}

test.each(['webgl', 'webgpu'])('%s: packs multiple native rows and owns only staging resources', async type => {
  const stride = type === 'webgpu' ? 256 : 12;
  const bytes = new Uint8Array(stride * 2).fill(255);
  bytes.set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  bytes.set([13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24], stride);
  const fixture = createReadback(type, bytes);
  const pixels = await readDevicePixels(fixture.device, fixture.texture, {x: 1, y: 2, width: 3, height: 2});
  expect([...pixels]).toEqual(Array.from({length: 24}, (_, index) => index + 1));
  expect(fixture.mocks.createBuffer).toHaveBeenCalledWith({id: 'tangram-pixel-readback',
    byteLength: stride * 2, usage: Buffer.COPY_DST | Buffer.MAP_READ});
  expect(fixture.encoder.copyTextureToBuffer).toHaveBeenCalledWith({sourceTexture: fixture.texture,
    destinationBuffer: fixture.staging, origin: [1, 2, 0], width: 3, height: 2,
    ...(type === 'webgpu' ? {bytesPerRow: 256, rowsPerImage: 2} : {})});
  expect(fixture.mocks.submit).toHaveBeenCalledWith(fixture.commands);
  expect(fixture.staging.destroy).toHaveBeenCalledTimes(1);
  expect(fixture.encoder.destroy).not.toHaveBeenCalled(); // finish owns encoder disposal.
  bytes.fill(0);
  expect(pixels[0]).toBe(1); // Returned storage survives resource release/reuse.
});

test.each(['createEncoder', 'copy', 'finish', 'submit', 'read', 'truncated'])('%s failure releases staging', async phase => {
  const fixture = createReadback();
  const fail = () => { throw new Error(phase); };
  if (phase === 'createEncoder') fixture.mocks.createCommandEncoder.mockImplementation(fail);
  if (phase === 'copy') fixture.encoder.copyTextureToBuffer.mockImplementation(fail);
  if (phase === 'finish') fixture.encoder.finish.mockImplementation(fail);
  if (phase === 'submit') fixture.mocks.submit.mockImplementation(fail);
  if (phase === 'read') fixture.staging.readAsync.mockRejectedValue(new Error(phase));
  if (phase === 'truncated') fixture.staging.readAsync.mockResolvedValue(new Uint8Array(3));
  await expect(readDevicePixels(fixture.device, fixture.texture, {x: 0, y: 0, width: 1, height: 1})).rejects.toThrow();
  expect(fixture.staging.destroy).toHaveBeenCalledTimes(1);
  expect(fixture.encoder.destroy).toHaveBeenCalledTimes(['copy', 'finish'].includes(phase) ? 1 : 0);
});

test.each([
  {x: -1, y: 0, width: 1, height: 1}, {x: 0, y: 0, width: 0, height: 1},
  {x: 3, y: 0, width: 2, height: 1}, {x: 0, y: 4, width: 1, height: 1},
  {x: 0.5, y: 0, width: 1, height: 1}, {x: 0, y: NaN, width: 1, height: 1}
])('invalid rectangle %j allocates nothing', async rectangle => {
  const fixture = createReadback();
  await expect(readDevicePixels(fixture.device, fixture.texture, rectangle)).rejects.toThrow('rectangle');
  expect(fixture.mocks.createBuffer).not.toHaveBeenCalled();
});

test.each([{format: 'r8unorm'}, {dimension: '3d'}, {samples: 4}])('unsupported texture %j allocates nothing', async properties => {
  const fixture = createReadback();
  Object.assign(fixture.texture, properties);
  await expect(readDevicePixels(fixture.device, fixture.texture, {x: 0, y: 0, width: 1, height: 1})).rejects.toThrow('rgba8unorm');
  expect(fixture.mocks.createBuffer).not.toHaveBeenCalled();
});

test('selection clips the GPU copy but retains the requested radius and transparent edge padding', async () => {
  const fixture = createReadback();
  const result = await readSelectionPixels(fixture.device, fixture.texture, {x: 0, y: 1}, {x: 0.25, y: 0.25});
  expect(result.width).toBe(2);
  expect(result.height).toBe(2);
  expect([...result.pixels]).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 7, 0, 0, 1]);
  expect(fixture.encoder.copyTextureToBuffer).toHaveBeenCalledWith(expect.objectContaining({
    origin: [0, 0, 0], width: 1, height: 1
  }));
  expect(findSelectionKey(result.pixels, 2, 2)).toEqual({key: 16777223, workerId: 1});
});

test.each([{x: 1, y: 0.5}, {x: 0.5, y: 0}])('an outside edge pixel %j is empty without an invalid GPU copy', async point => {
  const fixture = createReadback();
  const result = await readSelectionPixels(fixture.device, fixture.texture, point);
  expect([...result.pixels]).toEqual([0, 0, 0, 0]);
  expect(fixture.mocks.createBuffer).not.toHaveBeenCalled();
});

test('zero radius is empty; invalid radius and non-finite coordinates reject before copying', async () => {
  const fixture = createReadback();
  expect(await readSelectionPixels(fixture.device, fixture.texture, {x: 0.5, y: 0.5}, {x: 0, y: 0}))
    .toEqual({pixels: new Uint8Array(), width: 0, height: 0});
  for (const radius of [{x: -1, y: 1}, {x: Infinity, y: 1}, {x: 1, y: NaN}]) {
    await expect(readSelectionPixels(fixture.device, fixture.texture, {x: 0.5, y: 0.5}, radius)).rejects.toThrow('radius');
  }
  await expect(readSelectionPixels(fixture.device, fixture.texture, {x: NaN, y: 0})).rejects.toThrow('finite');
  expect(fixture.mocks.createBuffer).not.toHaveBeenCalled();
});

test('selection keys preserve unsigned worker IDs, center preference and nearest-hit tie order', () => {
  expect(findSelectionKey(new Uint8Array([7, 2, 3, 200]), 1, 1)).toEqual({key: 3355640327, workerId: 200});
  expect(findSelectionKey(new Uint8Array([0, 0, 0, 255]), 1, 1)).toBeNull();
  expect(findSelectionKey(new Uint8Array([1, 0, 0, 255]), 1, 1)?.workerId).toBe(255);
  expect(findSelectionKey(new Uint8Array(), 0, 0)).toBeNull();
  const pixels = new Uint8Array(4 * 4 * 4);
  pixels.set([1, 0, 0, 1], (2 * 4 + 1) * 4);
  pixels.set([2, 0, 0, 1], (1 * 4 + 2) * 4);
  expect(findSelectionKey(pixels, 4, 4)?.key).toBe(16777217); // Later scan wins equal distance.
  pixels.set([3, 0, 0, 1], (2 * 4 + 2) * 4);
  expect(findSelectionKey(pixels, 4, 4)?.key).toBe(16777219);
});
