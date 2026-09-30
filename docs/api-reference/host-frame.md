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

The deck-independent geographic projection contract. It defaults to
`{type: 'web-mercator'}` for backward compatibility and also recognizes
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
(`deckProjection × deckView`), while `camera.view` remains available for normal
transforms. Globe `camera.position` is the common-space eye used for horizon
culling. Planar `camera.position` is the shader's eye-space lighting origin,
not a longitude/latitude tuple. Use the package view adapters rather than
interchanging those conventions.

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
