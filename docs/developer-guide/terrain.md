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
tiles at physical scale. **Draped OpenFreeMap basemap** draws Tangram ground,
landcover, water, roads, buildings and labels over those heights. Uncheck it to
inspect the deck.gl elevation mesh, wireframe and skirts. Opt-in target following
is available; it is not first-person avatar physics.

The [FirstPerson terrain example](/tangram.gl/examples/deck-first-person-terrain)
uses deck's standard FirstPerson controller over the same loaded top triangles.
Drag to look, Shift-drag to translate, arrow keys to walk and scroll to advance.
The actual eye includes local XY meter offsets; both tile selection and the floor
probe follow that eye, not its fixed longitude/latitude anchor. Source detail is
explicit z10, z11 or z12 (clamped to the provider domain), with at most nine local
tiles and their coarse parents. This bounded neighborhood is not horizon coverage
or certified projected-error LOD. Device switches retain downloaded and decoded data.

**Keep eye above terrain** clamps a point eye upward to loaded elevation plus
clearance (20 m by default). Controller translation is held when the endpoint has
no loaded top triangle; looking remains enabled. A finite eye segment, lowered by
the clearance, is also checked against loaded triangles so a large step cannot
silently pass through an intervening ridge.
**Lower eye to loaded terrain** explicitly lowers an airborne camera to that floor;
it does nothing when coverage is missing. These controls do not implement gravity,
avatar volume, walls, tunnels or continuous world-wide collision. Intermediate
unloaded areas are not certified safe. Picking uses the actual
Map/FirstPerson projection and canvas-relative viewport offsets, including split
views, while returning unexaggerated top-triangle height rather than skirt height.

The [Globe terrain example](/tangram.gl/examples/deck-globe-terrain) now defaults to
the same draped OpenFreeMap ground and styled features as the Mercator reference.
Uncheck **Draped OpenFreeMap basemap** for the separate
[GlobeTerrainLayer elevation preview](../api-reference/globe-terrain-layer.md).
The preview resamples physical grids into curved spherical triangles, with a configurable maximum
`globeTerrainExaggeration` of 100 by default. As the apparent globe diameter grows
from one to two viewport diameters, exaggerated relief smoothly attenuates to flat.
Explicit 1× keeps physical-scale relief; zero and subphysical settings stay fixed.
Queries intersect the displayed surface but interpolate source meters, rather than
reporting exaggerated radial altitude or triangle-chord depression.

The globe keeps global z1/z2 ancestors warm while refining visible regions up to
the source limit (Mapterhorn z12). **Terrain detail** selects High, Balanced or Fast
projected-footprint targets with hysteresis; a 96-leaf cap may keep some regions
coarse. The status shows actual loaded detail, pending jobs and resource limits.
The scheduler retains all required ancestors, publishes complete sibling groups,
and rolls back fine groups when loading fallback would violate balanced 2:1 edges.
Fine edge nodes are also inserted into coarse spherical meshes; shared-edge relief
lighting and physical queries use the same sample neighborhood.

The globe requests **height grids only**. It does not decode a second bitmap or
build/retain the adaptive Mercator mesh used by the planar reference. Both outputs
share the same physical sampling, registration, validity and datum contract.

Navigation changes deck's camera immediately, while new detail selection waits
120 ms after the last navigation update. Loaded fallback continues drawing during
motion; there is no lower-resolution interactive mesh. Mesh preparation snapshots
physical samples, hole masks, stitched topology and relief slopes. Zooming only
rescales those prepared buffers; once the display becomes flat, it reuses them.
New tiles invalidate only touching neighborhoods. The globe example uses the
deck-independent `GlobeTerrainPreparation` controller to advance sampling and
stitching with a 4 ms cooperative slice target, paused during navigation. A complete
stitched generation replaces the previous display and physical-query surface
atomically. Old terrain remains visible on cancellation or preparation failure.
The default 96 MiB prepared-template retention cap counts unique current and
staged template buffers; admission failure reports a manual-retry error.
`mountGlobeTerrainExample` accepts `preparationBudgetMs`, `maxPreparedBytes` and
`meshResolution` (uniform cells per tile axis, integer 2–256, default 64).
The diagnostics show pending tiles, reuse, bytes and CPU-slice elapsed times.
The mount also uses `GlobeTerrainDisplayPreparation` from the opt-in terrain entry
to rescale packed vertices and construct matching query surfaces before publishing.
`displayBudgetMs` sets its independent 4 ms default slice target; it runs during
navigation so the latest attenuation/slider request can progress without blocking
the camera callback. Geometry can briefly lag the requested multiplier while a
complete replacement is prepared. The info card distinguishes requested and admitted
relief and reports pending display work, retention, slices and elapsed time.
The display stage also warms picking indexes cooperatively before publication.
Current-plus-staged acceleration is capped, including reservations for cold current
indexes; the card reports warmed and peak-budget-deferred tile counts. Deferred
indexes remain lazy, and insufficient per-tile space keeps exact linear picking.
Near-first bounds traversal reduces work without changing physical height results.

Only one template-to-display handoff runs at a time: further template preparation
waits while display work is pending. Source acquisition and camera updates
continue. A display commit schedules one follow-up to consume the latest cached source
selection. Failed unchanged requests do not create an automatic retry loop; a new
source snapshot or effective multiplier is a new request. Retry is explicit;
changing immutable mount budgets requires remounting. GPU switches keep the same CPU
display controller/snapshot, and unmount closes both preparation stages.
Snapshots held by the display stage can retain older template/source generations;
that cross-owner retention is outside the topology controller's own reported budget.
Neither stage claims a whole-pipeline memory cap.

The layer separately admits current plus replacement display/query geometry under
a 128 MiB retained-array cap. Failure keeps the previous generation visible and
pickable. Lazy picking acceleration has a separate 64 MiB cap; a tile that cannot
fit uses exact linear triangle queries. Query snapshots now own geometry once,
instead of duplicating positions/topology on the first pick. The globe mount accepts
`maxDisplayBytes` and `maxQueryIndexBytes`, both non-negative integer byte limits.
Display diagnostics report actual retained arrays and the last CPU update/pick
elapsed time after rendering or selection, without scheduling another frame.

Clicking globe terrain now pins a geographic sightline target. The inspector
re-samples the admitted triangles after camera or terrain changes and distinguishes
loaded blockers from unknown target coverage. It skips queries on unchanged idle
frames. Screen picking, geographic probes and finite segments share the same bounded
query owners; no new geometry cache is introduced. Missing/no-data geometry does
not certify visibility, and this does not automatically hide basemap annotations.

Renderer hosts can use `TerrainSurfaceCollection`, `sampleTerrainElevation` and
`resolveTerrainClearance` for shared nearest-tile lookup, explicit geographic
probe brackets and a Mercator point-floor constraint. The Mercator example's
target-following helper now uses this collection/probe boundary while retaining
its canonical longitude, source domain, highest loaded top triangle and missing-data
hold behavior. The FirstPerson example integrates point clearance with its controller;
the example additionally guards finite eye segments against loaded top triangles.
That guard is not avatar collision, and missing intermediate coverage remains unknown.

This is not a hard frame-time or peak-memory cap: an indivisible chunk can overrun
its target. Source grids, scratch arrays, the candidate before admission,
display/query buffers, query indexes and GPU uploads are outside this controller's
byte/slice limits. The ordinary layer path still scales synchronously; the globe mount
uses `preparedDisplay` to avoid that work during layer updates. Per-tile query copies,
final typed-array copies remain indivisible. Hierarchy scans and median partitions
now yield; ordinary lazy queries still build synchronously if warming was deferred. The
prepared snapshots are separate from the source-cache budget below and are
released on unmount; GPU switches keep the current CPU snapshot warm.

Rotation, exaggeration and GPU switches do not reset the source cache. Cold detail
can be evicted: retained compressed bytes and decoded arrays have a hard 256 MiB
cap, with at most two fetch/decode jobs, 48 cold records and a 64 MiB cold budget.
The source cap excludes in-flight worker temporaries, render/query meshes and GPU
resources. The display and hierarchy caps above cover their retained CPU arrays,
not temporary decode/scaling/sorting allocations, JavaScript objects, external
snapshots or GPU resources.
The footprint estimate is not a certified curvature/height-error bound. The separate
elevation preview does not temporally morph sibling replacement. Styled draping
uses the renderer's coordinated generation replacement below; it does not claim
fully conforming curved coarse/fine boundary geometry. Worker-side displacement and mocked stereo/XR
conformance are described below; native headset validation remains deferred. Missing
samples remain holes. Source datum is preserved, not converted to ellipsoidal height.

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
replicated final row/column. Touching tiles average shared-edge heights and compute
physical normals with the finest spacing touching each node. Adaptive interior
topology is retained. Same-LOD and 2:1 parent/detail boundaries use the union of
both tiles' boundary nodes, including finer half-steps on the coarse side. Shared
nodes have identical heights and normals, and participate in the physical top
triangles, not just visual walls. This
reconstruction is not a certified post-reconstruction simplification-error bound.

Optional 250 m visual skirts cover incomplete outer boundaries. They are excluded
from physical queries and following. The stitcher accepts adjacent, non-overlapping
footprints with equal sample dimensions and datum, at ratios 1:1 or 2:1. Larger
ratios and overlapping parents reject explicitly. No-data remains a hole on both
sides; skirts do not turn missing data into a physical surface. Antimeridian seams
and arbitrary terrain hierarchies are not certified.

## Streaming and ownership

The example uses Tangram's shared `TileBuildQueue`, `TileResidency` and
`TileCachePolicy`, with an example-local fetch/decode adapter. Defaults are nine
selected detail tiles, their immediate parents, two simultaneous jobs, and an
off-screen cache of 24 records / 32 MiB. A separate **128 MiB hard resident cache
cap** counts compressed bytes and unique backing buffers within each record's
decoded grid, mesh attributes and indices, including selected/fallback records.
Admission evicts cold LRU records before publishing new bytes or topology. If
protected records would exceed the cap, admission fails explicitly; a previously
completed mesh and coarse coverage are retained. Retry is manual, not a request loop.
Decoding can run concurrently, but completed payloads enter the cache in active
parent-first priority order. Under pressure, a pending lower-priority download can
yield its retained bytes and owned worker so coarse coverage can complete; already
completed geometry is not sacrificed. Yielded detail reports a manual-retry error.
Selection expansion preempts older lower-priority jobs so newly queued coarse
coverage starts before detail can publish; cancelled detail retains warm bytes.
Failed, inactive bytes-only records can also yield space to completed detail;
their diagnostic is preserved and no completed mesh is discarded.
`mountTerrainExample(..., {maxResidentBytes})` can lower that cap. The status shows
used and allowed decimal MB.

This is a retained **cache-array** cap, not a browser-process or GPU-memory limit.
Worker intermediates, concurrent decode results before admission, reconstructed
draw/query geometry, query indexes and GPU allocations are separate. Their scope
is bounded by image dimensions, job concurrency and the selected tile window;
whole-pipeline memory admission remains future work. Shared backing buffers across
different records are counted conservatively rather than discounted.
Images are limited to 8 MiB compressed and 1024×1024 power-of-two pixels.

The selected detail window uses one source zoom; the tileset manages immediate
parents internally and rejects overlapping mixed-zoom selections. Parents load
first. A parent stays visible until every selected child in its
group is ready; coarse and fine meshes never overlap. Navigation cancels obsolete
fetches and terminates their owned decoder workers. Late generations cannot
replace newer data. Mesh-error changes reuse retained bytes, and device changes
reuse payloads and view state. Failed tiles require an explicit retry.

Selection is a bounded local window around the camera, limited to global
Mapterhorn z0–12 coverage. It is not a horizon-wide terrain traversal or
projected-pixel-error LOD algorithm. The initial demonstration is near Zermatt;
global wrap seams and arbitrarily wide world views are not certified.

## Projected detail and picking

The tile-footprint control selects data zoom independently of camera zoom and
mesh simplification. It projects the local tile's four edges at a 2500 m reference
plane and targets a maximum CSS-pixel edge length. A 20% deadband reduces
threshold churn. Source limits and the nine-tile window remain enforced. Missing
or behind-camera measurements retain a bounded camera-zoom fallback rather than
requesting maximum detail. The status reports the resolved data zoom and limits.
This is a local footprint heuristic, **not** a certified terrain/pixel-error bound
or a guarantee that the entire visible horizon is covered.

Screen picking uses a retained common-space `TriangleQueryIndex` for each immutable
top mesh. Camera pan, zoom, bearing and resize only change the ray, not the index.
Changing mesh detail or neighbor reconstruction replaces the query geometry. The
legacy pseudo-meter height convention rebuilds the one retained index when its
scale changes. CPU `TerrainMeshSurface` queries also use the shared bounds index;
ray segments, original triangle IDs, physical heights and holes are preserved.

## Ground-following target

Enable **Follow terrain target** to set MapView's geographic target elevation to
the highest loaded top-triangle height plus the selected physical-meter clearance.
Navigation, new decoded tiles and clearance changes recompute it from the same
triangles used by physical queries. No-data or an unloaded target holds the last
elevation and reports that it is waiting; it never substitutes zero. Disabling
following restores the last freely navigated target height. Device changes retain
the controlled view state and cached terrain.

Following moves the **MapView target**, not the actual perspective eye. It does not
guarantee eye clearance, prevent collisions, move a FirstPersonView avatar, or
convert vertical datums. Those require a separate navigation/physics contract.

## Source boundary

`mountTerrainExample(host, {workerUrl, source})` accepts an example-local
`TerrainImageSource`. Omit it to use Mapterhorn. A mount owns one immutable source
and one isolated cache; changing a source requires a new mount. This is a Terrarium
image boundary, not a generic PMTiles/MLT/terrain source API in the renderer.

```ts
import {createTerrainImageSource} from '../../examples/terrain/terrain-source';

const source = createTerrainImageSource({
  id: 'my-terrarium-v1',
  urlTemplate: 'https://example.com/elevation/{z}/{x}/{y}.png',
  minZoom: 2,
  maxZoom: 12,
  noData: 'alpha-zero',
  credits: [{label: 'Dataset credits', url: 'https://example.com/license'}]
});
```

Provider bounds apply to both detail and coarse fallback: a source starting at z2
never requests z1 parents. Credits render as text and HTTP(S) links, never HTML.
The explicit no-data policy is forwarded to the owned worker. Built-in acquisition
reads incrementally, enforces the compressed-byte limit during reading, cancels
the response body on abort/error and imposes a 30-second total fetch/read deadline.
Sources must use physical-meter Terrarium encoding; dataset licensing and datum
remain the host's responsibility. Custom `fetchTile` implementations must honor
the same ownership and cancellation contract.

## Validation and limits

Hermetic tests encode a tiny asymmetric Terrarium PNG, parse it with the published
loaders.gl implementation, compare grid and mesh heights, and query its triangles.
GPU tests exercise the mesh on WebGL 2 and WebGPU. Required tests never access
Mapterhorn or a CDN.

Each mount owns a lazy pool of at most two same-origin module workers. Successful
requests reuse warm workers; a cancelled, timed-out or failed request terminates
its actual worker, with replacement created only when another job needs it.
The pool has no secondary pending queue: `TileBuildQueue` remains the sole
scheduler and excess concurrent submissions reject. Request IDs prevent stale
or duplicated replies from settling later jobs. Device changes keep the pool;
mount teardown releases idle workers and cancels active jobs.

The decoder panel reports constructed/warm workers, completed jobs, retained
grid/mesh bytes, and the last round-trip and worker decode elapsed times.
Round-trip includes startup, transfer and scheduling; decode elapsed includes
async image work. Neither is CPU-only execution time or frame time. Byte
categories sum to the existing retained-array admission total; a backing buffer
shared between categories counts only once per record. Worker heaps, browser
image decoding, render/query meshes and GPU resources are not included.

Decoding runs in a packaged same-origin module worker. Inside that owned worker,
`core.worker: false` avoids nested/CDN workers. Tests compare worker and local
outputs, grid-only/full-mesh conformance, pooled reuse, correlated replies,
cancellation, warm cache, parent fallback, shared edges and physical
queries. Tests also cover 2:1 edge topology/heights/normals without skirts, mixed-detail
no-data, resident admission and atomic replacement, opt-in following and missing
surface behavior. Both GPU backends draw a coarse/fine boundary without skirts and
check physical anchor clearance. Required tests remain hermetic.
Image decoding disables color-space conversion and alpha premultiplication:
RGB bytes encode data, not display colors.

The classic Mapterhorn style remains a hillshade shader, not displaced terrain.
Renderer-owned draping is opt-in through the shared height-grid contract below.
The renderer remains deck-independent; acquisition and deck view/controller
integration belong to the host. Attaching TerrainExtension alone still does not
make Tangram's custom render pass drape.

## Worker-side basemap draping

Pass `terrain: {grids}` to `Renderer.create` or `TangramLayer`. Grids use the
[shared physical height contract](../api-reference/map-logic/terrain-data.md):
absolute EPSG:3857 XY, physical-meter heights, explicit pixel-center/grid-node
registration and a single vertical datum. Current grids must not overlap; previous
grids form a separate generation. Providers and loaders remain host-owned.
Valid heights must be finite and within one Earth radius in magnitude; negative
height/exaggeration combinations that would invert the spherical radius are rejected.

The existing scene workers refine polygons, extruded walls, raster meshes and
road ribbons, then append current/previous height and ENU-slope attributes.
GLSL and WGSL displace before projection, so MapView, FirstPersonView, GlobeView
and host-supplied stereo cameras use the same drawing/feature-selection path.
Set `scene.lighting: configured` when using authored Tangram lights on both
backends; the reference basemap opts into this existing portable lighting path.
Point/text anchors gain the same height, with their pixel shapes retained; screen
collision uses the displaced anchor. Road width/offset interpolation stays in
Tangram. At the authored style zoom, DEM heights/slopes are sampled at the actual
width/offset corners, including source overzoom; other zoom fractions use a local
tangent-plane correction relative to those corners. This improves wide roads but
is not exact DEM sampling at every dynamically extruded corner. Custom position/width blocks and CPU-projected
basemaps are rejected rather than silently applying incompatible displacement.

Changing immutable grids calls `renderer.setTerrain(options)` on existing workers.
It retains decoded vector source data and shader animation time, coalesces pending
updates, and recovers the prior field after a failed rebuild. A failed recovery
blocks rendering until a successful correction. Enabling/disabling draping on a
deck layer recreates its renderer because vertex layouts and shader blocks differ.
Do not mutate grids in place; keep option identities stable until data changes.

`transitionDuration` defaults to 200 ms. Newly admitted meshes blend height and
slope from the last admitted field, or explicit `previousGrids`; missing previous
samples start at their current height, not sea level. Color, collision and both
eyes share a frame clock. `setTerrain` uploads replacements into an isolated stage;
all tile batches must finish before the draw owners swap together. Every replacement
mesh and label receives the same transition origin. Failure discards the entire
stage, then restores worker configuration. This removes asynchronous per-tile
transition starts, but is not a spatial mixed-LOD tessellation/seam guarantee.
`terrainExaggeration` defaults to 1 and is GPU-only:
it does not refetch tiles, resample grids or rebuild topology.

Missing DEM footprints and invalid bilinear neighborhoods suppress triangles.
Conservative footprint/mask checks can remove extra triangles near holes; they
never fill a hole with a zero-height surface. Use `querySurfaceStyles: ['ground']`
to retain the **final ground raster draw triangles**, including current/previous
heights. Polygon buildings, roads and annotations are not ground query owners.
`renderer.getDrapedTerrainSurface()` (also on `TangramLayer`) captures the last
submitted ground display: generation, frame clock, exaggeration and immutable
membership. `getTerrainAt(pixel)` queries it when no explicit surface is supplied.
Physical returned heights remain unexaggerated; hit positions follow displayed
relief. Globe fallback queries use the same clip rectangles as drawing.

The Map, FirstPerson and Globe examples use this surface for picking; Mercator
clearance and finite-eye guards also use it when draping is enabled. They never
fall back to a different adaptive mesh on a missing-ground query. Retained snapshots
continue to describe their original frame after subsequent replacement or relief
changes. The host must supply new frames to advance morphing; a query does not
advance the clock. Arbitrary retained host snapshots are outside renderer budgets.

Opt-in `occludeAnnotations: true` tests point/text fragments against scene depth
in color and selection passes. Non-interactive opaque ground/buildings contribute
selection depth without feature IDs. With `querySurfaceStyles`, collision layout
also omits anchors blocked by loaded ground triangles. Each eye has its own
sightline; a candidate visible in either eye keeps the shared collision mask,
while depth hides fragments separately. Missing ground does not certify occlusion.
This is an anchor test, not a quad-wide occlusion oracle; transparent styles and
arbitrary custom shader depth changes are not modeled by the CPU query.

Default limits are 96 grids per generation, 32 MiB current/previous grid arrays
per scene/worker copy, 131072 additional vertices and 16 MiB completed output per
mesh. Optional ground query channels have a separate 8 MiB per-mesh cap. Replacement
draw/query buffers share a 64 MiB staged-generation cap, checked before GPU upload.
`getTerrainDrapingStatistics()` separates `meshBytes`, `queryBytes` and
`stagedMeshBytes`; these are completed-buffer counts, not whole-pipeline peaks.
Terrain-enabled XY and ribbon attributes are promoted to floats before
refinement; feature IDs, UVs and annotation shapes retain their original channels.
A 1/64-tile edge floor bounds detail independently of DEM resolution; budgets fail
explicitly rather than publishing truncated topology. Refinement, mask-prefix
scratch, structured clones, retained label buffers and GPU copies are **outside**
the completed-output cap. This is not a total memory or frame-time guarantee.
`getTerrainDrapingStatistics()` reports resident vertices/triangles/output bytes,
masked triangles, detail-limited meshes and slowest worker preparation.

Hermetic tests cover CPU boundaries, replacement/recovery, draped vector/raster
output, stereo picking and mocked immersive room cameras on WebGL 2 and WebGPU.
Native headset validation remains a manual gate.

Ground queries use worker-computed extrema of the actual indexed vertices before
allocating projected geometry. Conservative bounds include authored offsets,
both DEM morph endpoints and current relief, including long globe chords and
unwrapped antimeridian coordinates. Collections query nearer bounds first and
skip owners beyond an accepted hit; equal-distance ties retain membership order.
Mercator fallback clips narrow the XY envelope; globe clips retain the full chord
envelope rather than incorrectly treating a curved rectangle as planar bounds.
Custom surfaces can provide optional `getBounds()` or keep the unbounded exact
query path. Bounds are an acceleration hint, not an occlusion/coverage guarantee.

Ground queries project only candidate meshes lazily. Settled displacement reuses
the immutable projected query owner; changing the blend or relief makes a new owner.
`maxProjectedQueryBytes` caps retained projected XYZ, physical-height and topology
arrays at 32 MiB per snapshot by default. Demand is admitted near-first and repeated
clip leases share one owner. Zero or insufficient space uses exact streaming
triangle projection, preserving clips, physical altitude and nearest-hit picking
without retaining another projected mesh. Streaming trades CPU time for bounded
residency; it is not a faster query path. `streamingMeshes` reports affected entries.
The cap excludes immutable worker inputs, transient triangle scratch, separately
retained snapshots and GPU resources; it is not a whole-renderer memory limit.
Morph queries use exact linear triangle traversal, avoiding new per-frame BVHs.
Settled queried owners are warmed cooperatively once per logical frame. The
default `maxQueryIndexBytes` is 16 MiB per snapshot and
`queryPreparationBudgetMs` is a 2 ms scheduling target (range 0–20; zero disables
warming). Reservations follow first bounds-admitted query demand, not display
membership order. Entries skipped by bounds or nearest-hit pruning reserve nothing.
An admitted reservation lasts for that snapshot; later queries use exact linear
traversal if the remaining budget is insufficient. Shared
clip leases reserve an index only once. Cooperative warming rotates between
demanded owners after each slice; cancellation releases every incomplete index.
Conservative display bounds are cached per immutable entry, without projecting
its vertices. Insufficient budget or
failed acceleration retains exact linear queries; it never removes terrain.
Initial lazy projection/copies and streaming queries are synchronous and outside that scheduling target.
`snapshot.getStatistics()` separates projected bytes, reserved/completed indexes,
preparation failures and CPU work. `getTerrainDrapingStatistics().annotationQueries`
reports the internal collision surface separately from retained host snapshots.
Bounds admission skips unrelated Mercator and globe owners. Compatibility payloads
without a worker summary pay one cached indexed-vertex scan; ordinary worker
payloads carry their summary. These small scalar metadata records are outside the
typed-array byte counters. Profiling
must still include these projection/copy and traversal costs: they are not a hard
frame-time guarantee. The globe draping mode skips the separate elevation preview's
template/display preparation and changes exaggeration through GPU uniforms only.
Its global current/previous grid-copy cap is explicitly 256 MiB per scene/worker
and its additional staged draw/query cap is 128 MiB. These are separate from the
256 MiB downloaded/decoded source cache: worker copies multiply retained data.
Local examples retain the smaller renderer defaults.

## Bounded phase acceptance and deferred work

This phase completes the local Mercator reference's streamed source boundary,
warm topology changes, indexed queries, 2:1 fallback stitching, hard resident cache
admission and opt-in target following. It does **not** complete the whole terrain
or WebXR roadmap. The subsequent globe preview adds balanced mixed-detail
displacement and adaptive source selection. Next larger features remain certified
pixel-error LOD, draping/morphing parity on wide dynamic ribbons and mixed-LOD
boundaries, whole-pipeline/GPU memory admission, avatar collision, quad-wide terrain
occlusion, polar terrain and native headset validation. Opt-in billboard depth and
loaded-anchor occlusion are implemented, but do not certify visibility beyond loaded triangles. None is
implied by this example's successful rendering or CPU queries.
