// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {afterAll, afterEach, beforeEach, expect, test, vi} from 'vitest';
import * as panels from '@deck.gl-community/panels';
import * as monaco from 'monaco-editor';
import {createMonacoEnvironment} from '../examples/classic/app/monaco-workers.js';
import {startSettingsPanel} from '../examples/classic/app/settings-panel-runtime.js';

const runtime = globalThis as typeof globalThis & {tangramClassicSettingsCleanup?: (() => void) | null};
const modelUri = monaco.Uri.parse('inmemory://deck-gl-community/panels/tangram-scene-editor');
const workers: Worker[] = [];
let frame: HTMLDivElement;
let originalUrl: string;
let sourceRequest: ((signal: AbortSignal) => Promise<Response>) | undefined;
const loadScene = vi.fn(async (_config: string | object, _options?: {base_path: string}) => {});
const setView = vi.fn();

beforeEach(() => {
  originalUrl = window.location.href;
  frame = document.createElement('div');
  frame.id = 'classic-playground-frame';
  frame.style.cssText = 'position:relative;width:1100px;height:650px';
  document.body.append(frame);
  const factory = createMonacoEnvironment(new URL('/examples/classic/dist/', window.location.href).href);
  vi.stubGlobal('MonacoEnvironment', {
    getWorker(id: string, label: string) {
      const worker = factory.getWorker(id, label);
      workers.push(worker);
      return worker;
    }
  });
  loadScene.mockClear();
  setView.mockClear();
  vi.stubGlobal('map', {setView});
  sourceRequest = undefined;
  vi.stubGlobal('scene', {
    load: loadScene, subscribe: vi.fn(), unsubscribe: vi.fn(), config: {},
    setActiveCamera: vi.fn(), setIntrospection: vi.fn()
  });
  vi.stubGlobal('layer', {});
  vi.stubGlobal('Tangram', {debug: {yaml: {safeLoad: JSON.parse}}});
  vi.stubGlobal('tangramClassicEmbedded', true);
  vi.stubGlobal('tangramClassicScene', 'styles/tron.yaml');
  vi.stubGlobal('tangramClassicBaseUrl', new URL('/examples/classic/', window.location.href).href);
  vi.stubGlobal('tangramStyleSchemaUrl', 'https://example.test/schema.json');
  vi.stubGlobal('tangramUpdateCartoBasemap', vi.fn());
  const fetchOriginal = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, options) => {
    const url = String(input);
    if (url === 'https://example.test/schema.json') return Promise.resolve(Response.json({type: 'object'}));
    if (url.includes('/examples/classic/styles/')) {
      if (sourceRequest) return sourceRequest(options?.signal as AbortSignal);
      const style = url.includes('crosshatch') ? 'crosshatch' : 'tron';
      return Promise.resolve(Response.json({scene: {style}}));
    }
    return fetchOriginal(input, options);
  });
});

afterEach(async () => {
  runtime.tangramClassicSettingsCleanup?.();
  await expect.poll(() => monaco.editor.getModel(modelUri), {timeout: 10000}).toBeNull();
  frame.remove();
  window.history.replaceState(null, '', originalUrl);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

afterAll(() => {for (const worker of workers.splice(0)) worker.terminate();});

/** Mount the production composition with the real community panels and wait for its model. */
async function mountPanels() {
  await startSettingsPanel(panels);
  const model = await vi.waitFor(() => {
    const model = monaco.editor.getModel(modelUri);
    expect(model).not.toBeNull();
    return model!;
  }, {timeout: 15000});
  // The tests exercise controlled text and lifecycle, not Monaco's unrelated
  // word-highlighter provider, whose pending Delayer rejects on immediate disposal.
  for (const editor of monaco.editor.getEditors()) editor.updateOptions({occurrencesHighlight: 'off'});
  return model;
}

test('selecting a style updates the actual nested community editor without replacing its model', async () => {
  const model = await mountPanels();
  expect(JSON.parse(model.getValue())).toEqual({scene: {style: 'tron'}});
  const editorElement = frame.querySelector('.monaco-editor');
  expect(editorElement).not.toBeNull();
  const selector = frame.querySelector<HTMLButtonElement>('[aria-haspopup="listbox"]')!;
  selector.click();
  const option = await vi.waitFor(() => {
    const option = [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')]
      .find(element => element.textContent?.includes('Crosshatch (OpenFreeMap)'));
    expect(option).toBeDefined();
    return option!;
  });
  option.click();
  await expect.poll(() => JSON.parse(model.getValue()).scene.style, {timeout: 10000}).toBe('crosshatch');
  expect(monaco.editor.getModel(modelUri)).toBe(model);
  expect(frame.querySelector('.monaco-editor')).toBe(editorElement);
  expect(frame.querySelectorAll('.monaco-editor')).toHaveLength(1);
  expect(selector.textContent).toContain('Crosshatch (OpenFreeMap)');
  expect(window.location.search).toContain('scene=styles%2Fcrosshatch.yaml');
  expect(loadScene).toHaveBeenCalledTimes(1);
  expect(frame.textContent).toContain('Scene JSON (schema validated)');
});

test('editor content changes apply once and update the visible accordion heading after completion', async () => {
  const model = await mountPanels();
  model.setValue('{"scene":{"style":"edited"}}');
  await expect.poll(() => loadScene.mock.calls.length, {timeout: 10000}).toBe(1);
  expect(loadScene.mock.lastCall).toEqual([
    {scene: {style: 'edited'}},
    {base_path: new URL('/examples/classic/styles/', window.location.href).href}
  ]);
  await expect.poll(() => frame.textContent, {timeout: 10000}).toContain('Scene JSON (applied)');
  expect(model.getValue()).toBe('{"scene":{"style":"edited"}}');
});

test('selecting Albers from a street-level style opens its national overview', async () => {
  await mountPanels();
  frame.querySelector<HTMLButtonElement>('[aria-haspopup="listbox"]')!.click();
  const option = await vi.waitFor(() => {
    const option = [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')]
      .find(element => element.textContent?.includes('Albers projection morph'));
    expect(option).toBeDefined();
    return option!;
  });
  option.click();
  await expect.poll(() => loadScene.mock.calls.length).toBe(1);
  expect(setView).toHaveBeenCalledExactlyOnceWith([39, -96], 4);
  expect(window.location.search).toContain('projection-morph.yaml');
});

test('leaving a mounted playground removes its host and model and cancels pending edits', async () => {
  const model = await mountPanels();
  model.setValue('{}');
  const cleanup = runtime.tangramClassicSettingsCleanup!;
  expect(() => {cleanup(); cleanup();}).not.toThrow();
  await new Promise(resolve => setTimeout(resolve, 500));
  expect(loadScene).not.toHaveBeenCalled();
  expect(frame.querySelector('.classic-settings-host')).toBeNull();
  expect(runtime.tangramClassicSettingsCleanup).toBeNull();
  await expect.poll(() => monaco.editor.getModel(modelUri), {timeout: 10000}).toBeNull();
});

test('leaving during initial fetch aborts startup without mounting a late sidebar', async () => {
  let release!: (response: Response) => void;
  let signal!: AbortSignal;
  sourceRequest = requestSignal => {
    signal = requestSignal;
    return new Promise(resolve => {release = resolve;});
  };
  const mounting = startSettingsPanel(panels);
  runtime.tangramClassicSettingsCleanup!();
  expect(signal.aborted).toBe(true);
  release(Response.json({scene: {style: 'late'}}));
  await mounting;
  expect(frame.querySelector('.classic-settings-host')).toBeNull();
  expect(monaco.editor.getModel(modelUri)).toBeNull();
});
