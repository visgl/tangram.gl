<!--
tangram-layers
SPDX-License-Identifier: MIT
Copyright (c) vis.gl contributors
-->

# Mercator terrain reference

Run `yarn website:start` from the root, then open
`/tangram.gl/examples/deck-terrain`. Ocular builds this private example during
`yarn build` and website assembly. Do not use `file://`.

The website mounts `mountTerrainExample` directly in a lazy-loaded Docusaurus
component. It shares the runtime and controls with the standalone entry, without
an iframe, injected scripts, global selectors or a second router. Unmounting
aborts requests, disconnects resize observation and releases GPU resources.

The example starts near Zermatt and streams up to nine visible Mapterhorn tiles
plus immediate coarse parents. Same-origin workers decode with loaders.gl v5;
deck.gl TerrainLayer renders reconstructed physical-height meshes. Controls
include navigation, projected tile footprint, mesh error, wireframe, seam skirts, retry, devices, fullscreen
and collapsible information.

Elevation stays at physical scale. Changing mesh error reuses downloaded bytes.
Each fetch/decode job owns its worker; cancellation terminates it. Shared Tangram
queue, residency and cache policies bound work and retain warm source bytes.
Neighbor heights/normals agree at full-resolution edges; visual skirts cover
incomplete and mixed-detail boundaries without entering elevation queries.
This is not production Tangram terrain support: basemap draping and certified
pixel-error LOD remain deferred. Required tests
use generated fixtures, not live services. See the developer guide for budgets,
registration, validity and remaining limitations.

The example credits Mapterhorn and swissALTI3D / swisstopo for the Swiss reference
area and links the full source attribution. Dataset licensing is separate from
this example's MIT code license. See the terrain
developer guide for the shared height contract and coordinate conversions.

Hosts may inject a Terrarium `TerrainImageSource` into `mountTerrainExample`.
Its zoom domain also limits parent fallback; its credits and explicit no-data
policy follow the source. Incremental HTTP acquisition enforces byte/deadline
limits and cancels actual response reads. Every mount retains an isolated cache.
Projected-footprint LOD uses CSS pixels and hysteresis, not a certified terrain
error metric. Owned query indexes prune physical top triangles and survive camera
changes; visual skirts never enter picking.

## Globe terrain

The native `/tangram.gl/examples/deck-globe-terrain` page mounts
`mountGlobeTerrainExample`. It keeps a complete coarse world cover and refines
visible regions with a balanced hierarchy, parent-first loading, warm cache,
stitched spherical edges and shared relief lighting. The maximum exaggeration
slider is 0–200, default 100; physical source heights and queries are unchanged.
High/Balanced/Fast detail settings use sampled screen footprints and hysteresis,
not a certified geometric-error guarantee. Limits are 96 selected leaves,
two fetch/decode jobs and 256 MiB of retained compressed/decoded arrays.
Transient worker, query and GPU memory are not included in that byte limit.
No polar-cap data, temporal height morphing, basemap draping or immersive terrain.
