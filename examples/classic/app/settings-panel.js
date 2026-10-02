// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {createMonacoEnvironment} from './monaco-workers.js';
import {startSettingsPanel} from './settings-panel-runtime.js';

if (!window.MonacoEnvironment) {
  const workerBaseUrl = new URL(window.tangramClassicBaseUrl || './', document.baseURI).href;
  window.MonacoEnvironment = createMonacoEnvironment(workerBaseUrl);
}

// Match the locally built workers instead of allowing the CDN's semver
// resolution to drift independently from the editor's worker protocol.
const scene = window.scene;
const panels = await import('https://esm.sh/@deck.gl-community/panels@9.4.2-beta.1?bundle&deps=monaco-editor@0.53.0');
const start = () => {
  // A delayed CDN import belongs to this mount, not a later playground visit.
  if (window.scene === scene && !window.tangramClassicCancelled) return startSettingsPanel(panels);
};
if (document.readyState === 'loading') {
  window.addEventListener('load', start, {once: true});
} else {
  start();
}
