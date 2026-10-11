{/*
tangram-layers
SPDX-License-Identifier: MIT
Copyright (c) vis.gl contributors
 */}

# Terrain data

<span className="badge badge--warning">Status: Experimental</span>

Import from `@vis.gl/tangram-renderer/map-logic`. These CPU helpers do not fetch
images, generate meshes, render terrain or require deck.gl/loaders.gl.

```ts
import {TERRARIUM_DECODER, decodeTerrainHeightGrid, sampleTerrainHeight}
  from '@vis.gl/tangram-renderer/map-logic';

const grid = decodeTerrainHeightGrid({
  width: image.width,
  height: image.height,
  pixels: image.data,
  decoder: TERRARIUM_DECODER,
  bounds: [westMeters, southMeters, eastMeters, northMeters],
  registration: 'pixel-center',
  verticalDatum: 'unknown'
});
const elevationMeters = sampleTerrainHeight(grid, [xMeters, yMeters]);
```

## Decoding

`ElevationDecoder` matches loaders.gl's byte-channel coefficients: `rScaler`,
`gScaler`, `bScaler`, `offset`. `TERRARIUM_DECODER` and `TERRAIN_RGB_DECODER` return
meters; custom decoders must also return meters. Input is linear RGBA bytes,
at least 2×2. Color conversion and datum conversion are caller responsibilities.

`decodeTerrainHeightGrid(options)` copies heights into Float32 storage and copies
bounds and validity. Input mutation cannot change the result; returned arrays
are caller-owned and should be treated as immutable while shared. An optional
pixel-aligned `valid` mask marks holes with zero and NaN height. Alpha has no
implicit meaning. Invalid dimensions, bounds, coefficients, datum, registration
or overflowing heights throw.

## Sampling

`sampleTerrainHeight(grid, [x, y])` returns bilinear meters or `null` outside the
footprint or across a contributing no-data sample. Rows start at north; columns
start at west. `pixel-center` places samples half a cell inside the footprint
and clamps half-cell borders; `grid-node` includes both edges. Exact-node queries
ignore zero-weight invalid neighbors.

This is a data lookup, not a simplified mesh query. Use TerrainMeshSurface to
intersect the actual rendered triangles. See [terrain integration](../../developer-guide/terrain.md)
for the loaders.gl/deck.gl reference and remaining limitations.
