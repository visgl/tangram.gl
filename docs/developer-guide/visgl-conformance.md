{/*
tangram-layers
SPDX-License-Identifier: MIT
Copyright (c) vis.gl contributors
 */}

# vis.gl conformance harness

Tangram's parser and projection implementations are now reached through small,
renderer-owned procedure boundaries. The production renderer continues to use
the original Tangram implementations. Parallel implementations based on
loaders.gl and math.gl are development-only candidates that run in comparative
tests.

This structure lets us measure compatibility before changing runtime behavior:

| Procedure | Production implementation | Candidate | Current result |
| --- | --- | --- | --- |
| Scene YAML | Tangram's `js-yaml` fork | `@loaders.gl/config` | 21 of 23 classic scenes match exactly |
| Vector tiles | `pbf` and `@mapbox/vector-tile` | `@loaders.gl/mvt` | Generated point, line, and polygon fixtures match exactly |
| Web Mercator | Tangram projection formulas | `@math.gl/web-mercator` | Representative locations and round trips match within numeric tolerance |

The loaders.gl YAML parser currently cannot parse YAML anchors and aliases. It
also rejects an unquoted `rgba(...)` expression accepted by the legacy parser.
Both gaps are recorded as expected incompatibilities in the corpus test rather
than hidden by normalizing or editing the source scenes.

## Why the candidates are development dependencies

The candidate modules are not imported by package entrypoints or the production
renderer graph. Keeping them in `devDependencies` prevents this evaluation from
changing application bundle size or requiring applications to install both
implementations. The exact loaders.gl alpha is pinned while its new config
loader is evaluated.

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
feature flag.

## Bundle-size baseline

The candidates are excluded from production bundles. With the current build
toolchain, extracting the legacy procedure boundaries changes the renderer by
only a small amount:

| Production artifact | `master` raw / gzip | Conformance branch raw / gzip | Difference |
| --- | ---: | ---: | ---: |
| Renderer ESM | 615,481 / 179,451 bytes | 615,828 / 179,531 bytes | +347 / +80 bytes |
| Legacy renderer bundle | 680,832 / 191,838 bytes | 683,222 / 192,522 bytes | +2,390 / +684 bytes |
| Package entry | 403 / 246 bytes | 403 / 246 bytes | no change |

Standalone minified candidate probes provide an early upper-bound for a future
switch: loaders.gl YAML is approximately 54,880 raw / 17,811 gzip bytes,
loaders.gl MVT is 339,709 / 88,905 bytes, and the math.gl Web Mercator helpers
are 476 / 337 bytes. The MVT result identifies an upstream optimization target:
a GeoJSON-only parser entry should not pull in Arrow and binary-geometry
conversion support.
