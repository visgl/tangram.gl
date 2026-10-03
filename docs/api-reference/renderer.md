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
Call after `load()` completes, and refresh after scene updates or source changes.
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
interpretation; omitting it preserves native common-space positions. `visible:
false` suppresses an entry. Legacy coordinate origins retain their existing
planar semantics; use native common-space positions for globe lights.

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

**Backend status:** native scene lights currently render on WebGL (including
vertex/fragment lighting and the hosted GlobeView path). Configurable WGSL scene
lighting remains a separate migration: native definitions explicitly fail on
WebGPU rather than being silently ignored. Existing WebGPU wall shading is
unchanged. The shadertools dependency is used only for public TypeScript light
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
