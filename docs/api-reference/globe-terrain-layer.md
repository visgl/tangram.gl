{/*
tangram-layers
SPDX-License-Identifier: MIT
Copyright (c) vis.gl contributors
 */}

# GlobeTerrainLayer

<span className="badge badge--warning">Status: Experimental</span>

Render physical DEM grids as displaced terrain in deck.gl `GlobeView`. This is a
separate layer, not terrain draping in `TangramLayer`. Importing it is opt-in:
the normal package entry does not include mesh-layers or this adapter.

```ts
import {GlobeTerrainLayer} from '@vis.gl/tangram-layers/experimental/terrain';

const terrain = new GlobeTerrainLayer({
  id: 'terrain',
  data: heightGrids,
  globeTerrainExaggeration: 100
});
```

See the [live globe terrain example](/tangram.gl/examples/deck-globe-terrain).
Install `@deck.gl/mesh-layers` alongside the package's normal peer dependencies.

## Properties

### `data` (required)

Immutable `TerrainHeightGrid[]` in absolute EPSG:3857 meters with physical heights,
explicit validity, registration and one shared vertical datum. Use same-LOD,
non-overlapping tiles; matching edges average neighbor heights, including the
antimeridian. Cells touching missing samples are omitted, not bridged. Do not
mutate grids in place: replace the data array after changing source samples.
Validity is checked over each cell's complete interpolation footprint, so source
holes smaller than the display mesh remain holes, including touching neighbors.

### `globeTerrainExaggeration` (number, default `100`)

Maximum display multiplier, range `[0, 1000]`. The example provides a live
`0–200` slider, default `100`. Exaggeration above `1` applies while the globe's apparent
diameter fits the shorter viewport dimension. A smooth logarithmic fade reaches
`1` at four viewport diameters (two diameter doublings). The policy uses actual
camera scale and viewport dimensions rather than assuming a particular zoom value.
`1` always renders physical scale. `0` removes displacement at every zoom;
values between `0` and `1` stay at that reduced scale rather than fading upward.
Original source heights and physical elevation queries are never modified.

### `meshResolution` (integer, default `64`)

Uniform curved cells per tile axis, range `[2, 256]`. Allocation and work are bounded
per tile, not per supplied dataset. The host must bound tile count and cache use.
This is a preview sampling policy, not a certified geometric-error LOD algorithm.
Cells spanning 180° or more longitude reject instead of producing degenerate triangles.
Zero-area triangles caused by packed-coordinate precision also reject; increase
the source footprint or use a local-coordinate terrain adapter for such tiny tiles.

### `wireframe` (boolean, default `false`)

Show mesh edges. Otherwise vertex colors provide baked spherical relief lighting;
no extra shader, texture, light effect or backend-specific normal transform is needed.

## `pickTerrain(viewport, [x, y])`

Call on the current initialized layer and the viewport that rendered it. Pixels
are top-origin deck canvas CSS coordinates, including viewport offsets. Returns
the nearest `TerrainSurfaceHit` or `null`. Displayed triangles determine visibility;
`coordinate[2]` interpolates **physical source meters**. `position` and `distance`
remain radius-256 common-space geometry values. No-data holes return no hit.
Backface culling is shared by drawing and querying, so missing front-side samples
do not reveal or select the far hemisphere.

The renderer's `TerrainMeshSurface` now also accepts optional `physicalHeights`
per vertex. It snapshots those values so exaggerated geometry can be queried
through `pickTerrainAt` and existing `HostFrame` eye routing without changing
the renderer's deck-independent camera contract.

## Limits

GlobeView only. Vertex-transforming `modelMatrix` and layer extensions reject,
so displayed positions cannot silently diverge from CPU queries.
Constrain the host's view state to `zoom <= 12`: deck.gl 9.4 changes GlobeView
to WebMercatorViewport above that threshold. The example sets `maxZoom: 12`
and also clamps its controlled state to stay spherical.
No basemap/annotation draping, mixed-LOD stitching, automatic tile
fetching or datum conversion. The example's Mercator DEM stops at ±85.05°; polar
terrain is not invented. Immersive WebXR/stereo validation remains future work.
