// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {afterEach, beforeEach, expect, test, vi} from 'vitest';
import {createClassicPlaygroundRenderer} from '../examples/classic/app/playground-renderer.js';

/** Create a scene loader with no browser or GPU dependencies. */
function createHarness(onSceneLoaded?: () => void | Promise<void>) {
  const scene = {load: vi.fn(async (_value: object, _options: object) => {}), subscribe: vi.fn(), unsubscribe: vi.fn()};
  const renderer = createClassicPlaygroundRenderer({scene,
    resolveSceneUrl: (name: string) => new URL(name, 'https://example.test/classic/').href, onSceneLoaded});
  const update = (value: object, controller = new AbortController()) => ({
    promise: renderer.update(null, value, '', {signal: controller.signal, templateId: 'styles/tron.yaml'}), controller
  });
  return {scene, renderer, update};
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

test('aborts the debounce and loads only the current document with its import base', async () => {
  const {scene, update} = createHarness();
  const obsolete = update({old: true});
  obsolete.controller.abort();
  const current = update({current: true});
  await vi.advanceTimersByTimeAsync(400);
  await Promise.all([obsolete.promise, current.promise]);
  expect(scene.load).toHaveBeenCalledExactlyOnceWith({current: true}, {base_path: 'https://example.test/classic/styles/'});
});

test('serializes in-flight scene loads and skips cancelled queued updates', async () => {
  const {scene, update} = createHarness();
  let release!: () => void;
  scene.load.mockImplementationOnce(() => new Promise(resolve => {release = resolve;}));
  const first = update({first: true});
  await vi.advanceTimersByTimeAsync(400);
  first.controller.abort();
  const second = update({second: true});
  await vi.advanceTimersByTimeAsync(400);
  second.controller.abort();
  const third = update({third: true});
  await vi.advanceTimersByTimeAsync(400);
  expect(scene.load).toHaveBeenCalledTimes(1);
  release();
  await Promise.all([first.promise, second.promise, third.promise]);
  expect(scene.load.mock.calls.map(([value]) => value)).toEqual([{first: true}, {third: true}]);
});

test('a rejected update does not poison subsequent scene loads', async () => {
  const {scene, update} = createHarness();
  scene.load.mockRejectedValueOnce(new Error('invalid scene'));
  const failing = update({bad: true});
  const rejection = expect(failing.promise).rejects.toThrow('invalid scene');
  await vi.advanceTimersByTimeAsync(400);
  await rejection;
  const corrected = update({good: true});
  await vi.advanceTimersByTimeAsync(400);
  await corrected.promise;
  expect(scene.load).toHaveBeenCalledTimes(2);
});

test('finalization settles the pending update without loading or leaving a timer', async () => {
  const {scene, renderer, update} = createHarness();
  const pending = update({});
  renderer.finalize();
  renderer.finalize();
  await pending.promise;
  await vi.advanceTimersByTimeAsync(400);
  expect(scene.load).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

test('refreshes credits after the accepted scene, not after a superseded in-flight load', async () => {
  const refresh = vi.fn(async () => {});
  const {scene, update} = createHarness(refresh);
  let release!: () => void;
  scene.load.mockImplementationOnce(() => new Promise(resolve => {release = resolve;}));
  const obsolete = update({old: true});
  await vi.advanceTimersByTimeAsync(400);
  obsolete.controller.abort();
  release();
  await obsolete.promise;
  expect(refresh).not.toHaveBeenCalled();
  const current = update({current: true});
  await vi.advanceTimersByTimeAsync(400);
  await current.promise;
  expect(refresh).toHaveBeenCalledExactlyOnceWith();
});

test('finalization settles every overlapping debounce and queued edit', async () => {
  const {scene, renderer, update} = createHarness();
  const first = update({first: true});
  const second = update({second: true});
  renderer.finalize();
  await Promise.all([first.promise, second.promise]);
  expect(vi.getTimerCount()).toBe(0);
  expect(scene.load).not.toHaveBeenCalled();
});

test('a cancelled in-flight rejection does not report errors or block the latest edit', async () => {
  const refresh = vi.fn();
  const {scene, update} = createHarness(refresh);
  let rejectLoad!: (error: Error) => void;
  scene.load.mockImplementationOnce(() => new Promise((_resolve, reject) => {rejectLoad = reject;}));
  const obsolete = update({obsolete: true});
  await vi.advanceTimersByTimeAsync(400);
  obsolete.controller.abort();
  const current = update({current: true});
  await vi.advanceTimersByTimeAsync(400);
  rejectLoad(new Error('Superseded failure'));
  await Promise.all([obsolete.promise, current.promise]);
  expect(scene.load).toHaveBeenCalledTimes(2);
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(scene.unsubscribe).toHaveBeenCalledTimes(2);
});
