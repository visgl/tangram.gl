<!--
tangram-layers
SPDX-License-Identifier: MIT
Copyright (c) vis.gl contributors
-->

# BasemapLayer made-up world

This example draws a world that does not exist. A seeded terrain generator makes the world in
the browser, and a protocol handler serves it to `BasemapLayer` as vector tiles. There is no
tile server and no network request for map data: the style, the TileJSON, the tiles, the sprite
and the glyphs all load through `registerBasemapProtocol`.

Run `yarn workspace tangram-basemap-made-up-world-example start` from the repository root,
after `yarn build:modules`.

## What to look at

- Continents, coasts, lakes and rivers, with forests, grass, farmland, sand, rock, wetland and
  ice where the climate puts them. The world wraps around the antimeridian with no seam.
- Names for oceans, seas, lakes, rivers, peaks and towns, all made from the seed.
- The antique style: a parchment ground, ink patterns, ripple lines inside the coast, and a
  deck.gl paper effect over the whole view.

## Settings

- **Seed**: the world. The same seed gives the same world, tile for tile. **Random** picks a
  new seed.
- **Sea level**: moves the coasts. A new seed or sea level is a new source URL, so the tiles
  load again.
- **Saturation**: moves every color of the style from a sepia tone (left) to more vivid colors
  (right). The change is in paint properties only. When `BasemapLayer` updates a style by diff
  and keeps the tiles of a source when the style changes, the colors change in place. Without
  those, the tiles load again.
- **Paper effect**: turns the post-process effect on and off.

The page URL can set the start state, for example
`?seed=7&sea=0.1&saturation=0.5&effect=off&lon=20&lat=30&zoom=3`.

## How it works

- `world/world.ts` builds a coarse grid of the whole world once for each seed and sea level:
  elevation from domain-warped fractal noise with ridges and erosion, moisture, temperature,
  flow accumulation, rivers, lakes, towns, peaks and water names. It takes a few hundred
  milliseconds.
- `world/tile.ts` makes one Web Mercator vector tile from the grid, with detail noise for the
  coasts, in OpenMapTiles source layers (`water`, `waterway`, `landcover`, `landuse`, `place`,
  `water_name`, `mountain_peak`). `world/mvt.ts` encodes it as a Mapbox Vector Tile.
- `world/protocol.ts` is the handler of `world://<seed>/tilejson?sea=<offset>` and
  `world://<seed>/tiles/{z}/{x}/{y}.pbf?sea=<offset>`. It generates the tiles in a pool of web
  workers (`world/worker.ts`). A request that deck.gl aborts while it waits in the queue never
  reaches a worker.
- `world-style.ts` is the style of the antique map style example, changed for the generated
  world: no roads or buildings, and large sea names, curved river names, peaks and towns.
- `antique-effect.ts` is the paper effect of the antique map style example, unchanged. It is a
  luma.gl `ShaderPass` for deck.gl's `PostProcessEffect`. WebGL only.

## Limits

- Map view only.
- Below about zoom 8, rivers are straight lines between the cells of the coarse grid.

## Assets

`assets/` is a copy of part of the assets of the antique map style example (about 340 kB):

- `sprite.png`, `sprite@2x.png` and their JSON indexes: the pattern images.
- `glyphs/`: the glyph range 0-255 of IM FELL English Roman and Italic by Igino Marini, licensed
  under the SIL Open Font License 1.1 (`assets/glyphs/OFL.txt`). The font names are reserved
  names of the licence, so the style calls the glyph sets "Antique Serif Roman" and "Antique
  Serif Italic". The generated names are ASCII, so the other ranges are not included. They load
  as empty ranges.

`style-assets.ts` loads the assets through the `antique-assets://` protocol, which maps each
name to the URL that the bundler gives the file.
