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

The [standalone playground](/tangram.gl/examples/classic/) is also
available when a full-window map is more convenient. The [source and style
assets](https://github.com/visgl/tangram.gl/tree/master/examples/classic)
are packaged and copied into the website during the build.

All gallery scenes are keyless. The historical basemap and shader styles use a
compatibility transform that maps current OpenMapTiles source layers and
properties onto the Mapzen schema they were authored against. The local
streets, TRON preview, raster maps, projection morph, and Crosshatch preview
remain self-contained alternatives.

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
