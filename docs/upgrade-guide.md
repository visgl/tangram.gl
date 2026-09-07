{/*
tangram-layers
SPDX-License-Identifier: MIT
Copyright (c) vis.gl contributors
 */}

# Upgrade guide

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
