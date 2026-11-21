<!--
tangram-layers
SPDX-License-Identifier: MIT
Copyright (c) vis.gl contributors
-->

# Get Started

## Installing

```sh
yarn add @tangram.gl/basemap-layers \
  @deck.gl/core@10.0.0-alpha.1 @deck.gl/layers@10.0.0-alpha.1 \
  @deck.gl/geo-layers@10.0.0-alpha.1 @deck.gl/extensions@10.0.0-alpha.1 \
  @deck.gl-community/geo-layers@10.0.0-alpha.1 \
  @luma.gl/core@10.0.0-alpha.14 @luma.gl/engine@10.0.0-alpha.14 \
  @loaders.gl/core@5.0.0-beta.8
```

## Using in deck.gl

To use `BasemapLayer` in a deck application:

```ts
import {Deck} from '@deck.gl/core';
import {BasemapLayer} from '@tangram.gl/basemap-layers';
import styleJson from '../../../website/static/mapstyle/deck-light.json';

new Deck({
  layers: [
    new BasemapLayer({
      id: 'basemap',
      style: styleJson
    })
  ]
});
```

For globe rendering, draw the layer in a deck.gl `GlobeView`. The default `mode: 'auto'` reads the globe from the viewport, so the layer needs no `mode` prop. The `labels` prop turns the labels off in any mode:

```ts
new BasemapLayer({
  id: 'earth',
  style: styleJson,
  labels: false
});
```

## Main Exports

- `BasemapLayer`
- `getBasemapLayers`
- `getGlobeBaseLayers`
- `getGlobeTopLayers`
- `resolveBasemapStyle`

The separate map-style helpers are exported from `@tangram.gl/basemap-layers/map-style`.

## Local Development

```sh
yarn
yarn --cwd modules/basemap-layers test
yarn lint
```
