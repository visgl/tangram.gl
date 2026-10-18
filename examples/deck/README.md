<!--
tangram-layers
SPDX-License-Identifier: MIT
Copyright (c) vis.gl contributors
-->

# TangramLayer bridge example

The [live example](https://vis.gl/tangram.gl/examples/deck/) renders a Tangram
basemap alongside deck.gl overlays. It is an experimental integration, not the
original Tangram site.

## Run locally

From the repository root:

```sh
yarn install --immutable
yarn build
yarn start
```

Open `http://localhost:8000/examples/deck/`. For the integrated Docusaurus
examples, use `yarn website:start` and open `/tangram.gl/examples/deck`.

## Views and devices

Use `?view=mapFlat`, `mapPerspective`, `firstPerson`, or `globe` to choose the
view. deck.gl owns navigation, camera matrices, scheduling and the device;
Tangram owns the basemap's scene and resources. First-person visibility uses a
bounded flat-ground footprint. Globe rendering is experimental and Mercator
tiles do not cover the poles.

The default uses WebGPU when available. Select `?device=webgl` to compare WebGL 2.
Installed deck.gl and luma.gl packages are bundled together and share one luma runtime. See
[view integration](../../docs/developer-guide/view-integration.md) for supported
geometry, culling and remaining limitations.

## MapLibre comparison

Comparison starts off. Enable **Compare with MapLibre GL JS** in the MapView flat,
MapView perspective or GlobeView example. Your toggle choice is saved in this
browser across examples and reloads. Unsupported examples omit the reference
without clearing that choice. Explicit `?compare=maplibre` or `?compare=none`
bookmarks override the saved choice for that page, without changing it.
If browser storage is unavailable, the toggle still works for the current page.
Drag, rotate and zoom
either half to update one shared geographic camera. Disable comparison to regain
the full canvas without resetting navigation. The flat view stays at zero pitch.

The reference uses the same OpenFreeMap/CARTO vector source or NASA Blue Marble
imagery, with independent attribution in each pane. Streets and TRON have a small
static reference style: Tangram shaders, animated traffic, text layout, lighting
and deck overlays are **not** reproduced by MapLibre. Globe camera/projection
models differ, so this is a geographic comparison, not a pixel-parity oracle.
MapLibre always uses WebGL, even beside Tangram's WebGPU backend.

FirstPersonView, WebXR, custom projected basemaps, terrain-specific views and the
original Nextzen TRON scene do not offer this option. MapLibre and its workers
load only when enabled; it is an example-only dependency, never part of either
Tangram package or the ordinary homepage's initial bundle.

## Basemaps and attribution

TRON and Streets use OpenFreeMap vector tiles through its stable TileJSON
endpoint, with maximum data zoom 14. NASA Blue Marble supplies overview raster
imagery through zoom 8. The controls do not offer CARTO; historical
`?provider=carto` bookmarks remain compatible.

The vector-backed TRON adaptation retains the original style's palette, glow
and traffic animation, including portable WebGPU traffic. The exact Nextzen
TRON scene needs an existing key and uses WebGL; its key stays in that tab's
session storage. More general custom GLSL blocks are not automatically portable
to WebGPU.

Source credits remain visible inside the fullscreen container. See
[provider requirements](../../docs/developer-guide/tile-providers.md) before
reusing scenes or exporting images.

## Diagnostics

- `?traffic=0` pauses portable traffic pulses.
- `?portable_text=0` disables WebGPU labels.
- `?line_probe=1` adds overlapping lines for position, offset and dash comparisons.

See the [TangramLayer API](../../docs/api-reference/tangram-layer.md) for lifecycle,
callbacks and resource policy. The former uniform-buffer spike is now part of
the renderer; it is not a separate branch or example setup.
