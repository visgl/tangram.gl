{/*
tangram-layers
SPDX-License-Identifier: MIT
Copyright (c) vis.gl contributors
 */}

# Tangram concepts

This page distills the Tangram scene concepts that are most useful when moving
a style into the current packages. For the complete reference, see the
[Tangram documentation](https://tangrams.readthedocs.io/en/latest/).

## A scene is data, style, and behavior

Tangram scenes are YAML documents. A scene usually contains:

- `global` values and JavaScript expressions shared by the rest of the scene;
- `sources`, which describe vector, raster, GeoJSON, or TopoJSON data;
- `layers`, which select features and choose their draw styles;
- `styles`, `textures`, and `fonts` used by those draw styles; and
- `cameras` and a `scene.background` for the view.

The [classic example scene](https://github.com/visgl/tangram.gl/blob/master/examples/classic/scene.yaml)
is a compact reference that exercises most of these sections.

## Sources and layers

A source turns a URL or local asset into feature data. A layer reads from a
source, filters the features, and assigns a draw block. Layers can be nested;
the more specific child layer inherits its parent's data and draw settings and
overrides only what it needs.

```yaml
sources:
  places:
    type: GeoJSON
    url: data/places.geojson

layers:
  places:
    data: {source: places}
    filter: {kind: park}
    draw:
      points:
        color: '#44d7e8'
        size: 10px
```

Vector tile sources are normally addressed with `{z}`, `{x}`, and `{y}`
placeholders. Keep credentials in runtime configuration (`global` values or
layer options), never in a checked-in scene or generated bundle.

## Draw blocks and styles

The draw primitive communicates the geometry type: `points`, `lines`,
`polygons`, `text`, or `icons`. A draw block can set color, width, order,
opacity, blending, and interactivity. A named style factors those settings out
of a layer and can add shader snippets:

```yaml
styles:
  glowing-lines:
    base: lines
    blend: overlay
    shaders:
      blocks:
        color: |
          color.rgb *= vec3(0.7, 0.9, 1.0);
```

Scene expressions are evaluated per feature and can use feature properties,
zoom, and global values. This is why a single scene can vary road widths,
building colors, or label text continuously while zooming.

## Cameras, labels, and interaction

Tangram's classic renderer supports flat, perspective, and isometric cameras.
Labels are draw blocks with a `text_source`, font, priority, and optional
stroke; the renderer performs collision management as tiles arrive. A layer or
feature marked `interactive: true` can be inspected by the application through
the scene's event hooks.

In a deck.gl integration, deck.gl owns the camera and pointer interaction. The
Tangram layer receives the resulting longitude, latitude, zoom, bearing, pitch,
and viewport size, while the renderer continues to own scene traversal and
resource lifetime.

## Porting a historical demo

When bringing one of the [original demo repositories](../README.md#original-demo-catalog) into
this monorepo:

1. Copy the scene and its local assets into a package under `/examples`.
2. Replace legacy script tags with `@vis.gl/tangram-renderer` entrypoints.
3. Keep scene-relative URLs relative to the package's built output.
4. Move API keys and service URLs to runtime options or URL parameters.
5. Prefer `TangramLayer` when deck.gl should own the device and viewport.

The historical docs and demos remain authoritative for the original scene
language. These notes describe the package boundaries and runtime conventions
used by this fork.
