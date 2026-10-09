{/*
tangram-layers
SPDX-License-Identifier: MIT
Copyright (c) vis.gl contributors
 */}

# Examples

The [examples gallery](/tangram.gl/examples) is the complete runnable catalog,
with screenshots and a dedicated sidebar. Examples stay embedded in the website;
use their fullscreen controls when you need more canvas/editor space.

| Group | Start here |
| --- | --- |
| `@vis.gl/tangram-layers` | [MapView](/tangram.gl/examples/deck), [GlobeView](/tangram.gl/examples/deck-globe), [FirstPersonView](/tangram.gl/examples/deck-first-person), [projections](/tangram.gl/examples/deck-projected) |
| `@vis.gl/tangram-layers` (WebXR) | [Globe](/tangram.gl/examples/webxr), [map](/tangram.gl/examples/webxr-map-view), [first person](/tangram.gl/examples/webxr-first-person), [Thor gestures](/tangram.gl/examples/webxr-thor) |
| `@vis.gl/tangram-renderer` | [Classic playground](/tangram.gl/examples/classic) with selectable styles and a schema-driven editor |

The default vector scenes use OpenFreeMap. NASA Blue Marble supplies overview
imagery, while local fixtures and the animated Albers morph demonstrate styling.
Check [provider attribution](../developer-guide/tile-providers.md) before reusing
scenes, showing them in a headset or exporting images.

Applications and assets live in [`examples/`](https://github.com/visgl/tangram.gl/tree/master/examples).
For local Docusaurus and standalone HTTP serving, follow the
[development workflow](../contributor-guide/development.md). Build a fresh clone
before serving; do not open examples with `file://`.
