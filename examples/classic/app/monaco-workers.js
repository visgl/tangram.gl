// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/** Create Monaco's worker factory for the same-origin, Ocular-built example assets. */
export function createMonacoEnvironment(baseUrl) {
  return {
    getWorker(_workerId, label) {
      const workerName = label === 'json' ? 'monaco-json.worker.js' : 'monaco-editor.worker.js';
      return new Worker(new URL(workerName, baseUrl), {type: 'module'});
    }
  };
}
