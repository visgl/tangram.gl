{/*
tangram-layers
SPDX-License-Identifier: MIT
Copyright (c) vis.gl contributors
 */}

# Tile providers and attribution

Tangram renders tiles from multiple providers. A rendering library license does
not replace a provider's data license or attribution obligations. Store required
credit text/links with each source and let the embedding application display them.

## Source-driven attribution

```yaml
sources:
  basemap:
    type: MVT
    tilejson: https://tiles.openfreemap.org/planet
    tile_size: 512
    max_zoom: 14
    attribution: >-
      <a href="https://openfreemap.org">OpenFreeMap</a>
      <a href="https://www.openmaptiles.org/">© OpenMapTiles</a>
      Data from <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>
```

This defines a source, **not** a complete Tangram style. Set source zoom limits
explicitly: current TileJSON resolution supplies a tile URL and attribution,
not automatic adoption of every TileJSON field. The live service's limits can
change; check its metadata when configuring a provider.

After `renderer.load()` or `scene.load()`, `getAttributions()` returns deduplicated
credits for all current sources. For TileJSON-only sources it resolves metadata
once per source instance and retains both explicit and discovered credits.
Ordinary tile-URL sources need explicit attribution. When both `url` and
`tilejson` are supplied, the existing explicit-URL precedence remains unchanged;
declare credits explicitly in that case too. Metadata failures reject so a host
can report the problem rather than silently claim complete attribution.

Refresh after source changes, including replacements through `setDataSource()`.
`TangramLayer.onAttributionChange` handles loading,
updates, stale asynchronous results and disposal for deck applications. The
classic Leaflet example adds/removes source credits through Leaflet's existing
control. Neither renderer entry imports Leaflet or an attribution widget.

Provider HTML is untrusted. The examples preserve text and absolute HTTP(S)
links only, stripping scripts, handlers, images, styles and active URL schemes.
Applications using the API must apply their own equivalent sanitization. Do not
feed returned strings directly to `innerHTML` or React's `dangerouslySetInnerHTML`.

Keep linked credits readable inside the map's fullscreen container. The deck,
homepage and WebXR mono/stereo-preview examples use source-driven credits,
including provider changes. DOM overlays are not part of an immersive XR
framebuffer: an immersive host must supply an in-headset credit/info surface.
The current experimental examples do **not** implement that surface. Likewise,
canvas screenshots/video omit DOM credits; add attribution to exported media
as required by the provider. Merely retrieving credits does not establish compliance.

## Default vector provider: OpenFreeMap

The deck streets/TRON examples, homepage hero and WebXR vector scenes use
OpenFreeMap by default. CARTO is no longer offered in the controls; old
`?provider=carto` bookmarks remain compatible rather than silently changing their
data. NASA Blue Marble replaces Positron as the raster choice. The Nextzen style
still requires its existing key.

Vector styles in the classic playground use OpenFreeMap through the
OpenMapTiles compatibility transform. Light and street comparisons are vector
styles rather than raster basemaps. The local GeoJSON previews overlay their
bundled fixtures on these live vector scenes, without a second Leaflet raster
layer. The Albers morph is a standalone bundled GeoJSON example, while terrain
shading retains its separate elevation source.

The shared source factory uses TileJSON rather than a hard-coded dated URL,
clears inherited `url`/URL parameters, sets maximum data zoom 14 and tile size
512 for deck/WebXR, and declares loading-time credits before metadata arrives.
At higher view zooms Tangram overzooms level-14 data rather than requesting
nonexistent higher levels. Recheck service metadata before changing these limits.

[OpenFreeMap](https://openfreemap.org/) offers a public instance without API keys
or registration, and publishes an unmodified OpenMapTiles schema. Its
[quick-start styles](https://openfreemap.org/quick_start/) are MapLibre style
documents, not Tangram YAML. Tangram can use the underlying MVT data without
introducing a MapLibre runtime.

The public [TileJSON endpoint](https://tiles.openfreemap.org/planet) currently
provides versioned tile templates, zoom levels and linked attribution. Resolve
this stable metadata endpoint rather than hard-coding a dated planet directory.
During this assessment it served levels 0–14 and allowed cross-origin access.
Live-service checks are not dependencies of hermetic CI.

Its attribution instructions require linked OpenMapTiles and OpenStreetMap
credits; OpenFreeMap credit is optional but appreciated. Retaining the complete
TileJSON credit is the straightforward choice. The public service currently
offers no SLA guarantee. Follow the provider's current instructions rather than
treating this document as a substitute for its terms.

## Mapterhorn elevation (POC)

The classic playground's **Mapterhorn hillshade (POC)** scene uses
[Mapterhorn's public endpoint](https://mapterhorn.com/data-access/) as its default
elevation source: `https://tiles.mapterhorn.com/{z}/{x}/{y}.webp`, 512-pixel,
Terrarium-encoded tiles. It conservatively caps data zoom at 12, the global planet
archive's documented range, and overzooms higher views. Regional higher-resolution
coverage is not yet selected dynamically.

Height in meters is `R * 256 + G + B / 256 - 32768` for byte-valued RGB. The POC
uses nearest filtering to avoid encoded-channel interpolation across carries,
then central differences and latitude-adjusted physical pixel spacing for shading.
The existing normal-map sources are **not** changed: Terrarium heights cannot be
sampled as encoded normals. Raster-edge samples clamp to the tile; neighbor-aware
seam handling and smooth decoded-height interpolation remain follow-ups.

This is classic WebGL 2 hillshade, not terrain displacement, automatic elevation
loading, terrain picking or a WebGPU implementation. OpenFreeMap remains the vector
default; TRON and other examples are unchanged. A production switch for Walkabout
and Refill needs normal generation and style conformance first.

Mapterhorn heights can also drive displaced terrain meshes and terrain queries;
the provider is not limited to hillshading. This POC demonstrates only shading.
Mesh displacement, edge stitching, terrain LOD, and globe-aware height sampling
remain separate renderer integration work.

The scene retains linked [Mapterhorn data attribution](https://mapterhorn.com/attribution/)
alongside OpenFreeMap/OpenMapTiles/OpenStreetMap credits. Mapterhorn combines
several open-data sources; its code license is not the terrain data license.
Use current source-specific credits/terms when redistributing data or exports.

## NASA Blue Marble imagery

The deck.gl and WebXR MapView, GlobeView and FirstPersonView examples, classic
playground and experimental projections offer Blue Marble. The projections
example defaults to it; other examples retain their vector defaults.
The shared raster source uses NASA GIBS's EPSG:3857 WMTS JPEG tiles at levels
0–8 and overzooms higher views. This is overview imagery, not a street-level
satellite basemap. It inherits the source grid's ±85.0511287798066° latitude limit.

Blue Marble's publisher requests **NASA Earth Observatory** credit; the examples
also identify **NASA GIBS** as the tile service. NASA's
[media-use guidelines](https://www.nasa.gov/nasa-brand-center/images-and-media/)
permit factual, informational use without implying endorsement. This is not
a blanket license for NASA logos or separately credited third-party material.
See the [Blue Marble publication and credit](https://science.nasa.gov/earth/earth-observatory/blue-marble-next-generation/)
and [GIBS tile API](https://nasa-gibs.github.io/gibs-api-docs/map-library-usage/).
The imagery is not relicensed under this repository's MIT license. Display
credits when exporting images and in immersive presentation as well as the DOM.

## Compatibility and follow-up validation

1. Use OpenFreeMap for vector choices and NASA Blue Marble for overview imagery;
   retain explicit old provider bookmarks only for compatibility.
2. Reuse the existing OpenMapTiles-to-Tilezen compatibility transform for classic styles.
   Compare layer names, road classes, building `render_height`/`render_min_height`,
   labels and zoom behavior with small conformance fixtures.
3. Check TRON traffic, crosshatch, extruded buildings and labels with real tiles
   across MapView, FirstPersonView and GlobeView, on both GPU backends.
4. Verify required links in source changes, stereo preview, fullscreen and exports;
   implement the separate immersive attribution surface before headset signoff.
5. Continue regional and zoom-level comparisons using recorded conformance fixtures
   while remaining visual differences are characterized.

The deck vector examples target OpenMapTiles-style layers such
as `transportation`, `building`, `landuse`, `water` and `place`. Legacy Tilezen
styles expect different collections and properties; changing only a Nextzen
URL will not make all those styles work. This migration does not claim that
every classic style is compatible.
