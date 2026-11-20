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
- **Direct flights.** From a globe, a body button flies straight to the other body: the globe
  fades out, one camera path runs in the overview, and the other globe fades in. The camera
  distance follows log space from one body size to the other, with a rise for a far pair. The
  view looks along the line between the bodies, then turns to face the new body. No flight takes
  more than 4 s, and the clock keeps running.
- **Vector maps in the overview.** With **Surface** set to vector map, the overview spheres use
  a plate carree texture of the same vector map (`bodies/textures.ts`): the GeoJSON of the Moon,
  Mars, Mercury and Venus, and the OpenFreeMap zoom 2 tiles of the Earth with the "liberty"
  colours. So the sphere and the globe look the same at the hand-off.
- **Time.** **Play** runs the clock at the selected speed, from **1× (real time)** to one year
  per second. **Now** goes to the current time. The night side of each body, the Earth's
  terminator (math.gl `getSunTerminator`), the positions, the Galilean moons and the poles
  follow the clock.

- **Clouds and atmospheres.** The Earth gets a cloud shell 2 to 12 km above the surface, and
  the Earth, Mars and Venus get a single-scattering atmosphere at the limb
  (`scene/atmosphere-layer.ts`). One fragment shader ray-marches both, on a sphere a little
  larger than the top of the atmosphere, in the overview and above the globe. See
  [Clouds and atmospheres](#clouds-and-atmospheres).

The page URL can set the start state, for example
`?mode=globe&body=mars&surface=imagery&date=2026-06-21&speed=3600&night=off`.
`clouds=off`, `atmosphere=off` and `cloudQuality=6|12|24` (ray-march steps) set the cloud
controls.

## Clouds and atmospheres

- **Cloud density.** A NASA Blue Marble cloud map (2048 x 1024) gives each column its albedo:
  the map brightness above a clear-sky floor of 0.1. The two-stream relation for conservative
  scattering, A = 0.15 tau / (2 + 0.15 tau), gives its optical depth (at most 60). Thicker
  clouds reach higher in the shell. The clouds turn only with the body; there is no weather.
- **Cloud light.** math.gl `getCloudLighting` (`@math.gl/earth/sun`) gives the direct and the
  sky light on a cloud at 7 km for each Sun altitude. A 128 x 2 table holds it
  (`celestial/atmosphere.ts`), white-balanced to the Sun above the atmosphere. The table makes
  the night side dark, cuts the beam at the horizon seen from the cloud, and reddens it at the
  terminator. In the shader, a short march toward the Sun (2 to 4 steps) gives the
  self-shadowing, a Henyey-Greenstein phase (g = 0.7, as math.gl) the forward lobe, and a
  diffuse term scaled to the two-stream albedo of the column the rest.
- **Atmosphere.** Rayleigh and Mie single scattering with exponential density profiles. The
  optical depth toward the Sun is the Chapman function sqrt(pi r / 2) erfcx(sqrt(r / 2) cos z),
  with erfcx after Ren & MacKenzie (2007). The body's own sphere shadows it. The parameters
  and their sources are in `celestial/atmosphere.ts`:

  | Body | Base, top | Scale heights (gas, aerosol) | Sources |
  | --- | --- | --- | --- |
  | Earth | 0, 60 km | 8 km, 1.2 km | Bruneton (2017), Precomputed Atmospheric Scattering, demo constants |
  | Mars | 0, 80 km | 11.1 km, 11.1 km (dust, optical depth 0.5) | NASA Mars Fact Sheet; Lemmon et al. 2015; Wolff et al. 2009 |
  | Venus | 70 km (cloud tops), 110 km | 4.9 km, 4 km (upper haze, optical depth 0.3) | VIRA (Seiff et al. 1985); Wilquet et al. 2009; NASA Venus Fact Sheet |

  Mars and Venus Rayleigh coefficients are the Earth's, scaled by the number density and by
  2.5 for CO2. Titan is not in the scene.
- **Venus's cloud deck.** With **Clouds** on, Venus gets an opaque deck at 70 km with a
  procedural pattern of streaks. It draws at 80 % so that the map under it stays readable;
  the real deck is opaque.
- **Gas giants.** Jupiter and Saturn keep their plain colour bands.
- **Cost.** **Cloud quality** sets the steps through the cloud shell (6, 12 or 24), and with
  them the steps toward the Sun (2, 3, 4) and through the air (6, 8, 12). The layer draws on
  WebGL2 only; on WebGPU it draws nothing.

## How it works

The code has three layers. A layer imports only from the layers above it, so each folder can
move to a library without changes to the others.

| Folder | What it holds | Imports | Later home |
| --- | --- | --- | --- |
| `celestial/` | Physical constants, time (TT), frames, body axes (IAU WGCCRE), positions of the planets, the Moon and the Galilean moons, the Earth's terminator, normal gravity. Pure functions and frozen data. | Astronomy Engine, math.gl | math.gl, beside `@math.gl/earth/sun` |
| `bodies/` | The map of each body: CRS, raster tile source, vector data (`bodies/data/`), `BasemapLayer` styles, plate carree textures of the vector maps, credits. | `celestial/` | tangram.gl, basemaps of other worlds |
| `scene/` | deck.gl views, navigation between bodies, the playback clock, the tile workers and the UI. | `celestial/`, `bodies/` | stays an example |

- `scene/app.ts`: three stacked decks. The back deck draws the sky and the focus body, the
  middle deck the `GlobeView` with the `BasemapLayer`, and the front deck the rest of the
  system, with the focus body as a depth-only occluder. One deck cannot do this: a `GlobeView`
  and an `OrbitView` over the same pixels cannot depth-test against each other.
- Floating origin: the scene keeps positions in double precision and subtracts an origin that
  follows the body or the point in view before it sends them to the GPU. With the Sun at the
  origin, float32 moves a true-scale Neptune by up to 145 km (2 px on its limb); with the
  floating origin the error is below 0.001 px.
- Globe camera: it follows the body centre but keeps its orientation in space, so the stars stay
  still while the clock runs. "Rotate with body" makes it turn with the surface.
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
| Earth | Clouds | NASA [Blue Marble clouds](https://visibleearth.nasa.gov/images/57747/blue-marble-clouds), NASA GSFC, Reto Stöckli; `bodies/data/earth-clouds-2048.jpg`, source and SHA-256 in `bodies/data/provenance.json` | NASA, no restriction |

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

- The atmospheres have their true thickness. At whole-globe zoom the Earth's limb glow is
  1 to 3 px wide; the haze over the disk shows more. The ray march adds a little per-pixel
  noise near the limb.

- `GlobeView` draws every body on a sphere of the Earth's radius, so heights and distances read
  as Earth units.
- Web Mercator tiles stop at ±85.05°. At the poles the overview sphere shows through.
- A flight between two globes goes through the overview and fades at each end. One continuous
  flight needs the globe of a body inside the system view, which `GlobeView` does not support.
- The planetary vector data is simplified, so the globe zoom stops at tile zoom 8 on the
  vector map. The imagery goes deeper.
