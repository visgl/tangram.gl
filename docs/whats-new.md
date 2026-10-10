{/*
tangram-layers
SPDX-License-Identifier: MIT
Copyright (c) vis.gl contributors
 */}

# What's new

## 1.0.0-alpha.0 — vis.gl integration line

- Tangram source, renderer bundles, fixtures, and renderer tests now live in
  `modules/tangram-renderer`.
- The deck.gl adapter is a separate `@vis.gl/tangram-layers` workspace. Both
  module packages remain private and unpublished.
- The renderer exposes luma.gl-backed `ClassicWebGLRenderer`, `Scene`, and
  `LumaDeviceRenderer` integration points while retaining the legacy default
  Tangram API.
- `HostFrame` separates shared geographic state from named render views and
  drives shared tile selection and per-eye rendering for stereo/WebXR hosts.
- `HostFrame.projection` identifies `web-mercator` and experimental `globe`
  frames without introducing a deck.gl dependency in the renderer. GlobeView
  matrices and visibility bounds now drive spherical WebGL 2 and WebGPU
  rendering while advanced culling and tessellation remain under development.
- The deck example is under `examples/deck/` and supports shared luma.gl
  WebGL and WebGPU devices, vector styles, and the animated TRON style.
- The opt-in `experimental/projected-basemaps` layer adds worker-side math.gl
  Equal Earth, regional Albers, equirectangular, ellipsoidal Mercator and Web
  Mercator projection for ground polygons, raster meshes, meter/pixel roads
  and screen-space-colliding point/text annotations in OrthographicView. See the
  [experimental projection contract](./developer-guide/projected-basemaps.md)
  for coverage, resource limits and deferred features.
- The repository uses Yarn workspaces and `@vis.gl/dev-tools` for bootstrap,
  Ocular/esbuild bundles, Vitest testing and Biome linting. Generated output is
  no longer committed; application bundles are ESM-only.
- OpenFreeMap supplies the default vector examples; NASA Blue Marble supplies
  overview imagery. Hosts display source-driven attribution.
- Renderer and example dependencies use luma.gl 9.4.2 with deck.gl 9.4.0,
  math.gl 5.0.0-alpha.15 and optional loaders.gl 5.0.0-alpha.11 adapters.
  The community playground uses loaders.gl 4.5.3; its Arrow dependency is
  patched to the same release to avoid the older package's stale 4.4 core peer.

This is an alpha boundary. Renderer and adapter APIs may change before a
stable release.
