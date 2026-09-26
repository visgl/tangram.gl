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

### Tile format examples

The examples gallery includes a baseline MVT source, an MVT tileset stored in a
PMTiles archive, and a direct MLT tile service. The source URLs are public demos
documented by OpenFreeMap, Protomaps, and MapLibre; they may require network
access and can be subject to those services' availability and usage policies.

For PMTiles, the loaders.gl source's `getTile({x, y, z})` returns the encoded
tile `ArrayBuffer`. The example selects Tangram's existing MVT decoder, so this
demonstrates the archive container without changing the encoded tile format.
The source is created without a `shape` option because that option applies to
the higher-level `getVectorTile()` method, not the raw `getTile()` method.

### PMTiles archives with MLT tiles

An optional worker add-on registers loaders.gl's PMTiles tile source and MLT
decoder. The renderer build emits it as a separate sidecar; to build only this
worker, run `yarn workspace @vis.gl/tangram-renderer build:loaders-gl-worker`.
Serve `dist/loaders-gl-worker.js` alongside the renderer package. It is a
separate worker script and is not included in the standard Tangram bundle.

```yaml
scene:
  scripts:
    - https://example.test/tangram/dist/loaders-gl-worker.js
sources:
  map:
    type: MVT
    url: https://demo-bucket.protomaps.com/v4.pmtiles
    tile_provider: loaders-pmtiles
    decoder: loaders-mlt
```

The PMTiles provider retrieves raw `{z,x,y}` tile bytes from the archive; the
MLT decoder groups features by layer and converts normalized local coordinates
to Tangram's tile coordinate scale. Standard builds do not include the optional
loaders.gl dependencies or add them to the renderer's main bundle. The direct
MLT service example uses MapLibre's public `plain` demo tiles at
`https://demotiles.maplibre.org/tiles-mlt/plain/{z}/{x}/{y}.mlt`.

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
