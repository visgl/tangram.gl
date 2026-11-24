{/*
tangram-layers
SPDX-License-Identifier: MIT
Copyright (c) vis.gl contributors
 */}

# `bodies` Export

The `bodies` entry holds basemaps of other worlds: a frozen registry of open map sources for the Moon, Mars, Mercury, Venus and the Earth.

```ts
import {BODY_BASEMAPS, type BodyBasemap} from '@tangram.gl/basemap-layers/bodies';

const moon: BodyBasemap = BODY_BASEMAPS.moon;
moon.crs; // 'IAU_2015:30100'
moon.radius; // 1737400 (metres)
```

The entry holds data only. It imports no other module, so a bundler drops it when an application does not import it.

## `BODY_BASEMAPS`

`Readonly<Record<BodyBasemapId, BodyBasemap>>`. The keys are `'mercury'`, `'venus'`, `'earth'`, `'moon'` and `'mars'`. The data is frozen at every depth.

## `BodyBasemap`

| Field | Type | Description |
| --- | --- | --- |
| `id` | `BodyBasemapId` | The identifier of the body. |
| `label` | `string` | The English name of the body. |
| `crs` | `string` | The geographic CRS of the map coordinates: the IAU 2015 planetocentric code of the body (OGC `IAU_2015` authority), or `EPSG:4326` for the Earth. |
| `radius` | `number` | The semi-major axis of the ellipsoid of `crs`, in metres. |
| `radiusSource` | `string` | The definition of `crs` that gives `radius`. |
| `raster` | `BodyRasterSource` (optional) | Raster imagery. Venus has none. |
| `vector` | `BodyVectorSource` | The vector map source. |

| Body | `crs` | `radius` (m) | Source of the radius |
| --- | --- | --- | --- |
| Mercury | `IAU_2015:19900` | 2440530 | IAU 2015 sphere (semi-major axis) |
| Venus | `IAU_2015:29900` | 6051800 | IAU 2015 sphere |
| Earth | `EPSG:4326` | 6378137 | WGS 84 ellipsoid, EPSG:7030 |
| Moon | `IAU_2015:30100` | 1737400 | IAU 2015 sphere |
| Mars | `IAU_2015:49900` | 3396190 | IAU 2015 sphere (semi-major axis) |

The IAU 2015 values come from the IAU 2015 coordinate reference systems (Archinal et al. 2018, doi:10.1007/s10569-017-9805-5).

## `BodyRasterSource`

| Field | Type | Description |
| --- | --- | --- |
| `tiles` | `string` | A URL template with the `{z}`, `{x}` (column) and `{y}` (row, from the top) placeholders. |
| `grid` | `'web-mercator' \| 'geographic'` | The tile grid of `tiles`. |
| `maxZoom` | `number` | The highest zoom level of the tiles. |
| `tileSize` | `256 \| 512` | The width and height of a tile, in pixels. |
| `label` | `string` | A short description of the imagery. |
| `credit` | `string` | The attribution to show with the tiles. |
| `licence` | `string` | The licence of the tiles. |

A `'web-mercator'` source uses the grid of `BasemapLayer`, so a style can use `tiles` directly. A `'geographic'` source uses a plate carree grid with 2 x 1 tiles at zoom 0. `BasemapLayer` cannot read this grid directly. Resample the tiles to Web Mercator in your application, for example in a `fetch` function of `loadOptions`.

## `BodyVectorSource`

A union with the `type` field as its tag:

- `{type: 'style', url, credit, licence}`: a MapLibre style URL. Give `url` to the `style` prop of `BasemapLayer`. Only the Earth has this form.
- `{type: 'datasets', datasets, credit}`: open datasets. Each `BodyDataset` has a `label`, a `url` and a `licence`. No hosted vector tiles exist for these bodies. Convert the datasets to vector data, for example GeoJSON, and write a style for them.

## Credits and licences

Show the `credit` of each source that your map uses.

| Body | Source | Licence |
| --- | --- | --- |
| Earth | OpenFreeMap "liberty" style, OpenMapTiles schema | Data © OpenStreetMap contributors (ODbL), © OpenMapTiles |
| Earth | NASA Blue Marble shaded relief and bathymetry, NASA GIBS | NASA, no restriction |
| Moon | USGS Unified Geologic Map of the Moon 1:5M (Fortezzo et al., 2020) | CC0 ("please cite authors") |
| Mars | USGS SIM 3292, Geologic Map of Mars (Tanaka et al., 2014) | US public domain |
| Mercury | USGS MESSENGER global DEM 665 m v2 | US public domain ("please cite authors") |
| Moon, Mars, Mercury, Venus | IAU/USGS Gazetteer of Planetary Nomenclature | Public domain |
| Moon, Mars, Mercury | LROC WAC, Viking MDIM 2.1 and MESSENGER MDIS mosaics, via NASA Trek | NASA, no restriction |
