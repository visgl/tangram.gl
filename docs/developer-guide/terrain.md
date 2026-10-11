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
basemap draping is deferred. Opt-in target following is available
in this bounded Mercator example; it is not first-person collision physics.

The [Globe terrain example](/tangram.gl/examples/deck-globe-terrain) uses the separate
[experimental GlobeTerrainLayer](../api-reference/globe-terrain-layer.md). It resamples
physical height grids into curved spherical triangles, with a configurable maximum
`globeTerrainExaggeration` of 100 by default. As the apparent globe diameter grows
from one to four viewport diameters, relief smoothly attenuates to physical scale.
Queries intersect the displayed surface but interpolate source meters, rather than
reporting exaggerated radial altitude or triangle-chord depression.

This global preview holds z2 source grids warm across rotation, zoom and device
changes. It switches the whole world from z1 fallback to z2 together, avoiding
mixed-LOD seams. It does not implement high-detail globe refinement, polar terrain,
terrain-aware vector/label draping, or immersive/stereo terrain validation. Missing
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

Decoding runs in a packaged same-origin module worker. Inside that owned worker,
`core.worker: false` avoids nested/CDN workers. Tests compare worker and local
outputs, cancellation, warm cache, parent fallback, shared edges and physical
queries. Tests also cover 2:1 edge topology/heights/normals without skirts, mixed-detail
no-data, resident admission and atomic replacement, opt-in following and missing
surface behavior. Both GPU backends draw a coarse/fine boundary without skirts and
check physical anchor clearance. Required tests remain hermetic.
Image decoding disables color-space conversion and alpha premultiplication:
RGB bytes encode data, not display colors.

The classic Mapterhorn style remains a hillshade shader, not displaced terrain.
The normal renderer and layer entries are unchanged. For renderer-owned terrain,
retain the shared data contract and put deck-specific mesh adapters in
`tangram-layers`. TerrainExtension integration must account for Tangram's custom
render pass; attaching an extension alone does not make the basemap drape.

## Bounded phase acceptance and deferred work

This phase completes the local Mercator reference's streamed source boundary,
warm topology changes, indexed queries, 2:1 fallback stitching, hard resident cache
admission and opt-in target following. It does **not** complete the whole terrain
or WebXR roadmap. Next larger features remain certified pixel-error LOD, draping
Tangram basemap geometry, globe elevation, whole-pipeline/GPU memory admission,
first-person terrain collision/occlusion and native headset validation. None is
implied by this example's successful rendering or CPU queries.
