{/*
tangram-layers
SPDX-License-Identifier: MIT
Copyright (c) vis.gl contributors
 */}

# vis.gl conformance harness

For the renderer's Mercator/globe CPU boundary, independent math.gl comparisons,
and exact coordinate units and domains, see
[projection boundary and conventions](./projection-conventions.md).

Tangram's parser, projection, and matrix implementations are reached through
small renderer-owned procedure boundaries. The renderer uses math.gl for Web
Mercator projection and native `Matrix3`/`Matrix4` operations in its camera and
tile paths; the previous projection formulas remain as a test oracle, and
captured matrix outputs preserve the former `gl-mat3`/`gl-mat4` results.
YAML and MVT loaders.gl implementations remain
comparative candidates until their compatibility and release criteria are met.

This structure lets us measure compatibility before changing runtime behavior:

| Procedure | Production implementation | Candidate | Current result |
| --- | --- | --- | --- |
| Scene YAML | Tangram's `js-yaml` fork | `@loaders.gl/config/yaml-loader` alpha.11 | All 26 classic scene files match; flow merges, timestamps and scientific scalar syntax still differ |
| Vector tiles | `pbf` and `@mapbox/vector-tile` | `@loaders.gl/mvt/mvt-geojson-loader` alpha.11 | Points, lines, polygons, extents, IDs and `parse_json` match; an authored `__tangram_layer` property is still overwritten by the candidate |
| Archive loading | Optional worker provider | `@loaders.gl/pmtiles` alpha.11 | Hermetic 16 KB PMTiles v3 fixture checks range requests, raw bytes, metadata, credits and both MVT decoders |
| Web Mercator | `@math.gl/web-mercator` plus Tangram meter adapter | Tangram projection formulas | Edge-domain round trips and tile selection match within numeric tolerance |
| Matrix operations | `@math.gl/core` `Matrix3`/`Matrix4` in camera and tile paths | Golden outputs captured from `gl-mat3@1.0.0` and `gl-mat4@1.1.4` | Identity, transforms, projection, look-at, inversion, and singular-matrix behavior match in conformance tests |
| WebXR surface rays | `@math.gl/culling` analytic plane/sphere shapes | Captured Tangram ground/sphere formulas | +Z/+Y axis adapter, forward/inside/tangent/miss cases, ground tolerance and physical tabletop edges match; existing per-eye picking/grabbing tests cover placement and clipping |

The published YAML parser now supports anchors, aliases, block merge keys and
unquoted `rgba(...)`. The complete classic corpus is compared directly, without
expected failures or edits to scene fixtures. Additional semantic checks expose
remaining gaps: flow-style `<<` remains a literal property, timestamps remain
strings instead of `Date`, and `1e3` becomes a number instead of Tangram's string.
Flow merge handling and explicit-key precedence are addressed in
[loaders.gl #4195](https://github.com/visgl/loaders.gl/pull/4195); the pinned
release and production parser remain unchanged until that fix is published and
conformance is rerun. These are explicit incompatibility tests, not a claim that the default parser
can safely change. MVT also retains its legacy default until the injected
layer-property collision can be eliminated without losing authored properties.
MLT remains an explicitly selected worker decoder; there is no legacy MLT parser
to replace or basis for claiming a full MVT/MLT conformance corpus.

The projection adapter converts math.gl's 512-unit world coordinates to
EPSG:3857 meters using Tangram's circumference constant. Tangram's projected Y
is north-positive; tile-row Y remains south-positive and is handled by the
existing tile conversion functions. The public `Geo` methods still mutate and
return their input coordinate arrays. At floating-point tile boundaries, the
adapter falls back to Tangram's previous arithmetic so tile selection retains
the same `Math.floor` behavior as before.

## Candidate dependency policy

The YAML and MVT candidates are not imported by normal package entrypoints or the
production renderer graph. The opt-in `loaders-gl-worker.js` bundles MVT, MLT and
PMTiles integrations separately. Keeping them in `devDependencies` prevents those
evaluations from changing application bundle size or requiring applications to
install both implementations. The exact loaders.gl alpha is pinned while its
new config loader is evaluated. The math.gl projection and matrix classes are
runtime dependencies. Legacy matrix packages are no longer installed: the
matrix conformance test keeps their captured numeric outputs as stable fixtures.

## Replacement criteria

A candidate can replace a legacy implementation only after:

1. all supported scene and tile fixtures have semantic parity;
2. known incompatibilities have either been fixed upstream or covered by a
   deliberate compatibility adapter;
3. browser and worker behavior is tested, not only synchronous Node parsing;
4. performance and bundle-size measurements show an acceptable tradeoff; and
5. the candidate dependency moves from development-only evaluation into the
   appropriate published package dependency set.

Until then, the conformance suite is a migration safety net, not a runtime
feature flag. Camera and tile transforms now call math.gl's native matrix APIs
directly while preserving Tangram's caller-owned typed-array boundaries. The
legacy projection formula remains in tests, and captured matrix outputs preserve
the matrix comparison after the legacy packages are removed.

## Candidates for upstream sharing

The following are opportunities, not production switches or claims of equivalence.
Compare identical fixtures and measure the optional dependency graph before replacing
an implementation. Keep Tangram styling and packed vertex formats in renderer adapters.

| Priority | Owner | Candidate and required boundary |
| --- | --- | --- |
| 1 | loaders.gl/config | Fix flow-style merge handling and offer explicit scalar-schema compatibility for timestamps/scientific notation. The existing scene corpus and semantic mismatch cases are ready-made regression fixtures. |
| 2 | loaders.gl/mvt | Return source-layer provenance separately from authored properties, so an internal grouping field cannot overwrite a user's property. Preserve the lightweight GeoJSON parser subpath and Tangram's normalization/`parse_json` adapter. |
| 3 | math.gl/polygon | Extend triangle subdivision with asynchronous/batched transforms and pluggable attribute interpolation. Tangram currently batches edge/interior probes through a worker RPC; a synchronous per-position callback cannot replace that contract. Preserve indexed seams, height-aware wall topology, budgets and determinism. |
| 4 | loaders.gl/tiles | Evaluate shared Tileset2D with Tangram's existing traversal adapter. Request/cache primitives already exist upstream; compare generation cancellation, worker-build completion, parent fallback pinning and CPU/GPU resource release before replacing Tangram's build queue/cache. Upstream only the missing lifecycle hooks. |
| 5 | math.gl/culling | WebXR surface rays now use existing analytic sphere/plane shapes with conformance coverage. No duplicate upstream intersection API is needed. A dedicated analytic-shape leaf could reduce optional-entry cost; measure it before proposing another public subpath. |

PMTiles metadata/attribution propagation is another focused loaders.gl compatibility
candidate; first verify whether the latest upstream source already fixes the published
alpha behavior described below. Native-import compatibility should be evaluated separately
from browser worker behavior.

Checked integer quantization could become a geometry utility if a second consumer
needs it. Tangram's 1/16-meter signed-short height slot is not itself a shared geospatial
contract, so the small packing helper remains local. Collision priorities, linked
point/text placement and atlas byte ranges also remain Tangram responsibilities.

The WebXR surface migration uses the already pinned math.gl alpha.15. Its minified
consumer probe (deck/luma, math.gl/core, Tangram renderer and mjolnir external;
culling included) grows from 28.2 / 8.7 KB raw/gzip to 38.6 / 11.6 KB: about
+10.3 KB raw / +2.9 KB gzip. The normal layer artifact is byte-identical; the
renderer code and dependency graph are unchanged (builds embed their commit SHA).
The published WebXR ESM artifact keeps a resolvable culling import; both browser
example import maps explicitly map it to the same math.gl release and core runtime.

## Historical matrix-migration baseline

The following records the matrix-migration tranche and its preceding `master`,
using `yarn bundle-size`. These figures include the full renderer dependency graph;
they are not an isolated measurement of `@math.gl/core`:

| Production artifact | `master` raw / gzip | Native matrix calls raw / gzip | Difference |
| --- | ---: | ---: | ---: |
| Renderer minified ESM | 931.0 / 276.8 KB | 962.4 / 285.8 KB | +31.4 / +9.0 KB |
| Renderer debug ESM | 1,796.4 / 394.9 KB | 1,867.2 / 409.1 KB | +70.8 / +14.2 KB |
| TangramLayer + renderer minified ESM (additive upper bound) | 949.4 / 281.4 KB | 980.9 / 290.5 KB | +31.5 / +9.1 KB |

Native matrix calls reduced the renderer artifact by 1.3 KB raw / 0.4 KB gzip
compared with the preceding compatibility-adapter tranche. The overall matrix
migration raised the measured renderer bundle by about 9.0 KB gzip. Older
broad-import parser probes are superseded by the lightweight probes below.
The legacy matrix packages have been removed from
development dependencies while golden output fixtures retain the conformance
coverage.

## Current parser probes and rollout gate

The following snapshot uses loaders.gl `5.0.0-alpha.11` and math.gl `5.0.0-alpha.15`.
Run `yarn bundle-size:parsers` to reproduce minified browser probes including
the Tangram normalization adapter. The script also rejects accidental Arrow/GIS
conversion imports in the lightweight MVT graph. Measurements use decimal KB:

| Parser with adapter | Minified | Gzip |
| --- | ---: | ---: |
| Legacy YAML | 32.4 KB | 10.6 KB |
| loaders.gl YAML alpha.11 | 9.6 KB | 3.1 KB |
| Legacy MVT | 25.1 KB | 8.1 KB |
| loaders.gl lightweight MVT alpha.11 | 27.8 KB | 9.3 KB |

These supersede historical broad-import parser estimates, not the matrix
migration numbers. Both default parser switches remain blocked by the semantic
gaps above. No legacy dependency is removed while production still imports it.
Published PMTiles drops attribution while normalizing archive metadata; the
source adapter additionally reads raw archive JSON and caches the combined
credits until upstream fixes that behavior. Its native Node import reaches an
extensionless `@maplibre/mlt` import; archive integration therefore runs in Chromium, its
intended worker runtime, while transport lifecycle is tested separately in Node.

The source-capability tranche adds 6.5 KB minified / 1.9 KB gzip to the complete
renderer (1,068.6 / 316.1 KB becomes 1,075.2 / 318.0 KB); that is lifecycle/API
code, not a new runtime loaders.gl import. The opt-in worker decreases from
988.0 / 236.6 KB to 929.2 / 221.5 KB. The TangramLayer root and experimental
WebXR entries remain unchanged. Renderer totals include both the main code and
its embedded worker and are not isolated parser measurements.
