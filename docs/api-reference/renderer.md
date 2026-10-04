{/*
tangram-layers
SPDX-License-Identifier: MIT
Copyright (c) vis.gl contributors
 */}

# Renderer API

`@vis.gl/tangram-renderer` exports the classic Tangram default object and named
integration primitives:

```js
import {ClassicWebGLRenderer, HostFrame} from '@vis.gl/tangram-renderer';

const renderer = ClassicWebGLRenderer.create(scene, {
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
renderer.render({renderPass, force: true});
renderer.destroy();
```

The host supplies the frame and owns scheduling. `LumaDeviceRenderer` provides
resource factories for luma.gl devices, including the WebGPU backend. The
renderer does not depend on deck.gl and does not create a second host device.

### GPU backend ownership

Passing `device` creates one renderer-owned `LumaDeviceRenderer`. It owns the
Tangram buffers, textures, shaders, pipelines, vertex arrays, and draw submission
and is released by `renderer.destroy()`. The embedding application continues to
own the luma.gl `Device` and each `RenderPass`; Tangram never destroys them.

`TangramGPUBackend` documents this deck-independent internal boundary so legacy
resource wrappers can migrate incrementally. It does not introduce a second
backend implementation or a public backend-selection mechanism. The classic
standalone path keeps its legacy WebGL implementation as a compatibility
fallback.

On the portable path, Tangram blend modes plus culling, depth-test, and
depth-write settings are translated by `LumaDeviceRenderer` into luma.gl
`RenderPipelineParameters`. Classic rendering continues to apply the equivalent
state through its existing WebGL state manager.

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

This first contract shares one geographic anchor and LOD decision across the
views, which matches a stereoscopic pair. Frustum-union tile selection and
WebXR render-pass orchestration remain future adapter work.
