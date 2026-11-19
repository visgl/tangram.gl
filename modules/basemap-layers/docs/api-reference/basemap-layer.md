<!--
tangram-layers
SPDX-License-Identifier: MIT
Copyright (c) vis.gl contributors
-->

# BasemapLayer

<p class="badges">
  <img src="https://img.shields.io/badge/from-v9.3-green.svg?style=flat-square" alt="from v9.3" />
  <img src="https://img.shields.io/badge/stability-experimental-orange.svg?style=flat-square" alt="experimental" />
</p>

`@tangram.gl/basemap-layers` exports a runtime API for loading a MapLibre or Mapbox style document and generating deck.gl sublayers from it.

Recommended example:

- [BasemapLayer MapView](/examples/layers/basemap-layer-map-view) for validating the standard 2D `MapView` render path

## Installation

```sh
yarn add @tangram.gl/basemap-layers @deck.gl-community/geo-layers@10.0.0-alpha.1
```

## Main Export

<p class="badges">
  <img src="https://img.shields.io/badge/from-v9.3-green.svg?style=flat-square" alt="from v9.3" />
  <img src="https://img.shields.io/badge/stability-experimental-orange.svg?style=flat-square" alt="experimental" />
</p>

```ts
import {BasemapLayer} from '@tangram.gl/basemap-layers';
```

`BasemapLayer` is a `CompositeLayer` that:

- accepts a style URL or parsed style object
- resolves TileJSON-backed sources, and fetches the data of GeoJSON sources given by URL
- cuts GeoJSON sources into vector tiles on the client, in a web worker
- generates `background`, `fill`, `line`, `symbol`, and `raster` sublayers
- supports flat map rendering, globe rendering, and rendering in a projected view (`_CustomProjectionView`)

## Props

### `style`

Type: `string | BasemapStyle | null`

The style document to render. Pass either:

- a URL string pointing to a style JSON document
- an in-memory MapLibre/Mapbox style object

### `mode`

Type: `'map' | 'globe'`

Controls whether the generated sublayers are optimized for a flat map or a globe. Defaults to `'map'`.

### `loadOptions`

Type: `BasemapLoadOptions | null`

Optional loader configuration used by `resolveBasemapStyle`. This can include:

- `baseUrl` for resolving relative URLs in in-memory styles
- `fetch` for a custom fetch implementation
- `fetchOptions` to customize network requests

The tiles of raster sources load with `loadOptions` and with the `fetch` prop of the layer, as vector tiles do.

### `rejectRasterTile`

Type: `((tile: RasterTileResponse) => boolean | Promise<boolean>) | null`

Some tile services return a placeholder image with status 200 where they have no data, in place of a 404 response. Return `true` for such a tile. The layer then draws that tile from its nearest ancestor tile that has data, enlarged, as MapLibre GL JS draws a tile that failed to load. The placeholder is not drawn.

The function receives the tile before it is decoded:

- `url`: the URL the tile was requested from
- `sourceId`: the id of the style source
- `index`: the `{x, y, z}` position of the tile
- `arrayBuffer`: the bytes of the response body

A tile with an empty response body also has no data. The search for an ancestor stops at the `minzoom` of the source. If no ancestor has data, the layer draws nothing for the tile.

With this prop, raster tiles are requested with the `fetch` and `fetchOptions` of `loadOptions`. The `fetch` prop of the layer returns decoded data, so the layer does not use it for these tiles. Pass a stable function: raster tiles reload when the function changes.

```ts
import {BasemapLayer, createRasterTileFingerprintFilter} from '@tangram.gl/basemap-layers';

// `placeholderFingerprint` is the SHA-256 digest of the placeholder image, in hexadecimal.
const rejectRasterTile = createRasterTileFingerprintFilter([placeholderFingerprint]);

new BasemapLayer({style, rejectRasterTile});
```

### `extensions`

Type: `LayerExtension[]`

The layers that draw the basemap are deck.gl layers. `BasemapLayer` gives its `extensions`, and the props of those extensions, to each of them: the background, the raster tiles, and the fills, lines, circles, extrusions and labels of the vector tiles. A layer of the basemap runs its own extensions first.

```ts
import {MaskExtension, type MaskExtensionProps} from '@deck.gl/extensions';
import {SolidPolygonLayer} from '@deck.gl/layers';
import {BasemapLayer} from '@tangram.gl/basemap-layers';

const layers = [
  // Draws the area into the mask of deck.gl, not on the screen.
  new SolidPolygonLayer({id: 'area', data: [area], getPolygon: polygon => polygon, operation: 'mask'}),
  // Draws the basemap in the area only.
  new BasemapLayer<MaskExtensionProps>({
    id: 'basemap',
    style,
    extensions: [new MaskExtension()],
    maskId: 'area'
  })
];
```

The [Basemap masked by data example](/examples/basemap-layers/masked-by-data) masks, filters and restyles the basemap with a survey track.

Limits:

- The props of an extension are the props in its `defaultProps`. Inside a vector tile, the `updateTriggers` of an accessor prop are not passed on.
- An accessor prop, such as the `getFilterValue` of `DataFilterExtension`, gets the features of the basemap, not the data of the application.
- `MaskExtension` masks a label by its anchor.
- In deck.gl 10.0.0-alpha.1, `MaskExtension` draws its mask in Web Mercator. It does not mask a basemap in a `_CustomProjectionView`.

### `globe`

Type: `{config?: BasemapGlobeConfig}`

Optional globe-specific toggles:

- `atmosphere`: enable atmosphere overlay helpers
- `basemap`: enable the main globe basemap geometry
- `labels`: enable symbol-label rendering on the globe path

### `separateLabelPlacement`

Type: `boolean`

By default (`false`), the labels of every `BasemapLayer` in a deck are placed together, as the layers of one style: a label is hidden where it overlaps a label placed before it, and the labels of a `BasemapLayer` drawn later (later in the `layers` array) are placed first. Stacking a base style and a labels-only style this way does not draw their labels over each other. Set `true` to place this layer's labels on their own, so that they collide only with each other and never hide, or are hidden by, those of another `BasemapLayer`.

The shared placement takes the `labelPlacementInterval` of the last `BasemapLayer` rendered: give layers that share it the same interval.

## Projected views

`BasemapLayer` also draws in a deck.gl `_CustomProjectionView`: a flat view in a projected coordinate reference system, such as a UTM zone or a conic projection. No prop selects this. The layer reads the kind of view from the viewport, and `mode` stays `'map'`.

```ts
import {Deck, _CustomProjectionView as CustomProjectionView} from '@deck.gl/core';
import {BasemapLayer} from '@tangram.gl/basemap-layers';

new Deck({
  views: new CustomProjectionView({crs: 'EPSG:32632'}),
  initialViewState: {center: [10.5, 48, 0], zoom: 12},
  controller: true,
  layers: [new BasemapLayer({id: 'basemap', style: 'https://example.com/style.json'})]
});
```

The [CustomProjectionView example](/examples/basemap-layers/custom-projection) draws the OpenFreeMap Liberty style in UTM zone 32N, Conus Albers and a south polar stereographic projection.

In a projected view:

- Tiles are still the Web Mercator tiles of the style's sources. They are selected for the area that the screen shows, through the projection (see `getProjectedTileIndices`).
- Vector geometry is drawn from longitude/latitude positions. deck.gl converts each vertex to the coordinate reference system of the view. Lines and fills are not drawn as tile images. Long edges, such as the edges of a polygon cut at the side of a tile, get more vertices, so that they follow the projection.
- Raster and hillshade tile images are drawn on a mesh that follows the projection. The mesh is refined with math.gl `subdivideTriangleMesh` until the sampled error is less than half a texel.
- Hillshade slopes are scaled by the radius of the body that the coordinate reference system is on, its semi-major axis, so that a CRS on the Moon or Mars shades a slope as steep as the same slope on the Earth. Maps and globes use the radius of the Earth, as MapLibre GL JS.
- Labels at points stay upright on the screen. Labels along lines turn to the line as the view draws it.
- Styles are evaluated, and tiles are selected, at the zoom of the Web Mercator map that has the same scale at the view center (see `getMercatorZoom`). The zoom of the view itself counts pixels per unit of the coordinate reference system. At latitude 60, the two differ by one zoom level.
- A `background` layer fills the screen, also outside the bounds of the projection.

Limits:

- math.gl moves positions outside the area of use of a projection to its edge. A view of EPSG:32632 thus draws UTM zone 32N only, and the background around it.
- Text along lines is straight. It does not follow the line glyph by glyph, as it does in a `MapView`.
- A view can zoom out past the area that its projection draws well. Where the projection stretches a tile to more than four times the scale at the view center, or the tile lies on a seam of the projection, the tile is divided into smaller tiles, up to four times. The parts that are still stretched are not drawn.
- `fill-extrusion` layers and pitched views are not covered by render tests.
- Web Mercator tiles end at 85.051129 degrees north and south. A projected view, such as a polar stereographic one, can show latitudes past that limit, and so can a globe (`mode: 'globe'`). Raster, hillshade and vector tiles have no data past the limit. `geojson` sources are cut at the limit in these views: points past it are not drawn, and lines and polygons end where they cross it. geojson-vt, and MapLibre GL JS, move positions past the limit onto it, so a point at -89.5 degrees would otherwise draw on the -85.05 degree parallel, 135 km away on the Moon. The layer logs one warning per source that has features past the limit. A `MapView` does not show latitudes past the limit, and draws such features as MapLibre GL JS does. To draw data near the poles in full, a tile path that is not Web Mercator is necessary. That work is tracked in [#287](https://github.com/visgl/tangram.gl/issues/287).

## Runtime Helpers

### `getProjectedTileIndices(viewport, options)`

```ts
import {getProjectedTileIndices} from '@tangram.gl/basemap-layers';
```

Returns the Web Mercator tile indices `{x, y, z}` of zoom `options.z` that a projected viewport shows, nearest the view center first. It reads only `width`, `height`, `project` and `unproject` of the viewport, so it holds for any projection, bearing and pitch. `options.extent` limits the selection to longitude/latitude bounds. `options.maxTiles` (default 512) bounds the count: a view that needs more gets the tiles of a lower zoom. With `projectPosition`, tiles that the projection stretches are divided into tiles of higher zooms, up to `options.maxZoom`.

### `ProjectedTileset2D`

```ts
import {TileLayer} from '@deck.gl/geo-layers';
import {ProjectedTileset2D} from '@tangram.gl/basemap-layers';

new TileLayer({data: 'https://example.com/{z}/{x}/{y}.png', TilesetClass: ProjectedTileset2D});
```

A deck.gl `Tileset2D` that selects tiles with `getProjectedTileIndices` in a projected view, and as `Tileset2D` does in other views. `BasemapLayer` uses it for raster sources.

### `ProjectedBitmapLayer`

A deck.gl `BitmapLayer` for one Web Mercator tile image. In a projected view it draws the image on the mesh described above. In other views it draws as `BitmapLayer` does. Pass `bounds` as `[west, south, east, north]`.

### `getMercatorZoom(viewport)`

Returns the zoom at which a Web Mercator map has the scale of a projected viewport at its center.

### `getBasemapLayers(options)`

<p class="badges">
  <img src="https://img.shields.io/badge/from-v9.3-green.svg?style=flat-square" alt="from v9.3" />
  <img src="https://img.shields.io/badge/stability-experimental-orange.svg?style=flat-square" alt="experimental" />
</p>

Generates the deck.gl sublayers for an already-resolved style definition. Use this when you want the sublayers without creating a `BasemapLayer` instance.

`BasemapLayer` keeps each source's tiles in a shared tileset across renders. A direct caller that calls `getBasemapLayers` on every render keeps them by passing its own `tilesets` map, keyed by source, and finalizes those tilesets when done.

### `createRasterTileFingerprintFilter(fingerprints)`

Creates a `rejectRasterTile` function. It matches each raster tile whose bytes have one of `fingerprints`. Use it for a tile service that returns the same placeholder image, byte for byte, for every tile without data.

`fingerprints` is an iterable of strings, or a promise of one. Use a promise to measure the fingerprint at run time from a tile that is known to have no data:

```ts
import {
  createRasterTileFingerprintFilter,
  getRasterTileFingerprint
} from '@tangram.gl/basemap-layers';

const rejectRasterTile = createRasterTileFingerprintFilter(
  fetch(urlOfTileWithoutData)
    .then(response => response.arrayBuffer())
    .then(async arrayBuffer => [await getRasterTileFingerprint(arrayBuffer)])
);
```

While the promise is pending, tiles wait for it. If the promise rejects, the function matches no tile.

### `getRasterTileFingerprint(arrayBuffer)`

Returns a promise of the SHA-256 digest of the bytes of a raster tile, as a hexadecimal string. It uses `crypto.subtle`, which browsers supply on secure origins only.

### `createDemTileset(source, loadOptions?)`

<p class="badges">
  <img src="https://img.shields.io/badge/from-v9.3-green.svg?style=flat-square" alt="from v9.3" />
  <img src="https://img.shields.io/badge/stability-experimental-orange.svg?style=flat-square" alt="experimental" />
</p>

Creates the shared tileset of a `raster-dem` source, for the `tilesets` map of `getBasemapLayers`: each tile is fetched and decoded once for all of the source's `hillshade` layers. The caller finalizes it.

### `getGlobeBaseLayers(options)`

<p class="badges">
  <img src="https://img.shields.io/badge/from-v9.3-green.svg?style=flat-square" alt="from v9.3" />
  <img src="https://img.shields.io/badge/stability-experimental-orange.svg?style=flat-square" alt="experimental" />
</p>

Convenience wrapper around `getBasemapLayers` that forces `mode: 'globe'`.

### `getGlobeTopLayers(options)`

<p class="badges">
  <img src="https://img.shields.io/badge/from-v9.3-green.svg?style=flat-square" alt="from v9.3" />
  <img src="https://img.shields.io/badge/stability-experimental-orange.svg?style=flat-square" alt="experimental" />
</p>

Returns the globe overlay layers that should render after the base globe content.

### `resolveBasemapStyle(style, loadOptions?)`

<p class="badges">
  <img src="https://img.shields.io/badge/from-v9.3-green.svg?style=flat-square" alt="from v9.3" />
  <img src="https://img.shields.io/badge/stability-experimental-orange.svg?style=flat-square" alt="experimental" />
</p>

Loads and normalizes a style document. This resolves:

- remote style JSON URLs
- TileJSON-backed source definitions
- GeoJSON source `data` URLs, fetched into the source's `data`
- relative tile template URLs
- legacy Mapbox `ref` layer inheritance

## Example

```ts
import {Deck, _GlobeView} from '@deck.gl/core';
import {BasemapLayer} from '@tangram.gl/basemap-layers';
import styleJson from '../../../../website/static/mapstyle/deck-light.json';

new Deck({
  views: new _GlobeView({resolution: 36}),
  controller: true,
  layers: [
    new BasemapLayer({
      id: 'earth',
      mode: 'globe',
      style: styleJson,
      globe: {
        config: {
          atmosphere: false,
          basemap: true,
          labels: false
        }
      }
    })
  ]
});
```

For a flat-map reference implementation that avoids globe-specific behavior, see the [BasemapLayer MapView example](/examples/layers/basemap-layer-map-view).
