<!--
tangram-layers
SPDX-License-Identifier: MIT
Copyright (c) vis.gl contributors
-->

# BasemapLayer image overlay

Run `yarn workspace tangram-basemap-image-overlay-example start` from the repository root.

The example draws a scan of an 1859 chart of San Francisco over the OpenFreeMap
Liberty style. The chart is a style `image` source, drawn by a `raster` style layer:

```js
{
  sources: {
    chart: {type: 'image', url: CHART_URL, coordinates: [topLeft, topRight, bottomRight, bottomLeft]}
  },
  layers: [{id: 'chart', type: 'raster', source: 'chart', paint: {'raster-opacity': 0.8}}]
}
```

What to look at:

- The `coordinates` are the corners of the image, as `[longitude, latitude]`. West is
  at the top of the chart, so the top left corner of the image is in the south-west of
  the area. The red points show the four corners and their names.
- **Opacity** sets `raster-opacity`. Lower it to compare the shore and the streets of
  1859 with the modern map. Much of the modern waterfront is on land that was bay in 1859.
- **Skew** moves the bottom right corner to the north-east. The four corners then do
  not make a parallelogram, and the image is warped as a perspective view, as MapLibre
  GL JS warps it.

The corners are approximate, to about 100 m. The latitudes come from the graticule on
the border of the chart. The longitudes come from the same graticule, moved 0.017
degrees west so that the old shore meets the modern shore at Black Point and Rincon Point.

The chart has a style of its own, in a second `BasemapLayer` between the fills and the
labels of the basemap. A change of opacity or corners is then a new chart style, and
the basemap tiles do not reload. In an application with a fixed overlay, put the image
source and its raster layer in the basemap style.

If the style or the image does not load, the panel shows the error.

## Data

No API key is required. All sources need network access.

- Chart: U.S. Coast Survey, "City of San Francisco and its Vicinity, California", 1859.
  Scan by Geographicus Rare Antique Maps, from
  [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:1858_U.S._Coast_Survey_Chart_or_Map_of_San_Francisco,_Califorina_-_Geographicus_-_SanFrancisco-uscs-1859.jpg).
  Public domain: a work of the United States government, published before 1930. The
  example loads the 1280 by 876 pixel JPEG (415 kB) from `upload.wikimedia.org`, which
  sends CORS headers.
- Basemap: [OpenFreeMap](https://openfreemap.org) Liberty style. OpenMapTiles schema,
  data from OpenStreetMap (ODbL) and Natural Earth (public domain).
