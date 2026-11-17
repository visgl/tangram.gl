<!--
tangram-layers
SPDX-License-Identifier: MIT
Copyright (c) vis.gl contributors
-->

# BasemapLayer draped on terrain

Run `yarn workspace tangram-basemap-draped-terrain-example start` from the repository root.
The example is also available under the website's BasemapLayer examples.

The example draws the OpenFreeMap Liberty style with `BasemapLayer` on a 3D terrain of
Monterey Bay, California. The terrain has the land and the seabed: the Santa Lucia Range
and Monterey Canyon are in one view.

`BasemapLayer` makes deck.gl layers from the style. Thus the deck.gl tools for layers apply
to the basemap:

- deck.gl's `TerrainExtension` drapes the fills, lines and rasters of the style on a
  `TerrainLayer`. It moves each label to the height of the terrain.
- The basemap, the terrain and the data layers are in one deck.gl scene with one depth
  buffer. The terrain hides a data layer that is behind it or below it.
- The style has one more raster layer, above its water and below its roads and labels. The
  layer shows the depth of the seabed as a color, with an isobath at each 500 m. The example
  makes its tiles in the browser from the heights that the terrain uses.

The data layers:

- The orange track is 60 m above the axis of Monterey Canyon. `TerrainExtension` adds the
  height of the terrain to its positions (`terrainDrawMode: 'offset'`).
- The yellow line is level, at a depth of 800 m. It has no extension. It shows only where
  the seabed is below it: in Monterey Canyon and in the canyons to the north.
- The sea surface is a translucent polygon at sea level. The terrain cuts it at the shore.

The panel sets the vertical exaggeration (4 by default), shows or hides the sea surface and
the data layers, and turns the camera around the view center.

## How the basemap gets the extension

`BasemapLayer` does not pass its `extensions` prop to the layers that it makes. The example
has a small subclass, `DrapedBasemapLayer`, that adds `TerrainExtension` to each layer that
`renderLayers` returns. The layers of the tiles get their extensions from those layers.

## Depth offsets

deck.gl moves each layer toward the camera in the depth buffer, by an offset that increases
with the index of the layer (`getPolygonOffset`). `BasemapLayer` makes many layers, so a
layer after it has a large offset and shows through terrain that is in front of it. The
data layers of the example set `getPolygonOffset` to no offset.

## Data

No API key is required. All data comes from the network.

- Style and vector tiles: [OpenFreeMap](https://openfreemap.org) Liberty,
  © [OpenMapTiles](https://www.openmaptiles.org/), data from
  [OpenStreetMap](https://www.openstreetmap.org/copyright) (ODbL).
- Heights: [Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) on AWS, in the
  Terrarium encoding. The data set combines public sources, with ETOPO1 and other NOAA and
  USGS data for the seabed. See its
  [attribution](https://github.com/tilezen/joerd/blob/master/docs/attribution.md).

The Terrarium tiles have seabed heights to zoom 10. The terrain and the depth tint use
zoom 10 at most, so the surface is smooth near the camera at high zoom.

## Limits

- The heights are multiplied in the `elevationDecoder` of the `TerrainLayer`. A change of
  the exaggeration makes the terrain meshes again.
- deck.gl makes the mesh of each terrain tile alone. Skirts close the steps between the
  edges of adjacent tiles. A thin seam can show on steep slopes.
- Draped layers are drawn into textures of the terrain. Near the camera, at a high pitch,
  the lines of the basemap are less sharp than the lines of a flat basemap.
- `TerrainExtension` is an experimental deck.gl export (`_TerrainExtension`).
