// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {afterEach, beforeEach, expect, test, vi} from 'vitest';
import {createSceneEditorController, loadClassicEditorScene} from '../examples/classic/app/scene-editor.js';

/** Controllable asynchronous completion for load-order tests. */
function createDeferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Value>((complete, fail) => {resolve = complete; reject = fail;});
  return {promise, resolve, reject};
}

/** Construct a controller with deterministic example-local dependencies. */
function createHarness() {
  const options = {
    initialScene: 'styles/first.yaml',
    initialSource: '{"scene":{"first":true}}',
    fetchSource: vi.fn(async (_url: string, _signal: AbortSignal) => '{"scene":{"second":true}}'),
    formatSource: (source: string) => JSON.stringify(JSON.parse(source), null, 2),
    parseSource: vi.fn((source: string) => JSON.parse(source)),
    loadScene: vi.fn(async (_config: string | object, _options?: {base_path: string}) => {}),
    resolveSceneUrl: (url: string) => new URL(url, 'https://example.test/tangram.gl/examples/classic/').href,
    onDocumentChange: vi.fn(),
    onSceneSelected: vi.fn()
  };
  return {...options, controller: createSceneEditorController(options)};
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

test('replaces the controlled text after the selected renderer and source both finish loading', async () => {
  const harness = createHarness();
  const source = createDeferred<string>();
  harness.fetchSource.mockReturnValue(source.promise);
  const selecting = harness.controller.selectScene('styles/second.yaml');
  expect(harness.onDocumentChange).toHaveBeenLastCalledWith(expect.objectContaining({status: 'loading', readOnly: true}));
  source.resolve('{"scene":{"second":true}}');
  await selecting;
  expect(harness.onDocumentChange).toHaveBeenLastCalledWith({
    source: '{\n  "scene": {\n    "second": true\n  }\n}', status: 'ready', message: '', readOnly: false
  });
  expect(harness.loadScene).toHaveBeenCalledWith('https://example.test/tangram.gl/examples/classic/styles/second.yaml', undefined);
});

test('aborts obsolete source requests and ignores late responses', async () => {
  const harness = createHarness();
  const oldSource = createDeferred<string>();
  harness.fetchSource.mockReturnValueOnce(oldSource.promise);
  const previous = harness.controller.selectScene('styles/old.yaml');
  const previousSignal = harness.fetchSource.mock.calls[0][1];
  await harness.controller.selectScene('styles/current.yaml');
  const latest = harness.onDocumentChange.mock.lastCall;
  expect(previousSignal.aborted).toBe(true);
  oldSource.resolve('{"obsolete":true}');
  await previous;
  expect(harness.onDocumentChange.mock.lastCall).toBe(latest);
});

test('serializes renderer loads and skips obsolete queued selections', async () => {
  const harness = createHarness();
  const loading = createDeferred<void>();
  harness.loadScene.mockReturnValueOnce(loading.promise);
  const first = harness.controller.selectScene('styles/one.yaml');
  await Promise.resolve();
  const second = harness.controller.selectScene('styles/two.yaml');
  const third = harness.controller.selectScene('styles/three.yaml');
  expect(harness.loadScene).toHaveBeenCalledTimes(1);
  loading.resolve();
  await Promise.all([first, second, third]);
  expect(harness.loadScene.mock.calls.map(([url]) => url)).toEqual([
    'https://example.test/tangram.gl/examples/classic/styles/one.yaml',
    'https://example.test/tangram.gl/examples/classic/styles/three.yaml'
  ]);
});

test('debounces edits and retains the selected document base path', async () => {
  const harness = createHarness();
  harness.controller.editSource('{"value":1}');
  await vi.advanceTimersByTimeAsync(200);
  harness.controller.editSource('{"value":2}');
  await vi.advanceTimersByTimeAsync(399);
  expect(harness.loadScene).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(harness.loadScene).toHaveBeenCalledExactlyOnceWith({value: 2}, {
    base_path: 'https://example.test/tangram.gl/examples/classic/styles/'
  });
  expect(harness.onDocumentChange).toHaveBeenLastCalledWith(expect.objectContaining({status: 'applied'}));
});

test('cancels a pending edit on style selection and blocks edits to stale loading text', async () => {
  const harness = createHarness();
  const source = createDeferred<string>();
  harness.fetchSource.mockReturnValue(source.promise);
  harness.controller.editSource('{"obsolete":true}');
  const selecting = harness.controller.selectScene('styles/new.yaml');
  harness.controller.editSource('{"alsoObsolete":true}');
  await vi.advanceTimersByTimeAsync(400);
  expect(harness.parseSource).not.toHaveBeenCalled();
  source.resolve('{}');
  await selecting;
  expect(harness.onDocumentChange).toHaveBeenLastCalledWith(expect.objectContaining({source: '{}', readOnly: false}));
});

test('reports parse failures without sending invalid text to the renderer', async () => {
  const harness = createHarness();
  harness.controller.editSource('{');
  await vi.advanceTimersByTimeAsync(400);
  expect(harness.loadScene).not.toHaveBeenCalled();
  expect(harness.onDocumentChange).toHaveBeenLastCalledWith(expect.objectContaining({status: 'error', readOnly: false}));
});

test('awaits asynchronous renderer failures and permits a corrected edit', async () => {
  const harness = createHarness();
  harness.loadScene.mockRejectedValueOnce(new Error('shader failed'));
  harness.controller.editSource('{"invalid":true}');
  await vi.advanceTimersByTimeAsync(400);
  expect(harness.onDocumentChange).toHaveBeenLastCalledWith(expect.objectContaining({status: 'error', message: 'shader failed'}));
  harness.controller.editSource('{}');
  await vi.advanceTimersByTimeAsync(400);
  expect(harness.onDocumentChange).toHaveBeenLastCalledWith(expect.objectContaining({status: 'applied', message: ''}));
});

test('a failed source load remains read-only until another style is selected', async () => {
  const harness = createHarness();
  harness.fetchSource.mockRejectedValueOnce(new Error('HTTP 404'));
  await harness.controller.selectScene('styles/missing.yaml');
  expect(harness.onDocumentChange).toHaveBeenLastCalledWith(expect.objectContaining({status: 'error', message: 'HTTP 404', readOnly: true}));
  harness.controller.editSource('{}');
  await vi.advanceTimersByTimeAsync(400);
  expect(harness.parseSource).not.toHaveBeenCalled();
  await harness.controller.selectScene('styles/recovered.yaml');
  expect(harness.onDocumentChange).toHaveBeenLastCalledWith(expect.objectContaining({status: 'ready', readOnly: false}));
});

test('an older successful edit cannot mark newer pending text as applied', async () => {
  const harness = createHarness();
  const loading = createDeferred<void>();
  harness.loadScene.mockReturnValueOnce(loading.promise);
  harness.controller.editSource('{"old":true}');
  await vi.advanceTimersByTimeAsync(400);
  harness.controller.editSource('{"new":true}');
  loading.resolve();
  await Promise.resolve();
  expect(harness.onDocumentChange).toHaveBeenLastCalledWith(expect.objectContaining({source: '{"new":true}', status: 'editing'}));
  await vi.advanceTimersByTimeAsync(400);
  expect(harness.onDocumentChange).toHaveBeenLastCalledWith(expect.objectContaining({source: '{"new":true}', status: 'applied'}));
});

test('teardown cancels timers and late fetches and is idempotent', async () => {
  const harness = createHarness();
  harness.controller.editSource('{}');
  harness.controller.dispose();
  harness.controller.dispose();
  await vi.advanceTimersByTimeAsync(400);
  expect(harness.loadScene).not.toHaveBeenCalled();
  harness.controller.editSource('{}');
  await harness.controller.selectScene('styles/ignored.yaml');
  expect(harness.fetchSource).not.toHaveBeenCalled();

  const selectingHarness = createHarness();
  const source = createDeferred<string>();
  selectingHarness.fetchSource.mockReturnValue(source.promise);
  const selecting = selectingHarness.controller.selectScene('styles/late.yaml');
  selectingHarness.controller.dispose();
  expect(selectingHarness.fetchSource.mock.calls[0][1].aborted).toBe(true);
  const before = selectingHarness.onDocumentChange.mock.calls.length;
  source.resolve('{}');
  await selecting;
  expect(selectingHarness.onDocumentChange).toHaveBeenCalledTimes(before);
});

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

test('teardown ignores an in-flight renderer rejection and does not publish a late editor error', async () => {
  const harness = createHarness();
  const loading = createDeferred<void>();
  harness.loadScene.mockReturnValueOnce(loading.promise);
  harness.controller.editSource('{}');
  await vi.advanceTimersByTimeAsync(400);
  harness.controller.dispose();
  const before = harness.onDocumentChange.mock.calls.length;
  loading.reject(new Error('renderer destroyed'));
  await vi.advanceTimersByTimeAsync(0);
  expect(harness.onDocumentChange).toHaveBeenCalledTimes(before);
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

test('keeps an accepted style selected and editable after a recoverable import error', async () => {
  let listener: {error: (event: {type: string; error: Error}) => void};
  const scene = {
    subscribe: vi.fn(next => {listener = next;}), unsubscribe: vi.fn(),
    load: vi.fn(async () => {
      listener.error({type: 'scene_import', error: new Error('unavailable nested import')});
    })
  };
  const harness = createHarness();
  harness.loadScene.mockImplementation((config, options) => loadClassicEditorScene(scene, config, options, () => false));
  await harness.controller.selectScene('styles/second.yaml');
  expect(harness.onDocumentChange).toHaveBeenLastCalledWith({
    source: '{\n  "scene": {\n    "second": true\n  }\n}', status: 'ready', message: '', readOnly: false
  });
  expect(scene.unsubscribe).toHaveBeenCalledWith(listener!);

  harness.controller.editSource('{"edited":true}');
  await vi.advanceTimersByTimeAsync(400);
  expect(scene.load).toHaveBeenLastCalledWith({edited: true}, {
    base_path: 'https://example.test/tangram.gl/examples/classic/styles/'
  });
  expect(harness.onDocumentChange).toHaveBeenLastCalledWith(expect.objectContaining({status: 'applied', readOnly: false}));
  expect(scene.unsubscribe).toHaveBeenCalledTimes(2);
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
