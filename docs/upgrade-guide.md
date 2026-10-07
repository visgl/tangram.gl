{/*
tangram-layers
SPDX-License-Identifier: MIT
Copyright (c) vis.gl contributors
 */}

# Upgrade guide

## Development dependency baseline

The development line uses math.gl `5.0.0-alpha.12` and the renderer's optional
loaders.gl adapters use `5.0.0-alpha.9`. The layer's math.gl peer dependency and
the standalone and embedded examples use the same math.gl version. These are
prerelease dependencies; the production YAML and MVT parser selection is unchanged.

The `9.4-release` branch preserves the previous dependency stack. The development
line still uses deck.gl and luma.gl 9.4 until compatible deck.gl and luma.gl WebXR
packages are published. Published deck.gl 9.4 depends on luma.gl 9.4; installing
an independent luma.gl 10 device alongside it is not a supported migration.
The classic community playground also retains its loaders.gl v4 dependency to
satisfy the published playground's peer contract. This is separate from the
renderer's optional v5 adapters.

## From the legacy Tangram package

The old root package published the renderer as `tangram`. In this integration
line, install the renderer and adapter explicitly:

```sh
yarn add @vis.gl/tangram-renderer @vis.gl/tangram-layers
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
formatting and `yarn test` for the browser suite.
