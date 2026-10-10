{/*
tangram-layers
SPDX-License-Identifier: MIT
Copyright (c) vis.gl contributors
 */}

# Renderer API

Use the host-only core entry when your application owns the camera, device and
render passes. The package root also exports this renderer as
`ClassicWebGLRenderer` (and the historical `Renderer` alias), alongside the
standalone default Tangram object.

```js
import {Renderer, HostFrame} from '@vis.gl/tangram-renderer/core';

const renderer = Renderer.create(scene, {
  device,
  canvas,
  requestRedraw: () => deck.redraw()
});

const frame = new HostFrame({
  viewport: {width, height},
  geographicAnchor: {longitude, latitude, altitude: 0, zoom},
  renderViews: [{
    id: 'main',
    viewport: {x: 0, y: 0, width, height},
    camera
  }],
  tileBuffer
});

renderer.setFrame(frame);
await renderer.load();
// In the host's draw callback, with a live host-owned render pass:
renderer.render({renderPass, force: true});
// On application teardown, after submitted GPU work is safe to retire:
renderer.destroy();
```

The host supplies the frame and owns scheduling. `LumaDeviceRenderer` provides
resource factories for luma.gl devices, including the WebGPU backend. The
renderer does not depend on deck.gl and does not create a second host device.

## Lifecycle

### `Renderer.create(config, options)` / `new Renderer(config, options)`

Creates the scene without loading it. `config` is a scene URL or object.
To combine scene definitions, use `{import: [sceneA, sceneB]}`, not a top-level
array. Supply
the host's `device`, optional `canvas`, and `requestRedraw` callback; `numWorkers`
and the source/projection options below configure worker execution. A custom
`workerURL` overrides the normal embedded scene-worker Blob. This renderer forces
external cameras and disables the standalone render loop.

### `renderer.load(config?, options?)`

Loads or reloads the scene. Call after setting the initial frame. Options use
the [Scene load contract](./scene.md#loadconfig-options), including `base_path`.
Completion means configuration is ready, not that every visible tile has arrived.
Subscribe to `error` and `view_complete` for later work; attribution/metadata
discovery is also asynchronous.

### `renderer.setFrame(frame, {renderViewId}?)`

Validates and applies a `HostFrame`, plain frame options or the legacy shape,
returning the normalized frame. The complete frame describes all eyes; the ID
selects the draw eye. The host still owns render-pass viewport/scissor placement.
See [HostFrame](./host-frame.md) for coordinates and visibility policy.

### `renderer.render({frame?, renderViewId?, renderPass?, force?})`

Applies an optional frame, updates the scene and returns whether a draw occurred.
Reuse the frame for each eye; `force: true` marks the scene dirty. Device-backed
draws use the host's active render pass; the host submits/ends that pass. A redraw
request is a scheduling notification, not an internal animation loop.

### `renderer.subscribe(listeners)` / `renderer.destroy()`

Subscriptions use [Scene events](./scene.md#events). Destruction releases the
scene's workers/resources and renderer-owned caches, not the host's device/pass.
Do not use the renderer afterward; unsubscribe scene listeners through
`renderer.scene.unsubscribe(listeners)` while the scene is live.

### `renderer.setProjectedBasemapProjection(options)`

For loaded CPU-projected scenes, returns a promise for a mesh-only rebuild,
retaining source tiles and renderer ownership. Failures reject and a later valid
request can retry. Other scenes reject this method. See
[projected basemaps](../developer-guide/projected-basemaps.md) for restrictions
and cache budgets.

## GPU backend ownership

Passing `device` creates one renderer-owned `LumaDeviceRenderer` for draw
submission and GPU caches. `renderer.destroy()` releases scene-owned buffers,
textures and shader stages, then the remaining backend caches. The embedding
application continues to own the luma.gl `Device` and each `RenderPass`; Tangram
never destroys them.

Cached vertex arrays and per-mesh uniform snapshots are released when a mesh
retires (including a globe-refined child). Shader replacement or destruction
invalidates that program's pipelines and dependent vertex arrays, while other
programs and meshes keep their reusable resources. Renderer destruction releases
the remaining caches once. Repeated draws with unchanged layouts reuse the same
resources. Scene wrappers retain ownership of their buffers, textures and shader
stages; cache cleanup does not destroy those shared resources.

As with other luma.gl resources, retire meshes and shaders only after submitting
render passes that reference them, not between encoding and submission.

`TangramGPUBackend` documents this deck-independent internal boundary so legacy
resource wrappers can migrate incrementally. It does not introduce a second
backend implementation or a public backend-selection mechanism. The classic
standalone path keeps its legacy WebGL implementation as a compatibility
fallback.

On the portable path, Tangram blend modes plus culling, depth-test, and
depth-write settings are translated by `LumaDeviceRenderer` into luma.gl
`RenderPipelineParameters`. Classic rendering continues to apply the equivalent
state through its existing WebGL state manager.

## `projectionEngine` constructor option

`Renderer.create(scene, {projectionEngine})` (also named `ClassicWebGLRenderer`)
accepts an optional math.gl-compatible `ProjectionEngine` factory. Tangram's
structural type is exported from `@vis.gl/tangram-renderer/core`, so ordinary
consumers do not need the optional math.gl projection peer. The option applies
to scenes using `scene.cpu_projection` and the opt-in projection worker; it
does not replace built-in Mercator/globe cameras or change `HostFrame`.

Each renderer compiles independent transforms with `createProjectionAsync` and
caches them by the supported projection type. Workers retain refinement, source
tiles, UVs and feature IDs, then transfer packed longitude/latitude batches to
a scene-local host endpoint. The engine converts the documented CRS pairs from
degrees to north-positive meters; Tangram converts those meters to common space.
Compilation and projection errors propagate through the existing tile-error
channel. A failed compilation can be retried by rebuilding.

Tangram releases its transforms and broker endpoint on destruction, including
rejecting late compilations. It does not dispose or modify the caller's engine.
Omitting the option keeps the existing worker-local projection implementation,
with no runtime import of math.gl's projection catalog into the core entry.
Engine identity is fixed for the renderer's lifetime; create a new renderer to
replace it. See [experimental projected basemaps](../developer-guide/projected-basemaps.md#injecting-a-projection-engine).

## `projectionEngineExecution` constructor option

`Renderer.create(scene, {projectionEngine, projectionEngineExecution: {maxBatchPositions: 4096}})`
captures a bounded synchronous kernel-call policy. The default is 4,096 coordinate
pairs; valid integers are 1–65,536. Larger requests yield between chunks. It does
not change worker build capacity or bound the full request's input/output memory.
An invalid policy fails before allocating renderer resources or broker endpoints.

### `renderer.getProjectionEngineStatistics()`

Returns a detached `ProjectionExecutionStatistics` snapshot, or `undefined` when
projection uses worker-local kernels. The scene exposes the same method. Counters
are cumulative for the host adapter lifetime: active/completed/failed/cancelled
requests, submitted positions, attempted kernel calls, scheduled yields and the
configured `maxBatchPositions`. Attempts later cancelled or failed remain in work
totals; invalid and pre-aborted requests do not enter accounting. Navigation has
separate counters. This is not worker refinement, cache/GPU residency or timing
information. See [cooperative host execution](../developer-guide/projected-basemaps.md#cooperative-host-execution).

## Source attribution

### `renderer.getAttributions()`

Returns `Promise<string[]>` containing deduplicated credit HTML from every
current scene source, including attribution discovered when resolving TileJSON.
This includes registered archive providers as well as TileJSON. Call after
`load()` completes, and refresh after scene updates or source changes.
The method delegates to `scene.getAttributions()` and adds no DOM or widget
dependency. It resolves/caches TileJSON metadata but never fetches tile payloads
just to obtain credits. Metadata failures reject; do not silently omit required
credits when handling an error.

The host is responsible for displaying credits and sanitizing provider HTML.
Do not insert these strings directly with `innerHTML`. Keep safe linked text
visible in map, fullscreen and captured/exported presentations, as required by
the provider. Credits describe all configured sources, not a per-pixel visible
source filter.

See [tile providers and attribution](../developer-guide/tile-providers.md) for
OpenFreeMap compatibility and headset presentation requirements. Deck hosts can
use [`onAttributionChange`](./tangram-layer.md#onattributionchange).

### `renderer.getSourceMetadata()`

Returns `Promise<Record<string, TangramTileSourceMetadata>>` keyed by scene source
name. Each entry can contain `name`, `format`, `tileMIMEType`, `attributions`,
`minZoom`, `maxZoom`, and `boundingBox: [[west, south], [east, north]]`.
Archive providers are queried in their worker; no archive handle crosses this API.
Authored bounds, sparse levels and maximum zoom override discovered values.
Capabilities are advisory: they do not change tile traversal or select a decoder.
Call after loading; metadata failures or source replacement during discovery reject.

See [tile loading](../developer-guide/tile-loading.md#archive-capabilities-and-lifetime).

## Tile resources

### `maxConcurrentTileLoadsPerWorker`

An optional **renderer creation option**, separate from `HostFrame.tileResources`:

```ts
const renderer = ClassicWebGLRenderer.create(scene, {
  device,
  numWorkers: 2,
  maxConcurrentTileLoadsPerWorker: 3
});
```

Use a positive safe integer. Omission preserves unlimited loading. Each worker
queues unique compatible built-in MVT, tiled GeoJSON and raster acquisitions in
FIFO order; duplicate source/data leases consume no additional slot. A slot
ends when the source acquisition/decode procedure settles, not when a styled mesh
build completes. Queued final-lease cancellation prevents the provider from
starting. Running cancellation rejects consumers promptly, but a non-cooperative
procedure retains its slot until it settles; late content cannot publish.

This is **not a scene-wide HTTP limit**: two workers configured with `3` may run
six shared source procedures. Metadata, textures, custom hooks/providers/decoders
and workers with external scripts are outside this budget. Those pipelines keep
their original loading behavior. The fixed budget is initialized with the worker
pool; recreate the renderer to change it.

### `renderer.getTileSourceStatistics()`

Returns `Promise<TileSourceStatistics[]>`, also available on `Scene`. Each detached
entry contains `workerId`, `sharingEnabled`, `maxConcurrentLoads`, `queuedTiles`,
`activeAcquisitions`, `loadingTiles`, `readyTiles`, `consumers`, `acquisitions`,
`sharedAcquisitions`, `cancelledAcquisitions`, `failedAcquisitions` and
`decodedBytes`. `acquisitions` counts actual provider starts, not queued leases.
Ready bytes remain undefined when allocation size is unknown.

`loadingTiles` counts live pending content, including queued records.
`activeAcquisitions` also includes retired, cancelled procedures that have not
settled, so these counts need not sum. `sharingEnabled: false` identifies workers
with external scripts; zero counts do not mean their custom pipelines are idle.
Counters do not include meshes, texture requests or driver memory. Worker samples
are not an atomic global snapshot. An absent worker pool returns `[]`; transport
failure or replacement of the sampled worker pool rejects rather than returning
partial/stale counts.

Projected-basemap workers additionally expose optional `projectionPreparation`
cache counts and `projectionWork: MeshProjectionStatistics`. Work counts include
`completedMeshes`, `failedMeshes`, `sourceVertices`, `outputVertices`,
`outputTriangles`, `projectionBatches`, `projectedPositions`, `edgeRounds`, and
`interiorRounds`. Geometry/round totals count completed requests only; batches and
positions also include failed work. These are cumulative per-worker counts, reset
with source preparation, not resident geometry or GPU memory. Ordinary workers
omit the fields. See [refinement diagnostics](../developer-guide/projected-basemaps.md#refinement-diagnostics).

Opt-in `cacheProjectedMeshes: true` adds
`projectionPreparation.projectedResults: {entries, bytes, hits, misses}` for an
independent 32-entry / 16 MiB worker LRU. Work counters exclude cache hits.
Caller-owned engines must stay immutable for the scene lifetime; leave this option
disabled for mutable engines. See [warm projected outputs](../developer-guide/projected-basemaps.md#switching-projections-without-reloading-tiles).

### `renderer.getTileResourceStatistics()`

Returns a detached snapshot of `activeBuilds`, `queuedBuilds`, `residentTiles`,
`cachedTiles`, `cachedMeshBytes`, `protectedTiles`, and `protectedMeshBytes`.
The counts belong to one logical renderer, not each stereo eye. Protected tiles
include visible geometry, proxies, pinned coarse globe fallback, and incomplete
or queued builds. Mesh bytes count vertex/index buffers, including globe variants
and pending labels; they are not a measurement of textures or total GPU memory.

Use [`HostFrame.tileResources`](./host-frame.md#tileresources) to opt into build
concurrency and completed off-screen cache limits. The renderer's normal unlimited
policy is preserved when options are omitted.

## Light definitions

The renderer accepts luma.gl 9.4 `Light` descriptors as the scene's `lights`
array, in JavaScript, JSON or YAML. These are plain definitions, not GPU
resources. Use `color` in byte RGB (`0..255`), `intensity` as a multiplier,
and `spot` with cone angles in radians:

```ts
import type {LumaLight} from '@vis.gl/tangram-renderer';

const lights = [
  {type: 'ambient', color: [255, 255, 255], intensity: 0.3},
  {type: 'directional', color: [255, 240, 220], intensity: 0.8,
    direction: [0.5, -0.5, -1]},
  {type: 'point', color: [255, 128, 0], position: [0, 0, 100],
    attenuation: [1, 0.01, 0.001]},
  {type: 'spot', color: [255, 255, 255], position: [0, 0, 200],
    direction: [0, 0, -1], innerConeAngle: 0.1, outerConeAngle: 0.4}
] satisfies LumaLight[];

const renderer = ClassicWebGLRenderer.create({...scene, lights}, {device, canvas});
```

Positions and directions use the projected common space of the geometry, **not
longitude/latitude**: EPSG:3857 meters on a planar map, or radius-256 globe
coordinates for GlobeView. Tangram transforms them to the active eye's lighting
space. Native lights do not interpret pixel units or Tangram's `origin` setting.
Distance attenuation is `1 / (constant + linear * distance + quadratic * distance²)`;
spotlights use the inner/outer cone transition rather than Tangram's exponent.
An omitted color is black, as in luma.gl. An explicit empty array means no lights.
Native arrays and named `luma` entries both support Tangram's `global.*`
substitutions. The renderer resolves globals before validating light vectors,
colors and falloff, and reapplies them when scene configuration is updated.

### Tangram light types extend luma.gl types

`TangramAmbientLight`, `TangramDirectionalLight`, `TangramPointLight`, and
`TangramSpotLight` extend the corresponding luma.gl definitions with optional
Tangram controls. Their union is `TangramLight`. Ordinary luma.gl `Light` values
are assignable directly; a separate wrapper or conversion step is not needed
for arrays. For example:

```ts
import type {TangramPointLight} from '@vis.gl/tangram-renderer';

const lamp = {
  type: 'point',
  color: [255, 128, 0],
  position: [0, 0, 100],
  attenuation: [1, 0.01, 0], // luma.gl's polynomial coefficients
  ambient: 0.1,             // optional Tangram contribution (normalized)
  specular: '#ffffff',      // independent Tangram specular contribution
  attenuationExponent: 2,   // optional additional Tangram falloff
  radius: [null, '200m']    // optional Tangram inner/outer radius
} satisfies TangramPointLight;
```

`ambient`, `diffuse`, and `specular` accept Tangram scalar, normalized RGB/RGBA,
or CSS colors. Positional lights also accept `radius` and `attenuationExponent`;
spotlights accept `spotExponent`. These falloff extensions multiply the native
distance attenuation and cone transition. The scalar legacy `attenuation`
field remains valid in old dictionaries, but is named `attenuationExponent`
in extended definitions so it does not conflict with luma.gl's coefficient
vector. Optional `origin` selects legacy `world`, `ground`, or `camera` position
interpretation; omitting it preserves native common-space positions.
`visible: false` suppresses an entry. Legacy coordinate origins retain their existing
planar semantics; use native common-space or geographic positions for globe lights.

### Geographic lamps and spotlights

Set `positionSpace: 'geographic'` on a `TangramPointLight` or `TangramSpotLight`
to supply `[longitude, latitude, altitude]` in degrees/degrees/meters. The renderer
projects the lamp into the current map or globe geometry space and resolves it
separately for each render eye. Planar maps choose the nearest antimeridian world
copy; latitudes outside Mercator's domain are clamped for planar projection.
Invalid/nonfinite coordinates and latitudes outside ±90° are rejected.

```ts
import type {TangramSpotLight} from '@vis.gl/tangram-renderer';

const lamp = {
  type: 'spot', color: [255, 240, 220], positionSpace: 'geographic',
  position: [-74.009, 40.705, 200], direction: [0, 0, -1],
  innerConeAngle: 0.2, outerConeAngle: 0.5
} satisfies TangramSpotLight;
```

Geographic spot directions default to east/north/up (`directionSpace: 'enu'`),
so `[0, 0, -1]` shines down toward the local surface, including on a globe.
Use `directionSpace: 'common'` to supply a projected direction explicitly.
Geographic positions cannot also specify legacy `origin`; ENU directions require
geographic positions. Distance attenuation and numeric radius extensions still
use projected lighting units: EPSG:3857 meters on maps, radius-256 common units
on globes. Geographic input does not rescale the attenuation equation.

Existing named Tangram light dictionaries and their historical default light
remain supported. To mix the two formats, wrap native definitions explicitly:

```yaml
lights:
  legacy-sun:
    type: directional
    direction: [0, 0, -1]
    ambient: 0.3
  native-lamp:
    luma:
      type: point
      color: [255, 128, 0]
      position: [0, 0, 100]
      attenuation: [1, 0.01, 0.001]
```

### `renderer.getLumaLightDefinitions()`

Returns detached `TangramLightMapping[]` snapshots; also available on `Scene`.
Call after loading and applying the desired `HostFrame`/render eye. Each mapping
contains a luma.gl `light`, a `coordinateSpace: 'tangram-lighting'` marker, and
the exact resolved `tangram` contributions. Positions in these snapshots are
eye-relative lighting coordinates; **do not feed them back as world positions**.

Tangram's independent ambient/diffuse/specular colors, positional ambient term,
radius falloff, attenuation exponent and spotlight exponent are carried as
optional Tangram fields on `mapping.light`, and retained with legacy names in
`mapping.tangram`. Luma.gl shaders do not consume those extra fields: rendering
only the standard luma.gl fields is an approximation for legacy lights, not a
lossless shader replacement. Native coefficients and cone angles are retained.
`mapTangramLight(resolved)` and `convertLumaLight(light)` expose
the same conversion boundary for tooling without creating a scene.

`convertLumaLight(light).lumaLight` is typed as `NormalizedTangramLight`: color
and intensity are required after validation/defaulting, point and spot lights
have attenuation coefficients, and spot lights have both radian cone angles.
Narrow on `type` before accessing positional or spotlight-only fields. The
authored `TangramLight` input keeps those defaults optional.

**Backend status:** native scene lights render on WebGL 2 and WebGPU for polygon,
line and raster surface styles, with `lighting: 'vertex'`, `'fragment'`, or `false`.
WebGPU supports constant emission, ambient, diffuse and specular material
contributions, shininess, and both native and legacy falloff equations. Material
textures and normal maps explicitly fail on this configured WGSL path; points
and text remain unlit. WebGPU accepts up to 16 visible lights and rejects larger
lists instead of silently truncating them. Native arrays/`luma` entries opt in
automatically, including explicit empty arrays. To opt in with an entirely
legacy light dictionary, set `scene: {lighting: 'configured'}`. Without that opt-in,
existing legacy WebGPU wall shading is unchanged. Updating a scene recompiles
its light-count-specialized shaders and releases replaced material resources.
The shadertools dependency is used only for public TypeScript light
definitions; this does not import its shader assembler or material modules into
the renderer bundle.

Native point/spot attenuation shares one GLSL/WGSL source boundary: the
polynomial distance denominator and cosine-cone transition follow luma.gl's
lighting convention. Tangram retains its denominator floor, explicit equal-cone
limit, independent material contributions and multiplicative legacy radius/exponent
falloff. This is not a wholesale replacement with luma's lighting uniform block:
that would change Tangram's light layout, supported count and legacy semantics.

## Backend compatibility and selection

The portable WebGL 2 shader compiler no longer queries raw shader precision;
high precision is required by WebGL 2. Classic WebGL 1 retains its capability
query and precision fallback. Device-backed feature selection uses a luma-owned
render pass and public command encoder to copy RGBA8 pixels into an owned staging
buffer, then `Buffer.readAsync()` to retrieve them. It does not access framebuffer
handles or call raw WebGL readback/state methods. Clipped radius queries retain
transparent edge padding; canceled or destroyed requests ignore late GPU/worker
results, and readback/worker failures reject internal requests instead of leaving
them pending. `Scene.getFeatureAt()` retains its existing `{error}` result on failure.
The staging buffer is released on success and failure. This does not guarantee
stall-free WebGL picking: luma's WebGL `readAsync()` may still synchronize with
the GPU. WebGPU supports selection shaders for polygons, lines, points and
text, using a copyable RGBA8 attachment, target-specific pipelines, native-row
conversion and padded asynchronous readback. Its selection encoder is independent
of the host's open render pass.

### `getFeatureAt(pixel, options?)`

Queries draws marked `interactive: true` in viewport-local, top-origin CSS pixels.
`options.radius` is an optional non-negative CSS-pixel radius. Coordinates and radius
must be finite. The host must keep rendering while the GPU pass and worker lookup
are pending. The promise resolves to `{feature, changed, pixel}`, `{error}` on a
scene readback/worker failure, or `undefined` for unloaded/noninteractive scenes.
Invalid arguments and queries after renderer destruction reject the promise.
`feature` is `unknown` because custom workers may return application-defined payloads;
built-in workers return ID/properties, source, layer and tile metadata.

By default the query uses the active render view. Supply `options.renderViewId`
for another eye's local pixels, or `options.coordinateSpace: 'canvas'` for full-target
CSS pixels. Canvas queries use half-open viewport rectangles and the last overlapping
view in `HostFrame.renderViews`, unless an explicit view is supplied. Out-of-bounds
queries return no hit; unknown view IDs reject. Results report `renderViewId` and
retain the caller's original `pixel`. Routing does not change the active camera.

Each queried eye owns a lazy fixed 256×256 selection target/queue, released when
the eye leaves the frame or the scene is destroyed/reloaded. The host must draw
the requested eye while its query is pending. This is not deck.gl's synchronous
picking or a terrain intersection. WGSL selection respects its point/text alpha and line
dash masks; legacy GLSL retains its existing silhouette selection behavior.

Legacy program/resource wrappers and classic non-device selection still contain
raw WebGL operations. Device-owned render passes and resources remain
the preferred portable path, without a luma.gl engine dependency.

## TypeScript contracts

The package root exports the runtime classes together with `RendererOptions`,
`HostFrameOptions`, `HostRenderView`, `HostCamera`, `SceneDefinition`,
`SceneLoadOptions`, and the worker-message contracts. Use `satisfies` to check a
frame without widening its render-view identifiers:

```ts
import type {HostFrameOptions} from '@vis.gl/tangram-renderer';

const frameOptions = {
  viewport: {width, height},
  geographicAnchor: {longitude, latitude, zoom},
  renderViews: [{id: 'main', camera}]
} satisfies HostFrameOptions;
```

## HostFrame

`HostFrame` separates shared geographic state from per-view camera state:

- `viewport` describes the complete render target.
- `geographicAnchor` supplies longitude, latitude, altitude, and the current
  tile-selection zoom.
- `projection` selects Web Mercator or the experimental globe projection; globe
  frames also supply `[west, south, east, north]` visibility bounds.
- `renderViews` contains one or more named viewport/camera pairs.
- `activeRenderViewId` selects the default view.
- `tileBuffer` requests additional tiles around the visible area.

The original `{viewport, view, camera, tileBuffer}` object remains accepted and
is normalized to a single-view `HostFrame`.

### Multiple views and stereo

For custom planar cameras, `calculatePlanarGroundBounds(camera, limits?)`
intersects the finite frustum with ground. Use
`calculatePlanarVolumeBounds(camera, [minimumHeight, maximumHeight], limits?)`
for conservative tile candidates that include elevated geometry. Heights are
physical meters and horizontal bounds use EPSG:3857 meters. Both helpers return
`null` for an empty footprint and are exported from the root and `/core` entries.
They do not query terrain or change the supplied camera matrices.

A host can share scene and tile state while submitting separate render passes:

```js
const stereoFrame = new HostFrame({
  viewport: {width: eyeWidth * 2, height},
  geographicAnchor: {longitude, latitude, altitude, zoom},
  renderViews: [
    {
      id: 'left-eye',
      viewport: {x: 0, y: 0, width: eyeWidth, height},
      camera: leftCamera
    },
    {
      id: 'right-eye',
      viewport: {x: eyeWidth, y: 0, width: eyeWidth, height},
      camera: rightCamera
    }
  ]
});

renderer.render({
  frame: stereoFrame,
  renderViewId: 'left-eye',
  renderPass: leftRenderPass
});
renderer.render({
  renderViewId: 'right-eye',
  renderPass: rightRenderPass
});
```

The frame shares one scene/style anchor across eyes and selects the union of
their tile footprints. Prepare the complete frame before submitting either eye.
The experimental WebXR presentation adapter composes room placement and per-eye
matrices without introducing deck.gl or XR state into this renderer contract.
