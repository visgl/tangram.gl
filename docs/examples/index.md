{/*
tangram-layers
SPDX-License-Identifier: MIT
Copyright (c) vis.gl contributors
 */}

# Examples

The website publishes every runnable application under the repository's
[`examples/`](https://github.com/visgl/tangram.gl/tree/master/examples)
directory. These are static demo applications, so they can also be served
directly from a checkout with a simple HTTP server.

<div className="example-tile-grid">
  <a className="example-tile" href="/tangram.gl/examples/deck/">
    <span className="example-tile__eyebrow">Integration</span>
    <strong>Deck + TangramLayer</strong>
    <span>Run Tangram beside deck.gl with vector basemaps and overlays.</span>
  </a>
  <a className="example-tile" href="/tangram.gl/examples/classic/?scene=styles/bubble-wrap.yaml">
    <span className="example-tile__eyebrow">Basemap</span>
    <strong>Bubble Wrap</strong>
    <span>A colorful hosted scene with expressive road and label styling.</span>
  </a>
  <a className="example-tile" href="/tangram.gl/examples/classic/?scene=styles/walkabout.yaml">
    <span className="example-tile__eyebrow">Basemap</span>
    <strong>Walkabout</strong>
    <span>Terrain-aware cartography with detailed roads and shields.</span>
  </a>
  <a className="example-tile" href="/tangram.gl/examples/classic/?scene=styles/refill.yaml">
    <span className="example-tile__eyebrow">Basemap</span>
    <strong>Refill</strong>
    <span>A restrained dark style designed to make overlays stand out.</span>
  </a>
  <a className="example-tile" href="/tangram.gl/examples/classic/?scene=styles/refill-blue-terrain.yaml">
    <span className="example-tile__eyebrow">Basemap</span>
    <strong>Refill Blue Terrain</strong>
    <span>Refill with a blue palette, terrain pattern, and no texture.</span>
  </a>
  <a className="example-tile" href="/tangram.gl/examples/classic/?scene=styles/tron.yaml">
    <span className="example-tile__eyebrow">Basemap</span>
    <strong>TRON</strong>
    <span>Procedural neon geometry and animated shader effects.</span>
  </a>
  <a className="example-tile" href="/tangram.gl/examples/classic/?scene=styles/crosshatch.yaml">
    <span className="example-tile__eyebrow">Shader</span>
    <strong>Crosshatch</strong>
    <span>A self-contained texture and shader study with local data.</span>
  </a>
  <a className="example-tile" href="/tangram.gl/examples/classic/?scene=styles/rainbow-buildings.yaml">
    <span className="example-tile__eyebrow">Shader</span>
    <strong>Rainbow Buildings</strong>
    <span>Fragment-shader coloring that cycles through building hues.</span>
  </a>
  <a className="example-tile" href="/tangram.gl/examples/classic/?scene=styles/popup-buildings.yaml">
    <span className="example-tile__eyebrow">Shader</span>
    <strong>Pop-up Buildings</strong>
    <span>A vertex-shader experiment that lifts geometry around the view.</span>
  </a>
  <a className="example-tile" href="/tangram.gl/examples/classic/?scene=styles/local-basemap.yaml">
    <span className="example-tile__eyebrow">Offline</span>
    <strong>Local streets</strong>
    <span>A deterministic vector preview that needs no tile-service key.</span>
  </a>
  <a className="example-tile" href="/tangram.gl/examples/classic/?scene=styles/local-tron.yaml">
    <span className="example-tile__eyebrow">Offline</span>
    <strong>TRON preview</strong>
    <span>A local neon scene for testing when hosted tiles are unavailable.</span>
  </a>
  <a className="example-tile" href="/tangram.gl/examples/classic/?scene=styles/open-light-raster.yaml">
    <span className="example-tile__eyebrow">Raster</span>
    <strong>Light raster basemap</strong>
    <span>An open light raster fallback for dependable map coverage.</span>
  </a>
  <a className="example-tile" href="/tangram.gl/examples/classic/?scene=styles/open-streets-raster.yaml">
    <span className="example-tile__eyebrow">Raster</span>
    <strong>Street map raster</strong>
    <span>Open street-map tiles with familiar labels and landmarks.</span>
  </a>
  <a className="example-tile" href="/tangram.gl/examples/classic/?scene=styles/projection-morph.yaml#7/39/-96">
    <span className="example-tile__eyebrow">Projection</span>
    <strong>Albers projection morph</strong>
    <span>Zoom between Web Mercator and an Albers equal-area projection.</span>
  </a>
</div>

The classic playground remains available as a full-screen application and
includes the same scenes in its control panel.

The deck example is the recommended integration starting point. It exercises
the package entrypoints, a deck.gl overlay, vector styles, and the TRON style
on WebGL and WebGPU.
