<!--
tangram-layers
SPDX-License-Identifier: MIT
Copyright (c) vis.gl contributors
-->

# Mercator terrain reference

Run `yarn website:start` from the root, then open
`/tangram.gl/examples/deck-terrain`. Ocular builds this private example during
`yarn build` and website assembly. Do not use `file://`.

The website mounts `mountTerrainExample` directly in a lazy-loaded Docusaurus
component. It shares the runtime and controls with the standalone entry, without
an iframe, injected scripts, global selectors or a second router. Unmounting
aborts requests, disconnects resize observation and releases GPU resources.

The POC loads one Mapterhorn Terrarium tile near Zermatt, decodes and simplifies
it with loaders.gl v5, renders it with deck.gl TerrainLayer, and queries the
identical mesh with Tangram's terrain surface API. Controls include MapView
navigation, mesh error, wireframe, devices, fullscreen and collapsible information.

Elevation stays at physical scale. Changing mesh error reuses downloaded bytes.
This is a reference adapter, not production terrain support: masks as mesh holes,
terrain streaming, basemap draping and globe terrain are deferred. Parsing is
main-thread. Required tests use a generated PNG, not live services.

The example credits Mapterhorn and swissALTI3D / swisstopo for the Swiss reference
area and links the full source attribution. Dataset licensing is separate from
this example's MIT code license. See the terrain
developer guide for the shared height contract and coordinate conversions.
