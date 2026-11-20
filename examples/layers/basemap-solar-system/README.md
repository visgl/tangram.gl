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
- **Eclipse shadows.** The Moon's shadow on the Earth (solar eclipses), the Earth's shadow on
  the Moon (lunar eclipses, with a reddened umbra), the shadows of the Galilean moons on
  Jupiter, Saturn's shadow on its rings and the rings' shadow on Saturn. Each fragment traces a
  ray toward the Sun, analytically, and takes the visible fraction of the solar disc, so the
  umbra and the penumbra have their true size. They show in the overview and on the globe.
  Known events:
  - total solar eclipse, 2024-04-08:
    `?mode=globe&body=earth&date=2024-04-08T18:17Z&lon=-100&lat=28`
  - total lunar eclipse, 2025-03-14 (umbral phase 05:09-08:48 UTC, totality 06:26-07:32):
    `?mode=globe&body=moon&date=2025-03-14T05:50Z&lon=0&lat=0`
  - triple shadow transit of Io, Europa and Callisto on Jupiter, 2015-01-24 (seen from the
    Earth 06:28-06:52 UTC; the scene time is Jupiter's, 36 minutes earlier):
    `?mode=globe&body=jupiter&date=2015-01-24T06:04Z&view=sun&scale=true`
  - Saturn's shadow on its rings: `?focus=saturn&date=2017-06-01&orbit=120&tilt=35`

- **Clouds and atmospheres.** The Earth gets a cloud shell 2 to 12 km above the surface, and
  the Earth, Mars and Venus get a single-scattering atmosphere at the limb
  (`scene/atmosphere-layer.ts`). One fragment shader ray-marches both, on a sphere a little
  larger than the top of the atmosphere, in the overview and above the globe. See
  [Clouds and atmospheres](#clouds-and-atmospheres).

- **Space volumes.** A WebGL2 pass over the decks adds what EVE Online-style space scenes have:
  - *Look volumes*: regions that change the look when the camera is inside them: a haze in the
    colour of a planet inside its atmosphere shell (4 radii), a dust haze in the ecliptic disc,
    and a darker sky with more stars beyond Neptune (31 to 90 AU; this one follows the point
    that the camera looks at, because an orbit camera is far from its target at an ordinary
    zoom). Each volume is a sphere, a shell or a box with a soft edge; the weights come from
    the camera position, and a priority rule blends them. The warm, brighter *glare of the Sun*
    is one more volume, but its weight comes from what the camera sees: the size of the Sun's
    disc on the screen (full at 300 px, 15 % at 3 px and below), whether the Sun is in the
    view, and the part of the disc that no body covers. So a zoom-out keeps a weaker glare,
    and a camera that looks away loses it
    (`scene/look-volumes.ts`). The idea follows the post-process volumes of the
    [Carbon engine](https://github.com/carbonengine) (MIT); no Carbon code is used. The tint and
    exposure go through one SVG colour matrix, the haze through the volume pass, the star
    factor through the sky layers.
  - *The solar corona*: electron density from the Baumbach model, ray-marched to 3 solar radii
    with a display compression. The streamers are noise in direction only, so they are
    radial: **artistic**. A *halo* (also artistic) goes with it: a glow of 4 solar radii, never
    under 22 px on the screen, weak close to the Sun and strong for a small disc, so a Sun of
    under a pixel (the system view in true scale) still shows as a bright star. It dims when
    a body covers the Sun.
  - *A comet*: C/2020 F3 (NEOWISE), from the JPL Small-Body Database (solution JPL 31, epoch
    JD 2459036.5 TDB), on a two-body Kepler orbit (`celestial/comet.ts`). The ion tail points
    straight away from the Sun; the dust tail is a syndyne (radiation-pressure ratio 0.6, 12
    days of dust) integrated under reduced solar gravity, so it curves behind the comet. Both
    grow with the activity, (q / r)^4. The scene **Comet at perihelion** (or `?comet=perihelion`)
    sets the clock to 2020-07-03 16:16 UTC and looks at the comet.
  - *Zodiacal dust*: the smooth cloud of Kelsall et al. (1998), its brightness scaled to taste.
  - *Gas clouds*: **artistic**. One density volume, baked offline (`scene/data/bake-cloud.mjs`:
    fractal noise advected through a curl-noise field, 96³ R8, 885 KB), ray-marched with a
    colour ramp, self-shadowing toward the Sun and an emissive term. Three clouds come from it
    by rotation, scale, flip and ramp, as EVE Online gets many clouds from a few bases.
    The scene **Into the Ember cloud** flies the camera inside one. `?cloud=procedural` evaluates
    the same shape from noise in the shader instead of the baked volume.
  - *Dust*: seeded points around the camera, for a sense of speed (after Carbon's seeded
    particle fills). The field repeats in cubes whose size follows the camera distance, with a
    cross-fade, and sits at fixed absolute positions, so a floating-origin rebase does not move it.

  The decks draw on their own canvases, so the pass cannot read their depth. The bodies are
  spheres, so it intersects each ray with them: a body hides the gas behind it at its true
  limb. Saturn's rings and the labels do not occlude. The march runs at a fraction of the
  screen resolution (the **Quality** control: 35 %, 50 % or 75 %, with 20, 36 or 64 steps) and
  is upsampled with a small blur.

## Controls

The controls are plain DOM (`scene/panel.ts`, styles in `index.html`). They take pointer events
only inside their own boxes, so the map takes every gesture elsewhere.

- **Time dock** (bottom): play or pause, the speed, the date and time in UTC, and **Now**. A
  click on the date opens the date and time fields. The time bar shows a window around its base
  date (±30 days to ±200 years) and follows the clock during playback. Marks on the bar show
  the solar and lunar eclipses and the perihelion of the comet; a click on a mark sets the clock
  to that event, and the button beside the bar goes to the next event. The marks come from the
  same shadow geometry that draws the eclipses (`celestial/events.ts`): every eclipse on a
  window of up to one year, the total and annular ones up to ten years.
- **Icon rail** (left; a bar at the bottom on a narrow screen), with one card open at a time:
  - **Navigate**: the system view, the compare view, and the bodies. In a globe, **Back**
    returns to the system.
  - **Layers**: the surface, the night side, the eclipse shadows, **Rotate with body**, the
    clouds and the atmosphere, **Readable scale** (system view), and **Quality**. A control that
    does not apply to the body or the view is disabled, with the reason beside it.
  - **Space**: the five space volumes and the gas-cloud source.
  - **Info**: gravity, sky data, notes, tile counts and errors. A badge on the icon shows the
    number of errors.
- **Scenes** (on the rail): one-click states. Each scene with a URL opens exactly as the page
  does from that URL, without a reload:
  - Total solar eclipse, 2024: `?mode=globe&body=earth&date=2024-04-08T18:17Z&lon=-100&lat=28`
  - Ring shadow of Saturn: `?focus=saturn&date=2017-06-01&orbit=120&tilt=35`
  - Total lunar eclipse, 2025: `?focus=moon&date=2025-03-14T06:58Z`
  - Comet at perihelion: `?comet=perihelion`
  - Into the Ember cloud: a flight from the camera in use (no URL)
  - Clouds of the Earth: `?mode=globe&body=earth&view=sun`
- **Quality** (Low, Medium, High) sets the cloud ray-march steps (6, 12, 24) and the
  space-volume quality together.
- **Status readout** (top right): the view, the scale and the frame rate, with a switch.
- **Keys**: `Space` plays or pauses; `[` and `]` change the speed; `1` to `4` open or close a
  card; `Esc` closes a menu, or goes back to the system, or closes the card; `?` lists the keys.
  No key acts while a field has the focus.
- The credits at the bottom show on one line; a click shows all of them.

## URL parameters

The page URL can set the start state, for example
`?mode=globe&body=mars&surface=imagery&date=2026-06-21&speed=3600&night=off`. `date` takes a day
(UTC midnight) or an ISO time. In globe mode `lon`, `lat` and `zoom` set the camera, and
`view=sun` faces the sub-solar point. With `focus=<body>`, `orbit`, `tilt` and `extent` set the
overview camera. `shadows=off` turns the eclipse shadows off. `clouds=off` and `atmosphere=off`
set the cloud controls. `quality=low|medium|high` sets the quality of the clouds and of the
space volumes; `cloudQuality=<steps>` (1 to 32) then sets the cloud ray-march steps alone.
The space volumes take `looks`, `corona`, `comet`, `gas` and `dust` (`off` turns one off),
`cloud=procedural` and `comet=perihelion`. `card=navigate|layers|space|info|none` sets the open
card, and `hud=off` hides the status readout.

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
- `celestial/shadows.ts` and `scene/shadow-extension.ts`: eclipse shadows. The idea is the
  "circular occluder" of [CORTAO](https://github.com/carbonengine/CORTAO) (MIT): seen from a
  shaded point, the light and each occluder are discs, and the occlusion is their overlap. Here
  it is exact: the Sun's angular radius is taken at the point, the overlap is the area of the
  lens between the two discs, and the light is the visible fraction of the solar disc. That
  gives the umbra (0), the antumbra (an annulus of the Sun) and the penumbra with no shadow
  map. Saturn's rings dim the ray by exp(-tau / |mu|), with a typical normal optical depth tau
  for the C ring, the B ring, the Cassini Division and the A ring.
  - The geometry is true at any scale. The CPU computes it in double precision from the
    ephemeris, relative to the centre of the shaded body (the floating origin of the shadow),
    in its body-fixed frame and in units of its radius. The shader maps each fragment of the
    drawn sphere to the true surface point at the same geodetic direction. So in the readable
    scale the shadow is in its true place on the map of the enlarged body, although the drawn
    Moon or moons are elsewhere.
  - Occluders are taken where they were when the shadowing light passed them (light time; this
    moves the Moon's shadow on the Earth by about 38 km). The Earth as an occluder has an 88 km
    atmosphere added, as in Astronomy Engine's lunar eclipse search. Earth longitudes come from
    Astronomy Engine's sidereal time, not from the IAU rotation model, which is about 0.9°
    off in longitude for the Earth.
  - Overview: a `LayerExtension` on the body meshes and the rings multiplies the colour by the
    light. Globe: `BasemapLayer` draws its tiles in sublayers, so instead one `BitmapLayer` over
    the whole body runs the same shader on its longitude and latitude and darkens the tiles with
    a multiply blend. It is in the layer list only while a shadow can reach the body.
  - `test/solar-system-shadows.node.spec.ts` checks the math against known geometry and against
    Astronomy Engine: the 2024-04-08 eclipse centre within 0.02°, the 2025-03-14 lunar eclipse
    contacts within 1 minute, and the 2015-01-24 triple shadow transit within 3 minutes.

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
| Comet | Orbit of C/2020 F3 (NEOWISE) | [JPL Small-Body Database](https://ssd.jpl.nasa.gov/tools/sbdb_lookup.html), solution JPL 31, epoch JD 2459036.5 TDB, typed into `celestial/comet.ts` | NASA/JPL, public |
| Corona | Electron density | Baumbach (1937), Astron. Nachr. 263, 121, as given in Allen's *Astrophysical Quantities* | Published model |
| Zodiacal dust | Density profile | Kelsall et al. (1998), ApJ 508, 44 (COBE/DIRBE) | Published model |
| Gas clouds | Density volume | Generated by `scene/data/bake-cloud.mjs` (artistic); `scene/data/cloud-96.r8`, SHA-256 in `scene/data/provenance.json` | MIT |

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
- Eclipse shadows: the Sun is a uniform disc (no limb darkening), the ring shadow ignores the
  Sun's size, Jupiter does not shadow its moons, and the shader takes four sphere occluders per
  body. The eclipsed Moon is a fixed red, not a model of the light refracted by the Earth's
  atmosphere. The overview draws Saturn as a sphere; the shadows use its true flattening.
- The planetary vector data is simplified, so the globe zoom stops at tile zoom 8 on the
  vector map. The imagery goes deeper.
- The space volumes do not read the decks' depth: only the body spheres occlude them. The
  rings, the orbit lines and the labels do not.
- The volume march uses a per-pixel jitter and a small blur; a grain stays visible in the
  clouds, most at the low quality.
- The look-volume haze is uniform over the view, so inside an atmosphere shell it also lightens
  the night side of the globe.
- The comet orbit is two-body only. It is close near the 2020 perihelion and drifts for dates
  far from it.
- In the readable scale, distances are logarithmic, so the comet tails, the zodiacal disc and
  the clouds have the readable-scale shape, not the true one.
