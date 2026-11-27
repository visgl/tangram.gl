<!--
tangram-layers
SPDX-License-Identifier: MIT
Copyright (c) vis.gl contributors
-->

# BasemapLayer antique map style

This example draws OpenFreeMap vector tiles with a custom MapLibre style that looks like an
old engraved and hand-colored city map. A deck.gl post-process effect adds paper grain, soft
stains, a light sepia tone and a vignette over the whole view.

Run `yarn workspace tangram-basemap-antique-style-example start` from the repository root,
after `yarn build:modules`.

## What to look at

- The parchment ground, with a paper texture that repeats without seams.
- City blocks and buildings in brick red with a light cross-hatch, and streets in a pale
  parchment color, so that the blocks read as islands. Main roads are a little wider.
- Water in a flat sage color with a darker shore line and three ripple lines inside the shore.
  The ripples get lighter away from the shore.
- Farmland with furrows, orchards as a grid of small trees, grass with short strokes, and
  woods as dense small crowns. Fields have a fine dashed outline.
- Labels in an old-style serif: water names in spaced capitals, towns in spaced capitals, and
  districts and streets in italic, all in dark-brown ink.

## Settings

- **City**: Charleston (South Carolina), Annapolis (Maryland) or Valletta (Malta).
- **Paper effect**: turns the post-process effect on and off.
- **Saturation**: moves every color of the style from a sepia tone (left) to more vivid colors
  (right). The middle position (1) is the palette as designed. The style is made from a small
  set of color roles (paper, ink, soft ink, street, block, building, block edge, field, meadow,
  wood, sand, water fill, water edge, ripple). The setting changes the roles and makes a new
  style, so MapLibre GL JS shows the same colors.
- **Paper grain**: the amplitude of the per-pixel grain of the effect. The default is 2%. The
  old look comes mostly from the palette and the ink, not from the noise.
- **Compare with MapLibre GL JS**: shows MapLibre GL JS beside the deck.gl view, with the same
  style and camera. MapLibre cannot show the deck.gl post-process effect, so the two sides
  differ when the effect is on. Turn the effect off to compare only the style.

The page URL can set the start state, for example
`?city=valletta&zoom=12&effect=off&saturation=0.5&compare=on`.

## How the style is made

- `antique-style.ts` makes the style for the OpenMapTiles schema from the color roles.
- The patterns are drawn as ink tints on a transparent ground. Each patterned area has a color
  fill under the pattern, so the saturation setting also changes patterned areas. The pattern
  direction is fixed to the screen axes, as in MapLibre GL JS: it does not follow streets or
  field edges.
- `BasemapLayer` does not draw `background-pattern` yet. The style draws the paper texture as
  a `fill-pattern` on a GeoJSON polygon that covers the world, which works in both renderers.
- `antique-effect.ts` is a luma.gl `ShaderPass` for deck.gl's `PostProcessEffect`. The grain
  and the stains are fixed to the screen, like a printed sheet. WebGL only.

## Assets

The assets are in `assets/` (about 440 kB):

- `sprite.png`, `sprite@2x.png` and their JSON indexes: six pattern images (paper, hatch,
  furrows, orchard, wood, meadow). `node make-sprite.mjs` draws them. Each image is a function
  of a position in a periodic square: the noise uses a lattice that wraps at the edges, and the
  shapes use distances that wrap at the edges. So the images tile without seams. A seeded random
  generator makes the output the same on each run.
- `glyphs/`: glyph ranges 0-255 and 256-511 (Basic Latin, Latin-1 and Latin Extended-A) of
  IM FELL English Roman and Italic by Igino Marini, licensed under the SIL Open Font License 1.1
  (`assets/glyphs/OFL.txt`). The fonts come from the Google Fonts repository. The font names
  are reserved names of the licence, so the style calls the glyph sets "Antique Serif Roman"
  and "Antique Serif Italic". They were made with `build-glyphs` of
  [fontnik](https://github.com/mapbox/fontnik) 0.7.7:
  `build-glyphs IMFeENrm28P.ttf <dir>` and `build-glyphs IMFeENit28P.ttf <dir>`, keeping
  `0-255.pbf` and `256-511.pbf`. Other ranges load as empty ranges, so their characters do not
  draw. The fonts do not have all letters of these ranges: for example, the Maltese letters Ħ
  and Ġ do not draw in Valletta's names, in either renderer.

The style names its assets with the prefix `antique-assets://local/`. `antique-assets.ts` maps
each name to the URL that the bundler gives the file: `loadOptions.fetch` does this for
`BasemapLayer`, and `transformRequest` for MapLibre GL JS.

## Data

Vector tiles from [OpenFreeMap](https://openfreemap.org/), in the
[OpenMapTiles](https://openmaptiles.org/) schema, with data from
[OpenStreetMap](https://www.openstreetmap.org/copyright) contributors (ODbL). No API key is
needed. MapLibre 6 loads its module worker from unpkg. Both services need network access.
