{/*
tangram-layers
SPDX-License-Identifier: MIT
Copyright (c) vis.gl contributors
 */}

# Terrain integration

<span className="badge badge--warning">Status: Experimental</span>

The [Mercator terrain example](/tangram.gl/examples/deck-terrain) combines
loaders.gl elevation decoding, deck.gl terrain rendering and Tangram's CPU
terrain-query surface. It draws one Mapterhorn Terrarium tile near Zermatt at
physical scale. It is **not** a terrain-enabled Tangram scene: vector basemap
draping, streaming terrain tiles, globe terrain and ground-following are deferred.

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
not automatically no-data. The live example assumes opaque valid pixels; masked
meshes require an explicit hole policy before production adoption.

The loader meshes normalized tile coordinates; the adapter converts Mercator XY
to longitude/latitude for TerrainLayer, leaving physical-meter Z unchanged. This
uses deck's geographic projection path, avoiding the preprojected height-scale
bug tracked in [deck.gl #10790](https://github.com/visgl/deck.gl/pull/10790).
The CPU reference surface converts the **same vertices and indices** to
EPSG:3857 XY and physical-meter Z. Screen picking intersects the triangles in
the active viewport's projected common space and returns barycentric physical
elevation, including occlusion by nearer triangles.

The source grid uses pixel-center registration. The mesh retains TerrainLoader's
boundary registration and replicated final row/column; it is not a bilinear
reconstruction of that grid. Exact sample registration, tile-edge stitching and
terrain-aware basemap draping need a follow-up before production use.

## Validation and limits

Hermetic tests encode a tiny asymmetric Terrarium PNG, parse it with the published
loaders.gl implementation, compare grid and mesh heights, and query its triangles.
GPU tests exercise the mesh on WebGL 2 and WebGPU. Required tests never access
Mapterhorn or a CDN.

Parsing is deliberately main-thread (`core.worker: false`) to avoid implicit
remote workers. Worker transport, cancellation within parsing, edge stitching,
terrain LOD/residency, basemap draping and accelerated queries are follow-ups.
Image decoding disables color-space conversion and alpha premultiplication:
RGB bytes encode data, not display colors.

The classic Mapterhorn style remains a hillshade shader, not displaced terrain.
The normal renderer and layer entries are unchanged. For renderer-owned terrain,
retain the shared data contract and put deck-specific mesh adapters in
`tangram-layers`. TerrainExtension integration must account for Tangram's custom
render pass; attaching an extension alone does not make the basemap drape.
