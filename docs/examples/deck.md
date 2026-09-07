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
It also supports WebGL, vector and raster styles, deck.gl camera controls,
and runtime `?api_key=...` handling for the original Nextzen style.
