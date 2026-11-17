<!--
tangram-layers
SPDX-License-Identifier: MIT
Copyright (c) vis.gl contributors
-->

# BasemapLayer masked by data

Run `yarn workspace tangram-basemap-masked-by-data-example start` from the repository root.

The example draws the OpenFreeMap Liberty style with `BasemapLayer`, and masks it with a deck.gl
data layer. A vehicle moves along a survey track over Amsterdam. The basemap has its colors in the
swath that the vehicle has covered. Outside the swath, the basemap is dark or gray, and can show
only its roads, or its roads and water.

The fills, lines, labels and raster tiles of a `BasemapLayer` are deck.gl layers. A layer
extension thus runs in their shaders. A map library that draws its own canvas below deck.gl cannot
take a deck.gl extension.

- The footprint is a layer with `operation: 'mask'`: the swath of the track, or an area of
  interest. deck.gl draws it into its mask texture.
- The `BasemapLayer` (`app.ts`) has the props `extensions`, `maskId`, `maskInverted` and
  `maskOutside`. It gives them to each of its sublayers. With the `MaskExtension` of deck.gl in
  `extensions`, the basemap is drawn inside the footprint only.
- `BasemapMaskExtension` (`basemap-mask-extension.ts`) extends `MaskExtension`. It reads the mask
  texture at each fragment. Inside the mask, it keeps the color. Outside the mask, it removes the
  saturation, inverts the lightness, mixes in a tint, or discards the fragment (`maskOutside`).
- The extension reads the ids of the style layers from the id of each sublayer. A function then
  selects the style layers to draw outside the mask, by their `source-layer`.

Settings:

- Footprint: the survey track or the area of interest.
- Swath: the width of the track, in meters.
- Animate: move the vehicle along the track.
- Invert: exchange the inside and the outside of the footprint.
- Style: the colors of the basemap outside the footprint.
- Layers: the style layers that are drawn outside the footprint.

Limits:

- The extension has GLSL shaders only. It does not run on WebGPU.
- The extension takes the position of a fragment on the ground from its position on the screen.
  The view must fill the canvas. In a pitched view, the roof of an extruded building takes the mask
  of the ground behind it.
- The mask texture of deck.gl has 2048 pixels on each side. The edge of the mask is correct to
  approximately one CSS pixel.
- The example needs a Web Mercator `MapView`. In deck.gl 10.0.0-alpha.1, the mask of
  `MaskExtension` is drawn in Web Mercator, so it does not fit a `_CustomProjectionView`.
- The mask pass of deck.gl draws a `PathLayer` of a width in meters too narrow. The track is a set
  of polygons.

No API key is required. Tiles and styles come from OpenFreeMap and need network access.
