<!--
tangram-layers
SPDX-License-Identifier: MIT
Copyright (c) vis.gl contributors
-->

# TangramLayer bridge example

The public example is deployed from the monorepo branch to:

```text
https://visgl.github.io/tangram.gl/examples/deck/
```

The page opts out of search indexing and the published site includes a
`robots.txt` that disallows crawling. It is an experimental fork demo, not an
official Tangram site.

To run it locally from a fresh checkout, build the package entrypoints and then
serve the repository as the web root:

```sh
yarn build:modules
python3 -m http.server 8000
```

Then open:

```text
http://localhost:8000/examples/deck/
```

The zero-parameter demo defaults to WebGPU when the browser exposes it and to
the vector-backed TRON style. Use the selectors or `?device=webgl` and
`?basemap=streetsVector` to exercise the compatibility paths.

The demo can switch between Streets vector tiles, styled locally by
Tangram, Positron raster tiles, and the canonical animated TRON 2.0
vector style from [`tangrams/tron-style`](https://github.com/tangrams/tron-style).
The vector-backed TRON adaptation reuses the original open-source style bundle,
palette, glow, and animation shaders without requiring an API key. The exact
original TRON scene uses Nextzen vector and terrain-normal tiles. Nextzen no
longer accepts new signups, but an existing key can be entered in the demo's
password field. It is retained only in that browser tab's session storage and
is never written to source. The vector-backed adaptation stays on WebGPU using
portable polygon and line shaders, including a non-additive WGSL translation
of the two-way highway traffic pulses. More general custom shader blocks remain
WebGL-only. The exact Nextzen scene currently selects WebGL because its
point/text styles are also unported.
The demo loads pinned deck.gl and luma.gl ESM builds from esm.sh. Both deck's
standard overlay layers and Tangram's renderer resolve one shared
`@luma.gl/core` module, so every resource and render pass belongs to the same
luma runtime.
The prototype supports one Web Mercator view. deck.gl remains authoritative for
longitude, latitude, zoom, bearing, and pitch; Tangram receives the deck camera
matrices so vector and raster basemaps remain aligned with deck layers while the
controller tilts and rotates the view.

Use `?view=mapFlat` or `?view=mapPerspective` to compare the map views.
`?view=firstPerson` uses the planar first-person adapter, which selects Tangram
tiles from the camera's visible ground footprint and derives LOD from projected
meters per pixel. Finite frustum/ground intersections support horizon-crossing
views, bounded by the camera planes and `firstPersonMaxGroundExtent` (20 km per
east/north axis by default). Sky-only views select no ground tiles; terrain and
elevated-only visibility remain future work. `?view=globe` projects Tangram tile
vertices onto deck.gl's sphere with experimental coarse-mesh refinement.
Tangram renders into deck.gl's active luma.gl render pass. On WebGL, the layer
brackets Tangram GPU work with the WebGLDevice state stack and then leaves a
clean depth/stencil buffer for the deck layers above it. The WebGPU path owns
no raw context handle. Tangram's depth, cull, and blend modes become immutable
luma.gl render-pipeline parameters, so the basemap participates in the host
depth buffer without mutating backend state.

The example imports `TangramLayer` from `@vis.gl/tangram-layers` rather than
constructing the adapter locally. Its renderer accepts a
host-provided frame containing viewport dimensions, geographic view state,
camera matrices, tile padding, and the active render pass. Standalone Tangram
continues to use `Scene` for canvas construction and frame scheduling.

On WebGPU, the default vector-backed TRON scene exercises portable polygon and
expanded-line WGSL pipelines. Extruded polygons carry buffered normals for
stable directional side lighting while flat ground colors remain unchanged.
Standalone labels retain Tangram's collision and canvas-atlas pipeline and
render through a portable text-quad WGSL shader. Generic shader points and
textured icons also use buffered portable attributes.
For diagnostics, `?portable_text=0` disables WebGPU labels and `?traffic=0`
pauses the portable vehicle pulses without changing the selected basemap. The
portable traffic shader uses fragment derivatives to keep each vehicle a
stable, compact screen-space mark while it moves continuously in both highway
directions. `?line_probe=1` adds four coincident test lines near the initial
view: cyan at ground level, magenta with a positive screen-space offset, and
orange with a negative offset at 60 meters elevation, plus a green dashed line.
It is useful for direct WebGPU/WebGL position and texture comparisons and is
absent from the default demo.

## Uniform-buffer migration

The `ib/deck-tangram-layer-uniform-buffers` sub-branch adds a WebGL2
`UniformBuffer` abstraction with std140 packing and integrates uniform-block
binding into `ShaderProgram`. It is exposed through `Tangram.debug` for the
spike, but the existing scalar-uniform path remains unchanged.

The generated polygon and point shaders now upgrade to GLSL 300 when uniform
blocks are enabled, and frame/view globals are supplied through a real
`TangramView` block. The deck bridge also restores indexed uniform-buffer state
that luma.gl's general WebGL state stack intentionally does not track.

Camera projection state and per-tile transforms are supplied through separate
`TangramCamera` and `TangramTile` blocks. Uniform-buffer storage is injectable,
and the deck bridge now allocates and updates those buffers through luma.gl's
`Device` API. Tangram still binds the WebGL resource handles while issuing its
legacy draw calls.

The bridge forwards deck's active `RenderPass` through `Scene` to every mesh,
and `VBOMesh` delegates portable draws before any raw WebGL call is reachable.
Uniform blocks expose luma-compatible binding layouts and WGSL declarations
while preserving std140 packing. Shader, texture, vertex, index, uniform-buffer,
pipeline, and vertex-array resources are all allocated and destroyed through
the luma.gl `Device`; the WebGPU path never unwraps those resources or the
device itself.
