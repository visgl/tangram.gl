{/*
tangram-layers
SPDX-License-Identifier: MIT
Copyright (c) vis.gl contributors
 */}

# Tile cache policy

<span className="badge badge--warning">Status: Experimental</span>

`TileCachePolicy` owns logical LRU recency, not tiles or GPU resources. Supply
readonly `TileCacheRecord` snapshots with unique `key`, finite non-negative
`bytes` and a host-computed `protected` flag. No renderer or mesh type is required.

```ts
import {TileCachePolicy} from '@vis.gl/tangram-renderer/map-logic';

const policy = new TileCachePolicy();
policy.touch('old');
policy.touch('new');
const records = [
  {key: 'old', bytes: 100, protected: false},
  {key: 'new', bytes: 100, protected: false},
  {key: 'visible', bytes: 500, protected: true}
];
const keys = policy.selectEvictions(records, {maxCachedTiles: 1, maxCachedBytes: 100});
// ['old']; the host decides when/how to dispose it and call policy.forget('old').
```

## Budgets and ordering

`TileCacheOptions.maxCachedTiles` and `maxCachedBytes` apply only to **unprotected**
entries. Supply already validated non-negative limits (integer tile count and
byte count); omitted limits are unlimited. Protected content can exceed both
budgets. This is not a total resident-memory cap or a maximum tile-selection count.

Least recently touched keys are selected until both limits fit. Untouched or
forgotten keys are oldest; equal ages preserve snapshot order. Zero-byte records
still count toward the tile budget. `selectEvictions()` does not mutate inputs,
change recency or remove records. The host must refresh protection each time it
applies a selection and serialize disposal with changes in ownership.

## Methods and accounting

| Method | Behavior |
| --- | --- |
| `touch(key)` | Record an insertion or reuse with a monotonic logical tick. |
| `forget(key)` | Remove recency after host-owned removal. |
| `selectEvictions(records, options?)` | Return eviction keys; omission selects none. |
| `getStatistics(records)` | Detached `residentTiles`, `cachedTiles`, `cachedBytes`, `protectedTiles` and `protectedBytes`. |
| `clear()` | Clear recency only; preserve the logical clock. |

The host defines byte accounting and decides when protected use refreshes recency.
Tangram keeps its vertex/index, globe-variant and pending-label accounting in the
renderer adapter, excluding textures, CPU payloads and driver overhead. Its
existing `maxCachedMeshBytes`, `cachedMeshBytes` and `protectedMeshBytes` fields
are translated to this neutral byte contract, not renamed publicly.
