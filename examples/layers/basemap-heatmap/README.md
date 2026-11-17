<!--
tangram-layers
SPDX-License-Identifier: MIT
Copyright (c) vis.gl contributors
-->

# Style heatmap and deck.gl heatmap

Run `yarn workspace tangram-basemap-heatmap-example start` from the repository root.

The example shows the same earthquakes in two ways, over the OpenFreeMap Dark style. Use the
"Draw with" setting to change between them:

- **Style heatmap layer.** The example adds the earthquakes to the style as a `geojson` source, and
  adds a `heatmap` style layer below the first `symbol` layer (`heatmap-data.ts`). `BasemapLayer`
  draws it as MapLibre GL JS does. The labels of the basemap stay above the heatmap.
- **deck.gl `HeatmapLayer`.** The example draws the basemap without the heatmap, and draws a
  `HeatmapLayer` of `@deck.gl/aggregation-layers` above it. The heatmap covers the labels.

Both use the same color ramp and the same weights. Each one has its own radius and intensity,
because the two layers use them differently.

What to look at:

- The labels. The style heatmap draws below them. The `HeatmapLayer` draws above them.
- The colors when you pan and zoom. The style heatmap colors an absolute density: a sum of
  Gaussian kernels, as in MapLibre. The `HeatmapLayer` scales its colors to the highest weight in
  the view (unless you set `colorDomain`), so the colors change when the view changes. One dense
  cluster in the view makes all other areas faint. The `HeatmapLayer` also waits for
  `debounceTimeout` (500 ms) after the view changes before it sums the weights again.
- The radius. For the same radius in pixels, the kernel of the `HeatmapLayer` is narrower: its
  standard deviation is a sixth of the radius. In MapLibre it is a third of the radius.
- The weight. "Magnitude" gives each earthquake a weight of `magnitude / 6`, capped at 1. The style
  uses an `interpolate` expression on the `mag` property. The deck.gl layer uses a `getWeight`
  accessor with the same values. A node test (`test/basemap-heatmap.node.spec.ts`) compares them.

When to use each:

- Use a **style heatmap** when the heatmap is part of the map design. It comes with the style,
  draws in style order (for example below labels or above water), and uses style expressions and
  zoom functions for its paint. It reads its points from the vector or GeoJSON sources of the
  style, and it draws in each copy of the world, as the other style layers do. To change its
  paint, give `BasemapLayer` a new style object. `BasemapLayer` then resolves the style again.
- Use a **deck.gl `HeatmapLayer`** when the heatmap shows application data. It takes any data
  array and accessors, updates with deck.gl props and `updateTriggers` without a new style, sums
  the weights on the GPU, and can scale its colors to the view. It draws in deck.gl layer order,
  above the basemap.
- Neither heatmap is pickable. For picking, add a pickable layer of the same data: turn on
  "Points" and hover a point.

Settings:

- Draw with: the style heatmap layer or the deck.gl `HeatmapLayer`.
- Weight by: each earthquake counts as 1, or by its magnitude.
- Points: draw the earthquakes as a pickable `ScatterplotLayer` with a tooltip.
- Style heatmap layer: `heatmap-radius` and `heatmap-intensity`.
- deck.gl HeatmapLayer: `radiusPixels` and `intensity`.

The antimeridian:

- The `MapView` of the basemap has `repeat: true`, so the basemap continues across the
  antimeridian. In deck.gl 10.0.0-alpha.1, a `HeatmapLayer` in a repeated view clears the canvas
  under its kernels in the copies of the world. The data layers thus draw in a second `MapView`
  without copies, with the same view state. `layerFilter` gives each view its layers.
- The data view draws one copy of the world. The data layers move each earthquake to within 180
  degrees of the center of the view (`wrapLongitude`), so the Pacific Ocean shows all of its
  earthquakes.

Limits:

- `BasemapLayer` draws a style heatmap with WebGL only. WebGPU draws no style heatmap.
- The example loads the live USGS feed. The number and the places of the earthquakes change from
  day to day.
- Below zoom 1.5, the view is wider than one copy of the world. The example does not zoom out
  further.

Data:

- Earthquakes: the [USGS earthquake summary feed](https://earthquake.usgs.gov/earthquakes/feed/v1.0/geojson.php)
  of magnitude 2.5 or more in the last 30 days. USGS data is in the public domain
  ([USGS copyrights and credits](https://www.usgs.gov/information-policies-and-instructions/copyrights-and-credits)).
- Basemap: the [OpenFreeMap](https://openfreemap.org) Dark style, with
  [OpenMapTiles](https://www.openmaptiles.org/) and
  [OpenStreetMap](https://www.openstreetmap.org/copyright) data (ODbL).

No API key is required. The style, the tiles and the earthquakes need network access.
