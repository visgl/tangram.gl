{/*
tangram-layers
SPDX-License-Identifier: MIT
Copyright (c) vis.gl contributors
 */}

# Styling reference

Tangram styles are scene documents. A scene combines data sources, layers, and
draw rules. The renderer evaluates those rules for each feature and emits the
geometry, color, and effects needed by the active rendering device.

## Smallest useful style

The following scene draws the OpenMapTiles `transportation` collection. The YAML and JSON
forms are equivalent; use whichever is easier to generate or edit in your
application.

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

<Tabs groupId="style-format">
  <TabItem value="yaml" label="YAML" default>

```yaml
sources:
  map:
    type: MVT
    tilejson: https://tiles.openfreemap.org/planet
    tile_size: 512
    max_zoom: 14

layers:
  roads:
    data: {source: map, layer: transportation}
    draw:
      lines:
        color: '#58e6ff'
        width: 2px
        order: 10
```

  </TabItem>
  <TabItem value="json" label="JSON">

```json
{
  "sources": {
    "map": {
      "type": "MVT",
      "tilejson": "https://tiles.openfreemap.org/planet",
      "tile_size": 512,
      "max_zoom": 14
    }
  },
  "layers": {
    "roads": {
      "data": {"source": "map", "layer": "transportation"},
      "draw": {
        "lines": {
          "color": "#58e6ff",
          "width": "2px",
          "order": 10
        }
      }
    }
  }
}
```

  </TabItem>
</Tabs>

Display the source's required [attribution](../developer-guide/tile-providers.md)
in your map UI; drawing a scene does not create a credit control.

## Scene structure

- `sources` describes where feature data comes from. Common source types are
  vector tiles (`MVT`), GeoJSON, and raster tiles.
- `layers` selects source features and assigns drawing rules. A layer can have
  nested sublayers with `filter` expressions for different feature classes.
- `draw` chooses a primitive such as `polygons`, `lines`, `points`, or `text`.
  Draw rules support paint properties such as `color`, `width`, `outline`, and
  `order`.
- `styles`, `textures` and `fonts` define reusable rendering assets.
- `cameras` and `lights` are top-level sections. Host-driven cameras come from
  `HostFrame`, not the scene's camera definitions.
- `scene` contains settings such as background, animation and worker scripts.
- `global` supplies shared values; `import` composes scene documents.

Scene expressions and worker scripts execute code. Treat remote scene files as
trusted application inputs, not safe data to load from arbitrary users.

## Vector tile decoders

`MVT` sources use Tangram's original decoder by default. The optional loaders.gl
worker registers an additional decoder; load the sidecar in the scene and
select it by name:

```yaml
scene:
  scripts:
    - https://vis.gl/tangram.gl/modules/tangram-renderer/dist/loaders-gl-worker.js
sources:
  map:
    type: MVT
    url: https://tiles.example.test/{z}/{x}/{y}.mvt
    decoder: loaders-mvt
```

The sidecar registers `loaders-mvt` and `loaders-mlt` decoders plus the
`loaders-pmtiles` tile provider. The MVT decoder returns Tangram-local,
layer-indexed GeoJSON feature collections and honors Tangram's `parse_json`
option. The standard renderer bundle still defaults to Tangram's decoder and
does not include the optional worker or its loaders.gl packages.

Custom registered decoders must return named feature collections in
Tangram-local tile coordinates and preserve `parse_json` and source-transform
behavior. `decoder: tangram` selects the built-in parser. An unregistered name
produces an error in the scene worker.

### Format and container choices

A PMTiles archive is a container, not a tile encoding. Select the decoder that
matches its contents; using `loaders-mlt` on an MVT archive is invalid.

| Example | Acquisition | Decoder |
| --- | --- | --- |
| [OpenFreeMap MVT](/tangram.gl/examples/classic?scene=styles/loaders-mvt.yaml) | TileJSON/XYZ service | `loaders-mvt` |
| [Protomaps PMTiles](/tangram.gl/examples/classic?scene=styles/loaders-pmtiles.yaml) | `tile_provider: loaders-pmtiles` | `loaders-mvt` (the example archive contains MVT) |
| [MapLibre MLT](/tangram.gl/examples/classic?scene=styles/loaders-mlt.yaml) | XYZ MLT service | `loaders-mlt` |

All three examples load the optional worker and use public demo data. Service
availability, data schemas and licenses are independent of format support.
For an archive containing MLT, combine `loaders-pmtiles` with `loaders-mlt`.

Build the sidecar with
`yarn workspace @vis.gl/tangram-renderer build:loaders-gl-worker`.
Serve it at the absolute URL in `scene.scripts`; the URL above assumes the
website's assembled asset layout. A custom host must copy the asset itself.
The provider acquires encoded bytes; decoders return named feature collections
in Tangram's local coordinates. See [tile loading](../developer-guide/tile-loading.md)
for capabilities, metadata and cancellation.

## Validation and editor tooling

The renderer exports a Zod schema for runtime validation and a generated
Draft 7 JSON Schema for editors and language servers:

```js
import {TangramStyleSheetSchema} from '@vis.gl/tangram-renderer/style-schema';
import tangramStyleJsonSchema from '@vis.gl/tangram-renderer/tangram-style.schema.json'
  with {type: 'json'};

const result = TangramStyleSheetSchema.safeParse(sceneDocument);
console.log(tangramStyleJsonSchema.$id);
```

Builds generate both schema entries; they are not checked into Git. JSON import
syntax must be supported by your host/bundler, or load the copied JSON asset over
HTTP. The schema preserves open-ended style/shader fields: passing validation
is not a guarantee of compatible shaders, valid URLs or supported projections.
The scene loader does not automatically run Zod validation.

The website playground passes this schema to the deck.gl-community
`TextEditorPanel`, enabling Monaco diagnostics and completion for the editable
JSON scene document. The renderer still accepts the original YAML scene files;
the editor converts the selected YAML source to JSON for schema-aware editing
and sends the edited object back through Tangram's normal scene loader.

## Filters and zoom stops

Filters and zoom-dependent values keep a style readable at every scale. The
following rule highlights primary roads and increases their width gradually:

```yaml
layers:
  roads:
    data: {source: map, layer: transportation}
    filter: {class: primary}
    draw:
      lines:
        color: '#ff4fd8'
        width:
          - [8, 1px]
          - [14, 3px]
          - [18, 7px]
```

## Expressions and feature properties

Style values can reference feature properties and scene variables. Keep the
property names aligned with the tile schema: a rule that asks for `kind`
cannot match a source that only provides `class` unless the source is adapted
before styling.

## Rendering notes

`order` determines draw ordering within the Tangram scene. For coplanar geometry, use
different orders or a small `z` offset instead of relying on depth precision.
Text and line widths are expressed in screen-aware units by the renderer. The
same scene document can therefore be passed to `@vis.gl/tangram-renderer` or
to `@vis.gl/tangram-layers` without changing the style format.

For a complete working document, see the scene files in
[`examples/classic/styles`](https://github.com/visgl/tangram.gl/tree/master/examples/classic/styles)
and the [classic playground](/tangram.gl/examples/classic).
The [legacy scene reference](https://tangrams.readthedocs.io/en/latest/)
describes the wider language; use this fork's API pages for backend restrictions.
