{/*
tangram-layers
SPDX-License-Identifier: MIT
Copyright (c) vis.gl contributors
 */}

# Architecture

The renderer owns Tangram scenes and GPU resources. The layer package adapts it
to deck.gl's device, viewport, and render-pass lifecycle.

## Package boundaries

- `@vis.gl/tangram-renderer/core` contains scene loading, tiles, styles, labels,
  external cameras and luma.gl draw submission. It excludes deck.gl, Leaflet
  and Tangram's classic perspective/flat/isometric camera factory. A build-time
  dependency-graph check enforces that separation.
- `@vis.gl/tangram-renderer` retains the default Tangram object and standalone
  `Scene` API, including classic scene cameras. The Leaflet adapter lives in
  `examples/classic`, not in either renderer entry.
- `@vis.gl/tangram-layers` supplies deck.gl view adapters and `TangramLayer`.
  Optional projected-basemap and WebXR APIs have separate experimental subpaths.

The dependency direction is layer → renderer, never renderer → deck.gl.
The core is host-independent, **not dependency-free**: it still uses luma.gl,
math.gl and Tangram's parsing/geometry dependencies. Schemas and optional loader
workers are separate entries or assets; see [bundling](./bundling.md).

## Ownership and lifetime

For host-driven rendering, the host owns interaction, scheduling, the canvas,
luma.gl device and render passes. Tangram owns its scene, workers, GPU resources
and renderer-created backend caches. Destroying the renderer releases those
resources, not the host's device or pass.

`HostFrame` separates shared geographic/style state from named camera views.
Apply the complete frame before drawing either stereo eye: tile selection uses
the union of their footprints, while camera uniforms are eye-specific. The host
sets render-target viewports/scissors and submits its passes.

Tile acquisition and decoded reuse have worker-local source boundaries;
mesh-build scheduling and off-screen residency have a separate tileset boundary.
Tangram still owns styling, refinement, labels and GPU disposal. These are not
a production switch to loaders.gl `Tileset2D`; see [tile loading](./tile-loading.md).

## Camera and style animation

Host-driven scenes use `cameraMode: 'external'`. deck.gl adapters supply the view
and projection matrices; a scene's `cameras` block cannot replace them. Classic
scene loading retains its built-in camera behavior.

Style animation is separate from camera ownership. Animated scenes request host
frames and use time, zoom or shader uniforms. The classic Albers morph transforms
vertices, not the host camera; it is distinct from the experimental CPU-projected
basemap entry. Custom GLSL blocks are not automatically portable to WebGPU.

See [view integration](./view-integration.md) for supported views and limitations,
[projection conventions](./projection-conventions.md) for units, and
[Renderer](../api-reference/renderer.md) for the host API.
