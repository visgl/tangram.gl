<!--
tangram-layers
SPDX-License-Identifier: MIT
Copyright (c) vis.gl contributors
-->

# BasemapLayer solar system

This example puts `BasemapLayer` on other worlds. An overview shows the Sun, the eight planets
and the Moon at their positions for a date. A click on a body flies the camera to it and hands
over to a `GlobeView` with a `BasemapLayer` of that body: a vector map where open vector data
exists, or raster imagery. A compare mode shows the Earth, the Moon and Mars side by side.

Run `yarn workspace tangram-basemap-solar-system-example start` from the repository root,
after `yarn build:modules`.

## What to look at

- **Vector maps on other bodies.** The Moon, Mars, Mercury and Venus get a vector style built
  from open planetary data (see [Data and licences](#data-and-licences)): geologic units or
  contours, crater rims, named features and a graticule, with labels. The Earth gets the OpenFreeMap "liberty" vector style.
  **Surface** changes to raster imagery (NASA Trek mosaics, NASA GIBS Blue Marble).
- **Raster tiles from a geographic grid.** NASA Trek serves its mosaics in a geographic grid
  (2 x 1 tiles at zoom 0). `BasemapLayer` reads Web Mercator tiles, so the `fetch` in
  `loadOptions` answers each Web Mercator tile: a worker reads the geographic tiles under the
  tile and resamples them bilinearly. Neighbouring tiles read the same source pixels at their
  common edge, so there is no seam. Toward the poles the worker reads one zoom level more.
- **The hand-off.** The fly-in ends at a camera whose view of the overview sphere matches the
  first frame of the globe, then the globe fades in. The way back is the same in reverse.
  From a globe, a body button flies out to the system and in to the other body.
- **Time.** **Play** runs the clock at the selected speed, from **1× (real time)** to one year
  per second. **Now** goes to the current time. The night side of each body, the Earth's
  terminator (math.gl `getSunTerminator`), the positions, the Galilean moons and the poles
  follow the clock.

The page URL can set the start state, for example
`?mode=globe&body=mars&surface=imagery&date=2026-06-21&speed=3600&night=off`.

## How it works

The code has three layers. A layer imports only from the layers above it, so each folder can
move to a library without changes to the others.

| Folder | What it holds | Imports | Later home |
| --- | --- | --- | --- |
| `celestial/` | Physical constants, time (TT), frames, body axes (IAU WGCCRE), positions of the planets, the Moon and the Galilean moons, the Earth's terminator, normal gravity. Pure functions and frozen data. | Astronomy Engine, math.gl | math.gl, beside `@math.gl/earth/sun` |
| `bodies/` | The map of each body: CRS, raster tile source, vector data (`bodies/data/`), `BasemapLayer` styles, credits. | `celestial/` | tangram.gl, basemaps of other worlds |
| `scene/` | deck.gl views, navigation between bodies, the playback clock, the tile workers and the UI. | `celestial/`, `bodies/` | stays an example |

- `scene/app.ts`: three stacked decks. The back deck draws the sky and the focus body, the
  middle deck the `GlobeView` with the `BasemapLayer`, and the front deck the rest of the
  system, with the focus body as a depth-only occluder. One deck cannot do this: a `GlobeView`
  and an `OrbitView` over the same pixels cannot depth-test against each other.
- `scene/tiles.ts`, `scene/tile-worker.ts`: the geographic-to-Web-Mercator tile workers.
- `celestial/ephemeris.ts`: positions from Astronomy Engine (MIT). Astronomy Engine was already
  a dependency for the poles and prime meridians, it covers the planets, the Moon and the
  Galilean moons to about 1 arcminute, and one scene takes about 0.1 ms.
- `celestial/gravity.ts`: normal gravity on the reference ellipsoid of a body (Somigliana).

## Data and licences

All data is open. The example credits each source on the page.

| Body | Surface | Source | Licence |
| --- | --- | --- | --- |
| Earth | Vector | [OpenFreeMap](https://openfreemap.org) "liberty" style, OpenMapTiles schema | Data © OpenStreetMap contributors (ODbL), © OpenMapTiles; the page shows the attribution |
| Earth | Imagery | NASA Blue Marble shaded relief and bathymetry, [NASA GIBS](https://nasa-gibs.github.io/gibs-api-docs/) | NASA, no restriction |
| Moon | Vector | Maria, crater rim crests and basin rings: USGS [Unified Geologic Map of the Moon 1:5M](https://astrogeology.usgs.gov/search/map/unified_geologic_map_of_the_moon_1_5m_2020) (Fortezzo et al., 2020) | CC0 ("please cite authors") |
| Mars | Vector | Geologic units, grouped by age: USGS [SIM 3292, Geologic Map of Mars](https://pubs.usgs.gov/sim/3292/) (Tanaka et al., 2014) | US public domain |
| Mercury | Vector | 4 km contours from the USGS [MESSENGER global DEM 665 m v2](https://planetarymaps.usgs.gov/mosaic/Mercury_Messenger_USGS_DEM_Global_665m_v2.tif) | US public domain ("please cite authors") |
| Moon, Mars, Mercury, Venus | Vector | Feature names, and crater rims (circles from the centre and diameter): [IAU/USGS Gazetteer of Planetary Nomenclature](https://planetarynames.wr.usgs.gov/GIS_Downloads) | Public domain |
| Moon | Imagery | LRO LROC WAC global mosaic, NASA/GSFC/Arizona State University, via [NASA Moon Trek](https://trek.nasa.gov/moon/) | NASA, no restriction |
| Mars | Imagery | Viking MDIM 2.1 colour mosaic, NASA/JPL/USGS, via [NASA Mars Trek](https://trek.nasa.gov/mars/) | NASA, no restriction |
| Mercury | Imagery | MESSENGER MDIS enhanced colour mosaic, NASA/JHUAPL/Carnegie Institution of Washington, via [NASA Mercury Trek](https://trek.nasa.gov/mercury/) | NASA, no restriction |
| All | Constants | NASA GSFC Planetary Fact Sheets; WGS84 for the Earth | Public domain |
| Sky | Stars, Milky Way, terminator | math.gl `@math.gl/earth/sun` (Yale Bright Star Catalog) | MIT |

`bodies/data/build_data.py` makes `bodies/data/<body>.geojson` from the reduced USGS sources
and the gazetteer. It needs Python 3 and GDAL. It drops geometry beyond 84° latitude and
geometry that crosses the antimeridian, and it simplifies lines to 0.02°–0.06°.

Bodies with no vector map:

- **The Sun, Jupiter, Saturn, Uranus, Neptune**: no solid surface to map.
- **Venus**: no open global vector geology in a small, reusable form. The vector map has names
  and crater rims only, and there is no raster tile source.
- **Mercury**: the USGS 1:5M geologic map covers only the Mariner 10 hemisphere, and its
  polygons cross the poles and the antimeridian. The vector map uses contours instead.

## Limits

- `GlobeView` draws every body on a sphere of the Earth's radius, so heights and distances read
  as Earth units.
- Web Mercator tiles stop at ±85.05°. At the poles the overview sphere shows through.
- The planetary vector data is simplified, so the globe zoom stops at tile zoom 8 on the
  vector map. The imagery goes deeper.
