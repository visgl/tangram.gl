{/*
tangram-layers
SPDX-License-Identifier: MIT
Copyright (c) vis.gl contributors
 */}

# Classic Tangram API

> This page adapts the original
> [Tangram README](https://github.com/tangrams/tangram/blob/master/README.md)
> and [Tangram JavaScript API reference](https://github.com/tangrams/tangram-docs/blob/main/docs/API-Reference/Javascript-API.md),
> both published under the MIT license. It has been updated for this repository's
> package names and host-renderer APIs.

Tangram began as a browser library for drawing 2D and 3D maps from vector data.
It supports tiled MVT, GeoJSON, and TopoJSON sources as well as non-tiled data.
Scene files describe sources, layers, draw rules, cameras, lights, materials,
textures, and custom shaders.

The classic playground uses an example-local Leaflet adapter for interaction
and camera state. Leaflet is intentionally not exported by the renderer
package. New deck.gl applications should normally use `TangramLayer` or
`ClassicWebGLRenderer` with a `HostFrame`.

## Package export

```js
import Tangram, {
  Scene,
  ClassicWebGLRenderer,
  HostFrame,
  LumaDeviceRenderer
} from '@vis.gl/tangram-renderer';
```

The default `Tangram` object contains the same named members plus the historical
`Renderer` alias, `debug`, and `version`.

## Leaflet example integration

The classic example packages the historical adapter locally rather than making
it part of `@vis.gl/tangram-renderer`:

```js
import L from 'leaflet';
import {leafletLayer} from './leaflet-layer.js';

const map = L.map('map');
const layer = leafletLayer({
  leaflet: L,
  scene: 'scene.yaml'
});

layer.addTo(map);
```

This adapter is example code, not a supported renderer-package API. The
returned layer exposes its `Scene` as `layer.scene`. Leaflet owns pan,
zoom, pointer events, and the classic camera lifecycle. The layer translates
those changes into Tangram view state and manages the standalone render loop.

Important layer options retained by the implementation include:

- `scene`: scene URL or configuration object;
- `sceneBasePath`/scene-relative resources through the scene loader;
- `numWorkers`: worker count;
- `preUpdate` and `postUpdate`: frame callbacks;
- `highDensityDisplay`: device-pixel-ratio rendering;
- `introspection`: make all features queryable;
- `noWrap`: disable antimeridian wrapping;
- `selectionRadius`: feature-picking radius; and
- `disableRenderLoop`: require the application to call `scene.update()`.

## Scene documents

A scene is YAML or the equivalent JavaScript object:

```yaml
sources:
  places:
    type: GeoJSON
    url: data/places.geojson

layers:
  parks:
    data: {source: places}
    filter: {kind: park}
    draw:
      polygons:
        color: '#4d8b57'
```

YAML is convenient for inline JavaScript expressions and GLSL shader blocks.
The renderer normalizes it into `scene.config`; after changing that object,
call `scene.updateConfig()` to apply the changes.

## Classic and host-driven ownership

| Concern | Classic Leaflet API | Host-driven renderer |
| --- | --- | --- |
| Interaction | Leaflet | Host application or deck.gl |
| Camera | Scene `cameras` block | `HostFrame.renderViews` |
| Scheduling | Tangram render loop | Host calls `renderer.render()` |
| GPU device | Tangram-created WebGL context | Host-owned luma.gl device |
| Render pass | Tangram | Host supplied |
| Tiles, styles, labels | Tangram | Tangram |

See the [Scene API](scene.md) for runtime scene operations and the
[Renderer API](renderer.md) for host integration.
