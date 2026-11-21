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

Type: `string | BasemapStyle | ResolvedBasemapStyle | null`

The style document to render. Pass one of:

- a URL string pointing to a style JSON document
- an in-memory MapLibre/Mapbox style object
- a style that `resolveBasemapStyle` or `MapStyleLoader` returned

The layer resolves a URL or a style object before it draws: it fetches the style document, each TileJSON `url` and each GeoJSON `data` URL. A style that is already resolved draws at once, and the layer does not fetch its sources again. Its relative `sprite` and `glyphs` URLs resolve against the URL that it was loaded from. This is the form of MapLibre GL JS's `getStyle()` and `setStyle(style)`: resolve a style one time, keep it, and give it to several layers or give it back later.

A copy of a resolved style (for example `{...style}` or `structuredClone(style)`) is not marked as resolved, so the layer resolves it again. See `isResolvedBasemapStyle`.

```ts
import {resolveBasemapStyle} from '@tangram.gl/basemap-layers/map-style';

const style = await resolveBasemapStyle('https://example.com/style.json');
new BasemapLayer({id: 'base', style});
```

A new style keeps what it shares with the previous style, as MapLibre GL JS's
`setStyle(style, {diff: true})` keeps it. A source with the same definition keeps its TileJSON,
its tiles and its decoded data. The sprites and the glyphs keep their loaded images when their
URLs do not change. A source is decoded again when the style draws a different set of its source
layers. A new `loadOptions` object loads everything again.

A new style object is compared with the previous one by `diff` from
`@maplibre/maplibre-gl-style-spec`, as in MapLibre GL JS. When only paint or layout values,
filters, zoom ranges, the order of the layers or other values that load nothing change, the new
style applies in the same update, without a load, and the next frame draws it. A change of a
source, the sprite or the glyphs loads the style as above. Give a new style object for each
change: the same object again does nothing, also when it was changed in place.

### `mode`

Type: `'auto' | 'map' | 'globe'`

Selects whether the sublayers draw as a flat map or on a globe. Defaults to `'auto'`.

- `'auto'`: the layer reads the mode from the viewport. It draws globe sublayers in a deck.gl `GlobeView` and map sublayers in other views. A layer that draws in two views (for example a `MapView` and a `GlobeView` in one deck) uses the mode of each view.
- `'map'`: always draw map sublayers.
- `'globe'`: draw globe sublayers. Above zoom 12, `GlobeView` uses a Web Mercator viewport, and the layer draws map sublayers there, as with `'auto'`.

This matches MapLibre GL JS, where the projection of the map selects how the style draws. Here, the deck.gl view is the projection, so most apps do not set `mode`.

### `loadOptions`

Type: `BasemapLoadOptions | null`

Optional loader configuration used by `resolveBasemapStyle`. This can include:

- `baseUrl` for resolving relative URLs in in-memory styles
- `fetch` for a custom fetch implementation
- `fetchOptions` to customize network requests

URLs with a custom scheme load with a registered handler instead (see [Custom protocols](#custom-protocols)).

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

### `labels`

Type: `boolean`

Draws the style's symbol layers (labels and icons). Defaults to `true`. It applies in every mode, not only on a globe. With `false`, the tiles do not decode the source layers that only symbol layers read. MapLibre GL JS has no such switch: there, an app sets `layout.visibility` on each symbol layer.

### `atmosphere`

Type: `boolean`

Draws the atmosphere around the globe in globe mode. Defaults to `false`. The atmosphere layers are placeholders that draw nothing yet.

### `globe` (deprecated)

Type: `{config?: BasemapGlobeConfig} | null`

Deprecated. Use `labels` and `atmosphere`. The layer logs a deprecation warning one time when `globe.config` is set, and it still applies the fields:

- `labels`: as the `labels` prop
- `atmosphere`: as the `atmosphere` prop
- `basemap`: `false` draws no style layers. Use deck.gl's `visible: false` in its place.

A field set in `globe.config` overrides the flat prop of the same name. A field that it leaves out keeps the flat prop.

### `separateLabelPlacement`

Type: `boolean`

By default (`false`), the labels of every `BasemapLayer` in a deck are placed together, as the layers of one style: a label is hidden where it overlaps a label placed before it, and the labels of a `BasemapLayer` drawn later (later in the `layers` array) are placed first. Stacking a base style and a labels-only style this way does not draw their labels over each other. Set `true` to place this layer's labels on their own, so that they collide only with each other and never hide, or are hidden by, those of another `BasemapLayer`.

The shared placement takes the `labelPlacementInterval` of the last `BasemapLayer` rendered: give layers that share it the same interval.

### `onStyleLoad`

Type: `((style: ResolvedBasemapStyle) => void) | null`

Called with the resolved style each time a style resolves, as MapLibre GL JS's `style.load` event.
The sprites, the glyphs and the tiles of the style can still be loading. An error that the
function throws goes to deck.gl's `onError`, and the style stays loaded. Defaults to `null`.

### `onTileLoad`

Type: `((tile: BasemapTile) => void) | null`

Called when a tile of a `vector`, `raster`, `raster-dem` or `geojson` source loads, with deck.gl's
tile header, as `TileLayer.onTileLoad`. The style layers of one source share its tiles, so each
load is reported once. Defaults to `null`.

### `onViewportLoad`

Type: `((tiles: BasemapTile[]) => void) | null`

Called with the tiles of all sources in the current viewport when they have loaded, as deck.gl's
`TileLayer.onViewportLoad` and MapLibre GL JS's `idle` event. The style and its sprites have
loaded too. A tile that failed to load counts as loaded. Unlike `TileLayer`, a viewport that
selects no tiles is not reported, and the same tiles are not reported again. Defaults to `null`.

### `onAttributionChange`

Type: `((attributions: string[]) => void) | null`

Called with the `attribution` of the sources that the style draws, when they change, as
`TangramLayer.onAttributionChange`. The list is collected as MapLibre GL JS's
`AttributionControl` collects it: a source that only hidden layers draw at the current zoom is
left out (also layers that `globe.config` turns off, and layer types that are not drawn), each attribution is given once, and one that another contains is left out. A change of
style or zoom can change the list, and a style of `null` gives `[]`. The strings are the
provider's HTML and are **not sanitized**: display them as safe linked text. `BasemapLayer` does
not draw an attribution control. Defaults to `null`.

### `isLoaded`

`BasemapLayer.isLoaded`, and thus deck.gl's `Deck.isLoaded`, is `false` while the style resolves,
while its sprites load, and while the tiles of the current viewport load, as `TileLayer.isLoaded`.
A style, a sprite or a tile that failed to load counts as loaded.

## Methods

### `querySourceFeatures(sourceId, options?)`

Returns the features of a `vector` or `geojson` source that are in the tiles the layer draws now, as MapLibre GL JS's [`Map#querySourceFeatures`](https://maplibre.org/maplibre-gl-js/docs/API/classes/Map/#querysourcefeatures). Use it to read the loaded basemap features without a pointer event: for example, to list the place names in view, or to search the loaded roads.

```ts
const basemap = deck.props.layers.find(layer => layer.id === 'basemap');
const places = basemap.querySourceFeatures('openmaptiles', {
  sourceLayer: 'place',
  filter: ['==', ['get', 'class'], 'city']
});
```

`options`:

- `sourceLayer` (`string`): the source layer to read. Required for a `vector` source, where no features are returned without it. Ignored for a `geojson` source.
- `filter` (`unknown[]`): a style-spec filter expression. `["zoom"]` in it is the zoom of the tile. A filter that the style spec rejects logs a warning and matches no features.

Each returned feature is a GeoJSON `Feature` in longitude and latitude, with:

- `id`: the tile feature's id, or the property that the source's `promoteId` names (a name, or a name per source layer), as in MapLibre. A feature without one has no `id`.
- `properties`: the feature's properties.
- `source` and `sourceLayer`: where the feature was read from (no `sourceLayer` for a `geojson` source).
- `tile`: the `{x, y, z}` index of the tile it was read from.

As in MapLibre:

- The method returns every feature that matches, whether a style layer draws it or not, but it reads only the tiles drawn now: the tiles of the view, and the parent or child tiles drawn in place of tiles that are still loading. Tiles outside the view are not read, also when they are still cached.
- A feature that crosses a tile edge is returned once for each tile, each time with the part of its geometry in that tile. A point near a tile edge can be in two tiles, because tiles have a buffer. Compare `id`s to merge the copies. A tile that is drawn more than once, as in the copies of the world, is read once.
- A raster or `raster-dem` source, an unknown source id, and a layer whose style has not loaded return `[]`.

Unlike MapLibre:

- The tiles of a vector source decode only the source layers that the style draws, so a source layer that no style layer reads returns `[]`.

The method reads state: call it after the tiles load, for example in deck.gl's `onAfterRender`, and not in `renderLayers`.

## Draping on terrain (experimental)

`BasemapLayer` makes deck.gl layers, so deck.gl's `_TerrainExtension` can drape them on a `TerrainLayer`. The [Draped on terrain example](/examples/basemap-layers/draped-terrain) adds the extension to the layers in a subclass, and draws data layers in the same depth buffer as the basemap and the terrain.

## Projected views

`BasemapLayer` also draws in a deck.gl `_CustomProjectionView`: a flat view in a projected coordinate reference system, such as a UTM zone or a conic projection. No prop selects this. The layer reads the kind of view from the viewport, as `mode: 'auto'` does.

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

The [native CRS raster example](/examples/basemap-layers/native-crs-raster) draws the style together with a Cloud Optimized GeoTIFF in the coordinate reference system of the GeoTIFF: a Sentinel-2 image in UTM zone 32N, and a hillshade in Antarctic polar stereographic. The raster is a deck.gl `BitmapLayer` between the fills and the labels of the style.

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

## Custom protocols

```ts
import {registerBasemapProtocol, unregisterBasemapProtocol} from '@tangram.gl/basemap-layers';
```

### `registerBasemapProtocol(scheme, handler)`

Loads every URL `<scheme>://...` that `BasemapLayer` requests with `handler`, in place of `fetch`. The function has the shape of MapLibre GL JS's `addProtocol`, so the same handler works in both:

```ts
registerBasemapProtocol('custom', async (requestParameters, abortController) => {
  const response = await fetch(`https://${requestParameters.url.split('://')[1]}`, {
    signal: abortController.signal
  });
  if (!response.ok) {
    throw new Error(`Tile fetch error: ${response.statusText}`);
  }
  return {data: await response.arrayBuffer()};
});

new BasemapLayer({style: 'custom://tiles.example.com/style.json'});
```

The handler loads these resources:

- the style, when `style` is a URL
- the TileJSON of a source `url`
- the tiles of `vector`, `raster` and `raster-dem` sources
- the sprite index and image
- the glyph ranges of `glyphs`
- the `data` URL of a `geojson` source

`requestParameters` has the `url`, and the `type` of the resource: `'json'` for a style, TileJSON, sprite index or GeoJSON data, `'arrayBuffer'` for a vector tile or glyph range, and `'image'` for a raster or raster-dem tile or sprite image. It also has the `headers`, `method`, `body`, `credentials` and `cache` of `loadOptions.fetchOptions`, where they are set.

The handler resolves with `{data}`. `data` is an `ArrayBuffer`, a typed array or a `Blob`, a string, or for a `'json'` request the parsed JSON value. An image is its encoded bytes: a decoded `ImageBitmap` or `HTMLImageElement` is not supported. `null` or empty data is a tile without data. `cacheControl` and `expires` are accepted and not used.

`abortController` aborts when the request is cancelled, for example when deck.gl no longer needs a tile. The request then rejects at once, also when the handler ignores the abort.

Notes:

- A URL with a registered scheme is used as it is written. It is not resolved against the style URL, so a handler can read URLs such as `pmtiles://https://example.com/archive.pmtiles`. Relative URLs in a style or TileJSON loaded from `<scheme>://host/path` resolve against that URL, as with `https`.
- `http`, `https` and `file` URLs always load with `fetch`, as in MapLibre GL JS, and cannot be registered. A URL with another scheme and no handler fails with an error that names the scheme, unless a custom `fetch` in `loadOptions` loads it.
- The registry is global, as MapLibre GL JS's is. A second registration of the same scheme replaces the first.

### `unregisterBasemapProtocol(scheme)`

Removes the handler of `scheme`. Requests of its URLs then fail.

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

With a `sourceCache` map in `loadOptions`, a source whose definition and base URL are in the map
is not fetched again. Each call replaces the entries of the map with the sources it resolved.
`BasemapLayer` uses this to keep the TileJSON of a source across styles.

The result is marked as resolved, so that `BasemapLayer` draws it without resolving it again (see [`style`](#style)).

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
      labels: false
    })
  ]
});
```

For a flat-map reference implementation that avoids globe-specific behavior, see the [BasemapLayer MapView example](/examples/layers/basemap-layer-map-view).
