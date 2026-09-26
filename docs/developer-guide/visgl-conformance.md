{/*
tangram-layers
SPDX-License-Identifier: MIT
Copyright (c) vis.gl contributors
 */}

# vis.gl conformance harness

Tangram's parser, projection, and matrix implementations are reached through
small renderer-owned procedure boundaries. The renderer uses math.gl for Web
Mercator projection and matrix operations through Tangram compatibility
adapters; the previous projection formulas and `gl-mat3`/`gl-mat4` packages
remain as test oracles. YAML and MVT loaders.gl implementations remain
comparative candidates until their compatibility and release criteria are met.

This structure lets us measure compatibility before changing runtime behavior:

| Procedure | Production implementation | Candidate | Current result |
| --- | --- | --- | --- |
| Scene YAML | Tangram's `js-yaml` fork | `@loaders.gl/config` | 21 of 23 classic scenes match exactly |
| Vector tiles | `pbf` and `@mapbox/vector-tile` | `@loaders.gl/mvt` | Generated point, line, and polygon fixtures match exactly |
| Web Mercator | `@math.gl/web-mercator` plus Tangram meter adapter | Tangram projection formulas | Edge-domain round trips and tile selection match within numeric tolerance |
| Matrix operations | `@math.gl/core` compatibility adapter | `gl-mat3` and `gl-mat4` | Identity, transforms, projection, look-at, inversion, and singular-matrix behavior match in conformance tests |

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

## Candidate dependency policy

The YAML and MVT candidates are not imported by package entrypoints or the
production renderer graph. Keeping them in `devDependencies` prevents those
evaluations from changing application bundle size or requiring applications to
install both implementations. The exact loaders.gl alpha is pinned while its
new config loader is evaluated. The math.gl projection and matrix adapters are
runtime dependencies; `gl-mat3` and `gl-mat4` remain development dependencies
used only as matrix conformance oracles.

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
feature flag. The matrix adapter preserves Tangram's existing helper surface so
call sites and renderer behavior can migrate independently from the underlying
matrix implementation. The legacy projection formula and matrix packages
remain in tests as conformance oracles.

## Bundle-size baseline

The following compares current `master` against this tranche using
`yarn bundle-size`. These figures include the full renderer dependency graph;
they are not an isolated measurement of `@math.gl/core`:

| Production artifact | `master` raw / gzip | Matrix adapter raw / gzip | Difference |
| --- | ---: | ---: | ---: |
| Renderer minified ESM | 931.0 / 276.8 KB | 963.7 / 286.2 KB | +32.7 / +9.4 KB |
| Renderer debug ESM | 1,796.4 / 394.9 KB | 1,871.9 / 410.1 KB | +75.5 / +15.2 KB |
| TangramLayer + renderer minified ESM (additive upper bound) | 949.4 / 281.4 KB | 982.1 / 290.9 KB | +32.7 / +9.5 KB |

Standalone minified candidate probes provide an early upper-bound for a future
switch: loaders.gl YAML is approximately 54,880 raw / 17,811 gzip bytes,
loaders.gl MVT is 339,709 / 88,905 bytes, and the math.gl Web Mercator helpers
are 476 / 337 bytes. The MVT result identifies an upstream optimization target:
a GeoJSON-only parser entry should not pull in Arrow and binary-geometry
conversion support. MVT remains opt-in until the lightweight parser is
published and Tangram's worker integration is validated against it. The matrix
adapter raises the measured renderer bundle by about 9.4 KB gzip; this full
dependency-graph change should be reviewed against the compatibility and
maintenance benefits before removing the legacy test oracle.
