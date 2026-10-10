{/*
tangram-layers
SPDX-License-Identifier: MIT
Copyright (c) vis.gl contributors
 */}

# Map utilities

<span className="badge badge--warning">Status: Experimental</span>

The optional `@vis.gl/tangram-renderer/map-logic` entry provides CPU-only map
algorithms and types. It has no renderer, deck.gl, luma.gl, DOM, worker or
third-party runtime imports. The normal renderer entry does not re-export it.

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

See the [reuse assessment](../developer-guide/map-logic.md) for extraction limits
and other candidates.
