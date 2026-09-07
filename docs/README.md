{/*
tangram-layers
SPDX-License-Identifier: MIT
Copyright (c) vis.gl contributors
 */}

# Overview

This site documents the vis.gl-oriented Tangram monorepo: a standalone
luma.gl-backed renderer and a deck.gl adapter that can compose it as a basemap.
The project is an experimental custodian fork and is not the official Tangram
website.

> With gratitude to the Mapzen team, the original Tangram contributors, and the
> open mapping community whose work made this project possible. This repository
> preserves and extends that work with modern vis.gl integration.

- [What's new](whats-new.md) — notable changes by release line.
- [Upgrade guide](upgrade-guide.md) — migration notes from legacy Tangram.

## Developer guide

- [Getting started](get-started/getting-started.md) — install, build, and run the examples.
- [Architecture](developer-guide/architecture.md) — package boundaries and render ownership.
- [Bundling](developer-guide/bundling.md) — measure the footprint of a small deck.gl basemap app.
- [Tangram concepts](developer-guide/legacy-concepts.md) — scene structure,
  sources, layers, styles, and porting guidance.

## Contributor guide

- [Development workflow](contributor-guide/development.md) — workspaces,
  dev-tools, and validation.
- [Monorepo guide](contributor-guide/monorepo.md) — workspaces, packages, and
  repository commands.
- [Release workflow](contributor-guide/release.md) — versioning and publishing
  the workspace packages.

## API reference

### `@vis.gl/tangram-renderer`

- [Package overview](api-reference/tangram-renderer.md) — renderer exports.
- [Classic Tangram API](api-reference/classic-api.md) — retained default and
  Leaflet integration APIs.
- [Scene API](api-reference/scene.md) — runtime scene configuration, queries,
  events, and lifetime.
- [Renderer API](api-reference/renderer.md) — host-device integration.
- [HostFrame API](api-reference/host-frame.md) — shared geographic state and
  one or more host camera views.
- [Styling reference](api-reference/styling.md) — scene, source, layer, draw, and filter syntax.

### `@vis.gl/tangram-layers`

- [Package overview](api-reference/tangram-layers.md) — deck.gl adapter exports.
- [TangramLayer API](api-reference/tangram-layer.md) — layer properties and lifecycle.

## Examples and project information

- [Deck example](examples/deck.md) — the runnable WebGL/WebGPU integration.

## Historical resources

Tangram grew out of Mapzen's open-source mapping work. These links preserve the
original project context and point to the demos that inspired this fork. They
are useful references when porting a style or checking how a feature behaved in
the classic browser renderer.

### Project history

- [Mapzen Tangram product page](https://www.mapzen.com/products/tangram/) — a
  visual overview of Tangram's live vector rendering, animated shaders, 3D
  buildings, and style gallery.
- [Tangram documentation](https://tangrams.readthedocs.io/en/latest/) — the
  legacy API, scene syntax, tutorials, and deployment guidance.
- [Tangram source repository](https://github.com/tangrams/tangram) — the
  original implementation and issue history.
- [Tangram Sandbox](https://github.com/tangrams/tangram-sandbox) — the
  experimental gallery behind many of the old Tangram Play links. Its
  [standalone `tangram.html` entrypoint](https://github.com/tangrams/tangram-sandbox/blob/gh-pages/tangram.html)
  loads styles from the repository rather than from a hosted editor.

The projection example is based on the sandbox's
[Albers experiment](https://github.com/tangrams/tangram-sandbox/blob/gh-pages/examples/albers.yaml),
which morphs the map from Web Mercator into an equal-area projection as the
camera zoom changes. This port vendors a small US TopoJSON fixture so the
experiment remains runnable after the original tile service is unavailable.

### Original demo catalog

The [Tangram demos guide](https://tangrams.readthedocs.io/en/main/Tutorials/Demos/)
organizes the historical examples by the technique they demonstrate. The
standalone repositories remain the best source for their scene files and
small, focused experiments:

- [simple-demo](https://github.com/tangrams/simple-demo) — a minimal scene and
  map setup.
- [generic-demo](https://github.com/tangrams/generic-demo) — a general-purpose
  starter application.
- [highways-demo](https://github.com/tangrams/highways-demo) — road styling and
  line-width experiments.
- [raster-baselayer-demo](https://github.com/tangrams/raster-baselayer-demo) —
  a raster layer beneath Tangram vector data.
- [filters-demo](https://github.com/tangrams/filters-demo) and
  [road-filters-demo](https://github.com/tangrams/road-filters-demo) — feature
  filtering examples.
- [explorer](https://github.com/tangrams/explorer) — interactive inspection of
  scene features and filters.
- [lights-cameras-demo](https://github.com/tangrams/lights-cameras-demo) —
  camera, lighting, and interaction experiments.
- [shaders-demo](https://github.com/tangrams/shaders-demo) — custom shader
  effects and animated styling.
- [terrain-demos](https://github.com/tangrams/terrain-demos) — terrain and
  elevation experiments.

The Crosshatch link in the old Play URL can be recovered directly from the
Sandbox repository: [crosshatch.yaml](https://github.com/tangrams/tangram-sandbox/blob/gh-pages/styles/crosshatch.yaml)
and its texture assets. The repository's `tangram.html` is a small Leaflet
wrapper around the legacy Tangram browser API, so it is a good behavioral
reference but not a dependency we should load at runtime.

The demos guide also links to third-party newsroom projects, including maps
created for election coverage, weather, and breaking news. Those projects are
valuable design references, but their data, hosting, and application code are
maintained outside this repository.

### Examples in this repository

The [classic playground](/tangram.gl/examples/classic/) collects the
style-gallery experience in a buildable workspace package. The [deck.gl
example](/tangram.gl/examples/deck/) shows the modern package boundary and
layer lifecycle. Candidate ports from the catalog above should keep their
scene files in `/examples`, consume `@vis.gl/tangram-renderer`, and avoid
embedding service credentials in source or generated assets.

This gives us a practical local replacement for Tangram Play: port a Sandbox
scene and its textures into an example package, then use the package's local
renderer and a small controls panel. A full in-browser scene editor can be
added later without relying on the retired Mapzen service.
