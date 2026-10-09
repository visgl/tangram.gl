{/*
tangram-layers
SPDX-License-Identifier: MIT
Copyright (c) vis.gl contributors
 */}

# Classic Tangram playground

This is the classic Tangram scene playground, contained inside the website so
the Examples sidebar remains available from the documentation navigation. The
playground itself is a buildable example package rather than an embedded iframe.

<div>
  <a className="button button--primary button--lg" href="/tangram.gl/examples/classic?scene=styles/crosshatch-preview.yaml">
    Open the classic playground
  </a>
</div>

The deck.gl-community 9.4.2 `Playground` supplies the full-height community
TextEditorPanel and tabs. **Select Style** shows the available scene cards;
**Style JSON** edits the active document with the renderer's JSON Schema for
completion and diagnostics. **Settings** contains camera and debug controls.
If the schema is unavailable, the original YAML remains editable as plain text.

Pause briefly after editing to apply it. Parse and scene-load errors appear in
the preview status; malformed documents are not sent to Tangram. Scene loads
are serialized, obsolete updates are cancelled, and relative imports resolve
against the selected style file. The preview retains the classic map and its
controls. The editor, stylesheets, and matching Monaco workers are bundled
locally with ocular rather than loaded from an editor CDN.

The cards explain each style's effect and distinguish the live vector basemaps
from the small bundled Manhattan fixtures. Selecting a local fixture or building
effect restores its street-level view; selecting Albers opens the national
overview. An explicit camera in a direct-link hash is preserved on startup.

Vector basemaps in the picker use [OpenFreeMap](https://openfreemap.org/)
vector tiles, with visible OpenFreeMap, OpenMapTiles and OpenStreetMap credits.
The light and street comparison styles are vector scenes, not raster fallbacks;
the previous `open-light-raster.yaml` and `open-streets-raster.yaml` URLs remain
compatibility wrappers. The small Manhattan fixtures render as separate named
overlay layers over these live basemaps, without a second Leaflet raster layer.
Albers keeps its bundled US-state geometry. The outdoor terrain styles still
use their separate elevation/normal-map sources where required.

NASA Blue Marble is available for overview imagery; its zoom-8 source is not a
street-level satellite basemap. See [provider credits](../developer-guide/tile-providers.md).
Use the example's fullscreen control for more editor/map space. To run the
standalone build, follow the [local development instructions](../contributor-guide/development.md).
The [source and style assets](https://github.com/visgl/tangram.gl/tree/master/examples/classic)
are copied into the website during the build.

All gallery scenes are keyless. The historical basemap and shader styles use a
compatibility transform that maps current OpenMapTiles source layers and
properties onto the Mapzen schema they were authored against. Only the
projection morph is wholly self-contained; the other styles and fixture
overlays require a network connection for their live basemaps.

The **Albers projection morph** is a self-contained port of the classic
[Escape from Mercator](https://www.mapzen.com/blog/escape-from-mercator)
experiment. Zoom out to watch the bundled US map transition from Web Mercator
to an Albers equal-area projection. At overview zoom it automatically cycles
Albers → Mercator → Albers every 12 seconds; fills and borders use the same clock.
Selecting it opens a US-wide view, and both the state fills and borders morph
together. Zoom in through levels 5–10 to blend back toward Web Mercator. Direct
links with an explicit `#zoom/latitude/longitude` retain that authored view.
This shader-block experiment uses the classic WebGL playground, not the hosted
WebGPU shader path.
