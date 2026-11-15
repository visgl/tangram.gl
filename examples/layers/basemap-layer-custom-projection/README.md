<!--
tangram-layers
SPDX-License-Identifier: MIT
Copyright (c) vis.gl contributors
-->

# BasemapLayer CustomProjectionView

Run `yarn workspace tangram-basemap-custom-projection-example start` from the repository root.

The example draws the OpenFreeMap Liberty style with `BasemapLayer` in a deck.gl
`_CustomProjectionView`. Choose the coordinate reference system in the panel:

- UTM zone 32N (`EPSG:32632`), at Munich.
- Conus Albers (EPSG:5070, as a PROJ string), at Washington.
- South polar stereographic (EPSG:3031, as a PROJ string), over Antarctica.

The tiles are Web Mercator tiles. They stop at 85.05 degrees south, so the area
around the pole shows the style background. Zoom out in UTM zone 32N to see that
math.gl draws only the area of use of the zone.

No API key is required. Tiles and styles come from OpenFreeMap and need network access.
