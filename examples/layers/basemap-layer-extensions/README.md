<!--
tangram-layers
SPDX-License-Identifier: MIT
Copyright (c) vis.gl contributors
-->

# Extensions on the basemap

Run `yarn workspace tangram-basemap-layer-extensions-example start` from the repository root.

The fills, lines, labels and raster tiles of a `BasemapLayer` are deck.gl layers. The
`BasemapLayer` gives them its `extensions` and the props of those extensions. This example shows
two deck.gl extensions on the OpenFreeMap Liberty style, over Midtown Manhattan.

## MaskExtension

A `SolidPolygonLayer` with `operation: 'mask'` draws a circle into the mask of deck.gl. The
`BasemapLayer` has `extensions: [new MaskExtension()]` and `maskId: 'mask-circle'`. The basemap is
drawn inside the circle only: the background, the fills, the lines and the labels.

- Click the map to move the circle.
- Use the radius slider to change its size.

## DataFilterExtension

The `BasemapLayer` has `extensions: [new DataFilterExtension({filterSize: 1})]`, a
`getFilterValue` accessor and a `filterRange`. Each sublayer calls `getFilterValue` with its own
features. A building of the OpenMapTiles schema returns its `render_height`. All other features
return a value at the top of the filter range, so the filter keeps them (`extension-props.ts`).

- Use the height slider to hide the buildings below that height, in meters.
- The slider changes only `filterRange`. The GPU filters the features again, and no tile loads
  again.

Settings:

- Extension: `MaskExtension` or `DataFilterExtension`.
- Apply: draw the basemap with the extension or without it.
- Mask radius: the radius of the mask circle, in kilometers.
- Minimum height: the lowest building that the filter keeps, in meters.

## Which extensions work

| Extension | Result |
| --- | --- |
| `MaskExtension` | Works on all sublayers. A label is masked by its anchor. |
| `DataFilterExtension` | Filters the building extrusions in this example. Some line sublayers do not draw. See the limits. |
| `ClipExtension` | Does not clip the fills and the lines of the vector tiles. Not in this example. See the limits. |

Limits:

- The accessor is one function for the life of the example. Inside a vector tile, the
  `updateTriggers` of an accessor are not passed on. A new `getFilterValue` function thus does not
  reach the features that are already loaded. Change a uniform prop, such as `filterRange`, instead.
- `getFilterValue` gets the features of all style layers, and the object of the background
  sublayer. It must return a value for each of them.
- With `DataFilterExtension`, some line sublayers do not draw in WebGL2. In the Liberty style, the
  tunnel casings and `waterway_tunnel` fail to link with the error
  `Too many attributes (rowIndexes)`: the line layer and the filter together use more vertex
  attributes than the device permits (`MAX_VERTEX_ATTRIBS`, often 16).
- `ClipExtension` does not clip the fills and the lines. The `MVTLayer` of deck.gl reserves
  `clipBounds`: it clips each tile sublayer to its tile with its own `ClipExtension`. The
  background and the labels take the `clipBounds` of the `BasemapLayer`. Use `MaskExtension` with a
  rectangle or a polygon to clip a basemap.
- In deck.gl 10.0.0-alpha.1, the mask of `MaskExtension` is drawn in Web Mercator. Use a `MapView`.

## Data

The style is [OpenFreeMap Liberty](https://openfreemap.org) (`https://tiles.openfreemap.org/styles/liberty`).
OpenFreeMap needs no API key. The vector tiles use the [OpenMapTiles](https://openmaptiles.org)
schema, with map data from [OpenStreetMap](https://www.openstreetmap.org/copyright) under the Open
Database License (ODbL). The low zoom levels use [Natural Earth](https://www.naturalearthdata.com)
data, in the public domain. The example needs network access.
