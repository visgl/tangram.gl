{/*
tangram-layers
SPDX-License-Identifier: MIT
Copyright (c) vis.gl contributors
 */}

# vis.gl conformance harness

Tangram's parser and projection implementations are reached through small,
renderer-owned procedure boundaries. The renderer now uses the math.gl Web
Mercator helpers through a Tangram convention adapter; the previous Tangram
formulas remain as test oracles. YAML and MVT loaders.gl implementations remain
comparative candidates until their compatibility and release criteria are met.

This structure lets us measure compatibility before changing runtime behavior:

| Procedure | Production implementation | Candidate | Current result |
| --- | --- | --- | --- |
| Scene YAML | Tangram's `js-yaml` fork | `@loaders.gl/config` | 21 of 23 classic scenes match exactly |
| Vector tiles | `pbf` and `@mapbox/vector-tile` | `@loaders.gl/mvt` | Generated point, line, and polygon fixtures match exactly |
| Web Mercator | `@math.gl/web-mercator` plus Tangram meter adapter | Tangram projection formulas | Edge-domain round trips and tile selection match within numeric tolerance |

The loaders.gl YAML parser currently cannot parse YAML anchors and aliases. It
also rejects an unquoted `rgba(...)` expression accepted by the legacy parser.
Both gaps are recorded as expected incompatibilities in the corpus test rather
than hidden by normalizing or editing the source scenes.

The projection adapter converts math.gl's 512-unit world coordinates to
EPSG:3857 meters using Tangram's circumference constant. Tangram's projected Y
is north-positive; tile-row Y remains south-positive and is handled by the
existing tile conversion functions. The public `Geo` methods still mutate and
return their input coordinate arrays. At floating-point tile boundaries, the
adapter falls back to Tangram's previous arithmetic so tile selection retains
the same `Math.floor` behavior as before.

## Why YAML and MVT candidates remain development dependencies

The loaders.gl candidate modules are not imported by package entrypoints or the
production renderer graph. Keeping them in `devDependencies` prevents this
evaluation from changing application bundle size or requiring applications to
install both implementations. The math.gl adapter is now part of the renderer's
production graph because its projection API passed conformance and bundle checks.

## Replacement criteria

A candidate can replace a legacy implementation only after:

1. all supported scene and tile fixtures have semantic parity;
2. known incompatibilities have either been fixed upstream or covered by a
   deliberate compatibility adapter;
3. browser and worker behavior is tested, not only synchronous Node parsing;
4. performance and bundle-size measurements show an acceptable tradeoff; and
5. the candidate dependency moves from development-only evaluation into the
   appropriate published package dependency set.

The legacy projection formula remains in the test suite as a conformance oracle.
The loaders.gl candidates remain a migration safety net, not runtime feature
flags.

## Bundle-size baseline

The following compares current `master` against this PR using
`yarn bundle-size`. The math.gl package adds less than 1 KB gzip to the renderer
and deck-layer combination:

| Production artifact | `master` raw / gzip | This PR raw / gzip | Difference |
| --- | ---: | ---: | ---: |
| Renderer minified ESM | 929.6 / 276.1 KB | 931.0 / 276.8 KB | +1.4 / +0.7 KB |
| Renderer debug ESM | 1,785.9 / 393.2 KB | 1,790.8 / 394.7 KB | +4.9 / +1.5 KB |
| TangramLayer + renderer minified ESM (additive upper bound) | 948.0 / 280.7 KB | 949.5 / 281.4 KB | +1.5 / +0.7 KB |

The loaders.gl MVT probe previously measured 339,709 raw / 88,905 gzip bytes,
which motivated the upstream GeoJSON-only parser entry. MVT remains opt-in until
the lightweight parser is published and Tangram's worker integration is
validated against it.
