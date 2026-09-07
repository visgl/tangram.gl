{/*
tangram-layers
SPDX-License-Identifier: MIT
Copyright (c) vis.gl contributors
 */}

# Getting started

Install the workspace dependencies and build both packages from the repository
root:

```sh
yarn install
yarn build
```

Run the example server with `yarn start`, then open
`http://localhost:8000/examples/deck/`. The example uses a browser import map
to resolve the local package builds and keeps deck.gl and Tangram on one luma.gl
runtime.

Applications can install the packages independently once they are published:

```sh
yarn add @vis.gl/tangram-renderer @vis.gl/tangram-layers
```

The renderer package is usable without deck.gl. Add `@vis.gl/tangram-layers`
when deck.gl should own the camera, device, and render pass.
