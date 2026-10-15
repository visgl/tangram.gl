// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {afterEach, beforeEach, expect, test, vi} from 'vitest';
import {luma} from '@luma.gl/core';
import {initializeWebXRExample} from '../examples/webxr/app.js';

const mocks = {createDevice: vi.fn()};

const teardowns: (() => void)[] = [];
const hosts: HTMLElement[] = [];

/** Install only the DOM owned by the example, without starting GPU or network work. */
function createHost(): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = `<div id="webxr-container"><canvas id="webxr-canvas"></canvas>
    <aside class="webxr-panel"><h1 id="webxr-title"></h1></aside>
    <p id="webxr-status"></p><p id="attribution"></p>
    <details id="webxr-stereo-settings"></details>
    <button id="webxr-enter"></button><button id="webxr-exit"></button>
    <button id="webxr-mono"></button><button id="webxr-stereo"></button></div>`;
  document.body.append(host);
  hosts.push(host);
  return host;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(luma, 'createDevice').mockImplementation(mocks.createDevice);
});
afterEach(() => {
  teardowns.splice(0).forEach(destroy => destroy());
  hosts.splice(0).forEach(host => host.remove());
  vi.restoreAllMocks();
});

test('importing the cached WebXR module does not initialize a device', () => {
  expect(mocks.createDevice).not.toHaveBeenCalled();
  expect(document.getElementById('webxr-container')).toBeNull();
});

test('unmount releases a late device without starting a renderer or overwriting the next route', async () => {
  let finishDevice: (device: {destroy: () => void}) => void = () => {};
  mocks.createDevice.mockImplementationOnce(() => new Promise(resolve => {finishDevice = resolve;}));
  const firstHost = createHost();
  const firstDestroy = initializeWebXRExample();
  teardowns.push(firstDestroy);
  await expect.poll(() => mocks.createDevice.mock.calls.length, {
    message: firstHost.querySelector('#webxr-status')?.textContent || 'Device was not requested'
  }).toBe(1);
  firstDestroy();
  firstDestroy();
  expect(firstHost.querySelector('.webxr-stereo-controls')).toBeNull();
  firstHost.remove();

  const secondHost = createHost();
  mocks.createDevice.mockImplementationOnce(() => new Promise(() => {}));
  const secondDestroy = initializeWebXRExample();
  teardowns.push(secondDestroy);
  const status = secondHost.querySelector('#webxr-status')?.textContent;
  const destroyDevice = vi.fn();
  finishDevice({destroy: destroyDevice});
  await expect.poll(() => destroyDevice.mock.calls.length).toBe(1);
  expect(secondHost.querySelector('#webxr-status')?.textContent).toBe(status);
  expect(secondHost.querySelectorAll('.webxr-stereo-controls')).toHaveLength(1);
  expect(mocks.createDevice).toHaveBeenCalledTimes(2);
  secondDestroy();
  expect(secondHost.querySelector('.webxr-stereo-controls')).toBeNull();
});

test('rejected device initialization after unmount does not mutate another mount', async () => {
  let rejectDevice: (error: Error) => void = () => {};
  mocks.createDevice.mockImplementationOnce(() => new Promise((_resolve, reject) => {rejectDevice = reject;}));
  const host = createHost();
  const destroy = initializeWebXRExample();
  teardowns.push(destroy);
  destroy();
  const status = host.querySelector('#webxr-status')?.textContent;
  rejectDevice(new Error('A detached device failed'));
  await Promise.resolve();
  await Promise.resolve();
  expect(host.querySelector('#webxr-status')?.textContent).toBe(status);
});

test('remounting the cached runtime on the same DOM does not duplicate input listeners', () => {
  mocks.createDevice.mockImplementation(() => new Promise(() => {}));
  const host = createHost();
  const canvas = host.querySelector('canvas');
  if (!canvas) throw new Error('Missing canvas');
  const focus = vi.spyOn(canvas, 'focus');
  const firstDestroy = initializeWebXRExample();
  teardowns.push(firstDestroy);
  firstDestroy();
  canvas.dispatchEvent(new PointerEvent('pointerdown'));
  expect(focus).not.toHaveBeenCalled();
  const secondDestroy = initializeWebXRExample();
  teardowns.push(secondDestroy);
  canvas.dispatchEvent(new PointerEvent('pointerdown'));
  expect(focus).toHaveBeenCalledOnce();
  expect(host.querySelectorAll('.webxr-stereo-controls')).toHaveLength(1);
});
