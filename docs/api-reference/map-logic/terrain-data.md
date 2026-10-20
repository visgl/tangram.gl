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

## Shared data and query contracts

`TerrainHeightGrid` is structurally compatible with the proposed loaders.gl terrain
height-grid contract: physical Float32 samples, explicit validity, unwrapped
EPSG:3857 bounds, registration and vertical datum. A decoded grid can enter
`TerrainHeightField` directly without an RGB re-encode, another image parse, or
display exaggeration. Treat its sample arrays as immutable while shared.

`adaptTerrainQuerySource(source)` accepts a read-only external surface and returns
Tangram's existing `TerrainSurface` interface. Import it and `TerrainQuerySource`
from `@vis.gl/tangram-renderer/map-logic`. No loaders.gl version upgrade is required.

```ts
const surface = adaptTerrainQuerySource(externalTerrainSurface);
const hit = tangramLayer.getTerrainAt({x, y}, surface, {renderViewId: 'left'});
```

The source supplies `projection`, `intersectRay(ray, maxDistance?)`, and optionally
`getBounds()`. Rays and displayed positions use the same content units (Mercator
XYZ meters or Tangram's radius-256 globe convention). Hit `coordinate` is longitude,
latitude and **physical source elevation meters**, independently of displayed
exaggeration. Distance is in content units, not the unnormalized ray parameter.

The adapter borrows the provider, preserves receiver identity and detaches returned
tuples; it does not dispose resources, build an index or cache a geometry generation.
Optional bounds distinguish unknown (method absent) from empty (null). A query miss
does not certify coverage. The provider must publish draw/query generations together.

The structural boundary deliberately avoids unpublished loaders.gl exports and a
dependency on community's layer package. Tangram's worker mesh compilation and
production query index remain unchanged. The published math.gl `5.0.0-alpha.18`
BVH is compared in ordinary Node CI, including accepted-hit rejection, nearest-face
ties, non-unit rays and exact distance cutoffs at multiple scales. It remains a
development-only candidate: cooperative construction, exact linear fallback and
memory admission still need matching contracts before replacing the current index.

To verify built candidate working copies together, without a release or network:

```sh
TANGRAM_TERRAIN_LOADERS_ROOT=/path/to/loaders.gl \
TANGRAM_TERRAIN_COMMUNITY_ROOT=/path/to/deck.gl-community \
TANGRAM_TERRAIN_MATH_ROOT=/path/to/math.gl \
yarn test-terrain-contracts
```

Build all four repositories first. This explicit Vitest project compares the
actual package implementations on 2,646 sampling cases, routes a shared query
through both consumer adapters and checks emitted public declaration assignability.
It also compares retained/upstream neighborhood fields, reconstructed seam nodes,
and accepted triangle hits against both accelerated and zero-budget legacy queries.
The upstream coverage field intentionally rejects representable gaps and missing
support on closed probe edges more strictly than the retained area-tolerance path.
It is separate from ordinary CI because the other candidate checkouts are required;
each repository's normal tests exercise its own boundary without sibling repositories.

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
translation, avoiding subtractive precision loss during sampling. `normalizedPositions`
contain exact dyadic world fractions (X from the western edge, Y southward from
the northern edge) for source-local packing without Mercator subtraction.
Interior stitch points use dyadic weights rather than one-third centroids. Arrays may
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

`new GlobeTerrainPreparation(maxRetainedBytes, {resourceBudget})` optionally
shares admission with other registered owners. The controller checks exact
final typed-template bytes before allocating gradients and output buffers;
`requiredPeakBytes` reports the current-plus-candidate requirement. Temporary
JavaScript topology, sampling masks and source arrays are outside that fence.
The lower-level generator's optional `onAllocate(bytes, identity)` callback may
throw to reject allocation; the identity cannot be scaled until preparation
returns successfully.

`cancel()` abandons staged work, releases its reservations and preserves the
completed snapshot. A subsequent identical `request()` can restart it. Failure
still requires `retry()` or a changed request; it does not retry every frame.

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

## Error envelopes and admission

`measureTerrainError(grid)` caches physical extrema and directional bilinear
gradient bounds by immutable grid identity. `boundTerrainMeshError(envelope,
resolution)` returns a conservative physical-height bound and radius-256
spherical curvature bound for dyadic resolutions 2–64. It deliberately
overestimates ramps; it is not an RMSE fit or an estimate of unloaded source detail.

`selectTerrainMeshResolution(grids, {pixelsPerMeter, pixelsPerGlobeUnit,
targetPixels, previousResolution})` chooses a bounded dyadic resolution with a
20% coarsening deadband. The caller must supply conservative projection scales,
including exaggeration. `limited` remains true when the cap or invalid samples
prevent satisfying the requested envelope. `boundProjectedDisplacement(matrix,
minimum, maximum, viewport)` bounds a projective transform over an entire XYZ box;
it returns null when the box crosses the eye plane rather than certifying a
center-only projection estimate.

`TerrainResourceBudget(byteLimit)` is an application-owned admission pool.
`reserve('retained' | 'transient' | 'gpu', bytes)` returns an independent lease or
null. A lease supports atomic `resize(bytes)` and idempotent `release()`. Rejected
reservations leave incumbent owners untouched. Diagnostics separate retained CPU,
transient reservations and GPU estimates and record their simultaneous peak.
Only registered owners are covered; this is not browser-process measurement.

`reserveAll(requests)` admits a complete batch or returns null without changing
incumbent bytes, leases or peak. Entries contain `domain`, `bytes`, and an optional
shared `identity`. `reserveShared(identity, domain, bytes)` retains one immutable
allocation across owners: matching metadata counts its bytes once, while every
owner must release its own lease. A shared lease cannot resize the allocation.
Incompatible metadata rejects the whole batch before mutation.

Pass the same pool to template and display preparation to preserve accounting
when a displayed generation still references a retired source template. Template
bytes remain registered until the last preparation/display owner releases them.
External snapshots retained after their controller retires them need separate
application lifetime accounting. Lazy query indexes, scratch storage, driver
overhead and unregistered buffers are not silently included in these totals.

## Conservative navigation

`TerrainHeightField.getHeightRange(bounds)` returns bilinear cell extrema over a
fully covered rectangle, or null for gaps and no-data. It uses the
same registration and missing-support rules as height sampling.

`guardTerrainMotion(field, start, end, {radius, clearance, maxStep, maxProbes})`
checks the full swept square footprint in bounded slices. XY/radius use absolute
EPSG:3857 meters; Z/clearance use physical vertical meters. Convert a physical
horizontal avatar radius to Mercator units at the path latitude. Missing coverage
and work-budget exhaustion block translation explicitly; a clear endpoint is not
enough. Range bounds may reject a clear path conservatively. This is a height-field
guard, not wall, tunnel, gravity or rigid-body physics.
