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

The deck.gl-community `SidebarPanelContainer` holds an `AccordeonPanel` with
the SettingsPanel and TextEditorPanel. Use the Scene section to switch between
historical styles and shader experiments, or open Scene YAML to edit the
active document. Pause briefly after editing to apply it; invalid YAML is
reported in the panel title and is not submitted to Tangram.

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
to an Albers equal-area projection.
