// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {afterAll, afterEach, beforeAll, expect, test, vi} from 'vitest';
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js';
import 'monaco-editor/esm/vs/language/json/monaco.contribution.js';
import {createMonacoEnvironment} from '../examples/classic/app/monaco-workers.js';

declare global {
  var MonacoEnvironment: monaco.Environment | undefined;
}

/** JSON RPC methods used by Monaco's own providers but omitted from its public worker types. */
type JSONWorker = monaco.languages.json.IJSONWorker & {
  doValidation(uri: string): Promise<{message: string}[]>;
  findDocumentSymbols(uri: string): Promise<{name: string}[]>;
  findDocumentColors(uri: string): Promise<unknown[]>;
  getFoldingRanges(uri: string): Promise<unknown[]>;
  format(uri: string, range: null, options: {tabSize: number; insertSpaces: boolean}): Promise<unknown[]>;
};

const workers: Worker[] = [];
const workerLabels: string[] = [];
const models: monaco.editor.ITextModel[] = [];
let schema: Record<string, unknown>;
let modelId = 0;
const originalEnvironment = globalThis.MonacoEnvironment;

beforeAll(async () => {
  const factory = createMonacoEnvironment(new URL('../examples/classic/dist/', import.meta.url).href);
  globalThis.MonacoEnvironment = {
    getWorker(workerId, label) {
      const worker = factory.getWorker(workerId, label);
      workers.push(worker);
      workerLabels.push(label);
      return worker;
    }
  };
  const response = await fetch(new URL('../modules/tangram-renderer/dist/tangram-style.schema.json', import.meta.url));
  expect(response.ok).toBe(true);
  schema = await response.json();
});

afterEach(() => {
  for (const model of models.splice(0)) model.dispose();
});

afterAll(() => {
  for (const worker of workers) worker.terminate();
  globalThis.MonacoEnvironment = originalEnvironment;
});

/** Register the actual generated style schema and synchronize a model to the built JSON worker. */
async function createModelWorker(source: string) {
  const uri = monaco.Uri.parse(`inmemory://classic/scene-${modelId++}.json`);
  monaco.languages.json.jsonDefaults.setDiagnosticsOptions({
    validate: true, enableSchemaRequest: false,
    schemas: [{uri: 'inmemory://classic/tangram-schema', fileMatch: [uri.toString()], schema}]
  });
  const model = monaco.editor.createModel(source, 'json', uri);
  models.push(model);
  // Language activation lazily installs the JSON worker manager. Do not race
  // getWorker against the first model's onLanguage callback.
  const createWorker = await vi.waitFor(() => monaco.languages.json.getWorker(), {timeout: 10000});
  // The methods are the same RPCs requested by the panel's JSON providers.
  const worker = await createWorker(uri) as JSONWorker;
  return {model, worker, uri: uri.toString()};
}

test('validates real Tangram source options and accepts a valid scene', async () => {
  const valid = await createModelWorker('{"sources":{"map":{"type":"MVT","tile_size":256}}}');
  expect(await valid.worker.doValidation(valid.uri)).toEqual([]);
  const invalid = await createModelWorker('{"sources":{"map":{"tile_size":-1}}}');
  expect(await invalid.worker.doValidation(invalid.uri)).toEqual(
    expect.arrayContaining([expect.objectContaining({message: expect.stringMatching(/greater than|minimum/i)})])
  );
  expect(await invalid.worker.getMatchingSchemas(invalid.uri)).not.toEqual([]);
});

test('reports syntax errors and revalidates after editing the synchronized model', async () => {
  const {model, worker, uri} = await createModelWorker('{"scene": }');
  expect(await worker.doValidation(uri)).not.toEqual([]);
  model.setValue('{"scene":{"background":{"color":"#ff0000"}}}');
  await expect.poll(async () => (await worker.doValidation(uri)).length).toBe(0);
});

test('serves the symbol, color, folding and formatting RPCs previously rejected by the mismatched worker', async () => {
  const {worker, uri} = await createModelWorker('{\n"scene": {\n"background": {"color": "#ff0000"}\n}\n}');
  expect(await worker.findDocumentSymbols(uri)).toEqual(expect.arrayContaining([expect.objectContaining({name: 'scene'})]));
  expect(await worker.findDocumentColors(uri)).toEqual([]);
  expect(await worker.getFoldingRanges(uri)).not.toEqual([]);
  expect(await worker.format(uri, null, {tabSize: 2, insertSpaces: true})).not.toEqual([]);
});

test('uses the built general editor worker to compute document differences', async () => {
  const host = document.createElement('div');
  host.style.cssText = 'width:600px;height:300px';
  document.body.append(host);
  const original = monaco.editor.createModel('before\nunchanged');
  const modified = monaco.editor.createModel('after\nunchanged');
  models.push(original, modified);
  const editor = monaco.editor.createDiffEditor(host, {automaticLayout: false});
  const viewModel = editor.createViewModel({original, modified});
  try {
    editor.setModel(viewModel);
    await viewModel.waitForDiff();
    expect(editor.getLineChanges()?.length).toBe(1);
    expect(workerLabels).toContain('editorWorkerService');
  } finally {
    editor.dispose();
    viewModel.dispose();
    host.remove();
  }
});
