// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {mountProjectedExample} from './app.js';

const host = document.getElementById('example');
if (!host) throw new Error('Missing example host');
const example = mountProjectedExample(host, {
  parameters: new URLSearchParams(location.search),
  workerUrl: new URL(
    '../../modules/tangram-renderer/dist/projected-basemaps-worker.js',
    import.meta.url
  ).href,
  onParametersChange(parameters) {
    history.replaceState(history.state, '', `${location.pathname}?${parameters}`);
  }
});
window.addEventListener('pagehide', (event) => {
  if (!event.persisted) example.destroy();
});
