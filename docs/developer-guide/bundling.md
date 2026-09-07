{/*
tangram-layers
SPDX-License-Identifier: MIT
Copyright (c) vis.gl contributors
 */}

# Bundling a small deck.gl basemap app

The deck example is a useful baseline for understanding the cost of adding a
Tangram basemap to a small deck.gl application. The application source is
[`examples/deck/app.js`](https://github.com/visgl/tangram.gl/blob/master/examples/deck/app.js).
It creates a deck instance, adds `TangramLayer`, and renders a small overlay.

## Current reference footprint

Run `yarn build` followed by `yarn bundle-size` to measure the checked-out
artifacts. The current reference build reports:

| Asset | Raw | Gzip |
| --- | ---: | ---: |
| Deck example source | 0.5 KB | 0.3 KB |
| `@vis.gl/tangram-layers` package entry | 18.5 KB | 4.6 KB |
| `@vis.gl/tangram-layers/experimental/webxr` package entry | 42.7 KB | 10.1 KB |
| WebXR example source | 22.1 KB | 6.0 KB |
| `@vis.gl/tangram-renderer` package entry | 0.4 KB | 0.2 KB |
| Minified Tangram renderer ESM | 621.9 KB | 181.3 KB |
| **TangramLayer + minified renderer** | **640.4 KB** | **185.9 KB** |

The combined row is an additive package-artifact estimate, not a promise about a
particular webpack, Rollup, or Vite output. It excludes deck.gl, luma.gl, the
WebGPU adapter, browser polyfills, scene YAML, fonts, sprites, and downloaded
tiles. Those dependencies and assets should be measured in the host application
using its production bundler.

The package root currently points at the debug ESM renderer entry so that the
published-style API remains easy to inspect during this experimental phase.
Production applications should use their bundler's minification and tree
shaking, and should verify that the worker bundle is copied to the URL expected
by the renderer. The renderer's `prepack` hook always rebuilds all browser and
worker artifacts before publishing.

## Minimal application shape

```js
import {Deck} from '@deck.gl/core';
import {TangramLayer} from '@vis.gl/tangram-layers';

new Deck({
  parent: document.getElementById('map'),
  initialViewState: {longitude: -74, latitude: 40.7, zoom: 12},
  controller: true,
  layers: [new TangramLayer({id: 'basemap', scene: sceneYaml})]
});
```

For a repeatable local report:

```sh
yarn install
yarn build
yarn bundle-size
```

The report intentionally measures checked-in package artifacts rather than
guessing at a host bundler's output. This keeps changes to renderer size visible
in review while leaving deck.gl applications free to choose their own build
pipeline.
