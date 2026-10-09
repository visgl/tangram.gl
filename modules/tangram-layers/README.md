<!--
tangram-layers
SPDX-License-Identifier: MIT
Copyright (c) vis.gl contributors
-->

# @vis.gl/tangram-layers

Experimental deck.gl basemap integration for tangram.gl. This workspace is
private and unpublished; build it from the repository root with `yarn build:modules`.

```js
import {Deck, MapView} from '@deck.gl/core';
import {TangramLayer} from '@vis.gl/tangram-layers';

const deck = new Deck({
  canvas: 'map',
  views: new MapView(),
  initialViewState: {longitude: -74, latitude: 40.7, zoom: 12},
  controller: true,
  layers: [new TangramLayer({id: 'basemap', scene: 'scene.yaml'})]
});
```

The layer accepts a scene URL or object, uses deck.gl's active luma.gl device and
render pass, and supports flat/perspective MapView plus experimental GlobeView
and FirstPersonView. The current peer stack is deck.gl/luma.gl 9.4; use compatible
versions sharing one device runtime.

- [TangramLayer properties and limitations](https://vis.gl/tangram.gl/docs/api-reference/tangram-layer)
- [Experimental projected basemaps](https://vis.gl/tangram.gl/docs/developer-guide/projected-basemaps)
- [Experimental WebXR presentation](https://vis.gl/tangram.gl/docs/api-reference/webxr-presentation)

The experimental subpaths are opt-in and do not enter the ordinary layer bundle.
Display the scene's required attribution through `onAttributionChange`; the layer
does not mount a credit control. See the API reference for safe presentation.
