{/*
tangram-layers
SPDX-License-Identifier: MIT
Copyright (c) vis.gl contributors
 */}

# `@vis.gl/tangram-layers`

The adapter package contains the experimental deck.gl integration.

```js
import {TangramLayer} from '@vis.gl/tangram-layers';

const basemap = new TangramLayer({
  id: 'tangram-basemap',
  scene: sceneConfiguration,
  sceneBasePath: '/examples/'
});
```

## Exports

- `TangramLayer` — the ready-to-use deck.gl layer class.
- `createTangramLayerClass({Layer, ClassicWebGLRenderer})` — dependency-injected
  factory for hosts that provide compatible layer and renderer classes. The
  `Renderer` dependency name remains accepted as a compatibility alias.
- `getExternalCameraFrame(viewport)` — converts a deck Web Mercator viewport
  into Tangram camera matrices.
- `injectNextzenApiKey(config, apiKey)` — injects a runtime key into Nextzen
  source URL parameters without storing credentials in a scene file.

`TangramLayer` uses the deck-owned luma.gl device and render pass. It supports
WebGL and WebGPU, synchronizes camera/resize/opacity state, and rejects
unsupported multi-view or non-flat viewport configurations.
