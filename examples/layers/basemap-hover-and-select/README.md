<!--
tangram-layers
SPDX-License-Identifier: MIT
Copyright (c) vis.gl contributors
-->

# BasemapLayer hover and select

Run `yarn workspace tangram-basemap-hover-and-select-example start` from the repository root.

The example highlights the features of a vector basemap with feature state, as
`map.setFeatureState()` does in MapLibre GL JS.

## What to look at

- Move the cursor over a building, a lawn, a park or a sports pitch. The feature draws in
  orange, with a dark orange outline. The card names the feature: its source layer, the style
  layer that drew it, its source, its id and its properties.
- Click the feature. It draws in pink and stays selected when the cursor moves away. Click it
  again, or click a place without a highlighted feature, to clear the selection.
- One feature can have many parts. The parts of a building with one id, and the parts of a
  feature that crosses a tile border, all take the highlight.

## How it works

1. `withHoverAndSelect` (in `feature-highlight.ts`) changes a copy of the
   [OpenFreeMap Liberty](https://openfreemap.org) style. The `fill-color` or
   `fill-extrusion-color` of each named style layer becomes
   `["case", ["boolean", ["feature-state", "selected"], false], selectedColor, ["boolean", ["feature-state", "hover"], false], hoverColor, color]`.
   For each source layer, a new `line` layer draws the outline. Its `line-width` reads the
   same two states, and is 0 for a feature without a state.
2. `pickable: true` on `BasemapLayer` makes the features pickable. `onHover` and `onClick`
   of the `Deck` read `info.basemapFeature`: the `id`, `source`, `sourceLayer`,
   `styleLayerId` and `properties` of the picked feature.
3. `getFeatureState` puts the states in the `featureState` prop: by source, then by source
   layer, then by feature id. `BasemapLayer` compares the prop by identity, so the example
   gives a new object only when a state changes.

When a state changes, the tiles do not load again and the polygons are not tessellated again.
Only the paint of the style layers that read the state changes.

## Limits

- Only `fill`, `line`, `circle` and `fill-extrusion` paint reads feature state. Labels and
  icons do not take the highlight, so the example ignores them.
- A feature without an id cannot have a state. The tiles of OpenFreeMap give an id to each
  feature. For other tiles, set `promoteId` on the source.

## Data

The basemap is the [OpenFreeMap](https://openfreemap.org) Liberty style, with
[OpenMapTiles](https://openmaptiles.org) vector tiles of [OpenStreetMap](https://www.openstreetmap.org/copyright)
data. No API key is necessary. The style and the tiles need network access.

- OpenStreetMap data: © OpenStreetMap contributors, under the Open Database License (ODbL).
- OpenMapTiles: the code is under the BSD 3-Clause License, and the design under CC BY 4.0.
- The Liberty style: a fork of OSM Liberty, which is a fork of OSM Bright. The style code is
  under the BSD 3-Clause License, and the design under CC BY 4.0. The OpenFreeMap style
  project is under the MIT License. See its
  [license list](https://github.com/hyperknot/openfreemap-styles/blob/main/LICENSE.md).

The example shows the attribution that the tiles require in the lower-right corner.
