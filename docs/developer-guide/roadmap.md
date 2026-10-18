{/*
tangram-layers
SPDX-License-Identifier: MIT
Copyright (c) vis.gl contributors
 */}

# Consolidated roadmap

This roadmap replaces overlapping terrain, view, integration and TypeScript
tranche lists. It describes remaining work, not a promise that every experimental
path is production-ready. Track integration in
[GitHub #49](https://github.com/visgl/tangram.gl/issues/49) and globe-specific
acceptance in [#48](https://github.com/visgl/tangram.gl/issues/48).

## Landed foundation

- HostFrame, MapView, FirstPersonView, GlobeView, projected basemaps and interactive
  mono/stereo previews have independent host/view adapters.
- The renderer uses luma.gl devices/resources, math.gl matrices/projection/culling,
  reusable GLSL/WGSL modules, optional loaders.gl tile workers and explicit credits.
  YAML/MVT **default-parser replacement is not complete**.
- Ocular/dev-tools owns build/lint/test orchestration; generated artifacts are not
  checked in. Removing direct Rollup pipelines is not a remaining tranche.
- All production module JavaScript is converted to TypeScript. #209 removed the
  last four production `@ts-nocheck` directives; strict compilation now covers the
  scene, worker and base/point styles. Narrowing residual `any` and assertions,
  migrating remaining JavaScript tests and removing Chai/Sinon are still useful.
- Terrain includes bounded source admission, parent fallback, preview 2:1 stitching,
  styled draping, atomic morph generations, physical queries, point-eye clearance,
  annotation depth and demand-bounded query/index residency (#188–#208).
  Preview stitching does **not** imply conforming styled ground topology.

## Landed batch: reusable height-field preparation

`TerrainHeightField` indexes immutable DEM footprints for height/slope lookup and
conservative rectangle admission. Worker styles share current/previous field
owners; lazy summed-area masks have an 8 MiB retained cap per field and exact
sample scanning when admission fails. Fully valid fields retain no mask.
Globe preparation and neighbor reconstruction use the same indexed sampling.

Conformance preserves ordered bilinear arithmetic, shared-edge averaging,
registration, physical meters and no-data holes. Diagnostics count admitted
grid visits, mask reads/builds and retained mask bytes. They are not FPS or total
memory estimates. This reduces repeated source scans and mask construction; it
does not change styled topology, certify terrain error or move work off-thread.

## Current batch: canonical styled terrain and field transitions

Opt-in `groundMeshResolution` gives selected full-tile raster ground styles
DEM-owned triangles with balanced coarse/fine knots. Complete cells survive
source-detail and fallback boundaries; half-open draw/query clips partition
ownership rather than retessellating the surface. Periodic copies reconcile
antimeridian sampling. The globe reference opts into 32 cells per DEM axis.

Late source tiles inherit the admitted field's shared transition origin, including
both eyes and CPU queries; successful staged replacement starts the next field
clock atomically. This completes the raster-ground seam/clock portion of batch 1,
not exact replay of older DEM triangulation.
Explicit resolution remains a resource/detail policy rather than certified error.

Polygon faces, vertical walls and nominal expanded road ribbons now intersect
the same DEM triangles. Cut vertices interpolate canonical physical height/slope
endpoints, preserving feature/material channels instead of resampling a different
bilinear surface. Source/fallback clips and field clocks remain shared. This
completes the Mercator-plane polygon/road portion, not exact curved-surface
coplanarity: extra feature cuts can change globe chords. Dynamic-width movement
between rebuilds retains local tangent correction rather than new cell intersections.

## Remaining batches, in priority order

The current combined implementation advances batches 1–4 with opt-in common planar
transition refinement, DEM-derived height/curvature envelopes, projected dyadic
ground detail, shared reservation leases and peak mesh admission, billboard-wide
visibility probes and a bounded swept-height-field footprint guard. These are not
completion claims: exact cross-style globe chords, dynamic-width re-intersection,
unregistered/transient resource domains, general avatar physics and full glyph
occlusion certification remain distinct work. See [terrain integration](./terrain.md#projected-detail-and-picking)
for the implemented bounds and failure policies.

| Batch | Coherent implementation scope | Gate before claiming completion |
| --- | --- | --- |
| 1. Styled terrain seams and replacement | Canonical edge nodes across mixed source LOD and fallback clips; coordinated spatial/temporal transitions; wide-road corner parity. Begin with ground raster triangles, then polygon and ribbon adapters. | Coarse/fine and parent/detail boundaries agree in color, depth, physical picking and both eyes on WebGL 2/WebGPU, including holes and antimeridian wrap. No skirts used to conceal styled-ground cracks. |
| 2. Measured detail and preparation | Height/curvature-error envelopes, projected-error detail choice and hysteresis; cancellable worker preparation/packing where profiling identifies main-thread costs. | Deterministic error fixtures, no empty coverage during motion, source/vertex limits retained, and reproducible preparation/upload/query profiles. Footprint heuristics are not certified error bounds. |
| 3. Cross-owner resource admission | Account shared source, worker copies, staged draw/query buffers and GPU resources through explicit leases; peak-aware replacement and teardown. | Over-budget updates keep the previous display/query generation; cancellation releases reservations. Report retained CPU, transient estimates and GPU separately instead of summing misleading per-stage limits. |
| 4. Terrain-aware annotations and navigation | Quad-wide visibility where useful, dynamic ribbon sampling, bounded swept eye/avatar volumes and missing-coverage policy. | Visible-in-either-eye labels survive; GPU feature IDs match visible fragments; unloaded terrain never certifies a safe path. Point clearance alone is not avatar collision. |
| 5. Projection/view continuity | Globe-to-Mercator terrain transition, explicit polar-data policy, custom ProjectionEngine domains, remaining curved/line-label and lighting restrictions, projected terrain and provider-specific conventions. | Draw/query/LOD continuity through projection changes and high zoom; coordinate precision, wrapping, units and vertical datum documented. Preserve existing projected road/point-label support; do not fabricate polar DEM coverage. |
| 6. Immersive validation and reusable input | Room-placement and controller/picking conformance, native/emulated VR terrain matrix, hardware attribution and input teardown; keep Thor example-local. | Map, Globe and true-scale FirstPerson tested on actual/emulated sessions as well as desktop stereo. Mock XR is not hardware certification. Upstream only APIs validated by independent consumers. |
| 7. Parser and tileset production switches | Published YAML scalar/merge parity, authored MVT-property preservation, PMTiles/MLT/provider conformance, shared loaders.gl source/tileset lifecycle hooks. | Re-run the corpus on the selected release, compare worker outputs and cancellation, record decode and raw/min/gzip costs, then switch one default implementation at a time. |
| 8. Type and coverage hardening | Replace residual broad dynamic types with normalized scene/style/source contracts; migrate remaining JS tests and simple Chai/Sinon usage; exercise untested ownership/error paths. | Raise each authored-package coverage metric above 90% without weaker thresholds/exclusions; no suppression regressions; unchanged runtime outputs and browser/worker coverage rather than assertions about types alone. |

Batch 1's remaining priorities are exact cross-topology geometric transitions,
cross-style globe chord conformity and dynamic-width resampling. Batches 2–3 share resource and
profiling work and can form one substantial follow-up. Batch 8 can run independently;
it must not be described as another filename-only TypeScript migration.
Batch 7 requires published upstream fixes; do not block unrelated terrain work on it.

## Delivery rules

Batch adjacent changes that share fixtures and ownership; do not combine unrelated
dependency switches merely to make a PR large. Every production replacement keeps
an output oracle until compatibility is established. Keep Tangram's styling,
feature identity, packed attributes and shader-block semantics in renderer adapters;
reusable math/data/resource contracts belong in their owning vis.gl libraries.

Each batch includes documentation, focused regressions, strict typing, current-head
CI/coverage and WebGL 2/WebGPU checks when drawing, views or selection change.
Measure bundle deltas without new exclusions or weaker coverage thresholds. Record
hardware/live-provider checks separately from hermetic automated gates.

See [terrain integration](./terrain.md), [view integration](./view-integration.md),
[projection conventions](./projection-conventions.md) and
[vis.gl conformance](./visgl-conformance.md) for the implemented contracts and
specific limitations. The earlier dependency stack is preserved on `9.4-release`;
major deck/luma/math/loaders upgrades need a compatible dependency matrix, not
incidental changes to that branch.
