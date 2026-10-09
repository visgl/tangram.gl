<!--
Tangram
SPDX-License-Identifier: MIT
Copyright (c) 2013-2016 Brett Camper and Mapzen
Copyright (c) 2026 vis.gl contributors
-->

# tangram.gl

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

All workspaces are private and unpublished. The root scripts use
[`@vis.gl/dev-tools`](https://github.com/visgl/dev-tools) for build orchestration,
Vitest testing and Biome linting. Ocular/esbuild produce ES modules and worker
bundles; generated `dist/` output is not committed. `yarn lint:fix` applies
license-header and safe formatting fixes.

To run the documentation and integrated examples:

```sh
yarn website:start --host 127.0.0.1 --port 3000
```

Then open [`http://127.0.0.1:3000/tangram.gl/examples/deck`](http://127.0.0.1:3000/tangram.gl/examples/deck).
The deck demo defaults to WebGPU with the animated TRON style when the
browser supports WebGPU. Use `?device=webgl` to exercise the WebGL path.
For standalone examples, run `yarn build` first, then `yarn start` to watch the
renderer and serve the repository at `http://127.0.0.1:8000/examples/deck/`.

The full documentation is in [`docs/`](docs/), and the runnable examples are
in [`examples/`](examples/). The classic style gallery is a workspace package
at [`examples/classic`](examples/classic) and is built before the website.
