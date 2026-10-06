// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {afterAll, afterEach, beforeEach, expect, test, vi} from 'vitest';
import {createCommunityPlayground, createCommunitySettingsPanel} from '../examples/classic/app/community-playground.js';
import * as monaco from 'monaco-editor';
import {createMonacoEnvironment} from '../examples/classic/app/monaco-workers.js';
import {startSettingsPanel} from '../examples/classic/app/settings-panel-runtime.js';
import '../examples/classic/css/main.css';

const runtime = globalThis as typeof globalThis & {tangramClassicSettingsCleanup?: (() => void) | null};
/** The shared Playground owns a unique editor ID per mount. */
function getPlaygroundModel() {
  return monaco.editor.getModels().find(model => model.uri.toString().includes('/panels/playground-editor-')) ?? null;
}
const workers: Worker[] = [];
let frame: HTMLDivElement;
let originalUrl: string;
let sourceRequest: ((signal: AbortSignal, url: string) => Promise<Response>) | undefined;
const loadScene = vi.fn(async (_config: string | object, _options?: {base_path: string}) => {});
const setView = vi.fn();
const refreshAttribution = vi.fn();

beforeEach(() => {
  originalUrl = window.location.href;
  frame = document.createElement('div');
  frame.id = 'classic-playground-frame';
  frame.style.cssText = 'position:relative;width:min(1100px, 100%);height:650px';
  document.body.append(frame);
  const mapElement = document.createElement('div');
  mapElement.id = 'map';
  frame.append(mapElement);
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
  refreshAttribution.mockClear();
  vi.stubGlobal('map', {setView});
  sourceRequest = undefined;
  vi.stubGlobal('scene', {
    load: loadScene, subscribe: vi.fn(), unsubscribe: vi.fn(), config: {},
    setActiveCamera: vi.fn(), setIntrospection: vi.fn()
  });
  vi.stubGlobal('layer', {updateAttribution: refreshAttribution});
  vi.stubGlobal('Tangram', {debug: {yaml: {safeLoad: JSON.parse}}});
  vi.stubGlobal('tangramClassicEmbedded', true);
  vi.stubGlobal('tangramClassicScene', 'styles/tron.yaml');
  vi.stubGlobal('tangramClassicBaseUrl', new URL('/examples/classic/', window.location.href).href);
  vi.stubGlobal('tangramStyleSchemaUrl', 'https://example.test/schema.json');
  const fetchOriginal = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, options) => {
    const url = String(input);
    if (url === 'https://example.test/schema.json') return Promise.resolve(Response.json({type: 'object'}));
    if (url.includes('/examples/classic/styles/')) {
      if (sourceRequest) return sourceRequest(options?.signal as AbortSignal, url);
      const style = url.includes('crosshatch') ? 'crosshatch' : 'tron';
      return Promise.resolve(Response.json({scene: {style}}));
    }
    return fetchOriginal(input, options);
  });
});

afterEach(async () => {
  runtime.tangramClassicSettingsCleanup?.();
  await expect.poll(() => getPlaygroundModel(), {timeout: 10000}).toBeNull();
  frame.remove();
  window.history.replaceState(null, '', originalUrl);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

afterAll(() => {for (const worker of workers.splice(0)) worker.terminate();});

/** Mount the production composition with the real community panels and wait for its model. */
async function mountPanels() {
  await startSettingsPanel({createCommunityPlayground, createCommunitySettingsPanel});
  const model = await vi.waitFor(() => {
    const model = getPlaygroundModel();
    expect(model).not.toBeNull();
    return model!;
  }, {timeout: 15000});
  // The tests exercise controlled text and lifecycle, not Monaco's unrelated
  // word-highlighter provider, whose pending Delayer rejects on immediate disposal.
  for (const editor of monaco.editor.getEditors()) editor.updateOptions({occurrencesHighlight: 'off'});
  await expect.poll(() => frame.querySelector('.classic-playground-status')?.textContent).toBe('Style applied');
  loadScene.mockClear();
  setView.mockClear();
  return model;
}

/** Select a scene through the actual community card picker. */
async function selectStyle(title: string) {
  const tab = [...frame.querySelectorAll<HTMLButtonElement>('[data-panel-tabs] button')]
    .find(element => element.textContent === 'Select Style')!;
  tab.click();
  const card = await vi.waitFor(() => {
    const card = [...frame.querySelectorAll<HTMLButtonElement>('[data-template]')]
      .find(element => element.textContent?.includes(title));
    expect(card).toBeDefined();
    return card!;
  });
  card.click();
}

test('selecting a style updates the actual nested community editor without replacing its model', async () => {
  const model = await mountPanels();
  expect(JSON.parse(model.getValue())).toEqual({scene: {style: 'tron'}});
  const editorElement = frame.querySelector('.monaco-editor');
  expect(editorElement).not.toBeNull();
  await selectStyle('Crosshatch (OpenFreeMap)');
  await expect.poll(() => JSON.parse(model.getValue()).scene.style, {timeout: 10000}).toBe('crosshatch');
  expect(getPlaygroundModel()).toBe(model);
  expect(frame.querySelector('.monaco-editor')).toBe(editorElement);
  expect(frame.querySelectorAll('.monaco-editor')).toHaveLength(1);
  expect(frame.querySelector('[data-template="styles/crosshatch.yaml"]')?.getAttribute('aria-selected')).toBe('true');
  expect(window.location.search).toContain('scene=styles%2Fcrosshatch.yaml');
  await expect.poll(() => loadScene.mock.calls.length).toBe(1);
  expect(frame.textContent).toContain('Style JSON');
});

test('editor content changes apply once and update the preview status after completion', async () => {
  const model = await mountPanels();
  model.setValue('{"scene":{"style":"edited"}}');
  await expect.poll(() => loadScene.mock.calls.length, {timeout: 10000}).toBe(1);
  expect(loadScene.mock.lastCall).toEqual([
    {scene: {style: 'edited'}},
    {base_path: new URL('/examples/classic/styles/', window.location.href).href}
  ]);
  await expect.poll(() => frame.textContent, {timeout: 10000}).toContain('Style applied');
  expect(refreshAttribution).toHaveBeenCalledTimes(2);
  expect(model.getValue()).toBe('{"scene":{"style":"edited"}}');
});

test('selecting Albers from a street-level style opens its national overview', async () => {
  await mountPanels();
  await selectStyle('Albers projection morph');
  await expect.poll(() => loadScene.mock.calls.length).toBe(1);
  expect(setView).toHaveBeenCalledExactlyOnceWith([39, -96], 4);
  expect(window.location.search).toContain('projection-morph.yaml');
});

test('selecting a local preview from Albers returns to its actual geometry', async () => {
  await mountPanels();
  await selectStyle('Albers projection morph');
  await expect.poll(() => loadScene.mock.calls.length).toBe(1);
  await selectStyle('TRON (local preview)');
  await expect.poll(() => loadScene.mock.calls.length).toBe(2);
  expect(setView).toHaveBeenLastCalledWith([40.705, -74.009], 16);
  expect(frame.querySelector('[data-template="styles/local-tron.yaml"]')?.textContent)
    .toContain('live animated TRON basemap from OpenFreeMap');
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
  await expect.poll(() => getPlaygroundModel(), {timeout: 10000}).toBeNull();
});

test('leaving during initial fetch aborts startup without mounting a late sidebar', async () => {
  let release!: (response: Response) => void;
  let signal!: AbortSignal;
  const response = new Promise<Response>(resolve => {release = resolve;});
  sourceRequest = requestSignal => {
    signal = requestSignal;
    return response;
  };
  const mounting = startSettingsPanel({createCommunityPlayground, createCommunitySettingsPanel});
  runtime.tangramClassicSettingsCleanup!();
  expect(signal.aborted).toBe(true);
  release(Response.json({scene: {style: 'late'}}));
  await mounting;
  expect(frame.querySelector('.classic-settings-host')).toBeNull();
  expect(getPlaygroundModel()).toBeNull();
});

test.each(['missing', 'malformed'])('an optional %s style does not prevent the active editor from mounting', async failure => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  sourceRequest = async (_signal, url) => url.endsWith('/crosshatch.yaml')
    ? new Response(failure === 'missing' ? 'Not found' : 'invalid document', {status: failure === 'missing' ? 404 : 200})
    : Response.json({scene: {style: 'tron'}});
  await startSettingsPanel({createCommunityPlayground, createCommunitySettingsPanel});
  await expect.poll(() => getPlaygroundModel(), {timeout: 15000}).not.toBeNull();
  await expect.poll(() => frame.querySelector('.classic-playground-status')?.textContent)
    .toBe('Style applied · 1 style unavailable');
  expect(frame.querySelector('[data-template="styles/crosshatch.yaml"]')).toBeNull();
  expect(frame.querySelector('[data-template="styles/tron.yaml"]')).not.toBeNull();
  expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('styles/crosshatch.yaml'));
});

test('parse errors retain the map and correcting the text applies again', async () => {
  const model = await mountPanels();
  model.setValue('{');
  await expect.poll(() => frame.querySelector('.classic-playground-status')?.textContent).toContain('Style error:');
  expect(loadScene).not.toHaveBeenCalled();
  expect(frame.querySelector('.deckgl-playground-preview #map')).not.toBeNull();
  model.setValue('{"scene":{"style":"fixed"}}');
  await expect.poll(() => frame.querySelector('.classic-playground-status')?.textContent).toBe('Style applied');
  expect(loadScene).toHaveBeenCalledTimes(1);
});

test('reports async failures and permits recovery without replacing the editor model', async () => {
  const model = await mountPanels();
  loadScene.mockRejectedValueOnce(new Error('scene failed'));
  model.setValue('{"invalid":true}');
  await expect.poll(() => frame.querySelector('.classic-playground-status')?.textContent).toBe('Style error: scene failed');
  model.setValue('{}');
  await expect.poll(() => frame.querySelector('.classic-playground-status')?.textContent).toBe('Style applied');
  expect(getPlaygroundModel()).toBe(model);
});

test('cleanup restores the map to the bootstrap-owned frame', async () => {
  await mountPanels();
  expect(frame.querySelector('.deckgl-playground-preview #map')).not.toBeNull();
  runtime.tangramClassicSettingsCleanup!();
  expect(frame.querySelector(':scope > #map')).not.toBeNull();
});

test('startup preserves the authored Albers URL/hash camera until a card is selected', async () => {
  window.history.replaceState(null, '', '?scene=styles/projection-morph.yaml#7/40/-100');
  await startSettingsPanel({createCommunityPlayground, createCommunitySettingsPanel});
  await expect.poll(() => frame.querySelector('.classic-playground-status')?.textContent).toBe('Style applied');
  expect(setView).not.toHaveBeenCalled();
  expect(window.location.hash).toBe('#7/40/-100');
  await selectStyle('Albers projection morph');
  expect(setView).toHaveBeenCalledExactlyOnceWith([39, -96], 4);
});

test.each([
  ['open-light-raster.yaml', 'open-light-vector.yaml'],
  ['open-streets-raster.yaml', 'open-streets-vector.yaml']
])('the legacy %s link selects its canonical vector card', async (legacy, canonical) => {
  window.history.replaceState(null, '', '?scene=styles/' + legacy + '#16/40.7/-74');
  await mountPanels();
  expect(window.location.search).toContain(encodeURIComponent('styles/' + canonical));
  expect(frame.querySelector(`[data-template="styles/${canonical}"]`)?.getAttribute('aria-selected')).toBe('true');
  expect(setView).not.toHaveBeenCalled();
});

test('the editor fills the canvas and stays above Leaflet pane z-indices', async () => {
  await mountPanels();
  const pane = document.createElement('div');
  pane.style.cssText = 'position:absolute;inset:0;z-index:600';
  frame.querySelector('#map')!.append(pane);
  const editor = frame.querySelector<HTMLElement>('.monaco-editor')!;
  await expect.poll(() => editor.getBoundingClientRect().height).toBeGreaterThan(450);
  const bounds = editor.getBoundingClientRect();
  const hit = document.elementFromPoint(bounds.left + 40, bounds.top + 40);
  expect(hit?.closest('.monaco-editor')).toBe(editor);
});
