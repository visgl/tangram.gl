{/*
tangram-layers
SPDX-License-Identifier: MIT
Copyright (c) vis.gl contributors
 */}

# deck.gl view integration roadmap

Tangram's host-driven renderer accepts deck.gl view and projection matrices.
The next tranches make tile selection, curved geometry, interaction, and package
boundaries reliable across MapView, FirstPersonView, GlobeView, and WebXR.

Each tranche should deliver a coherent behavior or package boundary, with its
tests and documentation in the same PR. Closely related files belong together;
the tranche size should follow the outcome rather than the file count.

## Completed foundation

- Web Mercator camera conversion is extracted into `WebMercatorViewAdapter`
  ([#96](https://github.com/visgl/tangram.gl/pull/96)).
- Host-driven scene loading avoids synthesizing a classic Tangram camera
  ([#98](https://github.com/visgl/tangram.gl/pull/98)).
- Renderer-owned visibility policies support Web Mercator bounds and globe
  bounds, including antimeridian ranges
  ([#99](https://github.com/visgl/tangram.gl/pull/99)).
- Globe camera position reaches the renderer
  ([#101](https://github.com/visgl/tangram.gl/pull/101)), with conservative
  horizon culling ([#102](https://github.com/visgl/tangram.gl/pull/102)).
- The globe adapter applies a latitude-dependent tile zoom adjustment
  ([#103](https://github.com/visgl/tangram.gl/pull/103)). This is a baseline LOD
  estimate; projected tile error is still a separate tranche.

FirstPersonView antimeridian footprint handling is proposed in
[#100](https://github.com/visgl/tangram.gl/pull/100), which remains open. Refresh
and validate that PR before treating the behavior as part of the baseline.

## Target frame contract

`HostFrame` already separates the shared geographic anchor from per-view camera
and viewport state. Complete the boundary around four independent host policies:

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

## Additional tranches, in recommended order

### 1. Apply host frames consistently across all views

Implemented: atomic frame application, camera-only invalidation, per-eye
ground/globe visibility unions, and shared animation time. The default planar
policy retains its legacy bounds fallback for unbounded horizon intersections;
bounded horizon handling remains in tranche 5.

Apply projection, camera, tile buffer, viewport, and anchor state before
recalculating visibility. Check the current `setFrame()` ordering: changing the
anchor can trigger tile selection before the new camera matrices are supplied.
Invalidate visibility when only the camera changes, even if the anchor and
geographic bounds are unchanged.

Select the union of tiles needed by all render views in a `HostFrame`. Keep
per-eye camera uniforms and draw passes separate, and keep frame time shared.
Define a conservative union for each projection rather than treating the active
eye as the visibility authority.

Complete when camera-only movement updates tiles in the same frame, either eye
can see its required tiles, switching eyes cannot prune the other eye's tiles,
and animation advances once per logical frame.

### 2. Finish the typed view and camera boundary

Implemented: checked HostFrame/View and camera-policy boundaries, extracted
FirstPersonView/GlobeView adapters, injected classic cameras, and a separately
built `@vis.gl/tangram-renderer/core` entry with a dependency-graph gate. The root
entry preserves the standalone Scene API. Legacy Scene traversal and the layer
lifecycle still have pre-existing type suppressions; this is not a claim that
the entire renderer's TypeScript migration is finished.

Extract FirstPersonView and GlobeView adapters alongside the Web Mercator
adapter. Define explicit types for host frames, render views, projection state,
camera policy, and visibility/LOD results. Document coordinates, units, matrix
order, clip-space conventions, viewport origins, and CSS versus device pixels.
Remove `@ts-nocheck` from the files changed by this tranche.

Inject camera construction into `Scene`/`View` so an external-camera entry no
longer imports the classic camera factory. Expose `tangram-renderer/core` only
after inspecting its dependency graph. Keep Leaflet integration in the example;
optional classic camera support can remain within the renderer package.

Complete when the core import excludes Leaflet and classic cameras, strict
typing covers the frame boundary, and existing classic examples still work.

### 3. Make coarse globe geometry follow the sphere

Implemented first slice: globe-only, edge-adaptive subdivision of immutable
polygon, road, and raster triangle meshes. The renderer keeps the original planar
GPU buffers and lazily builds one globe variant per coarse tile mesh. Both eyes
reuse that variant; camera movement does not rebuild it. Switching back to a
planar view uses the original buffers. Destroying the tile releases both variants.

The default cap is four degrees of **tile-local Mercator edge span**, before
road-width extrusion and custom shaders. This conservatively bounds the angular
span of the underlying spherical surface, not screen-space error or displaced
geometry. Tiles at source zoom 7 and above already meet the cap within a standard
tile diagonal and do not retain duplicate CPU data. Source tile zoom, rather than
style zoom, controls refinement. Coarse data is retained until the first globe
draw, then released. Refinement runs once on the main thread and is independent
of camera state.

Only long edges are split, so a long road or raster triangle does not multiply
every small building in the same mesh. Shared indexed edges reuse midpoints;
matching boundary segments in same-LOD neighboring tiles use identical rounded
positions. Different source simplification or LOD boundaries still require a
separate seam policy. UVs, heights, colors, normals and road extrusion attributes
are interpolated in their packed domains. Feature-selection IDs and layer order
must remain constant on each split edge. Indices promote to 32 bits when needed.

The per-mesh budget allows at most 262,144 additional vertices and twice that
many additional triangles. Exhausting it fails explicitly, never returning a
partially refined mesh. Unknown custom attributes must be constant on split
edges; varying attributes are rejected until their interpolation is defined.
Globe styles with a `position` shader block are rejected because that block runs
after geographic projection. Planar shader behavior and block ordering are
unchanged. Screen-facing points/text, mutable label buffers, and wireframe debug
meshes are not refined by this path.

Representative raster quad costs (16-byte position/UV layout, no other
attributes; original quad is 76 bytes). Local Node measurements use one warm-up
and the median of five refinements; these are not performance thresholds:

| Source zoom | Vertices | Triangles | Vertex/index data | One-time refinement |
| --- | ---: | ---: | ---: | ---: |
| 0 | 16,641 | 32,768 | 462.9 KB | 24.9 ms |
| 2 | 1,089 | 2,048 | 29.7 KB | 1.0 ms |
| 4 | 81 | 128 | 2.1 KB | 0.06 ms |
| 6 | 9 | 8 | 0.2 KB | 0.01 ms |

These figures count the globe buffers, not JS temporary allocations, retained
planar buffers, or textures. Real styles with wider layouts cost more. The
minified renderer ESM increases by 9.3 KB raw and 3.4 KB gzip, including its
embedded worker; there are no new package dependencies. Real-device tests cover
whole-world raster curvature and cache reuse across camera/stereo changes on
WebGL 2 and WebGPU.

Still pending: elevation-aware horizon bounds, projected-error LOD, seams across
different tile detail levels, and projection-aware label/lighting behavior. This
does not complete the full tranche.

Add projection-aware subdivision for polygon triangles, long line segments, and
raster tile meshes. Bound angular spans or projected curvature error, preserve
feature IDs and style attributes, and make neighboring tile edges agree. Avoid
rebuilding geometry when only the camera moves; key any additional mesh cache by
projection and refinement settings.

Account for extrusion and terrain height in globe visibility bounds so the
reference sphere's horizon cannot hide elevated geometry. Preserve Tangram
shader block ordering and explicitly reject incompatible position overrides.

Complete when low-zoom oceans, land, and raster tiles follow the globe without
large chords or seam cracks on WebGL 2 and WebGPU, with recorded geometry and
memory costs.

### 4. Choose tile LOD from projected error

Separate scene/style zoom from tile LOD. Evaluate projected tile size or error
using the host matrices and viewport, including latitude, pitch, resize, and
device pixel ratio. For multiple eyes, use the detail required by either eye.
Add hysteresis and resource limits to prevent tile churn and excessive requests.

Compare the existing globe zoom adjustment with actual deck.gl viewports rather
than relying only on fixtures that repeat its formula. Define source min/max
zoom behavior and how refinement changes without changing style evaluation.

Complete when MapView, FirstPersonView, and GlobeView have predictable detail
through camera transitions, with measured pixel error and tile/request budgets.

### 5. Support FirstPersonView near the horizon

Land the antimeridian fix in #100: the FirstPersonView adapter unwraps projected
ground corners around the camera center so a seam-crossing footprint stays
local instead of requesting nearly the whole world. Replace the requirement that all
four viewport corners hit the ground with bounded frustum/ground intersection.
Clip distant or upward-facing rays using explicit far-distance policy, and
handle camera altitude and source elevation conservatively.

Complete when looking toward or above the horizon produces a bounded selection
of visible tiles instead of an error, and antimeridian navigation does not
request a world-wide footprint. Terrain-aware intersection can follow after the
flat-ground contract is proven.

### 6. Align labels, lighting, and picking with projection

Distinguish screen-facing labels from ground-oriented symbols. Transform surface
normals consistently on the globe, and carry the same curved geometry and host
matrices into picking. Preserve feature identity through subdivision and hiding
behind the horizon.

Complete when labels and lighting follow the intended surface orientation, and
screen/spatial picks select the visible feature on MapView, GlobeView, and
FirstPersonView, including the antimeridian and stereo views.

### 7. Finish WebXR placement and interaction

Build on the typed host-frame and projection contracts. Verify room-meter
placement for tabletop maps and physical-radius globes, and one geographic meter
per XR meter for first-person rendering. Feed real XR eye matrices and viewport
rectangles into the same rendering path used by stereo preview.

Route mono/stereo controls and XR navigation through one logical view state.
Define picking rays, grabbing, locomotion, and teardown through interaction
intents. Keep Thor and webcam gesture translation local to its example.

Complete when mono, preview, and immersive rendering share animated scenes and
consistent navigation/picking, with deterministic mocked-frame tests and a
recorded native or emulated VR check.

### 8. Advance modern tile sources through conformance

Continue the pluggable loader boundary for MVT, MLT, and PMTiles, using published
loaders.gl capabilities when available. Compare decoded geometry, properties,
IDs, cancellation, transferables, and worker behavior before production switches.
Adapt Tilezen styles to Protomaps layers and evaluate Mapterhorn terrain through
the same boundary.

Complete each source/format switch with a working example, fixture-based parity
tests, attribution, and decode/worker/application bundle measurements. Track
upstream parser gaps in their owning repositories.

## Work that accompanies the tranches

- **TypeScript:** migrate complete related subsystems with real types. Remove
  suppressions and unsafe assertions as contracts become explicit; keep the
  migration behavior-preserving unless a documented fix is part of the PR.
- **luma.gl:** centralize GPU resource ownership and render-pass state through
  core APIs, then measure and test any shadertools adoption. Preserve Tangram's
  style blocks and shader injection behavior during each change.
- **Builds:** audit the remaining renderer-specific esbuild orchestration before
  consolidating it into dev-tools/ocular. Direct Rollup dependencies are already
  absent from the package manifests inspected for this roadmap; custom worker,
  legacy bundle, watch, and schema steps still need explicit output contracts.
- **Coverage:** target the authored renderer and layer code, including currently
  suppressed frame/view logic. Raise coverage toward greater than 90% with
  meaningful boundary and lifecycle tests; retain valid denominators and separate
  WebGL 2/WebGPU rendering coverage from aggregate unit coverage.
- **Regression evidence:** keep representative rendered examples for every view,
  include camera transitions and stereo-eye differences, and record bundle,
  worker, geometry, and memory changes when a tranche affects them.

## Good code entry points

- `modules/tangram-layers/src/tangram-layer.ts`: FirstPersonView/GlobeView frame
  construction and viewport validation.
- `modules/tangram-renderer/src/scene/host_frame.ts`: typed shared and per-view
  state contracts.
- `modules/tangram-renderer/src/scene/renderer.ts`: frame application order and
  render-view selection.
- `modules/tangram-renderer/src/scene/view.ts`: camera construction, visibility
  invalidation, and projection state.
- `modules/tangram-renderer/src/tile/tile_manager.ts`: consume adapter-provided
  visible tiles instead of assuming rectangular Web Mercator bounds.
- `modules/tangram-renderer/src/builders`: polygon and line geometry refinement.
- Tangram's GLSL/WGSL projection helpers: curved positions, normals, and matching
  rendering/picking behavior.
