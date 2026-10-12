{/*
tangram-layers
SPDX-License-Identifier: MIT
Copyright (c) vis.gl contributors
 */}

# What's new

## 1.0.0-alpha.0 — vis.gl integration line

- FirstPerson terrain adds standard deck navigation, bounded eye-centered streaming,
  physical-height screen picking and a point-eye floor constraint. XY meter offsets
  move both tile selection and elevation probes; missing terrain holds altitude.
  Canvas-relative picking routes offset Map/FirstPerson viewports without rebuilding
  unchanged geometry. Continuous collision, horizon coverage and draping are deferred.

- Terrain query collections add nearest-tile identities, finite trimmed sightlines,
  geographic elevation brackets and Mercator point-clearance constraints. Globe
  terrain exposes admitted-geometry probes and a pinned-target visibility inspector;
  no-data remains unknown rather than certified visible. Existing MapView target
  following uses the shared probe boundary. This is not continuous collision or draping.

- Terrain picking indexes can be warmed in cancellable cooperative chunks. The
  globe display stage warms them before publication when current-plus-staged
  acceleration fits, reports deferred warming, and keeps exact lazy/linear fallback.
  Near-first traversal prunes farther leaves while preserving physical height,
  accepted-face and equal-distance query results.

- Opt-in globe terrain display preparation cooperatively rescales vertices and
  builds matching query snapshots. The example publishes complete generations,
  cancels obsolete multiplier work and reuses CPU buffers through device changes;
  per-tile geometry copies remain indivisible.

- Globe terrain adds atomic display-memory admission and bounded lazy picking
  acceleration. Query geometry is retained once; a zero hierarchy budget keeps
  exact linear picking. Diagnostics report retained arrays and CPU update/pick time.
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
- The opt-in [GlobeTerrainLayer](./api-reference/globe-terrain-layer.md) displaces
  spherical terrain from physical DEM grids. `globeTerrainExaggeration` defaults
  to 100 while the globe fits and fades to flat after one diameter doubling;
  explicit 1× retains physical scale. Prepared terrain samples/topology are reused
  through zoom and neighborhood changes, and detail selection waits for navigation
  to settle. The Mapterhorn globe
  example retains global coarse coverage while refining visible DEM tiles, stitches
  balanced 2:1 spherical edges and shares relief lighting and physical picking.
  High/Balanced/Fast detail controls expose a bounded footprint policy; source
  arrays, requests and leaf counts are limited separately. This is not basemap draping.
  Terrain mounts reuse bounded same-origin decoder workers, and the globe requests
  physical height grids without constructing unused Mercator topology. Diagnostics
  expose retained grid/mesh memory and decode/round-trip elapsed time.
  Globe mesh preparation now cooperates with animation-frame slices, pauses during
  navigation and swaps complete stitched snapshots atomically. A separate prepared
  template retention cap preserves current terrain on admission failure; CPU-slice
  diagnostics identify overruns without claiming a whole-GPU-memory or FPS budget.
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
