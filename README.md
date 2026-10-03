<!--
Tangram
SPDX-License-Identifier: MIT
Copyright (c) 2013-2016 Brett Camper and Mapzen
-->

# Tangram layers

[![Coverage Status](https://coveralls.io/repos/github/visgl/tangram.gl/badge.svg?branch=master)](https://coveralls.io/github/visgl/tangram.gl?branch=master)

This repository is a vis.gl-oriented monorepo for the Tangram renderer and its
deck.gl integration. It is an experimental Linux Foundation/Mapzen Tangram
custodian fork; it is not the official Tangram project website.

Read the [tangram.gl documentation and examples](https://vis.gl/tangram.gl/).
The canonical website is hosted separately; this repository does not publish
to GitHub Pages.

## Packages

- [`@vis.gl/tangram-renderer`](modules/tangram-renderer/) contains the complete
  Tangram scene, tile, style, label, and luma.gl rendering runtime. It preserves
  the classic default Tangram API and additionally exposes named renderer
  entrypoints for host integrations.
- [`@vis.gl/tangram-layers`](modules/tangram-layers/) contains the experimental
  `TangramLayer` deck.gl adapter. deck.gl owns the device, view state, and render
  pass; Tangram owns scene traversal and basemap drawing.

## Development

```sh
yarn install
yarn build
yarn test
```

The root scripts use [`@vis.gl/dev-tools`](https://github.com/visgl/dev-tools)
for workspace bootstrap, cleaning, and Biome linting. Tangram's renderer still
uses its dedicated Rollup pipeline because it emits both the browser runtime
and the worker bundle; the package entrypoint is generated as part of that
build. `yarn lint:fix` applies the shared formatter and safe fixes.

To serve the deck example locally:

```sh
yarn start
```

Then open [`http://localhost:8000/examples/deck/`](http://localhost:8000/examples/deck/).
The deck demo defaults to WebGPU with the animated TRON style when the
browser supports WebGPU. Use `?device=webgl` to exercise the WebGL path.

The full documentation is in [`docs/`](docs/), and the runnable examples are
in [`examples/`](examples/). The classic style gallery is a workspace package
at [`examples/classic`](examples/classic) and is built before the website.
