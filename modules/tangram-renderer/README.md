<!--
Tangram
SPDX-License-Identifier: MIT
Copyright (c) 2013-2016 Brett Camper and Mapzen
Copyright (c) 2026 vis.gl contributors
-->

# @vis.gl/tangram-renderer

Tangram scene rendering powered by luma.gl, with WebGL 2 and WebGPU host paths.
The renderer loads vector/raster data, evaluates Tangram styles, manages tiles
and labels, and submits scene GPU work. It has no deck.gl or Leaflet dependency.

This workspace is private and unpublished. Build from the repository root:

```sh
yarn install --immutable
yarn build:modules
```

## Entries

```ts
// Custom host: no classic camera factory or Leaflet integration.
import {Renderer, HostFrame} from '@vis.gl/tangram-renderer/core';

// Standalone compatibility API with classic scene cameras.
import Tangram from '@vis.gl/tangram-renderer';

// Optional validation; not included by importing the renderer.
import {TangramStyleSheetSchema} from '@vis.gl/tangram-renderer/style-schema';
```

The root preserves the default Tangram object and named `Scene`,
`ClassicWebGLRenderer`/`Renderer`, `HostFrame`, and `LumaDeviceRenderer` exports.
For deck.gl applications, use `TangramLayer` from `@vis.gl/tangram-layers`.
The classic Leaflet adapter is example code under `examples/classic`.

Builds generate debug/minified ES modules, the core/package entries, declarations,
style schemas and workers. The main scene worker is embedded as a Blob;
loaders.gl and projected-basemap sidecars must be served separately when enabled.
No classic-script UMD bundles are produced, and `dist/` is not committed.

## Documentation and support

- [Renderer API](https://vis.gl/tangram.gl/docs/api-reference/renderer)
- [HostFrame](https://vis.gl/tangram.gl/docs/api-reference/host-frame)
- [Scene and styling](https://vis.gl/tangram.gl/docs/api-reference/styling)
- [Examples](https://vis.gl/tangram.gl/examples)
- [Issues in this fork](https://github.com/visgl/tangram.gl/issues)

Chromium is the automated browser/GPU test runtime. WebGPU requires browser
support; custom legacy GLSL effects are not automatically supported on that path.
The original [`tangram` npm package](https://www.npmjs.com/package/tangram) and
[upstream documentation](https://tangrams.readthedocs.io/) describe a separate
release, not this workspace's compatibility guarantees.

Tangram was created by Brett Camper and Mapzen. This fork preserves their MIT
licensed work and extends it with vis.gl integration. Tile and imagery licenses
are separate; the host must display source attribution.
