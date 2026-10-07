{/*
tangram-layers
SPDX-License-Identifier: MIT
Copyright (c) vis.gl contributors
 */}

# HostFrame API

`HostFrame` is the host-to-renderer boundary for viewport, geographic, and
camera state. It has no deck.gl dependency.

```js
import {HostFrame} from '@vis.gl/tangram-renderer/core';
```

## Constructor

```js
new HostFrame({
  viewport,
  geographicAnchor,
  projection,
  renderViews,
  activeRenderViewId,
  tileBuffer,
  tileZoom,
  tileLOD,
  tileResources,
  globePreloadZoom,
  animationTime
});
```

### `viewport`

The complete render target as `{width, height}`. Normalized frames also expose
`x` and `y`, which default to zero.

### `geographicAnchor`

Shared state `{longitude, latitude, altitude, zoom}`. `altitude` defaults to
zero. `zoom` controls style evaluation and, by default, tile selection. An
explicit `tileZoom` can reduce data detail without changing the style zoom.

### `projection`

CPU geographic procedures, units, axes and supported domains are documented in
[projection boundary and conventions](../developer-guide/projection-conventions.md).
They do not own host camera matrices or change the tile visibility policy.

The deck-independent geographic projection contract. When omitted, it defaults to
`{type: 'web-mercator'}` for backward compatibility. An explicit projection must
include a valid `type`; empty objects and missing, null, or empty types are rejected.
It also recognizes
`{type: 'globe', visibleBounds: [west, south, east, north]}` so host adapters
can describe spherical frames without importing deck.gl classes into the
renderer package.

Planar projections may also supply `visibleBounds: [west, south, east, north]`
to override the camera-derived rectangle. Longitudes are ordered and may remain
unwrapped across the antimeridian (for example, `179` to `181`). Latitudes must
stay strictly between -90 and 90 degrees, and projected meters must remain
finite. `visibleBounds:
null` explicitly declares no visible ground tiles; omitting the property retains
the existing camera/legacy bounds policy. Empty bounds are not replaced by a
fallback rectangle. Each render view may override or inherit this policy, and
tile selection is the union of their footprints.

`calculatePlanarGroundBounds(camera, limits?)`, exported from both renderer
entries, intersects the twelve edges of a **finite** frustum with EPSG:3857
`z = 0`. Optional `{sw: {x, y}, ne: {x, y}}` meter-space limits clip the convex
intersection before returning its bounding rectangle. The result is `null` when
there is no positive ground area. It does not infer terrain or elevated-only
geometry visibility. Singular matrices, infinite far planes and malformed limits
are rejected.

The experimental globe path converts Web Mercator tile vertices to deck's
radius-256 sphere and uses geographic bounds plus per-eye camera visibility for
tile selection. Coarse polygon, road and raster triangle meshes receive a cached,
globe-only refinement; planar meshes are unchanged. See the
[geometry refinement limits and costs](../developer-guide/view-integration.md#3-make-coarse-globe-geometry-follow-the-sphere).
Styles with post-projection `position` shader blocks or unknown varying vertex
attributes are not supported by this globe path. Automatic elevated footprints, label
orientation, and picking refinements remain tracked in
[GlobeView support](https://github.com/visgl/tangram.gl/issues/48).

Globe projections may declare `maxElevation`, a finite non-negative upper bound
in geographic meters above the reference sphere. Include terrain, extrusions,
offsets and shader displacement; this is not camera altitude. A known bound
expands the horizon test to retain elevated geometry. Explicit `0` opts into
surface-only horizon culling. Omission means unknown, so the renderer skips
horizon rejection within the supplied `visibleBounds`.

The host must supply a conservative geographic footprint enclosing ground **and
elevated** content. The height bound does not expand `visibleBounds`, derive a
3D frustum footprint, or choose tile LOD. Underestimating either bound can hide
content; omission can retain more tiles than surface-only culling.

```ts
projection: {
  type: 'globe',
  visibleBounds: [-120, -45, 20, 70], // supplied by the host
  maxElevation: 9000
}
```

### `globePreloadZoom`

Optional integer from `0` to `3`; only supported with a globe projection.
Omitted disables global preloading. A value of `2` keeps up to 16 coarse
coordinates per geometry source resident across globe rotation (`3` allows 64).
The actual level is capped by current data detail. Source zoom normalization may
reduce requests; sources whose minimum zoom is above this level are skipped,
so a source cannot silently expand the global request budget.

Visible detail is queued first. While a detail tile is incomplete, a ready resident
ancestor fills only that tile's region, using fragment clipping on WebGL 2 and WebGPU.
Clipping prevents overlap with completed neighbors, including translucent styles.
Fallbacks use the current style zoom, do not participate in label collision, and do
not draw point/text labels or feature-selection colors. Completed detail replaces
the placeholder. Changing style zoom rebuilds the small coarse set, and disabling
preloading or switching projections releases off-screen residents normally.

This is a loading fallback, not permanent whole-world high-resolution rendering:
cold-start loads still take time, tiles do not cover Mercator's polar caps, and missing
data in a provider's coarse level cannot be invented. Global residency is separate
from `tileLOD.maxTiles`, which still bounds active detailed footprint traversal.

### `tileResources`

Optional worker/cache limits shared across **all sources and render views**:

```ts
tileResources: {
  maxConcurrentBuilds: 8,
  maxCachedTiles: 64,
  maxCachedMeshBytes: 32 * 1024 * 1024
}
```

`maxConcurrentBuilds` is a positive safe integer. It limits tile builds submitted
to workers, not individual HTTP requests, decodes, texture loads, or scene-wide
configuration work. Visible detail is submitted before globe preload and retained
off-screen work, with stable center-first ordering within a priority. The queue
deduplicates source/style-normalized tile keys across eyes. Partial mesh replies
do not free a slot: completion, removal, cancellation or failure does. A late reply
from an old generation cannot release a newer build. Lowering the cap does not
abort active work; no additional work starts until the active count falls below
the new cap. Removing the policy resumes unlimited submission.

`maxCachedTiles` and `maxCachedMeshBytes` are non-negative safe integers.
They cap only **completed, unneeded off-screen cache entries**, evicting least
recently used entries until both limits are satisfied. Zero disables that cache.
Visible tiles from either eye, proxy ancestors, pinned globe fallback tiles, and
active/queued builds are protected and can exceed these cache limits. Ordinary
visibility/source pruning can still remove obsolete work and cancels its queue
ownership. Omitting a limit retains the existing unlimited cache behavior.

Mesh bytes count allocated planar and globe vertex/index buffers and pending
label meshes, without double-counting shared mesh references. They exclude
textures, retained CPU geometry, network data, shader/pipeline resources and driver
overhead. This is **not a total GPU-memory cap** or a bounded request queue; combine
it with `tileLOD.maxTiles`, source limits and bounded globe preloading. Cache limits
are enforced during tile/visibility updates, not by a separate background timer.

See [`renderer.getTileResourceStatistics()`](./renderer.md#renderergettileresourcestatistics)
for protected/cache residency and shared build-queue diagnostics.

Decoded source procedures have a separate, worker-local creation option,
[`maxConcurrentTileLoadsPerWorker`](./renderer.md#maxconcurrenttileloadsperworker).
Mesh-build slots remain held through final mesh batches even after a decoded
source slot is released. Neither setting limits metadata or texture requests.

### `renderViews`

A non-empty array of named render views:

```js
{
  id: 'main',
  viewport: {x: 0, y: 0, width, height},
  camera: {
    view: viewMatrix,
    projection: projectionMatrix,
    position: [x, y, z]
  }
}
```

Each matrix must contain 16 finite values and position must contain three finite
values. Projection values must remain finite after conversion to GPU float32.
The constructor copies camera arrays. Render-view IDs must be unique. A missing
first ID becomes `default`; later missing IDs become `view-1`, `view-2`, and so
on.

An eye can additionally supply `geographicAnchor` (its ground-footprint center
and zoom) and `projection` (its planar or globe geographic bounds). These affect visibility
only; scene/style state uses the shared anchor. All eyes must use the same
projection type.

Per-eye globe bounds inherit the shared `maxElevation` when omitted. An eye may
raise that bound but cannot lower it. Changing only the height invalidates tile
visibility without rebuilding scene styles or cached geometry.

### Coordinates and matrices

The `@vis.gl/tangram-renderer/core` entry exports shared, deck-independent
projection helpers: `PROJECTION_CONSTANTS`, `projectGeographicPosition`,
`projectGeographicVector`, and `unprojectGlobePosition`.
Positions are `[longitude, latitude, altitude]` in degrees/degrees/meters;
`projectGeographicPosition(position, 'web-mercator', anchorLongitude?)`
returns absolute EPSG:3857 meters, choosing the nearest unwrapped world copy
when an anchor is supplied. The `'globe'` variant returns radius-256 common
coordinates. `projectGeographicVector(position, direction, projection)` rotates
east/north/up vectors into those globe axes without changing their length.
`unprojectGlobePosition` performs the inverse for picking and rejects the sphere
center. These helpers do not apply eye, room-placement, or clip-space transforms.

CPU lighting, surface LOD, globe visibility, and XR picking share these units.
GLSL/WGSL projection and normal functions are generated from the same constants.
Public deck viewport projection conformance covers map, first-person, globe,
and stereo; no private deck projection uniforms are used. Tangram still keeps
tile-local packed vertices and its camera-relative meter transforms for precision.

Viewport dimensions and top-left `x/y` origins use CSS pixels. The host owns
render-target placement and render passes; Tangram derives device-pixel uniforms
from the device pixel ratio.

Matrices are column-major. For planar rendering, tile positions are absolute
EPSG:3857 meters (east-positive X, north-positive Y, altitude-positive Z), and
the camera composes `projection × view × tileModel × tilePosition`. The deck
adapters convert meters to deck's zoom-zero common coordinates and use its
latitude-dependent altitude scale. Matrices use OpenGL clip-space Z; the
WebGPU shader path performs the depth conversion.

The current globe shader first converts the geographic position to a
radius-256 sphere. Its `camera.projection` is the combined world-to-clip matrix
(`deckProjection × deckView`). Polygon and road normals rotate from local
east/north/up into that same globe common space at each vertex; they do not
use the planar tile's normal matrix. Globe `camera.position` is the common-space
eye used for tile horizon culling, billboard surface occlusion, and GLSL lighting.
Planar `camera.position` is the shader's eye-space lighting origin,
not a longitude/latitude tuple. Use the package view adapters rather than
interchanging those conventions.

For globe GLSL styles, directional-light `direction` and custom `normal` shader
blocks use globe common-space axes: longitude zero lies on -Y, longitude 90°
east on +X, and geographic north on +Z. Directional lights remain fixed in that
space when the camera or stereo eye changes. The interpolated default normals
are renormalized before fragment lighting. Planar light and normal-block
conventions are unchanged.

The portable WGSL polygon shader rotates wall normals into the same common
space for its fixed directional shading. Roof-versus-wall classification still
uses local up, so roofs and raster tiles keep their existing unlit colors.
This does not add configurable WGSL scene lights. Geographic point/spot-light
placement, tangent-space normal maps, and terrain normals are separate follow-up
work.

Screen-facing globe points, attached labels, and standalone text test the segment
from the current eye to their geographic anchor against the radius-256 sphere,
before applying screen offsets. This hides far-side overlays even without a
basemap surface underneath. Elevated anchors remain visible when that segment
clears the sphere; visibility is not inferred from a ground normal. Each stereo
eye uses its own `camera.position`, so a horizon label can be visible in only one
eye. The WebGL selection pass uses the same vertex test.

Anchor directions are normalized and their radius restored from geographic
altitude, so runtime trigonometric rounding does not bury surface labels. The
test keeps tangent/surface anchors visible within a small normalized f32
tolerance. Missing/zero eyes and eyes inside or on the sphere conservatively skip
this exterior-horizon test. Hosts must supply the actual common-space eye for
reliable occlusion. This is reference-sphere occlusion, not terrain/building
occlusion or a per-glyph intersection. Screen-space collision still uses the
existing planar layout, and hidden labels can still occupy that layout. Surface
label orientation, projected collision, spatial picking, and WebGPU selection
remain follow-up work.

### `activeRenderViewId`

The view selected when `renderViewId` is not supplied to the renderer. It
defaults to the first render view.

### `tileBuffer`

A finite non-negative number of additional Web Mercator tiles to retain around
the current bounds. It defaults to zero. Globe adapters normally provide zero
because their geographic visibility bounds already cover the host viewport.

### `tileZoom`

Optional shared **data** tile level, an integer from 0 to 22 and no higher than
`Math.floor(geographicAnchor.zoom)`. All eyes select the same requested level;
their footprints are still unioned. Lowering it does not lower scene/style zoom,
worker styling zoom, or the animation clock.
Omitting it restores the existing zoom-driven policy. The legacy single-camera
frame accepts the same option.

```ts
new HostFrame({
  viewport,
  geographicAnchor: {longitude: -74, latitude: 40.7, zoom: 16.5},
  tileZoom: 14,
  renderViews: [{id: 'main', camera}]
});
```

This requests level-14 data styled at level 16. Source `zooms`, `max_zoom`, tile
size/zoom bias and geographic bounds still apply, so the actual fetched level
may be lower. Existing `min_display_zoom` checks the requested coordinate level;
choosing a level below it hides that source rather than forcing finer tiles.
`max_display_zoom` continues to use style zoom. Coarser source data may contain
fewer features or more simplified shapes; preserving style evaluation cannot
restore missing data.

This is an opt-in uniform LOD contract, not an automatic projected-error policy.
The host must keep geographic candidate bounds and tile buffers appropriately
bounded. There is no new request budget or transition hysteresis. Finer-than-style
LOD and mixed levels within one frame are not supported by this contract;
Tangram's geometry overzoom scaling and proxy transitions need further work.
Normal deck.gl and WebXR adapters do not opt in automatically.

### `tileLOD`

Optional automatic **uniform data LOD**, mutually exclusive with `tileZoom`.
Both current and legacy frame shapes accept it. Omission keeps the existing
zoom-driven behavior; no normal deck or WebXR example changes its default.

```ts
new HostFrame({
  ...presentationFrame.hostFrame,
  tileLOD: {
    targetTilePixels: 512,
    pixelRatio: window.devicePixelRatio,
    maxTiles: 256,
    hysteresis: 0.2
  }
});
```

All four fields are optional and default to the values above, except
`pixelRatio`, which defaults to `1`. Pixel scales must be finite and positive,
`maxTiles` a positive safe integer, and hysteresis in `[0, 1)` zoom levels.
Viewport dimensions remain CSS pixels; pass the actual render-target pixel ratio.

The renderer samples a 3×3 grid over each eye's surface footprint, measures the
largest local screen-space magnification, and uses the most demanding eye to
estimate a tile level. Planar positions use EPSG:3857 meters; globe positions
and derivatives use the renderer's radius-256 sphere. The result is capped at
the shared integer style zoom and level 22. The current level is retained within
the hysteresis band; changes to policy settings, projection type or manual mode
reset that history. Source normalization/display filters still behave as
described under `tileZoom`.

Before enumerating coordinates, the renderer lowers the level until the sum of
buffered **candidate visits across all eyes** fits `maxTiles`. This conservatively
counts overlapping eyes, wrapped duplicates and globe candidates later rejected
by the horizon test. It bounds traversal/allocation work, **not** total cached
tiles, bytes, source count, in-flight requests or source-normalized fetches.
If even level zero cannot fit, `setFrame` throws without replacing the installed
frame. Custom visibility adapters must implement a conservative
`countTileCoordinates` method to opt into this policy; manual/legacy behavior
does not require it.

This is a sampled surface-scale estimate, not a certified feature-geometry
pixel-error bound. A target edge size cannot guarantee detail at every point of
a highly oblique footprint, and a resource cap can deliberately select coarser
data. Missing visible samples conservatively retain the style-zoom cap before
budget coarsening. Hosts must still provide bounded, conservative ground/globe
footprints, including elevated geometry. Mixed per-tile LOD, elevation-aware
error estimation, cache/request budgets and finer-than-style geometry remain
separate work.

### `animationTime`

Optional non-negative elapsed scene time in seconds, shared by every eye.
Supply it when the host uses an XR or other non-wall-clock timeline. Without it,
the renderer captures elapsed time when a logical frame starts. Submitting a new
frame object or submitting an eye again starts the next logical frame;
switching to another eye does not advance time. Submissions count even when a
draw is skipped during initialization or because nothing needs rendering.
Background tasks are processed once per logical frame.

## Static methods

### `HostFrame.from(frame)`

Returns an existing `HostFrame`, constructs one from the current shape, or
normalizes the legacy shape:

```js
HostFrame.from({
  viewport: {width, height},
  view: {longitude, latitude, zoom},
  projection: {type: 'web-mercator'},
  camera,
  tileBuffer
});
```

### `HostFrame.fromLegacy(frame)`

Explicitly converts the legacy shape into a frame with one `default` render
view.

## Instance methods

### `getRenderView(renderViewId)`

Returns a normalized render view. Omitting the ID returns the active render
view. An unknown ID throws an error before any renderer state is changed.

## Stereo-ready ownership

The frame stores shared geographic and tile state once while allowing separate
left/right cameras and viewport rectangles. A stereo host selects each view
when submitting its render pass:

```js
renderer.render({frame, renderViewId: 'left-eye', renderPass: leftPass});
renderer.render({renderViewId: 'right-eye', renderPass: rightPass});
```

Frame application is atomic: projection, camera, viewport, anchor, and buffer
are installed before visibility updates. Camera-only movement invalidates tiles.
Tile membership is the deduplicated union of all eyes, independent of draw order.
The default planar policy intersects each camera frustum with the ground plane;
if a bounded ground footprint cannot be determined it retains the legacy
buffered rectangle. Horizon clipping remains a separate improvement.
Globe selection uses each eye's geographic bounds and common-space position.
Visible tiles belonging to either eye are retained during pruning.

The renderer does not create XR sessions. WebXR placement and eye matrices are
supplied by the experimental presentation adapter.
