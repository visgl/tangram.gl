// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test, vi} from 'vitest';
import {loadClassicEditorScene} from '../examples/classic/app/scene-editor.js';

/** Controllable asynchronous completion for renderer-startup tests. */
function createDeferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>(complete => {resolve = complete;});
  return {promise, resolve};
}

test('waits for renderer startup before issuing a new scene load', async () => {
  const initial = createDeferred<void>();
  const scene = {initializing: initial.promise, load: vi.fn(async () => {}), subscribe: vi.fn(), unsubscribe: vi.fn()};
  const loading = loadClassicEditorScene(scene, {}, undefined, () => false);
  expect(scene.load).not.toHaveBeenCalled();
  initial.resolve();
  await loading;
  expect(scene.load).toHaveBeenCalledExactlyOnceWith({}, undefined);
  expect(scene.unsubscribe).toHaveBeenCalledWith(scene.subscribe.mock.calls[0][0]);
});


test.each([undefined, 'yaml'])('reports root error-and-revert events of type %s even when Scene.load resolves', async type => {
  let listener: {error: (event: {type?: string; error: Error}) => void};
  const scene = {
    subscribe: vi.fn(next => {listener = next;}), unsubscribe: vi.fn(),
    load: vi.fn(async () => {
      listener.error({type, error: new Error('reverted scene')});
      listener.error({type: 'scene_import', error: new Error('unavailable fallback import')});
    })
  };
  await expect(loadClassicEditorScene(scene, {}, undefined, () => false)).rejects.toThrow('reverted scene');
  expect(scene.unsubscribe).toHaveBeenCalledWith(listener!);
});


test('does not load after disposal while waiting for renderer startup', async () => {
  const initial = createDeferred<void>();
  const scene = {initializing: initial.promise, load: vi.fn(), subscribe: vi.fn()};
  const loading = loadClassicEditorScene(scene, {}, undefined, () => true);
  initial.resolve();
  await loading;
  expect(scene.load).not.toHaveBeenCalled();
  expect(scene.subscribe).not.toHaveBeenCalled();
});
test('recoverable import failures do not reject an accepted scene', async () => {
  let listener!: {error: (event: {type: string; error: Error}) => void};
  const scene = {
    subscribe: vi.fn(next => {listener = next;}), unsubscribe: vi.fn(),
    load: vi.fn(async () => {listener.error({type: 'scene_import', error: new Error('unavailable nested import')});})
  };
  await expect(loadClassicEditorScene(scene, {}, undefined, () => false)).resolves.toBeUndefined();
  expect(scene.unsubscribe).toHaveBeenCalledWith(listener);
});

test('does not report error-and-revert events after an edit becomes obsolete', async () => {
  let obsolete = false;
  let listener!: {error: (event: {type: string; error: Error}) => void};
  const scene = {
    subscribe: vi.fn(next => {listener = next;}), unsubscribe: vi.fn(),
    load: vi.fn(async () => {
      obsolete = true;
      listener.error({type: 'yaml', error: new Error('Obsolete parse error')});
    })
  };
  await expect(loadClassicEditorScene(scene, {}, undefined, () => obsolete)).resolves.toBeUndefined();
  expect(scene.unsubscribe).toHaveBeenCalledWith(listener);
});

test.each([false, true])('startup rejection is suppressed only for an obsolete edit (%s)', async obsolete => {
  const scene = {initializing: Promise.reject(new Error('Startup failed')), load: vi.fn(), subscribe: vi.fn()};
  const loading = loadClassicEditorScene(scene, {}, undefined, () => obsolete);
  if (obsolete) await expect(loading).resolves.toBeUndefined();
  else await expect(loading).rejects.toThrow('Startup failed');
  expect(scene.load).not.toHaveBeenCalled();
  expect(scene.subscribe).not.toHaveBeenCalled();
});
