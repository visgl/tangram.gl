{/*
tangram-layers
SPDX-License-Identifier: MIT
Copyright (c) vis.gl contributors
 */}

# Reusable shader boundaries

Extract small mathematical helpers before replacing Tangram's shader-block system.
Keep host sampling, coordinate conventions and resource binding outside generic
modules. Use both luma shader assemblers and compare actual WebGL 2 / WebGPU pixels
against an independent CPU reference before proposing an upstream module.

The [experimental shader modules](../api-reference/shader-modules.md) include
hillshade, RGB height decoding, globe horizon occlusion and material coordinate
helpers: triplanar, planar and sphere-map mapping. Hillshade consumes decoded elevations and metric spacing;
material helpers leave textures and normal-map interpretation with the host.
GPU conformance compares mapping outputs against independent CPU results and
the original material GLSL with only its sampling boundary replaced. Height tests
cover channel carries and f32 limits before pixel quantization; horizon tests compare
both original Tangram languages against independent CPU segment calculations.

| Candidate | Existing implementation | Reuse boundary |
| --- | --- | --- |
| RGB height decoding adoption | Provider-specific terrain blocks | Optional Terrarium, Terrain-RGB and affine decoding are available; keep sampling/no-data/datum decisions host-owned. |
| Material mapping adoption | `lights/material.glsl` | Optional modules are available; retain legacy materials until sampling, derivatives and normal-map semantics are validated in full scenes. |
| Globe position and normals | `scene/projection_shaders.ts` | Geographic projection and ENU rotation with explicit radii, units and handedness. |
| Globe horizon adoption | `styles/globe_visibility_wgsl.ts`, point GLSL | Optional explicit-radius segment/anchor helpers are available; retain legacy labels until full scene/selection integration is validated. |
| Native light falloff | `lights/native-falloff.ts` | Compare luma's existing lighting first; preserve Tangram's equal-cone limit and separate legacy falloff. |
| TRON traffic patterns | Scene-specific shader blocks | Later styling module with explicit time, UV, speed and seed contracts. |

Prefer existing luma lighting and picking modules when contracts match. Keep Tangram
material accumulation, feature-selection passes and layer-depth ordering unless a
replacement preserves their renderer-specific semantics. Arbitrary YAML blocks
remain supported rather than becoming a fixed menu of effects.

Batch closely related helpers where they share a compatibility boundary and
fixtures. Preserve inherited copyright, add conformance coverage, and measure
bundle impact. Avoid automatic module registration
or global assembler mutations. Upstream only after proving reuse outside Tangram.
