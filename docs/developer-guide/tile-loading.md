{/*
tangram-layers
SPDX-License-Identifier: MIT
Copyright (c) vis.gl contributors
 */}

# Tile loading and tileset alignment

Tangram's tile pipeline is being organized around the same separation used by
loaders.gl: a **source acquires data**, a **tileset manages shared residency and
loading**, and a **renderer adapter owns presentation**. The first boundaries
are internal and dependency-free; they do not replace the existing parsers or
claim drop-in compatibility with loaders.gl.

## Current responsibilities

| Boundary | Responsibility | Tangram behavior retained |
| --- | --- | --- |
| `TangramTileSourceAdapter` | Worker-side `getTileData` request and decoded-data reuse | Existing `DataSource.load`/`copyTileData`, URL handling, transforms, winding, seam padding, attached rasters and error behavior |
| `TangramTileset2D` | Resident table, shared build queue, LRU mesh policy and diagnostics | Source/style cache identities, build-generation tokens, protected/proxy/preload residency and opt-in resource limits |
| `TileManager` and worker adapter | Traversal, hierarchy/refinement, mesh construction/disposal and labels | Map/Globe/FirstPerson eye unions, pinned fallback, style zoom, collision and worker cancellation |

The tileset does not import a scene, camera, style, GPU backend, deck.gl, or a
loader. Its unload callback lets the renderer dispose resources. It selects cache
victims but never silently destroys renderer-owned meshes.

The source adapter delegates to the original source implementations in production.
It keeps the worker context live rather than cloning it: request IDs, cancellation,
decoded layers and source-specific state must remain on the object that the worker
owns. Resolved data errors stay resolved; rejected or synchronously thrown source
errors keep their original behavior. An absent source still resolves with empty
source data.

## Data identity is not mesh identity

Decoded data reuse matches **source identity and normalized data coordinate key**.
It deliberately ignores style zoom and build identity. The first loaded match is
reused, and the registry is read at request time. Distinct unwrapped world-copy
keys retain the existing matching behavior.

Renderer residency remains keyed by **source, data coordinate and style zoom**.
For example, `world/1/2/3/3` and `world/1/2/3/12` may share decoded source layers
but own different styled meshes. Scene generation and tile ID remain separate
worker-completion tokens. Collapsing these identities into one XYZ cache would
break overzoom, styling and stale-reply handling.

## Alignment with loaders.gl

The reference APIs are [`TileSource` in loader-utils](https://github.com/visgl/loaders.gl/blob/master/modules/loader-utils/src/lib/sources/tile-source.ts)
and [`Tileset2D` in tiles](https://github.com/visgl/loaders.gl/blob/master/modules/tiles/src/tileset-2d/tileset-2d.ts).
loaders.gl separates viewport traversal through `Tileset2DAdapter`, accepts a
`TileSource` or `getTileData` callback, and can share a tileset across consumers.

The new Tangram boundaries follow that division but are **not public package
exports**. `TangramTileDataRequest` carries an index, build ID, and required live
Tangram context. It is not yet loaders.gl's `GetTileDataParameters`, and the
adapter does not yet provide `getTile`, metadata initialization, or an `AbortSignal`
bridge. The renderer still uses its current worker protocol and parsers.

Resource limits also differ. Tangram's `maxConcurrentBuilds` lasts through the
final mesh batch, not merely fetch/decode. Its cache caps apply only to completed,
unneeded off-screen mesh allocations, not total decoded payload bytes. Do not map
these directly to loaders.gl's `maxRequests`, `maxCacheSize` or `maxCacheByteSize`
without explicitly reconciling those semantics.

## Next steps toward a common implementation

1. Separate immutable decoded payloads from mutable request/build context. Add
   source metadata, bounds, attributions and an `AbortSignal` adapter while
   preserving TileJSON, PMTiles/MLT providers, transforms and worker cancellation.
2. Extract a Tangram traversal adapter with `getTileIndices` and
   `getTileBoundingBox` contracts. Preserve eye unions, coordinate conventions,
   sparse zooms, bounds, world wrapping and pinned globe fallback.
3. Compare both tileset implementations against the same hermetic fixtures:
   overzoom/source identity, shared consumers, cancellation, retries, stale
   generations, refinement and cache-disposal order. Measure worker and application
   bundle size as well as request/build throughput.
4. Propose reusable source/tileset contracts upstream only after the comparison
   identifies the genuinely common parts. Switch individual production procedures
   in focused PRs, leaving Tangram's styling, labels and GPU content in its adapter.

See [tile providers](./tile-providers.md) for source formats and credits,
[resource limits](../api-reference/host-frame.md#tileresources) for policy details,
and [view integration](./view-integration.md) for projection and LOD work.
