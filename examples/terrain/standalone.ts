// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {mountTerrainExample} from './app';

const host = document.getElementById('example');
if (!host) throw new Error('Missing example host');
const example = mountTerrainExample(host, {
  parameters: new URLSearchParams(location.search),
  onParametersChange(parameters) {
    history.replaceState(history.state, '', `${location.pathname}?${parameters}`);
  }
});
window.addEventListener('pagehide', (event) => {
  if (!event.persisted) example.destroy();
});
