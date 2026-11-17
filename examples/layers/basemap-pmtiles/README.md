<!--
tangram-layers
SPDX-License-Identifier: MIT
Copyright (c) vis.gl contributors
-->

# BasemapLayer PMTiles archive

Run `yarn workspace tangram-basemap-pmtiles-example start` from the repository root.

The example draws a whole basemap from one [PMTiles](https://github.com/protomaps/PMTiles)
file. There is no tile server and no TileJSON. The style source names the file:

```js
sources: {
  protomaps: {type: 'vector', url: 'pmtiles://https://pmtiles.io/protomaps(vector)ODbL_firenze.pmtiles'}
}
```

`BasemapLayer` reads the header of the file, then the directories, then each tile, with HTTP
range requests to the file URL alone.

## What to look at

- The panel counts the range requests and the bytes that they read. At the first view, the
  example reads about 8 % of the 6.6 MB file. Pan and zoom: each new tile is one more range
  request.
- Select **Raster, world** in the settings. The same source URL form reads a raster archive of
  PNG tiles into a `raster` source.
- The panel shows an error when the file does not load, for example when the server refuses
  the range request.

The example gives `loadOptions` a `fetch` that counts the range requests and passes them on
(see `range-reads.ts`). Without it, `BasemapLayer` uses the global `fetch`. Keep one `fetch`
and one `loadOptions` object for the life of the layer: the archive readers, with the header
and the directories that they have read, are kept per `fetch`.

## Data

No API key is required. All sources need network access.

- Vector: `protomaps(vector)ODbL_firenze.pmtiles`, an extract of the
  [Protomaps basemap](https://protomaps.com) for Florence, Italy, hosted on pmtiles.io. MVT
  tiles, zoom 0 to 15. The PMTiles repository and the MapLibre GL JS PMTiles example use this
  file. Data © OpenStreetMap contributors, under the
  [Open Database License](https://www.openstreetmap.org/copyright).
- Raster: `stamen_toner(raster)CC-BY+ODbL_z3.pmtiles`, Stamen Toner for the world, hosted on
  pmtiles.io. 256 pixel PNG tiles, zoom 0 to 3. Map tiles by Stamen Design, under
  [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Data © OpenStreetMap
  contributors, under the Open Database License. The OpenLayers PMTiles example uses this file.
- Glyphs: Noto Sans from [protomaps/basemaps-assets](https://github.com/protomaps/basemaps-assets),
  under the SIL Open Font License.

The vector style in `archives.ts` is a minimal style for version 3 of the Protomaps basemap
schema, which this file uses: the kind of each feature is in its `pmap:kind` property. A
current Protomaps build uses version 4 of the schema (`kind`). For such a file, use the layers
of [`@protomaps/basemaps`](https://github.com/protomaps/basemaps) or change the filters.

## Make a file

The [`pmtiles` command-line tool](https://docs.protomaps.com/pmtiles/cli) makes and inspects
archives.

- Cut an area out of a Protomaps daily build. Only the tiles of the area are downloaded:

  ```bash
  pmtiles extract https://build.protomaps.com/<YYYYMMDD>.pmtiles florence.pmtiles \
    --bbox=11.22,43.74,11.29,43.79 --maxzoom=15
  ```

  The Protomaps
  [downloads page](https://docs.protomaps.com/basemaps/downloads) lists the builds. Copy the
  result to your own storage. Do not link to the daily builds from a map.

- Convert an MBTiles file: `pmtiles convert input.mbtiles output.pmtiles`.
- Write an archive from your own data with
  [tippecanoe](https://github.com/felt/tippecanoe) (`tippecanoe -o output.pmtiles input.geojson`)
  or from OpenStreetMap with [Planetiler](https://github.com/onthegomap/planetiler)
  (`--output=output.pmtiles`).
- Check a file with `pmtiles show output.pmtiles`: the tile type must suit the source (MVT for
  `vector`; PNG, JPEG, WebP or AVIF for `raster` and `raster-dem`), and the compression must be
  `gzip` or `none`. `BasemapLayer` does not read Brotli or zstd archives.

## Host a file

Any static file host that answers HTTP range requests works: Amazon S3, Cloudflare R2, Google
Cloud Storage, GitHub Pages or a plain web server.

- The server must answer a `Range` header with `206 Partial Content` and only the requested
  bytes. `BasemapLayer` refuses a response that holds the whole file.
- For a page on another origin, the server must send CORS headers: allow `GET` and the `Range`
  request header from the origin of the page.
- The [Protomaps deploy guides](https://docs.protomaps.com/deploy/) give the CORS settings for
  each cloud.
- For local tests, put the file in a `public/` folder next to `index.html`. The Vite dev server
  answers range requests. Use the full URL in the style:
  `pmtiles://http://localhost:5173/florence.pmtiles`.
