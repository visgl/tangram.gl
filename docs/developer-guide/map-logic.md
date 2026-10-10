{/*
tangram-layers
SPDX-License-Identifier: MIT
Copyright (c) vis.gl contributors
 */}

# Reusable map logic

<span className="badge badge--warning">Status: Experimental</span>

Separate *decisions* from Tangram's scene, tile, shader and resource machinery.
The first extraction lives in `modules/tangram-renderer/src/map-logic/`, exposed
through an optional [map-logic entry](../api-reference/map-logic.md). It is usable
with ordinary CPU data in Node or a browser and does not initialize a renderer.

## Extracted boundary

The renderer adapter projects packed billboard geometry into per-view rectangles,
sorts by its existing priority/build/ID policy, then invokes the pure placement
procedure. The procedure resolves collision, repeat distance, linked placement
and injected duplicate identity into one visibility map. Only the adapter writes
mesh masks, uploads GPU buffers and swaps pending label meshes.

Geographic copy matching takes explicit world width and wrapping policy; it does
not import `HostFrame`, infer a projection or assume an Earth radius. Existing
Globe/Mercator/CPU-projected decisions and classic worker layout are unchanged.

## Reuse assessment

| Area | Reuse potential | Boundary still needed |
| --- | --- | --- |
| Screen-space label placement, bounds and repeat filtering | Extracted, CPU-only | Host provides projected rectangles and priority order |
| Cross-tile label identity | Extracted, CPU-only | Host provides world units, wrapping and source identity |
| Tile build scheduling | Extracted, pure callback-based queue | Keep source/worker cancellation in the host |
| Tile residency/cache policy | Useful independent policy | Replace scene option types and mesh accounting with neutral resource records |
| Geographic projection and ground footprints | Strong conformance boundary | Separate renderer discriminators; prefer math.gl where equivalent |
| Point anchors and line-label placement | Useful algorithms | Remove style parsing, font/shader conventions and mutable singleton state first |
| Worker collision batching | Not yet a reusable public API | Instance-local batches instead of global collision/repeat registries |
| Terrain intersection | Host-owned surface boundary | Projection units and spatial indexing remain explicit |

Do not export scene orchestration or GPU wrappers merely because they were moved.
Future extractions should have neutral input/output types, isolated state, no
hidden browser initialization, direct CPU tests and dependency-graph checks.
Where math.gl or loaders.gl already owns the algorithm, prefer conformance and
upstream improvements over another parallel implementation.

## Validation

The optional entry has an import-graph test proving it bundles without third-party
or renderer imports. Placement tests use immutable CPU candidates. Existing
renderer mask/proxy tests and WebGL 2/WebGPU fixtures continue to test the adapter
against its prior behavior. Coverage still includes every extracted source file;
moving code does not remove it from the denominator.
