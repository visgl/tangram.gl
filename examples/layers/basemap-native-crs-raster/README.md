<!--
tangram-layers
SPDX-License-Identifier: MIT
Copyright (c) vis.gl contributors
-->

# BasemapLayer native CRS raster

Run `yarn workspace tangram-basemap-native-crs-raster-example start` from the repository root.

The example draws a vector basemap and a Cloud Optimized GeoTIFF (COG) in the
coordinate reference system (CRS) of the GeoTIFF. Nothing is warped to Web Mercator.

- `BasemapLayer` draws the OpenFreeMap Liberty style in a deck.gl `_CustomProjectionView`.
- The raster is a deck.gl `BitmapLayer`. Its bounds are metres of the CRS, and its
  `coordinateSystem` is the CRS of the view. deck.gl draws the image as it is: one pixel
  of the file is one axis-aligned square on the screen.
- The style is divided into two `BasemapLayer`s. The fills draw below the raster. The
  roads, boundaries and labels draw above it.
- A grid shows the metres of the CRS. Its lines are straight, and they are on the pixel
  edges of the Sentinel-2 image.
- The readout shows the length of one ground distance at the top edge and at the bottom
  edge of the view, and the position of the pointer in projected metres.

Select **Web Mercator** to draw the same layers in a `MapView`. The grid turns and
bends, the raster is drawn on a mesh, and the scale changes across the view.

## Scenes

- **Sentinel-2 image in UTM zone 32N (EPSG:32632).** A true color image of the
  Sognefjord and Voss in Norway, 10 m pixels. Tile 32VLN, 2020-08-16.
- **REMA hillshade in Antarctic polar stereographic (EPSG:3031).** Six tiles of the
  Reference Elevation Model of Antarctica around McMurdo Sound, 32 m pixels.

The view takes each CRS as a PROJ string. For the code `EPSG:32632`, math.gl draws only
the 6 degrees of the UTM zone, and the Sentinel-2 image starts west of them. math.gl does
not have the code `EPSG:3031`.

## How the raster loads

`createGeoTIFFSource` from `@loaders.gl/raster/geotiff` reads the files with HTTP range requests.
The example loads one overview of each file. When the view stops, it loads the block of
finer pixels for the area on the screen. Each block is on pixel edges of one level of the
file, so the read does not resample the pixels.

## Data

No API key is required. All sources need network access.

- Basemap: [OpenFreeMap](https://openfreemap.org) Liberty style. OpenMapTiles schema,
  data from OpenStreetMap (ODbL) and Natural Earth (public domain).
- Sentinel-2 L2A COG from the
  [Sentinel-2 Cloud-Optimized GeoTIFFs](https://registry.opendata.aws/sentinel-2-l2a-cogs/)
  open data registry. Contains modified Copernicus Sentinel data 2020. The Copernicus
  Sentinel data terms permit free use with this notice.
- [REMA](https://www.pgc.umn.edu/data/rema/) mosaic v2.0 hillshade COGs from the Polar
  Geospatial Center open data bucket. CC BY 4.0.
