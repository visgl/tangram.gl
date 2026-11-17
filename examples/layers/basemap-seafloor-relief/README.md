<!--
tangram-layers
SPDX-License-Identifier: MIT
Copyright (c) vis.gl contributors
-->

# BasemapLayer seafloor relief

Run `yarn workspace tangram-basemap-seafloor-relief-example start` from the repository root.
The example is also available under the website's BasemapLayer examples.

The example draws Monterey Bay, California, with `BasemapLayer` from a small MapLibre style.
The style has one `raster-dem` source of land and seabed heights, and two layers on it:

- A `color-relief` layer colors each pixel by its height. Each ramp changes color at 0 m, so
  the coast is the line between the blues and the land colors.
- A `hillshade` layer above it shades the slopes.

Both layers read the same decoded DEM tiles. Look at Monterey Canyon: it cuts the shelf
near the coast at Moss Landing and goes down the continental slope to more than 3000 m.

The panel has three controls:

- **Device**: WebGL or WebGPU. A deck.gl device cannot change its type, so the example makes
  a new `Deck` for the other type. If the browser has no WebGPU, the example uses WebGL and
  tells you.
- **Hillshade**: shows or hides the `hillshade` layer.
- **Color ramp**: three `color-relief-color` ramps. "Depth bands" shows the shelf (0 to
  200 m), the slope and the deep sea in bands of one color. `color-relief` draws nothing for
  a `step` expression, so the ramp uses two `interpolate` stops 1 m apart for each edge.

## WebGPU

`hillshade` layers draw on WebGPU. `color-relief` layers draw on WebGL only: on WebGPU, the
example shows the hillshade on the gray background, and the panel says so.

## Data

No API key is required. The DEM tiles come from the network.

- Heights: [Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) on the Registry of
  Open Data on AWS, in the Terrarium encoding (`encoding: 'terrarium'`). The data set
  combines open data sources. Near Monterey Bay, the seabed comes from ETOPO1 (NOAA) and the
  land from 3DEP, SRTM and GMTED2010 (USGS). Each source has its own licence and attribution
  terms; see the
  [attribution page](https://github.com/tilezen/joerd/blob/master/docs/attribution.md). The
  example shows the attribution in the lower right corner.

The Terrarium tiles have seabed heights to zoom 10, so the source has `maxzoom: 10`. At a
higher zoom, the layers draw the zoom 10 tiles larger.

## Limits

- The ETOPO1 seabed has a cell of about 1.8 km. Small seabed features are smooth.
- Where the tiles put the sea at 0 m, for example in bays and harbors at a high zoom, the
  ramp shows land colors.
