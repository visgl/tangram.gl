{/*
tangram-layers
SPDX-License-Identifier: MIT
Copyright (c) vis.gl contributors
 */}

# Tile residency

<span className="badge badge--warning">Status: Experimental</span>

`TileResidency<ConsumerId = symbol>` tracks requested and visible tile keys for
multiple views or other consumers. It does not own resident tiles, perform
selection, start loading, or unload resources. Selected keys may not yet be loaded;
visible keys may represent fallback ancestors rather than selected detail.

```ts
import {TileResidency} from '@vis.gl/tangram-renderer/map-logic';

const residency = new TileResidency<string>();
residency.updateConsumer('left-eye', ['detail'], ['ancestor']);
residency.updateConsumer('right-eye', ['detail', 'neighbor'], ['ancestor']);
residency.detachConsumer('left-eye');
residency.isProtected('detail'); // true: the right eye still needs it
```

| Method | Behavior |
| --- | --- |
| `attachConsumer(id)` | Attach empty state; reset existing state for that ID. |
| `updateConsumer(id, selected, visible)` | Replace copied sets; implicitly attach unknown IDs. |
| `detachConsumer(id)` | Remove only this consumer; unknown IDs are harmless. |
| `getSelectedTileKeys()` | Detached selected-only union, deduplicated in consumer/key insertion order. |
| `isProtected(key)` | True when any consumer selects or displays the key. |
| `clear()` | Release all consumer metadata, not resource content. |

Inputs are copied, and mutating a returned union does not affect protection.
Combine this with host lifecycle and pin state when constructing
[cache records](./tile-cache-policy.md). Consumer protection alone does not account
for in-flight work, incomplete builds or proxy resources.
