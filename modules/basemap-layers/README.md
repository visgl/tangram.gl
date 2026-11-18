<!--
tangram-layers
SPDX-License-Identifier: MIT
Copyright (c) vis.gl contributors
-->

# basemap-layers

[![NPM Version](https://img.shields.io/npm/v/@tangram.gl/basemap-layers.svg)](https://www.npmjs.com/package/@tangram.gl/basemap-layers)
[![NPM Downloads](https://img.shields.io/npm/dw/@tangram.gl/basemap-layers.svg)](https://www.npmjs.com/package/@tangram.gl/basemap-layers)

> _This is a work in progress_.

An implementation of a subset of the [Mapbox Style
Specification][mapbox_style_spec] with the intention of visualizing it using deck.gl.

The runtime API is exported from `@tangram.gl/basemap-layers`, and the map-style
helpers are exported from `@tangram.gl/basemap-layers/map-style`.

Install the eight peer dependencies alongside this package:

```sh
npm install @tangram.gl/basemap-layers \
  @deck.gl/core@10.0.0-alpha.1 @deck.gl/layers@10.0.0-alpha.1 \
  @deck.gl/geo-layers@10.0.0-alpha.1 @deck.gl/extensions@10.0.0-alpha.1 \
  @deck.gl-community/geo-layers@10.0.0-alpha.1 \
  @luma.gl/core@10.0.0-alpha.14 @luma.gl/engine@10.0.0-alpha.14 \
  @loaders.gl/core@5.0.0-beta.8
```

Strict dependency resolvers such as Yarn Plug'n'Play need each peer explicitly.

For more information, see the online documentation.
# Migration snapshot

This module was copied from `visgl/deck.gl-community`,
`modules/basemap-layers`, at commit `d903803f56f5eccda88a9b4328ab266c98c55fe5`.
It retains the upstream MIT attribution and third-party notices. It is private
and experimental while its build, tests and shared-core integration are adapted.

