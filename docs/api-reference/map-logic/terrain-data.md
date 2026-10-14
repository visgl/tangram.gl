{/*
tangram-layers
SPDX-License-Identifier: MIT
Copyright (c) vis.gl contributors
 */}

# Terrain data

<span className="badge badge--warning">Status: Experimental</span>

Import from `@vis.gl/tangram-renderer/map-logic`. These CPU helpers do not fetch
images, render terrain or require deck.gl/loaders.gl.

```ts
import {TERRARIUM_DECODER, decodeTerrainHeightGrid, sampleTerrainHeight}
  from '@vis.gl/tangram-renderer/map-logic';

const grid = decodeTerrainHeightGrid({
  width: image.width,
  height: image.height,
  pixels: image.data,
  decoder: TERRARIUM_DECODER,
  bounds: [westMeters, southMeters, eastMeters, northMeters],
  registration: 'pixel-center',
  verticalDatum: 'unknown'
});
const elevationMeters = sampleTerrainHeight(grid, [xMeters, yMeters]);
```

## Decoding

`ElevationDecoder` matches loaders.gl's byte-channel coefficients: `rScaler`,
`gScaler`, `bScaler`, `offset`. `TERRARIUM_DECODER` and `TERRAIN_RGB_DECODER` return
meters; custom decoders must also return meters. Input is linear RGBA bytes,
at least 2×2. Color conversion and datum conversion are caller responsibilities.

`decodeTerrainHeightGrid(options)` copies heights into Float32 storage and copies
bounds and validity. Input mutation cannot change the result; returned arrays
are caller-owned and should be treated as immutable while shared. An optional
pixel-aligned `valid` mask marks holes with zero and NaN height. Alpha has no
implicit meaning. Invalid dimensions, bounds, coefficients, datum, registration
or overflowing heights throw.

## Sampling

`sampleTerrainHeight(grid, [x, y])` returns bilinear meters or `null` outside the
footprint or across a contributing no-data sample. Rows start at north; columns
start at west. `pixel-center` places samples half a cell inside the footprint
and clamps half-cell borders; `grid-node` includes both edges. Exact-node queries
ignore zero-weight invalid neighbors.

This is a data lookup, not a simplified mesh query. Use TerrainMeshSurface to
intersect the actual rendered triangles. See [terrain integration](../../developer-guide/terrain.md)
for the loaders.gl/deck.gl reference and remaining limitations.

## Neighbor reconstruction

`sampleTerrainNeighborhood(grids, [x, y])` averages all touching footprints at a
shared boundary, independent of tile order. A contributing hole returns `null`;
it is not filled from another tile. Supply same-resolution grids in EPSG:3857
meters, with compatible vertical datums.

`resampleTerrainNodes(grid, neighbors)` reconstructs a detached `grid-node` field.
Pixel-center inputs produce `(width + 1) × (height + 1)` explicit nodes; node
inputs retain their dimensions. Neighbor dimensions, extents and datums must
match. Invalid nodes retain a zero validity byte and NaN height. These helpers
define physical data continuity, not mesh simplification or mixed-LOD stitching.

## Reusable indexed height fields

For repeated lookups, create `new TerrainHeightField(grids, {maxMaskBytes})` and
call `sampleHeight([x, y])`. It produces the same ordered bilinear arithmetic as
`sampleTerrainNeighborhood`, including touching-edge averaging and holes, but
indexes footprints before visiting samples; fields of 16 grids or fewer use a
direct lookup to avoid tree overhead. Mixed resolutions and overlapping
footprints are allowed for sampling; datums must match. No implicit wrapping,
datum conversion or higher-resolution preference is introduced.

`coversBounds([west, south, east, north])` conservatively requires loaded coverage
and valid bilinear-support samples across a rectangle or finite line. A point uses
the normal height sampler. Overlapping footprints are unioned, never counted twice
to fill an unloaded gap. This is rectangular admission, not an exact triangle mask
or a guarantee about interpolated draw geometry.

The default `maxMaskBytes` is 8 MiB of **retained prefix arrays** per field. Prefixes
are lazy and reused; fully valid sources keep no array. Zero or insufficient budget
scans the exact sample support without allocating a prefix, preserving results.
Construction retains source arrays rather than copying them: membership and bounds
are snapshotted, but callers must keep decoded heights/validity immutable. Replace
the field when arrays change. Prefix scans/construction are synchronous; sources,
tree metadata and temporary work are outside the byte cap.

`getStatistics()` returns detached scalar counts: `grids`, `maskBytes`, `maskBuilds`,
`maskSamples`, `boundsTests` and `candidateGrids`. Counts accumulate for the owner;
they measure work and retention, not elapsed time or whole-pipeline memory.
These helpers remain CPU-only and are exported from the existing `map-logic` entry.

## Canonical ground topology

`createTerrainGroundTopology(grids, bounds, resolution = 32, maxVertices = 131072)`
returns complete counterclockwise DEM triangles intersecting an EPSG:3857 ownership
rectangle, accepting at most 96 footprints. Footprints must be non-overlapping square quadtree tiles with balanced
2:1 edges; resolution is a power of two from 2 to 64. Unsupported geometry or an
exhausted vertex limit throws without publishing partial arrays.

The detached `positions` contain unwrapped absolute XY pairs; `indices` contain
triangles. `samplePositions` retain exact periodic XY before `sampleOffset` world
translation, avoiding subtractive precision loss during sampling. Arrays may
alias when no translation is needed. No heights, source fetches, GPU resources or
provider state are owned. Treat input grids/arrays as immutable; validated patch
metadata is reused by field-array identity.

Triangles are deliberately **not clipped to bounds**. A host must clip drawing
and querying to the ownership rectangle; otherwise adjacent source owners overlap.
This retains identical curved triangles across source-detail/fallback boundaries.
It is not arbitrary polygon subdivision, a height decoder, no-data admission or
an error-controlled terrain scheduler. The renderer adapter applies height/mask
admission and half-open source clips; see
[conforming raster ground](../../developer-guide/terrain.md#conforming-raster-ground).

## Globe display meshes

`buildGlobeTerrainMesh(grid, {exaggeration, resolution, neighbors})` resamples a
Mercator height grid onto curved globe triangles. Effective exaggeration defaults
to 1; resolution defaults to 64 cells per axis and is bounded to `[2, 256]`.
Returned `geographicPositions` contain packed longitude/latitude/display-height
attributes. `positions` contain matching radius-256 common-space XYZ for queries,
`physicalHeights` preserve source meters, and `indices` omit no-data cells.
`colors` contain baked relief shading. Source grids are unchanged; same-LOD
neighbors reconcile shared edges and antimeridian copies, including balanced 2:1
footprints. Boundary rings include finer edge nodes; relief lighting uses shared
finite-difference slopes in spherical coordinates. Overlaps and unbalanced edge
footprints reject. Source bounds must stay
inside the EPSG:3857 world and share a datum.

For repeated display changes, call `prepareGlobeTerrainMesh(grid, {resolution,
neighbors})` once, then `scaleGlobeTerrainMesh(template, exaggeration)` on zoom or
slider updates. Preparation snapshots physical samples, slopes, spherical frames,
no-data holes and stitched topology. The opaque handle exposes `vertexCount`,
`triangleCount` and retained typed-array `byteLength`; source changes require a new template. Handles belong to the
module instance that prepared them and cannot be serialized or transferred to a
worker. Scaling returns detached
buffers, so changing one result cannot corrupt subsequent results. It performs no
source sampling or topology reconstruction. `buildGlobeTerrainMesh` remains the
one-shot convenience API using the same pipeline.

## Cooperative globe preparation

`GlobeTerrainPreparation` prepares a complete stitched dataset across host-driven
slices. It has no timer, worker, network or deck.gl dependency. The normal
synchronous helpers remain available and produce the same packed geometry.

```ts
import {GlobeTerrainPreparation} from '@vis.gl/tangram-renderer/map-logic';

const preparation = new GlobeTerrainPreparation(96 * 1024 * 1024);
preparation.request(heightGrids, 64);

// Call once per animation frame when navigation is idle.
preparation.advance(4);
const snapshot = preparation.getSnapshot();
if (snapshot) {
  // Publish snapshot.grids and preparedTerrain: snapshot together.
}
```

`request(grids, resolution = 64)` replaces obsolete staged work, reusing unchanged
source identities and touching neighborhoods, including wrapped edges. Treat all
source grids as immutable. `advance(budgetMs = 4, now?)` runs at least one chunk,
then yields after the elapsed target. It returns true only on a complete commit.
The clock must be monotonic; the optional clock supports deterministic tests.
Allocation, row processing and final array packing are indivisible, so the target
is **not** a hard frame-time bound. Scaling, query indexing and GPU uploads are
outside these slices.

`getSnapshot()` returns only the latest completed generation. While a replacement
is pending or fails, the previous snapshot remains drawable and pickable; partially
stitched neighborhoods are never published. `getPreparedGlobeTerrainTemplate(snapshot,
grid)` resolves a template by exact source identity and rejects forged handles.
`prepareGlobeTerrainMeshSteps(grid, options)` exposes the lower-level generator;
consume its return value or close it to abandon unfinished work.
`assertGlobeTerrainPreparationSnapshot(snapshot)` verifies a completed library
handle, including an empty generation. `scaleGlobeTerrainMeshSteps(template,
effectiveExaggeration)` yields every 128 vertices while producing the same packed
positions, colors, indices and physical heights as `scaleGlobeTerrainMesh`.
It does not resample or restitch; final typed-array copies are indivisible.
The optional layer-side [display controller](../globe-terrain-layer.md#prepareddisplay-optional)
combines this generator with atomic query snapshots and geometry admission.

The constructor limits unique **retained template buffers across current and
staged generations**, default 96 MiB. Admission failure discards staged work and
keeps current terrain. It does not automatically retry: call `retry()` or request
a changed dataset/resolution. This is not a peak/process/GPU cap: source grids,
JavaScript scratch arrays, the candidate being admitted, display/query arrays,
and externally retained snapshots are excluded. `getStatistics()` reports pending
tiles, new/reused templates, retention, slice counts and CPU elapsed times; it is
not FPS. `destroy()` closes pending work and releases owned references. A caller
that retains a snapshot remains responsible for releasing it.

`getGlobeTerrainExaggeration(globeScreenRatio, maximum = 100)` supplies the display
policy: maxima above 1 apply while the globe fits, with a smooth logarithmic fade
to 0× when the apparent diameter reaches two shorter viewport dimensions. It
accepts maxima in `[0, 1000]`; zero keeps displacement flat at every zoom, and
subphysical values remain fixed rather than fading upward. Physical source heights
are unchanged. This helper has no deck.gl, camera or GPU dependency.

See [GlobeTerrainLayer](../globe-terrain-layer.md) for the optional deck.gl adapter.
