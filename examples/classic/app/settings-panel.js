// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {createMonacoEnvironment} from './monaco-workers.js';
import {startSettingsPanel} from './settings-panel-runtime.js';
import {createCommunityPlayground, createCommunitySettingsPanel} from './community-playground.js';

if (!window.MonacoEnvironment) {
  const workerBaseUrl = new URL(window.tangramClassicBaseUrl || './', document.baseURI).href;
  window.MonacoEnvironment = createMonacoEnvironment(workerBaseUrl);
}

// Bundle the client and its workers from the same installed Monaco version.
// Initialize the worker environment before TextEditorPanel lazily loads Monaco.
const scene = window.scene;
const start = () => {
  // A delayed import belongs to this mount, not a later playground visit.
  if (window.scene === scene && !window.tangramClassicCancelled) return startSettingsPanel({createCommunityPlayground, createCommunitySettingsPanel});
};
if (document.readyState === 'loading') {
  window.addEventListener('load', start, {once: true});
} else {
  start();
}
