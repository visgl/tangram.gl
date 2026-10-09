{/*
tangram-layers
SPDX-License-Identifier: MIT
Copyright (c) vis.gl contributors
 */}

# Getting started

tangram.gl is experimental. Both module packages are private workspaces, not
npm releases. Start from a repository clone; use the Node version in `.nvmrc`
and the Yarn version declared in `package.json`.

```sh
git clone https://github.com/visgl/tangram.gl.git
cd tangram.gl
corepack enable
yarn install --immutable
yarn website:start --host 127.0.0.1 --port 3000
```

Open [the local examples](http://127.0.0.1:3000/tangram.gl/examples).
The website command builds the renderer, layer and playground assets before
starting Docusaurus. Live tiles require network access; no API key is needed for
the default OpenFreeMap and NASA Blue Marble choices.

## Choose an integration

| Use case | Entry | Start here |
| --- | --- | --- |
| Basemap in a deck.gl application | `@vis.gl/tangram-layers` | [TangramLayer](../api-reference/tangram-layer.md) |
| A custom host owns cameras and GPU passes | `@vis.gl/tangram-renderer/core` | [Renderer](../api-reference/renderer.md) and [HostFrame](../api-reference/host-frame.md) |
| Classic Tangram scene cameras or Leaflet | Renderer root plus example-local adapter | [Classic API](../api-reference/classic-api.md) |
| Flat earth projections | `@vis.gl/tangram-layers/experimental/projected-basemaps` | [Projected basemaps](../developer-guide/projected-basemaps.md) |
| Stereo preview or immersive VR | `@vis.gl/tangram-layers/experimental/webxr` | [WebXR presentation](../api-reference/webxr-presentation.md) |

The renderer is independent of deck.gl and Leaflet, but has its own parsing,
math and luma.gl dependencies. The layer uses the host's device and render pass;
it does not create a second WebGL context.

## Build or develop without the website

```sh
yarn build          # modules and classic playground
yarn typecheck
yarn test-node
yarn test-headless  # requires Chromium: yarn playwright:install
```

After `yarn build`, `yarn start` watches renderer bundles and serves the repository
at `http://127.0.0.1:8000/` (for example, `/examples/deck/`). It does not start
Docusaurus or rebuild the layer/playground assets. Standalone examples must be
served over HTTP(S), not opened with `file://`. See the
[development workflow](../contributor-guide/development.md) for standalone
serving, worker URLs and validation commands. Never commit generated `dist/` files.
