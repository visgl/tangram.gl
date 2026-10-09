{/*
tangram-layers
SPDX-License-Identifier: MIT
Copyright (c) vis.gl contributors
 */}

# Deck.gl basemap example

The live integration example is built from the
[`examples/deck` source directory](https://github.com/visgl/tangram.gl/tree/master/examples/deck)
and staged into the documentation site during the website build. It is
embedded in the website so the Examples sidebar remains available while you
explore it.

<div>
  <a className="button button--primary button--lg" href="/tangram.gl/examples/deck">
    Open the interactive TangramLayer example
  </a>
</div>

The example defaults to WebGPU and the vector-backed TRON style when available.
It also supports WebGL 2, vector and raster styles, and deck.gl camera controls.
Use the password field for an existing Nextzen key when testing the original
TRON scene; do not place credentials in shared URLs.

Compare [flat MapView](/tangram.gl/examples/deck-map-flat),
[GlobeView](/tangram.gl/examples/deck-globe),
[FirstPersonView](/tangram.gl/examples/deck-first-person), and the
[experimental projections](/tangram.gl/examples/deck-projected).
See [TangramLayer](../api-reference/tangram-layer.md) for supported geometry and lifecycle.
