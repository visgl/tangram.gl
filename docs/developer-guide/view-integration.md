{/*
tangram-layers
SPDX-License-Identifier: MIT
Copyright (c) vis.gl contributors
 */}

# deck.gl view integration

Tangram consumes host camera matrices rather than owning a deck.gl camera.
The ordinary layer supports MapView and experimental GlobeView/FirstPersonView;
the optional WebXR entry shares one scene across stereo eyes.

## Current support

| View | Geometry and visibility | Important limits |
| --- | --- | --- |
| MapView | Flat or perspective Web Mercator, host matrices | Custom GLSL effects are not automatically translated to WGSL |
| GlobeView | Radius-256 sphere; refined polygons, roads and raster meshes; per-eye horizon tests | No polar-cap data; elevated bounds must be supplied conservatively |
| FirstPersonView | Finite frustum intersected with ground or an opt-in height slab, bounded per eye | Conservative tile candidates, not terrain intersections or occlusion |
| OrthographicView | CPU-projected surfaces, roads, height-aware billboard collision and per-eye async selection | Five fixed projection domains; no terrain picking or surface-oriented labels |
| WebXR | Mono, interactive stereo preview, immersive eye matrices and room placement | Headset validation and immersive attribution remain separate gates |

See [TangramLayer](../api-reference/tangram-layer.md),
[projected basemaps](./projected-basemaps.md), and
[WebXR presentation](../api-reference/webxr-presentation.md) for application APIs.

### Globe detail and raster sampling

MapView and GlobeView use the same deck-to-Tangram zoom offset: deck's
512-pixel world becomes Tangram's 256-pixel world at `deckZoom + 1`.
GlobeView's camera already compensates for latitude; applying that adjustment
again to tile zoom underfetches detail near the equator and overfetches near
the poles. Source `tile_size`, `zoom_offset`, maximum zoom and explicit host
LOD policies still apply normally.

When an immersive globe's silhouette falls between screen samples, visibility
uses the union of the eyes' analytic horizon-cap bounds. Hit-only sample bounds
can omit visible ground as data detail increases. This is conservative ground
coverage, not a claim of minimal tile selection or elevated-feature bounds.

Raster images default to linear sampling, like MapLibre and community
basemap-layers. Explicit `filtering: nearest` remains useful for categorical
data. A transparent loading placeholder does not change the loaded image's
sampler. The optional MapLibre reference uses `vertical-perspective` for
GlobeView rather than MapLibre's `globe` preset, which transitions to Mercator
at zooms 11–12. Both cameras use the default 36.87-degree field of view;
landmark projection is checked against the installed MapLibre implementation.
The Streets reference shares the example's palette, flat building footprints,
waterways, road hierarchy and width stops (with the 256/512-pixel zoom offset).
This is not a pixel-parity guarantee: Tangram evaluates styles at tile style
zoom and orders roads and casings per feature, while the reference interpolates
widths continuously and draws casings then fills within each grade. Both retain
bridge/tunnel precedence over road class, honor explicit numeric `layer` values
and clamp grades to [-5, 5]. The reference accepts finite numeric layer values;
Tangram retains its legacy permissive `parseInt` behavior for malformed strings.

The Streets order callback is a closure-free declared function, not an arrow.
Tangram's worker compiler recognizes `function (...) { ... }` strings; the old
arrow arrived as text and was parsed as order zero, causing road/casing depth
conflicts. Serialized/minified callback and offline crossing tests protect the
authored class/grade priorities rather than replacing them with reference rules.

MapLibre is a comparison tool, not the rendering specification. Preserve
Tangram's useful differences: animated TRON traffic, shader glow and water
effects, labels and deck overlays are not reproduced by the static reference.
TRON's reference remains an approximate geographic/building-height check,
not a promise to match its shader colors or animation. Investigate geometric,
camera and data differences separately from these intentional style choices.

The ordinary deck GlobeView example closes the north and south polar holes
with unlit, untextured sea-level caps. Their color follows the selected example
basemap, and hiding the basemap hides the caps. They are example-owned deck
geometry, not renderer tile data, and do not add polar imagery, terrain,
features or picking. Mercator tile loading and the renderer's projection
domain remain unchanged.

### Comparison audit: correctness versus presentation

The example reference overrides MapLibre's viewport-dependent camera constraint
with the shared explicit latitude/zoom limits. At low zoom, fitting the viewport
inside Mercator bounds would otherwise shift the reference center or raise its
zoom, especially in portrait panes. Hermetic landmark tests cover both aspect
ratios, high latitudes, pitch and zoom; intentional empty map-edge space remains.
Equivalent bearings modulo 360 do not trigger `jumpTo` or interrupt navigation.
Longitude is not normalized this way: separate Mercator world copies stay distinct.

Recent comparison fixes intentionally have different scopes:

| Change | Scope and preserved behavior |
| --- | --- |
| Raster sampling and globe tile detail | Correct placeholder-sampler leakage and duplicate zoom adjustment. Explicit nearest filtering and host LOD policies remain supported. |
| Land behind courtyards | Add example-owned background geometry. Do not fill polygon holes, replace tessellation, or clear the host framebuffer. |
| Streets and Blue Marble lighting | Opt these example styles out of incidental relighting. Keep renderer lights, custom lit scenes and TRON shader blocks intact. |
| Globe caps and comparison projection | Caps are illustrative example geometry, not fabricated source data. Set the reference camera to deck's persistent globe model, rather than changing Tangram to follow MapLibre's globe-to-Mercator transition. |

Use the comparison to isolate camera, topology, source-detail and data errors.
Do not remove animation, shader effects, lighting controls, label placement or
deck integration merely because the reference does not implement them. Road
intersection/casing ordering still warrants comparison; shared colors alone
do not establish equivalent geometry or draw order.
In particular, the transportation layer can contain tunneled roads, elevated
pedestrian areas and bridge polygons as well as ordinary road lines. A road
rendered beneath a higher-grade feature is not, by itself, missing geometry.

## Frame and package boundary

`HostFrame` stores one shared geographic/style anchor plus named cameras,
viewport rectangles and optional geographic footprints. The renderer applies
the complete frame atomically before selecting the deduplicated union of all
eyes' tiles. Camera-only movement invalidates visibility. Each draw uses its
eye's matrices and the same logical animation time.

The layer exports `WebMercatorViewAdapter`, `FirstPersonViewAdapter` and
`GlobeViewAdapter`. The host-only `@vis.gl/tangram-renderer/core` entry excludes
classic camera construction, Leaflet and deck.gl; the root retains the standalone
compatibility API. [Projection conventions](./projection-conventions.md) and
[HostFrame](../api-reference/host-frame.md#coordinates-and-matrices) define axes,
units, matrix order and pixel coordinates.

## Remaining work by area

### 1. Apply host frames consistently across all views

Implemented: atomic application, camera-only invalidation, per-eye footprint
unions and shared animation time. The default planar policy retains its legacy
rectangle when no ground footprint can be derived; explicit bounds, including
an empty footprint, override that fallback.

Preserve these contracts when adding views: prepare every eye before drawing,
and never let drawing one eye prune another's required tiles.

### 2. Finish the typed view and camera boundary

Implemented: checked frame/view adapters, injected classic camera policy and
a core dependency-graph gate. Remaining lifecycle suppressions are recorded in
the TypeScript allowlist; a camera-free entry does not mean the entire renderer
is fully checked.

Next: remove remaining suppressions through behavior-preserving subsystem
changes, without coupling core to deck.gl view classes.

### 3. Make coarse globe geometry follow the sphere

Implemented: globe-only, edge-adaptive subdivision of immutable polygon, road
and raster meshes. Planar buffers remain unchanged; a lazily built globe variant
is reused across eyes and camera movement, then released with the tile.

The default cap is four degrees of tile-local Mercator edge span, before
road-width extrusion or custom shaders. Source zoom 7 and above needs no retained
coarse CPU copy. Shared indexed edges reuse midpoints; same-detail neighboring
segments use matching rounded positions. UVs, heights, colors and normals
interpolate, while feature IDs/order remain constant. Unknown varying attributes
and post-projection `position` shader blocks are rejected.

Per mesh, refinement allows at most 262,144 additional vertices and twice as many
additional triangles; exhaustion fails rather than publishing a partial mesh.
A zoom-0 raster quad can become 16,641 vertices / 32,768 triangles (about 463 KB
of position/UV/index data), excluding retained planar buffers and textures.
This is angular refinement, not a pixel-error guarantee.

Next: mixed-detail seam stitching, automatic elevated footprints and certified
curvature/error bounds. A declared
[maximum elevation](../api-reference/host-frame.md#projection) expands horizon
rejection, but does not enlarge the host's geographic candidate rectangle.

### 4. Choose tile LOD from projected error

Implemented: `HostFrame.tileZoom` separates uniform data detail from style zoom.
Optional `tileLOD` estimates detail from sampled surface magnification across
all eyes, with pixel ratio, hysteresis and a candidate budget. Normal adapters
do not enable it automatically.

[Tile resource limits](../api-reference/host-frame.md#tileresources) separately
bound shared mesh builds and evictable off-screen meshes. Visible/proxy/preload
tiles remain protected; these are not total memory or HTTP limits. Decoded
acquisition has its own per-worker creation limit.

Next: certified feature-geometry pixel error, mixed LOD, total decoded/texture
budgets and finer-than-style geometry scaling. Do not conflate source detail,
style zoom, mesh refinement and cache residency.

### 5. Support FirstPersonView near the horizon

Implemented: intersect all twelve finite frustum edges with ground or a declared height slab, clip
to a configurable eye-centered extent (default 20 km per east/north axis), then
take geographic bounds. The near/far planes remain authoritative; Mercator
latitude scale and unwrapped antimeridian coordinates are preserved.

Horizon-crossing eyes retain ground; sky-only eyes explicitly select no ground.
Stereo/immersive eyes contribute separate footprints to the shared union.

`firstPersonElevationRange` retains elevated-only geometry without a ground footprint,
while `[0, 0]` keeps the ground-only default. Negative physical heights are supported.
Next: terrain intersections and occlusion. The current default zoom estimate is footprint-derived; it is not
a screen-space-error guarantee.

### 6. Align labels, lighting, and picking with projection

Implemented: globe ENU surface normals, per-eye billboard sphere occlusion,
native luma.gl light definitions, geographic point/spot lights and configured
WGSL surface lighting. WebGL selection uses the curved geometry and matching
occlusion test. See [lighting](../api-reference/renderer.md#light-definitions)
for supported materials, light counts and unit conventions.

Externally driven Mercator, Globe and CPU-projected point/text annotations use screen-space collision, geographic
cross-tile deduplication and one shared visibility mask across stereo eyes.
Asynchronous feature queries support explicit views or whole-canvas coordinates,
with independent per-eye selection targets on WebGL 2 and WebGPU.
Opt-in elevated projected points and standalone text retain physical altitude;
attached text inherits its marker's height. Cross-tile identity includes quantized
height, while stereo shares one collision mask. Ground-only remains the default.

Mercator/Globe layouts retain worker candidates and resolve priority, repeat
spacing and buffered copies against the actual host cameras. Curved text bounds
include its packed segment offsets. Back-side globe anchors do not occupy collision
space; wrapped globe copies deduplicate, while separate Mercator worlds remain
distinct. The shared conservative mask prevents collisions in either stereo eye.
Classic camera-driven scenes retain their existing planar layout.
Bounds are conservative screen-space rectangles, not glyph-outline tests or
alternate-anchor fitting. Custom billboard position/size shader blocks are not
evaluated by the CPU layout; keep such effects consistent with authored geometry.

Host-supplied Mercator/Globe terrain meshes now support nearest-triangle screen
and room-ray queries, including physical altitude, near/far clipping and explicit
eye routing and retained triangle bounds indexes. No terrain is loaded or rendered implicitly.

The separate [Mercator terrain reference](./terrain.md) now has a bounded source
window, warm decode cache with hard resident-array admission, stitched 2:1 parent
fallback, indexed physical picking and opt-in MapView target following. This closes
the local reference phase. [Terrain integration](./terrain.md) also describes
the separate globe elevation layer and experimental worker-side basemap draping.

Next: tangent-space normal maps, rendered terrain normals, surface-oriented labels,
terrain-aware occlusion and deck.gl synchronous picking.

### 7. Finish WebXR placement and interaction

Implemented: shared mono/stereo controllers, room-meter map/globe placement,
1:1 first-person scale, actual-eye/room-ray surface picking and single-controller
squeeze grabs. Grabs translate a map in its starting plane or rotate a globe
around its room center; input ownership and tracking-loss cancellation are explicit.
Ground/globe surface queries now delegate to math.gl analytic shapes behind a
content-space adapter. Legacy formulas remain test-only conformance oracles;
near/far clipping, physical tabletop edges and per-eye query routing stay Tangram-owned.

Next: native/emulated headset validation, an in-headset attribution surface,
grip-pose/two-handed manipulation and feature-aware spatial picking. Terrain
queries accept an explicit mesh; DEM loading, rendering and occlusion remain separate.
Mocked XR frames and stereo preview do not substitute for headset testing.
Thor/webcam translation remains example-local.

### 8. Advance modern tile sources through conformance

Implemented groundwork: pluggable decoders/providers, optional loaders.gl MVT,
MLT and PMTiles workers, source metadata/attribution, decoded acquisition sharing
and a development-only loaders.gl tileset candidate.

Next: resolve parser and scheduling policy gaps before focused production
switches; evaluate Protomaps/terrain through the same fixture boundaries.
See [tile loading](./tile-loading.md) and [conformance](./visgl-conformance.md).
A matching format does not imply a matching feature schema or attribution policy.

## Validation for each tranche

Keep deterministic behavior tests, WebGL 2/WebGPU rendering probes, and bundle,
geometry and memory measurements alongside changes. Use the owning package's
coverage gate; never hide untested source or lower thresholds. GPU fixtures are
hermetic, while live provider and headset checks must be reported separately.

The build already uses Ocular/esbuild with no direct Rollup dependency. Its
renderer-specific embedded-worker/GLSL/watch contracts still have explicit
orchestration; consolidation must preserve those outputs, not add another toolchain.
