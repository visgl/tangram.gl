{/*
tangram-layers
SPDX-License-Identifier: MIT
Copyright (c) vis.gl contributors
 */}

# Map utilities

<span className="badge badge--warning">Status: Experimental</span>

The optional `@tangram.gl/tangram-renderer/map-logic` entry provides CPU-only map
algorithms and types. It has no renderer, deck.gl, luma.gl, DOM or worker imports.
Triangle queries use lightweight `@math.gl/culling/queries` kernels with cooperative
in-place bounds partitioning. Terrain helpers use math.gl coordinate/vector APIs;
the utility graph contains only authored helpers and math.gl, not the renderer's
polygon-builder dependencies. The normal renderer entry does not re-export this
utility entry.

This API is experimental: names and contracts may change. These helpers form an
initial reusable boundary, not a complete cartographic layout engine or a new
package.

- [Label placement](./map-logic/label-placement.md): collision, repeat spacing,
  linked placement and one visibility mask across multiple views.
- [Label identity](./map-logic/label-identity.md): buffered geographic copies with
  explicit units and horizontal wrapping.
- [Screen bounds](./map-logic/screen-bounds.md): rectangle overlap, unions and
  clipped spatial-index cells.
- [Tile build queue](./map-logic/tile-build-queue.md): stable-priority scheduling
  without owning workers or rendering resources.
- [Tile residency](./map-logic/tile-residency.md): selected/visible key protection
  shared across independent consumers.
- [Tile cache policy](./map-logic/tile-cache-policy.md): stable LRU eviction and
  resource accounting from neutral metadata snapshots.
- [Terrain data](./map-logic/terrain-data.md): elevation decoding, georeferencing,
  no-data and physical-meter sampling.
- [Triangle queries](./map-logic/triangle-query-index.md): immutable bounds indexing,
  nearest ray intersections and deterministic work diagnostics.

See the [reuse assessment](../developer-guide/map-logic.md) for extraction limits
and other candidates.
