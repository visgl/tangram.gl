{/*
tangram-layers
SPDX-License-Identifier: MIT
Copyright (c) vis.gl contributors
 */}

# Experimental projected basemaps

The optional `@vis.gl/tangram-layers/experimental/projected-basemaps` entry renders
flat Tangram polygons, raster meshes and fixed-meter road ribbons in deck.gl's `OrthographicView`. Workers
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

`projectedVisibleBounds` can reduce geographic loading coverage
but does not follow orthographic panning automatically. The footprint is a finite,
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

## Fixed-meter roads

Line draws require an explicit positive width, either a number (Tangram's default
meter unit) or a meter string such as `width: '5000m'`. Style-level draw defaults
may supply that width. Standard butt/square/round caps and miter/bevel/round joins
use Tangram's existing ribbon builder. Workers expand each corner using its packed
extrusion vector, compensate for source overzoom, refine the expanded triangles,
and project the resulting ground surface. The shader consumes those projected
corners without applying extrusion again.

Widths are measured in the source EPSG:3857 plane, not screen pixels or true
geodesic distance. They distort with the rest of the map and grow on screen when
the orthographic camera zooms in. The overview example deliberately exaggerates
road widths to 150,000 meters; it is not a street-scale styling recommendation.
Offsets, outlines, pixel widths, zoom-stop/function widths, textures, dashes,
shader injection and animated traffic are deliberately rejected in this entry.
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

`projectPositions(Float64Array, type)` projects detached longitude/latitude pairs.
`unprojectPosition([x, y], type)` inverts common ground coordinates, compiling a
separate reverse CRS pair. Forward and reverse compilation is shared across
concurrent requests, supports lazy factories and retries failed compilation.
Finite inverse results outside the current geographic domain, or failing a
forward round trip, return `null`. Engine compilation, domain and convergence
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
eligible level is retained near adjacent thresholds with optional hysteresis
(default 0.15, range [0, 0.5)). A minimum level exceeding the candidate budget
throws instead of silently violating it. The result reports `candidateCount`,
`estimatedTilePixels`, `budgetLimited` and `detailLimited`; limit diagnostics use
the hysteresis upper bound. This is **uniform sampled tile-span LOD**, not a
per-triangle pixel-error guarantee or a screen-derived visible footprint.

The example defaults to Manual, with an optional Camera-driven policy and Fit
loading region button. OpenFreeMap retains minimum zoom 4; Blue Marble can use
zoom 0–6. Styling stays at 6. Camera updates are coalesced and obsolete calculations
are discarded. Loaded scene/workers remain warm, subject to cache limits; changing
detail can fetch missing tiles. Panning outside the fixed region does not load
new geographic coverage. Large scenes should avoid running this sampling policy
on every pointer movement.

## Next steps

Screen-space strokes need a separate projection-aware width contract. Labels, feature picking, lighting, height, adaptive geometry pixel-error LOD,
projection morphing and arbitrary projection domains are not implemented by this entry.
Existing Mercator, GlobeView and FirstPersonView integrations remain unchanged.
