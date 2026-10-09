{/*
tangram-layers
SPDX-License-Identifier: MIT
Copyright (c) vis.gl contributors
 */}

# Bundling a small deck.gl basemap app

The deck example is a useful baseline for understanding the cost of adding a
Tangram basemap to a small deck.gl application. The application source is
[`examples/deck/app.js`](https://github.com/visgl/tangram.gl/blob/master/examples/deck/app.js).
That small entry loads the implementation in
[`app-runtime.js`](https://github.com/visgl/tangram.gl/blob/master/examples/deck/app-runtime.js),
which creates deck, the basemap and overlays. The entry's size alone is not the
size of the application.

## Current reference footprint

Run `yarn bundle-size` to build the modules and measure their generated artifacts.
The following snapshot is from master `1d62e568` with the checked-in lockfile.
Values use decimal KB (1 KB = 1,000 bytes), not KiB:

| Asset | Raw | Gzip |
| --- | ---: | ---: |
| Deck example source | 0.5 KB | 0.3 KB |
| `@vis.gl/tangram-layers` package entry | 27.0 KB | 6.5 KB |
| `@vis.gl/tangram-layers/experimental/webxr` package entry | 56.7 KB | 13.3 KB |
| WebXR example source | 29.3 KB | 7.9 KB |
| `@vis.gl/tangram-renderer` package entry | 0.7 KB | 0.3 KB |
| Minified Tangram renderer ESM | 1,126.6 KB | 333.9 KB |
| Debug Tangram renderer ESM | 2,175.5 KB | 487.8 KB |
| **TangramLayer + minified renderer** | **1,153.6 KB** | **340.4 KB** |

The combined row is an additive package-artifact estimate, not a promise about a
particular production bundler output. The renderer figure includes its bundled
dependencies and embedded scene worker. The report does not separately account
for the external deck/luma runtime, example runtime/chunks, optional sidecar workers,
scene YAML, fonts, sprites or downloaded tiles. Measure the complete host app and
its emitted assets with the production bundler; do not interpret this table as
the download size of the running example.

The package root currently points at the debug ESM renderer entry so that the
published-style API remains easy to inspect during this experimental phase.
Production applications should use their bundler's minification and tree
shaking. The normal scene worker is embedded as a Blob URL; a custom `workerURL`
or optional loaders/projection sidecar must be hosted separately. See the
[worker setup](./projected-basemaps.md#usage). The renderer's `prepack` hook
rebuilds package artifacts, though the workspace remains private and unpublished.

## Minimal application shape

```js
import {Deck} from '@deck.gl/core';
import {TangramLayer} from '@vis.gl/tangram-layers';

// A scene URL, or a stable parsed scene object; see the styling reference.
const sceneYaml = '/scenes/basemap.yaml';

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
yarn bundle-size
```

The report measures generated package artifacts; no `dist/` bundles are checked
in. For focused dependency comparisons, also run `yarn bundle-size:parsers`,
`yarn bundle-size:tilesets` or `yarn bundle-size:projections`. Compare the same
entry, dependency versions and bundler settings before attributing a delta to
one library.
