{/*
tangram-layers
SPDX-License-Identifier: MIT
Copyright (c) vis.gl contributors
 */}

# `@vis.gl/tangram-renderer`

The renderer package owns Tangram scenes, tiles, styles, labels, resource
management, and luma.gl draw submission. It has no deck.gl or Leaflet
dependency.

## Public entrypoint

```js
import Tangram, {
  ClassicWebGLRenderer,
  HostFrame,
  LumaDeviceRenderer,
  Scene
} from '@vis.gl/tangram-renderer';
```

The default export preserves the legacy Tangram API. Named exports are the
host-integration boundary:

- `Scene` loads scene configuration and owns camera/tile state.
- `ClassicWebGLRenderer` drives classic scene traversal and submits work to a
  host device/render pass. The historical named `Renderer` alias remains for
  compatibility.
- `HostFrame` carries shared geographic state and one or more named camera
  views supplied by the embedding application.
- `LumaDeviceRenderer` provides the luma.gl resource backend used by WebGL and
  WebGPU paths.
- `debug` and `version` remain available for legacy consumers.

The repository's classic example carries its own Leaflet adapter. Keeping that
adapter outside this package prevents host interaction and camera code from
entering applications that use the renderer through deck.gl.

The renderer accepts an externally owned luma.gl device through its renderer
options. Applications should use the device and render pass supplied by their
host rather than reading a backend handle.

## Host-only core entrypoint

```ts
import {Renderer, HostFrame} from '@vis.gl/tangram-renderer/core';
```

This entry includes scene traversal, tiles, styles, the external camera, and the
luma.gl backend, but excludes classic perspective/isometric/flat cameras,
Leaflet, and deck.gl. Its embedded scene worker is initialized without assigning
`globalThis.Tangram`. The build checks the dependency graph on every build.
`@vis.gl/tangram-layers` uses this entry.

The root entry remains the standalone compatibility API: its `Scene` injects
classic camera construction. The core is **host-independent**, not dependency-free;
it still uses luma.gl, math.gl, and Tangram's parsing and geometry dependencies.
Schema validation remains a separate optional entry.

## Style schema entrypoint

Scene documents can be validated with the optional schema entrypoint:

```js
import {TangramStyleSheetSchema} from '@vis.gl/tangram-renderer/style-schema';

const parsedScene = TangramStyleSheetSchema.parse(sceneDocument);
```

The generated JSON Schema is available at
`@vis.gl/tangram-renderer/tangram-style.schema.json` for Monaco, YAML language
servers, and other editor integrations.
