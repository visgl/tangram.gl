{/*
tangram-layers
SPDX-License-Identifier: MIT
Copyright (c) vis.gl contributors
 */}

# Architecture

The renderer owns Tangram scenes and GPU resources. The layer package adapts it
to deck.gl's device, viewport, and render-pass lifecycle.

The monorepo has two intentionally separate layers:

1. `@vis.gl/tangram-renderer` contains scene loading, tile management, style
   evaluation, labels, and luma.gl resource/draw submission. Its
   `ClassicWebGLRenderer` receives a host-owned frame and render pass.
2. `@vis.gl/tangram-layers` adapts that renderer to deck.gl's layer lifecycle.
   deck.gl supplies the device, viewport, resize events, and render pass; the
   adapter forwards them to Tangram and keeps the package dependency one-way.

The split is a foundation for future shared-device and WebGPU work. It avoids
making the standalone Tangram renderer know about deck.gl while allowing a
deck.gl application to compose Tangram basemaps with ordinary overlay layers.

## Camera ownership

The host-driven renderer uses `cameraMode: 'external'`. In this mode the host
owns interaction, animation scheduling, view selection, and projection
matrices. `TangramLayer` converts the active deck.gl viewport into Tangram's
geographic frame and supplies deck.gl's view and projection matrices for every
draw. A scene's `cameras` block cannot replace those matrices.

The package root also retains Tangram's perspective, flat, and isometric scene
cameras for the classic Leaflet integration. Those compatibility cameras and
their interaction helpers should move behind optional `cameras` and `leaflet`
entrypoints as the renderer is decomposed. The intended package boundary is:

- `@vis.gl/tangram-renderer/core`: scene loading, tiles, styles, labels, GPU
  resources, draw submission, geographic frame state, and externally supplied
  matrices;
- `@vis.gl/tangram-renderer/cameras`: Tangram's perspective, flat, and
  isometric camera implementations;
- `@vis.gl/tangram-renderer/leaflet`: Leaflet interaction, URL synchronization,
  and standalone render-loop ownership.

The current `Scene` still constructs `View`, and `View` still imports the
classic camera factory. Therefore adding a `core` export today would only be a
name, not a camera-free package boundary. The next structural tranche should
inject view/camera policy into `Scene`, stop `SceneLoader` from synthesizing a
camera in external mode, and then expose the new subpath once its dependency
graph no longer reaches Leaflet or the classic cameras.

Style animation is separate from camera ownership. Animated styles continue to
request host frames and may transform geometry using `u_time`, zoom, or custom
shader uniforms. For example, the Albers projection example morphs vertices in
its shader according to zoom; it does not animate or replace the camera. This
means projection effects remain usable with deck.gl views, provided they do not
assume a specific built-in Tangram projection matrix.
