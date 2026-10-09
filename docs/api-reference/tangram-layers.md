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
- `getFirstPersonViewFrame(viewport, options)` and `getGlobeViewFrame(viewport, options)`
  — create host frames for the experimental geographic views.
- `WebMercatorViewAdapter`, `FirstPersonViewAdapter` and `GlobeViewAdapter`
  — reusable view-adapter classes.
- `injectNextzenApiKey(config, apiKey)` — injects a runtime key into Nextzen
  source URL parameters without storing credentials in a scene file.

`TangramLayer` uses the deck-owned luma.gl device and render pass. It supports
WebGL 2 and WebGPU with flat/perspective MapView and experimental GlobeView and
FirstPersonView. Fractional layer opacity is not applied to Tangram output.
See [TangramLayer](./tangram-layer.md) for property and lifecycle limits.

## Experimental entries

- `@vis.gl/tangram-layers/experimental/projected-basemaps` provides
  `ProjectedBasemapLayer`, scene preparation and geographic navigation for
  OrthographicView. See [projected basemaps](../developer-guide/projected-basemaps.md).
- `@vis.gl/tangram-layers/experimental/webxr` provides room placement, shared
  controls, per-eye frames and surface interaction. See [WebXR presentation](./webxr-presentation.md).

These opt-in entries do not enter the normal layer bundle. All workspace
packages are currently private and unpublished.
