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

The [experimental hillshade module](../api-reference/shader-modules.md) is the first
candidate. It consumes decoded elevations and metric spacing rather than depending
on a terrain provider, texture encoding or map projection.

| Candidate | Existing implementation | Reuse boundary |
| --- | --- | --- |
| RGB height decoding | Terrain example blocks | Encoding coefficients independent of sampling; preserve channel-carry precision. |
| Triplanar mapping | `lights/material.glsl` | Normal-based blend weights and UV mapping; host owns bindings and scale units. |
| Globe position and normals | `scene/projection_shaders.ts` | Geographic projection and ENU rotation with explicit radii, units and handedness. |
| Globe horizon occlusion | `styles/globe_visibility_wgsl.ts` | Sphere/eye segment test; add GLSL and CPU parity with explicit radius and altitude. |
| Native light falloff | `lights/native-falloff.ts` | Compare luma's existing lighting first; preserve Tangram's equal-cone limit and separate legacy falloff. |
| TRON traffic patterns | Scene-specific shader blocks | Later styling module with explicit time, UV, speed and seed contracts. |

Prefer existing luma lighting and picking modules when contracts match. Keep Tangram
material accumulation, feature-selection passes and layer-depth ordering unless a
replacement preserves their renderer-specific semantics. Arbitrary YAML blocks
remain supported rather than becoming a fixed menu of effects.

Each extraction should preserve inherited copyright, add conformance coverage,
measure bundle impact and land independently. Avoid automatic module registration
or global assembler mutations. Upstream only after proving reuse outside Tangram.
