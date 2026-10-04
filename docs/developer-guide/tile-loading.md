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
| `TangramTileSourceAdapter` and payload/request records | Worker-side `getTileData`, decoded publication and reuse | Existing `DataSource.load`/`copyTileData`, URL handling, transforms, winding, seam padding, attached rasters and error behavior |
| `AlignedTangramTileSource` (candidate) | Structural loaders.gl `TileSource`: metadata, flat/data requests and cancellation | Original source procedures; explicit context creation/cancellation hooks, no loader switch |
| `TangramTileTraversalAdapter` | `getTileIndices` and `getTileBoundingBox` | Planar/FirstPerson footprints, globe horizon policy, per-eye bounds, stereo union and separate projected data/style zoom |
| `TangramTileset2D` | Resident table, shared build queue, optional consumer protection, LRU mesh policy and diagnostics | Source/style cache identities, build-generation tokens, protected/proxy/preload residency and opt-in resource limits |
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

## Decoded payload and request ownership

`DecodedTilePayload` contains layer references, a detached raster-source list,
padding and winding. `TileSourceRequestState` contains cancellation ID, resolved
URL and resolved provider error. Weak records follow the context's lifetime and
do not enter worker messages or retain removed tiles globally. The legacy
`source_data` facade remains synchronized for existing parsers, transforms,
custom sources, cancellation and feature queries.

Payload shells and request state are separate, but features are **not deeply
immutable yet**: Tangram still annotates features during style evaluation.
Freezing or cloning those features here would change behavior. Rebinding a
payload preserves layer identity and creates fresh request/raster bookkeeping.
Decoded geometry retains Tangram's 4096-unit tile convention and negative local
Y, including seam padding; it is not geographic GeoJSON. The candidate advertises
`localCoordinates`. Its optional `getPayloadByteLength` hook supplies decoded
allocation estimates for loaders.gl byte budgets. Without that hook byte size is
unknown, not guessed from encoded network response size; use count limits.

The candidate source takes explicit `createContext` and `cancel` hooks rather
than importing a renderer tile or GPU resource. Abort rejects promptly, never
publishes an aborted result, and cancels request IDs assigned after asynchronous
TileJSON resolution. Non-cancellable providers may finish underlying work;
their late results are ignored. Resolved legacy errors still resolve content and
can be observed with `onResolvedError`; thrown/rejected errors remain rejections.
Requests carry normalized data indices separately from consumer zoom. Host
adapters pass `userData.styleZoom` when applying Tangram's display-zoom policy;
otherwise the bridge uses request `zoom`, then index zoom. Do not infer style
zoom from a shared XYZ content key.

Source `getMetadata()` resolves TileJSON and exposes normalized bounds, levels
and authored/discovered credits. Explicit scene bounds and sparse levels take
precedence. This does **not** change the legacy layout policy or automatically
discover PMTiles/MLT archive metadata: those providers still use configured
capabilities until their metadata interface is wired in.

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
exports**. The production `TangramTileDataRequest` still carries a required live
Tangram context. The separate `AlignedTangramTileSource` implements a structural
`TileSource` contract with `getMetadata`, `getTile`, `getTileData`, and an
`AbortSignal` bridge. The traversal adapter implements the published
`Tileset2DAdapter` shape, taking explicit Tangram footprint/LOD state instead of
a deck.gl viewport. Source normalization, sparse levels, display filters and
global fallback pinning remain renderer/source adapter responsibilities, not
generic tileset options. The renderer still uses its current worker protocol and
parsers; loaders.gl is installed **only for development comparisons**.

Resource limits also differ. Tangram's `maxConcurrentBuilds` lasts through the
final mesh batch, not merely fetch/decode. Its cache caps apply only to completed,
unneeded off-screen mesh allocations, not total decoded payload bytes. Do not map
these directly to loaders.gl's `maxRequests`, `maxCacheSize` or `maxCacheByteSize`
without explicitly reconciling those semantics.

## Comparative validation

Tests use published `@loaders.gl/tiles@5.0.0-alpha.6`, not copied source or a local
checkout. Both engines receive the same compact fixtures. Frozen expected
footprints additionally guard against two adapters agreeing on the same mistake.
Real browser source tests compare postprocessed MVT, GeoJSON and raster payloads.

| Behavior | Comparison / remaining distinction |
| --- | --- |
| Tile selection and structured bounds | Fixed map, bounded FirstPerson, globe, antimeridian and stereo footprints agree; unwrapped X and north-down Y are preserved |
| Shared consumers | Detaching one consumer cannot evict another consumer's selected/fallback content |
| Reuse and request identity | loaders.gl deduplicates XYZ in-flight; Tangram retains distinct style/build tiles and reuses completed decoded content in its source adapter |
| Cancellation and generations | Real tileset AbortSignals reach legacy cancellation; aborted provider results cannot publish; Tangram build tokens protect successor mesh builds |
| Failure/retry | loaders.gl retains a failed header until explicit reload; Tangram source calls reject and retry explicitly without caching a decoded failure |
| Refinement | Nearest loaded ancestor links agree for the fixture; Tangram still owns style-aware proxy/descendant refinement and label collision |
| LRU and disposal | Comparable equal-sized content has the same eviction order; only Tangram's renderer adapter disposes GPU resources |
| Budgets | loaders.gl counts total decoded residency; Tangram counts only evictable off-screen meshes and holds build slots through final mesh batches |

These are conformance groundwork, not a blanket equivalence claim. Generic
tileset integration, archive metadata, independent feature annotations, complex
refinement strategies and worker/host consumers still need focused follow-ups.

## Next steps toward a common implementation

1. Extend the fixtures to complex style-aware refinement and multiple worker/host
   consumers. Decide how decoded request slots and mesh build slots compose;
   do not collapse them into one limit.
2. Move feature generation/style annotations out of reusable decoded content,
   then make payloads truly immutable. Wire provider-specific archive metadata
   and cancellation without changing parser registrations or transforms.
3. Propose the demonstrated common contracts upstream. Resolve policy gaps in
   their owning library, with performance and bundle measurements.
4. Switch one production procedure per reviewed PR, retaining Tangram styling,
   GPU ownership, labels and globe fallback in renderer adapters.

See [tile providers](./tile-providers.md) for source formats and credits,
[resource limits](../api-reference/host-frame.md#tileresources) for policy details,
and [view integration](./view-integration.md) for projection and LOD work.
