{/*
tangram-layers
SPDX-License-Identifier: MIT
Copyright (c) vis.gl contributors
 */}

# TangramLayer

![webgpu](https://img.shields.io/badge/webgpu-supported-blue.svg?style=flat-square)
![webgl2](https://img.shields.io/badge/webgl2-supported-blue.svg?style=flat-square)

import DeckExample from '@site/src/components/DeckExample';
import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

<DeckExample
  viewMode="mapPerspective"
  title="TangramLayer"
  description="A Tangram vector basemap rendered in deck.gl's active device and render pass. Blue landmarks and the orange path are deck.gl overlay layers."
/>

`TangramLayer` renders a [Tangram scene](./styling.md) as a deck.gl basemap. deck.gl owns
the view, controller, canvas, luma.gl device, render pass, and frame scheduling; Tangram owns
the scene, vector-tile loading, styling, labels, and GPU resources used by the basemap.

Place `TangramLayer` before overlay layers so that deck.gl draws overlays on top of the
basemap.

<Tabs groupId="language">
  <TabItem value="js" label="JavaScript">

```js
import {Deck, MapView} from '@deck.gl/core';
import {PathLayer} from '@deck.gl/layers';
import {TangramLayer} from '@vis.gl/tangram-layers';

const scene = {
  sources: {
    basemap: {
      type: 'Raster',
      url: 'https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
      max_zoom: 20
    }
  },
  layers: {
    basemap: {
      data: {source: 'basemap'},
      draw: {raster: {order: 0}}
    }
  }
};

const basemap = new TangramLayer({
  id: 'tangram-basemap',
  scene,
  onSceneError: error => console.error(error)
});

new Deck({
  views: new MapView({controller: true}),
  initialViewState: {
    longitude: -74.0098,
    latitude: 40.7053,
    zoom: 14,
    pitch: 35,
    bearing: -20
  },
  controller: true,
  layers: [
    basemap,
    new PathLayer({
      id: 'route',
      data: [{path: [[-74.0134, 40.7127], [-73.9969, 40.7061]]}],
      getPath: d => d.path,
      getColor: [255, 128, 0],
      getWidth: 5,
      widthUnits: 'pixels'
    })
  ]
});
```

  </TabItem>
  <TabItem value="ts" label="TypeScript">

```ts
import {Deck, MapView} from '@deck.gl/core';
import {PathLayer} from '@deck.gl/layers';
import {TangramLayer} from '@vis.gl/tangram-layers';
import type {SceneDefinition} from '@vis.gl/tangram-renderer';

type Route = {
  path: [longitude: number, latitude: number][];
};

const scene: SceneDefinition = {
  sources: {
    basemap: {
      type: 'Raster',
      url: 'https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
      max_zoom: 20
    }
  },
  layers: {
    basemap: {
      data: {source: 'basemap'},
      draw: {raster: {order: 0}}
    }
  }
};

const basemap = new TangramLayer({
  id: 'tangram-basemap',
  scene,
  onSceneError: (error: Error) => console.error(error)
});

new Deck({
  views: new MapView({controller: true}),
  initialViewState: {
    longitude: -74.0098,
    latitude: 40.7053,
    zoom: 14,
    pitch: 35,
    bearing: -20
  },
  controller: true,
  layers: [
    basemap,
    new PathLayer<Route>({
      id: 'route',
      data: [{path: [[-74.0134, 40.7127], [-73.9969, 40.7061]]}],
      getPath: route => route.path,
      getColor: [255, 128, 0],
      getWidth: 5,
      widthUnits: 'pixels'
    })
  ]
});
```

  </TabItem>
  <TabItem value="react" label="React">

```tsx
import React, {useMemo} from 'react';
import DeckGL from '@deck.gl/react';
import {MapView} from '@deck.gl/core';
import {TangramLayer} from '@vis.gl/tangram-layers';

const INITIAL_VIEW_STATE = {
  longitude: -74.0098,
  latitude: 40.7053,
  zoom: 14,
  pitch: 35,
  bearing: -20
};

const SCENE = {
  sources: {
    basemap: {
      type: 'Raster',
      url: 'https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
      max_zoom: 20
    }
  },
  layers: {
    basemap: {
      data: {source: 'basemap'},
      draw: {raster: {order: 0}}
    }
  }
};

export function App() {
  const layers = useMemo(
    () => [
      new TangramLayer({
        id: 'tangram-basemap',
        scene: SCENE,
        onSceneError: (error: Error) => console.error(error)
      })
    ],
    []
  );

  return (
    <DeckGL
      views={new MapView({controller: true})}
      initialViewState={INITIAL_VIEW_STATE}
      controller
      layers={layers}
    />
  );
}
```

  </TabItem>
</Tabs>

## Installation

The current alpha packages are private workspace packages and are not published to npm. In a
clone of the repository, install and build the workspace before running an example or local app:

```bash
git clone https://github.com/visgl/tangram.gl.git
cd tangram.gl
yarn install
yarn build
```

```js
import {TangramLayer} from '@vis.gl/tangram-layers';

new TangramLayer({...props});
```

Publishing will be enabled after the alpha API and package boundaries stabilize. `TangramLayer`
is an ES module and does not currently provide a pre-bundled script-tag build.

## Properties

Inherits from all deck.gl [Base Layer](https://deck.gl/docs/api-reference/core/layer)
properties. The properties below are specific to `TangramLayer`.

### Scene

#### `scene` (string | object, required) {/* #scene */}

The Tangram scene to load. It may be:

- a URL to a YAML or JSON scene; or
- a parsed scene configuration object.

To compose multiple scene files, use Tangram's `import` property from one root scene.

Changing the `scene` reference destroys the current Tangram renderer and creates a new one.
Keep an object-valued scene stable between React renders (for example, define it outside the
component or memoize it).

#### `sceneBasePath` (string, optional) {/* #scenebasepath */}

* Default: `null`

Base URL used to resolve relative scene imports, textures, fonts, and data sources. Set this when
an object-valued scene contains relative URLs, or when a scene URL should resolve assets from a
different directory.

Changing `sceneBasePath` reloads the scene in a new renderer.

#### `apiKey` (string, optional) {/* #apikey */}

* Default: `null`

Runtime Nextzen API key. Before scene loading completes, the layer adds the key to every source
whose URL uses `nextzen.org`. The key is not written back to the source scene file.

Changing `apiKey` reloads the scene in a new renderer. Applications that do not use Nextzen
should omit this property.

### Callbacks

#### `onSceneLoad` (function, optional) {/* #onsceneload */}

* Default: `() => {}`

Called once after the Tangram scene finishes loading:

```ts
(scene: Scene) => void
```

The callback receives the renderer-owned Tangram [`Scene`](./scene.md). At this point
`layer.isLoaded` is `true`.

#### `onSceneError` (function, optional) {/* #onsceneerror */}

* Default: `() => {}`

Called when scene loading or rendering reports an error:

```ts
(error: Error, scene: Scene | null) => void
```

The same error is also forwarded through deck.gl's layer error handling. Use this callback for
application-specific status UI or logging.

### Inherited presentation properties

The following inherited deck.gl properties are particularly relevant:

- `id` identifies the layer and should be stable and unique.
- `visible: false` skips basemap rendering without destroying the loaded scene.
- `opacity: 0` skips basemap rendering. Fractional opacity is not yet applied to Tangram's color
  output; use Tangram scene styling when translucent basemap output is required.

## Members

### `isLoaded` (boolean, read-only) {/* #isloaded */}

`true` after the current scene has loaded successfully and before the layer is finalized. deck.gl
uses this getter when determining whether all layers are ready.

## Supported views and devices

| deck.gl view | Status | Notes |
| --- | --- | --- |
| `MapView` | Supported | Flat and perspective Web Mercator cameras are supported. |
| `GlobeView` | Experimental | Tangram tile geometry is projected onto deck.gl's globe. |
| `FirstPersonView` | Capability preview | The visible ground footprint drives geographic tile selection. |

The layer supports deck.gl's WebGL 2 and WebGPU devices. One deck.gl viewport is supported per
layer. Multi-view and stereoscopic rendering use the lower-level [`HostFrame`](./host-frame.md)
and [experimental WebXR presentation API](./webxr-presentation.md) instead of `TangramLayer`.

## Remarks

### Layer order and depth

Use `TangramLayer` as the first layer in the `layers` array. With WebGL, Tangram preserves its
color output and then clears its internal depth and stencil state before later deck.gl layers
render. With WebGPU, Tangram and subsequent layers share the host render pass's depth attachment,
so normal depth testing applies across the basemap and overlays.

### Animation

Scenes with `scene.animated: true` request new deck.gl frames even when the camera is stationary.
This keeps shader effects such as TRON traffic moving without an application animation loop.

### Scene identity and lifecycle

The layer owns the Tangram renderer and all scene GPU resources that it creates. It destroys them
when the layer is finalized or when `scene`, `sceneBasePath`, or `apiKey` changes. The deck-owned
luma.gl device, canvas, and render pass are never destroyed by `TangramLayer`.

### Picking

Tangram features are not exposed through deck.gl's picking API in the current alpha. Overlay
layers remain fully pickable. Use the renderer [`Scene` query API](./scene.md) when application
logic needs access to Tangram feature data.

## Source

- [Interactive MapView example](../../examples/deck)
- [`TangramLayer` source](https://github.com/visgl/tangram.gl/blob/master/modules/tangram-layers/src/tangram-layer.ts)
