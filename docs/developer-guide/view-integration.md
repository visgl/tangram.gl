{/*
tangram-layers
SPDX-License-Identifier: MIT
Copyright (c) vis.gl contributors
 */}

# deck.gl view integration roadmap

Tangram's host-driven renderer already accepts deck.gl view and projection
matrices. Matrix ownership is only one part of supporting a view: the renderer
also needs to know how world positions are projected and which tiles provide
the appropriate level of detail.

## Target frame contract

`Renderer.setFrame()` should evolve from a Web Mercator-shaped object into four
independent host policies:

1. **Render views** — one or more view/projection matrix pairs, eye positions,
   and viewport rectangles, plus shared redraw scheduling. A normal deck.gl
   view supplies one entry; stereoscopic rendering can supply left and right
   eye entries without duplicating geographic state or tile loading.
2. **Geographic anchor** — longitude, latitude, altitude, scale, and local
   meter-to-world conversion. This remains available even when a view does not
   expose a map-style `zoom` property.
3. **Projection adapter** — converts Tangram's geographic tile vertices into
   the host view's world coordinates and installs the required shader uniforms
   or modules.
4. **Visibility and LOD adapter** — returns visible tile coordinates and a
   screen-space level of detail for the current frustum.

The renderer core should depend on those interfaces, not on deck.gl classes.
`@vis.gl/tangram-layers` can then provide adapters backed by deck.gl viewports.
Tile selection should use the union of all render-view frusta, while each eye
gets its own camera uniforms and render pass. This keeps the contract suitable
for future WebXR and other stereoscopic hosts.

`HostFrame.projection` establishes the first part of that boundary with
deck-independent `web-mercator` and `globe` identifiers. The experimental
globe adapter additionally supplies geographic visibility bounds. It keeps
deck.gl out of the renderer while the remaining culling and tessellation
policies are extracted behind stronger interfaces.

## Tranches

### 1. Extract the current Web Mercator behavior

Move `getExternalCameraFrame()` and the Web Mercator checks out of
`TangramLayer` into a `WebMercatorViewAdapter`. Move the bounds and tile-range
calculation currently embedded in `View` behind the visibility/LOD interface.
Keep the existing flat and pitched `MapView` examples as conformance tests.

### 2. Make scene cameras optional

Inject the camera and visibility policies when `Scene` constructs `View`.
`SceneLoader` must stop synthesizing a default Tangram camera in external mode.
At this point a real `@vis.gl/tangram-renderer/core` entry can exclude Leaflet,
interaction handlers, the standalone loop, and classic camera implementations.

### 3. FirstPersonView

First-person rendering continues using planar Web Mercator geometry. The deck
adapter intersects the viewport corners with the ground plane, selects tiles
covering that footprint, and derives LOD from projected meters per pixel instead
of treating deck.gl's internal meter scale as a map zoom. Camera matrices still
come directly from deck.gl.

The initial supported contract is a fixed-altitude camera whose four viewport
corners intersect the Web Mercator ground plane. Horizon-level views, terrain
elevation, and footprints crossing the antimeridian remain follow-up work.

### 4. Implement GlobeView

The first GlobeView tranche converts each tile vertex from Web Mercator meters
to longitude/latitude and then to deck.gl globe coordinates before applying
the host camera matrix. It uses bounds supplied by `GlobeViewport` to select
tiles on both WebGL 2 and WebGPU.

The remaining production-hardening work is to subdivide coarse tile geometry
enough to follow the sphere, reject tiles behind the horizon, choose LOD from
screen-space error, orient labels, and align picking with bent geometry.

Tangram custom position shaders should run before the host projection hook.
Styles that replace geographic position entirely, such as the Albers morph,
must declare Web Mercator-only compatibility until they provide their own globe
projection behavior.

The renderer consumes only the `HostFrame` projection discriminator and bounds;
the deck.gl viewport check and matrix extraction stay in `tangram-layers`.

### 5. Conformance and packaging

For every adapter, test matrix forwarding, frustum-derived tile selection,
fractional LOD changes, resize, animation scheduling, cleanup, multiple
render-view frusta, and WebGL/WebGPU parity. Keep one example page per deck.gl
view so unsupported combinations are visible in navigation and cannot regress
silently.

## Good code entry points

- `modules/tangram-layers/src/tangram-layer.ts`: extract viewport validation
  and `getExternalCameraFrame()` into adapters.
- `modules/tangram-renderer/src/scene/renderer.ts`: define the new host frame
  contract.
- `modules/tangram-renderer/src/scene/view.ts`: inject projection and
  visibility/LOD policies.
- `modules/tangram-renderer/src/tile/tile_manager.ts`: consume adapter-provided
  visible tiles instead of assuming rectangular Web Mercator bounds.
- Tangram's vertex shader assembly: add the host projection hook after style
  position transforms and before camera projection.

The recommended implementation order is Web Mercator extraction, then
FirstPersonView, then GlobeView. This provides a reusable interface before the
most invasive shader and tessellation work begins.
