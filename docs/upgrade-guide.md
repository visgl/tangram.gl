{/*
tangram-layers
SPDX-License-Identifier: MIT
Copyright (c) vis.gl contributors
 */}

# Upgrade guide

## Dependency compatibility

The development line uses math.gl `5.0.0-alpha.13` and the renderer's optional
loaders.gl core, configuration, loader utilities and tiles use `5.0.0-alpha.10`.
MVT, MLT and PMTiles are pinned to `5.0.0-alpha.9`.
The layer's math.gl peer dependency and
the standalone and embedded examples use the same math.gl version. These are
prerelease dependencies; the production YAML and MVT parser selection is unchanged.

The `9.4-release` branch preserves the previous dependency stack. The development
line uses deck.gl and luma.gl 9.4. Published deck.gl 9.4 depends on luma.gl 9.4; installing
an independent luma.gl 10 device alongside it is not a supported migration.
The classic community playground also retains its loaders.gl v4 dependency to
satisfy the published playground's peer contract. This is separate from the
renderer's optional v5 adapters.

## From the legacy Tangram package

The old root package published the renderer as `tangram`. In this integration
line, the renderer and adapter are separate private workspaces, not npm releases.
Build a clone before importing them:

```sh
yarn install --immutable
yarn build
```

Use `@vis.gl/tangram-renderer` when building a standalone Tangram scene. Use
`TangramLayer` from `@vis.gl/tangram-layers` when the host application is a
deck.gl application. The adapter expects deck.gl to provide the luma.gl
`Device`, viewport, and render pass; it does not create a second WebGL context.

## Repository layout changes

| Legacy path | Current path |
| --- | --- |
| `src/` | `modules/tangram-renderer/src/` |
| `dist/` | `modules/tangram-renderer/dist/` |
| `test/` | `modules/tangram-renderer/test/` |
| `demos/` | `examples/` |
| deck bridge | `modules/tangram-layers/src/` |

Run `yarn install` once at the repository root. Workspace package builds are
then available through `yarn build`; use `yarn lint:fix` for the shared Biome
formatting and `yarn test` for lint, Node and Chromium checks.

`dist/` is generated and no longer tracked. Fresh checkouts must build before
using package entries, schemas or workers. Browser outputs are ES modules;
classic-script `tangram.debug.js` and `tangram.min.js` no longer exist. Replace
script-tag/global assumptions with ESM imports. The root ESM compatibility entry
still assigns `globalThis.Tangram`; the host-only core entry does not.

Leaflet integration has moved to `examples/classic/leaflet-layer.js`; it is not
a renderer export. The documentation host is now `https://vis.gl/tangram.gl/`,
and this repository no longer deploys GitHub Pages.
