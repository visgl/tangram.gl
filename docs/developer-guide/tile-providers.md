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
OpenFreeMap by default. Choose **Vector provider → CARTO** in deck or WebXR
controls, or append `?provider=carto` (use `&provider=carto` with existing query
parameters). The provider is retained when changing devices/views; changing it
reloads the example with the same style selection. This is a selectable
alternative, not a silent automatic failover. The Positron raster alternative
remains on CARTO; the Nextzen style still requires its existing key.

All tiled styles in the classic playground use OpenFreeMap through the
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

The immersive headset/export attribution limitations above still apply. This
provider migration does not establish immersive-VR attribution compliance.

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

### Compatibility and follow-up validation

1. Retain CARTO as a selectable vector option and as the raster alternative.
2. Reuse the existing OpenMapTiles-to-Tilezen compatibility transform for classic styles.
   Compare layer names, road classes, building `render_height`/`render_min_height`,
   labels and zoom behavior with small conformance fixtures.
3. Check TRON traffic, crosshatch, extruded buildings and labels with real tiles
   across MapView, FirstPersonView and GlobeView, on both GPU backends.
4. Verify required links in source changes, stereo preview, fullscreen and exports;
   implement the separate immersive attribution surface before headset signoff.
5. Continue regional and zoom-level comparisons; preserve the CARTO option while
   remaining visual differences are characterized.

The deck vector examples target OpenMapTiles-style layers such
as `transportation`, `building`, `landuse`, `water` and `place`. Legacy Tilezen
styles expect different collections and properties; changing only a Nextzen
URL will not make all those styles work. This migration does not claim that
every classic style is compatible.
