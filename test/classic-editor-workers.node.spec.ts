// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {readFileSync} from 'node:fs';
import {afterEach, expect, test, vi} from 'vitest';
import {createMonacoEnvironment} from '../examples/classic/app/monaco-workers.js';

afterEach(() => vi.unstubAllGlobals());

test.each(['json', 'editorWorkerService', 'plaintext'])('resolves the %s worker against the example assets on the current origin', label => {
  const workerConstructor = vi.fn(function WorkerStub() {});
  vi.stubGlobal('Worker', workerConstructor);
  const environment = createMonacoEnvironment('https://example.com/tangram.gl/examples/classic/');
  environment.getWorker('unused-module-id', label);
  expect(workerConstructor).toHaveBeenCalledWith(
    new URL(`https://example.com/tangram.gl/examples/classic/monaco-${label === 'json' ? 'json' : 'editor'}.worker.js`),
    {type: 'module'}
  );
});

test('pins the panel client to the exact locally installed worker version', () => {
  const packageConfig = JSON.parse(readFileSync(new URL('../examples/classic/package.json', import.meta.url), 'utf8'));
  const panelSource = readFileSync(new URL('../examples/classic/app/settings-panel.js', import.meta.url), 'utf8');
  expect(packageConfig.devDependencies['monaco-editor']).toBe('0.53.0');
  expect(panelSource).toContain(`deps=monaco-editor@${packageConfig.devDependencies['monaco-editor']}`);
  for (const worker of ['editor', 'json']) {
    const entry = readFileSync(new URL(`../examples/classic/monaco-${worker}.worker.js`, import.meta.url), 'utf8');
    expect(entry).not.toContain('https://');
    expect(entry).toContain("import 'monaco-editor/");
    expect(packageConfig.scripts['build:editor-workers']).toContain(`--output=dist/monaco-${worker}.worker.js`);
  }
});
