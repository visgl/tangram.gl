<!--
tangram-layers
SPDX-License-Identifier: MIT
Copyright (c) vis.gl contributors
-->

# BasemapLayer interleaved layers and picking

Run `yarn workspace tangram-basemap-interleaved-picking-example start` from the repository root.

`BasemapLayer` draws a map style as deck.gl layers. The example shows two things that
follow from this, on one canvas and in one deck.gl layer list.

## Free layer order

A deck.gl `GeoJsonLayer` of census tracts draws between two layers of the basemap style.
The list in the panel has the id of every layer of the style. Choose the style layer that
draws next above the tracts. The buttons are positions that most styles have: below the
roads, below the buildings, below the labels, and on top.

The example splits the style document at the chosen layer (`splitStyleAt` in
`style-layers.ts`). Each part is a complete style. The layer list is one `BasemapLayer`
for the lower part, the `GeoJsonLayer`, and one `BasemapLayer` for the upper part.

## One picking

`pickable: true` on `BasemapLayer` makes the features of the vector tiles pickable with
the picking of deck.gl. The `onHover` and `onClick` callbacks of the `Deck` receive the
features of the basemap and the features of the tracts.

- A basemap feature has `info.basemapFeature`: the id of the style layer that drew it, the
  source, the source layer, the feature id and the properties.
- A census tract is the `info.object` of the `GeoJsonLayer`.

One card shows the picked feature of either kind. Click a feature to keep it.

The picked basemap feature draws in a highlight color. The example adds
`["feature-state", "hover"]` and `["feature-state", "selected"]` to the color of each
`fill`, `line`, `circle` and `fill-extrusion` layer (`withFeatureStateHighlight`), and sets
the `featureState` prop of `BasemapLayer`. The tiles are not loaded again when the state
changes.

## Limits

- A change of position gives each `BasemapLayer` a new style, so the tiles of both parts
  load again. The browser cache has them.
- Labels and icons are pickable, but the paint of `symbol` layers does not read feature
  state. A picked label has a card and no highlight.
- The vector tiles merge the lines that have the same properties. One road feature can be
  many street segments, and all of them take the highlight.

## Data

- Basemap: the [OpenFreeMap](https://openfreemap.org) Positron and Liberty styles, with
  OpenMapTiles tiles of OpenStreetMap data. No API key is required. The styles and the
  tiles need network access.
- `manhattan-census-tracts.geojson`: the census tracts of New York County, New York, with
  the population and the housing units of the 2020 Census. The boundaries are the 2020
  cartographic boundary file of the U.S. Census Bureau (1:500,000). The counts are the
  `POP100` and `HU100` fields of the Census Bureau TIGERweb service. Both are in the
  public domain.
