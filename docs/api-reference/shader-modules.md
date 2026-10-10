{/*
tangram-layers
SPDX-License-Identifier: MIT
Copyright (c) vis.gl contributors
 */}

# Shader modules

<span className="badge badge--warning">Status: Experimental</span>

The optional `@vis.gl/tangram-renderer/experimental/shader-modules` entry exports
luma.gl `ShaderModule` definitions without importing the renderer or any runtime
dependency. Normal renderer and core entries do not re-export these modules.
Names and contracts may change before upstreaming.

## hillshade

```typescript
import {hillshade} from '@vis.gl/tangram-renderer/experimental/shader-modules';

// Supply this object in a luma ShaderAssembler or Model's modules array.
const modules = [hillshade];
```

GLSL vertex/fragment sources and WGSL `source` expose the same two functions:

```glsl
vec3 normal = hillshade_getNormal(vec4(west, east, south, north), vec2(spacingX, spacingY));
float shade = hillshade_getIntensity(normal, vec3(-1., 1., 1.), 0.35);
color.rgb *= shade;
```

- `heights`: finite decoded elevations, ordered **west, east, south, north**.
- `spacing`: positive finite center-to-neighbor distance, in the same linear units
  as height. X/Y spacing may differ.
- Local axes: +X east, +Y north, +Z up. Image rows usually run southward; the host
  must map samples to directions rather than pass row order blindly.
- `normal`: central-difference surface normal. Intensity normalizes normal and light
  inputs; light points **toward** its source in the same local frame.
- `ambient`: clamped to `[0, 1]`. Intensity is
  `ambient + (1 - ambient) * max(dot(normal, light), 0)`, bounded by `[0, 1]`.

Zero light contributes only ambient. Every nonzero light direction is normalized
independently of its magnitude. A defensive `1e-6` spacing floor prevents division
by zero, but does not replace meaningful finite units. Negative spacing is treated
by magnitude. Nonfinite inputs are unsupported.

This is local directional hillshading, not cast shadows, ambient occlusion or a
complete material model. The host owns texture sampling, elevation decoding,
no-data masks, latitude-dependent spacing, edge stitching, exaggeration and color.
For a globe, transform the light into the same local ENU frame as the heights.

Tangram GLSL scenes can append `hillshade.fs` to `shaders.blocks.global` and call
the helpers from their color block. YAML block composition stays unchanged; this
PR does not automatically rewrite existing styles or translate arbitrary GLSL to WGSL.

## Material coordinate helpers

```typescript
import {triplanar, planar, sphereMap} from '@vis.gl/tangram-renderer/experimental/shader-modules';

const modules = [triplanar, planar, sphereMap];
```

These binding-free modules extract the coordinate math from Tangram's
`lights/material.glsl`. They expose equivalent GLSL and WGSL functions, with no
uniforms or textures. Choose only the modules you need; unused exports tree-shake.
Existing material shaders remain unchanged while these reusable contracts are
validated. Adding a module does not automatically enable material mapping.

### triplanar

```glsl
vec3 weights = triplanar_getWeights(normal);
vec2 uvX = triplanar_getUVX(position, scale);
vec2 uvY = triplanar_getUVY(position, scale);
vec2 uvZ = triplanar_getUVZ(position, scale);
vec4 color = triplanar_blend(sampleX, sampleY, sampleZ, weights);
```

- `position` and `normal` use the same host-defined frame. Coordinates may be
  object-local, world-local or another consistent frame; no projection is implied.
- Weights use absolute normal components with a `1e-5` floor, then normalize to
  sum to one. A zero normal gives equal weights. This preserves Tangram's floor
  on the supplied components, including very small non-unit normals.
- X/Y/Z projections use **YZ / XZ / XY** coordinates respectively. `scale.x`,
  `scale.y` and `scale.z` each multiply both coordinates of their corresponding
  plane, in repeats per position unit. This is not per-world-axis scaling.
- UVs wrap with `fract`, including negative positions and frequencies. Negative
  normals do not mirror UVs. `triplanar_blend` blends all four sample channels.

The host samples its texture at each UV and passes the three RGBA samples to
`triplanar_blend`. In WGSL use `vec3<f32>` / `vec4<f32>` arguments with the same
function names. The host owns filtering, derivatives, color space and bindings.
This is **not** tangent-space normal-map reorientation: Tangram's legacy normal-map
interpretation stays with its material system.

### planar

`planar_getUV(position, frequency)` returns `fract(position.xy * frequency)`.
Frequency is a scalar in repeats per position unit; zero returns `(0, 0)`, and
negative frequencies wrap rather than clamp. Tangram's legacy `getPlanar` accepts
a vec2 scale but uses only its X component: pass `scale.x` here.

### sphereMap

`sphereMap_getUV(eyeToPoint, normal, skew)` computes reflection-map UVs. Supply a
nonzero camera-to-surface vector and a **unit** normal in the same frame. It
normalizes the eye vector, subtracts XY camera skew, renormalizes, reflects against
the normal, then maps the reflected direction to UVs. GLSL and WGSL use this same
order. The host samples the environment texture without implicit UV wrapping.

This is environment mapping, not equirectangular texture mapping or geographic
GlobeView projection. The back-facing reflection pole `(0, 0, -1)` and a zero
post-skew eye are undefined, just as in the legacy shader; avoid these inputs.

All mapping inputs and intermediate results must be finite and remain within f32
normalization and UV precision limits. Floating-point world coordinates should be
rebased before mapping when large magnitudes would lose fractional detail.

## heightDecode

```typescript
import {heightDecode} from '@vis.gl/tangram-renderer/experimental/shader-modules';
```

GLSL and WGSL expose `heightDecode_getTerrarium(rgb)`,
`heightDecode_getTerrainRGB(rgb)` and `heightDecode_getHeight(rgb, coefficients, offset)`.
Pass **linear normalized RGB** (`[0, 1]`), not byte-valued channels or an sRGB-decoded
texture sample. The built-in encodings return meters:

- Terrarium: `R * 256 + G + B / 256 - 32768` for byte channels.
- Terrain-RGB: `(R * 65536 + G * 256 + B) * 0.1 - 10000` for byte channels.
- Custom decoding: `dot(rgb * 255, coefficients) + offset` in host-defined units.

No rounding or clamping is applied, so already-interpolated samples may be decoded.
The host owns the texture's linear format, filtering, no-data/alpha handling,
vertical datum, height exaggeration and neighborhood sampling. Keep these choices
consistent when passing heights to `hillshade_getNormal`. This is decoding only,
not a terrain provider or displacement implementation. A provider using Terrarium,
such as Mapterhorn, still needs its own source configuration and attribution.

Finite inputs are required. f32 precision is limited: Terrarium's least blue-channel
step is `1/256` meter, while high Terrain-RGB elevations cannot retain every `0.1`
meter step. Normalized-channel rounding and cancellation can also introduce a small
absolute error near sea level (up to about `0.004` meter for Terrarium in the tested
GPU backends). Do not use this shader as a lossless archive decoder.

## globeHorizon

```typescript
import {globeHorizon} from '@vis.gl/tangram-renderer/experimental/shader-modules';
```

```glsl
vec3 anchor = globeHorizon_getAnchor(direction, altitude, radius, earthRadius);
bool hidden = globeHorizon_isOccluded(anchor, eye, radius);
```

The occlusion helper tests the **finite segment** from the eye to a position against
a sphere centered at the origin. Position, eye and positive radius use the same
linear units and orthonormal frame; subtract any globe center first. It is independent
of geographic axes, projection, deck.gl, WebXR and render-pass state.

`getAnchor` restores a nonzero radial direction to
`radius * (1 + altitude / earthRadius)`, avoiding trigonometric shortening of surface
anchors. Altitude and positive earthRadius use the same units (usually meters);
altitude must exceed `-earthRadius`. Tangram uses common-space radius `256` and
geographic radius `6370972` meters. Direct positions retain their supplied radius,
including elevated or buried anchors; they are not implicitly normalized.

Missing/zero, surface or interior eyes return false because they cannot define an
exterior horizon. Tangent/surface segments are visible within Tangram's `1e-6`
squared-unit-radius tolerance. Finite f32-representable inputs are required; extreme
camera distances or near-boundary differences below f32 precision are unsupported.
Call separately for each stereo eye. This is sphere occlusion only, not frustum
culling, terrain occlusion, collision resolution or screen clipping.

Current terrain styles and globe label shaders remain unchanged. Opt-in modules
do not register automatically or replace Tangram shader blocks.

See the [shader reuse assessment](../developer-guide/shader-modules.md).
