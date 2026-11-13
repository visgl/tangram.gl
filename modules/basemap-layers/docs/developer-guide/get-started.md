<!--
tangram-layers
SPDX-License-Identifier: MIT
Copyright (c) vis.gl contributors
-->

# Get Started

## Installing

```sh
yarn add @deck.gl/core@10.0.0-alpha.1 @tangram.gl/basemap-layers @deck.gl-community/geo-layers@10.0.0-alpha.1
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
      mode: 'map',
      style: styleJson
    })
  ]
});
```

For globe rendering, switch `mode` to `'globe'` and pass optional globe config:

```ts
new BasemapLayer({
  id: 'earth',
  mode: 'globe',
  style: styleJson,
  globe: {
    config: {
      atmosphere: false,
      basemap: true,
      labels: false
    }
  }
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
