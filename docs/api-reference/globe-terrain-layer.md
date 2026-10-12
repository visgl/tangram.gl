{/*
tangram-layers
SPDX-License-Identifier: MIT
Copyright (c) vis.gl contributors
 */}

# GlobeTerrainLayer

<span className="badge badge--warning">Status: Experimental</span>

Render physical DEM grids as displaced terrain in deck.gl `GlobeView`. This is a
separate layer, not terrain draping in `TangramLayer`. Importing it is opt-in:
the normal package entry does not include mesh-layers or this adapter.

```ts
import {GlobeTerrainLayer} from '@vis.gl/tangram-layers/experimental/terrain';

const terrain = new GlobeTerrainLayer({
  id: 'terrain',
  data: heightGrids,
  globeTerrainExaggeration: 100
});
```

See the [live globe terrain example](/tangram.gl/examples/deck-globe-terrain).
Install `@deck.gl/mesh-layers` alongside the package's normal peer dependencies.

## Properties

### `data` (required)

Immutable `TerrainHeightGrid[]` in absolute EPSG:3857 meters with physical heights,
explicit validity, registration and one shared vertical datum. Use non-overlapping
tiles with balanced 2:1 edge neighbors; matching edges average heights, including the
antimeridian. Cells touching missing samples are omitted, not bridged. Do not
mutate grids in place: replace each changed grid object and the data array after
changing source samples. Grid identity is the preparation-cache key; replacing
only the array does not invalidate unchanged grid objects.
Validity is checked over each cell's complete interpolation footprint, so source
holes smaller than the display mesh remain holes, including touching neighbors.
All tiles use the same `meshResolution`. Coarse boundary triangles include the
fine tile's extra edge nodes, preventing T-junctions. Relief colors use common
sample-neighborhood slopes in spherical coordinates rather than independent
triangle normals, so shared vertices have matching lighting. This does not morph
heights through time: newly loaded sibling groups replace their parent together.

### `globeTerrainExaggeration` (number, default `100`)

Maximum display multiplier, range `[0, 1000]`. The example provides a live
`0–200` slider, default `100`. Exaggeration above `1` applies while the globe's apparent
diameter fits the shorter viewport dimension. A smooth logarithmic fade reaches
`0` at two viewport diameters (one diameter doubling). The policy uses actual
camera scale and viewport dimensions rather than assuming a particular zoom value.
`1` always renders physical scale. `0` removes displacement at every zoom;
values between `0` and `1` stay at that reduced scale rather than fading upward.
Original source heights and physical elevation queries are never modified.

### `meshResolution` (integer, default `64`)

Uniform curved cells per tile axis, range `[2, 256]`. Allocation and work are bounded
per tile, not per supplied dataset. The host must bound tile count and cache use.
This is a preview sampling policy, not a certified geometric-error LOD algorithm.
Cells spanning 180° or more longitude reject instead of producing degenerate triangles.
Zero-area triangles caused by packed-coordinate precision also reject; increase
the source footprint or use a local-coordinate terrain adapter for such tiny tiles.

### `wireframe` (boolean, default `false`)

Show mesh edges. Otherwise vertex colors provide baked spherical relief lighting;
no extra shader, texture, light effect or backend-specific normal transform is needed.

### `preparedTerrain` (optional)

A completed `GlobeTerrainPreparationSnapshot` from the renderer's
[`GlobeTerrainPreparation`](./map-logic/terrain-data.md#cooperative-globe-preparation).
Supply its `grids` as `data`, in the same order, with matching `meshResolution`.
Mismatched identities/resolution and forged templates reject. The layer skips
source sampling and stitching, then performs its normal synchronous display
scaling and physical-query setup. Without this prop, preparation remains
synchronous. The experimental globe example advances preparation in idle
animation-frame slices and atomically publishes completed generations.

### `preparedDisplay` (optional)

A completed `GlobeTerrainDisplaySnapshot` from the opt-in
`GlobeTerrainDisplayPreparation` export. It contains a complete matching draw/query
generation, not partially scaled buffers. Use `snapshot.terrain.grids` as `data`
and `snapshot.terrain.resolution` as `meshResolution`. If supplied, `preparedTerrain`
must be that same `snapshot.terrain`. Both budget props must match the controller.
Forged display handles reject, including empty handles.

In this mode, the snapshot's **effective** `exaggeration` controls display geometry.
The layer does not automatically rescale it on camera changes: the host requests
the desired effective multiplier from the controller. `globeTerrainExaggeration`
remains the host's maximum control, not an additional multiplier on cached geometry.
Rotation, wireframe changes and device replacement reuse the admitted CPU buffers
and query surface. The ordinary synchronous path remains unchanged without this prop.

```ts
import {GlobeTerrainLayer, GlobeTerrainDisplayPreparation}
  from '@vis.gl/tangram-layers/experimental/terrain';

const display = new GlobeTerrainDisplayPreparation(); // owns no animation loop
display.request(terrainSnapshot, effectiveExaggeration);
display.advance(4); // repeat in later frames until complete; retarget when needed
const snapshot = display.getSnapshot(); // previous complete generation while pending
if (snapshot) {
  const layer = new GlobeTerrainLayer({
    data: snapshot.terrain.grids,
    meshResolution: snapshot.terrain.resolution,
    preparedDisplay: snapshot
  });
}
```

`request(terrainSnapshot, effectiveExaggeration)` is latest-request-wins; unchanged
requests, including failures, do not restart. `advance(budgetMs = 4, now?)` runs at
least one chunk and returns true only when a whole generation commits. Rescaling
yields every 128 vertices without re-reading DEM samples or changing topology.
Query-snapshot construction remains an indivisible per-tile step. Rendering and
picking switch together; cancellation or admission/scaling failure retains the
previous complete generation. `retry()` retries explicitly, `isPending()` reports
work, and idempotent `destroy()` releases owned references.

Picking hierarchies are warmed cooperatively before publication when their
current-plus-staged storage fits `maxQueryIndexBytes`. Bounds scans and in-place
median partitioning yield between chunks; partial indexes are never traversed.
Cancellation releases their arrays. The budget reserves even cold current indexes,
since an input event can allocate them between host slices. If peak space is
insufficient, warming is deferred without rejecting geometry: the admitted tile
retains its ordinary lazy policy. A tile exceeding its per-tile quota instead uses
exact linear queries. Warming is not a guarantee that every first pick is allocation-free.

Constructor options are `maxDisplayBytes` (128 MiB) and `maxQueryIndexBytes` (64 MiB).
Whole-generation preflight precedes replacement display allocations, counting reused
tile handles once. `getStatistics()` reports complete retained geometry and allocated
acceleration arrays, the preflight `requiredPeakBytes`, pending/new/reused tiles,
commits/cancellations, `warmedIndexes`/`deferredIndexes`, slice times and errors.
Allocated in-progress hierarchy arrays are included in acceleration accounting.
In-progress scaling arrays and query-copy
scratch are excluded from **retained completed** storage, not from CPU elapsed time.
These are cooperative targets and owned-array budgets, not hard frame-time,
whole-process or GPU-memory guarantees. External handles remain caller-owned after
the controller is destroyed; do not retain old snapshots indefinitely.

## `pickTerrain(viewport, [x, y])`

Call on the current initialized layer and the viewport that rendered it. Pixels
are top-origin deck canvas CSS coordinates, including viewport offsets. Returns
the nearest `TerrainSurfaceHit` or `null`. Displayed triangles determine visibility;
`coordinate[2]` interpolates **physical source meters**. `position` and `distance`
remain radius-256 common-space geometry values. No-data holes return no hit.
Backface culling is shared by drawing and querying, so missing front-side samples
do not reveal or select the far hemisphere.
Closed tile bounds prune unrelated rays before allocating each lazy triangle index.
Prepared indexes visit nearer child bounds first and skip farther leaves after
accepting a closer hit. Equal-distance hits still use the original triangle order,
and rejected backfaces do not hide farther accepted triangles.
Camera rotation at a fixed display scale reuses meshes and query surfaces. Zoom
or exaggeration changes rescale prepared physical samples and relief slopes without
resampling source grids or rebuilding stitched topology. Once exaggerated mode
reaches flat, further zooming retains those buffers. Adding/removing tiles
invalidates only affected touching neighborhoods, including antimeridian corners;
other meshes and query surfaces stay warm. Wireframe-only updates retain geometry.
The cache holds only the current dataset, not historical mesh variants. A device
change creates new owned render resources without discarding decoded grids.

The renderer's `TerrainMeshSurface` now also accepts optional `physicalHeights`
per vertex. It snapshots those values so exaggerated geometry can be queried
through `pickTerrainAt` and existing `HostFrame` eye routing without changing
the renderer's deck-independent camera contract.

## Geographic probes and finite sightlines

`sampleElevation([longitude, latitude])` radially queries the **admitted** display
generation, even after a replacement is rejected. Conservative owned XYZ bounds
bracket exaggerated relief; returned `coordinate[2]` remains physical source
meters. The hit position follows the exact displayed triangles, including chord
error, and is suitable as a current sightline target. Missing data returns `null`.

`intersectTerrainSegment(start, end, {startInset = 0, endInset = 0})` returns the
nearest loaded blocker, or `null`. Endpoints, inset distances and returned hit
distances use radius-256 globe common coordinates. `surfaceId` is a generation-local
surface index, not a provider tile ID. Queries share the admitted meshes, face
culling and warmed/bounded indexes used by picking; they allocate no new geometry.
`queryMs` includes the most recent probe/segment query as well as screen picking.

The globe example pins a geographic target when clicked. Rotation and new admitted
terrain re-sample that target and test the camera-to-target segment with a small
endpoint trim. The card reports blockers or **visibility unknown** when the target
is not loaded. A miss reports only that loaded geometry supplied no blocker—not
that the Earth, missing terrain or other layers are transparent. Idle frames reuse
the result; clear-target, device changes and teardown preserve ownership boundaries.
This inspector does not yet hide labels, drape a basemap or implement avatar collision.

## Memory admission and diagnostics

`maxDisplayBytes` defaults to 128 MiB and accepts a non-negative integer.
It admits the **current plus replacement** geographic/color/index buffers and
immutable query geometry/physical heights before allocating replacement display
arrays. Reused tiles count once. If admission fails, the entire previous generation
remains drawn and pickable; `getStatistics().error` explains the failure. Increasing
the budget or reducing data/resolution retries on the next props update. Empty data
always releases geometry, even after lowering a budget below the retained size.
Lowering a limit does not forcibly discard already displayed fallback.

`maxQueryIndexBytes` defaults to 64 MiB, divided equally among the current tiles.
Lazy packed hierarchy arrays cannot exceed that shared cap. A tile whose hierarchy
does not fit uses exact linear queries; zero disables acceleration, not picking.
This trades query speed for bounded retained acceleration storage.
Budget changes take effect when a replacement generation is admitted; a rejected
replacement keeps the previous generation's hierarchy policy too.

`getStatistics()` returns detached admitted `tileCount` and `exaggeration`,
`displayBytes`, `queryIndexBytes`, `error`,
`updateMs` and `queryMs`. Timings include synchronous CPU update/query work and
lazy hierarchy construction, not GPU time or frame rate. Display accounting is
56 bytes per vertex plus 24 bytes per triangle. Source grids, prepared templates,
temporary scaling/sorting arrays, JavaScript objects, external retained layers and
GPU allocations are outside these caps. The separate preparation controller owns
the template budget; neither controller claims a whole-process peak-memory cap.

## Limits

GlobeView only. Vertex-transforming `modelMatrix` and layer extensions reject,
so displayed positions cannot silently diverge from CPU queries.
Constrain the host's view state to `zoom <= 12`: deck.gl 9.4 changes GlobeView
to WebMercatorViewport above that threshold. The example sets `maxZoom: 12`
and also clamps its controlled state to stay spherical.
No basemap/annotation draping, automatic tile fetching in the layer, or datum
conversion. The example selects balanced mixed detail from sampled projected
footprints, preserves global coarse coverage, and bounds selected leaves and
retained source arrays. This is not a certified terrain-error LOD algorithm or a
total GPU/transient-memory budget. The Mercator DEM stops at ±85.05°; polar
terrain is not invented. Immersive WebXR/stereo validation remains future work.
