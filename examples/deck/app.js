// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {initializeCurrentDeckExample} from './app-loader.js';

window.tangramExampleBaseUrl = new URL('./', window.location.href).href;

await initializeCurrentDeckExample({
  moduleUrl: import.meta.url,
  getActiveMountId: () => window.tangramDeckExampleMountId,
  embeddedViewMode: window.tangramExampleViewMode,
  runtimeOptions: {
    basemapId: window.tangramExampleBasemapId,
    showOverlays: window.tangramExampleShowOverlays
  }
});
