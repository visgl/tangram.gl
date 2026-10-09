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
yarn build:modules
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
Pinned deck.gl and luma.gl browser modules share one luma runtime. See
[view integration](../../docs/developer-guide/view-integration.md) for supported
geometry, culling and remaining limitations.

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
