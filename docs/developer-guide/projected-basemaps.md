{/*
tangram-layers
SPDX-License-Identifier: MIT
Copyright (c) vis.gl contributors
 */}

# Experimental projected basemaps

The optional `@vis.gl/tangram-layers/experimental/projected-basemaps` entry renders
flat Tangram polygons, raster meshes and static meter/pixel roads in deck.gl's `OrthographicView`. Workers
subdivide the packed tile geometry and project it with math.gl before transferring
the mesh. The ordinary renderer does not bundle the math.gl projection kernels.

Try the [projected basemap example](/examples/deck-projected).
It defaults to NASA GIBS Blue Marble raster imagery, with OpenFreeMap vector polygons and roads as an alternative.
The example supplies one stable math.gl `ProjectionEngine`, registering only the four
algorithms required by its five projection choices. Changing projections reuses
that factory, compiled transforms and loaded tiles.
The raster source uses the documented [GIBS Web Mercator tile service](https://nasa-gibs.github.io/gibs-api-docs/map-library-usage/),
with visible imagery credit; it does not preload the community-funded OSM raster server.

## Usage

```typescript
import {Deck, OrthographicView} from '@deck.gl/core';
import {
  ProjectedBasemapLayer,
  createProjectedBasemapScene
} from '@vis.gl/tangram-layers/experimental/projected-basemaps';

const scene = createProjectedBasemapScene({
  sources: {map: {type: 'MVT', url: '', tilejson: 'https://tiles.openfreemap.org/planet'}},
  layers: {
    water: {data: {source: 'map', layer: 'water'},
      draw: {polygons: {order: 0, color: '#388ab3'}}}
  }
}, {type: 'equal-earth'}, projectionWorkerUrl);

new Deck({
  views: new OrthographicView({flipY: false, controller: true}),
  initialViewState: {target: [0, 0, 0], zoom: -1.5},
  layers: [new ProjectedBasemapLayer({id: 'projected-basemap', scene,
    projectedTileZoom: 2, projectedStyleZoom: 4, projectedMaxTiles: 256,
    tileResources: {maxConcurrentBuilds: 8, maxCachedTiles: 256,
      maxCachedMeshBytes: 32 * 1024 * 1024}})]
});
```

Serve the generated `modules/tangram-renderer/dist/projected-basemaps-worker.js`
as a separate asset and supply its absolute HTTP(S) URL as `projectionWorkerUrl`.
The website build copies this asset automatically. Custom hosting must copy it;
no worker URL is inferred from an application bundle. Display the tile provider's
[required attribution](./tile-providers.md) independently of rendering success.

## Injecting a projection engine

The renderer and deck layer accept `projectionEngine?: ProjectionEngine`. Supply
a reusable math.gl factory, not a compiled transform:

```ts
import {createProjectionEngine} from '@math.gl/projection/core';
import {equalEarth} from '@math.gl/projection/projections/eqearth';
import {albersEqualArea} from '@math.gl/projection/projections/aea';
import {mercator} from '@math.gl/projection/projections/merc';
import {equidistantCylindrical} from '@math.gl/projection/projections/eqc';
import type {ProjectionEngine} from '@math.gl/projection/types';

const projectionEngine: ProjectionEngine = createProjectionEngine({
  projections: [equalEarth, albersEqualArea, mercator, equidistantCylindrical]
});

// Keep both scene and engine identity stable across deck updates.
const layer = new ProjectedBasemapLayer({scene, projectionEngine, projectedTileZoom: 2});
// Or for a custom host:
// const renderer = Renderer.create(scene, {device, canvas, projectionEngine});
```

`@math.gl/projection` is an optional peer. Install a compatible alpha.13 factory
when using this option. Tangram exposes a structural factory contract without
importing the optional package's types or a default factory in its normal entries. Register only the
algorithms you need. Lazy factories are supported through
`createProjectionAsync`; required descriptors/grids must load successfully.

The engine stays on the host because factories, plugins and grids are not
structured-cloneable. The opt-in projection worker is **still required** for
geometry refinement. It transfers one longitude/latitude batch per refined mesh,
and receives projected common positions. Factory work runs on the main thread,
so this path trades a host round trip for caller-controlled implementations.
Without an injected engine, projection remains worker-local.

The requested CRS pairs, sphere/ellipsoid, domain and meter/common scaling below
are unchanged. The factory must honor these pairs and return finite meter values.
This is backend injection for the five supported projections, not arbitrary
target-CRS or globe-camera support. Source tiles, UVs, ordering and feature IDs
retain their original conventions.

Changing `projectedProjection` reuses the factory, independent compiled transforms
and decoded tiles. Changing/removing the engine prop recreates the renderer and
workers, so keep the factory reference stable. Tangram never modifies or destroys
the caller's engine, even if shared by multiple renderers. Pending work is rejected
on teardown; factory/transform errors surface through `onSceneError`.

### Cooperative host execution

Injected kernels receive at most **4,096 coordinate pairs per synchronous call**
by default. Larger mesh and navigation requests yield to a browser task between
chunks, allowing input and painting to proceed. Set a stable
`projectionEngineExecution: {maxBatchPositions: 1024}` object on the layer or
renderer to customize this limit (integer 1–65,536). It is captured at creation;
changing its identity on a layer recreates the scene. It does not change tile
detail, refinement, worker concurrency or memory budgets. The full input and
output buffers are still allocated; this is a per-call work limit, not a memory
limit or a guarantee of milliseconds per frame.

Both the host adapter and `new ProjectedBasemapNavigation(engine, executionOptions)`
snapshot coordinate inputs **before** awaiting compilation. Caller mutations or
transfers cannot change pending requests. Navigation's `projectPositions`,
`projectPosition`, `unprojectPosition` and `unprojectScreenPosition` accept an
optional final `{signal: AbortSignal}` argument. Cancellation rejects with
`AbortError`, publishes no partial result and leaves shared compilation and other
requests usable. The example cancels obsolete hover probes. Disposal rejects even
a pending compilation promptly; it cannot interrupt a synchronous kernel already
running or cancel the caller-owned factory's compilation.

`renderer.getProjectionEngineStatistics()` (also available on its scene) returns
detached cumulative host counters, or `undefined` for worker-local projection.
Navigation has independent `getExecutionStatistics()` counters. Active, completed,
failed and cancelled requests are separate from submitted positions, kernel calls
and scheduled yields. Position/call totals include work attempted by requests that
later fail or cancel; invalid or already-aborted inputs are not counted. The
example displays host work separately from worker refinement and GPU/cache
residency. These counters are not timing measurements.

## Projection and coordinate contract

### Switching projections without reloading tiles

Keep the prepared `scene` object and layer `id` stable, and update
`projectedProjection: {type: 'albers'}` through `deck.setProps({layers: [...]})`.
`onProjectionChange(projection)` runs after the worker mesh rebuild finishes.
Removing the override restores the prepared scene's initial projection.
The layer calls `renderer.setProjectedBasemapProjection(projection)` without
replacing the scene, workers, source definitions or decoded tile cache. Raster
textures are reused too. Only changing basemap sources requires a new scene.
Geographic footprint changes retain loaded tiles subject to the configured
cache budgets; new source detail or an expanded footprint may still fetch missing tiles.

Workers also retain **projection-independent source preparation**: packed attributes
and refined triangle topology. Byte-identical source geometry can reuse this work
across target projection changes, including returning to an earlier projection.
The lookup includes layout, geometry kind, source tile origin/detail, overzoom,
and refinement limits; exact byte comparisons prevent hash collisions from
substituting another feature's geometry. Styling or source-content changes miss
the cache. Each worker retains at most 64 preparations and 16 MiB of accounted
original/prepared buffers, evicting least-recently-used entries. Oversized meshes
are processed without retention. These limits are independent of GPU tile caches
and do not cap total scene memory. Worker reset releases the preparation cache.
`renderer.getTileSourceStatistics()` includes optional per-worker
`projectionPreparation: {entries, bytes, hits, misses}` diagnostics for this entry.

Target positions are always recomputed, including for a caller-owned engine;
mutable engine registrations/results are not cached. Every output owns separate
transferable buffers. This avoids repeated refinement, not all styling/build work:
styles are still evaluated during a rebuild, and region clipping is target-specific.

| `type` | Projection parameters | Initial coverage |
| --- | --- | --- |
| `equal-earth` | Central longitude 0° | One Mercator tile world |
| `equirectangular` | Origin and standard parallel 0° | One Mercator tile world |
| `albers` | Origin −96°, 37.5°; standard parallels 29.5°, 45.5° | North America: −170°, 5° to −40°, 75° |
| `mercator` | Ellipsoidal WGS84 Mercator, EPSG:3395; origin 0°, scale 1 | One Mercator tile world |
| `web-mercator` | Spherical Web Mercator, EPSG:3857; origin 0°, scale 1 | One Mercator tile world |

Equal Earth, Albers, equirectangular and Web Mercator use a 6,378,137 meter sphere.
Mercator uses the WGS84 ellipsoid (major radius 6,378,137 meters, inverse flattening
298.257223563). Mercator and Web Mercator share eastings but have different northings
away from the equator: Web Mercator omits the ellipsoidal latitude correction.
Projected meters are multiplied by
`256 / 6378137` to obtain Cartesian common coordinates; X points east, Y north,
and Z is zero. Unlike a geographic deck view, OrthographicView's zoom measures
pixels per common unit, not tile or styling zoom. Equal Earth, equirectangular and both Mercator variants
are centered on 0°, 0°; Albers is centered on its geographic origin.

`projectedTileZoom` explicitly selects source data detail, defaults to 2, and
must be an integer in [0, 6]. `projectedStyleZoom` independently sets the integer
styling level in [0, 22], at least as high as data detail. When omitted it follows
`projectedTileZoom`, retaining the original behavior. To refine data without
restyling cached meshes, keep `projectedStyleZoom`, the layer `id` and prepared
`scene` stable and change only `projectedTileZoom`.

`projectedVisibleBounds` can reduce geographic loading coverage. The layer does not
follow orthographic panning automatically; applications can opt into the camera
policy below. The footprint is a finite,
ordered west/south/east/north rectangle in a single world; latitude cannot exceed
±85.0511287798066°. There is no pole completion, wrapped world, or arbitrary cut
meridian in this preview. Albers cannot request coverage outside the region above.
Both Mercator variants retain this tile latitude limit rather than extending to the poles.
Source tiles remain EPSG:3857; `mercator` changes output geometry, not the source grid.

### Seam and domain clipping

Before projection, workers clip ground triangles against the single source world
in EPSG:3857 meters. Albers additionally clips to its documented North American
region. Outside triangles are discarded; intersecting triangles are cut and
triangulated in their original winding order. Raster UVs and varying packed
attributes interpolate at intersections, while feature IDs and layer order stay
flat. Polygon holes remain holes because clipping operates on the existing
triangulation, not on newly reconstructed rings. Fixed-meter ribbon corners use
the same clipping path. Source buffers remain untouched.

The west and east antimeridian edges remain separate; padding is not wrapped to
the other side or collapsed into a border triangle. Only rounding of packed cut
positions is clamped to the exact boundary. Cut vertices share the existing
`maxAdditionalVertices` budget with refinement, and exhausting it rejects the
build rather than silently deleting geometry. Geographic poles beyond the source
tile domain remain absent. Custom cut meridians, interrupted projections, and
arbitrary engine-defined valid regions still require a separate domain contract.
The example uses zoom 2 for Blue Marble and zoom 4 for OpenFreeMap, whose
transportation layer starts at zoom 4. Its full-world vector footprint therefore
loads up to 256 logical tile candidates per source. Its controls keep styling at
zoom 6, expose finer detail within North America, and disable choices exceeding
the example's 256-candidate budget. Projection and detail changes reuse the
scene and workers; returning to cached detail avoids source reacquisition when
the entries have not been evicted.

`projectedMaxTiles` is an optional positive integer guard checked before installing
a frame. It counts the finite footprint with the renderer's actual XYZ endpoint
and single-world clamping rules, before allocating tile coordinates. It is a
per-source logical candidate bound, not a total across multiple sources or a
network-request limit. An oversized request fails explicitly; detail is never
silently lowered. The renderer core also exports
`countProjectedTileCoordinates(bounds, tileZoom)` for application controls.

The existing layer `tileResources` property forwards `HostTileResourceOptions`: `maxConcurrentBuilds`,
`maxCachedTiles` and `maxCachedMeshBytes`. Build concurrency is shared across sources;
cache limits cover completed offscreen meshes, not visible or pinned tiles.
Textures, decoded CPU data and GPU driver overhead are not counted. Neither
these limits nor `projectedMaxTiles` imply a total memory cap. Defaults remain
unlimited when these opt-in properties are omitted.

`getProjectedViewFrame(viewport, {projection, visibleBounds, tileZoom, styleZoom,
maxTiles, tileResources})` exposes the
adapter for custom hosts. Its `HostFrame` uses `projection.type: 'projected'` with
an explicit footprint and common-space matrices. It does not label these matrices
as EPSG:3857 meters or use the Mercator/globe surface helpers. The scene's
`scene.cpu_projection` and host projection must agree.

## Supported scenes and resource limits

Use self-contained inline scenes and unlit ground `polygons`, `raster` or `lines` styles.
The scene helper rejects imports, mixins, shader injection, extrusion, elevation,
interactive feature draws, points and text. Unsupported features fail
explicitly rather than rendering partly in the wrong coordinate system.

The worker keeps original packed positions, UVs, ordering and feature IDs in
addition to Float32 projected positions. Refinement therefore preserves raster
sampling and tile clipping. `maxAngularSpan` defaults to 4° (range 1–30°) and
`maxAdditionalVertices` defaults to 65,536 per mesh (range 0–262,144). Exceeding
the budget rejects a build rather than silently dropping triangles. Tile detail,
geographic footprint and refinement should be kept small for initial applications.
Worker mesh failures reject the projection update after the current tile-build
queue drains. Restore a valid budget and request the projection again to rebuild;
even restoring the previous options retries after a failed update. Other queued
updates remain usable, and late failed batches release their texture references.

## Static projected roads

Line draws require an explicit positive width, either a number (Tangram's default
meter unit), a meter string such as `width: '5000m'`, or a pixel string such as `width: '6px'`. Style-level draw defaults
may supply that width. Standard butt/square/round caps and miter/bevel/round joins
use Tangram's existing ribbon builder. Workers expand each corner using its packed
extrusion vector, compensate for source overzoom, refine the expanded triangles,
and project the resulting ground surface. The shader consumes those projected
corners without applying extrusion again.

Meter widths are measured in the source EPSG:3857 plane, not true geodesic distance.
They distort with the rest of the map and grow on screen when the orthographic
camera zooms in. Pixel widths retain their CSS radius through shader-side extrusion.
Static same-unit offsets and outlines, dash arrays and portable animated traffic
are supported. See the road styling contract below for deliberate restrictions.
Existing geographic-view roads retain their current dynamic styling and animation.

## Geographic navigation and coordinate probing

The optional entry exports `ProjectedBasemapNavigation`, which uses a caller-owned
factory and the same CRS pairs and meter/common scaling as the renderer:

```ts
import {ProjectedBasemapNavigation, getProjectedGeographicBounds}
  from '@vis.gl/tangram-layers/experimental/projected-basemaps';

const navigation = new ProjectedBasemapNavigation(projectionEngine);
const type = 'equal-earth';
const target = await navigation.projectPosition([-75, 40], type);
const fitted = await navigation.fitBounds(getProjectedGeographicBounds(type),
  {width: 800, height: 600}, type, {padding: 24});
deck.setProps({viewState: fitted});
const viewport = deck.getViewports()[0];
const geographic = await navigation.unprojectScreenPosition(viewport, [400, 300], type);
// On application teardown; does not dispose the supplied engine.
navigation.dispose();
```

`projectPositions(Float64Array, type)` projects detached longitude/latitude pairs,
captured before asynchronous compilation; inverse inputs are captured the same way.
`unprojectPosition([x, y], type)` inverts common ground coordinates, compiling a
separate reverse CRS pair. Forward and reverse compilation is shared across
concurrent requests, supports lazy factories and retries failed compilation.
Finite inverse results outside the current geographic domain, or failing a
forward round trip, return `null`. The two antimeridian edges stay distinct even
when a kernel wraps +180° onto −180°: the opposite edge must pass the same forward
round-trip check. This does not accept additional world copies. Engine compilation, domain and convergence
exceptions propagate: applications should handle them when probing outside the
drawn outline. Disposed helpers reject pending work without destroying the engine.

Screen probes require an `OrthographicViewport` and top-left **viewport-local CSS
pixels**, independent of device-pixel ratio. Positions outside its rectangle
return `null`. Probing returns geographic ground coordinates, **not feature picking**:
it does not inspect tiles, feature IDs, depth or rendered transparency.
`fitBounds` projects a 33×33 geographic grid and fits its sampled extent, with
default padding 24 and zoom limits −10 to 10. It is a navigation aid, not a
conservative visibility or arbitrary curved-domain guarantee. An explicit zoom
clamp can prevent a full fit. Albers bounds must stay inside its documented region.

### Retaining focus across projection switches

```ts
const transition = await navigation.reprojectViewState(viewState, previousType, nextType);
deck.setProps({viewState: {...viewState, ...transition.viewState}, layers: [
  new ProjectedBasemapLayer({...existingProps, projectedProjection: {type: nextType}})
]});
```

`reprojectViewState` captures the old common-space target and zoom before awaiting
the engine. It inverts the target, projects that geographic focus into the new
coordinate system, and preserves numeric orthographic zoom. It does **not** promise
constant local ground scale across different projection distortions. Its result
includes `focus`, `clamped` and `domainFallback`: switching to Albers clamps an
outside focus to its North American domain; a finite invalid old inverse resets
to the destination domain center. Engine compilation/domain/convergence failures
still propagate rather than being mistaken for an ordinary outside-map target.
Applications must discard obsolete asynchronous transitions. The example retries
against the latest camera if a drag occurs during compilation and restores the
previous projection selector if compilation fails. Scene/id/engine stay stable.

### Camera-driven geographic coverage

```ts
const coverage = await navigation.getCameraCoverage(viewport, type, sourceRegion);
// Feed coverage.bounds into both projectedVisibleBounds and the detail policy.
// If null, retain the layer and its previous bounds with visible: false.
```

`getCameraCoverage` returns `{bounds, domainFallback}`. It captures the four
viewport-local CSS ground corners, computes their common-space envelope, and
intersects it with the allowed source region. For equirectangular and both
Mercator modes, latitude is monotone and longitude has constant scale. Equal
Earth also has monotone latitude, but longitude scale decreases with absolute
latitude: both endpoints and the equator (when included) bound its geographic
envelope. This avoids treating a sparse inverse screen grid as a visibility proof.
The fixed supported CRS parameters and a conforming engine are required; it does
not bound arbitrary user-defined projection kernels.

The envelope is conservative, not an exact visible polygon. It may load extra
tiles at curved outlines. Longitude and latitude are clipped to the source region
with a small outward numerical margin; seam edges remain separate and additional
worlds are not wrapped. A viewport beyond that domain returns `bounds: null`.
Albers bounds radius and longitude angle around the fixed northern cone's apex.
The apex is recovered from the supplied engine's forward transform; radial and
angular extrema over the camera rectangle are clipped against the source region.
It now returns a bounded envelope or `null`, rather than retaining the entire region.
Neither this method nor focus transitions change renderer defaults or import
projection kernels into the normal package entry.

## Opt-in camera-driven source detail

`selectProjectedTileDetail` is an application policy; the renderer's default
explicit detail and fixed footprint remain unchanged:

```ts
import {selectProjectedTileDetail}
  from '@vis.gl/tangram-layers/experimental/projected-basemaps';

const detail = await selectProjectedTileDetail(navigation, deck.getViewports()[0],
  type, {visibleBounds: getProjectedGeographicBounds(type),
    minZoom: 0, maxZoom: 6, targetTilePixels: 256, maxTiles: 256,
    currentTileZoom: previousDetail, hysteresis: 0.15});
// Update the same scene/id/engine; keep projectedStyleZoom fixed independently.
// new ProjectedBasemapLayer({...existingProps, projectedTileZoom: detail.tileZoom});
```

For each eligible XYZ level, the helper projects nine samples per tile footprint,
clipped to the supplied loading region, and measures its maximum CSS screen span.
It chooses the coarsest level meeting the target, bounded by integer levels 0–6
and the same per-source candidate count used by `projectedMaxTiles`. The previous
eligible level is retained near adjacent thresholds with optional hysteresis;
the coarser footprint is measured too, because clipping need not halve tile spans.
Hysteresis
(default 0.15, range [0, 0.5)). A minimum level exceeding the candidate budget
throws instead of silently violating it. The result reports `candidateCount`,
`estimatedTilePixels`, `budgetLimited` and `detailLimited`; limit diagnostics use
the hysteresis upper bound. This is **uniform sampled tile-span LOD**, not a
per-triangle pixel-error guarantee or a screen-derived visible footprint.

The example defaults to fixed coverage/manual detail, with an optional Camera-driven policy and Fit
loading region button. OpenFreeMap retains minimum zoom 4; Blue Marble can use
zoom 0–6. Camera-driven mode feeds the camera envelope into loading and detail
selection, capped by the selected world or North American source region. Styling
stays at 6. Camera updates are coalesced and obsolete calculations
are discarded. Loaded scene/workers remain warm, subject to cache limits; changing
detail or panning into uncached coverage can fetch missing tiles. Outside-region
cameras hide the layer without finalizing it; returning reuses retained resources.
Large scenes should avoid running this sampling policy
on every pointer movement.

## Geometry refinement and road styling

### Adaptive projected geometry

`ProjectedBasemapOptions.maxProjectedError` optionally sets a positive sampled-error
tolerance in projected common units. Each round batches endpoints and quarter,
midpoint and three-quarter edge samples through the same selected engine.
Polygon and raster surfaces also sample the centroid and three barycentric interior
points, comparing projected positions against triangle interpolation. Surface edge
checks compare parameterized interpolation, so straight but nonuniformly stretched
edges still refine for raster UV accuracy. Road ribbons retain perpendicular chord
checks rather than surface interpolation checks.
Edges exceeding the tolerance split with shared indexed midpoints, preserving UVs,
colors, layer order and feature IDs. The existing angular limit and vertex budget
still apply; exhausting a budget or packed-coordinate precision fails explicitly.
Interior-only errors insert packed triangle centers without changing shared edges.
Partial edge subdivisions use interior fans to avoid alternating long diagonals;
all added vertices count against the same per-mesh budget. Degenerate rounded
centers are rejected rather than silently accepting an unmet tolerance.
The preparation cache remains projection-independent; adaptive results are not
inserted into that cache. The host engine uses batched RPCs, not one call per vertex.

The example's optional adaptive mode targets sampled 2 CSS-pixel error,
quantized upward in log2 camera scale and debounced. Adjacent equal-detail tiles
use one shared tolerance and midpoint arithmetic. This is a **sampled error
estimate**, not a mathematical surface-error guarantee. Mixed-level stitching,
certified surface bounds and terrain refinement remain follow-ups; source
detail is still uniform, independent of mesh refinement.

### Refinement diagnostics

The example's About tab polls `scene.getTileSourceStatistics()` once per second,
without overlapping requests. Optional `projectionWork` snapshots report completed
and failed meshes, input/output vertices and triangles, projection batches and
positions, and edge/interior refinement rounds. Counts are cumulative work, not
current residency or GPU memory; rebuilding a mesh adds another completed request.
Batch/position counters include rejected work, while geometry and round totals
include only completed meshes. Counters reset with worker source preparation;
late replies from a previous reset do not enter the new counters.

The card reports current build queues and evictable mesh-buffer residency separately,
using `getResourceStatistics()`. These byte counts exclude textures and driver
memory. Diagnostics failures do not interrupt rendering. Normal workers without
the projected entry omit `projectionWork`; they do not load projection kernels to
provide diagnostics.

### Projected road styling

Static widths accept meters (`'1000m'` or a numeric meter width) or CSS pixels
(`'6px'`). Packed projected centers and corners give the shader a direction;
pixel strokes then apply their radius in screen space in both GLSL and WGSL,
without scaling width when the orthographic camera zooms. Caps and joins retain
their packed shape. Static offsets and parent-style outlines must use the same
units as the width. Dash arrays use Tangram's existing generated textures.
Styles with `animated: true` receive portable two-lane traffic using frame time
on both backends. The vector example uses pixel roads, outlines and traffic.

Dynamic width/offset expressions, mixed-unit outlines, alternate outline styles,
external road textures and arbitrary shader blocks remain explicitly unsupported.
This is the portable traffic effect, not unrestricted execution of legacy TRON mixins.

## Next steps

Labels, feature picking, lighting, height,
projection morphing and arbitrary projection domains are not implemented by this entry.
Existing Mercator, GlobeView and FirstPersonView integrations remain unchanged.
