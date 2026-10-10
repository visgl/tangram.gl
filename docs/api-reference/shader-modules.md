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

Zero light contributes only ambient. Defensive `1e-6` denominator floors prevent
zero-vector/spacing division, but do not replace meaningful finite units. Negative
spacing is treated by magnitude. Nonfinite inputs are unsupported.

This is local directional hillshading, not cast shadows, ambient occlusion or a
complete material model. The host owns texture sampling, elevation decoding,
no-data masks, latitude-dependent spacing, edge stitching, exaggeration and color.
For a globe, transform the light into the same local ENU frame as the heights.

Tangram GLSL scenes can append `hillshade.fs` to `shaders.blocks.global` and call
the helpers from their color block. YAML block composition stays unchanged; this
PR does not automatically rewrite existing styles or translate arbitrary GLSL to WGSL.

See the [shader reuse assessment](../developer-guide/shader-modules.md).
