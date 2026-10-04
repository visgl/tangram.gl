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
| `SharedTileSourceAdapter` and `DecodedTileStore` | Worker-local leases for compatible pending/ready decoded data | Original built-in tiled parsers; custom hooks retain the legacy path; no warm cache or GPU disposal |
| `AlignedTangramTileSource` | Structural loaders.gl `TileSource`: metadata, flat/data requests and cancellation | Original source procedures; explicit context creation/cancellation hooks, no loader switch |
| `TangramTileTraversalAdapter` | `getTileIndices` and `getTileBoundingBox` | Planar/FirstPerson footprints, globe horizon policy, per-eye bounds, stereo union and separate projected data/style zoom |
| `TangramTileset2D` | Resident table, shared build queue, optional consumer protection, LRU mesh policy and diagnostics | Source/style cache identities, build-generation tokens, protected/proxy/preload residency and opt-in resource limits |
| `TileManager` and worker adapter | Traversal, hierarchy/refinement, mesh construction/disposal and labels | Map/Globe/FirstPerson eye unions, pinned fallback, style zoom, collision and worker cancellation |

The tileset does not import a scene, camera, style, GPU backend, deck.gl, or a
loader. Its unload callback lets the renderer dispose resources. It selects cache
victims but never silently destroys renderer-owned meshes.

Both source adapters delegate to the original source implementations in production.
The legacy adapter keeps the worker context live rather than cloning it; compatible
shared acquisition instead owns a detached source context and binds its payload to
each worker tile. Resolved data errors stay resolved; rejected or synchronously thrown source
errors keep their original behavior. An absent source still resolves with empty
source data.

## Decoded payload and request ownership

`DecodedTilePayload` contains layer references, a detached raster-source list,
padding and winding. `TileSourceRequestState` contains cancellation ID, resolved
URL and resolved provider error. Weak records follow the context's lifetime and
do not enter worker messages or retain removed tiles globally. The legacy
`source_data` facade remains synchronized for existing parsers, transforms,
custom sources, cancellation and feature queries.

Payload shells and request state are separate. Built-in style evaluation now
records rendered generations in weak feature sidecars rather than writing
`feature.generation`. Feature queries preserve the existing aggregate-generation
visibility semantics across shared layer references, and legacy custom annotations
remain readable. Picking entries were already keyed by build tile and remain so:
removing one build cannot clear another build's selection entries.

Features are **not deeply frozen in production**. Custom functions can still
mutate them, and custom acquisition hooks are not assumed pure. Frozen fixture
tests enforce built-in bookkeeping isolation without breaking those extensions.
Rebinding a payload preserves layer identity and creates fresh request/raster bookkeeping.
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

Source `getMetadata()` resolves TileJSON or registered archive metadata and
exposes normalized bounds, levels, container format, encoded tile MIME type and
authored/discovered credits. Explicit scene bounds, maximum zoom and sparse
levels take precedence. Invalid advertised levels/bounds are not exposed.
Antimeridian bounds retain their original west/east ordering. This does **not**
change the legacy layout policy or choose a decoder automatically.

`scene.getSourceMetadata()` and `renderer.getSourceMetadata()` return a record
keyed by logical source name. Archive metadata is queried in the worker where
its provider is registered, without importing loaders.gl into the core bundle.
`getAttributions()` includes those archive credits. Call after `load()` resolves;
metadata failures or a source replaced during discovery reject instead of
returning incomplete/stale credits. URL-only sources still need explicit credits.

## Archive capabilities and lifetime

The existing `registerMvtTileProvider(name, function)` contract remains valid.
A factory registration additionally supports source-owned handles:

```ts
registerMvtTileProvider('archive', {
  createSource(url, {headers}) {
    return {
      async getTile(index, signal) { /* encoded MVT or MLT bytes */ },
      async getMetadata() { /* format, tileMIMEType, bounds, levels, credits */ },
      dispose() { /* abort requests and release archive references */ }
    };
  }
});
```

The opt-in `loaders-pmtiles` worker now uses this factory. Each source instance
owns its archive handle; no global URL cache survives source removal. Request
headers are forwarded to byte-range requests. Cancellation remains active
through response body completion. Metadata requests, live tile requests and
archive references are released on replacement/removal, scene destruction or
worker reset. Cancelled tile/preprocessor results cannot publish late geometry.
Legacy function providers need not support transport cancellation, but their late
results are likewise ignored. Source metadata failures remain explicit rejections.

Published loaders.gl alpha.8 drops archive attribution from normalized metadata.
The Tangram adapter also reads and caches raw archive JSON and combines its
credits with any normalized credits until that upstream gap is fixed. Encoded
`tileMIMEType` is distinct from the `pmtiles` container format; authored `decoder`
remains authoritative.

## Data identity is not mesh identity

Decoded data reuse matches **source identity and normalized data coordinate key**.
It deliberately ignores style zoom and build identity. Compatible built-in sources
reuse pending or ready acquisitions; custom pipelines still reuse the first loaded
match in the worker registry. Distinct unwrapped world-copy
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

## Shared decoded acquisition in production

`SharedTileSourceAdapter` uses a worker-local `DecodedTileStore` for exact built-in
MVT (Tangram decoder, no alternate tile provider), tiled GeoJSON and raster source
classes without transforms, preprocessors or external source scripts. Custom
subclasses, instance loader/parser overrides, standalone sources and registered
alternate providers/decoders retain the original first-match loading procedure.
Workers importing external scripts also disable sharing conservatively, since
those scripts can modify built-in prototypes.
There is no heuristic purity inference or new scene option promising custom-source
sharing. Extending eligibility requires a focused conformance change.

The data key is the **source object revision plus normalized coordinate key**,
not source name alone, style zoom or mesh/build generation. Unwrapped world copies
remain distinct. Existing routing already pins equal normalized data coordinates
to the same worker; no routing or cross-worker transfer protocol changes here.

The first consumer starts acquisition on a detached source context. Other
compatible builds lease the same pending or ready content. Each consumer receives
independent request/raster/debug shells, while layer references remain shared.
Acquisition errors and resolved URLs are copied as diagnostics; cancellation IDs
belong only to the detached acquisition, never to the first renderer tile.

Releasing one pending lease rejects that consumer promptly without cancelling
another consumer. The final release cancels the underlying request, including an
ID assigned after TileJSON discovery. Non-cancellable work may finish but cannot
publish over a new attempt or obsolete source revision. Ordinary rejected loads
reject all waiting consumers and allow an explicit later retry; resolved legacy
provider errors continue to resolve and are reported to every consuming build.

Unchanged source instances survive style-only configuration refreshes. Changed,
removed or failed replacement sources invalidate old acquisitions and release
their worker tile/selection ownership. Completion and error callbacks check the
receiving tile object, not merely its reusable key, before building or reporting.

There is **no unreferenced decoded warm cache**. Ready content is retained only
while live worker tiles hold leases; its final release forgets the record and
source map. Internal worker diagnostics report unique pending/ready acquisitions,
consumer counts, actual/shared attempts, cancellation/failure counts and known
decoded allocation bytes. Unknown bytes remain unknown. Native worker termination
releases its isolated heap; worker reset also explicitly finalizes the store.

Decoded acquisition does not release a `maxConcurrentBuilds` slot early, change
mesh-cache budgets, allocate a new global fetch limit, or replace Tangram's
style-aware refinement. A scene-wide decoded request budget would need to account
for multiple workers separately.

Resource limits also differ. Tangram's `maxConcurrentBuilds` lasts through the
final mesh batch, not merely fetch/decode. Its cache caps apply only to completed,
unneeded off-screen mesh allocations, not total decoded payload bytes. Do not map
these directly to loaders.gl's `maxRequests`, `maxCacheSize` or `maxCacheByteSize`
without explicitly reconciling those semantics.

## Comparative validation

Tests use published `@loaders.gl/tiles@5.0.0-alpha.8`, not copied source or a local
checkout. Both engines receive the same compact fixtures. Frozen expected
footprints additionally guard against two adapters agreeing on the same mistake.
Real browser source tests compare postprocessed MVT, GeoJSON and raster payloads.

| Behavior | Comparison / remaining distinction |
| --- | --- |
| Tile selection and structured bounds | Fixed map, bounded FirstPerson, globe, antimeridian and stereo footprints agree; unwrapped X and north-down Y are preserved |
| Shared consumers | Detaching one consumer cannot evict another consumer's selected/fallback content |
| Reuse and request identity | Both deduplicate compatible in-flight data; Tangram retains distinct style/build tiles, source-revision leases, zero decoded warm retention and a legacy path for custom hooks |
| Cancellation and generations | Real tileset AbortSignals reach legacy cancellation; aborted provider results cannot publish; Tangram build tokens protect successor mesh builds |
| Failure/retry | loaders.gl retains a failed header until explicit reload; Tangram source calls reject and retry explicitly without caching a decoded failure |
| Refinement | Nearest loaded ancestor links agree for the fixture; Tangram still owns style-aware proxy/descendant refinement and label collision |
| LRU and disposal | Comparable equal-sized content has the same eviction order; only Tangram's renderer adapter disposes GPU resources |
| Budgets | loaders.gl counts total decoded residency; Tangram counts only evictable off-screen meshes and holds build slots through final mesh batches |

These are conformance groundwork, not a blanket equivalence claim. Generic
tileset integration, archive metadata, custom feature annotations, complex
refinement strategies and worker/host consumers still need focused follow-ups.

Shared-acquisition tests additionally exercise independent leases, late
cancellation IDs, source revisions, explicit retries, zero warm retention and
recreated tile keys. Native Chromium workers load a tiny local GeoJSON fixture:
two compatible style consumers issue one real request, and cancelling one does
not interrupt the other. Built-in styling accepts frozen features, feature queries
preserve visibility/geometry output, and picking cleanup stays build-owned.

## Next steps toward a common implementation

### Independent acquisition and mesh-build capacity

Compatible shared built-in source procedures now have an optional FIFO queue,
configured at worker creation by `maxConcurrentTileLoadsPerWorker`. One exact
source/data record owns one slot regardless of the number of style/eye leases.
The source slot ends after acquisition/decode; the renderer's build slot remains
held until its final mesh reply. Ready content and retained styled meshes do not
occupy a source slot. Neither queue inherits the other's limit.

Final queued-lease release removes work before invocation. Source invalidation
and worker reset remove queued attempts; running aborts cannot publish late data.
A non-cooperative procedure still occupies its slot until settlement rather than
allowing a cancellation/retry loop to silently exceed logical capacity. Failure
releases the slot and advances the next unique request. Unlimited is still the
default, and extension-owned pipelines retain their original path.

Unit comparisons exercise the same unique-request capacity against the published
loaders.gl `Tileset2D.maxRequests`. Native Chromium workers prove separate XYZ
loads obey capacity while overzoom/style consumers share one acquisition and
cancel independently. The policies are not identical: Tangram uses FIFO with no
arrival debounce or request-priority callback, limits each worker separately,
retains source-revision leases and zero decoded warm cache, and does not charge
custom pipelines to this queue. This is groundwork for common scheduling, not
a claim of drop-in `RequestScheduler` equivalence or a total HTTP budget.

Public asynchronous source diagnostics report queue/active state per worker,
separately from the renderer's synchronous mesh-resource statistics. Unknown
decoded sizes remain unknown; no encoded-response estimate is substituted.

### Loaders-backed tileset candidate

Tranche 9 now has an executable candidate in the renderer's test helpers, backed
by the actual published `Tileset2D`. It is **development-only**, not a new package
export or a replacement for `TileManager` in production. Its Chromium tests load
the same fixed Map, bounded FirstPerson, Globe, antimeridian and stereo traversal
corpus used by the existing procedure-level comparisons.

The candidate normalizes sparse source levels and overzoom before acquisition,
deduplicates normalized data while retaining separate source/data/style mesh
keys, and isolates source revisions in separate instances. Host consumers protect
shared headers independently. Coarse globe preload has separate protection and
is not counted as ordinary selected detail. Explicit ancestor/descendant fallback
inputs remain renderer-owned; decoded header ancestry is not a styled refinement
decision. Cancellation, explicit failure retry and teardown are exercised without
network services or GPU resource ownership in the candidate.

The comparison makes these rollout gates concrete:

| Published behavior | Candidate adaptation / remaining production gate |
| --- | --- |
| Warm decoded cache and budgets cover total decoded content | Candidate explicitly defaults decoded warm entries to zero. An optional decoded count is separate from Tangram's off-screen mesh count/byte limits; there is no automatic budget translation. |
| Missing `content.byteLength` contributes zero to cache bytes | Candidate diagnostics use an explicit allocation estimator and retain unknown sizes. A common byte-budget contract is still needed before enforcing decoded memory limits. |
| Nearest cached ancestor can be unloaded | A fixture contrasts this with Tangram's nearest loaded styled ancestor. Host-authored drawable fallbacks stay protected; switching refinement requires a style/generation-aware policy, not a header pointer. |
| Aborting a non-cooperative header may accept its late content | Candidate source publication checks the signal and source lifetime after acquisition; pending eviction also explicitly aborts the header. |
| `Tileset2D.finalize()` clears headers without unload callbacks | Candidate explicitly releases live decoded content once before finalization. This is not GPU mesh disposal. |

`yarn bundle-size:tilesets` reports reproducible browser/minified/gzip probes and
guards against retained 3D/spatial code in the decoded entry. The current probes
are 3.714 / 1.393 KB for Tangram's mesh tileset, 15.499 / 4.456 KB for published
decoded `Tileset2D`, and 19.583 / 5.701 KB for the candidate with its compatibility
adapter (decimal KB). These are **different responsibilities**, not evidence of a
drop-in replacement or a bundle saving. The candidate adds no bytes to production
renderer, layer, optional-worker or WebXR bundles.

Production continues using Tangram's mesh tileset and worker protocol. Common
source scheduling, failed-header semantics, unknown memory estimates, source
revision ownership and style-aware refinement need upstream agreement before
replacing the remaining generic tables/cache bookkeeping. Transferable ownership
and native multi-worker/GPU integration of a shared tileset are separate rollout
gates; these fixture comparisons do not claim they are complete.

### Remaining common contracts

1. Extend the fixtures to complex style-aware refinement and multiple worker/host
   consumers. Add priority policy and measure latency/throughput before sharing a
   common scheduler; do not collapse source slots and mesh build slots into one limit.
2. Continue isolating custom feature mutations and provider-specific archive
   metadata/cancellation. Built-in generation annotations and compatible decoded
   acquisition are isolated already; do not globally freeze extension-owned data.
3. Propose the demonstrated common contracts upstream. Resolve policy gaps in
   their owning library, with performance and bundle measurements.
4. Switch one production procedure per reviewed PR, retaining Tangram styling,
   GPU ownership, labels and globe fallback in renderer adapters.

See [tile providers](./tile-providers.md) for source formats and credits,
[resource limits](../api-reference/host-frame.md#tileresources) for policy details,
and [view integration](./view-integration.md) for projection and LOD work.
