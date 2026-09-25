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

The following scene draws roads from a vector-tile source. The YAML and JSON
forms are equivalent; use whichever is easier to generate or edit in your
application.

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

<Tabs groupId="style-format">
  <TabItem value="yaml" label="YAML" default>

```yaml
scene:
  scripts:
    - https://example.test/loaders-mvt-decoder.js
sources:
  map:
    type: MVT
    url: https://tiles.example.test/{z}/{x}/{y}.mvt

layers:
  roads:
    data: {source: map}
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
      "url": "https://tiles.example.test/{z}/{x}/{y}.mvt"
    }
  },
  "layers": {
    "roads": {
      "data": {"source": "map"},
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

## Scene structure

- `sources` describes where feature data comes from. Common source types are
  vector tiles (`MVT`), GeoJSON, and raster tiles.
- `layers` selects source features and assigns drawing rules. A layer can have
  nested sublayers with `filter` expressions for different feature classes.
- `draw` chooses a primitive such as `polygons`, `lines`, `points`, or `text`.
  Draw rules support paint properties such as `color`, `width`, `outline`, and
  `order`.
- `scene` contains global settings such as background color, camera behavior,
  and texture declarations.

## Vector tile decoders

`MVT` sources use Tangram's original decoder by default. Renderer integrations
can register another decoder in the worker and select it by name:

```yaml
sources:
  map:
    type: MVT
    url: https://tiles.example.test/{z}/{x}/{y}.mvt
    decoder: loaders-mvt
```

The script registers a synchronous function with
`self.registerMvtDecoder('loaders-mvt', decodeTile)`. `decodeTile` receives the
tile bytes and Tangram's `parse_json` option, and returns a record of named
GeoJSON feature collections.

The registered decoder must return named feature collections in Tangram-local
tile coordinates and preserve `parse_json` and source-transform behavior.
`decoder: tangram` selects the built-in parser. An unregistered name produces
an error in the scene worker. The loaders.gl MVT implementation remains a
development-only comparison candidate until its GeoJSON entry avoids pulling
Arrow and binary-conversion dependencies into the renderer bundle.

## Validation and editor tooling

The renderer publishes a Zod schema for runtime validation and a generated
Draft 7 JSON Schema for editors and language servers:

```js
import {TangramStyleSheetSchema} from '@vis.gl/tangram-renderer/style-schema';
import tangramStyleJsonSchema from '@vis.gl/tangram-renderer/tangram-style.schema.json';

const result = TangramStyleSheetSchema.safeParse(sceneDocument);
console.log(tangramStyleJsonSchema.$id);
```

The schema accepts the standard scene sections while preserving Tangram's
open-ended style, shader, and renderer-specific properties.

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
    data: {source: map}
    filter: {kind: primary}
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

`order` determines draw ordering within a layer. For coplanar geometry, use
different orders or a small `z` offset instead of relying on depth precision.
Text and line widths are expressed in screen-aware units by the renderer. The
same scene document can therefore be passed to `@vis.gl/tangram-renderer` or
to `@vis.gl/tangram-layers` without changing the style format.

For a complete working document, see the scene files in
[`examples/classic/styles`](https://github.com/visgl/tangram.gl/tree/master/examples/classic/styles)
and the [classic playground](../examples/classic).
