{/*
tangram-layers
SPDX-License-Identifier: MIT
Copyright (c) vis.gl contributors
 */}

# Terrain integration

<span className="badge badge--warning">Status: Experimental</span>

The [Mercator terrain example](/tangram.gl/examples/deck-terrain) combines
loaders.gl elevation decoding, deck.gl terrain rendering and Tangram's CPU
terrain-query surface. It streams a bounded neighborhood of Mapterhorn Terrarium
tiles at physical scale. It is **not** a terrain-enabled Tangram scene: vector
basemap draping, globe terrain and ground-following are deferred.

## Ownership and coordinates

- **loaders.gl** decodes elevation and generates the mesh. The example explicitly
  requests mesh output from TerrainLoader v5 instead of deck.gl's built-in v4
  loader. Simplification changes reuse downloaded bytes.
- **deck.gl** owns MapView, controllers, TerrainLayer, lighting and GPU resources.
  The example supplies the decoded mesh through TerrainLayer's `fetch` boundary.
- **Tangram** provides the optional CPU height-grid contract and TerrainMeshSurface.
  The renderer has no new deck.gl or loaders.gl runtime dependency.

The [height grid](../api-reference/map-logic/terrain-data.md) stores physical meters
in north-to-south rows, with explicit registration, validity and vertical datum.
The POC carries the datum as `unknown`; no datum conversion is implied. Alpha is
not automatically no-data. The live example assumes opaque valid pixels. The
decoder also accepts an explicit `alpha-zero` policy: invalid contributing samples
remove entire reconstructed cells instead of bridging holes with adaptive triangles.

The loader meshes normalized tile coordinates; the adapter converts Mercator XY
to longitude/latitude for TerrainLayer, leaving physical-meter Z unchanged. This
uses math.gl's north-positive common-world Y (`(worldY - 256) × circumference / 512`
for EPSG:3857), not the south-positive XYZ tile-row convention. It
uses deck's geographic projection path, avoiding the preprojected height-scale
bug tracked in [deck.gl #10790](https://github.com/visgl/deck.gl/pull/10790).
The CPU reference surface converts the **same vertices and indices** to
EPSG:3857 XY and physical-meter Z. Screen picking intersects the triangles in
the active viewport's projected common space and returns barycentric physical
elevation, including occlusion by nearer triangles.

The source grid uses pixel-center registration. The display mesh resamples those
physical samples at explicit boundary nodes instead of using the loader's
replicated final row/column. Touching, same-resolution tiles average shared-edge
heights and compute the same physical normals. Adaptive interior topology is
retained; full-resolution boundary nodes prevent same-LOD T-junctions. This
reconstruction is not a certified post-reconstruction simplification-error bound.

Optional 250 m visual skirts cover incomplete and mixed-LOD boundaries. They are
excluded from the physical query mesh. Skirts are a seam treatment, not complete
mixed-LOD stitching or terrain-aware basemap draping.

## Streaming and ownership

The example uses Tangram's shared `TileBuildQueue`, `TileResidency` and
`TileCachePolicy`, with an example-local fetch/decode adapter. Defaults are nine
selected detail tiles, their immediate parents, two simultaneous jobs, and an
off-screen cache of 24 records / 32 MiB. Selected/fallback resources are protected
separately from that off-screen budget; the total is not a hard 32 MiB cap.
Images are limited to 8 MiB compressed and 1024×1024 power-of-two pixels.

Parents load first. A parent stays visible until every selected child in its
group is ready; coarse and fine meshes never overlap. Navigation cancels obsolete
fetches and terminates their owned decoder workers. Late generations cannot
replace newer data. Mesh-error changes reuse retained bytes, and device changes
reuse payloads and view state. Failed tiles require an explicit retry.

Selection is a bounded local window around the camera, limited to global
Mapterhorn z0–12 coverage. It is not a horizon-wide terrain traversal or
projected-pixel-error LOD algorithm. The initial demonstration is near Zermatt;
global wrap seams and arbitrarily wide world views are not certified.

## Validation and limits

Hermetic tests encode a tiny asymmetric Terrarium PNG, parse it with the published
loaders.gl implementation, compare grid and mesh heights, and query its triangles.
GPU tests exercise the mesh on WebGL 2 and WebGPU. Required tests never access
Mapterhorn or a CDN.

Decoding runs in a packaged same-origin module worker. Inside that owned worker,
`core.worker: false` avoids nested/CDN workers. Tests compare worker and local
outputs, cancellation, warm cache, parent fallback, shared edges and physical
queries. Pixel-error LOD, exact mixed-detail stitching, basemap draping and
accelerated queries remain follow-ups.
Image decoding disables color-space conversion and alpha premultiplication:
RGB bytes encode data, not display colors.

The classic Mapterhorn style remains a hillshade shader, not displaced terrain.
The normal renderer and layer entries are unchanged. For renderer-owned terrain,
retain the shared data contract and put deck-specific mesh adapters in
`tangram-layers`. TerrainExtension integration must account for Tangram's custom
render pass; attaching an extension alone does not make the basemap drape.
