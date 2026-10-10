{/*
tangram-layers
SPDX-License-Identifier: MIT
Copyright (c) vis.gl contributors
 */}

# Overview

[![CI](https://github.com/visgl/tangram.gl/actions/workflows/test.yml/badge.svg?branch=master)](https://github.com/visgl/tangram.gl/actions/workflows/test.yml)
[![Coverage](https://coveralls.io/repos/github/visgl/tangram.gl/badge.svg?branch=master)](https://coveralls.io/github/visgl/tangram.gl?branch=master)
[![TypeScript](https://img.shields.io/badge/Typed-TypeScript-3178c6?logo=typescript&logoColor=white)](https://github.com/visgl/tangram.gl/tree/master/modules)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://github.com/visgl/tangram.gl/blob/master/LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/visgl/tangram.gl?style=flat)](https://github.com/visgl/tangram.gl/stargazers)

With gratitude to Brett Camper, the Mapzen team, the original Tangram contributors
and the open mapping community. This project preserves and extends their work.

<div className="project-credits" aria-label="Project and tile-provider acknowledgements">
  <a href="https://github.com/tangrams/tangram"><img src="/tangram.gl/img/credits/tangram.png" alt="Tangram" width="126" height="50" /></a>
  <a href="https://www.mapzen.com/"><img src="/tangram.gl/img/credits/mapzen.png" alt="Mapzen" width="160" height="50" /></a>
  <a href="https://openfreemap.org/"><img src="/tangram.gl/img/credits/openfreemap.jpg" alt="OpenFreeMap" width="50" height="50" /></a>
  <a href="https://mapterhorn.com/"><img src="/tangram.gl/img/credits/mapterhorn.png" alt="Mapterhorn" width="147" height="50" /></a>
</div>

Original rendering by Tangram/Mapzen; vector tiles by OpenFreeMap; elevation
tiles in the terrain POC by Mapterhorn. These acknowledgements do not replace
[source-specific map attribution](developer-guide/tile-providers.md) or imply endorsement.

tangram.gl combines a standalone luma.gl-backed Tangram renderer with a deck.gl
basemap adapter. It is an experimental custodian fork, not the official Tangram
website. Both module packages remain private and unpublished.

Start with [Getting started](get-started/getting-started.md), try the
[examples](/tangram.gl/examples), or read [What's new](whats-new.md) and the
[upgrade guide](upgrade-guide.md).

## Developer guide

- [Working with AI agents](developer-guide/working-with-ai.md) — version-aware documentation and browser verification.
- [Architecture](developer-guide/architecture.md) — package boundaries and ownership.
- [View integration](developer-guide/view-integration.md) — current capabilities and remaining work.
- [Projection conventions](developer-guide/projection-conventions.md) — domains, axes and units.
- [Projected basemaps](developer-guide/projected-basemaps.md) — optional earth projections and navigation.
- [Tile providers](developer-guide/tile-providers.md) — data schemas and required attribution.
- [Tile loading](developer-guide/tile-loading.md) — source/tileset boundaries and resource policy.
- [Bundling](developer-guide/bundling.md) — reproducible artifact measurements.
- [Tangram concepts](developer-guide/legacy-concepts.md) — sources, layers and styling.
- [vis.gl conformance](developer-guide/visgl-conformance.md) — replacement criteria and parser gaps.

## API reference

### `@vis.gl/tangram-renderer`

[Package entries](api-reference/tangram-renderer.md) ·
[Classic API](api-reference/classic-api.md) ·
[Scene](api-reference/scene.md) ·
[Renderer](api-reference/renderer.md) ·
[HostFrame](api-reference/host-frame.md) ·
[Styling](api-reference/styling.md)

### `@vis.gl/tangram-layers`

[Package entries](api-reference/tangram-layers.md) ·
[TangramLayer](api-reference/tangram-layer.md) ·
[Experimental WebXR](api-reference/webxr-presentation.md)

## Contributor guide

[Development and validation](contributor-guide/development.md) ·
[Monorepo](contributor-guide/monorepo.md) ·
[Licensing](contributor-guide/licensing.md) ·
[Release workflow](contributor-guide/release.md)

## Historical resources

Tangram grew out of Mapzen's open-source mapping work. The
[original repository](https://github.com/tangrams/tangram),
[legacy documentation](https://tangrams.readthedocs.io/en/latest/), and
[Mapzen product page](https://www.mapzen.com/products/tangram/) preserve that context.

### Original demo catalog

The [demos guide](https://tangrams.readthedocs.io/en/main/Tutorials/Demos/)
catalogs historical projects. Useful scene references include
[simple-demo](https://github.com/tangrams/simple-demo),
[filters-demo](https://github.com/tangrams/filters-demo),
[shaders-demo](https://github.com/tangrams/shaders-demo),
[lights-cameras-demo](https://github.com/tangrams/lights-cameras-demo), and
[terrain-demos](https://github.com/tangrams/terrain-demos).

The [Sandbox](https://github.com/tangrams/tangram-sandbox) contains the original
[Crosshatch](https://github.com/tangrams/tangram-sandbox/blob/gh-pages/styles/crosshatch.yaml)
and [Albers](https://github.com/tangrams/tangram-sandbox/blob/gh-pages/examples/albers.yaml)
experiments. The local [classic playground](/tangram.gl/examples/classic) ports
these ideas, including a bundled US fixture for the animated Albers morph.
Historical services may no longer work; use current provider and attribution
guidance rather than copying old credentials or service URLs.
